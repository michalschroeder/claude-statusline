'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promptText, buildDetail } = require('../lib/session-detail');
const { loadPricing } = require('../lib/pricing');
const { aggregate } = require('../lib/cost-aggregate');

const tmp = [];
after(() => { for (const d of tmp) fs.rmSync(d, { recursive: true, force: true }); });

// Bundled-snapshot pricing, offline.
function pricing() {
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-sd-px-'));
  tmp.push(xdg);
  return loadPricing(xdg, { allowFetch: false });
}

const MODEL = 'claude-opus-4-8'; // present in data/model_prices.json
const asst = (id, usage, ts) => ({ type: 'assistant', timestamp: ts || '2026-06-09T01:00:00Z', message: { id, model: MODEL, usage } });
const userPrompt = (text) => ({ type: 'user', message: { role: 'user', content: text } });
const toolResult = () => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } });

function writeJsonl(file, entries, mtime) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  if (mtime != null) { const d = new Date(mtime); fs.utimesSync(file, d, d); }
}

test('promptText: genuine prompt vs tool result vs slash command', () => {
  assert.equal(promptText(userPrompt('hello there')), 'hello there');
  assert.equal(promptText(toolResult()), null); // tool result is not a prompt
  assert.equal(promptText({ type: 'assistant', message: {} }), null);
  const cmd = { type: 'user', message: { role: 'user', content: '<command-name>/simplify</command-name>\n<command-message>x</command-message>' } };
  assert.equal(promptText(cmd), '/simplify');
});

test('buildDetail: total matches aggregate over the same session', () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-sd-'));
  tmp.push(cfg);
  const main = path.join(cfg, 'projects', 'p', 'sessAAA1.jsonl');
  writeJsonl(main, [
    userPrompt('first prompt'),
    asst('m1', { input_tokens: 1000, output_tokens: 200 }),
    asst('m2', { input_tokens: 500, cache_read_input_tokens: 4000 }),
  ]);
  const px = pricing();
  const agg = aggregate(cfg, px);
  const detail = buildDetail(main, [], px);
  assert.ok(detail.total > 0);
  assert.equal(detail.total.toFixed(8), agg.perSession.sessAAA1.total.toFixed(8));
  assert.equal(detail.calls, 2);
});

test('buildDetail: components sum to total; byModel aggregates', () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-sd2-'));
  tmp.push(cfg);
  const main = path.join(cfg, 'projects', 'p', 'sessBBB1.jsonl');
  writeJsonl(main, [
    userPrompt('p'),
    asst('m1', { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000 }),
  ]);
  const detail = buildDetail(main, [], pricing());
  const c = detail.components;
  assert.equal((c.input + c.output + c.cacheWrite + c.cacheRead + c.web).toFixed(8), detail.total.toFixed(8));
  assert.equal(detail.byModel.length, 1);
  assert.equal(detail.byModel[0].model, MODEL);
  assert.equal(detail.byModel[0].calls, 1);
});

test('buildDetail: turn attribution — calls bucket under active prompt, tool results do not start one', () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-sd3-'));
  tmp.push(cfg);
  const main = path.join(cfg, 'projects', 'p', 'sessCCC1.jsonl');
  writeJsonl(main, [
    asst('m0', { input_tokens: 100 }),               // before any prompt → (session start)
    userPrompt('big task'),
    asst('m1', { input_tokens: 10000, output_tokens: 4000 }),
    toolResult(),                                    // must NOT become a prompt
    asst('m2', { input_tokens: 8000, output_tokens: 2000 }),
    userPrompt('small task'),
    asst('m3', { input_tokens: 100 }),
  ]);
  const detail = buildDetail(main, [], pricing());
  const texts = detail.topPrompts.map((p) => p.text);
  assert.ok(texts.includes('big task'));
  assert.ok(texts.includes('(session start)'));
  const big = detail.topPrompts.find((p) => p.text === 'big task');
  assert.equal(big.calls, 2); // m1 + m2 (tool result did not split the turn)
});

