'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { run, baseInput } = require('./helpers');

// A rich input that exercises many segments at once (long combined line).
function richInput() {
  return {
    model: { display_name: 'Claude' },
    workspace: { current_dir: '/tmp', project_dir: '/tmp' },
    effort: { level: 'medium' },
    cost: {
      total_cost_usd: 3.51,
      total_duration_ms: 1_260_000,
      total_lines_added: 87,
      total_lines_removed: 61,
    },
    rate_limits: { five_hour: { used_percentage: 42 }, seven_day: { used_percentage: 18 } },
    context_window: { total_input_tokens: 220_000, used_percentage: 22 },
  };
}

test('default (no STATUSLINE_SEGMENTS): wide terminal stays single-line', async () => {
  const out = await run(richInput(), { COLUMNS: '400' });
  const lines = out.trim().split('\n');
  // First line is the rendered segments; second is the trailing rule.
  assert.match(lines[0], /Claude/);
  assert.match(lines[0], /\$3\.51/);
  assert.match(lines[0], /22%/);
});

test('default: narrow terminal wraps onto multiple lines at segment boundaries', async () => {
  const out = await run(richInput(), { COLUMNS: '40' });
  const lines = out.trim().split('\n');
  // more than just [segments-line, rule] — wrapped onto several lines
  assert.ok(lines.length > 2, `expected wrapped output, got: ${JSON.stringify(out)}`);
  for (const line of lines.slice(0, -1)) {
    assert.ok(line.replace(/\x1b\[[0-9;]*m/g, '').length <= 40 + 10, `line exceeds width: ${line}`);
  }
});

test('sparse session (few segments) stays single-line even at default fallback width', async () => {
  const input = baseInput();
  input.cost = { total_cost_usd: 0.1 };
  const out = await run(input, {}); // no COLUMNS -> falls back to 80
  const lines = out.trim().split('\n');
  assert.match(lines[0], /Claude/);
  assert.match(lines[0], /\$0\.10/);
});

test('explicit `;` groups still force a fixed multi-line layout regardless of width', async () => {
  const out = await run(richInput(), { COLUMNS: '400', STATUSLINE_SEGMENTS: 'model;cost' });
  const lines = out.trim().split('\n');
  assert.match(lines[0], /Claude/);
  assert.doesNotMatch(lines[0], /\$3\.51/);
  assert.match(lines[1], /\$3\.51/);
});
