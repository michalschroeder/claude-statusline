'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { baseInput, runRaw, stripAnsi } = require('./helpers.js');

function inp(remaining) {
  const i = baseInput();
  i.context_window = { remaining_percentage: remaining };
  return i;
}

function inpUsed(used) {
  const i = baseInput();
  i.context_window = { used_percentage: used };
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

// Direct used_percentage path (primary field — preferred over remaining_percentage fallback).
test('used_percentage 20 — green, no skull', async () => {
  const raw = await runRaw(inpUsed(20));
  const plain = stripAnsi(raw);
  assert.ok(plain.includes('20%'));
  assert.ok(!plain.includes('󰚌'));
  assert.ok(raw.includes('\x1b[32m'));
});

test('used_percentage 49 — green', async () => {
  assert.ok((await runRaw(inpUsed(49))).includes('\x1b[32m'));
});

test('used_percentage 50 — yellow', async () => {
  assert.ok((await runRaw(inpUsed(50))).includes('\x1b[33m'));
});

test('used_percentage 64 — yellow', async () => {
  assert.ok((await runRaw(inpUsed(64))).includes('\x1b[33m'));
});

test('used_percentage 65 — orange', async () => {
  assert.ok((await runRaw(inpUsed(65))).includes('\x1b[38;5;208m'));
});

test('used_percentage 79 — orange', async () => {
  assert.ok((await runRaw(inpUsed(79))).includes('\x1b[38;5;208m'));
});

test('used_percentage 80 — blink red + skull', async () => {
  const raw = await runRaw(inpUsed(80));
  assert.ok(stripAnsi(raw).includes('󰚌'));
  assert.ok(raw.includes('\x1b[5;31m'));
});

test('used_percentage 0 — green, 0% bar', async () => {
  const raw = await runRaw(inpUsed(0));
  assert.ok(stripAnsi(raw).includes('0%'));
  assert.ok(raw.includes('\x1b[32m'));
});

test('used_percentage takes priority over remaining_percentage', async () => {
  const i = baseInput();
  i.context_window = { used_percentage: 90, remaining_percentage: 90 };
  const raw = await runRaw(i);
  // used_percentage:90 → blink-red zone; remaining_percentage:90 alone would be 10% used → green.
  assert.ok(raw.includes('\x1b[5;31m'));
  assert.ok(stripAnsi(raw).includes('90%'));
});

// 1M-context tier — absolute-token thresholds (200k/300k/400k/500k).
// Detection: total = total_input_tokens / (used_percentage/100); >500k → 1M tier.
function inp1M(tokens) {
  const i = baseInput();
  i.context_window = { used_percentage: tokens / 10_000, total_input_tokens: tokens };
  return i;
}

test('1M tier: 100k tokens (10%) — green', async () => {
  const raw = await runRaw(inp1M(100_000));
  assert.ok(raw.includes('\x1b[32m'));
  assert.ok(!stripAnsi(raw).includes('󰚌'));
});

test('1M tier: 199k tokens — green', async () => {
  assert.ok((await runRaw(inp1M(199_000))).includes('\x1b[32m'));
});

test('1M tier: 200k tokens — yellow', async () => {
  assert.ok((await runRaw(inp1M(200_000))).includes('\x1b[33m'));
});

test('1M tier: 299k tokens — yellow', async () => {
  assert.ok((await runRaw(inp1M(299_000))).includes('\x1b[33m'));
});

test('1M tier: 300k tokens — orange', async () => {
  assert.ok((await runRaw(inp1M(300_000))).includes('\x1b[38;5;208m'));
});

test('1M tier: 399k tokens — orange', async () => {
  assert.ok((await runRaw(inp1M(399_000))).includes('\x1b[38;5;208m'));
});

test('1M tier: 400k tokens — red (no blink, no skull)', async () => {
  const raw = await runRaw(inp1M(400_000));
  assert.ok(raw.includes('\x1b[31m'));
  assert.ok(!raw.includes('\x1b[5;31m'));
  assert.ok(!stripAnsi(raw).includes('󰚌'));
});

test('1M tier: 499k tokens — red', async () => {
  const raw = await runRaw(inp1M(499_000));
  assert.ok(raw.includes('\x1b[31m'));
  assert.ok(!raw.includes('\x1b[5;31m'));
});

test('1M tier: 500k tokens — blink red + skull', async () => {
  const raw = await runRaw(inp1M(500_000));
  assert.ok(raw.includes('\x1b[5;31m'));
  assert.ok(stripAnsi(raw).includes('󰚌'));
});

test('1M tier: 900k tokens — blink red + skull', async () => {
  const raw = await runRaw(inp1M(900_000));
  assert.ok(raw.includes('\x1b[5;31m'));
  assert.ok(stripAnsi(raw).includes('󰚌'));
});

// 200k model with input tokens: stays on percentage tiers.
test('200k model with input tokens: 50% (100k of 200k) — yellow (percentage tier)', async () => {
  const i = baseInput();
  i.context_window = { used_percentage: 50, total_input_tokens: 100_000 };
  // total inferred = 200k → standard tier → 50% = yellow.
  assert.ok((await runRaw(i)).includes('\x1b[33m'));
});
