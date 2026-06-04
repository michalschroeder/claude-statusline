# Session Recap + Cost Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pure-Node CLI (`bin/sessions.js`) that lists recent Claude Code sessions per profile with cost + ts (from existing `cost.log` / live temps) joined to ai-title + recap (parsed live from CC transcripts), plus today/week/month totals.

**Architecture:** Extract cost.log parsing/dedup/period-bucketing out of `hooks/statusline.js` into a shared `lib/cost.js` (single source of truth, both renderer and viewer require it). Add `lib/transcript.js` to find + parse transcript jsonl in-process (no `jq`, no subprocess). `bin/sessions.js` composes them. No hook changes, no new persisted file.

**Tech Stack:** Node 18+ stdlib only (`fs`, `path`, `os`). Tests via `node --test`. No build/lint.

Spec: `docs/superpowers/specs/2026-06-05-session-recap-viewer-design.md`.

---

## File Structure

- Create `lib/cost.js` — `resolveStateDir`, `readCostRows`, `readLiveCosts`, `bucketPeriods`.
- Modify `hooks/statusline.js` — require `lib/cost.js`; replace inline state-dir resolution + `readCostRows`/`bucketPeriods` logic inside `readPeriodCosts`.
- Create `lib/transcript.js` — `findTranscript`, `readTitleRecap`.
- Create `bin/sessions.js` — the viewer CLI.
- Modify `tests/helpers.js` — add `runSessions(args, env)` spawn helper.
- Create `tests/cost-lib.test.js`, `tests/transcript.test.js`, `tests/sessions-viewer.test.js`.
- Create fixtures under `tests/fixtures/` as needed (inline-written in tests).
- Modify `CLAUDE.md`, `README.md`.

Run all tests: `node --test tests/*.test.js`.

---

## Task 1: `lib/cost.js` — `resolveStateDir`

**Files:**
- Create: `lib/cost.js`
- Test: `tests/cost-lib.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/cost-lib.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveStateDir } = require('../lib/cost');

test('resolveStateDir: CLAUDE_CONFIG_DIR mangled into profile subdir', () => {
  const prev = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = '/tmp/xdg';
  try {
    assert.strictEqual(
      resolveStateDir('/home/u/.claude-x'),
      path.join('/tmp/xdg', 'claude-statusline', 'home_u_.claude-x')
    );
  } finally {
    if (prev === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = prev;
  }
});

test('resolveStateDir: undefined/empty source → flat layout (empty profile)', () => {
  const prev = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = '/tmp/xdg';
  try {
    assert.strictEqual(resolveStateDir(undefined), path.join('/tmp/xdg', 'claude-statusline', ''));
    assert.strictEqual(resolveStateDir(''), path.join('/tmp/xdg', 'claude-statusline', ''));
  } finally {
    if (prev === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = prev;
  }
});

test('resolveStateDir: no XDG_STATE_HOME → ~/.local/state', () => {
  const prev = process.env.XDG_STATE_HOME;
  delete process.env.XDG_STATE_HOME;
  try {
    assert.strictEqual(
      resolveStateDir('/a/b'),
      path.join(os.homedir(), '.local', 'state', 'claude-statusline', 'a_b')
    );
  } finally {
    if (prev !== undefined) process.env.XDG_STATE_HOME = prev;
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/cost-lib.test.js`
Expected: FAIL — `Cannot find module '../lib/cost'`.

- [ ] **Step 3: Write minimal implementation**

Create `lib/cost.js`:

```js
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

// State dir resolution (MUST match hooks/statusline.js and the bash hooks). Data
// lives in our own XDG namespace; CLAUDE_CONFIG_DIR is only a per-profile KEY —
// its sanitized path becomes a profile subdir. Falsy source → empty profile →
// flat layout (single-profile users), unchanged.
function resolveStateDir(configDir) {
  const xdgRoot = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  const profile = configDir ? configDir.replace(/^\//, '').replace(/\//g, '_') : '';
  return path.join(xdgRoot, 'claude-statusline', profile);
}

module.exports = { resolveStateDir };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/cost-lib.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/cost.js tests/cost-lib.test.js
git commit -m "feat: lib/cost.js resolveStateDir"
```

---

## Task 2: `lib/cost.js` — `readCostRows`

**Files:**
- Modify: `lib/cost.js`
- Test: `tests/cost-lib.test.js`

- [ ] **Step 1: Write the failing test** — append to `tests/cost-lib.test.js`:

