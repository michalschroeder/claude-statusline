'use strict';
// In-process tests for the extracted render(data, env) function (#42). These
// exercise segment logic without spawning a process — the spawn-based tests in
// the other files still cover the stdin→stdout wiring end-to-end.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { stripAnsi, baseInput, ISOLATED_STATE } = require('./helpers.js');
const { render } = require('../hooks/statusline.js');

// Env mirroring the spawn helpers: isolated state, offline pricing, nerd icons.
const ENV = { XDG_STATE_HOME: ISOLATED_STATE, STATUSLINE_PRICING_NO_FETCH: '1', STATUSLINE_ICONS: 'nerd' };
const plain = (data, env) => stripAnsi(render(data, { ...ENV, ...env }));

test('render: returns a string and includes the model name', () => {
  const out = plain(baseInput());
  assert.equal(typeof out, 'string');
  assert.match(out, /Claude/);
});

test('render: throws on bad input (the shell swallows this, not render)', () => {
  assert.throws(() => render(null, ENV));
});

test('render: STATUSLINE_SEGMENTS allowlist filters and orders segments', () => {
  const data = { ...baseInput(), effort: { level: 'high' } };
  // Only the effort segment, nothing else (model excluded).
  const out = plain(data, { STATUSLINE_SEGMENTS: 'effort' });
  const firstLine = out.split('\n')[0];
  assert.match(firstLine, /high/);
  assert.doesNotMatch(firstLine, /Claude/);
});

test('render: env is read from the passed env, not process.env', () => {
  // Budget opt-out (0) hides the d/w/m chips — proves env injection works.
  const data = { ...baseInput(), cost: { total_cost_usd: 2 } };
  // Budget opt-out drops the 's ' prefix and hides d/w/m entirely.
  const out = plain(data, { STATUSLINE_MONTHLY_BUDGET: '0' });
  assert.match(out, /\$2\.00/);
  assert.doesNotMatch(out, /\bd \$/);
  assert.doesNotMatch(out, /\bw \$/);
});
