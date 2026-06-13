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

// Write `content` to a unique tmp file, run `fn(path)`, always clean up.
let tmpN = 0;
function withTmp(content, fn) {
  const f = path.join(os.tmpdir(), `sca-sum-${process.pid}-${tmpN++}.json`);
  fs.writeFileSync(f, JSON.stringify(content));
  return fn(f).finally(() => fs.rmSync(f, { force: true }));
}

test('apply-summaries: object map keyed by turnIndex fills turns[].summary', async () => {
  await withTmp({ '1': 'Authored a skill', '2': 'Applied edits' }, async (f) => {
    const out = JSON.parse(await run(JSON.stringify(payload()), ['--summaries', f]));
    assert.strictEqual(out.turns[0].summary, 'Authored a skill');
    assert.strictEqual(out.turns[1].summary, 'Applied edits');
    assert.ok(!('summary' in out.turns[2]), 'unmatched turn left untouched');
  });
});

test('apply-summaries: array-of-records shape is accepted too', async () => {
  await withTmp([{ turnIndex: 3, summary: 'Processed subagent output' }], async (f) => {
    const out = JSON.parse(await run(JSON.stringify(payload()), ['--summaries', f]));
    assert.strictEqual(out.turns[2].summary, 'Processed subagent output');
  });
});

test('apply-summaries: namespaced map fills turns and consumers independently', async () => {
  await withTmp({
    turns: { '2': 'Applied edits' },
    consumers: { '0': 'The HTML report renderer', '1': 'Ran the full test suite' },
  }, async (f) => {
    const out = JSON.parse(await run(JSON.stringify(payload()), ['--summaries', f]));
    assert.strictEqual(out.turns[1].summary, 'Applied edits');
    const top = out.summary.contextConsumers.top;
    assert.strictEqual(top[0].summary, 'The HTML report renderer');
    assert.strictEqual(top[1].summary, 'Ran the full test suite');
  });
});

test('apply-summaries: rich tips land at summary.aiAssessment, normalized and capped', async () => {
  await withTmp({
    tips: {
      rating: 2,
      headline: '  Context ran hot   for most of it. ',
      cards: [
        { verdict: 'BAD', title: 'Kept context huge  ', what: '  $3 above 200k. ', why: 're-reads', how: 'compact' },
        { verdict: 'strength', title: 'Offloaded reads', what: 'subagents did the heavy lifting' },
        { verdict: 'mystery', title: 'Unknown verdict', what: 'defaults to warn' },
        'a bare string card',
        { title: '', what: '', why: '', how: '' },   // empty → dropped
        42,                                            // non-object → dropped
      ],
    },
  }, async (f) => {
    const out = JSON.parse(await run(JSON.stringify(payload()), ['--summaries', f]));
    const a = out.summary.aiAssessment;
    assert.strictEqual(a.rating, 2);
    assert.strictEqual(a.headline, 'Context ran hot for most of it.');
    assert.strictEqual(a.cards.length, 4);
    assert.deepStrictEqual(a.cards[0], { verdict: 'bad', title: 'Kept context huge', what: '$3 above 200k.', why: 're-reads', how: 'compact' });
    assert.strictEqual(a.cards[1].verdict, 'good');           // 'strength' → good
    assert.strictEqual(a.cards[2].verdict, 'warn');           // unknown → warn
    assert.deepStrictEqual(a.cards[3], { verdict: 'warn', title: '', what: 'a bare string card', why: '', how: '' });
  });
});

test('apply-summaries: out-of-range rating → null, cards still land', async () => {
  await withTmp({ tips: { rating: 9, cards: [{ verdict: 'good', title: 'ok', what: 'fine' }] } }, async (f) => {
    const out = JSON.parse(await run(JSON.stringify(payload()), ['--summaries', f]));
    assert.strictEqual(out.summary.aiAssessment.rating, null);
    assert.strictEqual(out.summary.aiAssessment.cards.length, 1);
  });
});

test('apply-summaries: legacy tips LIST of {head,body} → what-only warn cards', async () => {
  await withTmp({ tips: [{ head: 'Costliest skill', body: 'write-a-skill drove the spend.' }] }, async (f) => {
    const out = JSON.parse(await run(JSON.stringify(payload()), ['--summaries', f]));
    const a = out.summary.aiAssessment;
    assert.strictEqual(a.rating, null);
    assert.deepStrictEqual(a.cards[0], { verdict: 'warn', title: 'Costliest skill', what: 'write-a-skill drove the spend.', why: '', how: '' });
  });
});

test('apply-summaries: no tips key → summary.aiAssessment is never added', async () => {
  await withTmp({ turns: { '1': 'x' } }, async (f) => {
    const out = JSON.parse(await run(JSON.stringify(payload()), ['--summaries', f]));
    assert.ok(!('aiAssessment' in out.summary), 'aiAssessment absent when tips not provided');
  });
});

test('apply-summaries: flat map (legacy) touches turns only, never consumers', async () => {
  await withTmp({ '1': 'Authored a skill' }, async (f) => {
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

test('apply-summaries: zero-entry summaries file → output bytes identical to input', async () => {
  await withTmp({ turns: {}, consumers: {}, tips: [] }, async (f) => {
    const input = JSON.stringify(payload()); // compact, unlike the re-serialized pretty form
    const out = await run(input, ['--summaries', f]);
    assert.strictEqual(out, input);
  });
});

test('apply-summaries: non-JSON stdin is echoed verbatim', async () => {
  const out = await run('not json', []);
  assert.strictEqual(out, 'not json');
});
