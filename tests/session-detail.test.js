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
  const texts = detail.turns.map((p) => p.prompt);
  assert.ok(texts.includes('big task'));
  assert.ok(texts.includes('(session start)'));
  const big = detail.turns.find((p) => p.prompt === 'big task');
  assert.equal(big.steps, 2); // m1 + m2 (tool result did not split the turn)
});

test('buildDetail: undated billable call is dropped (parity with list COST)', () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-sd-und-'));
  tmp.push(cfg);
  const main = path.join(cfg, 'projects', 'p', 'sessUND1.jsonl');
  writeJsonl(main, [
    userPrompt('p'),
    asst('m1', { input_tokens: 1000, output_tokens: 200 }),
    // no timestamp → cost-aggregate drops it when bucketing, so buildDetail must too
    { type: 'assistant', message: { id: 'm2', model: MODEL, usage: { input_tokens: 9999, output_tokens: 9999, cache_read_input_tokens: 90000 } } },
  ]);
  const px = pricing();
  const agg = aggregate(cfg, px);
  const detail = buildDetail(main, [], px);
  assert.equal(detail.calls, 1); // m2 dropped — not counted
  assert.equal(detail.total.toFixed(8), agg.perSession.sessUND1.total.toFixed(8));
});

test('buildDetail: repeated identical prompt text stays two distinct turns', () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-sd-rep-'));
  tmp.push(cfg);
  const main = path.join(cfg, 'projects', 'p', 'sessREP1.jsonl');
  writeJsonl(main, [
    userPrompt('continue'),
    asst('m1', { input_tokens: 1000, output_tokens: 100 }),
    userPrompt('continue'),
    asst('m2', { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 5000 }),
  ]);
  const detail = buildDetail(main, [], pricing());
  const conts = detail.turns.filter((t) => t.prompt === 'continue');
  assert.equal(conts.length, 2); // keyed on turn index, not text → not merged
  assert.notEqual(conts[0].turnIndex, conts[1].turnIndex);
  // perCall carries the turn it served, so renderers group structurally
  const mainCalls = detail.perCall.filter((c) => c.isMain);
  assert.equal(mainCalls.length, 2);
  assert.notEqual(mainCalls[0].turnIndex, mainCalls[1].turnIndex);
});

test('buildDetail: summary.mainSteps counts main calls only; detail.calls includes subagents', () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-sd-ms-'));
  tmp.push(cfg);
  const id = 'sessMS01';
  const main = path.join(cfg, 'projects', 'p', id + '.jsonl');
  const sub = path.join(cfg, 'projects', 'p', id, 'subagents', 'agent-x.jsonl');
  writeJsonl(main, [
    userPrompt('p'),
    asst('m1', { input_tokens: 1000, output_tokens: 100 }),
    asst('m2', { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 5000 }),
  ], 2000); // main is the newest write → sorts last, exercising seq/mainStep alignment
  writeJsonl(sub, [
    userPrompt('sub task'),
    asst('s1', { input_tokens: 1000, output_tokens: 100 }),
  ], 1000);
  const detail = buildDetail(main, [sub], pricing());
  assert.equal(detail.summary.mainSteps, 2); // main-only denominator
  assert.equal(detail.calls, 3);             // 2 main + 1 subagent billed call
});

test('buildDetail: turns carry ctx/out tokens and a tool tally', () => {
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
  const p = detail.turns.find((x) => x.prompt === 'do work');
  assert.equal(p.tokens.input, 2000);      // 1000 + 1000 fresh input
  assert.equal(p.tokens.cacheRead, 120000); // 50k + 70k cache-read re-read across the turn
  assert.equal(p.tokens.cacheWrite, 8000); // 3000 + 5000 cache-write
  assert.equal(p.tokens.output, 500);      // 200 + 300 output
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
  const at = (id, ctx, t, tools) => ({
    type: 'assistant', timestamp: t,
    message: { id, model: MODEL, usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: ctx, cache_creation_input_tokens: 1000 }, content: (tools || []).map((n) => ({ type: 'tool_use', name: n })) },
  });
  writeJsonl(main, [
    userPrompt('work'),
    at('m1', 40000, '2026-06-09T01:00:00Z', ['Bash']),
    at('m2', 250000, '2026-06-09T01:10:00Z', ['Bash', 'Read']),  // same turn — context grew past 200k
    { type: 'user', message: { role: 'user', content: '<task-notification> done </task-notification>' } },
    at('m3', 30000, '2026-06-09T01:20:00Z', ['Bash']),  // context reset (250k → 30k drop)
  ]);
  const detail = buildDetail(main, [], pricing());
  const work = detail.turns.find((t) => t.prompt === 'work');
  // per-turn context is per-step, not the SUM (which would be 290000)
  assert.equal(work.tokens.cacheRead, 290000);   // sum across the 2 steps
  assert.equal(work.avgContext, 145000);         // (40k + 250k) / 2
  assert.equal(work.peakContext, 250000);        // max step, not the sum
  assert.equal(work.kind, 'user');
  // turn-kind classification
  const orch = detail.turns.find((t) => t.kind === 'subagent-orchestration');
  assert.ok(orch && orch.prompt.startsWith('<task-notification>'));
  // summary: duration spans first→last main call; growth curve is per-step
  const s = detail.summary;
  assert.equal(s.durationMs, 20 * 60 * 1000);    // 01:00 → 01:20
  assert.equal(s.contextGrowth.firstCall, 40000);
  assert.equal(s.contextGrowth.peakContext, 250000);
  assert.equal(s.contextGrowth.quartileAvgContext.length, 4);
  // byTurnKind aggregates cost per kind, cost-desc
  const kinds = s.byTurnKind.map((k) => k.kind);
  assert.ok(kinds.includes('user') && kinds.includes('subagent-orchestration'));
  assert.equal(s.byTurnKind.reduce((a, k) => a + k.cost, 0).toFixed(8), detail.total.toFixed(8));
  // toolTally: canonical counts (Bash×3 across the 3 calls, Read×1), desc
  assert.deepEqual(s.toolTally, [['Bash', 3], ['Read', 1]]);
  // highContextCost: only m2 (250k) is above the 200k threshold
  assert.equal(s.highContextCost.thresholdTokens, 200000);
  assert.equal(s.highContextCost.calls, 1);
  assert.ok(s.highContextCost.cost > 0);
  // contextResets: the 250k → 30k drop counts as one reset
  assert.equal(s.contextResets, 1);
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
  // subagent cost is in the total but NOT in the main-session turns
  assert.ok(!detail.turns.some((p) => p.cost === detail.subagentTotal && p.prompt !== 'p'));
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
  assert.deepEqual(detail.turns, []);
});