test('buildDetail: topPrompts carry ctx/out tokens and a tool tally', () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-sdt-'));
  tmp.push(cfg);
  const main = path.join(cfg, 'projects', 'p', 'sessTLS1.jsonl');
  const withTools = (id, usage, names) => ({
    type: 'assistant', timestamp: '2026-06-09T01:00:00Z',
    message: { id, model: MODEL, usage, content: names.map((n) => ({ type: 'tool_use', name: n })) },
  });
  writeJsonl(main, [
    userPrompt('do work'),
    withTools('m1', { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 50000, cache_creation_input_tokens: 3000 }, ['Read', 'Bash', 'Bash']),
    withTools('m2', { input_tokens: 1000, output_tokens: 300, cache_read_input_tokens: 70000, cache_creation_input_tokens: 5000 }, ['Bash', 'Edit']),
  ]);
  const detail = buildDetail(main, [], pricing());
  const p = detail.topPrompts.find((x) => x.text === 'do work');
  assert.equal(p.inp, 2000);              // 1000 + 1000 fresh input
  assert.equal(p.ctx, 120000);            // 50k + 70k cache-read re-read across the turn
  assert.equal(p.cw, 8000);               // 3000 + 5000 cache-write
  assert.equal(p.out, 500);               // 200 + 300 output
  assert.deepEqual(p.tools, [['Bash', 3], ['Read', 1], ['Edit', 1]]); // desc by count
});

test('buildDetail: turns + perCall keep execution order and raw token fidelity', () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-sdo-'));
  tmp.push(cfg);
  const main = path.join(cfg, 'projects', 'p', 'sessORD1.jsonl');
  writeJsonl(main, [
    userPrompt('first'),
    asst('m1', { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 40000 }),
    userPrompt('second'),
    asst('m2', { input_tokens: 1000, output_tokens: 300, cache_read_input_tokens: 900000 }), // context ballooned
  ]);
  const detail = buildDetail(main, [], pricing());
  // turns in EXECUTION order (not cost) — second is costlier but stays second
  assert.deepEqual(detail.turns.map((t) => t.prompt), ['first', 'second']);
  assert.equal(detail.turns[1].tokens.cacheRead, 900000); // raw integer, not compacted
  // perCall is one record per billed call, chronological, with raw per-call ctx
  assert.equal(detail.perCall.length, 2);
  assert.equal(detail.perCall[0].tokens.cacheRead, 40000);
  assert.equal(detail.perCall[1].tokens.cacheRead, 900000);
  assert.equal(detail.perCall[0].prompt, 'first');
  assert.ok(detail.perCall[1].cost > detail.perCall[0].cost);
});

test('buildDetail: summary + per-turn context fix the growth-misread', () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-sum-'));
  tmp.push(cfg);
  const main = path.join(cfg, 'projects', 'p', 'sessSUM1.jsonl');
  const at = (id, ctx, t) => asst(id, { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: ctx, cache_creation_input_tokens: 1000 }, t);
  writeJsonl(main, [
    userPrompt('work'),
    at('m1', 40000, '2026-06-09T01:00:00Z'),
    at('m2', 200000, '2026-06-09T01:10:00Z'),  // same turn — context grew within it
    { type: 'user', message: { role: 'user', content: '<task-notification> done </task-notification>' } },
    at('m3', 300000, '2026-06-09T01:20:00Z'),  // a subagent-orchestration turn
  ]);
  const detail = buildDetail(main, [], pricing());
  const work = detail.turns.find((t) => t.prompt === 'work');
  // per-turn context is per-step, not the SUM (which would be 240000)
  assert.equal(work.tokens.cacheRead, 240000);   // sum across the 2 steps
  assert.equal(work.avgContext, 120000);         // (40k + 200k) / 2
  assert.equal(work.peakContext, 200000);        // max step, not the sum
  assert.equal(work.kind, 'user');
  // turn-kind classification
  const orch = detail.turns.find((t) => t.kind === 'subagent-orchestration');
  assert.ok(orch && orch.prompt.startsWith('<task-notification>'));
  // summary: duration spans first→last main call; growth curve is per-step
  const s = detail.summary;
  assert.equal(s.durationMs, 20 * 60 * 1000);    // 01:00 → 01:20
  assert.equal(s.contextGrowth.firstCall, 40000);
  assert.equal(s.contextGrowth.peakContext, 300000);
  assert.equal(s.contextGrowth.quartileAvgContext.length, 4);
  // byTurnKind aggregates cost per kind, cost-desc
  const kinds = s.byTurnKind.map((k) => k.kind);
  assert.ok(kinds.includes('user') && kinds.includes('subagent-orchestration'));
  assert.equal(s.byTurnKind.reduce((a, k) => a + k.cost, 0).toFixed(8), detail.total.toFixed(8));
});

