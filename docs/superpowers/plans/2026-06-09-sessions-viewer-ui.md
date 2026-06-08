# Session Viewer UI Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure `bin/sessions.js` terminal output into day-grouped rows (clock + relative time, right-aligned cost, full copy-pasteable session id) with a budget-bar footer.

**Architecture:** Pure presentation change inside the single file `bin/sessions.js`. Extract pure formatting helpers (relative time, day labels, bar fill, width) and `module.exports` them behind a `require.main === module` guard so they're unit-testable; rewrite `main()`'s render loop and footer. No changes to arg parsing or the cost pipeline.

**Tech Stack:** Pure Node stdlib (Node 18+), `node:test`. ANSI helpers from `lib/color.js`.

---

## File Structure

- **Modify** `bin/sessions.js` — add pure helpers + exports + guard; rewrite render in `main()`.
- **Modify** `tests/sessions-viewer.test.js` — rewrite integration assertions for the new layout.
- **Create** `tests/sessions-format.test.js` — unit tests for the new pure helpers.
- **Modify** `CLAUDE.md` — update the Session viewer description + testing list.

### Layout contract (reference for all tasks)

Plain-text column widths, left→right, computed **before** ANSI is applied:

```
INDENT=2  CLOCK=5  GAP=2  REL=8(right-align)  GAP=2  COST=8(right-align)  GAP=2  TITLE(flex)  GAP=2  ID=36(right-align)
```

- `leftWidth = 2+5+2+8+2+8+2 = 29` (title starts at column 29).
- Right block when id shown = `GAP(2) + ID(36) = 38`.
- `titleWidth = termWidth - leftWidth - 38`. If `< MIN_TITLE (20)`, drop the id and `titleWidth = termWidth - leftWidth`.
- Day rule: `── <Ddd Mmm DD> ` padded with `─` to `termWidth`, all dim. Emitted whenever a row's local day differs from the previous row's.
- Recap sub-line (only when present): `' '.repeat(leftWidth) + dim('└ ' + truncate(recap, termWidth - leftWidth - 2))`.
- Footer budget set: 3 rows `label(5)  bar(8 ▓/░)  $spent(right-aligned) / $limit`. Opted out (`STATUSLINE_MONTHLY_BUDGET=0`): `today $X · week $Y · month $Z`.
- `termWidth()` = `process.stdout.columns || parseInt(process.env.COLUMNS,10) || 80` (COLUMNS fallback lets piped output / tests request a width; real TTY still wins).

---

## Task 1: Pure formatting helpers (exported, unit-tested)

**Files:**
- Modify: `bin/sessions.js`
- Test: `tests/sessions-format.test.js` (create)

- [ ] **Step 1: Write the failing unit tests**

Create `tests/sessions-format.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { relativeTime, dayKey, dayLabel, clock, barFill, truncate } = require('../bin/sessions');

test('relativeTime: buckets', () => {
  const now = 1_000_000;
  assert.strictEqual(relativeTime(now, now), 'just now');
  assert.strictEqual(relativeTime(now, now + 50), 'just now'); // future clamps to 0
  assert.strictEqual(relativeTime(now, now - 30), 'just now');
  assert.strictEqual(relativeTime(now, now - 90), '1m ago');
  assert.strictEqual(relativeTime(now, now - 7200), '2h ago');
  assert.strictEqual(relativeTime(now, now - 2 * 86400), '2d ago');
});

test('barFill: clamps to [0,width]', () => {
  assert.strictEqual(barFill(0, 10, 8), 0);
  assert.strictEqual(barFill(5, 10, 8), 4);
  assert.strictEqual(barFill(10, 10, 8), 8);
  assert.strictEqual(barFill(20, 10, 8), 8); // over budget clamps
  assert.strictEqual(barFill(1, 0, 8), 0);   // no limit → 0
});

test('dayKey / dayLabel: same day groups, label shape', () => {
  const a = Math.floor(new Date(2026, 5, 9, 1, 0).getTime() / 1000);
  const b = Math.floor(new Date(2026, 5, 9, 23, 0).getTime() / 1000);
  const c = Math.floor(new Date(2026, 5, 8, 12, 0).getTime() / 1000);
  assert.strictEqual(dayKey(a), dayKey(b));
  assert.notStrictEqual(dayKey(a), dayKey(c));
  assert.match(dayLabel(a), /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{2}$/);
});

test('clock: zero-padded HH:MM', () => {
  const ts = Math.floor(new Date(2026, 5, 9, 3, 7).getTime() / 1000);
  assert.strictEqual(clock(ts), '03:07');
});

test('truncate: ellipsis at width', () => {
  assert.strictEqual(truncate('abcdef', 4), 'abc…');
  assert.strictEqual(truncate('ab', 5), 'ab');
  assert.strictEqual(truncate('abc', 0), '');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/sessions-format.test.js`