test('buildDetail: contextConsumers attributes tool results to concrete targets', () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-sd6-'));
  tmp.push(cfg);
  const main = path.join(cfg, 'projects', 'p', 'sessGGG1.jsonl');
  const bigRead = 'x'.repeat(8000); // → ~2000 est tokens
  writeJsonl(main, [
    userPrompt('analyze the file'),
    { type: 'assistant', timestamp: '2026-06-09T01:00:00Z',
      message: { id: 'm1', model: MODEL, usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10000 },
        content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/tmp/big.js' } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: bigRead }] } },
    asst('m2', { input_tokens: 50, output_tokens: 20, cache_read_input_tokens: 12000 }),
  ]);
  const detail = buildDetail(main, [], pricing());
  const cc = detail.summary.contextConsumers;
  assert.ok(cc.note.includes('chars/4'));
  const read = cc.top.find((c) => c.tool === 'Read');
  assert.equal(read.target, '/tmp/big.js');
  assert.equal(read.estTokens, 2000);
  assert.ok(read.carriedCost > 0); // one step followed it, at a positive cache-read rate
  // synthetic rows make the table explain the whole context, not just tool results
  assert.ok(cc.byTool.some((t) => t.tool === 'session-overhead'));
  // m1: 50 output tokens but only ~6.75 visible (27 chars of Read args) → the excess
  // is attributed to unstored thinking, not smeared onto the tiny tool args.
  // m2: 20 output tokens, no content blocks → prose.
  const tc = cc.byTool.find((t) => t.tool === 'assistant-tool-calls');
  assert.equal(tc.estTokens, 7); // round(27 chars / 4)
  assert.match(cc.top.find((c) => c.tool === 'assistant-tool-calls').target, /Read \d+/); // per-tool breakdown in label
  assert.equal(cc.byTool.find((t) => t.tool === 'assistant-thinking').estTokens, 43); // round(50 − 27/4)
  assert.equal(cc.byTool.find((t) => t.tool === 'assistant-text').estTokens, 20);
  const up = cc.byTool.find((t) => t.tool === 'user-prompt');
  assert.equal(up.count, 1); // the tool_result entry is not a user prompt
  assert.equal(cc.totalEstTokens, cc.byTool.reduce((a, t) => a + t.estTokens, 0));
  // assistantOutput drills into the same apportionment: kind split, stored vs
  // unstored thinking, per-turn attribution, peak step.
  const ao = detail.summary.assistantOutput;
  assert.equal(ao.byKind.text.tokens, 20);
  assert.equal(ao.byKind.thinking.tokens, 43);
  assert.equal(ao.byKind.toolCalls.tokens, 7);
  assert.ok(ao.byKind.thinking.cost > 0);
  assert.equal(ao.thinking.storedTokens, 0); // no thinking blocks in the transcript
  assert.equal(ao.thinking.unstoredTokens, 43); // all inferred from output_tokens
  assert.equal(ao.thinking.stepsWithThinking, 1);
  assert.equal(ao.thinking.mainSteps, 2);
  assert.equal(ao.thinking.peakStep.seq, 1);
  assert.deepEqual(ao.thinking.peakStep.nextTools, ['Read']);
  // the burst's trigger = what landed in context right before that call — here the
  // user prompt (the call follows it directly; the Read result lands after).
  assert.equal(ao.thinking.topSteps.length, 1);
  assert.deepEqual(ao.thinking.topSteps[0].trigger, { tool: 'user-prompt', target: 'analyze the file' });
  assert.equal(ao.thinking.byTurn.length, 1);
  assert.equal(ao.thinking.byTurn[0].prompt, 'analyze the file');
  assert.equal(ao.thinking.byTurn[0].steps, 2);
  assert.equal(ao.thinking.byTurn[0].thinkingTokens, 43);
});

