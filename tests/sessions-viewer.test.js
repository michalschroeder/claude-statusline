'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runSessions } = require('./helpers');

// The viewer (bin/sessions.js) enumerates sessions from the CC transcripts under
// <config-dir>/projects/*/<id>.jsonl, newest-first by file mtime, and renders
// WHEN / SESSION / TITLE-RECAP (title + recap parsed in-process). No cost.

const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

// Isolated profile: configDir is the transcript root the viewer reads.
function mkProfile() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-cfg-'));
  tmpDirs.push(configDir);
  return { configDir };
}

// Write a transcript and (optionally) set its mtime — the viewer derives each
// session's timestamp from the file mtime. `when` is a Date or unix seconds.
function writeTranscript(configDir, sessionId, entries, when) {
  const proj = path.join(configDir, 'projects', '-test-proj');
  fs.mkdirSync(proj, { recursive: true });
  const file = path.join(proj, `${sessionId}.jsonl`);
  fs.writeFileSync(file, entries.map((o) => JSON.stringify(o)).join('\n') + '\n');
  if (when != null) {
    const d = when instanceof Date ? when : new Date(when * 1000);
    fs.utimesSync(file, d, d);
  }
}

const env = () => ({}); // config-dir passed as a CLI flag; no state dir needed
const dataRows = (out) => out.split('\n').filter((l) => /^\d{2}-\d{2} \d{2}:\d{2}/.test(l));

test('viewer: empty state → friendly message', async () => {
  const p = mkProfile();
  const out = await runSessions(['--config-dir', p.configDir], env());
  assert.match(out, /no sessions found/i);
});

test('viewer: prints a row with title + recap sub-line', async () => {
  const p = mkProfile();
  writeTranscript(p.configDir, 'sessAAA1', [
    { type: 'ai-title', aiTitle: 'Address timezone comment' },
    { type: 'system', subtype: 'away_summary', content: 'Applied 4 reviewer changes (disable recaps in /config)' },
  ]);
  const out = await runSessions(['--config-dir', p.configDir], env());
  assert.match(out, /sessAAA/); // short id appears
  assert.match(out, /Address timezone comment/);
  assert.match(out, /Applied 4 reviewer changes/);
  assert.doesNotMatch(out, /disable recaps/); // disclaimer stripped
});

test('viewer: title absent → em dash, no recap line', async () => {
  const p = mkProfile();
  writeTranscript(p.configDir, 'sessBBB1', [{ type: 'user', text: 'hi' }]);
  const out = await runSessions(['--config-dir', p.configDir], env());
  assert.match(out, /—/);
  assert.match(out, /sessBBB/);
});

test('viewer: newest-first by mtime', async () => {
  const p = mkProfile();
  const now = Math.floor(Date.now() / 1000);
  writeTranscript(p.configDir, 'sessOLD11', [{ type: 'ai-title', aiTitle: 'older' }], now - 7200);
  writeTranscript(p.configDir, 'sessNEW11', [{ type: 'ai-title', aiTitle: 'newer' }], now - 60);
  const out = await runSessions(['--config-dir', p.configDir], env());
  const rows = dataRows(out);
  assert.ok(rows[0].includes('sessNEW'), 'newest row first');
  assert.ok(rows[1].includes('sessOLD'), 'older row second');
});

test('viewer: --last caps rows', async () => {
  const p = mkProfile();
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 5; i++) {
    writeTranscript(p.configDir, `sess${i}xxxx`, [{ type: 'ai-title', aiTitle: `t${i}` }], now - i);
  }
  const out = await runSessions(['--config-dir', p.configDir, '--last', '2'], env());
  assert.strictEqual(dataRows(out).length, 2);
});

test('viewer: negative --last is rejected (not slice-from-end)', async () => {
  const p = mkProfile();
  writeTranscript(p.configDir, 'sessNEG1', [{ type: 'ai-title', aiTitle: 'x' }]);
  await assert.rejects(
    runSessions(['--config-dir', p.configDir, '--last', '-3'], env()),
    /non-negative integer/
  );
});

test('viewer: --since filters older rows out', async () => {
  const p = mkProfile();
  const nowD = new Date();
  const todayTs = Math.floor(new Date(nowD.getFullYear(), nowD.getMonth(), nowD.getDate(), 12).getTime() / 1000);
  const oldTs = todayTs - 40 * 86400; // 40 days ago
  writeTranscript(p.configDir, 'sessNEW1', [{ type: 'ai-title', aiTitle: 'new' }], todayTs);
  writeTranscript(p.configDir, 'sessOLD1', [{ type: 'ai-title', aiTitle: 'old' }], oldTs);
  const since = `${nowD.getFullYear()}-${String(nowD.getMonth() + 1).padStart(2, '0')}-${String(nowD.getDate()).padStart(2, '0')}`;
  const out = await runSessions(['--config-dir', p.configDir, '--since', since], env());
  assert.match(out, /sessNEW/);
  assert.doesNotMatch(out, /sessOLD/);
});

test('viewer: --since without --last does not cap at 10', async () => {
  const p = mkProfile();
  const nowD = new Date();
  const todayTs = Math.floor(new Date(nowD.getFullYear(), nowD.getMonth(), nowD.getDate(), 12).getTime() / 1000);
  for (let i = 0; i < 12; i++) {
    writeTranscript(p.configDir, `sess${i}yyyy`, [{ type: 'ai-title', aiTitle: `t${i}` }], todayTs - i);
  }
  const since = `${nowD.getFullYear()}-${String(nowD.getMonth() + 1).padStart(2, '0')}-${String(nowD.getDate()).padStart(2, '0')}`;
  const out = await runSessions(['--config-dir', p.configDir, '--since', since], env());
  assert.ok(dataRows(out).length >= 11, `expected >= 11 data rows, got ${dataRows(out).length}`);
});

test('viewer: invalid --since rejects with exit 1', async () => {
  const p = mkProfile();
  await assert.rejects(
    runSessions(['--config-dir', p.configDir, '--since', 'notadate'], env()),
    /--since requires/
  );
});

test('viewer: SESSION column stays aligned across rows', async () => {
  const p = mkProfile();
  const now = Math.floor(Date.now() / 1000);
  writeTranscript(p.configDir, 'sessSMALL1', [{ type: 'ai-title', aiTitle: 'a' }], now);
  writeTranscript(p.configDir, 'sessBIG001', [{ type: 'ai-title', aiTitle: 'b' }], now - 1);
  const out = await runSessions(['--config-dir', p.configDir], env());
  const lines = dataRows(out);
  const small = lines.find((l) => l.includes('sessSMAL'));
  const big = lines.find((l) => l.includes('sessBIG0'));
  // Short ids (first 8 chars) must start at the same column → columns aligned.
  assert.strictEqual(small.indexOf('sessSMAL'), big.indexOf('sessBIG0'));
});

test('viewer: shows per-session COST column + d/w/m footer', async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-vc-'));
  const proj = path.join(configDir, 'projects', 'p');
  fs.mkdirSync(proj, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(proj, 'sess1.jsonl'),
    JSON.stringify({ type: 'assistant', timestamp: now, message: { id: 'm1', model: 'claude-opus-4-8', usage: { input_tokens: 1000000 } } }) + '\n');
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-vx-'));
  const out = await runSessions(['--config-dir', configDir], { XDG_STATE_HOME: xdg });
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.rmSync(xdg, { recursive: true, force: true });
  assert.match(out, /COST/);            // header
  assert.match(out, /\$\d+\.\d{2}/);    // a dollar amount on the row
  assert.match(out, /today|day|week|month/i); // footer line
});
