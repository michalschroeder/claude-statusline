# Recomputed cross-session cost tracking — design

Date: 2026-06-08

## Goal

Bring back **session + daily/weekly/monthly cost** on the statusline and in the
session viewer (`bin/sessions.js`), but compute spend from **raw token counts ×
per-token LiteLLM prices** rather than trusting Claude Code's
`cost.total_cost_usd`. Cross-session d/w/m tracking was removed in PR #19
(commit `eff0579`) precisely because the old design trusted Claude's cumulative
cost; this re-adds it with accurate, recomputed math.

Source of the cost algorithm: `docs/claude-code-cost-replication.md` (kept in the
`codeburn` repo). Section numbers below (§3–§7) refer to that document.

## Constraints (inherited from the project)

- **The renderer (`hooks/statusline.js`) must stay cheap.** It runs on every
  render, no subprocesses, fast file IO only. It MUST NOT parse all transcripts
  or fetch the network. It reads a small precomputed cache.
- **Data lives in our own XDG state dir** (`<STATE>` =
  `${XDG_STATE_HOME:-$HOME/.local/state}/claude-statusline/<profile>`), never
  inside `CLAUDE_CONFIG_DIR`. `CLAUDE_CONFIG_DIR` is only the per-profile key.
- **Silent failure** everywhere on the render path — never break the prompt.
- Single `CLAUDE_CONFIG_DIR` (the existing profile key), not the spec's
  `CLAUDE_CONFIG_DIRS` multi-dir form. Each profile aggregates only its own
  config dir's transcripts (consistent with existing per-subscription
  separation).

## Architecture overview

```
transcripts (JSONL)  --aggregate-->  cost-cache.json  --read-->  statusline (d/w/m)
        |                  ^                                          + live session payload
        |                  |
        |            UserPromptSubmit hook (refresh-cost-cache)
        |                  |
        +--aggregate-------+--------------------------->  bin/sessions.js (full history)

pricing: bundled data/model_prices.json  (+ ≤24h LiteLLM fetch → <STATE>/pricing.json)
```

The renderer never aggregates and never fetches. Aggregation happens in a
`UserPromptSubmit` hook (for the statusline cache) and on demand in the viewer.

## Modules

### `lib/pricing.js` — LiteLLM price table

- Ships a bundled snapshot `data/model_prices.json` checked into the repo
  (offline fallback).
- `loadPricing(stateDir)` returns a sanitized price map plus a `pricingHash`
  (used for cache invalidation). It fetches the LiteLLM JSON
  (`https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`)
  **at most every 24h**, caching the raw result + fetch timestamp to
  `<STATE>/pricing.json`. On any network/parse failure it falls back to the
  newer of the cached fetch or the bundled snapshot. **Never called from the
  renderer.**
- Per model, extract (§4): `inputCostPerToken`, `outputCostPerToken`,
  `cacheWriteCostPerToken` (fallback input×1.25), `cacheReadCostPerToken`
  (fallback input×0.1), `fastMultiplier` (fallback 1), `webSearchCostPerRequest`
  (flat 0.01).
- **Sanitize every rate**: reject NaN/Infinity/negative → treat as absent; clamp
  any per-token rate `> 1` down to `1`.
- Index each model also under its provider-stripped name (`anthropic/claude-...`
  → `claude-...`), first write wins.
- **Model lookup** (§4): exact (strip trailing `@...` and `-YYYYMMDD`), then
  longest-prefix match (`model === key || model.startsWith(key + "-")`). No match
  → `$0`. Local models (name contains `:` or ends `-q4`/`bf16`/`fp16`/`gguf`/
  `f16`/`f32`) → silently `$0`.

### `lib/cost-compute.js` — pure per-call math

No IO; fully unit-testable.

- `extractCacheCreation(usage)` → `{ fiveMinute, oneHour }` per §3 (split form
  with legacy fallback; keep the larger total; clamp non-negative).
