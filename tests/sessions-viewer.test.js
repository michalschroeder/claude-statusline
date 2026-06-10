'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runSessions } = require('./helpers');

// The viewer (bin/sessions.js) enumerates sessions from CC transcripts under
// <config-dir>/projects/*/<id>.jsonl, newest-first by file mtime, and renders
// day-grouped rows (clock + relative time, cost, full session id) + a footer.

const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

function mkProfile() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-cfg-'));
  tmpDirs.push(configDir);
  return { configDir };
}

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

// Wide terminal so the full-id column is shown (narrow terminals drop it).
const wide = (extra) => ({ COLUMNS: '200', ...(extra || {}) });
// A data row starts with the 2-space indent + HH:MM clock.
const dataRows = (out) => out.split('\n').filter((l) => /^  \d{2}:\d{2} /.test(l));
const dayRules = (out) => out.split('\n').filter((l) => /^── /.test(l));

test('viewer: empty state → friendly message', async () => {
  const p = mkProfile();
  const out = await runSessions(['--config-dir', p.configDir], wide());
  assert.match(out, /no sessions found/i);
});

test('viewer: row shows clock + relative time + title + recap', async () => {
  const p = mkProfile();
  writeTranscript(p.configDir, 'sessAAA1', [
    { type: 'ai-title', aiTitle: 'Address timezone comment' },
    { type: 'system', subtype: 'away_summary', content: 'Applied 4 reviewer changes (disable recaps in /config)' },
  ]);
  const out = await runSessions(['--config-dir', p.configDir], wide());
  assert.match(out, /\d{2}:\d{2}/);             // clock
  assert.match(out, /ago|just now/);            // relative time
  assert.match(out, /Address timezone comment/);
  assert.match(out, /Applied 4 reviewer changes/);
  assert.doesNotMatch(out, /disable recaps/);   // disclaimer stripped
  assert.match(out, /id +sessAAA1/);            // full id, labeled, shown on wide terminal
});

test('viewer: title absent → em dash', async () => {
  const p = mkProfile();
  writeTranscript(p.configDir, 'sessBBB1', [{ type: 'user', text: 'hi' }]);
  const out = await runSessions(['--config-dir', p.configDir], wide());
  assert.match(out, /—/);
});

test('viewer: full id dropped on a narrow terminal, title kept', async () => {
  const p = mkProfile();
  writeTranscript(p.configDir, 'sessNARROW', [{ type: 'ai-title', aiTitle: 'keepme' }]);
  const out = await runSessions(['--config-dir', p.configDir], { COLUMNS: '40' });
  assert.match(out, /keepme/);
  assert.doesNotMatch(out, /sessNARROW/);
});

test('viewer: rows grouped under a day header', async () => {
  const p = mkProfile();
  const a = Math.floor(new Date(2026, 5, 9, 10).getTime() / 1000);
  const b = Math.floor(new Date(2026, 5, 8, 10).getTime() / 1000);
  writeTranscript(p.configDir, 'sessDAY1', [{ type: 'ai-title', aiTitle: 'today-ish' }], a);
  writeTranscript(p.configDir, 'sessDAY2', [{ type: 'ai-title', aiTitle: 'yesterday-ish' }], b);
  const out = await runSessions(['--config-dir', p.configDir], wide());
  assert.strictEqual(dayRules(out).length, 2, 'one rule per distinct day');
  assert.match(dayRules(out)[0], /[A-Z][a-z]{2} [A-Z][a-z]{2} \d{2}/);
});

test('viewer: newest-first', async () => {
  const p = mkProfile();
  const now = Math.floor(Date.now() / 1000);
  writeTranscript(p.configDir, 'sessOLD11', [{ type: 'ai-title', aiTitle: 'older' }], now - 7200);
  writeTranscript(p.configDir, 'sessNEW11', [{ type: 'ai-title', aiTitle: 'newer' }], now - 60);
  const rows = dataRows(await runSessions(['--config-dir', p.configDir], wide()));
  assert.ok(rows[0].includes('newer'), 'newest row first');
  assert.ok(rows[1].includes('older'), 'older row second');
});

test('viewer: --last caps rows', async () => {
  const p = mkProfile();
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 5; i++) {
    writeTranscript(p.configDir, `sess${i}xxxx`, [{ type: 'ai-title', aiTitle: `t${i}` }], now - i);
  }
  const out = await runSessions(['--config-dir', p.configDir, '--last', '2'], wide());
  assert.strictEqual(dataRows(out).length, 2);
});

test('viewer: sessions exist but --since excludes all → distinct message', async () => {
  const p = mkProfile();
  writeTranscript(p.configDir, 'sessONLY1', [{ type: 'ai-title', aiTitle: 'x' }],
    Math.floor(new Date(2020, 0, 1).getTime() / 1000));
  const out = await runSessions(['--config-dir', p.configDir, '--since', '2030-01-01'], wide());
  assert.match(out, /no sessions match/);
  assert.doesNotMatch(out, /no sessions found/); // that message is for a truly empty store
});

