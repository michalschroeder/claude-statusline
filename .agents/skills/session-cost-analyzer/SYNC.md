# Vendoring / sync

This skill bundles a copy of the claude-statusline cost engine so it can run standalone
(and eventually live in its own repo). **Canonical source = the claude-statusline repo.**

## Vendored files (source → here)

| Source (repo root) | Here |
|---|---|
| `lib/transcript.js` | `scripts/lib/transcript.js` |
| `lib/cost-aggregate.js` | `scripts/lib/cost-aggregate.js` |
| `lib/session-detail.js` | `scripts/lib/session-detail.js` |
| `lib/cost-compute.js` | `scripts/lib/cost-compute.js` |
| `lib/pricing.js` | `scripts/lib/pricing.js` (one delta — see below) |
| `lib/periods.js` | `scripts/lib/periods.js` |
| `lib/state.js` | `scripts/lib/state.js` |
| `lib/budget.js` | `scripts/lib/budget.js` |
| `data/model_prices.json` | `data/model_prices.json` |

`lib/color.js` is deliberately NOT vendored (human rendering only).

## The one non-verbatim delta

`scripts/lib/pricing.js` `BUNDLED` constant: `__dirname/../data` → `__dirname/../../data`
(because `data/` sits at the skill root, one level above `scripts/`). Re-apply after any re-copy.

## Re-sync

```bash
# from the claude-statusline repo root
SKILL=.agents/skills/session-cost-analyzer
cp lib/{transcript,cost-aggregate,session-detail,cost-compute,pricing,periods,state,budget}.js "$SKILL/scripts/lib/"
cp data/model_prices.json "$SKILL/data/"
# then re-apply the BUNDLED delta in scripts/lib/pricing.js
```

The repo test `tests/skill-analyze-parity.test.js` fails loudly if the vendored trim ever
diverges in output from `bin/sessions.js --analyze`.
