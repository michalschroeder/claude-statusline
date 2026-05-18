'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { run, baseInput } = require('./helpers');

function inp() {
  const i = baseInput();
  i.effort = { level: 'high' };
  i.cost = { total_duration_ms: 45000, total_lines_added: 3, total_lines_removed: 1 };
  i.context_window = { remaining_percentage: 10, total_input_tokens: 1234, total_output_tokens: 567 };
  i.rate_limits = { five_hour: { used_percentage: 50 }, seven_day: { used_percentage: 20 } };
  return i;
}

test('nerd mode keeps Nerd Font glyphs', async () => {
  const out = await run(inp(), { STATUSLINE_ICONS: 'nerd' });
  assert.ok(out.includes('󰾅'));      // effort
  assert.ok(out.includes('󰉋'));      // dir
  assert.ok(out.includes('󰷈'));      // lines
  assert.ok(out.includes('󰔚 5h'));   // rate5h
  assert.ok(out.includes('󰃭 7d'));   // rate7d
  assert.ok(out.includes('•'));      // separator
});

test('unicode mode swaps Nerd glyphs for BMP fallbacks', async () => {
  const out = await run(inp(), { STATUSLINE_ICONS: 'unicode' });
  assert.ok(!out.includes('󰾅'));
  assert.ok(!out.includes('󰉋'));
  assert.ok(!out.includes('󰷈'));
  assert.ok(out.includes('⚡'));      // effort
  assert.ok(out.includes('▸'));      // dir
  assert.ok(out.includes('Δ'));      // lines
  assert.ok(out.includes('⏱'));      // duration retained (BMP)
});

test('ascii mode uses pure ASCII', async () => {
  const out = await run(inp(), { STATUSLINE_ICONS: 'ascii' });
  // No Nerd Font glyphs
  assert.ok(!out.includes('󰾅'));
  assert.ok(!out.includes('󰉋'));
  assert.ok(!out.includes('󰷈'));
  // No emoji / BMP icons
  assert.ok(!out.includes('⚡'));
  assert.ok(!out.includes('⏱'));
  assert.ok(!out.includes('▸'));
  // ASCII labels present
  assert.ok(out.includes('dir:'));
  assert.ok(out.includes('t: 45s'));
  assert.ok(out.includes('|'));      // ascii separator
  // Whole string should be ASCII-safe
  assert.ok(/^[\x00-\x7F\s]+$/.test(out), `non-ASCII char in ascii mode: ${JSON.stringify(out)}`);
});

test('invalid STATUSLINE_ICONS falls through to cache/default', async () => {
  // Should not crash — falls to cached or first-run ascii.
  const out = await run(baseInput(), { STATUSLINE_ICONS: 'bogus' });
  assert.ok(out.length > 0);
});
