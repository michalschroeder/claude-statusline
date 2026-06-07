'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readTitleRecap, findTranscript, listSessions } = require('../lib/transcript');

const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

function mkJsonl(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-tr-'));
  tmpDirs.push(dir);
  const fp = path.join(dir, 's.jsonl');
  fs.writeFileSync(fp, lines.map((o) => (typeof o === 'string' ? o : JSON.stringify(o))).join('\n') + '\n');
  return fp;
}

test('readTitleRecap: takes LAST ai-title and LAST away_summary, strips disclaimer', () => {
  const fp = mkJsonl([
    { type: 'ai-title', aiTitle: 'First title' },
    { type: 'user', text: 'noise' },
    { type: 'system', subtype: 'away_summary', content: 'Old recap (disable recaps in /config)' },
    { type: 'ai-title', aiTitle: 'Final title' },
    { type: 'system', subtype: 'away_summary', content: 'Latest recap (disable recaps in /config)' },
  ]);
  assert.deepStrictEqual(readTitleRecap(fp), { title: 'Final title', recap: 'Latest recap' });
});

test('readTitleRecap: title only → recap null', () => {
  const fp = mkJsonl([{ type: 'ai-title', aiTitle: 'Only title' }]);
  assert.deepStrictEqual(readTitleRecap(fp), { title: 'Only title', recap: null });
});

test('readTitleRecap: recap only → title null', () => {
  const fp = mkJsonl([{ type: 'system', subtype: 'away_summary', content: 'A recap (disable recaps in /config)' }]);
  assert.deepStrictEqual(readTitleRecap(fp), { title: null, recap: 'A recap' });
});

test('readTitleRecap: neither → both null', () => {
  const fp = mkJsonl([{ type: 'user', text: 'hi' }]);
  assert.deepStrictEqual(readTitleRecap(fp), { title: null, recap: null });
});

test('readTitleRecap: tolerates unparseable lines', () => {
  const fp = mkJsonl([
    'not json at all',
    { type: 'ai-title', aiTitle: 'Survives' },
    '{ broken json',
  ]);
  assert.deepStrictEqual(readTitleRecap(fp), { title: 'Survives', recap: null });
});

test('readTitleRecap: collapses newlines/whitespace so the table row stays single-line', () => {
  const fp = mkJsonl([
    { type: 'ai-title', aiTitle: 'Multi\nline\ttitle' },
    { type: 'system', subtype: 'away_summary', content: 'First line\n\nSecond  line\t(disable recaps in /config)' },
  ]);
  assert.deepStrictEqual(readTitleRecap(fp), {
    title: 'Multi line title',
    recap: 'First line Second line',
  });
});

test('readTitleRecap: recap without disclaimer left intact', () => {
  const fp = mkJsonl([{ type: 'system', subtype: 'away_summary', content: 'Bare recap' }]);
  assert.strictEqual(readTitleRecap(fp).recap, 'Bare recap');
});

function mkRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-root-'));
  tmpDirs.push(dir);
  return dir;
}

test('findTranscript: finds <id>.jsonl under projects/<enc>/', () => {
  const root = mkRoot();
  const proj = path.join(root, 'projects', '-home-u-repo');
  fs.mkdirSync(proj, { recursive: true });
  const fp = path.join(proj, 'abc123.jsonl');
  fs.writeFileSync(fp, '{}\n');
  assert.strictEqual(findTranscript(root, 'abc123'), fp);
});

test('findTranscript: excludes subagent transcripts', () => {
  const root = mkRoot();
  const sub = path.join(root, 'projects', '-home-u-repo', 'sessX', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'abc123.jsonl'), '{}\n');
  // findTranscript only probes projects/<enc>/<id>.jsonl directly, so any deeper
  // subagent path is excluded by construction (limited search depth, not active filtering).
  assert.strictEqual(findTranscript(root, 'abc123'), null);
});

test('findTranscript: direct child of enc dir IS found (depth boundary)', () => {
  const root = mkRoot();
  const proj = path.join(root, 'projects', '-home-u-repo');
  fs.mkdirSync(proj, { recursive: true });
  const fp = path.join(proj, 'depthcheck.jsonl');
  fs.writeFileSync(fp, '{}\n');
  assert.strictEqual(findTranscript(root, 'depthcheck'), fp);
});

test('findTranscript: not found → null', () => {
  const root = mkRoot();
  fs.mkdirSync(path.join(root, 'projects'), { recursive: true });
  assert.strictEqual(findTranscript(root, 'nope'), null);
});

test('findTranscript: missing projects/ → null', () => {
  const root = mkRoot();
  assert.strictEqual(findTranscript(root, 'x'), null);
});

// Write projects/<enc>/<id>.jsonl under a root and set its mtime (unix seconds).
function seedTranscript(root, enc, id, ts) {
  const proj = path.join(root, 'projects', enc);
  fs.mkdirSync(proj, { recursive: true });
  const fp = path.join(proj, `${id}.jsonl`);
  fs.writeFileSync(fp, '{}\n');
  if (ts != null) fs.utimesSync(fp, new Date(ts * 1000), new Date(ts * 1000));
  return fp;
}

test('listSessions: enumerates transcripts newest-first by mtime, returns id/ts/file', () => {
  const root = mkRoot();
  const now = Math.floor(Date.now() / 1000);
  const older = seedTranscript(root, '-a', 'sessOld', now - 3600);
  const newer = seedTranscript(root, '-a', 'sessNew', now - 60);
  const out = listSessions(root);
  assert.deepStrictEqual(out.map((s) => s.id), ['sessNew', 'sessOld']);
  assert.strictEqual(out[0].file, newer);
  assert.strictEqual(out[1].file, older);
  assert.strictEqual(out[0].ts, now - 60);
});

test('listSessions: dedupes a session id across project dirs, keeping the newest file', () => {
  const root = mkRoot();
  const now = Math.floor(Date.now() / 1000);
  seedTranscript(root, '-dir-a', 'dup', now - 7200);
  const newer = seedTranscript(root, '-dir-b', 'dup', now - 30);
  const out = listSessions(root);
  assert.strictEqual(out.length, 1, 'one row per session id');
  assert.strictEqual(out[0].file, newer, 'keeps the newest of the two');
  assert.strictEqual(out[0].ts, now - 30);
});

test('listSessions: skips a file literally named .jsonl (empty id)', () => {
  const root = mkRoot();
  seedTranscript(root, '-a', '', Math.floor(Date.now() / 1000)); // → ".jsonl"
  assert.deepStrictEqual(listSessions(root), []);
});

test('listSessions: excludes subagent transcripts and missing projects/', () => {
  const root = mkRoot();
  const sub = path.join(root, 'projects', '-a', 'sessX', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'sub123.jsonl'), '{}\n'); // nested → excluded
  assert.deepStrictEqual(listSessions(root).map((s) => s.id), []);
  assert.deepStrictEqual(listSessions(mkRoot()), []); // no projects/ → empty
});
