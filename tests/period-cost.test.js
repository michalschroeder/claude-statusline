'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { baseInput, run, runRaw } = require('./helpers.js');

const tmp = [];
after(() => { for (const d of tmp) fs.rmSync(d, { recursive: true, force: true }); });

// Build an isolated XDG state dir holding a cost-cache.json with the given perSession.
function stateWithCache(perSession) {
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-pc-')); tmp.push(xdg);
  const dir = path.join(xdg, 'claude-statusline'); // empty profile (no CLAUDE_CONFIG_DIR)
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'cost-cache.json'), JSON.stringify({ pricingHash: 'h', files: {}, perSession }));
  return xdg;
}

function todayKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

test('d/w/m chips sum cached other-sessions + folded live session delta', async () => {
  const xdg = stateWithCache({ other: { days: { [todayKey()]: 2 }, total: 2 } });
  const i = baseInput();
  i.session_id = 'current';
  i.cost = { total_cost_usd: 3 };
  const out = await run(i, { XDG_STATE_HOME: xdg, STATUSLINE_MONTHLY_BUDGET: '300' });
  // current not in cache → cachedSession 0, delta = live 3; daily = other(2) + 3 = $5.00
  assert.ok(out.includes('s $3.00'));
  assert.ok(out.includes('d $5.00'));
});

test('current session: cache day-buckets honored, only live delta folded (no double count)', async () => {
  // cache has current at $1 today; live reports $3 cumulative → delta is $2.
  const xdg = stateWithCache({ current: { days: { [todayKey()]: 1 }, total: 1 } });
  const i = baseInput();
  i.session_id = 'current';
  i.cost = { total_cost_usd: 3 };
  const out = await run(i, { XDG_STATE_HOME: xdg, STATUSLINE_MONTHLY_BUDGET: '300' });
  // s = cached(1) + delta(2) = $3.00; daily = today bucket(1) + delta(2) = $3.00 (NOT 1+3=4)
  assert.ok(out.includes('s $3.00'));
  assert.ok(out.includes('d $3.00'));
});

test('session spend on a past day is NOT dumped into today', async () => {
  // A resumed session: $10 spent on a past (out-of-window) day, $1 today; live == cached total.
  const xdg = stateWithCache({ current: { days: { '2020-01-01': 10, [todayKey()]: 1 }, total: 11 } });
  const i = baseInput();
  i.session_id = 'current';
  i.cost = { total_cost_usd: 11 }; // live == cached → delta 0
  const out = await run(i, { XDG_STATE_HOME: xdg, STATUSLINE_MONTHLY_BUDGET: '300' });
  // daily = today bucket(1) + delta(0) = $1.00 (the past $10 stays out of "today"); s = $11.00
  assert.ok(out.includes('s $11.00'));
  assert.ok(out.includes('d $1.00'));
});

test('live delta clamped: lifetime cross-basis gap does NOT inflate today (#44)', async () => {
  // current recomputed $80 on a PAST day (out of today's window), $0 today; live
  // reports $100 (different pricing basis). Raw delta would be $20 → phantom 'today'.
  // Clamp caps it at MAX_LIVE_DELTA ($5).
  const xdg = stateWithCache({ current: { days: { '2020-01-01': 80 }, total: 80 } });
  const i = baseInput();
  i.session_id = 'current';
  i.cost = { total_cost_usd: 100 };
  const out = await run(i, { XDG_STATE_HOME: xdg, STATUSLINE_MONTHLY_BUDGET: '300' });
  // daily = today bucket(0) + clamped delta(5) = $5.00, NOT 0 + 20 = $20.00
  assert.ok(out.includes('d $5.00'), out);
  assert.ok(!out.includes('d $20.00'), out);
});

test('s chip is NOT clamped — shows full session spend, only d/w/m fold is capped (#44)', async () => {
  const xdg = stateWithCache({ current: { days: { '2020-01-01': 80 }, total: 80 } });
  const i = baseInput();
  i.session_id = 'current';
  i.cost = { total_cost_usd: 100 };
  const out = await run(i, { XDG_STATE_HOME: xdg, STATUSLINE_MONTHLY_BUDGET: '300' });
  assert.ok(out.includes('s $100.00'), out); // 80 + full delta(20); clamp applies only to d/w/m
  assert.ok(out.includes('d $5.00'), out);   // period fold capped at MAX_LIVE_DELTA
});

