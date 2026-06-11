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
    { turnIndex: 2, prompt: 'short late prompt', kind: 'user', cost: 1.69, peakContext: 140279 },
    { turnIndex: 1, prompt: 'a cheaper earlier one', kind: 'skill', cost: 0.10, peakContext: 17068 },
  ],
  calls: [
    { seq: 1, agent: 'main', isMain: true, cost: 0.02, prompt: 'a cheaper earlier one', turnIndex: 1,
      tokens: { input: 200, cacheRead: 17068, cacheWrite: 5000, output: 300 } },
    { seq: 2, agent: 'agent-1', isMain: false, cost: 0.01, prompt: null, turnIndex: null,
      tokens: { input: 100, cacheRead: 5000, cacheWrite: 0, output: 50 } },
    { seq: 3, agent: 'main', isMain: true, cost: 0.40, prompt: 'short late prompt', turnIndex: 2,
      tokens: { input: 0, cacheRead: 140279, cacheWrite: 2000, output: 900 } },
    { seq: 4, agent: 'main', isMain: true, cost: 0.55, prompt: 'evil <img src=x onerror=alert(1)> prompt', turnIndex: 3,
      tokens: { input: 0, cacheRead: 210000, cacheWrite: 0, output: 400 } },
  ],
  summary: {
    durationMs: 3 * 3600 * 1000 + 25 * 60 * 1000,
    mainSteps: 37,
    contextGrowth: { firstCall: 17068, quartileAvgContext: [58049, 90462, 107795, 127179], peakContext: 140279 },
    highContextCost: { thresholdTokens: 200000, calls: 4, cost: 0.88 },
    contextResets: 2,
    contextConsumers: {
      note: 'estTokens ≈ chars/4 — estimates, not billed figures.',
      totalEstTokens: 60000,
      byTool: [
        { tool: 'Read', count: 3, estTokens: 40000, carriedCost: 1.2 },
        { tool: 'Bash', count: 2, estTokens: 20000, carriedCost: 0.4 },
      ],
      top: [
        { tool: 'Read', target: '/repo/src/<huge> & "big".js', count: 2, estTokens: 38000, carriedCost: 1.1 },
        { tool: 'Bash', target: 'git log --stat', count: 1, estTokens: 15000, carriedCost: 0.3 },
      ],
    },
    assistantOutput: {
      note: 'output split by kind',
      byKind: { text: { tokens: 2100, cost: 0.05 }, thinking: { tokens: 149000, cost: 3.43 }, toolCalls: { tokens: 11000, cost: 0.25 } },
      thinking: {
        storedTokens: 12000, unstoredTokens: 137000,
        stepsWithThinking: 148, mainSteps: 155, avgPerThinkingStep: 1007,
        peakStep: { seq: 73, tokens: 6200, nextTools: ['Bash'] },
        topSteps: [
          { seq: 73, tokens: 6200, trigger: { tool: 'Bash', target: 'docker compose run <tests>' }, nextTools: ['Bash'] },
          { seq: 12, tokens: 3100, trigger: { tool: 'user-prompt', target: 'fix the tests' }, nextTools: [] },
        ],
        byTurn: [
          { prompt: 'fix the <failing> tests', kind: 'user', steps: 14, thinkingTokens: 38000 },
          { prompt: 'a cheaper earlier one', kind: 'skill', steps: 9, thinkingTokens: 22000 },
        ],
      },
    },
    bySkill: [
      { skill: 'writing-phpunit-tests', turns: 1, steps: 2, cost: 0.84, tokens: { input: 0, cacheRead: 90000, cacheWrite: 0, output: 4000 } },
    ],
  },
};

test('render: all template slots are filled (no {{...}} left)', () => {
  const html = render(detail, TEMPLATE);
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(html), 'unfilled slot remains');
});

