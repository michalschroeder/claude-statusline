'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { baseInput, run } = require('./helpers');

test('agent segment renders with icon and name when agent.name set', async () => {
  const input = baseInput();
  input.agent = { name: 'explorer' };
  const out = await run(input);
  assert.match(out, /󰚩 explorer/);
});

test('no agent segment when agent.name absent', async () => {
  const out = await run(baseInput());
  assert.doesNotMatch(out, /󰚩/);
});
