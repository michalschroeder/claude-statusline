'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK = path.resolve(__dirname, '../hooks/refresh-cost-cache.js');
const tmp = [];
after(() => { for (const d of tmp) fs.rmSync(d, { recursive: true, force: true }); });

test('builds cost-cache.json from transcripts under CLAUDE_CONFIG_DIR', () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-cfg-')); tmp.push(configDir);
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-xdg-')); tmp.push(xdg);
  const proj = path.join(configDir, 'projects', 'p');
  fs.mkdirSync(proj, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(proj, 's1.jsonl'),
    JSON.stringify({ type: 'assistant', timestamp: now, message: { id: 'm1', model: 'claude-opus-4-8', usage: { input_tokens: 1000 } } }) + '\n');

  const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir, XDG_STATE_HOME: xdg, STATUSLINE_PRICING_NO_FETCH: "1" };
  const res = spawnSync(process.execPath, [HOOK], { env, encoding: 'utf8' });
  assert.equal(res.status, 0);

  const profile = configDir.replace(/^\//, '').replace(/\//g, '_');
  const cachePath = path.join(xdg, 'claude-statusline', profile, 'cost-cache.json');
  const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  assert.ok(cache.perSession.s1);
  assert.ok(cache.perSession.s1.total > 0);
});

test('exits 0 even with no projects dir', () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-cfg2-')); tmp.push(configDir);
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-xdg2-')); tmp.push(xdg);
  const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir, XDG_STATE_HOME: xdg, STATUSLINE_PRICING_NO_FETCH: "1" };
  const res = spawnSync(process.execPath, [HOOK], { env, encoding: 'utf8' });
  assert.equal(res.status, 0);
});
