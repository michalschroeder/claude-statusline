'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { runSessions } = require('./helpers');

const SESSIONS = path.resolve(__dirname, '../bin/sessions.js');

// Like runSessions but DOES NOT strip ANSI — used to inspect footer color codes.
// Mirrors the CLAUDE_CONFIG_DIR scrub so XDG_STATE_HOME isolation holds.
function runSessionsRaw(args = [], env) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...process.env, STATUSLINE_ICONS: 'nerd', ...(env || {}) };
    if (!(env && 'CLAUDE_CONFIG_DIR' in env)) delete childEnv.CLAUDE_CONFIG_DIR;
    // Same for the budget: a budget inherited from the test harness would mask the
    // "unset → 500 default" path, so drop it unless the test sets it on purpose.
    if (!(env && 'STATUSLINE_MONTHLY_BUDGET' in env)) delete childEnv.STATUSLINE_MONTHLY_BUDGET;
    const proc = spawn(process.execPath, [SESSIONS, ...args], { env: childEnv });
    let out = '', err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('close', (code) => {
      if (code !== 0 && err) reject(new Error(err));
      else resolve(out);
    });
  });
}

// Build an isolated profile: XDG_STATE_HOME → state dir; configDir → transcript root.
// Returns { env, configDir } to pass to runSessions.
const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

function mkProfile() {
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-xdg-'));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-cfg-'));
  tmpDirs.push(xdg, configDir);
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

test('viewer: dim ─ rule separates the list from the totals footer', async () => {
  const p = mkProfile();
  const now = Math.floor(Date.now() / 1000);
  writeCostLog(p.stateDir, [`2026-06-05 ${now} sessRULE1 0.50`]);
  const out = await runSessions(['--config-dir', p.configDir], env(p));
  const lines = out.split('\n');
  const ruleIdx = lines.findIndex((l) => /^─+$/.test(l));
  const footerIdx = lines.findIndex((l) => /^TODAY /.test(l));
  assert.ok(ruleIdx !== -1, 'a ─ rule line is present');
  assert.strictEqual(ruleIdx, footerIdx - 1, 'rule sits directly above the footer');
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
  assert.match(out, /TODAY\s+\$1\.20/);
});