Expected: FAIL — `relativeTime is not a function` (exports don't exist yet).

- [ ] **Step 3: Add helpers + exports + guard to `bin/sessions.js`**

In `bin/sessions.js`, replace the existing `truncate` function (lines 51-54) with the helper block below, and at the **end of the file** replace `main();` with the guard + exports.

Replace `truncate` (old lines 51-54):

```js
function truncate(s, width) {
  if (width <= 0) return '';
  if (s.length <= width) return s;
  return s.slice(0, Math.max(0, width - 1)) + '…';
}

// '2h ago' style age. nowSec/ts both unix seconds; future clamps to 'just now'.
function relativeTime(nowSec, ts) {
  const d = Math.max(0, nowSec - ts);
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = (n) => String(n).padStart(2, '0');

// Local calendar-day key for grouping rows.
function dayKey(ts) {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// 'Mon Jun 09' for a day header.
function dayLabel(ts) {
  const d = new Date(ts * 1000);
  return `${DOW[d.getDay()]} ${MON[d.getMonth()]} ${pad2(d.getDate())}`;
}

// Local HH:MM.
function clock(ts) {
  const d = new Date(ts * 1000);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// Filled-cell count for a budget bar of `width` cells (clamped).
function barFill(spent, limit, width) {
  if (!(limit > 0)) return 0;
  return Math.max(0, Math.min(width, Math.round((spent / limit) * width)));
}

// Terminal width: real TTY wins, else COLUMNS env (piped output / tests), else 80.
function termWidth() {
  return process.stdout.columns || parseInt(process.env.COLUMNS, 10) || 80;
}
```

At the end of the file, replace the bare `main();` with:

```js
if (require.main === module) main();

module.exports = { relativeTime, dayKey, dayLabel, clock, barFill, termWidth, truncate };
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/sessions-format.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add bin/sessions.js tests/sessions-format.test.js
git commit -m "feat: testable formatting helpers for session viewer"
```

---

## Task 2: Render day-grouped rows

**Files:**
- Modify: `bin/sessions.js` (the render block in `main()`, old lines 99-129)
- Test: `tests/sessions-viewer.test.js`

- [ ] **Step 1: Rewrite the integration tests for the new layout**

Replace the entire contents of `tests/sessions-viewer.test.js` with:

```js
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runSessions } = require('./helpers');

// The viewer (bin/sessions.js) enumerates sessions from CC transcripts under
// <config-dir>/projects/*/<id>.jsonl, newest-first by file mtime, and renders
// day-grouped rows (clock + relative time, cost, full session id) + a footer.

const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

function mkProfile() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-cfg-'));
  tmpDirs.push(configDir);
  return { configDir };
}

function writeTranscript(configDir, sessionId, entries, when) {
  const proj = path.join(configDir, 'projects', '-test-proj');
  fs.mkdirSync(proj, { recursive: true });
  const file = path.join(proj, `${sessionId}.jsonl`);
  fs.writeFileSync(file, entries.map((o) => JSON.stringify(o)).join('\n') + '\n');
  if (when != null) {
    const d = when instanceof Date ? when : new Date(when * 1000);
    fs.utimesSync(file, d, d);
  }
}

// Wide terminal so the full-id column is shown (narrow terminals drop it).
const wide = (extra) => ({ COLUMNS: '200', ...(extra || {}) });
// A data row starts with the 2-space indent + HH:MM clock.
const dataRows = (out) => out.split('\n').filter((l) => /^  \d{2}:\d{2} /.test(l));
const dayRules = (out) => out.split('\n').filter((l) => /^── /.test(l));

test('viewer: empty state → friendly message', async () => {
  const p = mkProfile();
  const out = await runSessions(['--config-dir', p.configDir], wide());
  assert.match(out, /no sessions found/i);
});

test('viewer: row shows clock + relative time + title + recap', async () => {
  const p = mkProfile();
  writeTranscript(p.configDir, 'sessAAA1', [
    { type: 'ai-title', aiTitle: 'Address timezone comment' },
    { type: 'system', subtype: 'away_summary', content: 'Applied 4 reviewer changes (disable recaps in /config)' },
  ]);
  const out = await runSessions(['--config-dir', p.configDir], wide());
  assert.match(out, /\d{2}:\d{2}/);             // clock
  assert.match(out, /ago|just now/);            // relative time
  assert.match(out, /Address timezone comment/);
  assert.match(out, /Applied 4 reviewer changes/);
  assert.doesNotMatch(out, /disable recaps/);   // disclaimer stripped
  assert.match(out, /sessAAA1/);                // full id shown on wide terminal
});

test('viewer: title absent → em dash', async () => {
  const p = mkProfile();
  writeTranscript(p.configDir, 'sessBBB1', [{ type: 'user', text: 'hi' }]);
  const out = await runSessions(['--config-dir', p.configDir], wide());
  assert.match(out, /—/);
});

test('viewer: full id dropped on a narrow terminal, title kept', async () => {
  const p = mkProfile();
  writeTranscript(p.configDir, 'sessNARROW', [{ type: 'ai-title', aiTitle: 'keepme' }]);
  const out = await runSessions(['--config-dir', p.configDir], { COLUMNS: '40' });
  assert.match(out, /keepme/);
  assert.doesNotMatch(out, /sessNARROW/);
});

test('viewer: rows grouped under a day header', async () => {
  const p = mkProfile();
  const a = Math.floor(new Date(2026, 5, 9, 10).getTime() / 1000);
  const b = Math.floor(new Date(2026, 5, 8, 10).getTime() / 1000);
  writeTranscript(p.configDir, 'sessDAY1', [{ type: 'ai-title', aiTitle: 'today-ish' }], a);
  writeTranscript(p.configDir, 'sessDAY2', [{ type: 'ai-title', aiTitle: 'yesterday-ish' }], b);
  const out = await runSessions(['--config-dir', p.configDir], wide());
  assert.strictEqual(dayRules(out).length, 2, 'one rule per distinct day');
  assert.match(dayRules(out)[0], /[A-Z][a-z]{2} [A-Z][a-z]{2} \d{2}/);
});

test('viewer: newest-first', async () => {
  const p = mkProfile();
  const now = Math.floor(Date.now() / 1000);
  writeTranscript(p.configDir, 'sessOLD11', [{ type: 'ai-title', aiTitle: 'older' }], now - 7200);
  writeTranscript(p.configDir, 'sessNEW11', [{ type: 'ai-title', aiTitle: 'newer' }], now - 60);
  const rows = dataRows(await runSessions(['--config-dir', p.configDir], wide()));
  assert.ok(rows[0].includes('newer'), 'newest row first');
  assert.ok(rows[1].includes('older'), 'older row second');
});

test('viewer: --last caps rows', async () => {
  const p = mkProfile();
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 5; i++) {
    writeTranscript(p.configDir, `sess${i}xxxx`, [{ type: 'ai-title', aiTitle: `t${i}` }], now - i);
  }
  const out = await runSessions(['--config-dir', p.configDir, '--last', '2'], wide());
  assert.strictEqual(dataRows(out).length, 2);
});

test('viewer: negative --last is rejected', async () => {
  const p = mkProfile();
  writeTranscript(p.configDir, 'sessNEG1', [{ type: 'ai-title', aiTitle: 'x' }]);
  await assert.rejects(
    runSessions(['--config-dir', p.configDir, '--last', '-3'], wide()),
    /non-negative integer/
  );
});

test('viewer: --since filters older rows out', async () => {
  const p = mkProfile();
  const nowD = new Date();
  const todayTs = Math.floor(new Date(nowD.getFullYear(), nowD.getMonth(), nowD.getDate(), 12).getTime() / 1000);
  const oldTs = todayTs - 40 * 86400;
  writeTranscript(p.configDir, 'sessNEW1', [{ type: 'ai-title', aiTitle: 'freshone' }], todayTs);
  writeTranscript(p.configDir, 'sessOLD1', [{ type: 'ai-title', aiTitle: 'staleone' }], oldTs);
  const since = `${nowD.getFullYear()}-${String(nowD.getMonth() + 1).padStart(2, '0')}-${String(nowD.getDate()).padStart(2, '0')}`;
  const out = await runSessions(['--config-dir', p.configDir, '--since', since], wide());
  assert.match(out, /freshone/);
  assert.doesNotMatch(out, /staleone/);
});

test('viewer: --since without --last does not cap at 10', async () => {
  const p = mkProfile();
  const nowD = new Date();
  const todayTs = Math.floor(new Date(nowD.getFullYear(), nowD.getMonth(), nowD.getDate(), 12).getTime() / 1000);
  for (let i = 0; i < 12; i++) {
    writeTranscript(p.configDir, `sess${i}yyyy`, [{ type: 'ai-title', aiTitle: `t${i}` }], todayTs - i);
  }
  const since = `${nowD.getFullYear()}-${String(nowD.getMonth() + 1).padStart(2, '0')}-${String(nowD.getDate()).padStart(2, '0')}`;
  const out = await runSessions(['--config-dir', p.configDir, '--since', since], wide());
  assert.ok(dataRows(out).length >= 11, `expected >= 11 data rows, got ${dataRows(out).length}`);
});

test('viewer: invalid --since rejects with exit 1', async () => {
  const p = mkProfile();
  await assert.rejects(
    runSessions(['--config-dir', p.configDir, '--since', 'notadate'], wide()),
    /--since requires/
  );
});

test('viewer: per-session cost + budget-bar footer', async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-vc-'));
  tmpDirs.push(configDir);
  const proj = path.join(configDir, 'projects', 'p');
  fs.mkdirSync(proj, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(proj, 'sess1.jsonl'),
    JSON.stringify({ type: 'assistant', timestamp: now, message: { id: 'm1', model: 'claude-opus-4-8', usage: { input_tokens: 1000000 } } }) + '\n');
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-vx-'));
  tmpDirs.push(xdg);
  const out = await runSessions(['--config-dir', configDir], wide({ XDG_STATE_HOME: xdg }));
  assert.match(out, /\$\d+\.\d{2}/);              // a dollar amount on the row
  assert.match(out, /[▓░]/);                       // budget bar cells
  assert.match(out, /today.*\$\d+\.\d{2} \/ \$\d+\.\d{2}/); // "today … $spent / $limit"
});

test('viewer: budget opted out → plain footer, no bars', async () => {
  const p = mkProfile();
  writeTranscript(p.configDir, 'sessZZZ1', [{ type: 'ai-title', aiTitle: 'z' }]);
  const out = await runSessions(['--config-dir', p.configDir], wide({ STATUSLINE_MONTHLY_BUDGET: '0' }));
  assert.doesNotMatch(out, /[▓░]/);
  assert.match(out, /today \$\d+\.\d{2} · week /);
});
```

- [ ] **Step 2: Run to verify the render tests fail**

Run: `node --test tests/sessions-viewer.test.js`
Expected: FAIL — day-grouping / clock / footer-bar assertions fail (old layout still rendered). The footer-bar and day-rule tests are the key reds.

- [ ] **Step 3: Rewrite the render block in `main()`**

In `bin/sessions.js`, delete the old layout constants `WHEN_W`/`ID_W`/`COST_W`/`GAP` block (old lines 56-61) and the render section from `const termWidth = ...` through the end of the footer (old lines 99-142). Replace the render section (everything from after the `rows = rows.slice(0, cap);` line down to just before `process.stdout.write(...)`) with:

```js
  const width = termWidth();
  const nowSec = Math.floor(Date.now() / 1000);

  // Column geometry (plain-text widths; ANSI applied after).
  const CLOCK_W = 5, REL_W = 8, COST_W = 8, ID_W = 36, MIN_TITLE = 20;
  const GAP = '  ';
  const leftWidth = 2 + CLOCK_W + GAP.length + REL_W + GAP.length + COST_W + GAP.length; // 29
  const idBlock = GAP.length + ID_W; // 38
  let titleWidth = width - leftWidth - idBlock;
  const showId = titleWidth >= MIN_TITLE;
  if (!showId) titleWidth = width - leftWidth;

  const out = [];
  let curDay = null;
  for (const r of rows) {
    const { title, recap } = readTitleRecap(r.file);
    const key = dayKey(r.ts);
    if (key !== curDay) {
      curDay = key;
      const label = `── ${dayLabel(r.ts)} `;
      out.push(dim(label + '─'.repeat(Math.max(0, width - label.length))));
    }
    const clockCell = dim(clock(r.ts));
    const relCell = dim(relativeTime(nowSec, r.ts).padStart(REL_W));
    const cost = costOf(r.id);
    const plainCost = (cost > 0 ? '$' + cost.toFixed(2) : '—').padStart(COST_W);
    const costCell = cost > 0 ? colorByTier(cost, SESSION_TIERS)(plainCost) : dim(plainCost);
    const titleText = truncate(title || '—', titleWidth);
    let line = `  ${clockCell}${GAP}${relCell}${GAP}${costCell}${GAP}`;
    if (showId) line += titleText.padEnd(titleWidth) + GAP + dim(r.id.padStart(ID_W));
    else line += titleText;
    out.push(line);
    if (recap) {
      const recapText = truncate(recap, Math.max(0, width - leftWidth - 2));
      out.push(`${' '.repeat(leftWidth)}${dim('└ ' + recapText)}`);
    }
  }

  // Footer: budget bars when a budget is set, else a plain d/w/m line.
  const { budgetOptedOut, monthly: mBudget, daily: dLimit, weekly: wLimit } =
    resolveBudget(process.env.STATUSLINE_MONTHLY_BUDGET);
  const per = sumPeriods(agg.perSession, new Date());
  const money = (c) => '$' + c.toFixed(2);
  out.push('');
  if (budgetOptedOut) {
    out.push(
      dim('today ') + money(per.daily) + dim(' · week ') + money(per.weekly) +
      dim(' · month ') + money(per.monthly)
    );
  } else {
    const BAR_W = 8;
    const periods = [
      ['today', per.daily, dLimit],
      ['week', per.weekly, wLimit],
      ['month', per.monthly, mBudget],
    ];
    const amtW = Math.max(...periods.map(([, s]) => money(s).length));
    for (const [label, spent, limit] of periods) {
      const ratio = limit > 0 ? spent / limit : 0;
      const fill = barFill(spent, limit, BAR_W);
      const bar = colorByTier(ratio, BUDGET_TIERS)('▓'.repeat(fill)) + dim('░'.repeat(BAR_W - fill));
      out.push(`${dim(label.padEnd(5))}  ${bar}  ${money(spent).padStart(amtW)}${dim(' / ' + money(limit))}`);
    }
  }
```

Note: the `view`/`titleCol`/header-push lines (old 100-114) are removed — `readTitleRecap` now runs inside the loop. Keep the earlier `if (rows.length === 0) { … 'no sessions found' … return; }` block intact (it precedes this section).

- [ ] **Step 4: Run both viewer test files**

Run: `node --test tests/sessions-viewer.test.js tests/sessions-format.test.js`
Expected: PASS (all).

- [ ] **Step 5: Eyeball the real output**

Run: `node bin/sessions.js --last 6`
Expected: day rules, `HH:MM  Nh ago  $cost  title …  <id>` rows, recap `└` sub-lines, a 3-row budget-bar footer. Then `COLUMNS=40 node bin/sessions.js --last 3` shows no id column but readable titles.

- [ ] **Step 6: Commit**

```bash
git add bin/sessions.js tests/sessions-viewer.test.js
git commit -m "feat: day-grouped session viewer with budget-bar footer"
```

---

## Task 3: Docs + full suite

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the Session viewer description**

In `CLAUDE.md`, find the sentence in the `### Session viewer (bin/sessions.js)` block:

> Renders WHEN / SESSION / TITLE-RECAP;
> titles/recaps are width-truncated only (no redaction). No `--all-profiles`. Also renders a per-session
> COST column and a today/week/month footer (same recomputed costs as the renderer).

Replace with:

> Renders day-grouped rows (a dim `── Ddd Mmm DD ──` rule per local day) of
> `HH:MM · relative-age · cost · title · full-session-id`; titles/recaps are width-truncated only (no
> redaction). The **full** session id (copy-paste-resumable via `claude --resume <id>`) is right-aligned
> and dropped on terminals too narrow to leave a usable title. Recaps render as a dim `└` sub-line. No
> `--all-profiles`. The footer shows today/week/month budget bars (`▓`/`░`, budget-relative coloring) when
> `STATUSLINE_MONTHLY_BUDGET` is set, else a plain `today $X · week $Y · month $Z` line. Terminal width =
> TTY columns, else `COLUMNS`, else 80. Same recomputed costs as the renderer.

- [ ] **Step 2: Add the new test file to the testing list**

In `CLAUDE.md`, find:

> The session viewer has `tests/sessions-viewer.test.js` (transcript-sourced listing, title/recap, `--last`/`--since`); `lib/transcript.js` has `tests/transcript.test.js`.

Replace with:

> The session viewer has `tests/sessions-viewer.test.js` (transcript-sourced listing, day grouping, full id,
> budget-bar footer, `--last`/`--since`) and `tests/sessions-format.test.js` (pure formatting helpers:
> relative time, day labels, bar fill, truncate); `lib/transcript.js` has `tests/transcript.test.js`.

- [ ] **Step 3: Run the entire test suite**

Run: `node --test tests/*.test.js`
Expected: PASS (all files, no regressions).

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: session viewer day-grouped layout + budget-bar footer"
```

---

## Self-Review Notes

- **Spec coverage:** day groups (Task 2), clock+relative (Task 1+2), right-aligned cost (Task 2), full id with narrow-terminal fallback (Task 2), budget bars + opted-out fallback (Task 2), tests (Tasks 1-2), docs (Task 3). All spec sections covered.
- **COLUMNS fallback:** added in Task 1's `termWidth()` — not in the original spec but required so piped output / tests can request a width (TTY still wins). Documented in Task 3.
- **Type consistency:** helper names (`relativeTime`, `dayKey`, `dayLabel`, `clock`, `barFill`, `termWidth`, `truncate`) are identical in the helper definitions, the exports, the unit-test import, and the `main()` call sites.
- **No placeholders:** every code/test/command step is concrete.
