'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { baseInput, run } = require('./helpers.js');

function inp(tokens) {
  const i = baseInput();
  i.context_window = { total_input_tokens: tokens, used_percentage: 10 };
  return i;
}

// Pattern: bar+percent followed by ` · <compact>` token suffix.
const SUFFIX_RE = /10%\s·\s\S+/;

test('tokens null — no token suffix on context bar', async () => {
  const i = baseInput();
  i.context_window = { used_percentage: 10 };
  const out = await run(i);
  assert.ok(out.includes('10%'));
  assert.doesNotMatch(out, SUFFIX_RE);
});

test('tokens 0 — no token suffix on context bar', async () => {
  const out = await run(inp(0));
  assert.ok(out.includes('10%'));
  assert.doesNotMatch(out, SUFFIX_RE);
});

test('tokens 523 → 523', async () => {
  assert.ok((await run(inp(523))).includes('523'));
});

test('tokens 999 → 999', async () => {
  assert.ok((await run(inp(999))).includes('999'));
});

test('tokens 1000 → 1k', async () => {
  assert.ok((await run(inp(1000))).includes('1k'));
});

test('tokens 9999 → 10k', async () => {
  assert.ok((await run(inp(9999))).includes('10k'));
});

test('tokens 10000 → 10k', async () => {
  assert.ok((await run(inp(10000))).includes('10k'));
});

test('tokens 999999 → 1000k', async () => {
  assert.ok((await run(inp(999999))).includes('1000k'));
});

test('tokens 1000000 → 1M', async () => {
  assert.ok((await run(inp(1000000))).includes('1M'));
});