test('viewer: negative --last is rejected', async () => {
  const p = mkProfile();
  writeTranscript(p.configDir, 'sessNEG1', [{ type: 'ai-title', aiTitle: 'x' }]);
  await assert.rejects(
    runSessions(['--config-dir', p.configDir, '--last', '-3'], wide()),
    /non-negative integer/
  );
});

test('viewer: --since filters older rows out', async () => {
  const p = mkProfile();
  const nowD = new Date();
  const todayTs = Math.floor(new Date(nowD.getFullYear(), nowD.getMonth(), nowD.getDate(), 12).getTime() / 1000);
  const oldTs = todayTs - 40 * 86400;
  writeTranscript(p.configDir, 'sessNEW1', [{ type: 'ai-title', aiTitle: 'freshone' }], todayTs);
  writeTranscript(p.configDir, 'sessOLD1', [{ type: 'ai-title', aiTitle: 'staleone' }], oldTs);
  const since = `${nowD.getFullYear()}-${String(nowD.getMonth() + 1).padStart(2, '0')}-${String(nowD.getDate()).padStart(2, '0')}`;
  const out = await runSessions(['--config-dir', p.configDir, '--since', since], wide());
  assert.match(out, /freshone/);
  assert.doesNotMatch(out, /staleone/);
});

test('viewer: --since without --last does not cap at 10', async () => {
  const p = mkProfile();
  const nowD = new Date();
  const todayTs = Math.floor(new Date(nowD.getFullYear(), nowD.getMonth(), nowD.getDate(), 12).getTime() / 1000);
  for (let i = 0; i < 12; i++) {
    writeTranscript(p.configDir, `sess${i}yyyy`, [{ type: 'ai-title', aiTitle: `t${i}` }], todayTs - i);
  }
  const since = `${nowD.getFullYear()}-${String(nowD.getMonth() + 1).padStart(2, '0')}-${String(nowD.getDate()).padStart(2, '0')}`;
  const out = await runSessions(['--config-dir', p.configDir, '--since', since], wide());
  assert.ok(dataRows(out).length >= 11, `expected >= 11 data rows, got ${dataRows(out).length}`);
});

test('viewer: invalid --since rejects with exit 1', async () => {
  const p = mkProfile();
  await assert.rejects(
    runSessions(['--config-dir', p.configDir, '--since', 'notadate'], wide()),
    /--since requires/
  );
});

test('viewer: per-session cost + budget-bar footer', async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-vc-'));
  tmpDirs.push(configDir);
  const proj = path.join(configDir, 'projects', 'p');
  fs.mkdirSync(proj, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(proj, 'sess1.jsonl'),
    JSON.stringify({ type: 'assistant', timestamp: now, message: { id: 'm1', model: 'claude-opus-4-8', usage: { input_tokens: 1000000 } } }) + '\n');
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-vx-'));
  tmpDirs.push(xdg);
  const out = await runSessions(['--config-dir', configDir], wide({ XDG_STATE_HOME: xdg }));
  assert.match(out, /\$\d+\.\d{2}/);              // a dollar amount on the row
  assert.match(out, /[▓░]/);                       // budget bar cells
  assert.match(out, /today.*\$\d+\.\d{2} \/ \$\d+\.\d{2}/); // "today … $spent / $limit"
});

test('viewer: budget opted out → plain footer, no bars', async () => {
  const p = mkProfile();
  writeTranscript(p.configDir, 'sessZZZ1', [{ type: 'ai-title', aiTitle: 'z' }]);
  const out = await runSessions(['--config-dir', p.configDir], wide({ STATUSLINE_MONTHLY_BUDGET: '0' }));
  assert.doesNotMatch(out, /[▓░]/);
  assert.match(out, /today \$\d+\.\d{2} · week /);
});

test('viewer detail: <prefix> renders the section headers + total', async () => {
  const p = mkProfile();
  const now = new Date().toISOString();
  writeTranscript(p.configDir, 'sessDET01', [
    { type: 'ai-title', aiTitle: 'Detail me' },
    { type: 'user', message: { role: 'user', content: 'do the thing' } },
    { type: 'assistant', timestamp: now, message: { id: 'd1', model: 'claude-opus-4-8', usage: { input_tokens: 1000000, output_tokens: 1000 } } },
  ]);
  const xdg = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'csl-det-'));
  const out = await runSessions(['--config-dir', p.configDir, 'sessDET'], wide({ XDG_STATE_HOME: xdg }));
  require('fs').rmSync(xdg, { recursive: true, force: true });
  assert.match(out, /SESSION sessDET01/);
  assert.match(out, /WHERE IT WENT/);
  assert.match(out, /WHAT FILLED CONTEXT/);
  assert.match(out, /session-overhead/); // synthetic consumer row renders
  assert.match(out, /BY MODEL/);
  assert.match(out, /TOP PROMPTS/);
  assert.match(out, /\$\d+\.\d{2} total/);
});

