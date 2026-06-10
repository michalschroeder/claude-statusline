# Session Detail View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-session cost drill-down (`sessions.js <id-prefix>`) that splits a session's recomputed cost across token types, models, the user prompts that drove it, and subagents.

**Architecture:** A pure, testable detail builder (`lib/session-detail.js`) parses the session's own transcripts (main + `subagents/agent-*.jsonl`) using the same dedup as `lib/cost-aggregate.js`, retaining each call's `model`/`usage` (which the cost cache discards). Cost is itemized via a new `calculateCostBreakdown` in `lib/cost-compute.js` (the existing `calculateCost` becomes its `.total`). `bin/sessions.js` gains a positional-arg detail mode and a `renderDetail` function; the list mode is unchanged.

**Tech Stack:** Pure Node stdlib (Node 18+), `node:test`. Reuses `lib/color.js`, `lib/pricing.js`, `lib/transcript.js`.

**Source spec:** `docs/superpowers/specs/2026-06-09-session-detail-view-design.md`

---

## File Structure

- **Modify** `lib/cost-compute.js` — add `calculateCostBreakdown`; redefine `calculateCost` as its `.total`. Export both.
- **Create** `lib/session-detail.js` — `promptText`, `parseCalls`, `buildDetail` (pure).
- **Modify** `bin/sessions.js` — `fs` import; `parseArgs` positional `opts.detail`; hoist `money` to module scope; detail-mode block in `main()`; `renderDetail` function.
- **Modify** `tests/cost-compute.test.js` — breakdown tests.
- **Create** `tests/session-detail.test.js` — builder tests (pure).
- **Modify** `tests/sessions-viewer.test.js` — detail-mode integration tests.

---

## Task 1: Cost breakdown in `lib/cost-compute.js`

**Files:**
- Modify: `lib/cost-compute.js`
- Test: `tests/cost-compute.test.js`

- [ ] **Step 1: Add the failing breakdown tests**

Append to `tests/cost-compute.test.js` (and update the import on line 4 to include `calculateCostBreakdown`):

Change line 4 from:
```js
const { extractCacheCreation, calculateCost } = require('../lib/cost-compute');
```
to:
```js
const { extractCacheCreation, calculateCost, calculateCostBreakdown } = require('../lib/cost-compute');
```

Append these tests at the end of the file:
```js
test('calculateCostBreakdown: components priced and sum to total', () => {
  // COSTS = { input:10, output:20, cacheWrite:4, cacheRead:1, fastMultiplier:0.5, webSearch:0.01 }
  const usage = {
    input_tokens: 1000,
    output_tokens: 500,
    cache_read_input_tokens: 2000,
    cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 50 },
    server_tool_use: { web_search_requests: 3 },
  };
  const b = calculateCostBreakdown(usage, COSTS);
  assert.equal(b.input, 1000 * 10);                       // 10000
  assert.equal(b.output, 500 * 20);                       // 10000
  assert.equal(b.cacheRead, 2000 * 1);                    // 2000
  assert.equal(b.cacheWrite, 100 * 4 + 50 * 4 * 1.6);     // 400 + 320 = 720
  assert.equal(b.web, 3 * 0.01);                          // 0.03
  assert.equal(b.total, b.input + b.output + b.cacheRead + b.cacheWrite + b.web);
  assert.equal(b.total, calculateCost(usage, COSTS));     // single source of truth
});

test('calculateCostBreakdown: fast multiplier scales every component', () => {
  const usage = { input_tokens: 100, output_tokens: 100, speed: 'fast' };
  const b = calculateCostBreakdown(usage, COSTS); // fastMultiplier 0.5
  assert.equal(b.input, 100 * 10 * 0.5);
  assert.equal(b.output, 100 * 20 * 0.5);
  assert.equal(b.total, calculateCost(usage, COSTS));
});

test('calculateCostBreakdown: above-200K tier applies per component', () => {
  const usage = { input_tokens: 150000, cache_read_input_tokens: 100000, output_tokens: 1 };
  const b = calculateCostBreakdown(usage, BIG); // premium: input20 output40 cacheRead2
  assert.equal(b.input, 150000 * 20);
  assert.equal(b.cacheRead, 100000 * 2);
  assert.equal(b.output, 1 * 40);
  assert.equal(b.total, calculateCost(usage, BIG)); // 3200040
});

test('calculateCostBreakdown: null costs/usage → all zeros', () => {
  const z = calculateCostBreakdown(null, null);
  assert.deepEqual(z, { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, web: 0, total: 0 });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/cost-compute.test.js`
