'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { baseInput, runRaw, stripAnsi } = require('./helpers.js');

// Isolate state for parity with the other suites; the cost chip is the live
// session's own spend ($X.XX) with absolute-USD color thresholds.
const EMPTY_STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-cost-only-'));
after(() => fs.rmSync(EMPTY_STATE, { recursive: true, force: true }));

function inp(cost) {
  const i = baseInput();
  i.cost = { total_cost_usd: cost };
  return i;
}

async function rawAndPlain(cost) {
  const raw = await runRaw(inp(cost), { XDG_STATE_HOME: EMPTY_STATE });
  return { raw, plain: stripAnsi(raw) };
}

test('cost zero — no dollar sign', async () => {
  const { plain } = await rawAndPlain(0);
  assert.ok(!plain.includes('$'));
});

test('cost 0.50 — green', async () => {
  const { plain, raw } = await rawAndPlain(0.50);
  assert.ok(plain.includes('s $0.50'));
  assert.ok(raw.includes('\x1b[32m'));
});

test('cost 4.99 — green', async () => {
  const { plain, raw } = await rawAndPlain(4.99);
  assert.ok(plain.includes('s $4.99'));
  assert.ok(raw.includes('\x1b[32m'));
});

test('cost 5.00 — yellow', async () => {
  const { plain, raw } = await rawAndPlain(5.00);
  assert.ok(plain.includes('s $5.00'));
  assert.ok(raw.includes('\x1b[33m'));
});

test('cost 9.99 — yellow', async () => {
  const { plain, raw } = await rawAndPlain(9.99);
  assert.ok(plain.includes('s $9.99'));
  assert.ok(raw.includes('\x1b[33m'));
});

test('cost 10.00 — orange', async () => {
  const { plain, raw } = await rawAndPlain(10.00);
  assert.ok(plain.includes('s $10.00'));
  assert.ok(raw.includes('\x1b[38;5;208m'));
});

test('cost 19.99 — orange', async () => {
  const { plain, raw } = await rawAndPlain(19.99);
  assert.ok(plain.includes('s $19.99'));
  assert.ok(raw.includes('\x1b[38;5;208m'));
});

test('cost 20.00 — red', async () => {
  const { plain, raw } = await rawAndPlain(20.00);
  assert.ok(plain.includes('s $20.00'));
  assert.ok(raw.includes('\x1b[31m'));
});

test('cost 50.00 — red', async () => {
  const { plain, raw } = await rawAndPlain(50.00);
  assert.ok(plain.includes('s $50.00'));
  assert.ok(raw.includes('\x1b[31m'));
});

// Burn rate ($/h) — appended only once the session has run ≥60s.
function inpDur(cost, durationMs) {
  const i = inp(cost);
  i.cost.total_duration_ms = durationMs;
  return i;
}

test('burn rate shown after 60s: $6 over 30m → $12.00/h', async () => {
  const raw = await runRaw(inpDur(6, 30 * 60 * 1000), { XDG_STATE_HOME: EMPTY_STATE });
  assert.ok(stripAnsi(raw).includes('s $6.00 $12.00/h'));
});

test('burn rate rounds to integer at ≥$100/h', async () => {
  // $10 in 60s = $600/h
  const raw = await runRaw(inpDur(10, 60 * 1000), { XDG_STATE_HOME: EMPTY_STATE });
  assert.ok(stripAnsi(raw).includes('$600/h'));
});

test('burn rate hidden under 60s', async () => {
  const raw = await runRaw(inpDur(1, 30 * 1000), { XDG_STATE_HOME: EMPTY_STATE });
  assert.ok(!stripAnsi(raw).includes('/h'));
});

test('burn rate hidden when duration absent', async () => {
  const { plain } = await rawAndPlain(1);
  assert.ok(!plain.includes('/h'));
});