test('small genuine delta (< clamp) still folds fully (#44)', async () => {
  const xdg = stateWithCache({ current: { days: { [todayKey()]: 1 }, total: 1 } });
  const i = baseInput();
  i.session_id = 'current';
  i.cost = { total_cost_usd: 3 }; // delta 2 < $5 clamp → unaffected
  const out = await run(i, { XDG_STATE_HOME: xdg, STATUSLINE_MONTHLY_BUDGET: '300' });
  assert.ok(out.includes('d $3.00'), out); // today bucket(1) + delta(2)
});

test('budget opt-out (0) → only session chip, no d/w/m', async () => {
  const xdg = stateWithCache({ other: { days: { [todayKey()]: 2 }, total: 2 } });
  const i = baseInput();
  i.session_id = 'current';
  i.cost = { total_cost_usd: 3 };
  const out = await run(i, { XDG_STATE_HOME: xdg, STATUSLINE_MONTHLY_BUDGET: '0' });
  assert.ok(out.includes('$3.00'));
  assert.ok(!out.includes('d $'));
  assert.ok(!out.includes('w $'));
});

// --- STATUSLINE_COST_MULTIPLIER: scales the displayed figures, not the recompute ---
test('cost multiplier scales s and d/w/m chips', async () => {
  const xdg = stateWithCache({ other: { days: { [todayKey()]: 2 }, total: 2 } });
  const i = baseInput();
  i.session_id = 'current';
  i.cost = { total_cost_usd: 3 };
  const base = await run(i, { XDG_STATE_HOME: xdg, STATUSLINE_MONTHLY_BUDGET: '300' });
  assert.ok(base.includes('s $3.00') && base.includes('d $5.00'), 'baseline');
  const cal = await run(i, { XDG_STATE_HOME: xdg, STATUSLINE_MONTHLY_BUDGET: '300', STATUSLINE_COST_MULTIPLIER: '1.15' });
  assert.ok(cal.includes('s $3.45'), 's scaled: 3 × 1.15');
  assert.ok(cal.includes('d $5.75'), 'd scaled: 5 × 1.15');
});

test('cost multiplier of 1 (and garbage) leaves output byte-identical', async () => {
  const xdg = stateWithCache({ other: { days: { [todayKey()]: 2 }, total: 2 } });
  const i = baseInput();
  i.session_id = 'current';
  i.cost = { total_cost_usd: 3 };
  const base = await run(i, { XDG_STATE_HOME: xdg, STATUSLINE_MONTHLY_BUDGET: '300' });
  for (const v of ['1', '0', 'abc']) {
    assert.equal(await run(i, { XDG_STATE_HOME: xdg, STATUSLINE_MONTHLY_BUDGET: '300', STATUSLINE_COST_MULTIPLIER: v }), base, `mult=${v}`);
  }
});

test('cost multiplier drives the budget colour, not just the number', async () => {
  // month $250 of a $300 budget = 83% (under the 90% red line); ×1.15 → $287.50 = 96% → red.
  const xdg = stateWithCache({ other: { days: { [todayKey()]: 250 }, total: 250 } });
  const i = baseInput();
  i.session_id = 'current';
  i.cost = { total_cost_usd: 0 };
  const raw = await runRaw(i, { XDG_STATE_HOME: xdg, STATUSLINE_MONTHLY_BUDGET: '300' });
  const cal = await runRaw(i, { XDG_STATE_HOME: xdg, STATUSLINE_MONTHLY_BUDGET: '300', STATUSLINE_COST_MULTIPLIER: '1.15' });
  assert.ok(raw.includes('m $250.00') && cal.includes('m $287.50'), 'amounts scaled');
  const c1 = colorOf(raw, 'm $250.00'), c2 = colorOf(cal, 'm $287.50');
  assert.ok(c1 && c2, 'both chips carry a colour');
  assert.notEqual(c1, c2, 'colour tier moves with the calibrated value');
});

// The colour code opening the run that contains `label`: the last SGR escape
// before it in the raw (un-stripped) output.
function colorOf(out, label) {
  const at = out.indexOf(label);
  if (at < 0) return null;
  const before = out.slice(0, at);
  const last = before.lastIndexOf('\x1b[');
  if (last < 0) return null;
  const m = before.slice(last).match(/^\x1b\[([0-9;]+)m/);
  return m && m[1];
}
