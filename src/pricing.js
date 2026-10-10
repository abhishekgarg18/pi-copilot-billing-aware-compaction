export const COPILOT_PROVIDER_ID = "github-copilot";
export const DEFAULT_SAFETY_RATIO = 0.9;

function unquote(value) {
  const text = value.trim();
  if (text.length >= 2 && text[0] === "'" && text.at(-1) === "'") {
    return text.slice(1, -1).replaceAll("''", "'");
  }
  if (text.length >= 2 && text[0] === '"' && text.at(-1) === '"') {
    try {
      return JSON.parse(text);
    } catch {
      return text.slice(1, -1);
    }
  }
  return text.replace(/\s+#.*$/, "").trim();
}

function field(block, name) {
  const match = block.match(new RegExp(`^\\s*${name}:\\s*(.*?)\\s*$`, "m"));
  return match ? unquote(match[1]) : undefined;
}

function modelName(block) {
  const match = block.match(/^\s*-\s*model:\s*(.*?)\s*$/m);
  return match ? unquote(match[1]) : undefined;
}

function parseGreaterThanTokens(value) {
  const match = value?.match(/^>\s*([\d,]+(?:\.\d+)?)\s*([KM])?$/i);
  if (!match) return undefined;

  const magnitude = Number(match[1].replaceAll(",", ""));
  const multiplier = match[2]?.toUpperCase() === "M" ? 1_000_000 : match[2] ? 1_000 : 1;
  const tokens = magnitude * multiplier;
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined;
}

/** Parse GitHub's public Copilot pricing YAML, retaining only long-context cutoffs. */
export function parseCopilotPricingTable(source) {
  if (typeof source !== "string") throw new TypeError("Pricing source must be text");

  const rows = source
    .split(/(?=^\s*-\s*model\s*:)/m)
    .filter((block) => /^\s*-\s*model\s*:/m.test(block));
  const tiers = [];

  for (const block of rows) {
    const model = modelName(block);
    const provider = field(block, "provider");
    const tier = field(block, "tier");
    const threshold = field(block, "threshold");
    const thresholdTokens = parseGreaterThanTokens(threshold);

    if (!model || tier?.toLowerCase() !== "long context" || !thresholdTokens) continue;
    tiers.push({ model, provider: provider?.toLowerCase(), thresholdTokens });
  }

  if (tiers.length === 0) {
    throw new Error("Pricing data contained no parseable long-context tiers");
  }
  return tiers;
}

export function normalizeModelName(value) {
  return typeof value === "string" ? value.toLowerCase().replace(/[^a-z0-9]/g, "") : "";
}

/** Match a Pi Copilot model by normalized model ID or display name. */
export function findCopilotBillingTier(model, tiers) {
  if (model?.provider !== COPILOT_PROVIDER_ID || !Array.isArray(tiers)) return undefined;

  const identifiers = new Set([normalizeModelName(model.id), normalizeModelName(model.name)].filter(Boolean));
  return tiers.find((entry) => identifiers.has(normalizeModelName(entry.model)));
}

export function getCompactionThreshold(billingCutoffTokens, safetyRatio = DEFAULT_SAFETY_RATIO) {
  if (!Number.isFinite(billingCutoffTokens) || billingCutoffTokens <= 0) {
    throw new RangeError("Billing cutoff must be a positive token count");
  }
  if (!Number.isFinite(safetyRatio) || safetyRatio <= 0 || safetyRatio >= 1) {
    throw new RangeError("Safety ratio must be greater than 0 and less than 1");
  }
  return Math.floor(billingCutoffTokens * safetyRatio);
}
