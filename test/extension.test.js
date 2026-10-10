import test from "node:test";
import assert from "node:assert/strict";

import extension, {
  registerCopilotBillingAwareCompaction,
} from "../extensions/copilot-billing-aware-compaction.js";

test("registers cache refresh and in-run turn-end compaction hooks", () => {
  const events = new Map();
  const commands = new Map();
  const pi = {
    on(name, handler) {
      events.set(name, handler);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
  };

  extension(pi);

  assert.equal(typeof events.get("before_agent_start"), "function");
  assert.equal(typeof events.get("turn_end"), "function");
  assert.equal(typeof commands.get("copilot-tier-compaction-status")?.handler, "function");
});

test("turn_end waits for Pi compaction callback before resolving the active boundary", async () => {
  const events = new Map();
  const commands = new Map();
  let compactionCompleted = false;
  let pi;
  pi = {
    on(name, handler) {
      events.set(name, handler);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
  };
  registerCopilotBillingAwareCompaction(pi, {
    getPricingCache: async () => ({
      cache: {
        tiers: [{ model: "GPT-5.4", provider: "openai", thresholdTokens: 100_000 }],
        lastAttemptAt: "2026-06-01T12:00:00.000Z",
        lastUpdatedAt: "2026-06-01T12:00:00.000Z",
        lastUpdatedDateUtc: "2026-06-01",
        lastError: null,
      },
      attempted: false,
    }),
    compact: async (ctx) =>
      new Promise((resolve) => {
        ctx.compact({
          onComplete: () => {
            compactionCompleted = true;
            resolve({ ok: true });
          },
          onError: (error) => resolve({ ok: false, error: error.message }),
        });
      }),
  });

  const handler = events.get("turn_end");
  const ctx = {
    model: { provider: "github-copilot", id: "gpt-5.4", name: "GPT-5.4" },
    getContextUsage: () => ({ tokens: 90_000, contextWindow: 1_000_000, percent: 0.09 }),
    compact: (options) => setTimeout(() => options.onComplete({}), 0),
    hasUI: false,
  };

  await handler({ type: "turn_end", toolResults: [{}] }, ctx);
  assert.equal(compactionCompleted, true);
});
