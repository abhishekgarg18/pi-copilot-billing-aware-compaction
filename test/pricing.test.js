import test from "node:test";
import assert from "node:assert/strict";

import {
  findCopilotBillingTier,
  getCompactionThreshold,
  parseCopilotPricingTable,
} from "../src/pricing.js";

const fixture = `
- model: GPT-5.4
  provider: openai
  tier: Default
  threshold: '≤ 272K'
  input: $2.50
- model: GPT-5.4
  provider: openai
  tier: Long context
  threshold: '> 272K'
  input: $5.00
- model: Claude Haiku 5.5
  provider: anthropic
  tier: Long context
  threshold: '> 100K'
  input: $0.50
- model: Grok 4.7
  provider: xai
  tier: 'Long context'
  threshold: '> 200K'
  input: $4.00
- model: GPT-5 mini
  provider: openai
  tier: Default
  threshold: Not applicable
  input: $0.25
`;

test("parses only long-context billing cutoffs from official pricing rows", () => {
  assert.deepEqual(parseCopilotPricingTable(fixture), [
    { model: "GPT-5.4", provider: "openai", thresholdTokens: 272_000 },
    { model: "Claude Haiku 5.5", provider: "anthropic", thresholdTokens: 100_000 },
    { model: "Grok 4.7", provider: "xai", thresholdTokens: 200_000 },
  ]);
});

test("maps normalized Copilot model IDs to live billing cutoffs", () => {
  const tiers = parseCopilotPricingTable(fixture);

  assert.equal(
    findCopilotBillingTier(
      { provider: "github-copilot", id: "gpt-5.4", name: "GPT-5.4" },
      tiers,
    )?.thresholdTokens,
    272_000,
  );
  assert.equal(
    findCopilotBillingTier(
      { provider: "github-copilot", id: "claude-haiku-5.5", name: "Claude Haiku 5.5" },
      tiers,
    )?.thresholdTokens,
    100_000,
  );
  assert.equal(
    findCopilotBillingTier({ provider: "anthropic", id: "claude-haiku-5.5" }, tiers),
    undefined,
  );
  assert.equal(
    findCopilotBillingTier({ provider: "github-copilot", id: "unknown-model" }, tiers),
    undefined,
  );
});

test("uses 90 percent of each live billing cutoff as compaction trigger", () => {
  assert.equal(getCompactionThreshold(100_000), 90_000);
  assert.equal(getCompactionThreshold(200_000), 180_000);
  assert.equal(getCompactionThreshold(272_000), 244_800);
  assert.throws(() => getCompactionThreshold(0), /positive/);
});
