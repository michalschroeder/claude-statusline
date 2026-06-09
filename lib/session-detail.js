'use strict';
const fs = require('fs');
const path = require('path');
const { getModelCosts } = require('./pricing');
const { calculateCostBreakdown, extractCacheCreation } = require('./cost-compute');

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

// Tool names invoked by an assistant message (its `tool_use` content blocks).
function toolNames(m) {
  const c = m.content;
  if (!Array.isArray(c)) return [];
  return c.filter((b) => b && b.type === 'tool_use' && b.name).map((b) => b.name);
}

// Parse a transcript into ordered, within-file-deduped calls:
// { id, ts, usage, model, prompt, tools }. within-file: keep LAST usage/tools per
// message.id, carry FIRST timestamp + FIRST active prompt. id-less calls always
// kept. When `trackPrompts`, each call is tagged with the active user prompt.
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
      tools: toolNames(m),
    });
  }
  return order.map((k) => byKey.get(k));
}

// First genuine user prompt in a transcript (the agent's task), or null. Used to
// give subagents a human-meaningful label instead of their opaque agent-<hash> id.
function firstPrompt(file) {
  let raw; try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const p = promptText(o);
    if (p) return p;
  }
  return null;
}

// Build a per-session cost breakdown from its main transcript + subagent files.
// Global dedup: first occurrence wins, files processed oldest mtime first (so the
// total equals lib/cost-aggregate.js's per-session total). Returns:
// { total, calls, components:{input,output,cacheWrite,cacheRead,web},
//   byModel:[{model,cost,calls}], byAgent:[{name,label,cost}],
//   topPrompts:[{text,cost,calls,inp,ctx,cw,out,tools:[[name,count]]}],
//   turns:[...], perCall:[...], subagentTotal, subagentCount }.
// Per topPrompt token sums across the turn: inp = fresh input, ctx = cache-read
// (the dominant cost driver), cw = cache-write, out = output; tools = tool tally
// (desc by count).
// byAgent `label` is 'main session' for the main file, else the subagent's task
// (its first prompt) falling back to the agent-<hash> stem.
// `turns` are main-session prompts in EXECUTION order (not cost order) — each with
// full text, raw token sums, and a tool tally — so a consumer can watch cacheRead
// climb. `perCall` is every billed assistant call in chronological-by-file order,
// each with raw per-call tokens (the call's cacheRead is the context size at that
// step). Both carry raw integers + untruncated prompts for downstream analysis.
function buildDetail(mainFile, subagentFiles, pricing) {
  const descriptors = [];
  const add = (file, name, isMain, label) => {
    let st; try { st = fs.statSync(file); } catch { return; }
    descriptors.push({ file, name, isMain, label, mtime: st.mtimeMs });
  };
  add(mainFile, 'main', true, 'main session');
  for (const f of subagentFiles || []) {
    const name = path.basename(f).replace(/\.jsonl$/, '');
    add(f, name, false, firstPrompt(f) || name);
  }
  descriptors.sort((a, b) => a.mtime - b.mtime); // oldest first → first occurrence wins

  const seen = new Set();
  const components = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, web: 0 };
  const byModel = new Map();
  const byAgent = new Map();
  const byPrompt = new Map();
  const perCall = [];
  let total = 0, calls = 0, subagentTotal = 0;
  const subWithCost = new Set();

  for (const d of descriptors) {
    for (const call of parseCalls(d.file, d.isMain)) {
      if (call.id) { if (seen.has(call.id)) continue; seen.add(call.id); }
      const b = calculateCostBreakdown(call.usage, getModelCosts(pricing.map, call.model));
      if (b.total <= 0) continue; // unknown/local model or zero-cost usage
      const cc = extractCacheCreation(call.usage);
      const u = call.usage;
      const tokens = {
        input: u.input_tokens || 0,                  // fresh (uncached) input
        cacheRead: u.cache_read_input_tokens || 0,   // context re-read — the dominant cost driver
        cacheWrite: cc.fiveMinute + cc.oneHour,      // new context cached
        output: u.output_tokens || 0,
      };
      total += b.total; calls += 1;
      components.input += b.input; components.output += b.output;
      components.cacheWrite += b.cacheWrite; components.cacheRead += b.cacheRead;
      components.web += b.web;
      const mm = byModel.get(call.model) || { model: call.model, cost: 0, calls: 0 };
      mm.cost += b.total; mm.calls += 1; byModel.set(call.model, mm);
      const ag = byAgent.get(d.name) || { name: d.name, label: d.label, cost: 0 };
      ag.cost += b.total; byAgent.set(d.name, ag);
      perCall.push({
        seq: calls, agent: d.name, agentLabel: d.label, isMain: d.isMain,
        model: call.model, ts: call.ts || null,
        prompt: d.isMain ? call.prompt : null,       // subagent calls aren't main-session turns
        cost: b.total, tokens, tools: call.tools.slice(),
      });
      if (d.isMain) {
        const pp = byPrompt.get(call.prompt) || { text: call.prompt, ts: call.ts || null, cost: 0, calls: 0, inp: 0, ctx: 0, cw: 0, out: 0, tools: new Map() };
        pp.cost += b.total; pp.calls += 1;
        pp.inp += tokens.input;
        pp.ctx += tokens.cacheRead;
        pp.cw += tokens.cacheWrite;
        pp.out += tokens.output;
        for (const tn of call.tools) pp.tools.set(tn, (pp.tools.get(tn) || 0) + 1);
        byPrompt.set(call.prompt, pp);
      } else {
        subagentTotal += b.total; subWithCost.add(d.name);
      }
    }
  }
  const desc = (a, b) => b.cost - a.cost;
  const toolArr = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]);
  // Map iteration preserves insertion order → byPrompt values are already in
  // execution order; `turns` keeps that, `topPrompts` re-sorts a copy by cost.
  const turns = [...byPrompt.values()].map((p) => ({
    prompt: p.text, ts: p.ts, steps: p.calls, cost: p.cost,
    tokens: { input: p.inp, cacheRead: p.ctx, cacheWrite: p.cw, output: p.out },
    tools: toolArr(p.tools),
  }));
  return {
    total, calls, components,
    byModel: [...byModel.values()].sort(desc),
    byAgent: [...byAgent.values()].sort(desc),
    topPrompts: [...byPrompt.values()]
      .map((p) => ({ ...p, tools: toolArr(p.tools) }))
      .sort(desc),
    turns, perCall,
    subagentTotal, subagentCount: subWithCost.size,
  };
}

module.exports = { promptText, parseCalls, buildDetail };
