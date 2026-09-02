'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { run, baseInput } = require('./helpers');

test('added dirs: single dir folds into the dir chip as "main + added"', async () => {
  const input = baseInput();
  input.workspace.added_dirs = ['/home/ms/other-project'];
  const out = await run(input);
  assert.match(out, /tmp \+ other-project/);
});

test('added dirs: multiple dirs fold in as a count suffix', async () => {
  const input = baseInput();
  input.workspace.added_dirs = ['/a', '/b', '/c'];
  const out = await run(input);
  assert.match(out, /tmp \+3dir/);
});

test('added dirs: no suffix when there are none', async () => {
  const input = baseInput();
  const out = await run(input);
  assert.doesNotMatch(out, /\+/);
});
