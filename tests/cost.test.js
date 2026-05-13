'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { baseInput, run, runRaw } = require('./helpers.js');

function inp(cost) {
  const i = baseInput();
  i.cost = { total_cost_usd: cost };
  return i;
}

test('cost zero — no dollar sign', async () => {
  const out = await run(inp(0));
  assert.ok(!out.includes('$'));
});

test('cost 0.50 — green', async () => {
  const [plain, raw] = await Promise.all([run(inp(0.50)), runRaw(inp(0.50))]);
  assert.ok(plain.includes('$0.50'));
  assert.ok(raw.includes('\x1b[32m'));
});

test('cost 0.99 — green', async () => {
  const [plain, raw] = await Promise.all([run(inp(0.99)), runRaw(inp(0.99))]);
  assert.ok(plain.includes('$0.99'));
  assert.ok(raw.includes('\x1b[32m'));
});

test('cost 1.00 — yellow', async () => {
  const [plain, raw] = await Promise.all([run(inp(1.00)), runRaw(inp(1.00))]);
  assert.ok(plain.includes('$1.00'));
  assert.ok(raw.includes('\x1b[33m'));
});

test('cost 4.99 — yellow', async () => {
  const [plain, raw] = await Promise.all([run(inp(4.99)), runRaw(inp(4.99))]);
  assert.ok(plain.includes('$4.99'));
  assert.ok(raw.includes('\x1b[33m'));
});

test('cost 5.00 — orange', async () => {
  const [plain, raw] = await Promise.all([run(inp(5.00)), runRaw(inp(5.00))]);
  assert.ok(plain.includes('$5.00'));
  assert.ok(raw.includes('\x1b[38;5;208m'));
});

test('cost 9.99 — orange', async () => {
  const [plain, raw] = await Promise.all([run(inp(9.99)), runRaw(inp(9.99))]);
  assert.ok(plain.includes('$9.99'));
  assert.ok(raw.includes('\x1b[38;5;208m'));
});

test('cost 10.00 — red', async () => {
  const [plain, raw] = await Promise.all([run(inp(10.00)), runRaw(inp(10.00))]);
  assert.ok(plain.includes('$10.00'));
  assert.ok(raw.includes('\x1b[31m'));
});

test('cost 25.00 — red', async () => {
  const [plain, raw] = await Promise.all([run(inp(25.00)), runRaw(inp(25.00))]);
  assert.ok(plain.includes('$25.00'));
  assert.ok(raw.includes('\x1b[31m'));
});
