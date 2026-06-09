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
