'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ANALYZE = path.join(__dirname, '..', 'analyze.js');
const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

function mkProfile() {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-smoke-'));
  tmpDirs.push(cfg);
  return cfg;
}

function writeTranscript(cfg, id, entries, when) {
  const proj = path.join(cfg, 'projects', '-test-proj');
  fs.mkdirSync(proj, { recursive: true });
  const file = path.join(proj, `${id}.jsonl`);
  fs.writeFileSync(file, entries.map((o) => JSON.stringify(o)).join('\n') + '\n');
  if (when != null) { const d = new Date(when * 1000); fs.utimesSync(file, d, d); }
}

function runJson(args, cfg) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, CLAUDE_CONFIG_DIR: cfg,
      XDG_STATE_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'csl-st-')),
      STATUSLINE_PRICING_NO_FETCH: '1',
      STATUSLINE_MONTHLY_BUDGET: '0' };
    tmpDirs.push(env.XDG_STATE_HOME);
    const proc = spawn(process.execPath, [ANALYZE, ...args], { env });
    let out = '', err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('close', (code) => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err)));
  });
}

// Proven fixture shape from parity test — timestamp required for cost > 0.
const fixture = () => [
  { type: 'user', message: { role: 'user', content: 'do the thing' }, uuid: 'u1' },
  { type: 'assistant', timestamp: '2024-06-01T10:00:00Z',
    message: { id: 'm1', role: 'assistant', model: 'claude-sonnet-4-6',
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 },
      content: [{ type: 'text', text: 'done' }] }, uuid: 'a1' },
];

test('smoke: list payload has the documented top-level keys', async () => {
  const cfg = mkProfile();
  writeTranscript(cfg, 'smoke001', fixture(), 1717200000);
  const out = await runJson(['list'], cfg);
  assert.ok(Array.isArray(out.sessions));
  assert.deepStrictEqual(Object.keys(out.periods).sort(), ['month', 'today', 'week']);
  assert.ok('monthlyBudget' in out);
  assert.strictEqual(out.sessions[0].session, 'smoke001');
});

test('smoke: detail payload exposes the precomputed summary rollups', async () => {
  const cfg = mkProfile();
  writeTranscript(cfg, 'smoke002', fixture(), 1717200000);
  const out = await runJson(['smoke002'], cfg);
  assert.strictEqual(out.session, 'smoke002');
  assert.ok(out.totalCost > 0);
  for (const k of ['contextGrowth', 'byTurnKind', 'toolTally', 'highContextCost', 'contextResets', 'contextConsumers', 'assistantOutput', 'bySkill']) {
    assert.ok(k in out.summary, `summary.${k} present`);
  }
});

// A subagent's byAgent label prefers its meta.json `description` (the Task tool's
// short summary) over the long, boilerplate-heavy first prompt.
test('smoke: subagent label comes from meta.json description', async () => {
  const cfg = mkProfile();
  const id = 'smoke003';
  writeTranscript(cfg, id, fixture(), 1717200000);
  const subDir = path.join(cfg, 'projects', '-test-proj', id, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  const sub = [
    { type: 'user', message: { role: 'user', content: 'You have access to the Datadog MCP tools. The account is already authenticated. Validate ...' }, uuid: 's-u1' },
    { type: 'assistant', timestamp: '2024-06-01T10:05:00Z',
      message: { id: 'sm1', role: 'assistant', model: 'claude-sonnet-4-6',
        usage: { input_tokens: 50, output_tokens: 20, cache_read_input_tokens: 500, cache_creation_input_tokens: 100 },
        content: [{ type: 'text', text: 'ok' }] }, uuid: 's-a1' },
  ];
  fs.writeFileSync(path.join(subDir, 'agent-abc123.jsonl'), sub.map((o) => JSON.stringify(o)).join('\n') + '\n');
  fs.writeFileSync(path.join(subDir, 'agent-abc123.meta.json'),
    JSON.stringify({ agentType: 'general-purpose', description: 'Validate DD error tracking' }));
  const out = await runJson([id], cfg);
  const agent = out.byAgent.find((a) => a.name === 'agent-abc123');
  assert.ok(agent, 'subagent present in byAgent');
  assert.strictEqual(agent.label, 'Validate DD error tracking');
});

test('smoke: empty store still emits valid list JSON', async () => {
  const cfg = mkProfile();
  const out = await runJson(['list'], cfg);
  assert.deepStrictEqual(out.sessions, []);
});
