'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { baseInput, run } = require('./helpers.js');

function inp(tokens) {
  const i = baseInput();
  i.context_window = { total_input_tokens: tokens };
  return i;
}

test('tokens null — absent', async () => {
  const out = await run(baseInput());
  assert.ok(!out.includes('󰁝'));
});

test('tokens 0 — absent', async () => {
  const out = await run(inp(0));
  assert.ok(!out.includes('󰁝'));
});

test('tokens 523 → 523󰁝', async () => {
  assert.ok((await run(inp(523))).includes('523󰁝'));
});

test('tokens 999 → 999󰁝', async () => {
  assert.ok((await run(inp(999))).includes('999󰁝'));
});

test('tokens 1000 → 1k󰁝', async () => {
  assert.ok((await run(inp(1000))).includes('1k󰁝'));
});

test('tokens 9999 → 10k󰁝', async () => {
  assert.ok((await run(inp(9999))).includes('10k󰁝'));
});

test('tokens 10000 → 10k󰁝', async () => {
  assert.ok((await run(inp(10000))).includes('10k󰁝'));
});

test('tokens 999999 → 1000k󰁝', async () => {
  assert.ok((await run(inp(999999))).includes('1000k󰁝'));
});

test('tokens 1000000 → 1M󰁝', async () => {
  assert.ok((await run(inp(1000000))).includes('1M󰁝'));
});
