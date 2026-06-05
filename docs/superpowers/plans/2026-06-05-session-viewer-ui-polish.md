# Session Viewer UI Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `bin/sessions.js` output column-stable (right-aligned decimal-aligned cost, fixed `●` marker column) and add an ANSI color hierarchy, reusing the renderer's color ladder via a new shared `lib/color.js`.

**Architecture:** Extract the shared color primitives (`dim/bold/green/yellow/orange/red`, `COST_TIERS`, `colorByTier`) from `hooks/statusline.js` into `lib/color.js`; both the renderer and the viewer import them. Rewrite the viewer's render loop to size columns from the rows being printed and colorize each cell. Tests strip ANSI, so color is assertion-transparent.

**Tech Stack:** Node 18+ stdlib, `node --test`. No build/lint. Branch: `feat/session-viewer` (continues PR #18).

Spec: `docs/superpowers/specs/2026-06-05-session-viewer-ui-polish-design.md`.

---

## File Structure

- Create `lib/color.js` — shared ANSI helpers + `colorByTier`/`COST_TIERS`.
- Create `tests/color.test.js` — `colorByTier` boundary table.
- Modify `hooks/statusline.js` — import the extracted helpers, delete local duplicates (keep `cyan`/`fg256`/`blink_red`/`dimCyan`).
- Modify `bin/sessions.js` — column sizing + colorized render.
- Modify `tests/sessions-viewer.test.js` — alignment regression guard + update footer assertions to the new `TODAY $X` (no-colon) format.
- Modify `README.md` — note the output is colorized (small).

Run all tests: `node --test tests/*.test.js`.

---

## Task 1: `lib/color.js` + boundary test

**Files:**
- Create: `lib/color.js`
- Test: `tests/color.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/color.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { green, yellow, orange, red, colorByTier, COST_TIERS } = require('../lib/color');

test('colorByTier: absolute [1,5,10] ladder picks tier by upper bound', () => {
  assert.strictEqual(colorByTier(0.99, [1, 5, 10]), green);
  assert.strictEqual(colorByTier(1, [1, 5, 10]), yellow);   // at threshold → next tier
  assert.strictEqual(colorByTier(4.99, [1, 5, 10]), yellow);
  assert.strictEqual(colorByTier(5, [1, 5, 10]), orange);
  assert.strictEqual(colorByTier(9.99, [1, 5, 10]), orange);
  assert.strictEqual(colorByTier(10, [1, 5, 10]), red);
  assert.strictEqual(colorByTier(100, [1, 5, 10]), red);
});

test('colorByTier: ratio [0.5,0.75,0.9] ladder', () => {
  assert.strictEqual(colorByTier(0.49, [0.5, 0.75, 0.9]), green);
  assert.strictEqual(colorByTier(0.5, [0.5, 0.75, 0.9]), yellow);
  assert.strictEqual(colorByTier(0.75, [0.5, 0.75, 0.9]), orange);
  assert.strictEqual(colorByTier(0.9, [0.5, 0.75, 0.9]), red);
  assert.strictEqual(colorByTier(2.0, [0.5, 0.75, 0.9]), red);
});

test('color helpers wrap with the expected ANSI codes', () => {
  assert.strictEqual(green('x'), '\x1b[32mx\x1b[0m');
  assert.strictEqual(red('x'), '\x1b[31mx\x1b[0m');
  assert.strictEqual(orange('x'), '\x1b[38;5;208mx\x1b[0m');
  assert.strictEqual(COST_TIERS.length, 4);
  assert.strictEqual(COST_TIERS[0], green);
  assert.strictEqual(COST_TIERS[3], red);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/color.test.js`
Expected: FAIL — `Cannot find module '../lib/color'`.

- [ ] **Step 3: Write minimal implementation**

Create `lib/color.js` (ANSI codes copied verbatim from `hooks/statusline.js:17-23`):

```js
'use strict';

// Shared ANSI color primitives + the cost-severity tier ladder. Single source of
// truth for both the renderer (hooks/statusline.js) and the viewer (bin/sessions.js).
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const orange = (s) => `\x1b[38;5;208m${s}\x1b[0m`;

// Cost color ladder, low→high severity. `thresholds` are the upper bounds for the
// first three tiers; anything at/above the last threshold is red.
const COST_TIERS = [green, yellow, orange, red];
function colorByTier(value, thresholds) {
  for (let i = 0; i < thresholds.length; i++) {
    if (value < thresholds[i]) return COST_TIERS[i];
  }
  return COST_TIERS[COST_TIERS.length - 1];
}

module.exports = { dim, bold, green, yellow, orange, red, COST_TIERS, colorByTier };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/color.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/color.js tests/color.test.js
git commit -m "feat: lib/color.js shared ANSI tier ladder"
```

---

## Task 2: Refactor `hooks/statusline.js` onto `lib/color.js`

Behavior-preserving — the existing suite is the guard. Replace the local definitions of the SIX extracted helpers + `COST_TIERS` + `colorByTier` with an import. Keep `cyan`, `fg256`, `blink_red`, `dimCyan` local.

**Files:**
- Modify: `hooks/statusline.js:17-25` (color helper block) and `:118-124` (`COST_TIERS`/`colorByTier`)

- [ ] **Step 1: Capture the green baseline**

Run: `node --test tests/*.test.js`
Expected: PASS. Note the count (should be 203 now: 200 + color.test's 3).

- [ ] **Step 2: Add the import** — after the `const os = require('os');` require near the top of `hooks/statusline.js`, add:

```js
const { dim, bold, green, yellow, orange, red, COST_TIERS, colorByTier } = require('../lib/color');
```

- [ ] **Step 3: Delete the extracted local color helpers** — in the color-helper block (currently `hooks/statusline.js:17-25`), DELETE these six lines:

```js
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const orange = (s) => `\x1b[38;5;208m${s}\x1b[0m`;
```

LEAVE these in place (still local, viewer doesn't need them):

```js
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const blink_red = (s) => `\x1b[5;31m${s}\x1b[0m`;
const dimCyan = (s) => `\x1b[2;36m${s}\x1b[0m`;
```

(`fg256` at ~L183 also stays.)

- [ ] **Step 4: Delete the local `COST_TIERS` + `colorByTier`** — remove `hooks/statusline.js:116-124` (the comment block, `const COST_TIERS = [green, yellow, orange, red];`, and the `function colorByTier(...) {...}`). They now come from the import. Leave `formatCost`/`formatPeriodCost` (which call `colorByTier`) unchanged.

- [ ] **Step 5: Run the full suite — behavior must be identical**

Run: `node --test tests/*.test.js`
Expected: PASS — same count as Step 1 (203). If any color/cost test regresses, a deleted helper was still referenced or an ANSI code differs from the lib; reconcile.

- [ ] **Step 6: Manual smoke check**

Run: `echo '{"model":{"display_name":"Claude"},"cost":{"total_cost_usd":2.5},"workspace":{"current_dir":"/tmp","project_dir":"/tmp"}}' | node hooks/statusline.js`
Expected: a colored statusline line prints, no crash.

- [ ] **Step 7: Commit**

```bash
git add hooks/statusline.js
git commit -m "refactor: statusline.js uses shared lib/color.js"
```

---

## Task 3: Rewrite `bin/sessions.js` render (align + color)

**Files:**
- Modify: `bin/sessions.js` (imports + the render section of `main`, currently lines 91-108)
- Test: `tests/sessions-viewer.test.js`

- [ ] **Step 1: Write the failing tests** — edit `tests/sessions-viewer.test.js`.

First, UPDATE the footer assertions to the new no-colon format (the render will change `TODAY: $x` → `TODAY $x`). Apply these replacements throughout the file:
- `/TODAY:\s*\$1\.20/` → `/TODAY\s+\$1\.20/`
- `/TODAY:\s*\$1.20/` (any variant with colon) → `/TODAY\s+\$1\.20/`
- In any data-row filter that excludes the footer via `!/TODAY:/`, change the exclusion to `!/TODAY/` (the footer no longer has a colon). Specifically the `--last` cap test and the `--since` no-cap test build `dataRows` with a filter like `out.split('\n').filter((l) => /\$\d/.test(l) && !/TODAY:/.test(l))` — change `!/TODAY:/` to `!/TODAY/`.

Then ADD this alignment regression test (the original drift bug):

```js
test('viewer: SESSION column stays aligned across cost magnitudes', async () => {
  const p = mkProfile();
  const now = Math.floor(Date.now() / 1000);
  writeCostLog(p.stateDir, [
    `2026-06-05 ${now} sessSMALL1 0.58`,
    `2026-06-05 ${now - 1} sessBIG001 12.34`,
  ]);
  const out = await runSessions(['--config-dir', p.configDir], env(p));
  const dataLines = out.split('\n').filter((l) => /\$\d/.test(l) && !/TODAY/.test(l));
  const small = dataLines.find((l) => l.includes('sessSMAL'));
  const big = dataLines.find((l) => l.includes('sessBIG0'));
  // Short ids (first 8 chars) must start at the same column → columns aligned.
  assert.strictEqual(small.indexOf('sessSMAL'), big.indexOf('sessBIG0'));
  // Decimal points align too (right-aligned cost field).
  assert.strictEqual(small.indexOf('.'), big.indexOf('.'));
});

test('viewer: ended row has a blank marker where live row has ●', async () => {
  const p = mkProfile();
  const now = Math.floor(Date.now() / 1000);
  writeCostLog(p.stateDir, [`2026-06-05 ${now} sessENDED1 1.00`]);
  writeLive(p.stateDir, 'sessLIVE22', 2.00);
  const out = await runSessions(['--config-dir', p.configDir], env(p));
  const dataLines = out.split('\n').filter((l) => /\$\d/.test(l) && !/TODAY/.test(l));
  const ended = dataLines.find((l) => l.includes('sessENDE'));
  const live = dataLines.find((l) => l.includes('sessLIVE'));
  // The ● sits exactly one column before the short id on the live line.
  assert.strictEqual(live.indexOf('●'), live.indexOf('sessLIVE') - 2);
  // Ended line has a space at that same column (no ●).
  assert.strictEqual(ended.includes('●'), false);
  assert.strictEqual(ended.indexOf('sessENDE'), live.indexOf('sessLIVE'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/sessions-viewer.test.js`
Expected: FAIL — the alignment test fails (current code misaligns / `$12.34 ●` drift) and/or footer-format assertions fail against the old `TODAY:` output.

- [ ] **Step 3: Implement** — in `bin/sessions.js`:

(a) Add the color import after line 6 (`const { findTranscript, ... }`):

```js
const { dim, bold, green, colorByTier } = require('../lib/color');
```

(b) Replace the render section — everything from `const width = process.stdout.columns || 80;` (currently line 91) through the `process.stdout.write(out.join('\n') + '\n');` line (currently 108) — with:

```js
  const termWidth = process.stdout.columns || 80;

  // Resolve title/recap up front so column widths can be sized from the data.
  const view = rows.map((r) => {
    const tr = findTranscript(transcriptRoot, r.id);
    const { title, recap } = tr ? readTitleRecap(tr) : { title: null, recap: null };
    return { ...r, costStr: '$' + r.cost.toFixed(2), shortId: r.id.slice(0, 8), title, recap };
  });

  // Cost field width = widest rendered cost (min 5 = "$0.00"); right-aligned so
  // decimals line up. titleCol = plain-text offset where the title starts:
  // when(11) + '  '(2) + costW + ' '(1) + marker(1) + ' '(1) + shortId(8) + '  '(2).
  const costW = Math.max(5, ...view.map((v) => v.costStr.length));
  const titleCol = 11 + 2 + costW + 1 + 1 + 1 + 8 + 2;
  const titleWidth = Math.max(0, termWidth - titleCol);

  const out = [];
  out.push(dim(`${'WHEN'.padEnd(11)}  ${'COST'.padStart(costW)}   ${'SESSION'.padEnd(8)}  TITLE / RECAP`));

  for (const v of view) {
    const when = dim(fmtWhen(v.ts));
    const cost = colorByTier(v.cost, [1, 5, 10])(v.costStr.padStart(costW));
    const marker = v.live ? green('●') : ' ';
    const sid = dim(v.shortId.padEnd(8));
    const titleText = truncate(v.title || '—', titleWidth); // plain (default color)
    out.push(`${when}  ${cost} ${marker} ${sid}  ${titleText}`);
    if (v.recap) {
      const recapText = truncate(v.recap, Math.max(0, termWidth - titleCol - 2));
      out.push(`${' '.repeat(titleCol)}${dim('└ ' + recapText)}`);
    }
  }

  // Footer: budget-tiered amounts when STATUSLINE_MONTHLY_BUDGET > 0, else bold.
  const rawBudget = process.env.STATUSLINE_MONTHLY_BUDGET;
  const parsedBudget = rawBudget != null && rawBudget.trim() !== '' ? Number(rawBudget) : NaN;
  const budget = parsedBudget > 0 ? parsedBudget : null;
  const amt = (total, limit) => {
    const s = '$' + total.toFixed(2);
    return budget ? colorByTier(total / limit, [0.5, 0.75, 0.9])(s) : bold(s);
  };
  const liveNote = anyLive ? dim('  (incl. live)') : '';
  out.push(
    `${dim('TODAY')} ${amt(totals.daily, budget ? budget / 30 : 0)}   ` +
    `${dim('WEEK')} ${amt(totals.weekly, budget ? (budget * 7) / 30 : 0)}   ` +
    `${dim('MONTH')} ${amt(totals.monthly, budget || 0)}${liveNote}`
  );
  process.stdout.write(out.join('\n') + '\n');
```

(The empty-state early return, merge, totals, filter/sort/cap logic above this section are UNCHANGED.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/sessions-viewer.test.js`
Expected: PASS (existing tests + the two new alignment tests; footer assertions now match `TODAY $x`).

- [ ] **Step 5: Manual visual smoke check** — confirm color + alignment by eye:

```bash
TMP=$(mktemp -d); CFG="$TMP/.claude"
STATE="$TMP/state/claude-statusline/$(echo "$CFG" | sed 's#^/##; s#/#_#g')"
mkdir -p "$STATE/cost" "$CFG/projects/-x"; NOW=$(date +%s)
printf '2026-06-05 %s sess1234abcd 0.58\n2026-06-05 %s sessbig00abc 12.34\n' "$NOW" "$((NOW-1))" > "$STATE/cost.log"
printf '{"type":"ai-title","aiTitle":"Short title"}\n{"type":"system","subtype":"away_summary","content":"A recap line (disable recaps in /config)"}\n' > "$CFG/projects/-x/sess1234abcd.jsonl"
printf '1.20' > "$STATE/cost/sesslive9999"
XDG_STATE_HOME="$TMP/state" node bin/sessions.js --config-dir "$CFG"
rm -rf "$TMP"
```
Expected: decimal points aligned, SESSION column flush, `●` only on the live row, dim time/recap, colored costs.

- [ ] **Step 6: Run the full suite**

Run: `node --test tests/*.test.js`
Expected: PASS, no regressions.

- [ ] **Step 7: Commit**

```bash
git add bin/sessions.js tests/sessions-viewer.test.js
git commit -m "feat: align + colorize session viewer output"
```

---

## Task 4: Docs + final regression

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update `README.md`** — in the "## Session viewer" section, after the example block, add one line:

```markdown
Output is colorized: costs are tiered green→yellow→orange→red by amount, live sessions show a green `●`, and period totals in the footer are colored against `STATUSLINE_MONTHLY_BUDGET`.
```

- [ ] **Step 2: Run the entire suite**

Run: `node --test tests/*.test.js`
Expected: PASS — all prior tests plus `color.test.js` and the new alignment tests. No regressions.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: note session viewer colorization"
```

---

## Self-Review notes (resolved)

- **Spec coverage:** right-aligned/decimal-aligned cost + fixed marker col → Task 3 `costW`/`padStart` + marker field + alignment tests; recap indent under title → `titleCol`/`' '.repeat(titleCol)`; color table (dim when/header/session/recap, tiered cost, green ●, budget-tiered footer, bold-when-no-budget) → Task 3 render + footer; `lib/color.js` extraction + renderer import → Tasks 1–2; budget parse mirrors renderer (strict Number, >0 else fall back) with viewer-specific "always show footer, bold when not >0" → Task 3 footer; tests (color boundaries, alignment guard, marker col) → Tasks 1 & 3; renderer suite green → Task 2.
- **Type/format consistency:** `colorByTier(value, thresholds)` returns a color fn; `costW`/`titleCol` are plain-text widths computed before coloring (ANSI never enters padding/truncation); footer format `TODAY $x` (no colon) updated consistently in render AND tests.
- **No placeholders:** every step has full code/commands and expected output.

## Unresolved questions

None.
