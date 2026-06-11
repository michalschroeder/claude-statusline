---
name: session-cost-analyzer
description: >-
  Analyze why a Claude Code session was expensive — break down its cost by token type,
  model, turn, and subagent, and produce an HTML report. Use when the user asks where a
  session's cost or tokens went, why a session was costly, to analyze or audit token or
  dollar spend, to list recent sessions by cost, or mentions session cost, /compact
  savings, or context growth. Args: `[<session-id-prefix> | list] [--summarize-turns]
  [--config-dir <path>] [--out <path>] [--last N] [--since YYYY-MM-DD]`. Examples:
  `/session-cost-analyzer 848c5b25`, `/session-cost-analyzer 848c5b25 --summarize-turns`,
  `/session-cost-analyzer list --last 20 --config-dir ~/.claude-lendable`.
argument-hint: "[<session-id-prefix> | list] [--summarize-turns] [--config-dir <path>] [--out <path>] [--last N] [--since YYYY-MM-DD]"
---

# Session Cost Analyzer

Drives `scripts/analyze.js` (self-contained, JSON-only) to explain a session's cost.

## Arguments

`/session-cost-analyzer [<session-id-prefix> | list] [flags]` — parse the invocation for
these tokens **before** running the workflow; they map deterministically to the steps below.

| Token | Effect |
|---|---|
| `<session-id-prefix>` | Analyze that session (detail report). Omit → ask which (step 1). |
| `list` | List recent sessions by cost instead of a detail report. |
| `--summarize-turns` | Opt in to **Haiku per-turn summaries** in TOP TURNS (the subagent flow in step 5). Absent → deterministic relabel + tooltip only. Aliases: `--haiku`, `--turn-summaries`. |
| `--config-dir <path>` | Non-default transcript root (e.g. `~/.claude-lendable`). Passed straight to `analyze.js`. |
| `--out <path>` | Report output path. Default `./session-cost-<shortid>.html`. |
| `--last N` / `--since YYYY-MM-DD` | `list`-mode filters. |

The Haiku step is gated **only** by `--summarize-turns` (or its aliases) — treat its
presence/absence as the on/off switch, don't infer it from prose. Unknown flags: ignore.

### Examples

```bash
/session-cost-analyzer 848c5b25                         # detail report, deterministic labels
/session-cost-analyzer 848c5b25 --summarize-turns       # + Haiku "what each turn did" summaries
/session-cost-analyzer 848c5b25 --config-dir ~/.claude-lendable --summarize-turns
/session-cost-analyzer list --last 20                   # rank recent sessions by cost
```

## Quick start

```bash
# List recent sessions (newest first) with their recomputed cost:
node scripts/analyze.js list --last 10

# Full cost breakdown for one session (id or unambiguous prefix):
node scripts/analyze.js <session-id-prefix>
```

Both print JSON to stdout. `--config-dir <path>` points at a non-default `~/.claude`.
`list` also takes `--since YYYY-MM-DD` and `--last N`.

## Workflow

1. **Select the session.**
   - If the user gave a session id/prefix, skip to step 2 with it.
   - Otherwise run `node scripts/analyze.js list --last 10`, summarize the sessions
     inline (`title · $cost · age`), and ask which one to analyze.

2. **Pull the detail.** Run `node scripts/analyze.js <prefix>` and parse the JSON.
   Read the `legend` field first — it states the cost model.

3. **Read the precomputed rollups, do NOT hand-aggregate `calls[]`.**
   Use `summary.contextGrowth`, `summary.byTurnKind`, `summary.toolTally`,
   `summary.highContextCost`, `summary.contextResets`, and `summary.contextConsumers`
   (names the exact files/commands whose results filled the context, with estimated
   tokens and the carried re-read cost — lead with these when the user asks WHAT
   consumed the context). When `assistant-thinking` dominates the consumers, drill into
   `summary.assistantOutput.thinking` — stored vs unstored (interleaved) thinking, the
   per-turn attribution in `thinking.byTurn`, and `thinking.peakStep` — to say WHICH
   prompts drove the reasoning. `summary.bySkill` links cost to skill usage — the turns
   each skill dispatch drove. Re-aggregating `calls[]` is a known trap: it over-counts
   tools ~3× and invents false "10× growth" from one early call. The script already
   computed the honest numbers — use them.

4. **Interpret** with the cost model in [REFERENCE.md](REFERENCE.md).

5. **Report.**
   - Narrate the cost story inline (where the money went, the biggest lever).
   - Generate the HTML report deterministically — pipe the detail JSON into the bundled
     renderer rather than hand-building rows (it formats money/duration/tokens, draws the
     proportion bars, ranks the top turns, and HTML-escapes every prompt/title/label):

     ```bash
     node scripts/analyze.js <prefix> | node scripts/render-report.js --out ./session-cost-<shortid>.html
     ```

     It prints the path it wrote. Pass a different `--out` if the user names one. Tell the
     user the file path. The report opens with an interactive context-window timeline (one
     SVG bar per step, colored by the 200k threshold, hover for per-step size/cost/prompt).
     (`assets/report-template.html` holds the styling if you need to tweak it.)

     By default the TOP TURNS prompt cell is cleaned deterministically (skill dispatches →
     their skill name, `<task-notification>` returns → `↩ subagent results`, user turns
     keep their words) with the full raw prompt on hover. **No extra step needed** — this is
     the path when `--summarize-turns` is absent.

   - **`--summarize-turns` → Haiku turn summaries.** Run this step **iff** the flag (or an
     alias) was passed; otherwise skip it. Replace the prompt cell with a one-line "what
     this turn accomplished" phrase. Don't shell out to a model — dispatch a couple of cheap
     Haiku **subagents** (the Agent tool with `model: haiku`) over the top turns, then merge
     their output with the pure helper:

     ```bash
     node scripts/analyze.js <prefix> > /tmp/detail.json
     # Read /tmp/detail.json's `turns` (sort by cost, take ~10). Dispatch 1-2 Haiku
     # subagents, each given a batch of turns (turnIndex + kind + tool tally + prompt),
     # asking for a JSON map { "<turnIndex>": "<=10-word phrase", ... }. Write the merged
     # map to /tmp/summaries.json, then:
     node scripts/apply-summaries.js --summaries /tmp/summaries.json < /tmp/detail.json \
       | node scripts/render-report.js --out ./session-cost-<shortid>.html
     ```

     `apply-summaries.js` is pure (keys by `turnIndex`, ignores unknown/missing, passes the
     payload through unchanged on any error) so the report always renders; the renderer
     prefers `turns[].summary` when present and falls back to the deterministic label.

## Notes

- Costs are recomputed from raw tokens × LiteLLM prices — never Claude's reported cost.
- The analyzer is offline; it uses the bundled `data/model_prices.json` snapshot.
