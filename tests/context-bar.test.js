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
