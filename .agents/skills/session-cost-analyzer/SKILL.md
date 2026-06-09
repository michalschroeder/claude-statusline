---
name: session-cost-analyzer
description: >-
  Analyze why a Claude Code session was expensive — break down its cost by token type,
  model, turn, and subagent, and produce an HTML report. Use when the user asks where a
  session's cost or tokens went, why a session was costly, to analyze or audit token or
  dollar spend, to list recent sessions by cost, or mentions session cost, /compact
  savings, or context growth.
---

# Session Cost Analyzer

Drives `scripts/analyze.js` (self-contained, JSON-only) to explain a session's cost.

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
   `summary.highContextCost`, `summary.contextResets`. Re-aggregating `calls[]` is a
   known trap: it over-counts tools ~3× and invents false "10× growth" from one early
   call. The script already computed the honest numbers — use them.

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
     user the file path. (`assets/report-template.html` holds the styling if you need to tweak it.)

## Notes

- Costs are recomputed from raw tokens × LiteLLM prices — never Claude's reported cost.
- The analyzer is offline; it uses the bundled `data/model_prices.json` snapshot.