test('viewer detail: --analyze emits full-fidelity JSON', async () => {
  const p = mkProfile();
  const now = new Date().toISOString();
  writeTranscript(p.configDir, 'sessANL01', [
    { type: 'ai-title', aiTitle: 'Analyze me' },
    { type: 'user', message: { role: 'user', content: 'do the thing' } },
    { type: 'assistant', timestamp: now, message: { id: 'a1', model: 'claude-opus-4-8', usage: { input_tokens: 1000000, output_tokens: 1000 } } },
  ]);
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-anl-'));
  tmpDirs.push(xdg);
  const out = await runSessions(['--config-dir', p.configDir, 'sessANL', '--analyze'], wide({ XDG_STATE_HOME: xdg }));
  const j = JSON.parse(out); // must be valid JSON, not the rendered table
  assert.strictEqual(j.session, 'sessANL01');
  assert.strictEqual(j.title, 'Analyze me');
  assert.ok(j.totalCost > 0);
  assert.strictEqual(j.steps, 1);
  assert.match(j.legend, /cacheRead/);
  assert.ok(Array.isArray(j.turns) && j.turns.length === 1);
  assert.strictEqual(j.turns[0].prompt, 'do the thing');
  assert.ok(Array.isArray(j.calls) && j.calls.length === 1);
  assert.strictEqual(j.calls[0].tokens.input, 1000000); // raw integer preserved
});

test('viewer list: --analyze emits JSON session list, newest-first, with periods', async () => {
  const p = mkProfile();
  const now = Math.floor(Date.now() / 1000);
  writeTranscript(p.configDir, 'sessLST01', [
    { type: 'ai-title', aiTitle: 'older one' },
    { type: 'system', subtype: 'away_summary', content: 'did old stuff' },
  ], now - 7200);
  writeTranscript(p.configDir, 'sessLST02', [{ type: 'ai-title', aiTitle: 'newer one' }], now - 60);
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-lst-'));
  tmpDirs.push(xdg);
  const out = await runSessions(['--config-dir', p.configDir, '--analyze'], wide({ XDG_STATE_HOME: xdg }));
  const j = JSON.parse(out); // valid JSON, not the rendered list
  assert.strictEqual(j.sessions.length, 2);
  assert.strictEqual(j.sessions[0].session, 'sessLST02'); // newest first
  assert.strictEqual(j.sessions[0].title, 'newer one');
  assert.strictEqual(j.sessions[1].recap, 'did old stuff');
  assert.match(j.sessions[0].startedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(typeof j.sessions[0].cost === 'number');
  assert.ok(j.periods && typeof j.periods.month === 'number');
});

test('viewer list: --analyze honors --last', async () => {
  const p = mkProfile();
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 4; i++) {
    writeTranscript(p.configDir, `sessLC0${i}x`, [{ type: 'ai-title', aiTitle: `t${i}` }], now - i);
  }
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-lc-'));
  tmpDirs.push(xdg);
  const out = await runSessions(['--config-dir', p.configDir, '--analyze', '--last', '2'], wide({ XDG_STATE_HOME: xdg }));
  assert.strictEqual(JSON.parse(out).sessions.length, 2);
});

test('viewer list: --analyze on empty store → valid JSON, empty sessions', async () => {
  const p = mkProfile();
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-le-'));
  tmpDirs.push(xdg);
  const out = await runSessions(['--config-dir', p.configDir, '--analyze'], wide({ XDG_STATE_HOME: xdg }));
  assert.deepStrictEqual(JSON.parse(out).sessions, []);
});

test('viewer detail: unknown prefix → exit 1', async () => {
  const p = mkProfile();
  writeTranscript(p.configDir, 'sessXYZ01', [{ type: 'ai-title', aiTitle: 'x' }]);
  await assert.rejects(
    runSessions(['--config-dir', p.configDir, 'nope'], wide()),
    /no session matching/
  );
});

test('viewer detail: ambiguous prefix → exit 1 listing matches', async () => {
  const p = mkProfile();
  writeTranscript(p.configDir, 'sessAMB01', [{ type: 'ai-title', aiTitle: 'a' }]);
  writeTranscript(p.configDir, 'sessAMB02', [{ type: 'ai-title', aiTitle: 'b' }]);
  await assert.rejects(
    runSessions(['--config-dir', p.configDir, 'sessAMB'], wide()),
    /ambiguous/
  );
});
