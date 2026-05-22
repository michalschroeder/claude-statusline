'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { baseInput, run, runRaw, stripAnsi } = require('./helpers.js');

function inp(usage) {
  const i = baseInput();
  i.context_window = { current_usage: usage };
  return i;
}

test('cache omitted when current_usage missing', async () => {
  const out = await run(baseInput());
  assert.ok(!out.includes('󰆼'));
});

test('cache omitted when current_usage is null', async () => {
  const i = baseInput();
  i.context_window = { current_usage: null };
  const out = await run(i);
  assert.ok(!out.includes('󰆼'));
});

test('cache omitted when all three input components are 0', async () => {
  const out = await run(inp({
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 500,
  }));
  assert.ok(!out.includes('󰆼'));
});

function extractBar(stripped) {
  const m = stripped.match(/\[([^\]]+)\]/);
  return m ? m[1] : '';
}

test('bar cells sum to exactly 10 — even thirds', async () => {
  const out = await run(inp({
    input_tokens: 100,
    cache_creation_input_tokens: 100,
    cache_read_input_tokens: 100,
  }));
  const bar = extractBar(out);
  assert.equal([...bar].length, 10);
});

test('bar cells sum to exactly 10 — all read', async () => {
  const out = await run(inp({
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 1000,
  }));
  const bar = extractBar(out);
  assert.equal([...bar].length, 10);
  // All filled with read glyph '▓'
  assert.ok([...bar].every((c) => c === '▓'));
});

test('bar cells sum to exactly 10 — skewed', async () => {
  const out = await run(inp({
    input_tokens: 50,
    cache_creation_input_tokens: 25,
    cache_read_input_tokens: 925,
  }));
  const bar = extractBar(out);
  assert.equal([...bar].length, 10);
});

test('hit rate matches formula — 88%', async () => {
  const out = await run(inp({
    input_tokens: 12,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 88,
  }));
  assert.ok(out.includes('88%'));
});

test('hit rate matches formula — 0%', async () => {
  const out = await run(inp({
    input_tokens: 1000,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  }));
  assert.ok(out.includes('0%'));
});

test('hit rate ≥80 — green', async () => {
  const raw = await runRaw(inp({
    input_tokens: 10,
    cache_creation_input_tokens: 10,
    cache_read_input_tokens: 80,
  }));
  assert.ok(stripAnsi(raw).includes('80%'));
  assert.ok(raw.includes('\x1b[32m'));
});

test('hit rate ≥50 and <80 — yellow', async () => {
  const raw = await runRaw(inp({
    input_tokens: 30,
    cache_creation_input_tokens: 20,
    cache_read_input_tokens: 50,
  }));
  assert.ok(stripAnsi(raw).includes('50%'));
  assert.ok(raw.includes('\x1b[33m'));
});

test('hit rate <50 — orange', async () => {
  const raw = await runRaw(inp({
    input_tokens: 60,
    cache_creation_input_tokens: 10,
    cache_read_input_tokens: 30,
  }));
  assert.ok(stripAnsi(raw).includes('30%'));
  assert.ok(raw.includes('\x1b[38;5;208m'));
});

test('cache segment respects STATUSLINE_SEGMENTS filter', async () => {
  const i = inp({
    input_tokens: 10,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 90,
  });
  const only = await run(i, { STATUSLINE_SEGMENTS: 'cache' });
  assert.ok(only.includes('90%'));
  assert.ok(only.includes('󰆼'));
  const excluded = await run(i, { STATUSLINE_SEGMENTS: 'model' });
  assert.ok(!excluded.includes('󰆼'));
});
