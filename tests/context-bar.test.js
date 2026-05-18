'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { baseInput, runRaw, stripAnsi } = require('./helpers.js');

function inp(remaining) {
  const i = baseInput();
  i.context_window = { remaining_percentage: remaining };
  return i;
}

test('context null — no bar', async () => {
  assert.ok(!stripAnsi(await runRaw(baseInput())).includes('█'));
});

test('context 80% remaining (20% used) — green, no skull', async () => {
  const raw = await runRaw(inp(80));
  const plain = stripAnsi(raw);
  assert.ok(plain.includes('20%'));
  assert.ok(!plain.includes('󱓇'));
  assert.ok(raw.includes('\x1b[32m'));
});

test('context 51% remaining (49% used) — green', async () => {
  const raw = await runRaw(inp(51));
  assert.ok(raw.includes('\x1b[32m'));
});

test('context 50% remaining (50% used) — yellow', async () => {
  const raw = await runRaw(inp(50));
  assert.ok(raw.includes('\x1b[33m'));
});

test('context 36% remaining (64% used) — yellow', async () => {
  const raw = await runRaw(inp(36));
  assert.ok(raw.includes('\x1b[33m'));
});

test('context 35% remaining (65% used) — orange', async () => {
  const raw = await runRaw(inp(35));
  assert.ok(raw.includes('\x1b[38;5;208m'));
});

test('context 21% remaining (79% used) — orange', async () => {
  const raw = await runRaw(inp(21));
  assert.ok(raw.includes('\x1b[38;5;208m'));
});

test('context 20% remaining (80% used) — blink red + skull', async () => {
  const raw = await runRaw(inp(20));
  assert.ok(stripAnsi(raw).includes('󰚌'));
  assert.ok(raw.includes('\x1b[5;31m'));
});

test('context 0% remaining (100% used) — blink red + skull', async () => {
  const raw = await runRaw(inp(0));
  assert.ok(stripAnsi(raw).includes('󰚌'));
  assert.ok(raw.includes('\x1b[5;31m'));
});
