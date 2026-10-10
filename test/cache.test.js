import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getDailyPricingCache } from "../src/cache.js";

const pricingYaml = `
- model: GPT-5.4
  provider: openai
  tier: Long context
  threshold: '> 272K'
  input: $5.00
`;

async function withCachePath(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-copilot-tier-"));
  try {
    await run(path.join(dir, "pricing-cache.json"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("refreshes at most once per 24 hours and persists the last-success date", async () => {
  await withCachePath(async (cachePath) => {
    let fetches = 0;
    const fetchImpl = async () => {
      fetches += 1;
      return new Response(pricingYaml, { status: 200 });
    };

    const first = await getDailyPricingCache({
      cachePath,
      now: new Date("2026-06-01T10:00:00.000Z"),
      fetchImpl,
    });
    assert.equal(first.refreshed, true);
    assert.equal(first.cache.lastAttemptAt, "2026-06-01T10:00:00.000Z");
    assert.equal(first.cache.lastUpdatedAt, "2026-06-01T10:00:00.000Z");

    const sameDay = await getDailyPricingCache({
      cachePath,
      now: new Date("2026-06-01T23:59:00.000Z"),
      fetchImpl,
    });
    assert.equal(sameDay.refreshed, false);
    assert.equal(sameDay.cache.lastUpdatedAt, "2026-06-01T10:00:00.000Z");
    assert.equal(fetches, 1);

    const before24Hours = await getDailyPricingCache({
      cachePath,
      now: new Date("2026-06-02T09:59:00.000Z"),
      fetchImpl,
    });
    assert.equal(before24Hours.attempted, false);
    assert.equal(fetches, 1);

    const nextDay = await getDailyPricingCache({
      cachePath,
      now: new Date("2026-06-02T10:01:00.000Z"),
      fetchImpl,
    });
    assert.equal(nextDay.refreshed, true);
    assert.equal(nextDay.cache.lastUpdatedAt, "2026-06-02T10:01:00.000Z");
    assert.equal(nextDay.cache.lastUpdatedDateUtc, "2026-06-02");
    assert.equal(fetches, 2);

    const persisted = JSON.parse(await readFile(cachePath, "utf8"));
    assert.equal(persisted.lastUpdatedAt, "2026-06-02T10:01:00.000Z");
    assert.equal(persisted.lastUpdatedDateUtc, "2026-06-02");
    assert.equal(persisted.tiers[0].thresholdTokens, 272_000);
  });
});

test("rejects oversized pricing data and preserves the last-good cache", async () => {
  await withCachePath(async (cachePath) => {
    const previous = {
      schemaVersion: 1,
      sourceUrl: "https://example.test/pricing.yml",
      lastAttemptAt: "2026-06-01T00:00:00.000Z",
      lastUpdatedAt: "2026-06-01T00:00:00.000Z",
      lastUpdatedDateUtc: "2026-06-01",
      lastError: null,
      tiers: [{ model: "GPT-5.4", provider: "openai", thresholdTokens: 272_000 }],
    };
    await writeFile(cachePath, JSON.stringify(previous));

    const result = await getDailyPricingCache({
      cachePath,
      now: new Date("2026-06-02T00:00:00.000Z"),
      maxResponseBytes: 32,
      fetchImpl: async () => new Response("x".repeat(128), { status: 200 }),
    });

    assert.equal(result.refreshed, false);
    assert.equal(result.cache.lastUpdatedAt, previous.lastUpdatedAt);
    assert.equal(result.cache.tiers[0].thresholdTokens, 272_000);
    assert.match(result.cache.lastError, /exceeds maximum/);
  });
});

test("fails closed when the pricing response cannot be size-limited", async () => {
  await withCachePath(async (cachePath) => {
    const result = await getDailyPricingCache({
      cachePath,
      now: new Date("2026-06-02T00:00:00.000Z"),
      fetchImpl: async () => ({ ok: true, text: async () => pricingYaml }),
    });

    assert.equal(result.refreshed, false);
    assert.match(result.cache.lastError, /readable body/);
  });
});

test("failed refresh preserves last-good data and respects the 24-hour retry interval", async () => {
  await withCachePath(async (cachePath) => {
    const previous = {
      schemaVersion: 1,
      sourceUrl: "https://example.test/pricing.yml",
      lastAttemptAt: "2026-06-01T12:00:00.000Z",
      lastUpdatedAt: "2026-06-01T12:00:00.000Z",
      lastError: null,
      tiers: [{ model: "GPT-5.4", provider: "openai", thresholdTokens: 272_000 }],
    };
    await writeFile(cachePath, JSON.stringify(previous));

    let fetches = 0;
    const failFetch = async () => {
      fetches += 1;
      throw new Error("network unavailable");
    };
    const firstAttempt = await getDailyPricingCache({
      cachePath,
      now: new Date("2026-06-02T12:00:00.000Z"),
      fetchImpl: failFetch,
    });
    assert.equal(firstAttempt.refreshed, false);
    assert.equal(firstAttempt.cache.lastUpdatedAt, previous.lastUpdatedAt);
    assert.equal(firstAttempt.cache.lastAttemptAt, "2026-06-02T12:00:00.000Z");
    assert.match(firstAttempt.cache.lastError, /network unavailable/);

    const sameDay = await getDailyPricingCache({
      cachePath,
      now: new Date("2026-06-02T21:00:00.000Z"),
      fetchImpl: failFetch,
    });
    assert.equal(sameDay.cache.lastUpdatedAt, previous.lastUpdatedAt);
    assert.equal(fetches, 1);
  });
});
