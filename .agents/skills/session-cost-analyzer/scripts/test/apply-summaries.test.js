'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'apply-summaries.js');

// Run apply-summaries.js with `stdinText` on stdin and the given argv; resolve stdout.
function run(stdinText, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [SCRIPT, ...args]);
    let out = '', err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('close', (code) => code === 0 ? resolve(out) : reject(new Error(err)));
    proc.stdin.write(stdinText);
    proc.stdin.end();
  });
}

const payload = () => ({
  session: 's',
  turns: [
    { turnIndex: 1, kind: 'skill', prompt: 'x', cost: 3 },
    { turnIndex: 2, kind: 'user', prompt: 'do it', cost: 2 },
    { turnIndex: 3, kind: 'subagent-orchestration', prompt: '<task-notification>', cost: 1 },
  ],
});

function withTmp(obj, fn) {
  const f = path.join(os.tmpdir(), `sca-sum-${process.pid}-${Math.round(obj.__n || 0)}.json`);
  fs.writeFileSync(f, JSON.stringify(obj));
  return fn(f).finally(() => fs.rmSync(f, { force: true }));
}

test('apply-summaries: object map keyed by turnIndex fills turns[].summary', async () => {
  await withTmp({ '1': 'Authored a skill', '2': 'Applied edits', __n: 1 }, async (f) => {
    const out = JSON.parse(await run(JSON.stringify(payload()), ['--summaries', f]));
    assert.strictEqual(out.turns[0].summary, 'Authored a skill');
    assert.strictEqual(out.turns[1].summary, 'Applied edits');
    assert.ok(!('summary' in out.turns[2]), 'unmatched turn left untouched');
  });
});

test('apply-summaries: array-of-records shape is accepted too', async () => {
  const arr = path.join(os.tmpdir(), `sca-sum-arr-${process.pid}.json`);
  fs.writeFileSync(arr, JSON.stringify([{ turnIndex: 3, summary: 'Processed subagent output' }]));
  try {
    const out = JSON.parse(await run(JSON.stringify(payload()), ['--summaries', arr]));
    assert.strictEqual(out.turns[2].summary, 'Processed subagent output');
  } finally { fs.rmSync(arr, { force: true }); }
});

test('apply-summaries: missing --summaries → payload passes through unchanged', async () => {
  const out = JSON.parse(await run(JSON.stringify(payload()), []));
  assert.deepStrictEqual(out, payload());
});

test('apply-summaries: unreadable summaries file → passthrough, not a crash', async () => {
  const out = JSON.parse(await run(JSON.stringify(payload()), ['--summaries', '/no/such/file.json']));
  assert.deepStrictEqual(out, payload());
});

test('apply-summaries: non-JSON stdin is echoed verbatim', async () => {
  const out = await run('not json', []);
  assert.strictEqual(out, 'not json');
});
