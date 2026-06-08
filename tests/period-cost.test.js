'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { baseInput, run } = require('./helpers.js');

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
