'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { baseInput, run } = require('./helpers.js');

function inp(ms) {
  const i = baseInput();
  i.cost = { total_duration_ms: ms };
  return i;
}

test('duration null — absent', async () => {
  assert.ok(!(await run(baseInput())).includes('⏱'));
});

test('duration 0 — absent', async () => {
  assert.ok(!(await run(inp(0))).includes('⏱'));
});

test('duration 45000 → ⏱ 45s', async () => {
  assert.ok((await run(inp(45000))).includes('⏱ 45s'));
});

test('duration 59000 → ⏱ 59s', async () => {
  assert.ok((await run(inp(59000))).includes('⏱ 59s'));
});

test('duration 60000 → ⏱ 1m', async () => {
  assert.ok((await run(inp(60000))).includes('⏱ 1m'));
});

test('duration 3600000 → ⏱ 1h', async () => {
  assert.ok((await run(inp(3600000))).includes('⏱ 1h'));
});

test('duration 3900000 → ⏱ 1h 5m', async () => {
  assert.ok((await run(inp(3900000))).includes('⏱ 1h 5m'));
});
