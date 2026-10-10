import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { parseCopilotPricingTable } from "./pricing.js";

export const COPILOT_PRICING_SOURCE_URL =
  "https://raw.githubusercontent.com/github/docs/main/data/tables/copilot/models-and-pricing.yml";
export const CACHE_SCHEMA_VERSION = 1;
export const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1_000;
export const MAX_PRICING_RESPONSE_BYTES = 1_048_576;

async function readResponseText(response, maxBytes) {
  const declaredLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`Pricing response exceeds maximum size of ${maxBytes} bytes`);
  }

  if (typeof response.body?.getReader !== "function") {
    throw new Error("Pricing response does not expose a readable body for bounded streaming");
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // Keep the size-limit error as the actionable failure.
        }
        throw new Error(`Pricing response exceeds maximum size of ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function isRefreshDue(lastAttemptAt, now) {
  if (typeof lastAttemptAt !== "string") return true;
  const lastAttemptMs = Date.parse(lastAttemptAt);
  return !Number.isFinite(lastAttemptMs) || now.getTime() - lastAttemptMs >= REFRESH_INTERVAL_MS;
}

function emptyCache(sourceUrl) {
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    sourceUrl,
    lastAttemptAt: null,
    lastUpdatedAt: null,
    lastUpdatedDateUtc: null,
    lastError: null,
    tiers: [],
  };
}

async function readCache(cachePath, sourceUrl) {
  try {
    const parsed = JSON.parse(await readFile(cachePath, "utf8"));
    if (
      parsed?.schemaVersion === CACHE_SCHEMA_VERSION &&
      Array.isArray(parsed.tiers) &&
      (parsed.tiers.length === 0 || parsed.tiers.every(isValidTier))
    ) {
      return { ...parsed, sourceUrl };
    }
  } catch {
    // Missing or malformed cache is treated as a cache miss.
  }
  return emptyCache(sourceUrl);
}

function isValidTier(tier) {
  return (
    typeof tier?.model === "string" &&
    Number.isSafeInteger(tier?.thresholdTokens) &&
    tier.thresholdTokens > 0
  );
}

async function writeCacheAtomically(cachePath, cache) {
  await mkdir(path.dirname(cachePath), { recursive: true });
  const temporaryPath = `${cachePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, cachePath);
}

/**
 * Refresh at most once per 24 hours. `lastAttemptAt` enforces the interval;
 * `lastUpdatedAt` records the last successful refresh and remains unchanged on failure.
 */
export async function getDailyPricingCache({
  cachePath,
  now = new Date(),
  fetchImpl = globalThis.fetch,
  sourceUrl = COPILOT_PRICING_SOURCE_URL,
  timeoutMs = 8_000,
  maxResponseBytes = MAX_PRICING_RESPONSE_BYTES,
}) {
  if (!cachePath) throw new TypeError("cachePath is required");
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");

  const timestamp = now.toISOString();
  const cached = await readCache(cachePath, sourceUrl);
  if (!isRefreshDue(cached.lastAttemptAt, now)) {
    return { cache: cached, refreshed: false, attempted: false, error: cached.lastError ?? undefined };
  }

  const attemptCache = {
    ...cached,
    sourceUrl,
    lastAttemptAt: timestamp,
    lastError: null,
  };

  try {
    // Persist the attempt before networking, so failures do not cause a retry storm.
    await writeCacheAtomically(cachePath, attemptCache);
    const response = await fetchImpl(sourceUrl, {
      headers: { accept: "text/plain" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response?.ok) {
      throw new Error(`Pricing fetch failed${response?.status ? ` (HTTP ${response.status})` : ""}`);
    }

    const source = await readResponseText(response, maxResponseBytes);
    const tiers = parseCopilotPricingTable(source);
    const refreshedCache = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      sourceUrl,
      lastAttemptAt: timestamp,
      lastUpdatedAt: timestamp,
      lastUpdatedDateUtc: timestamp.slice(0, 10),
      lastError: null,
      tiers,
    };
    await writeCacheAtomically(cachePath, refreshedCache);
    return { cache: refreshedCache, refreshed: true, attempted: true };
  } catch (error) {
    const failureCache = {
      ...cached,
      schemaVersion: CACHE_SCHEMA_VERSION,
      sourceUrl,
      lastAttemptAt: timestamp,
      lastError: error instanceof Error ? error.message : String(error),
    };
    try {
      await writeCacheAtomically(cachePath, failureCache);
    } catch {
      // Keep the last-good in-memory value if even the cache directory is unwritable.
    }
    return { cache: failureCache, refreshed: false, attempted: true, error: failureCache.lastError };
  }
}