- `calculateCost(model, usage, pricing)` → USD per §5:

  ```
  multiplier = (speed === "fast") ? costs.fastMultiplier : 1
  cost = multiplier * (
        inputTokens       * inputCostPerToken
      + outputTokens      * outputCostPerToken
      + fiveMinuteTokens  * cacheWriteCostPerToken
      + oneHourTokens     * cacheWriteCostPerToken * 1.6
      + cacheReadTokens   * cacheReadCostPerToken
      + webSearchRequests * webSearchCostPerRequest
  )
  ```

  Clamp every token field to finite non-negative first. Unknown model → 0.

### `lib/cost-aggregate.js` — shared aggregator

`aggregate(configDir, pricing, { sinceMtimeMs, cache })` →
`{ perSession, byDay, files }`:

- `perSession`: `{ <sessionId>: { days: {"YYYY-MM-DD": cost}, total, firstTs } }`
- `byDay`: `{ "YYYY-MM-DD": { cost, inputTokens, outputTokens, cacheRead, cacheWrite, calls } }`
- `files`: per-file cache entries (see cache format) so the caller can persist.

Procedure:

1. Enumerate `<configDir>/projects/*/*.jsonl`. When `sinceMtimeMs` is given, skip
   files whose `mtime < sinceMtimeMs` (statusline's 40-day window; the viewer
   omits this for full history).
