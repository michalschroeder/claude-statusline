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

test('cost 0.99 — green', async () => {
  const { plain, raw } = await rawAndPlain(0.99);
  assert.ok(plain.includes('s $0.99'));
  assert.ok(raw.includes('\x1b[32m'));
});

test('cost 1.00 — yellow', async () => {
  const { plain, raw } = await rawAndPlain(1.00);
  assert.ok(plain.includes('s $1.00'));
  assert.ok(raw.includes('\x1b[33m'));
});

test('cost 4.99 — yellow', async () => {
  const { plain, raw } = await rawAndPlain(4.99);
  assert.ok(plain.includes('s $4.99'));
  assert.ok(raw.includes('\x1b[33m'));
});

test('cost 5.00 — orange', async () => {
  const { plain, raw } = await rawAndPlain(5.00);
  assert.ok(plain.includes('s $5.00'));
  assert.ok(raw.includes('\x1b[38;5;208m'));
});

test('cost 9.99 — orange', async () => {
  const { plain, raw } = await rawAndPlain(9.99);
  assert.ok(plain.includes('s $9.99'));
  assert.ok(raw.includes('\x1b[38;5;208m'));
});

test('cost 10.00 — red', async () => {
  const { plain, raw } = await rawAndPlain(10.00);
  assert.ok(plain.includes('s $10.00'));
  assert.ok(raw.includes('\x1b[31m'));
});

test('cost 25.00 — red', async () => {
  const { plain, raw } = await rawAndPlain(25.00);
  assert.ok(plain.includes('s $25.00'));
  assert.ok(raw.includes('\x1b[31m'));
});
