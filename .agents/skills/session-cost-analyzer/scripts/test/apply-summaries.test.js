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
  summary: {
    contextConsumers: {
      top: [
        { tool: 'Read', target: '/a/render-report.js', estTokens: 5000 },
        { tool: 'Bash', target: 'node --test scripts/test/*.test.js', estTokens: 3000 },
      ],
    },
  },
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

test('apply-summaries: namespaced map fills turns and consumers independently', async () => {
  const f = path.join(os.tmpdir(), `sca-sum-ns-${process.pid}.json`);
  fs.writeFileSync(f, JSON.stringify({
    turns: { '2': 'Applied edits' },
    consumers: { '0': 'The HTML report renderer', '1': 'Ran the full test suite' },
  }));
  try {
    const out = JSON.parse(await run(JSON.stringify(payload()), ['--summaries', f]));
    assert.strictEqual(out.turns[1].summary, 'Applied edits');
    const top = out.summary.contextConsumers.top;
    assert.strictEqual(top[0].summary, 'The HTML report renderer');
    assert.strictEqual(top[1].summary, 'Ran the full test suite');
  } finally { fs.rmSync(f, { force: true }); }
});

test('apply-summaries: tips list lands at summary.aiTips, normalized and capped', async () => {
  const f = path.join(os.tmpdir(), `sca-sum-tips-${process.pid}.json`);
  fs.writeFileSync(f, JSON.stringify({
    tips: [
      { head: 'Session grade: B  ', body: '  Context ran hot   for most of it. ' },
      { title: 'Costliest skill', text: 'write-a-skill drove most of the spend.' },
      'plain string tip',
      { head: '', body: '' },              // empty → dropped
      42,                                   // non-object → dropped
    ],
  }));
  try {
    const out = JSON.parse(await run(JSON.stringify(payload()), ['--summaries', f]));
    const tips = out.summary.aiTips;
    assert.strictEqual(tips.length, 3);
    assert.deepStrictEqual(tips[0], { head: 'Session grade: B', body: 'Context ran hot for most of it.' });
    assert.deepStrictEqual(tips[1], { head: 'Costliest skill', body: 'write-a-skill drove most of the spend.' });
    assert.deepStrictEqual(tips[2], { head: '', body: 'plain string tip' });
  } finally { fs.rmSync(f, { force: true }); }
});

test('apply-summaries: no tips key → summary.aiTips is never added', async () => {
  const f = path.join(os.tmpdir(), `sca-sum-notips-${process.pid}.json`);
  fs.writeFileSync(f, JSON.stringify({ turns: { '1': 'x' } }));
  try {
    const out = JSON.parse(await run(JSON.stringify(payload()), ['--summaries', f]));
    assert.ok(!('aiTips' in out.summary), 'aiTips absent when tips not provided');
  } finally { fs.rmSync(f, { force: true }); }
});

test('apply-summaries: flat map (legacy) touches turns only, never consumers', async () => {
  await withTmp({ '1': 'Authored a skill', __n: 9 }, async (f) => {
    const out = JSON.parse(await run(JSON.stringify(payload()), ['--summaries', f]));
    assert.strictEqual(out.turns[0].summary, 'Authored a skill');
    assert.ok(!('summary' in out.summary.contextConsumers.top[0]), 'consumers untouched by flat map');
  });
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
