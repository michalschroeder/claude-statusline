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

test('buildDetail: subagent cost split out', () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-sd4-'));
  tmp.push(cfg);
  const main = path.join(cfg, 'projects', 'p', 'sessDDD1.jsonl');
  const sub = path.join(cfg, 'projects', 'p', 'sessDDD1', 'subagents', 'agent-x1.jsonl');
  writeJsonl(main, [userPrompt('p'), asst('m1', { input_tokens: 1000, output_tokens: 200 })], '2026-06-09T01:00:00Z');
  writeJsonl(sub, [asst('s1', { input_tokens: 2000, output_tokens: 400 })], '2026-06-09T01:05:00Z');
  const detail = buildDetail(main, [sub], pricing());
  assert.equal(detail.subagentCount, 1);
  assert.ok(detail.subagentTotal > 0);
  const names = detail.byAgent.map((a) => a.name);
  assert.ok(names.includes('main'));
  assert.ok(names.includes('agent-x1'));
  // subagent cost is in the total but NOT in topPrompts
  assert.ok(!detail.topPrompts.some((p) => p.cost === detail.subagentTotal && p.text !== 'p'));
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
