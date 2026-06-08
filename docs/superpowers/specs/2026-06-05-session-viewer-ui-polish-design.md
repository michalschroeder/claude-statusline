# Session viewer UI polish (align + color) — design

Status: approved (brainstorm). Date: 2026-06-05. Repo: `claude-statusline`.
Builds on: `bin/sessions.js` (PR #18, the recap+cost viewer).

## Problem

Current `bin/sessions.js` output drifts: the cost field is left-aligned with the live `●`
glued to it, so any cost ≥ $10 (or the presence/absence of `●`) shifts the SESSION/TITLE
columns. Numbers are ragged (decimals don't line up). No visual hierarchy.

Observed:
```
06-05 02:06  $2.10 ●  00a68135  Reuse tree view component…
06-05 02:06  $12.34 ● 01hxyzpa  —          ← SESSION shifted left
```

## Goal

Stable columns + decimal-aligned costs + ANSI color hierarchy, reusing the renderer's
existing color ladder. No behavior change to which rows/totals are shown.

## Decisions (locked)

### Layout
- **Cost right-aligned** in a fixed-width field (decimals line up). Field width fits the
  largest rendered cost (compute from the rows being printed; floor at a sensible minimum
  e.g. `$0.00` → 6).
- **`●` marker is its own fixed 1-column field** (`●` live, space otherwise), separate from
  the cost number. This removes the width variance that caused the drift.
- Row format (left→right): `WHEN  <cost right-aligned> <marker> <session>  <title>`.
- **Recap `└` sub-line** indented to align under the title's first character (the computed
  title column), not a hard-coded guess.
- Header row and footer share the same column origins.
- Title/recap still width-truncated with `…` (truncate-only, no redaction — unchanged).

### Color (ANSI; the test harness strips ANSI, so assertions are unaffected)
| Element | Color |
|---|---|
| header row | dim |
| `WHEN` | dim |
| cost (per row) | `colorByTier(cost, [1,5,10])` → green/yellow/orange/red (same ladder as renderer session cost) |
| live `●` | green |
| `SESSION` short id | dim |
| title | default (no color) |
| recap `└ …` | dim |
| footer amounts | budget-tiered: `colorByTier(total/limit, [0.5,0.75,0.9])`; limits = `budget/30` (daily), `budget·7/30` (weekly), `budget` (monthly) |
| footer labels (`TODAY`/`WEEK`/`MONTH`) | dim |

`STATUSLINE_MONTHLY_BUDGET` parsed exactly like the renderer (strict `Number`), and the footer
color matches the renderer's default behavior so the viewer and statusline agree:
- `>0` → budget-tiered against that value.
- **unset / negative / non-numeric → default `500`, budget-tiered** (mirrors the renderer, which
  colors period costs against `500` by default when the var is unset).
- **explicit `0` → opt-out**: amounts render **bold and uncolored**. (The renderer *hides* the
  d/w/m chips at `0`; the viewer always shows the footer since it's the point, so the natural
  "opted-out" rendering is bold/uncolored rather than hidden.)

So the only case that renders bold is an explicit `STATUSLINE_MONTHLY_BUDGET=0`; every other
value (including unset) colors the footer.

### DRY — shared color module
Extract the shared basics into **`lib/color.js`**:
- ANSI helpers: `dim, bold, green, yellow, orange, red` (verbatim codes from `statusline.js`).
- `COST_TIERS = [green, yellow, orange, red]` and `colorByTier(value, thresholds)`.

`hooks/statusline.js` imports these from `lib/color.js`, dropping its local duplicates of those
specific helpers + `colorByTier`/`COST_TIERS`. Its context-bar-specific helpers (`fg256`,
`cyan`, `blink_red`, `dimCyan`) **stay local** (the viewer doesn't need them). `bin/sessions.js`
imports from `lib/color.js` too. Single source of truth for the tier ladder, mirroring the
`lib/cost.js` extraction. Low risk: presentation-only, ANSI codes byte-identical, all existing
tests strip ANSI.

## Components

### `lib/color.js` (new)
Exports `dim, bold, green, yellow, orange, red, COST_TIERS, colorByTier`. Pure functions,
no deps. `colorByTier(value, thresholds)` returns the tier color fn for the first threshold
`value <` ; else the last (red).

### `hooks/statusline.js` (modify)
Replace the local `const dim/bold/green/yellow/orange/red`, `COST_TIERS`, and `colorByTier`
definitions with `const { dim, bold, green, yellow, orange, red, COST_TIERS, colorByTier } =
require('../lib/color');`. `formatCost`/`formatPeriodCost` keep using `colorByTier` unchanged.
Keep `cyan`, `fg256`, `blink_red`, `dimCyan` local. Behavior identical (existing suite is the guard).

### `bin/sessions.js` (modify)
- `require('../lib/color')` for color helpers + `colorByTier`.
- Compute the cost-field width from the rows to print (max of the formatted `$X.XX` strings,
  min 6). Right-pad/left-pad accordingly so the decimal points align.
- Render the `●`/space marker in its own column.
- Color each element per the table above.
- Footer: parse `STATUSLINE_MONTHLY_BUDGET` (strict `Number`). Resolve budget: explicit `0` →
  `null` (bold opt-out); `>0` → that value; otherwise (unset/negative/NaN) → `500`. Derive
  daily/weekly/monthly limits (`budget/30`, `·7/30`, `budget`). If budget is non-null, color
  each amount via `colorByTier(total/limit, [0.5,0.75,0.9])`; if null, render amounts bold.
  Labels dim.
- Recap indent = the computed title-column offset.

## Testing
- `tests/color.test.js` (new): `colorByTier` boundary table — value just below / at each
  threshold returns the expected tier fn; reuse the ANSI-strip helper or assert on the
  wrapping codes directly.
- `tests/sessions-viewer.test.js` (extend, ANSI-stripped):
  - **Alignment regression guard**: print a `$0.58` row and a `$12.34` live row; assert the
    SESSION short-id starts at the same character offset in both lines (the original bug).
  - Cost right-alignment: decimal point column identical across rows.
  - Marker column: live row has `●`, ended row has a space at the same offset.
  - Footer still shows correct totals (unchanged) — keep existing assertions.
- Renderer suite (`tests/*.test.js`) stays green after the `lib/color.js` extraction
  (color codes unchanged; ANSI stripped in tests).

## Conventions
- Embed real glyph chars (`●`, `└`, `…`) literally.
- No subprocess (viewer is pure Node anyway).
- Conventional Commits; **continue on `feat/session-viewer`** so PR #18 ships already-polished.

## Out of scope (YAGNI)
- Card/grouped layout (rejected in brainstorm).
- Redaction, `--all-profiles`, configurable color themes.
- Moving `fg256`/`cyan`/`blink_red`/`dimCyan` out of the renderer.

## Unresolved questions
None.