Expected: FAIL — `calculateCostBreakdown is not a function`.

- [ ] **Step 3: Implement the breakdown**

In `lib/cost-compute.js`, replace the entire `calculateCost` function (the `function calculateCost(usage, costs) { ... }` block) with:

```js
// Price one assistant call, itemized. Returns USD per component plus `total`.
// `costs` is the resolved per-token rate object or null (unknown/local → all 0).
// Fast mode scales the whole call; >200K prompt switches the four token rates to
// the model's `above200k` premium tier when defined; the 1-hour cache-write
// premium is `cacheWrite × 1.6`.
function calculateCostBreakdown(usage, costs) {
  const zero = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, web: 0, total: 0 };
  if (!costs || !usage) return zero;
  const { fiveMinute, oneHour } = extractCacheCreation(usage);
  const inputTokens = num(usage.input_tokens);
  const cacheReadTokens = num(usage.cache_read_input_tokens);
  const promptTokens = inputTokens + cacheReadTokens + fiveMinute + oneHour;
  const rates = (costs.above200k && promptTokens > LONG_CONTEXT_THRESHOLD) ? costs.above200k : costs;
  const mult = usage.speed === 'fast' ? (costs.fastMultiplier || 1) : 1;
  const webReq = num(usage.server_tool_use && usage.server_tool_use.web_search_requests);
  const input = mult * inputTokens * rates.input;
  const output = mult * num(usage.output_tokens) * rates.output;
  const cacheWrite = mult * (fiveMinute * rates.cacheWrite + oneHour * rates.cacheWrite * 1.6);
  const cacheRead = mult * cacheReadTokens * rates.cacheRead;
  const web = mult * webReq * costs.webSearch;
  return { input, output, cacheWrite, cacheRead, web, total: input + output + cacheWrite + cacheRead + web };
}

// Single-number cost: the total of the itemized breakdown (no drift between paths).
function calculateCost(usage, costs) {
  return calculateCostBreakdown(usage, costs).total;
}
```

Update the exports line at the bottom from:
```js
module.exports = { extractCacheCreation, calculateCost };
```
to:
```js
module.exports = { extractCacheCreation, calculateCost, calculateCostBreakdown };
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/cost-compute.test.js`
Expected: PASS (all existing + 4 new).

- [ ] **Step 5: Commit**

```bash
git add lib/cost-compute.js tests/cost-compute.test.js
git commit -m "feat: calculateCostBreakdown (itemized per-call cost)"
```

---

## Task 2: Detail builder `lib/session-detail.js`

**Files:**
- Create: `lib/session-detail.js`
- Test: `tests/session-detail.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/session-detail.test.js`:
```js
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
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/session-detail.test.js`
Expected: FAIL — cannot find module `../lib/session-detail`.

- [ ] **Step 3: Implement `lib/session-detail.js`**

