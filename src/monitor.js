import {
  DEFAULT_SAFETY_RATIO,
  findCopilotBillingTier,
  getCompactionThreshold,
  normalizeModelName,
} from "./pricing.js";

const REARM_RATIO = 0.8;
const SUCCESS_RETRY_GROWTH_RATIO = 0.05;
const FAILURE_RETRY_GROWTH_RATIO = 0.01;
const MIN_RETRY_GROWTH_TOKENS = 500;

/** Create an async turn_end handler that compacts before Pi continues its active run. */
export function createCompactionMonitor({
  getTiers,
  compact,
  onStatus = () => {},
  safetyRatio = DEFAULT_SAFETY_RATIO,
}) {
  if (typeof getTiers !== "function") throw new TypeError("getTiers must be a function");
  if (typeof compact !== "function") throw new TypeError("compact must be a function");

  const lastTriggerTokensByModel = new Map();

  return async function monitorTurnEnd(event, ctx) {
    const model = ctx?.model;
    const tiers = await getTiers();
    const tier = findCopilotBillingTier(model, tiers);
    const tokens = ctx?.getContextUsage?.()?.tokens;
    if (!tier || !Number.isFinite(tokens)) return { triggered: false, reason: "no-match-or-usage" };

    const thresholdTokens = getCompactionThreshold(tier.thresholdTokens, safetyRatio);
    const rearmBelowTokens = Math.floor(thresholdTokens * REARM_RATIO);
    const modelKey = `${model.provider}:${normalizeModelName(model.id || model.name)}`;
    let lastTrigger = lastTriggerTokensByModel.get(modelKey);

    if (lastTrigger !== undefined && tokens < rearmBelowTokens) {
      lastTriggerTokensByModel.delete(modelKey);
      lastTrigger = undefined;
    }
    if (tokens < thresholdTokens) return { triggered: false, reason: "below-threshold", thresholdTokens };

    const retryGrowthRatio = lastTrigger?.failed
      ? FAILURE_RETRY_GROWTH_RATIO
      : SUCCESS_RETRY_GROWTH_RATIO;
    const retryGrowth = Math.max(MIN_RETRY_GROWTH_TOKENS, Math.floor(thresholdTokens * retryGrowthRatio));
    if (lastTrigger !== undefined && tokens < lastTrigger.tokens + retryGrowth) {
      return { triggered: false, reason: "already-triggered", thresholdTokens };
    }

    lastTriggerTokensByModel.set(modelKey, { tokens, failed: false });
    const details = {
      model: model.name || model.id,
      billingCutoffTokens: tier.thresholdTokens,
      thresholdTokens,
      contextTokens: tokens,
      eventType: event?.type,
    };
    onStatus({ type: "compaction-started", ...details });

    const result = await compact(ctx, details);
    if (result?.ok === false) {
      // Retry after small additional growth; failed attempts must not consume the full safety margin.
      lastTriggerTokensByModel.set(modelKey, { tokens, failed: true });
      onStatus({ type: "compaction-failed", ...details, error: result.error });
      return { triggered: true, compacted: false, ...details };
    }

    const afterTokens = ctx.getContextUsage?.()?.tokens;
    if (Number.isFinite(afterTokens) && afterTokens < rearmBelowTokens) {
      lastTriggerTokensByModel.delete(modelKey);
    }
    onStatus({ type: "compaction-completed", ...details });
    return { triggered: true, compacted: true, ...details };
  };
}
