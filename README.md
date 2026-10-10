# Pi Copilot Billing-Aware Compaction

A Pi extension that refreshes GitHub Copilot long-context pricing tiers and compacts active sessions before they approach a model's higher-priced input tier.

## Behavior

- Reads the official pricing data behind [GitHub's Copilot models and pricing page](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing).
- Refreshes the pricing cache at most once every 24 hours. A failed fetch preserves the last-known-good tier data and is not retried until the 24-hour interval passes.
- Matches the active `github-copilot` model by normalized Pi model ID or display name.
- Compacts at 90% of that model's current long-context input cutoff. Examples: `100K` → `90K`, `200K` → `180K`, `272K` → `244.8K` estimated context tokens.
- Checks on Pi's awaited `turn_end` boundary. When the trigger is reached, compaction completes before Pi continues the active agent run; it does not wait for a new user prompt.
- Does not interrupt a model request already in flight. Context usage is Pi's estimate, so the 10% margin is a safety buffer, not a guarantee against every billing-boundary crossing.
- Models without a matching Copilot long-context pricing row are left to Pi's normal compaction behavior.

## Install

From the workspace root:

```bash
pi install ./pi-extensions/copilot-billing-aware-compaction
```

This installs the package into the current user's Pi configuration. Restart Pi after installation.

Optional visual companion: `pi install npm:pi-nano-context`. It displays context composition; it does not apply Copilot billing cutoffs or compact sessions.

`pi-voluntary-compaction` uses model-directed cleanup and asks users to disable Pi auto-compaction. Do not combine it with this package: this extension relies on Pi's normal `ctx.compact()` pipeline.

## Cache and tracking

Cache file:

```text
~/.pi/agent/cache/copilot-billing-tiers.json
```

The JSON records `lastAttemptAt` (used to enforce the 24-hour refresh interval), `lastUpdatedAt` and `lastUpdatedDateUtc` (last successful cache refresh), `lastError`, source URL, and parsed model cutoffs. Failed refreshes update the attempt/error fields but retain the previous successful timestamp and tier data.

Show cache age and the active model's resolved cutoff with:

```text
/copilot-tier-compaction-status
```

## Development

No third-party runtime dependencies.

```bash
cd pi-extensions/copilot-billing-aware-compaction
npm test
```