Create `lib/session-detail.js`:
```js
'use strict';
const fs = require('fs');
const path = require('path');
const { getModelCosts } = require('./pricing');
const { calculateCostBreakdown } = require('./cost-compute');

// Extract a human prompt string from a transcript entry, or null if it isn't a
// genuine user prompt (assistant/meta entries, tool results, empty text). A
// slash-command wrapper collapses to '/name'. Whitespace is collapsed.
function promptText(o) {
  if (!o || o.type !== 'user' || !o.message) return null;
  const c = o.message.content;
  let text = null;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    if (c.some((b) => b && b.type === 'tool_result')) return null; // tool return, not a prompt
    const tb = c.find((b) => b && b.type === 'text' && typeof b.text === 'string');
    text = tb ? tb.text : null;
  }
  if (text == null) return null;
  const cmd = /<command-name>([^<]*)<\/command-name>/.exec(text);
  if (cmd) text = cmd[1];
  text = text.replace(/\s+/g, ' ').trim();
  return text || null;
}

// Parse a transcript into ordered, within-file-deduped calls:
// { id, ts, usage, model, prompt }. within-file: keep LAST usage per message.id,
// carry FIRST timestamp + FIRST active prompt. id-less calls always kept.
// When `trackPrompts`, each call is tagged with the active user prompt.
function parseCalls(file, trackPrompts) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const byKey = new Map();
  const order = [];
  let synth = 0;
  let current = '(session start)';
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!o) continue;
    if (trackPrompts) { const p = promptText(o); if (p) current = p; }
    if (o.type !== 'assistant' || !o.message) continue;
    const m = o.message;
    if (!m.usage || !m.model) continue;
    const realId = typeof m.id === 'string' && m.id ? m.id : null;
    const key = realId || `__synth__${synth++}`;
    if (!byKey.has(key)) order.push(key);
    const prev = byKey.get(key);
    byKey.set(key, {
      id: realId,
      ts: prev ? prev.ts : o.timestamp,
      usage: m.usage,
      model: m.model,
      prompt: prev ? prev.prompt : current,
    });
  }
  return order.map((k) => byKey.get(k));
}

// Build a per-session cost breakdown from its main transcript + subagent files.
// Global dedup: first occurrence wins, files processed oldest mtime first (so the
// total equals lib/cost-aggregate.js's per-session total). Returns:
// { total, calls, components:{input,output,cacheWrite,cacheRead,web},
//   byModel:[{model,cost,calls}], byAgent:[{name,cost}],
//   topPrompts:[{text,cost,calls}], subagentTotal, subagentCount }.
function buildDetail(mainFile, subagentFiles, pricing) {
  const descriptors = [];
  const add = (file, name, isMain) => {
    let st; try { st = fs.statSync(file); } catch { return; }
    descriptors.push({ file, name, isMain, mtime: st.mtimeMs });
  };
  add(mainFile, 'main', true);
  for (const f of subagentFiles || []) add(f, path.basename(f).replace(/\.jsonl$/, ''), false);
  descriptors.sort((a, b) => a.mtime - b.mtime); // oldest first → first occurrence wins

  const seen = new Set();
  const components = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, web: 0 };
  const byModel = new Map();
  const byAgent = new Map();
  const byPrompt = new Map();
  let total = 0, calls = 0, subagentTotal = 0;
  const subWithCost = new Set();

  for (const d of descriptors) {
    for (const call of parseCalls(d.file, d.isMain)) {
      if (call.id) { if (seen.has(call.id)) continue; seen.add(call.id); }
      const b = calculateCostBreakdown(call.usage, getModelCosts(pricing.map, call.model));
      if (b.total <= 0) continue; // unknown/local model or zero-cost usage
      total += b.total; calls += 1;
      components.input += b.input; components.output += b.output;
      components.cacheWrite += b.cacheWrite; components.cacheRead += b.cacheRead;
      components.web += b.web;
      const mm = byModel.get(call.model) || { model: call.model, cost: 0, calls: 0 };
      mm.cost += b.total; mm.calls += 1; byModel.set(call.model, mm);
      byAgent.set(d.name, (byAgent.get(d.name) || 0) + b.total);
      if (d.isMain) {
        const pp = byPrompt.get(call.prompt) || { text: call.prompt, cost: 0, calls: 0 };
        pp.cost += b.total; pp.calls += 1; byPrompt.set(call.prompt, pp);
      } else {
        subagentTotal += b.total; subWithCost.add(d.name);
      }
    }
  }
  const desc = (a, b) => b.cost - a.cost;
  return {
    total, calls, components,
    byModel: [...byModel.values()].sort(desc),
    byAgent: [...byAgent.entries()].map(([name, cost]) => ({ name, cost })).sort(desc),
    topPrompts: [...byPrompt.values()].sort(desc),
    subagentTotal, subagentCount: subWithCost.size,
  };
}

module.exports = { promptText, parseCalls, buildDetail };
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/session-detail.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/session-detail.js tests/session-detail.test.js
git commit -m "feat: lib/session-detail buildDetail (per-session cost breakdown)"
```

---

## Task 3: Detail mode in `bin/sessions.js`

**Files:**
- Modify: `bin/sessions.js`
- Test: `tests/sessions-viewer.test.js`

- [ ] **Step 1: Add the failing integration tests**

Append to `tests/sessions-viewer.test.js` (the helpers `mkProfile`, `writeTranscript`, `wide`, `runSessions` already exist in that file):
```js
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
  assert.match(out, /BY MODEL/);
  assert.match(out, /TOP PROMPTS/);
  assert.match(out, /\$\d+\.\d{2} total/);
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
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/sessions-viewer.test.js`
Expected: FAIL — the new tests fail (no detail mode; `sessDET` arg currently ignored → list rendered).

- [ ] **Step 3a: Imports + parseArgs positional**

In `bin/sessions.js`, add an `fs` require near the top imports (after `const os = require('os');`):
```js
const fs = require('fs');
```

Add `buildDetail` to the existing requires (after the `cost-aggregate` line):
```js
const { buildDetail } = require('../lib/session-detail');
```

