# Session viewer UI polish — `bin/sessions.js`

Restructure the `bin/sessions.js` terminal output for better scannability. Pure
presentation change: arg parsing, cost pipeline, transcript libs, and the
silent-fail philosophy are untouched.

## Goals

- Group sessions under day headers instead of repeating `MM-DD` per row.
- Show both a clock and a relative time per session.
- Right-align cost.
- Make the **full** session id available (copy-paste-resumable via `claude --resume <id>`);
  the old 8-char prefix only fuzzy-matches the picker, so it was useless for resume.
- Replace the plain d/w/m footer with budget bars when a budget is set.

## Layout

### Day groups

Rows (already newest-first from `listSessions`) are bucketed by **local** calendar
day. Each group is preceded by a dim full-width rule carrying the date:

```
── Mon Jun 09 ──────────────────────────────────────────────
```

- Rule text: `── <Ddd Mmm DD> ` then `─` padding to terminal width (`process.stdout.columns || 80`).
- Whole rule dim.
- Day order follows row order (newest day first). A new rule is emitted whenever
  the local day of the current row differs from the previous row's.

### Session row (line 1)

```
  00:18  2h ago    $0.18  Improve sessions.js command UI            b6c32a08-1234-5678-9abc-def012345678
```

Columns, left to right:

| Part | Width | Notes |
|---|---|---|
| indent | 2 | two spaces |
| clock | 5 | `HH:MM` local, dim |
| gap | 2 | |
| relative | 8 | right-aligned in field, dim. `just now`, `5m ago`, `2h ago`, `3d ago` |
| gap | 2 | |
| cost | 8 | right-aligned plain text, then colored by `SESSION_TIERS`; `—` dim when ≤0 |
| gap | 2 | |
| title | flex | default color, truncated with `…` |
| gap + id | 2 + 36 | full session id, dim, right-aligned at terminal end |

**Relative time** from `now - ts` (seconds): `<60` → `just now`; `<3600` → `${m}m ago`;
`<86400` → `${h}h ago`; else `${d}d ago`.

**Full id placement**: id sits flush right. Title width =
`termWidth - leftColumns - 2 (gap) - 36 (id)`. If that leaves less than
`MIN_TITLE` (20) for the title, **omit the id** and give the title the full
remaining width — narrow terminals keep a readable title rather than a crushed one.
ANSI codes are applied only after plain-text widths are computed (same pattern as today).

### Recap sub-line

Unchanged behavior: only when a recap exists, a dim `└ <recap>` line is emitted,
indented to the title column and truncated to the remaining terminal width.

## Footer

### Budget set (`STATUSLINE_MONTHLY_BUDGET` ≠ 0)

```
today  ▓▓░░░░░░   $1.37 / $16.67
week   ▓▓▓▓▓▓░░  $58.06 / $116.67
month  ▓▓▓▓▓▓▓░ $441.74 / $500.00
```

- One blank line, then three rows: today / week / month.
- Label padded to 5 (`today`, `week`, `month`).
- Bar: `BAR_W = 8` cells. `ratio = spent / limit`. `filled = clamp(round(ratio * BAR_W), 0, BAR_W)`.
  Filled cells `▓` colored by `colorByTier(ratio, BUDGET_TIERS)`; empty cells `░` dim.
- Amount: `$spent` right-aligned across the three rows (pad to the widest), then ` / $limit`.
- Limits from `resolveBudget`: daily = monthly/30, weekly = monthly×7/30, monthly.

### Budget opted out (`STATUSLINE_MONTHLY_BUDGET=0`)

Fall back to the current plain line (no bars):

```
today $1.37 · week $58.06 · month $441.74
```

## Unchanged

- `parseArgs`, `--last` / `--since` / `--config-dir`, `sinceToTs`.
- Cost recompute pipeline (`aggregate`, `loadPricing` offline, `sumPeriods`, `resolveBudget`).
- `no sessions found` empty state.
- Silent-fail philosophy / pure Node stdlib.

## Icons / glyphs

Hardcoded box-drawing (`─ └ ▓ ░`) — the viewer does not use the statusline's
icon-mode system. These are existing chars already used in the viewer / mockups.

## Testing

Update `tests/sessions-viewer.test.js`:

- Day rule appears once per distinct local day, in newest-first order.
- A row shows clock `HH:MM` and a relative token (`ago` / `just now`).
- The **full** 36-char session id appears on a wide terminal; absent when the
  terminal is too narrow (title < 20).
- Footer renders bars + `$spent / $limit` when budget set; renders the plain
  `today … week … month …` line when `STATUSLINE_MONTHLY_BUDGET=0`.
- Existing title/recap and `--last`/`--since` assertions still hold (adjusted to
  the new layout; titles/recaps remain width-truncated, no redaction).

## Open questions

None.
