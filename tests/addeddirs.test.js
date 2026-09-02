'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { run, baseInput } = require('./helpers');

test('addeddirs: single dir shows basename', async () => {
  const input = baseInput();
  input.workspace.added_dirs = ['/home/ms/other-project'];
  const out = await run(input);
  assert.match(out, /\+dir other-project/);
});

test('addeddirs: multiple dirs show count', async () => {
  const input = baseInput();
  input.workspace.added_dirs = ['/a', '/b', '/c'];
  const out = await run(input);
  assert.match(out, /\+3dir/);
});

test('addeddirs: absent when no added dirs', async () => {
  const input = baseInput();
  const out = await run(input);
  assert.doesNotMatch(out, /dir/);
});
