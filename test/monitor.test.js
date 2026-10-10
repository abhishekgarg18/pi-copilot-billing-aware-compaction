import test from "node:test";
import assert from "node:assert/strict";

import { createCompactionMonitor } from "../src/monitor.js";

const tier = { model: "GPT-5.4", provider: "openai", thresholdTokens: 100_000 };

function fakeContext({ provider = "github-copilot", id = "gpt-5.4", tokens = 90_000, compact } = {}) {
  return {
    model: { provider, id, name: "GPT-5.4" },
    getContextUsage: () => ({ tokens, contextWindow: 1_000_000, percent: tokens / 10_000 }),
    compact,
  };
}

test("compacts and awaits completion at the billing safety threshold inside turn_end", async () => {
  let compactions = 0;
  let completed = false;
  const monitor = createCompactionMonitor({
    getTiers: async () => [tier],
    compact: async () => {
      compactions += 1;
      await new Promise((resolve) => setTimeout(resolve, 0));
      completed = true;
      return { ok: true };
    },
  });

  await monitor({ type: "turn_end", toolResults: [{}] }, fakeContext());

  assert.equal(compactions, 1);
  assert.equal(completed, true);
});

test("does not compact below the billing threshold or for other providers", async () => {
  let compactions = 0;
  const monitor = createCompactionMonitor({
    getTiers: async () => [tier],
    compact: async () => {
      compactions += 1;
      return { ok: true };
    },
  });

  await monitor({}, fakeContext({ tokens: 89_999 }));
  await monitor({}, fakeContext({ provider: "anthropic", tokens: 99_000 }));
  assert.equal(compactions, 0);
});

test("re-arms after successful compaction lowers usage, without retriggering on unchanged high usage", async () => {
  let compactions = 0;
  let tokens = 90_000;
  const ctx = fakeContext({ compact: undefined });
  ctx.getContextUsage = () => ({ tokens, contextWindow: 1_000_000, percent: tokens / 10_000 });
  const monitor = createCompactionMonitor({
    getTiers: async () => [tier],
    compact: async () => {
      compactions += 1;
      tokens = 20_000;
      return { ok: true };
    },
  });

  await monitor({}, ctx);
  tokens = 90_000;
  await monitor({}, ctx);
  assert.equal(compactions, 2);
});

test("retries a failed compaction after small context growth, before nearing the billing cutoff", async () => {
  let compactions = 0;
  let tokens = 90_000;
  const ctx = fakeContext();
  ctx.getContextUsage = () => ({ tokens, contextWindow: 1_000_000, percent: tokens / 10_000 });
  const monitor = createCompactionMonitor({
    getTiers: async () => [tier],
    compact: async () => {
      compactions += 1;
      if (compactions === 1) return { ok: false, error: "temporary failure" };
      tokens = 20_000;
      return { ok: true };
    },
  });

  await monitor({}, ctx);
  tokens = 90_500;
  await monitor({}, ctx);
  assert.equal(compactions, 1);

  tokens = 90_900;
  await monitor({}, ctx);
  assert.equal(compactions, 2);
});