test('buildDetail: subagent cost split out', () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-sd4-'));
  tmp.push(cfg);
  const main = path.join(cfg, 'projects', 'p', 'sessDDD1.jsonl');
  const sub = path.join(cfg, 'projects', 'p', 'sessDDD1', 'subagents', 'agent-x1.jsonl');
  writeJsonl(main, [userPrompt('p'), asst('m1', { input_tokens: 1000, output_tokens: 200 })], '2026-06-09T01:00:00Z');
  writeJsonl(sub, [userPrompt('investigate the failing build'), asst('s1', { input_tokens: 2000, output_tokens: 400 })], '2026-06-09T01:05:00Z');
  const detail = buildDetail(main, [sub], pricing());
  assert.equal(detail.subagentCount, 1);
  assert.ok(detail.subagentTotal > 0);
  const names = detail.byAgent.map((a) => a.name);
  assert.ok(names.includes('main'));
  assert.ok(names.includes('agent-x1'));
  // byAgent carries a human-meaningful label: main → 'main session', subagent → its task
  assert.equal(detail.byAgent.find((a) => a.name === 'main').label, 'main session');
  assert.equal(detail.byAgent.find((a) => a.name === 'agent-x1').label, 'investigate the failing build');
  // subagent cost is in the total but NOT in topPrompts
  assert.ok(!detail.topPrompts.some((p) => p.cost === detail.subagentTotal && p.text !== 'p'));
});

test('buildDetail: subagent label falls back to the agent stem when it has no prompt', () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-sd6-'));
  tmp.push(cfg);
  const main = path.join(cfg, 'projects', 'p', 'sessFFF1.jsonl');
  const sub = path.join(cfg, 'projects', 'p', 'sessFFF1', 'subagents', 'agent-z9.jsonl');
  writeJsonl(main, [userPrompt('p'), asst('m1', { input_tokens: 1000 })], '2026-06-09T01:00:00Z');
  writeJsonl(sub, [asst('s1', { input_tokens: 2000 })], '2026-06-09T01:05:00Z'); // no user prompt
  const detail = buildDetail(main, [sub], pricing());
  assert.equal(detail.byAgent.find((a) => a.name === 'agent-z9').label, 'agent-z9');
});

test('buildDetail: empty/unbilled session → zeros, no crash', () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-sd5-'));
  tmp.push(cfg);
  const main = path.join(cfg, 'projects', 'p', 'sessEEE1.jsonl');
  writeJsonl(main, [userPrompt('hi'), { type: 'user', message: { role: 'user', content: 'no assistant calls' } }]);
  const detail = buildDetail(main, [], pricing());
  assert.equal(detail.total, 0);
  assert.equal(detail.calls, 0);
  assert.deepEqual(detail.byModel, []);
  assert.deepEqual(detail.topPrompts, []);
});
