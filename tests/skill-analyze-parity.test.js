'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SESSIONS = path.join(__dirname, '..', 'bin', 'sessions.js');
const ANALYZE = path.join(__dirname, '..', '.agents', 'skills', 'session-cost-analyzer', 'scripts', 'analyze.js');

const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

function mkProfile() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-parity-'));
  tmpDirs.push(configDir);
  return configDir;
}

function writeTranscript(configDir, sessionId, entries, when) {
  const proj = path.join(configDir, 'projects', '-test-proj');
  fs.mkdirSync(proj, { recursive: true });
  const file = path.join(proj, `${sessionId}.jsonl`);
  fs.writeFileSync(file, entries.map((o) => JSON.stringify(o)).join('\n') + '\n');
  if (when != null) { const d = new Date(when * 1000); fs.utimesSync(file, d, d); }
}

function runJson(script, args, configDir) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir,
      XDG_STATE_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'csl-state-')),
      STATUSLINE_PRICING_NO_FETCH: '1',
      STATUSLINE_MONTHLY_BUDGET: '0' };
    tmpDirs.push(env.XDG_STATE_HOME);
    const proc = spawn(process.execPath, [script, ...args], { env });
    let out = '', err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('close', (code) => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`exit ${code}: ${err}`)));
  });
}

// One assistant call with usage so cost is non-zero and deterministic.
const fixture = () => [
  { type: 'user', message: { role: 'user', content: 'do the thing' }, uuid: 'u1' },
  { type: 'assistant', timestamp: '2024-06-01T10:00:00Z',
    message: { id: 'm1', role: 'assistant', model: 'claude-sonnet-4-6',
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 },
      content: [{ type: 'text', text: 'done' }] }, uuid: 'a1' },
];

test('parity: list payload matches bin/sessions.js --analyze', async () => {
  const cfg = mkProfile();
  writeTranscript(cfg, 'parity01', fixture(), 1717200000);
  const a = await runJson(SESSIONS, ['--analyze'], cfg);
  const b = await runJson(ANALYZE, ['list'], cfg);
  assert.deepStrictEqual(b, a);
});

test('parity: detail payload matches bin/sessions.js <prefix> --analyze', async () => {
  const cfg = mkProfile();
  writeTranscript(cfg, 'parity02', fixture(), 1717200000);
  const a = await runJson(SESSIONS, ['parity02', '--analyze'], cfg);
  const b = await runJson(ANALYZE, ['parity02'], cfg);
  assert.deepStrictEqual(b, a);
});
