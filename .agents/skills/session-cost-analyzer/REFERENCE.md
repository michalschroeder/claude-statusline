# Cost interpretation model

**Cost ≈ context-size × steps. Subagents are cheap; bloated MAIN-session context is the real cost.**

- The MAIN thread re-reading/re-caching its own accumulated context dominates: typically
  `cache-read` (~47%) + `cache-write` (~31%) ≫ `output` (~20%) ≫ fresh `input` (~2%).
- Each subagent spawns with its **own fresh ~5–35k context** — it does **not** inherit the
  parent's 200k+. It returns only a few-KB summary. So fan-out (planning, parallel review
  lenses, research) costs cents. In one measured $32.94 session, all 11 subagents (226 calls)
  were **$1.04 (3%)**; the main session (192 calls) was **$31.90 (97%)**.
- `summary.highContextCost` = spend on calls **above 200k context** = exactly what a `/compact`
  would have cut.
- `summary.byTurnKind` "subagent-orchestration" cost is **not** the subagents — it's the parent
  taking steps while already at 200k+. The fix is always: shrink the parent's context.

## Levers, by impact

1. Keep MAIN-session context small — `/compact` or a fresh session between distinct phases.
   Context never shed = every later step pays the full tax.
2. Push heavy exploration INTO subagents — nearly free, keeps the parent lean.
3. Treat "subagent-orchestration" cost as a parent-context problem, not a subagent problem.

## How to read the detail JSON

- `legend` — the cost model, embedded so numbers are interpreted correctly.
- `components` — itemized `{input, output, cacheWrite, cacheRead, web, total}` dollars.
- `summary.contextGrowth` — `{firstCall, quartileAvgContext[4], peakContext}` per-step cacheRead:
  the honest growth curve. A turn's `tokens.cacheRead` is a SUM across its steps, NOT context size.
- `summary.toolTally` — canonical main-session tool counts. Do not recompute from `calls[]`.
- `byModel` / `byAgent` / `subagents` — cost split by model, by subagent task, and the subagent total.
- `turns` (execution order) carry `kind` / `avgContext` / `peakContext`.