In `parseArgs`, change the opts initializer:
```js
  const opts = { last: null, since: null, configDir: undefined };
```
to:
```js
  const opts = { last: null, since: null, configDir: undefined, detail: undefined };
```

And add two branches to the arg loop, after the `--config-dir` branch (so the chain ends `... else if (a === '--config-dir') {...}` then these):
```js
    else if (a.startsWith('--')) { /* unknown flag: ignored, as before */ }
    else if (opts.detail === undefined) { opts.detail = a; } // first bare token = session prefix
    else {
      process.stderr.write(`bin/sessions.js: unexpected argument '${a}'\n`);
      process.exit(1);
    }
```

- [ ] **Step 3b: Hoist `money` to module scope**

In `bin/sessions.js`, delete the in-`main` line:
```js
  const money = (c) => '$' + c.toFixed(2);
```
and add it at module scope, right after the `truncate` function definition (near the other helpers):
```js
const money = (c) => '$' + c.toFixed(2);
```

- [ ] **Step 3c: Detail-mode block in `main()`**

In `main()`, immediately after the line `const costOf = (id) => { const ps = agg.perSession[id]; return ps ? ps.total : 0; };` and BEFORE the `if (rows.length === 0)` guard, insert:
```js
  if (opts.detail !== undefined) {
    const matches = rows.filter((r) => r.id.startsWith(opts.detail));
    if (matches.length === 0) {
      process.stderr.write(`bin/sessions.js: no session matching '${opts.detail}'\n`);
      process.exit(1);
    }
    if (matches.length > 1) {
      process.stderr.write(`bin/sessions.js: '${opts.detail}' is ambiguous:\n` +
        matches.map((m) => '  ' + m.id).join('\n') + '\n');
      process.exit(1);
    }
    const row = matches[0];
    const subDir = path.join(path.dirname(row.file), row.id, 'subagents');
    let subFiles = [];
    try {
      subFiles = fs.readdirSync(subDir)
        .filter((n) => n.startsWith('agent-') && n.endsWith('.jsonl'))
        .map((n) => path.join(subDir, n));
    } catch {}
    const detail = buildDetail(row.file, subFiles, pricing);
    const { title, recap } = readTitleRecap(row.file);
    process.stdout.write(renderDetail(detail, row.id, row.ts, title, recap, termWidth()));
    return;
  }
```

- [ ] **Step 3d: `renderDetail` function**

In `bin/sessions.js`, add this function at module scope (e.g. just above `function main()`):
```js
// Render the per-session detail view (see lib/session-detail.buildDetail).
function renderDetail(detail, sessionId, when, title, recap, width) {
  const out = [];
  out.push(`SESSION ${sessionId}`);
  out.push(title || '—');
  if (recap) out.push(dim('└ ' + truncate(recap, Math.max(0, width - 2))));
  out.push(dim(`${dayLabel(when)} ${clock(when)} · ${detail.calls} calls · ${money(detail.total)} total`));

  const t = detail.total || 1; // avoid divide-by-zero on an unbilled session
  const comp = [
    ['cache-read', detail.components.cacheRead],
    ['input', detail.components.input],
    ['output', detail.components.output],
    ['cache-write', detail.components.cacheWrite],
    ['web search', detail.components.web],
  ].filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]);
  if (comp.length) {
    out.push('');
    out.push(dim('WHERE IT WENT'));
    const lw = Math.max(...comp.map(([l]) => l.length));
    const BAR = 10;
    for (const [label, c] of comp) {
      const frac = c / t;
      const fill = Math.max(0, Math.min(BAR, Math.round(frac * BAR)));
      const bar = '▓'.repeat(fill) + dim('░'.repeat(BAR - fill));
      out.push(`  ${label.padEnd(lw)}  ${bar}  ${dim(String(Math.round(frac * 100)).padStart(3) + '%')}  ${money(c)}`);
    }
  }

  if (detail.byModel.length) {
    out.push('');
    out.push(dim('BY MODEL'));
    const mw = Math.max(...detail.byModel.map((m) => m.model.length));
    for (const m of detail.byModel) {
      out.push(`  ${m.model.padEnd(mw)}  ${money(m.cost)}  ${dim(m.calls + ' call' + (m.calls === 1 ? '' : 's'))}`);
    }
  }

  if (detail.topPrompts.length) {
    out.push('');
    out.push(dim('TOP PROMPTS'));
    const top = detail.topPrompts.slice(0, 10);
    const cw = Math.max(...top.map((p) => money(p.cost).length));
    for (const p of top) {
      const meta = `${money(p.cost).padStart(cw)}  ${String(p.calls).padStart(2)} call${p.calls === 1 ? ' ' : 's'}  `;
      out.push('  ' + meta + truncate(p.text, Math.max(0, width - 2 - meta.length)));
    }
    if (detail.subagentCount > 0) {
      out.push(dim(`  + ${money(detail.subagentTotal)} across ${detail.subagentCount} subagent${detail.subagentCount === 1 ? '' : 's'}`));
    }
  }

  if (detail.subagentCount > 0) {
    out.push('');
    out.push(dim('BY AGENT'));
    const aw = Math.max(...detail.byAgent.map((a) => a.name.length));
    for (const a of detail.byAgent) out.push(`  ${a.name.padEnd(aw)}  ${money(a.cost)}`);
  }

  return out.join('\n') + '\n';
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/sessions-viewer.test.js tests/session-detail.test.js tests/cost-compute.test.js`
Expected: PASS (all).