test('render: scalar cards carry the formatted values', () => {
  const html = render(detail, TEMPLATE);
  assert.match(html, /\$4\.53/);            // total cost
  assert.match(html, />37</);               // steps card = summary.mainSteps (main-only, not detail.steps=39)
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

test('render: top-turns — skill column, summary, and styled tooltip only on user rows', () => {
  const d = { ...detail, turns: [
    { turnIndex: 1, kind: 'skill', cost: 3.0, peakContext: 176000,
      prompt: 'Base directory for this skill: /home/u/.claude/skills/write-a-skill # Writing Skills ...' },
    { turnIndex: 2, kind: 'subagent-orchestration', cost: 2.0, peakContext: 239000,
      prompt: '<task-notification> <task-id>bjraq17xi</task-id> <tool-use-id>toolu_x</tool-use-id> done' },
    { turnIndex: 3, kind: 'user', cost: 1.5, peakContext: 104000,
      prompt: 'read log tags, we have some useful tags there like adhoc job or worker — a fairly long message that exceeds the displayed summary so the tooltip adds detail',
      summary: 'Parsed Datadog log tags' },
    { turnIndex: 4, kind: 'user', cost: 1.0, peakContext: 61000,
      prompt: 'do it', summary: 'Applied 6 edits and ran shell validation' },
  ] };
  const html = render(d, TEMPLATE);
  // skill name lands in its own column; the skill row's WHAT cell is blank (no redundancy)
  assert.match(html, /<td>write-a-skill<\/td>/);
  // orchestration → fixed label, no tooltip tagging
  assert.match(html, /class="prompt"[^>]*>↩ subagent results</);
  // a Haiku summary wins in the WHAT cell
  assert.match(html, /Applied 6 edits and ran shell validation/);
  // user rows expose the full message via the styled tooltip (data-full), NOT native title=;
  // skill/orchestration rows do not
  assert.match(html, /class="prompt turn-tip" data-kind="user" data-full="read log tags[^"]*"/);
  assert.ok(!/title="Base directory/.test(html), 'no native title tooltip');
  assert.ok(!/turn-tip[^>]*write-a-skill/.test(html), 'skill row has no tooltip');
  // the original user prompt is preserved even when a summary replaced it in the cell —
  // "do it" stays reachable on hover, not lost
  assert.match(html, /data-full="do it">Applied 6 edits and ran shell validation</);
});

test('render: all user-derived text is HTML-escaped (no injection)', () => {
  const html = render(detail, TEMPLATE);
  assert.ok(!html.includes('<script>alert(1)</script>'), 'raw script tag leaked');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /Why &lt;was&gt; this &quot;costly&quot; &amp; slow\?/); // escaped title
});

test('render: context consumers name the concrete target, escaped', () => {
  const html = render(detail, TEMPLATE);
  assert.match(html, /\/repo\/src\/&lt;huge&gt; &amp; &quot;big&quot;\.js/); // target escaped
  assert.match(html, /Read ×2/);              // grouped count
  assert.match(html, /git log --stat/);       // bash command as target
  assert.match(html, /estimates, not billed/i); // disclaimer note rendered
});

test('render: consumer summary replaces target, raw target stays on hover', () => {
  const withSummary = {
    ...detail,
    summary: {
      ...detail.summary,
      contextConsumers: {
        ...detail.summary.contextConsumers,
        top: [
          { tool: 'Read', target: '/repo/src/<huge> & "big".js', count: 2, estTokens: 38000, carriedCost: 1.1, summary: 'The oversized bundled renderer module' },
          { tool: 'Bash', target: 'git log --stat', count: 1, estTokens: 15000, carriedCost: 0.3 },
        ],
      },
    },
  };
  const html = render(withSummary, TEMPLATE);
  // summary text shown in the cell, tagged for the styled tooltip, raw target on data-full
  assert.match(html, /class="prompt cc-tip"[^>]*data-tool="Read"[^>]*data-full="\/repo\/src\/&lt;huge&gt; &amp; &quot;big&quot;\.js"[^>]*>The oversized bundled renderer module</);
  // un-summarized row stays a plain cell with the raw target, no tooltip
  assert.match(html, /<td class="prompt">git log --stat<\/td>/);
});

test('render: payload without contextConsumers → placeholder rows, no crash', () => {
  const old = { ...detail, summary: { ...detail.summary, contextConsumers: undefined } };
  const html = render(old, TEMPLATE);
  assert.match(html, /no consumer data/);
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(html));
});

test('render: thinking section carries the headline and per-turn rows, escaped', () => {
  const html = render(detail, TEMPLATE);
  assert.match(html, /149k tokens \$3\.43 billed at the output rate/);
  assert.match(html, /137k interleaved \(billed, never saved to the transcript\)/);
  assert.match(html, /148\/155 steps thought/);
  assert.match(html, /peak 6k at step 73 → Bash/);
  assert.match(html, /fix the &lt;failing&gt; tests/); // by-turn prompt escaped
  assert.match(html, /38k/);                           // by-turn tokens
  // biggest bursts: trigger escaped, blank nextTools → 'replied'
  assert.match(html, /Bash: docker compose run &lt;tests&gt;/);
  assert.match(html, /replied/);
});

test('render: by-skill rows + placeholder when absent', () => {
  const html = render(detail, TEMPLATE);
  assert.match(html, /writing-phpunit-tests/);
  assert.match(html, /\$0\.84/);
  const none = { ...detail, summary: { ...detail.summary, bySkill: [] } };
  assert.match(render(none, TEMPLATE), /no skill dispatches/);
});

test('render: payload without assistantOutput → placeholder, no crash', () => {
  const old = { ...detail, summary: { ...detail.summary, assistantOutput: undefined } };
  const html = render(old, TEMPLATE);
  assert.match(html, /no thinking recorded/);
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(html));
});

test('render: context timeline draws one bar per MAIN step, threshold tiers, escaped', () => {
  const html = render(detail, TEMPLATE);
  assert.match(html, /<svg class="ctx-chart"/);
  assert.strictEqual((html.match(/class="ctx-bar /g) || []).length, 3); // subagent call excluded
  assert.match(html, /class="ctx-bar c-high"/); // 210k bar → red tier
  assert.match(html, /class="ctx-bar c-low"/);  // 17k bar → green tier
  assert.match(html, />200k<\/text>/);          // 200k gridline label
  assert.match(html, /class="ctx-turn /);       // turn-start tick
  assert.ok(!html.includes('<img src=x'), 'raw prompt leaked into svg');
  assert.match(html, /evil &lt;img src=x onerror=alert\(1\)&gt; prompt/);
});

test('render: growth bar groups steps by turn, leads with session overhead', () => {
  const html = render(detail, TEMPLATE);
  assert.match(html, /<svg class="ctx-growbar"/);
  // 3 segments: overhead (22k baseline = cacheRead 17068 + cacheWrite 5000 + input
  // 200) + skill turn (+123k) + user turn (+70k); the 210k step adds nothing after
  // itself so it collapses away.
  assert.strictEqual((html.match(/class="ctx-seg /g) || []).length, 3);
  assert.match(html, /session start — system prompt/);
  assert.match(html, /class="ctx-seg c-skill"/); // skill-kind segment (turnIndex 1)
  assert.match(html, /data-grow="123k"/);
  assert.match(html, /\+215k total context added/); // 22k baseline + 123k + 70k
});

test('render: payload without calls → timeline placeholder, no crash', () => {
  const old = { ...detail, calls: undefined };
  const html = render(old, TEMPLATE);
  assert.match(html, /no per-call data in this payload/);
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(html));
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