test('viewer: --last caps rows', async () => {
  const p = mkProfile();
  const now = Math.floor(Date.now() / 1000);
  const lines = [];
  for (let i = 0; i < 5; i++) lines.push(`2026-06-05 ${now - i} sess${i}xxx ${(i + 1) / 10}`);
  writeCostLog(p.stateDir, lines);
  const out = await runSessions(['--config-dir', p.configDir, '--last', '2'], env(p));
  const dataRows = out.split('\n').filter((l) => /^\d{2}-\d{2} \d{2}:\d{2}/.test(l));
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

test('viewer: --since without --last does not cap at 10', async () => {
  const p = mkProfile();
  const nowD = new Date();
  const todayTs = Math.floor(new Date(nowD.getFullYear(), nowD.getMonth(), nowD.getDate(), 12).getTime() / 1000);
  const lines = [];
  for (let i = 0; i < 12; i++) lines.push(`2026-06-05 ${todayTs - i} sess${i}yyy ${(i + 1) / 10}`);
  writeCostLog(p.stateDir, lines);
  const since = `${nowD.getFullYear()}-${String(nowD.getMonth() + 1).padStart(2, '0')}-${String(nowD.getDate()).padStart(2, '0')}`;
  const out = await runSessions(['--config-dir', p.configDir, '--since', since], env(p));
  const dataRows = out.split('\n').filter((l) => /^\d{2}-\d{2} \d{2}:\d{2}/.test(l));
  assert.ok(dataRows.length >= 11, `expected >= 11 data rows, got ${dataRows.length}`);
});

test('viewer: invalid --since rejects with exit 1', async () => {
  const p = mkProfile();
  await assert.rejects(
    runSessions(['--config-dir', p.configDir, '--since', 'notadate'], env(p)),
    /--since requires/
  );
});

test('viewer: live cost supersedes logged cost for same id', async () => {
  const p = mkProfile();
  const now = Math.floor(Date.now() / 1000);
  writeCostLog(p.stateDir, [`2026-06-05 ${now} sessDUP1 0.50`]);
  writeLive(p.stateDir, 'sessDUP1', 1.20);
  const out = await runSessions(['--config-dir', p.configDir], env(p));
  assert.match(out, /\$1\.20/);
  assert.doesNotMatch(out, /\$0\.50/);
  assert.match(out, /●/);
  assert.match(out, /TODAY\s+\$1\.20/);
});

test('viewer: SESSION column stays aligned across cost magnitudes', async () => {
  const p = mkProfile();
  const now = Math.floor(Date.now() / 1000);
  writeCostLog(p.stateDir, [
    `2026-06-05 ${now} sessSMALL1 0.58`,
    `2026-06-05 ${now - 1} sessBIG001 12.34`,
  ]);
  const out = await runSessions(['--config-dir', p.configDir], env(p));
  const dataLines = out.split('\n').filter((l) => /^\d{2}-\d{2} \d{2}:\d{2}/.test(l));
  const small = dataLines.find((l) => l.includes('sessSMAL'));
  const big = dataLines.find((l) => l.includes('sessBIG0'));
  // Short ids (first 8 chars) must start at the same column → columns aligned.
  assert.strictEqual(small.indexOf('sessSMAL'), big.indexOf('sessBIG0'));
  // Decimal points align too (right-aligned cost field).
  assert.strictEqual(small.indexOf('.'), big.indexOf('.'));
});

test('viewer: footer colors against 500 default when budget unset; 0 opts out (bold)', async () => {
  const p = mkProfile();
  const now = Math.floor(Date.now() / 1000);
  // $600 today → daily total far exceeds the 500/30 limit → definite tier color.
  writeCostLog(p.stateDir, [`2026-06-05 ${now} sessFTR01 600.00`]);

  const tierRe = /\x1b\[(32|33|31|38;5;208)m/;
  const todayLineOf = (raw) =>
    raw.split('\n').find((l) => /TODAY/.test(l.replace(/\x1b\[[0-9;]*m/g, '')));

  // Default (budget unset): TODAY amount carries a tier color, not merely bold.
  const rawDefault = await runSessionsRaw(['--config-dir', p.configDir], env(p));
  const todayDefault = todayLineOf(rawDefault);
  assert.ok(todayDefault, 'TODAY line present (default)');
  assert.ok(tierRe.test(todayDefault), 'TODAY amount tier-colored by default');

  // Explicit 0: bold, no tier color.
  const rawZero = await runSessionsRaw(
    ['--config-dir', p.configDir],
    { ...env(p), STATUSLINE_MONTHLY_BUDGET: '0' }
  );
  const todayZero = todayLineOf(rawZero);
  assert.ok(todayZero, 'TODAY line present (budget=0)');
  assert.ok(/\x1b\[1m/.test(todayZero), 'TODAY amount bold when budget=0');
  assert.ok(!tierRe.test(todayZero), 'TODAY amount not tier-colored when budget=0');
});

test('viewer: ended row has a blank marker where live row has ●', async () => {
  const p = mkProfile();
  const now = Math.floor(Date.now() / 1000);
  writeCostLog(p.stateDir, [`2026-06-05 ${now} sessENDED1 1.00`]);
  writeLive(p.stateDir, 'sessLIVE22', 2.00);
  const out = await runSessions(['--config-dir', p.configDir], env(p));
  const dataLines = out.split('\n').filter((l) => /^\d{2}-\d{2} \d{2}:\d{2}/.test(l));
  const ended = dataLines.find((l) => l.includes('sessENDE'));
  const live = dataLines.find((l) => l.includes('sessLIVE'));
  // The ● sits exactly one column before the short id on the live line.
  assert.strictEqual(live.indexOf('●'), live.indexOf('sessLIVE') - 2);
  // Ended line has a space at that same column (no ●).
  assert.strictEqual(ended.includes('●'), false);
  assert.strictEqual(ended.indexOf('sessENDE'), live.indexOf('sessLIVE'));
});
