# Session Cost Analyzer Skill — Design

**Date:** 2026-06-10
**Status:** Approved (brainstorming)
**Branch:** `session-detail` (PR #23)

## Goal

A **skill** that analyzes the cost / token usage of a Claude Code session. It drives a
**self-contained, JSON-only** analyzer (vendored from this repo's cost engine), narrates the
cost story inline, and produces a reusable **HTML report** for a chosen session.

Designed to be lifted out into its own repository later: the skill folder has **no references
outside itself** — every script, lib, data file and asset it needs is bundled.

## Decisions (resolved in brainstorming)

| Question | Decision |
|---|---|
| Extraction approach | **B — vendor the cost-engine libs** (verbatim copies of tested code). Not A (can't extract), not C (reimplementation → dedup/cost drift risk). |
| Output format | **JSON-only** from the script. No `--analyze` flag — JSON is the only output (AI/agent consumer). |
| Skill scope | **Project-local** `.agents/skills/` for now; the folder lifts out to a separate repo later. |
| Session selection | **Both** — list mode (narrate, user picks) AND direct by id/prefix passed as the skill arg. |
| Inline output | List mode: narrate recent sessions inline. |
| Rich output | Detail mode: a **reusable HTML report** from a bundled template. |
| Report location | **cwd** by default (`./session-cost-<shortid>.html`), user may override the path. |
| `lib/` placement | **Under `scripts/`** (`scripts/lib/`). |
| `data/` placement | At **skill root** (outside `scripts/`). Forces a one-line patch to vendored `pricing.js` (`BUNDLED = __dirname/../../data/...`) — the only non-verbatim edit; parity test covers it. |

## Layout

```
.agents/skills/session-cost-analyzer/
  SKILL.md                     # frontmatter (name/description) + workflow, < 100 lines
  REFERENCE.md                 # cost-interpretation model (split out to keep SKILL.md lean)
  scripts/
    analyze.js                 # JSON-only entry; require('./lib/...')
    lib/                       # vendored from ../../../../lib (8 files)
      transcript.js  cost-aggregate.js  session-detail.js  cost-compute.js
      pricing.js  periods.js  state.js  budget.js
  data/
    model_prices.json          # vendored verbatim; skill root, outside scripts/
  assets/
    report-template.html       # reusable styled HTML shell the agent fills
  SYNC.md                      # canonical source = repo lib/+data/; how to re-vendor
```

`color.js` is **not** vendored — it is human-rendering only and the JSON script never calls it.
All vendored libs are byte-identical copies **except** `pricing.js`, whose `BUNDLED` constant is
re-pathed from `__dirname/../data` to `__dirname/../../data` (since `data/` is now two levels up,
outside `scripts/`). This single-line delta is recorded in `SYNC.md` and re-applied on every re-sync.

## The analyzer script (`scripts/analyze.js`)

`bin/sessions.js` with **all rendering removed** (renderDetail, list rendering, color imports,
budget bars, human formatting helpers). It keeps `parseArgs`, the main wiring, `analysisPayload`,
and `listPayload`. JSON is the only thing written to stdout.

**Modes:**
- `node scripts/analyze.js list [--last N] [--since YYYY-MM-DD] [--config-dir P]`
  → the existing **list** payload: `{ sessions:[{session,title,recap,startedAt,cost}], periods{today,week,month}, monthlyBudget }`.
- `node scripts/analyze.js <id-prefix> [--config-dir P]`
  → the existing **detail** payload: `{ session,title,recap,startedAt,totalCost,steps,legend,components,summary,byModel,byAgent,subagents,turns,calls }`.

Same exit-1 behavior on no-match / ambiguous prefix (writes the reason to stderr).
Config-dir resolution unchanged: `--config-dir` ?? `CLAUDE_CONFIG_DIR` ?? `~/.claude`.
Offline like the renderer (`loadPricing(..., {allowFetch:false})`).

The vendored libs are copied as-is except for `pricing.js`'s one-line `BUNDLED` re-path
(`__dirname/../data` → `__dirname/../../data`), since `data/` lives at the skill root while `lib/`
lives under `scripts/`. The only new code is `analyze.js` (a trim of `bin/sessions.js`).

## SKILL.md — frontmatter

```yaml
name: session-cost-analyzer
description: >-
  Analyze why a Claude Code session was expensive — break down its cost by token type,
  model, turn, and subagent, and produce an HTML report. Use when the user asks where a
  session's cost/tokens went, why a session was costly, to analyze/audit token or dollar
  spend, to list recent sessions by cost, or mentions session cost, /compact savings, or
  context growth.
```

Third person, < 1024 chars, first sentence = capability, second = "Use when…" triggers. Per the
write-a-skill checklist.

## SKILL.md — workflow (kept under 100 lines; cost model lives in `REFERENCE.md`)

1. **Select.** If the skill arg is a session id/prefix → go straight to detail. Otherwise run
   `list`, narrate recent sessions inline (`title · $cost · age`), ask the user to pick.
2. **Detail.** Run `<prefix>`, parse the JSON. **Read `summary.*` precomputed rollups**
   (`contextGrowth`, `toolTally`, `byTurnKind`, `highContextCost`, `contextResets`) and the
   `legend`. **Never re-aggregate `calls[]`** — the documented traps: hand-tallying tools
   over-counts ~3×, cherry-picking one early call invents false "10× growth". The script already
   precomputes the honest numbers; use them.
3. **Interpret** using the cost model in [`REFERENCE.md`](#referencemd--cost-interpretation).
4. **Output.**
   - Narrate the cost story inline.
   - Generate an HTML report by filling `assets/report-template.html` from the JSON: where-it-went
     (token-type split with bars), by-model, top turns, subagents, and the `highContextCost`
     "what a /compact would have saved" figure. Write to `./session-cost-<shortid>.html` by default;
     honor a user-supplied path.

## REFERENCE.md — cost interpretation

Split out of SKILL.md (it is reference material, not workflow) to keep SKILL.md lean and under 100
lines per the write-a-skill rule. SKILL.md links to it one level deep. Content:

> **Cost ≈ context-size × steps. Subagents are cheap; bloated MAIN-session context is the real cost.**
>
> - The MAIN thread re-reading/re-caching its own accumulated context dominates: typically
>   `cache-read` (~47%) + `cache-write` (~31%) ≫ `output` (~20%) ≫ fresh `input` (~2%).
> - Each subagent spawns with its **own fresh ~5–35k context** — it does **not** inherit the
>   parent's 200k+. It returns only a few-KB summary. So fan-out (planning, parallel review lenses,
>   research) costs cents. In one $32.94 session, all 11 subagents (226 calls) were **$1.04 (3%)**;
>   the main session (192 calls) was **$31.90 (97%)**.
> - `summary.highContextCost` = spend on calls **above 200k context** = exactly what a `/compact`
>   would have cut.
> - `byTurnKind` "subagent-orchestration" cost is **not** the subagents — it's the parent taking
>   steps while already at 200k+. The fix is always: shrink the parent's context.
>
> **Levers, by impact:** (1) keep main context small — `/compact` or fresh session between phases;
> (2) push heavy exploration into subagents; (3) treat orchestration cost as a parent-context problem.

## Tests

`scripts/test/` (Node `--test`): on a fixture transcript tree, assert `analyze.js list` and
`analyze.js <prefix>` produce JSON **identical** to `bin/sessions.js --analyze` (list) and
`bin/sessions.js <prefix> --analyze` (detail). This proves the vendored trim is in parity with the
canonical CLI — the one thing that could silently break.

## Drift management (`SYNC.md`)

Canonical source = repo `lib/*.js` + `data/model_prices.json`. While the skill lives inside this
repo there are two copies; `SYNC.md` records the source paths, the plain-overwrite re-copy step, and
the single `pricing.js` `BUNDLED` re-path to re-apply after copying. The parity test fails loudly if
`analyze.js` ever diverges in output.

## Out of scope (YAGNI)

- No `--analyze` flag / no human-rendered tables in the vendored script.
- No automated sync tooling beyond the documented copy step + parity test.
- No `color.js`, no budget bars, no TTY-width logic.

## Unresolved

None — all six handoff questions resolved.
