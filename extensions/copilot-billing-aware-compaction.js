import os from "node:os";
import path from "node:path";

import { COPILOT_PRICING_SOURCE_URL, getDailyPricingCache } from "../src/cache.js";
import { createCompactionMonitor } from "../src/monitor.js";
import { findCopilotBillingTier, getCompactionThreshold } from "../src/pricing.js";

const CACHE_PATH = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "cache",
  "copilot-billing-tiers.json",
);
const COMPACTION_INSTRUCTIONS =
  "Preserve the user's goal, constraints, decisions, completed work, unresolved questions, and precise next steps. Drop stale tool output and redundant exploration. Keep identifiers and facts needed to continue correctly.";

function notify(ctx, message, level = "info") {
  if (ctx?.hasUI) ctx.ui.notify(message, level);
  else if (level === "error") console.error(`[copilot-tier-compaction] ${message}`);
}

function compactAndWait(ctx) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    try {
      ctx.compact({
        customInstructions: COMPACTION_INSTRUCTIONS,
        onComplete: () => finish({ ok: true }),
        onError: (error) => finish({ ok: false, error: error?.message ?? String(error) }),
      });
    } catch (error) {
      finish({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
}

function displayDate(value) {
  if (!value) return "never";
  return value.replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

export function registerCopilotBillingAwareCompaction(
  pi,
  {
    getPricingCache = () => getDailyPricingCache({ cachePath: CACHE_PATH }),
    compact = compactAndWait,
    onStatus = (status) => {
      if (status.type === "compaction-started") {
        console.info(
          `[copilot-tier-compaction] ${status.model}: ${status.contextTokens.toLocaleString()} estimated tokens; ` +
            `billing cutoff ${status.billingCutoffTokens.toLocaleString()}, compacting before next model turn`,
        );
      } else if (status.type === "compaction-failed") {
        console.error(`[copilot-tier-compaction] Compaction failed: ${status.error ?? "unknown error"}`);
      }
    },
  } = {},
) {
  let refreshInFlight;
  let cache;
  const refreshCache = async () => {
    if (!refreshInFlight) {
      refreshInFlight = getPricingCache().then((result) => {
        if (result.error && result.attempted) {
          console.warn(`[copilot-tier-compaction] Pricing refresh failed; retaining last-good cache: ${result.error}`);
        }
        cache = result.cache ?? result;
        return cache;
      }).finally(() => {
        refreshInFlight = undefined;
      });
    }
    return refreshInFlight;
  };

  const monitorTurnEnd = createCompactionMonitor({
    getTiers: async () => (cache ?? (await refreshCache())).tiers,
    compact,
    onStatus,
  });

  // Load or refresh before the first model request; turn_end also checks for a daily refresh.
  pi.on("before_agent_start", async () => {
    await refreshCache();
  });

  // This awaited hook runs between assistant turns, including tool cycles in one active agent run.
  pi.on("turn_end", async (event, ctx) => {
    await refreshCache();
    await monitorTurnEnd(event, ctx);
  });

  pi.registerCommand("copilot-tier-compaction-status", {
    description: "Show Copilot pricing-cache age and active model compaction threshold",
    handler: async (_args, ctx) => {
      const current = await refreshCache();
      const tier = findCopilotBillingTier(ctx.model, current.tiers);
      const modelLabel = ctx.model?.name || ctx.model?.id || "none";
      const lines = [
        `Active model: ${modelLabel} (${ctx.model?.provider ?? "no provider"})`,
        `Pricing source: ${COPILOT_PRICING_SOURCE_URL}`,
        `Cache last checked: ${displayDate(current.lastAttemptAt)}`,
        `Cache last updated: ${current.lastUpdatedDateUtc ?? "never"} UTC (${displayDate(current.lastUpdatedAt)})`,
      ];
      if (tier) {
        lines.push(
          `Billing cutoff: ${tier.thresholdTokens.toLocaleString()} input tokens`,
          `Auto-compaction trigger: ${getCompactionThreshold(tier.thresholdTokens).toLocaleString()} estimated context tokens`,
        );
      } else {
        lines.push("No matching Copilot long-context tier; billing-aware compaction is inactive for this model.");
      }
      if (current.lastError) lines.push(`Last refresh error: ${current.lastError}`);
      notify(ctx, lines.join("\n"), current.lastError && current.tiers.length === 0 ? "error" : "info");
    },
  });
}

export default function copilotBillingAwareCompaction(pi) {
  return registerCopilotBillingAwareCompaction(pi);
}