test('buildDetail: two main files across project dirs sum to the aggregate total (cross-cwd resume)', () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-sd-xcwd-'));
  tmp.push(cfg);
  const id = 'sessXCW1';
  const mainA = path.join(cfg, 'projects', 'pa', id + '.jsonl');
  const mainB = path.join(cfg, 'projects', 'pb', id + '.jsonl');
  const subA = path.join(cfg, 'projects', 'pa', id, 'subagents', 'agent-x.jsonl');
  writeJsonl(mainA, [
    userPrompt('first cwd'),
    asst('m1', { input_tokens: 1000, output_tokens: 200 }),
  ], 1000);
  writeJsonl(subA, [
    userPrompt('sub in dir A'),
    asst('s1', { input_tokens: 2000, output_tokens: 400 }),
  ], 1500);
  writeJsonl(mainB, [
    userPrompt('second cwd'),
    asst('m2', { input_tokens: 800, output_tokens: 150, cache_read_input_tokens: 5000 }),
  ], 2000);
  const px = pricing();
  const agg = aggregate(cfg, px);
  const detail = buildDetail([mainA, mainB], [subA], px);
  // detail total == list COST (aggregate sums every dir's half + its subagents)
  assert.equal(detail.total.toFixed(8), agg.perSession[id].total.toFixed(8));
  // both main halves merge into a single 'main' byAgent row; subagent split out
  const mainRow = detail.byAgent.find((a) => a.name === 'main');
  assert.ok(mainRow);
  assert.equal(detail.subagentCount, 1);
  assert.ok(detail.subagentTotal > 0);
  // main cost = total minus subagent cost
  assert.equal(mainRow.cost.toFixed(8), (detail.total - detail.subagentTotal).toFixed(8));
});

test('buildDetail: single-file (non-array) signature still works', () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-sd-sig-'));
  tmp.push(cfg);
  const main = path.join(cfg, 'projects', 'p', 'sessSIG1.jsonl');
  writeJsonl(main, [
    userPrompt('p'),
    asst('m1', { input_tokens: 1000, output_tokens: 200 }),
  ]);
  const px = pricing();
  const agg = aggregate(cfg, px);
  const detail = buildDetail(main, [], px); // bare path, not array
  assert.equal(detail.total.toFixed(8), agg.perSession.sessSIG1.total.toFixed(8));
  assert.equal(detail.calls, 1);
});

test('buildDetail: global dedup across main files counts a shared message id once', () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-sd-dup-'));
  tmp.push(cfg);
  const id = 'sessDUP1';
  const mainA = path.join(cfg, 'projects', 'pa', id + '.jsonl');
  const mainB = path.join(cfg, 'projects', 'pb', id + '.jsonl');
  // same streamed message id 'm1' appears in both halves → must bill once
  writeJsonl(mainA, [userPrompt('a'), asst('m1', { input_tokens: 1000, output_tokens: 200 })], 1000);
  writeJsonl(mainB, [userPrompt('b'), asst('m1', { input_tokens: 1000, output_tokens: 200 }), asst('m2', { input_tokens: 500, output_tokens: 50 })], 2000);
  const detail = buildDetail([mainA, mainB], [], pricing());
  assert.equal(detail.calls, 2); // m1 (once) + m2
});

test('buildDetail: bySkill attributes turn cost to the dispatched skill', () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-sd7-'));
  tmp.push(cfg);
  const main = path.join(cfg, 'projects', 'p', 'sessHHH1.jsonl');
  writeJsonl(main, [
    userPrompt('Base directory for this skill: /home/u/.claude/skills/writing-tests # Writing tests…'),
    asst('m1', { input_tokens: 1000, output_tokens: 100 }),
    asst('m2', { input_tokens: 500, output_tokens: 50 }),
    userPrompt('/code-review the diff'),
    asst('m3', { input_tokens: 800, output_tokens: 80 }),
    userPrompt('plain question'),
    asst('m4', { input_tokens: 200, output_tokens: 20 }),
  ]);
  const detail = buildDetail(main, [], pricing());
  const bs = detail.summary.bySkill;
  assert.equal(bs.length, 2); // the plain prompt is not a skill
  const wt = bs.find((s) => s.skill === 'writing-tests');
  assert.equal(wt.turns, 1);
  assert.equal(wt.steps, 2);
  assert.ok(wt.cost > 0);
  assert.ok(wt.tokens.input >= 1500);
  const cr = bs.find((s) => s.skill === 'code-review');
  assert.equal(cr.steps, 1);
  // skill turn costs are a subset of the total
  assert.ok(bs.reduce((a, s) => a + s.cost, 0) < detail.total);
});