```js
const { readCostRows } = require('../lib/cost');

function mkState(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-cost-'));
  if (lines != null) fs.writeFileSync(path.join(dir, 'cost.log'), lines);
  return dir;
}

test('readCostRows: dedup by id keeps the largest cumulative cost', () => {
  const dir = mkState(
    '2026-06-05 1000 sessA 0.50\n' +
    '2026-06-05 1100 sessA 1.20\n' +   // resume → larger, wins
    '2026-06-05 1000 sessB 0.30\n'
  );
  const rows = readCostRows(dir);
  assert.strictEqual(rows.get('sessA').cost, 1.20);
  assert.strictEqual(rows.get('sessA').ts, 1100);
  assert.strictEqual(rows.get('sessB').cost, 0.30);
  assert.strictEqual(rows.size, 2);
});

test('readCostRows: skips malformed / non-positive / short rows', () => {
  const dir = mkState(
    'too few fields\n' +
    '2026-06-05 notanum sessC 0.10\n' +    // NaN ts
    '2026-06-05 1000 sessD notanum\n' +    // NaN cost
    '2026-06-05 1000 sessE -5\n' +         // negative
    '2026-06-05 1000 sessF 0\n' +          // zero
    '2026-06-05 1000  0.40\n' +            // empty id (double space → parts[2]='')
    '2026-06-05 1000 sessG 0.40\n'         // the only valid row
  );
  const rows = readCostRows(dir);
  assert.deepStrictEqual([...rows.keys()], ['sessG']);
});

test('readCostRows: missing cost.log → empty map', () => {
  const dir = mkState(null);
  assert.strictEqual(readCostRows(dir).size, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/cost-lib.test.js`
Expected: FAIL — `readCostRows is not a function`.

- [ ] **Step 3: Write minimal implementation** — add to `lib/cost.js` (before `module.exports`) and extend exports:

```js
// Read cost.log → Map<id, {ts, cost}>, deduped keeping the LARGEST cumulative
// cost per session (total_cost_usd is cumulative; a resume logs a second larger
// line). Skips rows with <4 fields, NaN ts/cost, cost<=0, or empty id.
function readCostRows(stateDir) {
  const byId = new Map();
  try {
    const lines = fs.readFileSync(path.join(stateDir, 'cost.log'), 'utf8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      const parts = line.split(' ');
      if (parts.length < 4) continue;
      const ts = parseInt(parts[1], 10);
      const id = parts[2];
      const c = parseFloat(parts[3]);
      if (isNaN(ts) || isNaN(c) || c <= 0 || !id) continue;
      const prev = byId.get(id);
      if (!prev || c > prev.cost) byId.set(id, { ts, cost: c });
    }
  } catch {}
  return byId;
}
```

Update the export line to: `module.exports = { resolveStateDir, readCostRows };`

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/cost-lib.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/cost.js tests/cost-lib.test.js
git commit -m "feat: lib/cost.js readCostRows"
```

---

## Task 3: `lib/cost.js` — `readLiveCosts`

**Files:**
- Modify: `lib/cost.js`
- Test: `tests/cost-lib.test.js`

- [ ] **Step 1: Write the failing test** — append:

```js
const { readLiveCosts } = require('../lib/cost');

test('readLiveCosts: reads every cost/<id> temp, skips bad/non-positive', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-live-'));
  const costDir = path.join(dir, 'cost');
  fs.mkdirSync(costDir);
  fs.writeFileSync(path.join(costDir, 'live1'), '0.75');
  fs.writeFileSync(path.join(costDir, 'live2'), '2.50');
  fs.writeFileSync(path.join(costDir, 'bad'), 'notanum');
  fs.writeFileSync(path.join(costDir, 'zero'), '0');
  const live = readLiveCosts(dir);
  assert.strictEqual(live.get('live1'), 0.75);
  assert.strictEqual(live.get('live2'), 2.50);
  assert.strictEqual(live.has('bad'), false);
  assert.strictEqual(live.has('zero'), false);
});