2. **Incremental reuse**: for each file, if `cache.files[path]` exists with the
   same `mtime` and `size`, reuse its cached `calls` list (no re-read). Otherwise
   parse the file: skip unparseable lines; **dedup within file** keeping the
   *last* occurrence per `message.id` (carry the first occurrence's timestamp);
   price each assistant call; record `calls: [{ id, dayKey, cost }]`.
3. **Global dedup** (§6): process files **mtime-ascending**; keep one `Set` of
   message ids for the whole run; the first time an id is seen it counts, later
   appearances (in any file, e.g. resumed sessions) are skipped. Calls without an
   id use a synthetic key `claude:<ts>` and are always kept. This is rebuilt from
   the cached id lists each run, so incremental reuse stays correct.
4. **Day bucketing** (§7): `dayKey(iso)` = local calendar `YYYY-MM-DD` (parse the
   UTC instant, read local `getFullYear/getMonth/getDate`). Each call buckets by
   its own timestamp, so a session spanning midnight splits across days.
5. If `cache.pricingHash !== pricing.pricingHash`, ignore the cache (full
   rebuild) — cached per-file costs are stale when prices change.

### `lib/budget.js` — budget contract

Restored `resolveBudget(raw)` (was in the removed `lib/cost.js`):

- Strict `Number` parse; empty/whitespace → unset.
- `0` → `budgetOptedOut: true` (renderer hides d/w/m).
- `> 0` → that monthly budget; otherwise (unset / negative / non-numeric) → `500`
  fallback.
- Derived limits: `daily = monthly / 30`, `weekly = monthly * 7 / 30`.

### `lib/color.js` — add `BUDGET_TIERS`

`SESSION_TIERS`, `COST_TIERS`, `colorByTier`, `orange` already present. Add
`BUDGET_TIERS = [0.5, 0.75, 0.9]` (budget-relative cost/limit ratio thresholds, so
a period goes red at 90% of its limit — the exact tuple the removed code used).
Tiers are part of the tested contract.

## Cache format — `<STATE>/cost-cache.json`

```jsonc
{
  "pricingHash": "<hash of the price map>",
  "files": {
    "<absolute jsonl path>": {
      "mtime": 1733650000000,
      "size": 12345,
      "sessionId": "<id>",
      "calls": [ { "id": "msg_...", "dayKey": "2026-06-08", "cost": 0.0123 } ]
    }
  }
}
```

- Scoped to files with `mtime` within the **last ~40 days** (covers the current
  month plus week spillover). Older files are never parsed for the statusline —
  d/w/m only need recent windows. The viewer ignores this cap.
- Storing per-call `(id, dayKey, cost)` (not full token detail) keeps the cache
  small while preserving correct global dedup and per-day rollup.

## Refresh trigger — `UserPromptSubmit` hook

New `hooks/refresh-cost-cache.js` (invoked from a thin bash wrapper or directly,
matching the project's hook style):

1. Resolve `<STATE>` from `CLAUDE_CONFIG_DIR` (same mangling as everywhere).
2. `loadPricing(stateDir)` (handles the ≤24h fetch + fallback).
3. Read existing `cost-cache.json` (if any), run incremental `aggregate` with
   `sinceMtimeMs = now - 40d`, write the updated cache atomically.
4. Fully silent on error; never block the prompt.

Runs once per turn, off the render hot path. Incremental skipping makes it cheap
even with months of history.

## Renderer changes — `hooks/statusline.js`

- Read `cost-cache.json` (small JSON; silent failure → no d/w/m).
- Compute today/week/month windows as **local-calendar starts** (today's
  midnight, this week's Monday via `(getDay()+6)%7`, the 1st of the month) — same
  math as the removed `bucketPeriods`. Sum `perSession[*].days[dayKey]` over the
  relevant day keys, **excluding the current `session_id`** to avoid
  double-counting.
- **Fold the current session's live `cost.total_cost_usd`** into today/week/month
  (it is within all three windows). This realizes the "current session + other
  sessions" model and makes parallel sessions self-heal each turn (each prompt
  flushes committed spend to the cache).
- Restore the s/d/w/m chip group: `formatCost` (session, `SESSION_TIERS`
  absolute) + `formatPeriodCost` (period, `BUDGET_TIERS` budget-relative),
  joined by the dim `·` separator, like rate limits. Budget via
  `lib/budget.js`. `budgetOptedOut` → show only the session chip (drop the `s `
  prefix). Segment name remains `cost`.

## Viewer changes — `bin/sessions.js`

- Use `lib/cost-aggregate` over full history (no 40-day cap; slow is fine) +
  `lib/pricing.js`.
- Add an accurate per-session **COST** column (from `perSession[id].total`) and a
  d/w/m summary footer (local-calendar windows, same math as the renderer).
- Honor `--config-dir`. No `--all-profiles`.

## Edge cases

- **Current live session spanning midnight**: its whole payload cost attributes
  to "today" until the next refresh flushes it to the cache, after which it is
  per-call bucketed correctly. Accepted minor inaccuracy, live session only.
- **Parallel sessions**: each statusline misses at most the *other* session's
  spend since that session's last prompt; resolves on the next refresh of either
  session. Strictly better than the old SessionEnd-only flush.
- **Unknown / local models** → `$0`, never a crash.
- **Pricing change** invalidates the whole cache (full rebuild next refresh).

## Testing

Bundled snapshot makes everything offline-deterministic.

- `tests/pricing.test.js` — sanitize (NaN/Inf/negative/clamp), fallbacks,
  provider-stripped indexing, model lookup (exact, date/`@` strip, longest
  prefix), local/unknown → $0, bundled-fallback path.
- `tests/cost-compute.test.js` — cache 5m/1h split + legacy fallback, fast
  multiplier on whole call, 1h×1.6, full formula, clamping.
- `tests/cost-aggregate.test.js` — within-file dedup (keep last), global dedup
  across files, resumed-session id replay not double-counted, midnight day split,
  incremental skip by mtime/size, pricing-hash invalidation.
- `tests/period-cost.test.js` — restore: local-calendar window math + budget
  tiers + `resolveBudget` (unset→500, 0→opt-out, derived daily/weekly).
- Renderer d/w/m test (extend `tests/cost.test.js` or a new file) — cache sum +
  live fold + current-session exclusion + budget coloring + opt-out.
- Viewer cost test (extend `tests/sessions-viewer.test.js`) — per-session COST
  column + d/w/m footer.

## Decisions made during design

- Budget logic lives in a new `lib/budget.js` (not resurrecting the catch-all
  `lib/cost.js`).
- 40-day retention window for the statusline cache.
- Approach A (incremental per-session cache, refresh on `UserPromptSubmit`).
- Pricing: bundled snapshot + ≤24h LiteLLM fetch.
- Budget unset → $500/mo default; `0` hides d/w/m.

## Open questions

None.