- [ ] **Step 5: Eyeball a real session**

Run: `node bin/sessions.js --last 5` to get an id prefix, then `node bin/sessions.js <prefix>`.
Expected: SESSION header, WHERE IT WENT bars, BY MODEL, TOP PROMPTS, and BY AGENT only if the session spawned subagents.

- [ ] **Step 6: Run the full suite**

Run: `node --test tests/*.test.js`
Expected: PASS (no regressions in list mode).

- [ ] **Step 7: Commit**

```bash
git add bin/sessions.js tests/sessions-viewer.test.js
git commit -m "feat: session detail view (sessions.js <prefix>)"
```

---

## Task 4: Docs

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Document the detail view**

In `CLAUDE.md`, in the `### Session viewer (bin/sessions.js)` block, after the sentence describing the flags (`Flags: --last N ... --config-dir <path>`), add:
```
A bare positional arg (`sessions.js <id-prefix>`) switches to a per-session **detail
view**: prefix-matched against session ids (zero matches or ambiguous → exit 1). It
renders a header (title/recap/total), `WHERE IT WENT` (cost split by token type —
cache-read/input/output/cache-write/web, with proportion bars), `BY MODEL`, `TOP
PROMPTS` (main-session user prompts ranked by the cost of the turns they drove, plus a
`+ $X across N subagents` line), and `BY AGENT` (only when subagents exist). Backed by
the pure `lib/session-detail.js` (`buildDetail`), which reuses the same dedup as
`lib/cost-aggregate.js` so the detail total equals the list COST, and by
`calculateCostBreakdown` in `lib/cost-compute.js` (the itemized form of `calculateCost`).
```

In the cost-pipeline lib list, update the `lib/cost-compute.js` bullet to note it also exports `calculateCostBreakdown` (itemized per-component cost; `calculateCost` is its `.total`).

In the testing section, add: `tests/session-detail.test.js` (buildDetail: dedup parity with aggregate, token-type split, turn attribution, subagent split).

- [ ] **Step 2: Run the full suite**

Run: `node --test tests/*.test.js`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: session detail view"
```

---

## Self-Review Notes

- **Spec coverage:** invocation/selection (Task 3 parseArgs + detail block), `calculateCostBreakdown` + `calculateCost` refactor (Task 1), `buildDetail` with aggregate-parity dedup + retained usage/model (Task 2), turn attribution incl. tool_result exclusion + slash-command + `(session start)` (Task 2 `promptText`/`parseCalls` + test), all four sections + `+ $X across N subagents` + BY AGENT-only-when-subagents (Task 3 `renderDetail`), offline pricing reuse (Task 3 reuses `main`'s `pricing`), tests (Tasks 1-3), docs (Task 4). All spec sections covered.
- **Signature note:** spec sketched `buildDetail(mainFile, subagentFiles, pricing)` and `renderDetail(detail, sessionId, when, title, recap, width)` — both implemented with exactly those signatures.
- **Type consistency:** `buildDetail` return keys (`total, calls, components{input,output,cacheWrite,cacheRead,web}, byModel[{model,cost,calls}], byAgent[{name,cost}], topPrompts[{text,cost,calls}], subagentTotal, subagentCount`) are consumed identically in `renderDetail` and asserted in the tests. `calculateCostBreakdown` keys match between cost-compute, session-detail, and the cost-compute tests.
- **No placeholders:** every code/test/command step is concrete.
- **Money hoist:** Task 3b moves `money` to module scope; both the list footer and `renderDetail` reference the same module-level `money` (the footer's local definition is removed).
