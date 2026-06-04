'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveStateDir } = require('../lib/cost');

const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

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

const { readCostRows } = require('../lib/cost');

function mkState(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-cost-'));
  tmpDirs.push(dir);
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

const { readLiveCosts } = require('../lib/cost');

test('readLiveCosts: reads every cost/<id> temp, skips bad/non-positive', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-live-'));
  tmpDirs.push(dir);
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
  tmpDirs.push(dir);
  assert.strictEqual(readLiveCosts(dir).size, 0);
});

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
  const { daily: dailyExcl } = bucketPeriods([{ ts: dayStart - 1, cost: 5.00 }], now);
  assert.ok(Math.abs(dailyExcl - 0) < 1e-9, 'ts before midnight excluded from daily');
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
