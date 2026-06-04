'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runSessions } = require('./helpers');

// Build an isolated profile: XDG_STATE_HOME → state dir; configDir → transcript root.
// Returns { env, configDir } to pass to runSessions.
function mkProfile() {
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-xdg-'));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-cfg-'));
  // state dir = <xdg>/claude-statusline/<mangled configDir>
  const profile = configDir.replace(/^\//, '').replace(/\//g, '_');
  const stateDir = path.join(xdg, 'claude-statusline', profile);
  fs.mkdirSync(stateDir, { recursive: true });
  return { xdg, configDir, stateDir };
}

function writeCostLog(stateDir, lines) {
  fs.writeFileSync(path.join(stateDir, 'cost.log'), lines.join('\n') + '\n');
}

function writeTranscript(configDir, sessionId, entries) {
  const proj = path.join(configDir, 'projects', '-test-proj');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(
    path.join(proj, `${sessionId}.jsonl`),
    entries.map((o) => JSON.stringify(o)).join('\n') + '\n'
  );
}

function writeLive(stateDir, sessionId, cost) {
  const d = path.join(stateDir, 'cost');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, sessionId), String(cost));
}

const env = (p) => ({ XDG_STATE_HOME: p.xdg });

test('viewer: empty state → friendly message', async () => {
  const p = mkProfile();
  const out = await runSessions(['--config-dir', p.configDir], env(p));
  assert.match(out, /no sessions recorded yet/i);
});

test('viewer: prints a row with title + recap sub-line', async () => {
  const p = mkProfile();
  const now = Math.floor(Date.now() / 1000);
  writeCostLog(p.stateDir, [`2026-06-05 ${now} sessAAA1 0.83`]);
  writeTranscript(p.configDir, 'sessAAA1', [
    { type: 'ai-title', aiTitle: 'Address timezone comment' },
    { type: 'system', subtype: 'away_summary', content: 'Applied 4 reviewer changes (disable recaps in /config)' },
  ]);
  const out = await runSessions(['--config-dir', p.configDir], env(p));
  assert.match(out, /sessAAA1|sessAAA/); // short id appears
  assert.match(out, /Address timezone comment/);
  assert.match(out, /Applied 4 reviewer changes/);
  assert.match(out, /\$0\.83/);
});

test('viewer: title absent → em dash, no recap line', async () => {
  const p = mkProfile();
  const now = Math.floor(Date.now() / 1000);
  writeCostLog(p.stateDir, [`2026-06-05 ${now} sessBBB1 1.10`]);
  writeTranscript(p.configDir, 'sessBBB1', [{ type: 'user', text: 'hi' }]);
  const out = await runSessions(['--config-dir', p.configDir], env(p));
  assert.match(out, /—/);
  assert.match(out, /\$1\.10/);
});

test('viewer: live session marked, folded into TODAY total', async () => {
  const p = mkProfile();
  writeLive(p.stateDir, 'sessLIVE1', 1.20);
  writeTranscript(p.configDir, 'sessLIVE1', [{ type: 'ai-title', aiTitle: 'Live work' }]);
  const out = await runSessions(['--config-dir', p.configDir], env(p));
  assert.match(out, /Live work/);
  assert.match(out, /●/);                 // live marker
  assert.match(out, /incl\. live/i);
  assert.match(out, /TODAY:\s*\$1\.20/);
});

test('viewer: --last caps rows', async () => {
  const p = mkProfile();
  const now = Math.floor(Date.now() / 1000);
  const lines = [];
  for (let i = 0; i < 5; i++) lines.push(`2026-06-05 ${now - i} sess${i}xxx ${(i + 1) / 10}`);
  writeCostLog(p.stateDir, lines);
  const out = await runSessions(['--config-dir', p.configDir, '--last', '2'], env(p));
  const dataRows = out.split('\n').filter((l) => /\$\d/.test(l) && !/TODAY:/.test(l));
  assert.strictEqual(dataRows.length, 2);
});

test('viewer: --since filters older rows out', async () => {
  const p = mkProfile();
  const nowD = new Date();
  const todayTs = Math.floor(new Date(nowD.getFullYear(), nowD.getMonth(), nowD.getDate(), 12).getTime() / 1000);
  const oldTs = todayTs - 40 * 86400; // 40 days ago
  writeCostLog(p.stateDir, [
    `2026-06-05 ${todayTs} sessNEW1 0.50`,
    `2026-04-01 ${oldTs} sessOLD1 0.50`,
  ]);
  const since = `${nowD.getFullYear()}-${String(nowD.getMonth() + 1).padStart(2, '0')}-${String(nowD.getDate()).padStart(2, '0')}`;
  const out = await runSessions(['--config-dir', p.configDir, '--since', since], env(p));
  assert.match(out, /sessNEW/);
  assert.doesNotMatch(out, /sessOLD/);
});