test('readLiveCosts: missing cost/ dir → empty map', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-live2-'));
  assert.strictEqual(readLiveCosts(dir).size, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/cost-lib.test.js`
Expected: FAIL — `readLiveCosts is not a function`.

- [ ] **Step 3: Write minimal implementation** — add to `lib/cost.js`:

```js
// Read every cost/<id> temp (plain float) for still-running sessions → Map<id, cost>.
// Skips NaN / non-positive. (The renderer only reads its own session's temp.)
function readLiveCosts(stateDir) {
  const live = new Map();
  try {
    const dir = path.join(stateDir, 'cost');
    for (const id of fs.readdirSync(dir)) {
      try {
        const c = parseFloat(fs.readFileSync(path.join(dir, id), 'utf8'));
        if (!isNaN(c) && c > 0) live.set(id, c);
      } catch {}
    }
  } catch {}
  return live;
}
```

Update exports: `module.exports = { resolveStateDir, readCostRows, readLiveCosts };`

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/cost-lib.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/cost.js tests/cost-lib.test.js
git commit -m "feat: lib/cost.js readLiveCosts"
```

---

## Task 4: `lib/cost.js` — `bucketPeriods`

**Files:**
- Modify: `lib/cost.js`
- Test: `tests/cost-lib.test.js`

- [ ] **Step 1: Write the failing test** — append. Build rows relative to the REAL `now` (no fake clock):

```js
const { bucketPeriods } = require('../lib/cost');

test('bucketPeriods: sums by local-calendar day/week/month windows', () => {
  const now = new Date();
  const sec = (d) => Math.floor(d.getTime() / 1000);
  const dayStart = sec(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
  const monthStart = sec(new Date(now.getFullYear(), now.getMonth(), 1));
  const daysSinceMonday = (now.getDay() + 6) % 7;
  const weekStart = sec(new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysSinceMonday));

  const rows = [
    { ts: dayStart, cost: 1.00 },        // today (and week, and month)
    { ts: dayStart - 1, cost: 0.50 },    // before today: in week only if weekStart<=this
    { ts: monthStart - 1, cost: 0.25 },  // before this month → counts in none of the three
  ];
  const { daily, weekly, monthly } = bucketPeriods(rows, now);

  assert.ok(Math.abs(daily - 1.00) < 1e-9);
  // weekly/monthly include the 1.00; the 0.50 and 0.25 depend on window edges:
  let expWeek = 1.00 + (dayStart - 1 >= weekStart ? 0.50 : 0) + (monthStart - 1 >= weekStart ? 0.25 : 0);
  let expMonth = 1.00 + (dayStart - 1 >= monthStart ? 0.50 : 0); // monthStart-1 always < monthStart
  assert.ok(Math.abs(weekly - expWeek) < 1e-9);
  assert.ok(Math.abs(monthly - expMonth) < 1e-9);
});

test('bucketPeriods: accepts a Map.values() iterable', () => {
  const now = new Date();
  const dayStart = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000);
  const m = new Map([['x', { ts: dayStart, cost: 2.00 }]]);
  const { daily } = bucketPeriods(m.values(), now);
  assert.ok(Math.abs(daily - 2.00) < 1e-9);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/cost-lib.test.js`
Expected: FAIL — `bucketPeriods is not a function`.

- [ ] **Step 3: Write minimal implementation** — add to `lib/cost.js`:

```js
// Sum {ts, cost} rows into local-calendar windows: daily = since today's midnight,
// weekly = since this week's Monday ((getDay()+6)%7 days back), monthly = since the
// 1st. `rows` is any iterable of {ts, cost}. `now` is a Date.
function bucketPeriods(rows, now) {
  const sec = (d) => Math.floor(d.getTime() / 1000);
  const dayStart = sec(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
  const daysSinceMonday = (now.getDay() + 6) % 7; // getDay(): 0=Sun..6=Sat → Mon=0
  const weekStart = sec(new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysSinceMonday));
  const monthStart = sec(new Date(now.getFullYear(), now.getMonth(), 1));
  let daily = 0, weekly = 0, monthly = 0;
  for (const { ts, cost } of rows) {
    if (ts >= dayStart) daily += cost;
    if (ts >= weekStart) weekly += cost;
    if (ts >= monthStart) monthly += cost;
  }
  return { daily, weekly, monthly };
}
```

Update exports: `module.exports = { resolveStateDir, readCostRows, readLiveCosts, bucketPeriods };`

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/cost-lib.test.js`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/cost.js tests/cost-lib.test.js
git commit -m "feat: lib/cost.js bucketPeriods"
```

---

## Task 5: Refactor `hooks/statusline.js` onto `lib/cost.js`

Replace the inline state-dir resolution and the body of `readPeriodCosts` with calls into `lib/cost.js`. Renderer behavior MUST be unchanged — existing tests are the guard.

**Files:**
- Modify: `hooks/statusline.js:4-6` (requires), `:155-195` (`readPeriodCosts`), `:299` (remove `homeDir`), `:306-310` (state dir)
- Guard tests: `tests/cost.test.js`, `tests/period-cost.test.js`, `tests/cleanup-hook.test.js`, `tests/state-dir.test.js`

- [ ] **Step 1: Run the existing suite to capture the green baseline**

Run: `node --test tests/*.test.js`
Expected: PASS (all current tests, ~170). Note the count.

- [ ] **Step 2: Add the require** — after `hooks/statusline.js:6` (`const os = require('os');`) add:

```js
const { resolveStateDir, readCostRows, bucketPeriods } = require('../lib/cost');
```

- [ ] **Step 3: Replace `readPeriodCosts` body** — replace the whole function at `hooks/statusline.js:155-195` (from `function readPeriodCosts(stateDir, liveSession, liveCost) {` through its closing `}`) with the thin wrapper:

```js
/**
 * Sum cost.log entries by calendar period. Returns {daily, weekly, monthly}.
 * Thin wrapper over lib/cost.js: dedup-keep-max rows + fold the live session at
 * `now` (its cumulative supersedes any logged line) → bucket into local windows.
 */
function readPeriodCosts(stateDir, liveSession, liveCost) {
  const now = new Date();
  const rows = readCostRows(stateDir);
  if (liveSession && liveCost > 0) {
    rows.set(liveSession, { ts: Math.floor(now.getTime() / 1000), cost: liveCost });
  }
  return bucketPeriods(rows.values(), now);
}
```

- [ ] **Step 4: Replace the inline state-dir block** — replace `hooks/statusline.js:306-310`:

```js
    const xdgRoot = process.env.XDG_STATE_HOME || path.join(homeDir, '.local', 'state');
    const profile = process.env.CLAUDE_CONFIG_DIR
      ? process.env.CLAUDE_CONFIG_DIR.replace(/^\//, '').replace(/\//g, '_')
      : '';
    const stateDir = path.join(xdgRoot, 'claude-statusline', profile);
```

with:

```js
    const stateDir = resolveStateDir(process.env.CLAUDE_CONFIG_DIR);
```

- [ ] **Step 5: Remove the now-unused `homeDir`** — delete `hooks/statusline.js:299` (`const homeDir = os.homedir();`). (`os` stays — still used by `resolveIconMode` at ~L53.)

- [ ] **Step 6: Run the full suite — behavior must be unchanged**

Run: `node --test tests/*.test.js`
Expected: PASS — same count as Step 1. If `state-dir.test.js` or `period-cost.test.js` regress, the wrapper/extraction diverged from the original; reconcile against the Task-2/Task-4 code.

- [ ] **Step 7: Manual smoke check**

Run: `echo '{"model":{"display_name":"Claude"},"workspace":{"current_dir":"/tmp","project_dir":"/tmp"}}' | node hooks/statusline.js`
Expected: a statusline line prints, no crash.

- [ ] **Step 8: Commit**

```bash
git add hooks/statusline.js
git commit -m "refactor: statusline.js uses shared lib/cost.js"
```

---

## Task 6: `lib/transcript.js` — `readTitleRecap`

**Files:**
- Create: `lib/transcript.js`
- Test: `tests/transcript.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/transcript.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readTitleRecap } = require('../lib/transcript');

function mkJsonl(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-tr-'));
  const fp = path.join(dir, 's.jsonl');
  fs.writeFileSync(fp, lines.map((o) => (typeof o === 'string' ? o : JSON.stringify(o))).join('\n') + '\n');
  return fp;
}

test('readTitleRecap: takes LAST ai-title and LAST away_summary, strips disclaimer', () => {
  const fp = mkJsonl([
    { type: 'ai-title', aiTitle: 'First title' },
    { type: 'user', text: 'noise' },
    { type: 'system', subtype: 'away_summary', content: 'Old recap (disable recaps in /config)' },
    { type: 'ai-title', aiTitle: 'Final title' },
    { type: 'system', subtype: 'away_summary', content: 'Latest recap (disable recaps in /config)' },
  ]);
  assert.deepStrictEqual(readTitleRecap(fp), { title: 'Final title', recap: 'Latest recap' });
});

test('readTitleRecap: title only → recap null', () => {
  const fp = mkJsonl([{ type: 'ai-title', aiTitle: 'Only title' }]);
  assert.deepStrictEqual(readTitleRecap(fp), { title: 'Only title', recap: null });
});

test('readTitleRecap: recap only → title null', () => {
  const fp = mkJsonl([{ type: 'system', subtype: 'away_summary', content: 'A recap (disable recaps in /config)' }]);
  assert.deepStrictEqual(readTitleRecap(fp), { title: null, recap: 'A recap' });
});

test('readTitleRecap: neither → both null', () => {
  const fp = mkJsonl([{ type: 'user', text: 'hi' }]);
  assert.deepStrictEqual(readTitleRecap(fp), { title: null, recap: null });
});

test('readTitleRecap: tolerates unparseable lines', () => {
  const fp = mkJsonl([
    'not json at all',
    { type: 'ai-title', aiTitle: 'Survives' },
    '{ broken json',
  ]);
  assert.deepStrictEqual(readTitleRecap(fp), { title: 'Survives', recap: null });
});

test('readTitleRecap: recap without disclaimer left intact', () => {
  const fp = mkJsonl([{ type: 'system', subtype: 'away_summary', content: 'Bare recap' }]);
  assert.strictEqual(readTitleRecap(fp).recap, 'Bare recap');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/transcript.test.js`
Expected: FAIL — `Cannot find module '../lib/transcript'`.

- [ ] **Step 3: Write minimal implementation**

Create `lib/transcript.js`:

```js
'use strict';
const fs = require('fs');
const path = require('path');

const DISCLAIMER = / *\(disable recaps in \/config\)$/;

// Parse a transcript .jsonl in-process (no jq). Returns the LAST ai-title and the
// LAST away_summary (the /recap output), each string or null. Unparseable lines
// are skipped. Trailing " (disable recaps in /config)" is stripped from the recap.
function readTitleRecap(filePath) {
  let title = null, recap = null;
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { title, recap };
  }
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o && o.type === 'ai-title' && typeof o.aiTitle === 'string') {
      title = o.aiTitle;
    } else if (o && o.type === 'system' && o.subtype === 'away_summary' && typeof o.content === 'string') {
      recap = o.content.replace(DISCLAIMER, '');
    }
  }
  return { title, recap };
}

module.exports = { readTitleRecap };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/transcript.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/transcript.js tests/transcript.test.js
git commit -m "feat: lib/transcript.js readTitleRecap"
```

---

## Task 7: `lib/transcript.js` — `findTranscript`

**Files:**
- Modify: `lib/transcript.js`
- Test: `tests/transcript.test.js`

- [ ] **Step 1: Write the failing test** — append to `tests/transcript.test.js`:

```js
const { findTranscript } = require('../lib/transcript');

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'csl-root-'));
}

test('findTranscript: finds <id>.jsonl under projects/<enc>/', () => {
  const root = mkRoot();
  const proj = path.join(root, 'projects', '-home-u-repo');
  fs.mkdirSync(proj, { recursive: true });
  const fp = path.join(proj, 'abc123.jsonl');
  fs.writeFileSync(fp, '{}\n');
  assert.strictEqual(findTranscript(root, 'abc123'), fp);
});

test('findTranscript: excludes subagent transcripts', () => {
  const root = mkRoot();
  const sub = path.join(root, 'projects', '-home-u-repo', 'sessX', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'abc123.jsonl'), '{}\n'); // must be ignored
  assert.strictEqual(findTranscript(root, 'abc123'), null);
});

test('findTranscript: not found → null', () => {
  const root = mkRoot();
  fs.mkdirSync(path.join(root, 'projects'), { recursive: true });
  assert.strictEqual(findTranscript(root, 'nope'), null);
});

test('findTranscript: missing projects/ → null', () => {
  const root = mkRoot();
  assert.strictEqual(findTranscript(root, 'x'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/transcript.test.js`
Expected: FAIL — `findTranscript is not a function`.

- [ ] **Step 3: Write minimal implementation** — add to `lib/transcript.js` and extend exports:

```js
// Locate a session's transcript: <root>/projects/<enc-cwd>/<sessionId>.jsonl.
// Scans the immediate project subdirs (the real CC layout) and returns the first
// match. Subagent transcripts live under .../<sessionId>/subagents/ — a nested
// path that never matches projects/<enc>/<id>.jsonl, so they're excluded by
// construction. Returns null when projects/ is absent or no match exists.
function findTranscript(root, sessionId) {
  const projects = path.join(root, 'projects');
  const target = `${sessionId}.jsonl`;
  let entries;
  try {
    entries = fs.readdirSync(projects, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const candidate = path.join(projects, e.name, target);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}
```

Update exports: `module.exports = { readTitleRecap, findTranscript };`

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/transcript.test.js`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/transcript.js tests/transcript.test.js
git commit -m "feat: lib/transcript.js findTranscript"
```

---

## Task 8: `tests/helpers.js` — `runSessions` spawn helper

**Files:**
- Modify: `tests/helpers.js`

- [ ] **Step 1: Add the helper** — in `tests/helpers.js`, after the `runRaw` function (~line 47) add:

```js
const SESSIONS = path.resolve(__dirname, '../bin/sessions.js');

// Spawn bin/sessions.js with CLI args + env, resolve stripped-ANSI stdout. Mirrors
// _invoke's CLAUDE_CONFIG_DIR scrub so XDG_STATE_HOME isolation holds in tests.
function runSessions(args = [], env) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...process.env, STATUSLINE_ICONS: 'nerd', ...(env || {}) };
    if (!(env && 'CLAUDE_CONFIG_DIR' in env)) delete childEnv.CLAUDE_CONFIG_DIR;
    const proc = spawn(process.execPath, [SESSIONS, ...args], { env: childEnv });
    let out = '', err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('close', (code) => {
      if (code !== 0 && err) reject(new Error(err));
      else resolve(stripAnsi(out));
    });
  });
}
```

- [ ] **Step 2: Extend the exports** — change the final `module.exports` line of `tests/helpers.js`:

```js
module.exports = { stripAnsi, baseInput, run, runRaw, mkTmpGit, runSessions };
```

- [ ] **Step 3: Sanity-check the module still loads**

Run: `node -e "require('./tests/helpers.js')"`
Expected: no output, exit 0 (no syntax error).

- [ ] **Step 4: Commit**

```bash
git add tests/helpers.js
git commit -m "test: runSessions spawn helper"
```

---

## Task 9: `bin/sessions.js` — viewer CLI

**Files:**
- Create: `bin/sessions.js`
- Test: `tests/sessions-viewer.test.js`

The viewer is rendered with the same icon/color discipline as the renderer is NOT required here — keep output plain text + minimal ANSI. Tests strip ANSI, so assertions target text only.

- [ ] **Step 1: Write the failing test**

Create `tests/sessions-viewer.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runSessions } = require('./helpers');

// Build an isolated profile: XDG_STATE_HOME → state dir; configDir → transcript root.
// Returns { env, configDir } to pass to runSessions.
function mkProfile() {
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-xdg-'));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-cfg-'));
  // state dir = <xdg>/claude-statusline/<mangled configDir>
  const profile = configDir.replace(/^\//, '').replace(/\//g, '_');
  const stateDir = path.join(xdg, 'claude-statusline', profile);
  fs.mkdirSync(stateDir, { recursive: true });
  return { xdg, configDir, stateDir };
}

function writeCostLog(stateDir, lines) {
  fs.writeFileSync(path.join(stateDir, 'cost.log'), lines.join('\n') + '\n');
}

function writeTranscript(configDir, sessionId, entries) {
  const proj = path.join(configDir, 'projects', '-test-proj');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(
    path.join(proj, `${sessionId}.jsonl`),
    entries.map((o) => JSON.stringify(o)).join('\n') + '\n'
  );
}

function writeLive(stateDir, sessionId, cost) {
  const d = path.join(stateDir, 'cost');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, sessionId), String(cost));
}

const env = (p) => ({ XDG_STATE_HOME: p.xdg });

test('viewer: empty state → friendly message', async () => {
  const p = mkProfile();
  const out = await runSessions(['--config-dir', p.configDir], env(p));
  assert.match(out, /no sessions recorded yet/i);
});

test('viewer: prints a row with title + recap sub-line', async () => {
  const p = mkProfile();
  const now = Math.floor(Date.now() / 1000);
  writeCostLog(p.stateDir, [`2026-06-05 ${now} sessAAA1 0.83`]);
  writeTranscript(p.configDir, 'sessAAA1', [
    { type: 'ai-title', aiTitle: 'Address timezone comment' },
    { type: 'system', subtype: 'away_summary', content: 'Applied 4 reviewer changes (disable recaps in /config)' },
  ]);
  const out = await runSessions(['--config-dir', p.configDir], env(p));
  assert.match(out, /sessAAA1|sessAAA/); // short id appears
  assert.match(out, /Address timezone comment/);
  assert.match(out, /Applied 4 reviewer changes/);
  assert.match(out, /\$0\.83/);
});

test('viewer: title absent → em dash, no recap line', async () => {
  const p = mkProfile();
  const now = Math.floor(Date.now() / 1000);
  writeCostLog(p.stateDir, [`2026-06-05 ${now} sessBBB1 1.10`]);
  writeTranscript(p.configDir, 'sessBBB1', [{ type: 'user', text: 'hi' }]);
  const out = await runSessions(['--config-dir', p.configDir], env(p));
  assert.match(out, /—/);
  assert.match(out, /\$1\.10/);
});

test('viewer: live session marked, folded into TODAY total', async () => {
  const p = mkProfile();
  writeLive(p.stateDir, 'sessLIVE1', 1.20);
  writeTranscript(p.configDir, 'sessLIVE1', [{ type: 'ai-title', aiTitle: 'Live work' }]);
  const out = await runSessions(['--config-dir', p.configDir], env(p));
  assert.match(out, /Live work/);
  assert.match(out, /●/);                 // live marker
  assert.match(out, /incl\. live/i);
  assert.match(out, /TODAY:\s*\$1\.20/);
});

test('viewer: --last caps rows', async () => {
  const p = mkProfile();
  const now = Math.floor(Date.now() / 1000);
  const lines = [];
  for (let i = 0; i < 5; i++) lines.push(`2026-06-05 ${now - i} sess${i}xxx ${(i + 1) / 10}`);
  writeCostLog(p.stateDir, lines);
  const out = await runSessions(['--config-dir', p.configDir, '--last', '2'], env(p));
  const dataRows = out.split('\n').filter((l) => /\$\d/.test(l) && !/TODAY:/.test(l));
  assert.strictEqual(dataRows.length, 2);
});

test('viewer: --since filters older rows out', async () => {
  const p = mkProfile();
  const nowD = new Date();
  const todayTs = Math.floor(new Date(nowD.getFullYear(), nowD.getMonth(), nowD.getDate(), 12).getTime() / 1000);
  const oldTs = todayTs - 40 * 86400; // 40 days ago
  writeCostLog(p.stateDir, [
    `2026-06-05 ${todayTs} sessNEW1 0.50`,
    `2026-04-01 ${oldTs} sessOLD1 0.50`,
  ]);
  const since = `${nowD.getFullYear()}-${String(nowD.getMonth() + 1).padStart(2, '0')}-${String(nowD.getDate()).padStart(2, '0')}`;
  const out = await runSessions(['--config-dir', p.configDir, '--since', since], env(p));
  assert.match(out, /sessNEW/);
  assert.doesNotMatch(out, /sessOLD/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/sessions-viewer.test.js`
Expected: FAIL — spawn error / `Cannot find module` for `bin/sessions.js`.

- [ ] **Step 3: Write the implementation**

Create `bin/sessions.js`:

```js
#!/usr/bin/env node
'use strict';
const path = require('path');
const os = require('os');
const { resolveStateDir, readCostRows, readLiveCosts, bucketPeriods } = require('../lib/cost');
const { findTranscript, readTitleRecap } = require('../lib/transcript');

function parseArgs(argv) {
  const opts = { last: null, since: null, configDir: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--last') opts.last = parseInt(argv[++i], 10);
    else if (a === '--since') opts.since = argv[++i];
    else if (a === '--config-dir') opts.configDir = argv[++i];
  }
  return opts;
}

// '2026-06-01' → local-midnight unix seconds, or null if unparseable.
function sinceToTs(s) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return Math.floor(new Date(+m[1], +m[2] - 1, +m[3]).getTime() / 1000);
}

function fmtWhen(ts) {
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function truncate(s, width) {
  if (s.length <= width) return s;
  return s.slice(0, Math.max(0, width - 1)) + '…';
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const source = opts.configDir !== undefined ? opts.configDir : process.env.CLAUDE_CONFIG_DIR;
  const stateDir = resolveStateDir(source);                       // unset → flat (matches renderer)
  const transcriptRoot = source || path.join(os.homedir(), '.claude'); // default only for projects/

  const logged = readCostRows(stateDir);          // Map<id, {ts, cost}>
  const live = readLiveCosts(stateDir);           // Map<id, cost>
  const now = new Date();
  const nowTs = Math.floor(now.getTime() / 1000);

  // Merge: live cost supersedes logged for the same id; live rows bucket at now.
  const merged = new Map();
  for (const [id, r] of logged) merged.set(id, { ts: r.ts, cost: r.cost, live: false });
  for (const [id, cost] of live) merged.set(id, { ts: nowTs, cost, live: true });

  if (merged.size === 0) {
    process.stdout.write('no sessions recorded yet\n');
    return;
  }

  // Period totals over ALL merged rows (incl. live), before row filtering.
  const totals = bucketPeriods([...merged.values()], now);
  const anyLive = [...merged.values()].some((r) => r.live);

  // Rows: filter --since, sort desc by ts, cap --last (default 10; skipped when
  // --since given without --last).
  let rows = [...merged.entries()].map(([id, r]) => ({ id, ...r }));
  const sinceTs = sinceToTs(opts.since);
  if (sinceTs != null) rows = rows.filter((r) => r.ts >= sinceTs);
  rows.sort((a, b) => b.ts - a.ts);
  const cap = opts.last != null && !isNaN(opts.last)
    ? opts.last
    : (opts.since ? Infinity : 10);
  rows = rows.slice(0, cap);

  const width = process.stdout.columns || 80;
  const out = [];
  out.push('WHEN         COST     SESSION   TITLE / RECAP');
  for (const r of rows) {
    const tr = findTranscript(transcriptRoot, r.id);
    const { title, recap } = tr ? readTitleRecap(tr) : { title: null, recap: null };
    const when = fmtWhen(r.ts);
    const cost = `$${r.cost.toFixed(2)}${r.live ? ' ●' : '  '}`;
    const shortId = r.id.slice(0, 8);
    const titleText = title || '—';
    out.push(truncate(`${when}  ${cost.padEnd(8)} ${shortId.padEnd(8)}  ${titleText}`, width));
    if (recap) out.push(truncate(`${' '.repeat(33)}└ ${recap}`, width));
  }
  const liveNote = anyLive ? '  (incl. live)' : '';
  out.push(
    `TODAY: $${totals.daily.toFixed(2)}   WEEK: $${totals.weekly.toFixed(2)}   MONTH: $${totals.monthly.toFixed(2)}${liveNote}`
  );
  process.stdout.write(out.join('\n') + '\n');
}

main();
```

- [ ] **Step 4: Make it executable**

Run: `chmod +x bin/sessions.js`

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/sessions-viewer.test.js`
Expected: PASS (6 tests). If the `--since` test fails because `sessOLD` still appears, confirm `sinceToTs` parses the date and the filter uses `>=`.

- [ ] **Step 6: Manual smoke check**

Run: `node bin/sessions.js --config-dir /tmp/does-not-exist`
Expected: `no sessions recorded yet`.

- [ ] **Step 7: Commit**

```bash
git add bin/sessions.js tests/sessions-viewer.test.js
git commit -m "feat: bin/sessions.js session recap + cost viewer"
```

---

## Task 10: Full-suite regression + docs

**Files:**
- Modify: `CLAUDE.md`, `README.md`

- [ ] **Step 1: Run the entire suite**

Run: `node --test tests/*.test.js`
Expected: PASS — all prior tests plus the new `cost-lib`, `transcript`, `sessions-viewer` files. No regressions.

- [ ] **Step 2: Update `CLAUDE.md`** — under "## Architecture", after the state-dir paragraph, add a subsection documenting the split:

```markdown
### Shared cost lib (`lib/cost.js`)

`cost.log` parsing lives in `lib/cost.js` — `resolveStateDir(configDir)` (the `/`→`_`
profile mangling), `readCostRows(stateDir)` (dedup-by-id keep-max), `readLiveCosts(stateDir)`
(every `cost/<id>` temp), `bucketPeriods(rows, now)` (local-calendar day/week/month sums).
Both the renderer (`hooks/statusline.js`, whose `readPeriodCosts` is now a thin wrapper folding
the live session at `now`) and the viewer (`bin/sessions.js`) require it — single source of truth.

### Session viewer (`bin/sessions.js`)

Standalone CLI (NOT the renderer — may use whatever it needs, but is pure Node anyway). Lists
recent sessions with cost + ts (from `cost.log` + live `cost/<id>` temps) joined to ai-title +
recap parsed in-process from the CC transcript via `lib/transcript.js` (`findTranscript`,
`readTitleRecap` — last `ai-title` / last `away_summary`, disclaimer stripped, subagent
transcripts excluded). Config-dir resolution: `--config-dir` ?? `CLAUDE_CONFIG_DIR`; state-dir
profile uses that source raw (unset → flat, matching the renderer), transcript root defaults to
`~/.claude` only for `projects/` discovery. Flags: `--last N` (default 10), `--since YYYY-MM-DD`
(lower ts bound; without `--last` shows all matches), `--config-dir <path>`. Live sessions marked
`●` and folded into the TODAY/WEEK/MONTH footer. Titles/recaps are width-truncated only (no
redaction). No `--all-profiles` (the profile mangling is lossy).
```

- [ ] **Step 3: Update `README.md`** — add a "Session viewer" section with the usage example:

```markdown
## Session viewer

List recent sessions with cost + what each was about (reusing Claude Code's own
session title and `/recap` summary, parsed from the transcript — no extra AI spend):

    $ node bin/sessions.js --last 10
    WHEN         COST     SESSION   TITLE / RECAP
    06-05 14:02  $1.20 ●  e7ddfb1f  Refactor cost parser
    06-05 00:25  $0.83    a3f1c0d2  Address timezone comment
                                    └ Applied 4 reviewer changes…
    TODAY: $5.41   WEEK: $48.20   MONTH: $210.00  (incl. live)

`●` marks a still-running session. Flags: `--last N` (default 10),
`--since YYYY-MM-DD`, `--config-dir <path>` (target another Claude Code profile).
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: session viewer + lib/cost refactor"
```

---

## Self-Review notes (resolved)

- **Spec coverage:** A (viewer-only, in-process parse) → Tasks 6–9; lib extraction → Tasks 1–5;
  config-dir/profile split (unset→flat, transcript default ~/.claude) → Task 9 Step 3 + tests;
  label (ai-title strict title, recap as `└`, `—` fallbacks) → Task 9 + viewer tests; truncate-only
  → `truncate()`; live `●` + folded totals → Task 9 + live test; flags `--last`/`--since`/`--config-dir`
  + interaction → Task 9 `cap` logic + tests; dedup keep-max → Task 2; period windows → Task 4;
  tests one-file-per-unit + temp XDG + scrubbed CLAUDE_CONFIG_DIR → Tasks 1–9; docs → Task 10.
- **Type consistency:** `readCostRows`→`Map<id,{ts,cost}>`, `readLiveCosts`→`Map<id,cost>`,
  `bucketPeriods(iterable<{ts,cost}>, Date)`→`{daily,weekly,monthly}`, `findTranscript(root,id)`→path|null,
  `readTitleRecap(path)`→`{title,recap}` — names/shapes consistent across renderer wrapper and viewer.
- **No placeholders:** every code/test step contains full content; no TBD/TODO.

## Unresolved questions

None.
