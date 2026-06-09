'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { render, money, compactTokens, duration } = require('../render-report');

const TEMPLATE = fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'report-template.html'), 'utf8');

// A detail payload shaped like `analyze.js <prefix>` output, with a deliberately
// hostile prompt to prove HTML-escaping.
const detail = {
  session: 'abcdef12-3456-7890-aaaa-bbbbbbbbbbbb',
  title: 'Why <was> this "costly" & slow?',
  startedAt: '2026-06-01T00:00:00.000Z',
  totalCost: 4.5287,
  steps: 39,
  components: { input: 0.072, output: 1.576, cacheWrite: 1.763, cacheRead: 2.321, web: 0 },
  byModel: [{ model: 'claude-opus-4-8', cost: 4.5287, calls: 39 }],
  byAgent: [
    { name: 'main', label: 'main session', cost: 4.5287 },
    { name: 'agent-1', label: 'Implement <script>alert(1)</script> the parser', cost: 0.51 },
  ],
  turns: [
    { prompt: 'short late prompt', kind: 'user', cost: 1.69, peakContext: 140279 },
    { prompt: 'a cheaper earlier one', kind: 'skill', cost: 0.10, peakContext: 17068 },
  ],
  summary: {
    durationMs: 3 * 3600 * 1000 + 25 * 60 * 1000,
    contextGrowth: { firstCall: 17068, quartileAvgContext: [58049, 90462, 107795, 127179], peakContext: 140279 },
    highContextCost: { thresholdTokens: 200000, calls: 4, cost: 0.88 },
    contextResets: 2,
  },
};

test('render: all template slots are filled (no {{...}} left)', () => {
  const html = render(detail, TEMPLATE);
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(html), 'unfilled slot remains');
});

test('render: scalar cards carry the formatted values', () => {
  const html = render(detail, TEMPLATE);
  assert.match(html, /\$4\.53/);            // total cost
  assert.match(html, />39</);               // steps
  assert.match(html, /3h 25m/);             // duration
  assert.match(html, /140k/);               // peak context
  assert.match(html, /\$0\.88/);            // high-context cost
  assert.match(html, /4 calls · 2 resets/); // high-ctx calls + resets
});

test('render: rows are built from the arrays', () => {
  const html = render(detail, TEMPLATE);
  assert.match(html, /cache read/);                 // components row
  assert.match(html, /claude-opus-4-8/);            // by-model row
  assert.match(html, /short late prompt/);          // top-turns row
});

test('render: all user-derived text is HTML-escaped (no injection)', () => {
  const html = render(detail, TEMPLATE);
  assert.ok(!html.includes('<script>alert(1)</script>'), 'raw script tag leaked');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /Why &lt;was&gt; this &quot;costly&quot; &amp; slow\?/); // escaped title
});

test('render: empty subagents → placeholder, not a blank table', () => {
  const noSubs = { ...detail, byAgent: [{ name: 'main', label: 'main session', cost: 1 }] };
  const html = render(noSubs, TEMPLATE);
  assert.match(html, /no subagents/);
});

test('formatting helpers', () => {
  assert.strictEqual(money(4.5287), '$4.53');
  assert.strictEqual(money(0.0021), '$0.0021'); // sub-cent stays informative
  assert.strictEqual(money(0), '$0.00');
  assert.strictEqual(compactTokens(140279), '140k');
  assert.strictEqual(compactTokens(950), '950');
  assert.strictEqual(duration(3 * 3600 * 1000 + 25 * 60 * 1000), '3h 25m');
  assert.strictEqual(duration(90 * 1000), '2m');
  assert.strictEqual(duration(5 * 1000), '5s');
});
