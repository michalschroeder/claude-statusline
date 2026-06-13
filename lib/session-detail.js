'use strict';
const fs = require('fs');
const path = require('path');
const { getModelCosts } = require('./pricing');
const { calculateCostBreakdown, extractCacheCreation } = require('./cost-compute');
const { dayKey } = require('./cost-aggregate');

// Every token estimate below sizes text at ~this many characters per token.
const CHARS_PER_TOKEN = 4;

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

// Best-effort "what is this tool acting on" label (file path, command, pattern, url)
// so context consumption can be attributed to a concrete target, not just a tool name.
function toolTarget(name, input) {
  if (!input || typeof input !== 'object') return '';
  const first = (...keys) => {
    for (const k of keys) if (typeof input[k] === 'string' && input[k]) return input[k];
    return '';
  };
  let t;
  switch (name) {
    case 'Read': case 'Write': case 'Edit': t = first('file_path'); break;
    case 'NotebookEdit': t = first('notebook_path', 'file_path'); break;
    case 'Bash': t = first('command'); break;
    case 'Grep': t = first('pattern') + (typeof input.path === 'string' && input.path ? ` in ${input.path}` : ''); break;
    case 'Glob': t = first('pattern'); break;
    case 'Task': case 'Agent': t = first('description', 'prompt'); break;
    case 'WebFetch': t = first('url'); break;
    case 'WebSearch': t = first('query'); break;
    case 'Skill': t = first('skill'); break;
    default: t = first('file_path', 'path', 'command', 'pattern', 'url', 'query', 'description', 'prompt');
  }
  return t.replace(/\s+/g, ' ').trim().slice(0, 200);
}

// Character size of a tool_result content payload (string or block array).
function resultChars(content) {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return content == null ? 0 : JSON.stringify(content).length;
  let n = 0;
  for (const b of content) n += (b && typeof b.text === 'string') ? b.text.length : JSON.stringify(b || '').length;
  return n;
}

// Char sizes of what the model itself emitted in one assistant message, by kind:
// prose text, extended-thinking blocks, and the tool_use arguments it wrote (Edit
// payloads, Bash commands, subagent prompts). Used to apportion the call's exact
// output_tokens across those kinds. Keep LAST per message id, like usage/tools.
function measureOutput(c) {
  const p = { text: 0, thinking: 0, toolInput: {} };
  if (typeof c === 'string') { p.text = c.length; return p; }
  if (!Array.isArray(c)) return p;
  for (const b of c) {
    if (!b) continue;
    if (b.type === 'text' && typeof b.text === 'string') p.text += b.text.length;
    else if (b.type === 'thinking' && typeof b.thinking === 'string') p.thinking += b.thinking.length;
    else if (b.type === 'tool_use') {
      const n = b.name || '?';
      const t = p.toolInput[n] || { chars: 0, count: 0 };
      t.chars += JSON.stringify(b.input || {}).length; t.count += 1;
      p.toolInput[n] = t;
    }
  }
  return p;
}

// Parse a transcript into ordered, within-file-deduped calls:
// { id, ts, usage, model, prompt, turn, tools }. within-file: keep LAST usage/tools
// per message.id, carry FIRST timestamp + FIRST active prompt. id-less calls always
// kept. When `trackPrompts`, each call is tagged with the active user prompt and a
// monotonic `turn` index that increments on EVERY user submission — so two turns
// with identical prompt text stay distinct (turn 0 = pre-prompt session start).
// When `consumers` (array) is given, every tool_result and user prompt is pushed
// onto it as { tool, target, estTokens, afterStep } — what landed in this
// transcript's context, attributed to the concrete file/command/pattern it came
// from, sized at ~4 chars/token, tagged with how many billed calls preceded it.
function parseCalls(file, trackPrompts, consumers) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const byKey = new Map();
  const order = [];
  const pendingTools = new Map(); // tool_use id → { tool, target }
  let synth = 0;
  let current = '(session start)';
  let turn = 0;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!o) continue;
    if (trackPrompts) {
      const p = promptText(o);
      if (p) {
        current = p; turn++;
        if (consumers) consumers.push({ tool: 'user-prompt', target: p.slice(0, 200), estTokens: Math.round(p.length / CHARS_PER_TOKEN), afterStep: order.length });
      }
    }
    if (consumers) {
      const c = o.message && o.message.content;
      if (o.type === 'assistant' && Array.isArray(c)) {
        for (const b of c) if (b && b.type === 'tool_use' && b.id) pendingTools.set(b.id, { tool: b.name || '?', target: toolTarget(b.name, b.input) });
      } else if (o.type === 'user' && Array.isArray(c)) {
        for (const b of c) {
          if (!b || b.type !== 'tool_result') continue;
          const src = pendingTools.get(b.tool_use_id) || { tool: '?', target: '' };
          consumers.push({ tool: src.tool, target: src.target, estTokens: Math.round(resultChars(b.content) / CHARS_PER_TOKEN), afterStep: order.length });
        }
      }
    }
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
      turn: prev ? prev.turn : turn,
      tools: toolNames(m),
      outParts: measureOutput(m.content),
    });
  }
  return order.map((k) => byKey.get(k));
}

// Coarse class of a main-session turn, for attributing cost to *kinds* of work.
// 'subagent-orchestration' = a parent turn handling a subagent return (the parent
// re-caches its whole context → a cacheWrite spike); 'skill' = a skill/slash
// dispatch; 'session-start' = pre-prompt calls; else 'user'.
function turnKind(text) {
  if (!text) return 'other';
  if (text.startsWith('<task-notification>')) return 'subagent-orchestration';
  // Slash command = /name, one token, no inner slashes — not an absolute path like /home/….
  if (text.startsWith('Base directory for this skill:') || /^\/[A-Za-z0-9_:-]+(\s|$)/.test(text)) return 'skill';
  if (text === '(session start)') return 'session-start';
  return 'user';
}

// Skill name from a skill-dispatch prompt: a Skill-tool expansion ("Base directory
// for this skill: /path/to/<name> …") or a typed slash command ("/name args").
// Null for non-skill prompts.
function skillName(text) {
  if (!text) return null;
  const base = /^Base directory for this skill:\s*(\S+)/.exec(text);
  if (base) return path.basename(base[1].replace(/\/+$/, ''));
  const slash = /^\/([A-Za-z0-9_:-]+)(\s|$)/.exec(text);
  return slash ? slash[1] : null;
}

// The dispatcher-authored task label from a subagent's sibling `<agent>.meta.json`
// (`description` — the Task tool's 3-5 word summary), or null. Preferred over the
// raw first prompt: it's a purpose-built one-liner, where first prompts share a long
// boilerplate preamble (MCP setup, auth) that truncates to indistinguishable rows.
function agentDescription(file) {
  const meta = file.replace(/\.jsonl$/, '.meta.json');
  let raw; try { raw = fs.readFileSync(meta, 'utf8'); } catch { return null; }
  let o; try { o = JSON.parse(raw); } catch { return null; }
  const d = o && typeof o.description === 'string' ? o.description.trim() : '';
  return d || null;
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
//   unpriced, unpricedModels:[...], byModel:[{model,cost,calls}],
//   byAgent:[{name,label,cost}], turns:[...], perCall:[...],
//   subagentTotal, subagentCount }.
// `unpriced` counts billed calls excluded from cost rollups because their model
// isn't in the price table (the #25 stale-snapshot failure); `unpricedModels`
// lists the distinct models, so the detail view can warn rather than silently
// undercount.
// byAgent `label` is 'main session' for the main file, else the subagent's task —
// its meta.json `description`, falling back to its first prompt, then the agent-<hash> stem.
// `turns` are main-session prompts in EXECUTION order (not cost order) — each with
// full text, raw token sums, and a tool tally — so a consumer can watch cacheRead
// climb. `perCall` is every billed assistant call in chronological-by-file order,
// each with raw per-call tokens (the call's cacheRead is the context size at that
// step). Both carry raw integers + untruncated prompts for downstream analysis.
// `mainFile` accepts a single path or an array — a session resumed under a
// different cwd has a transcript half under each `projects/<enc-cwd>/` dir, and
// all halves must be folded in to match the list COST (aggregate sums them all).
function buildDetail(mainFile, subagentFiles, pricing) {
  const descriptors = [];
  const add = (file, name, isMain, label) => {
    let st; try { st = fs.statSync(file); } catch { return; }
    descriptors.push({ file, name, isMain, label, mtime: st.mtimeMs });
  };
  const mains = Array.isArray(mainFile) ? mainFile : [mainFile];
  for (const f of mains) add(f, 'main', true, 'main session');
  for (const f of subagentFiles || []) {
    const name = path.basename(f).replace(/\.jsonl$/, '');
    add(f, name, false, agentDescription(f) || firstPrompt(f) || name);
  }
  descriptors.sort((a, b) => a.mtime - b.mtime); // oldest first → first occurrence wins

  const seen = new Set();
  const components = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, web: 0 };
  const byModel = new Map();
  const byAgent = new Map();
  const byPrompt = new Map();
  const perCall = [];
  const consumerEvents = []; // main-session only: what landed in context, per target
  let total = 0, calls = 0, subagentTotal = 0;
  let unpriced = 0;                  // billed calls dropped because their model isn't in the price table
  const unpricedModels = new Set();  // which models — surfaces the stale-pricing failure (#25/#27)
  let mainParsedSteps = 0; // distinct main-file calls in parse order (consumer afterStep space)
  const subWithCost = new Set();

  const mainIdx = []; // per kept main call: its index in the main file's parse order
  for (const d of descriptors) {
    const parsed = parseCalls(d.file, d.isMain, d.isMain ? consumerEvents : null);
    if (d.isMain) mainParsedSteps += parsed.length; // accumulate across multiple main halves (cross-cwd resume)
    for (let fi = 0; fi < parsed.length; fi++) {
      const call = parsed[fi];
      if (!dayKey(call.ts)) continue; // parity: cost-aggregate drops undated calls, so the detail total matches list COST
      if (call.id) { if (seen.has(call.id)) continue; seen.add(call.id); }
      const costs = getModelCosts(pricing.map, call.model);
      const b = calculateCostBreakdown(call.usage, costs);
      if (b.total <= 0) {
        // A null `costs` means the model isn't in the price table (the #25 stale-snapshot
        // failure) — count it so the detail view can warn instead of silently undercounting.
        if (!costs) { unpriced++; unpricedModels.add(call.model); }
        continue; // unknown/local model or zero-cost usage — excluded from cost rollups
      }
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
        turnIndex: d.isMain ? call.turn : null,      // which main-session turn this call served
        cost: b.total, outCost: b.output, cacheReadCost: b.cacheRead,
        tokens, tools: call.tools.slice(),
        outParts: call.outParts,
      });
      if (d.isMain) {
        mainIdx.push(fi);
        // Key on the turn index, not the text: repeated identical prompts (e.g.
        // "continue", a re-run slash command) are distinct turns, not one row.
        const pp = byPrompt.get(call.turn) || { turnIndex: call.turn, text: call.prompt, ts: call.ts || null, cost: 0, calls: 0, inp: 0, ctx: 0, cw: 0, out: 0, peakCtx: 0, tools: new Map() };
        pp.cost += b.total; pp.calls += 1;
        pp.inp += tokens.input;
        pp.ctx += tokens.cacheRead;
        pp.cw += tokens.cacheWrite;
        pp.out += tokens.output;
        if (tokens.cacheRead > pp.peakCtx) pp.peakCtx = tokens.cacheRead;
        for (const tn of call.tools) pp.tools.set(tn, (pp.tools.get(tn) || 0) + 1);
        byPrompt.set(call.turn, pp);
      } else {
        subagentTotal += b.total; subWithCost.add(d.name);
      }
    }
  }
  const desc = (a, b) => b.cost - a.cost;
  const toolArr = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]);
  // Map iteration preserves insertion order → byPrompt values are already in
  // execution order, which `turns` keeps (consumers re-sort by cost as needed).
  // tokens.cacheRead is the SUM across the turn's steps; avgContext/peakContext are
  // the actual per-step context size (cacheRead/step) — the honest growth signal.
  const turns = [...byPrompt.values()].map((p) => {
    const kind = turnKind(p.text);
    return {
      turnIndex: p.turnIndex, prompt: p.text, ts: p.ts, kind, steps: p.calls, cost: p.cost,
      skill: kind === 'skill' ? skillName(p.text) : null,
      tokens: { input: p.inp, cacheRead: p.ctx, cacheWrite: p.cw, output: p.out },
      avgContext: Math.round(p.ctx / p.calls), peakContext: p.peakCtx,
      tools: toolArr(p.tools),
    };
  });
  const mainCalls = perCall.filter((c) => c.isMain);
  const summary = buildSummary(mainCalls, turns);
  // Blended cache-read $/token across the main session, for carried-cost estimates.
  const mainCacheReadTokens = mainCalls.reduce((a, c) => a + c.tokens.cacheRead, 0);
  const rate = mainCacheReadTokens > 0
    ? mainCalls.reduce((a, c) => a + c.cacheReadCost, 0) / mainCacheReadTokens : 0;
  // totalSteps is the main file's PARSE-ORDER call count — the same index space as
  // each event's afterStep (which counts every parsed main call, incl. ones later
  // dropped by dedup/zero-cost), so steps-remaining doesn't clamp to 0.
  summary.contextConsumers = buildConsumers(
    consumerEvents, mainParsedSteps, rate, syntheticConsumers(mainCalls, rate));
  // What landed in context right before each main call — the likely trigger of
  // that call's reasoning. Keyed by parse-order index; biggest event wins when a
  // batch of tool_results returns at once.
  const triggerByIdx = new Map();
  for (const e of consumerEvents) {
    const cur = triggerByIdx.get(e.afterStep);
    if (!cur || e.estTokens > cur.estTokens) triggerByIdx.set(e.afterStep, e);
  }
  summary.assistantOutput = buildAssistantOutput(mainCalls, mainIdx, triggerByIdx);
  // Cost per skill: the turns each skill dispatch drove (its expansion prompt or
  // /slash command), summed by extracted skill name. Only the dispatch's own
  // turns — later work the skill influenced is attributed to those prompts.
  const bySkill = new Map();
  for (const t of turns) {
    if (t.kind !== 'skill') continue;
    const name = t.skill || '(unknown)';
    const e = bySkill.get(name) || { skill: name, turns: 0, steps: 0, cost: 0, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } };
    e.turns += 1; e.steps += t.steps; e.cost += t.cost;
    for (const k of Object.keys(e.tokens)) e.tokens[k] += t.tokens[k];
    bySkill.set(name, e);
  }
  summary.bySkill = [...bySkill.values()].sort((a, b) => b.cost - a.cost);
  return {
    total, calls, components,
    unpriced, unpricedModels: [...unpricedModels],
    byModel: [...byModel.values()].sort(desc),
    byAgent: [...byAgent.values()].sort(desc),
    turns, perCall,
    summary,
    subagentTotal, subagentCount: subWithCost.size,
  };
}

// Apportion one call's exact output_tokens across what the model emitted: prose
// text, thinking, and the tool_use arguments it wrote. Visible content blocks are
// sized at ~chars/4; when output_tokens exceed that, the excess is interleaved
// thinking the transcript didn't store (returned as unstoredThinking) — attributed
// to the thinking bucket instead of being smeared over tiny tool args. When
// output_tokens are below the chars/4 estimate, the visible parts scale down
// proportionally. Blockless content counts as prose.
function apportionOutput(c) {
  const o = c.tokens.output;
  const p = c.outParts || { text: 0, thinking: 0, toolInput: {} };
  const toolChars = Object.values(p.toolInput).reduce((a, t) => a + t.chars, 0);
  const total = p.text + p.thinking + toolChars;
  const visTok = total / CHARS_PER_TOKEN;
  const scale = o > visTok ? 1 / CHARS_PER_TOKEN : (total > 0 ? o / total : 0);
  const perTool = {};
  for (const [name, t] of Object.entries(p.toolInput)) perTool[name] = { tok: t.chars * scale, count: t.count };
  return {
    text: total > 0 ? p.text * scale : o, // blockless content → all prose
    storedThinking: p.thinking * scale,
    unstoredThinking: total > 0 ? Math.max(0, o - visTok) : 0,
    perTool,
  };
}

// Drill-down for "why is the model's own output so big": per-kind token + billed
// output-cost split, and a thinking breakdown — stored thinking blocks vs unstored
// interleaved thinking (billed in output_tokens but never written to the
// transcript), per-step stats, per-turn attribution so a consumer can say WHICH
// prompts drove the reasoning, and the heaviest single bursts (topSteps), each
// with its trigger — what landed in context right before — and what it did next.
// The thinking TEXT itself is unrecoverable (never persisted anywhere); trigger →
// next-action is the maximum attribution the transcript supports. Null when the
// session has no billed output.
function buildAssistantOutput(mainCalls, mainIdx, triggerByIdx) {
  const kinds = { text: { tokens: 0, cost: 0 }, thinking: { tokens: 0, cost: 0 }, toolCalls: { tokens: 0, cost: 0 } };
  let stored = 0, unstored = 0, withThinking = 0;
  const steps = [];
  const byTurn = new Map();
  for (let j = 0; j < mainCalls.length; j++) {
    const c = mainCalls[j];
    const o = c.tokens.output;
    if (!o) continue;
    const a = apportionOutput(c);
    const think = a.storedThinking + a.unstoredThinking;
    const toolTok = Object.values(a.perTool).reduce((s, t) => s + t.tok, 0);
    const costOf = (tok) => (c.outCost || 0) * (tok / o);
    kinds.text.tokens += a.text; kinds.text.cost += costOf(a.text);
    kinds.thinking.tokens += think; kinds.thinking.cost += costOf(think);
    kinds.toolCalls.tokens += toolTok; kinds.toolCalls.cost += costOf(toolTok);
    stored += a.storedThinking; unstored += a.unstoredThinking;
    if (think > 0) {
      withThinking += 1;
      const trg = triggerByIdx.get(mainIdx[j]);
      steps.push({
        seq: j + 1, tokens: Math.round(think), // main-session step ordinal (1..mainSteps), not the global billed seq
        trigger: trg ? { tool: trg.tool, target: trg.target } : null,
        nextTools: c.tools.slice(0, 3),
      });
    }
    // Keyed by turnIndex (not prompt text) so repeated identical prompts stay
    // distinct rows and consumers can join back to turns[] without text matching.
    const prompt = c.prompt || '(session start)';
    const t = byTurn.get(c.turnIndex) || { turnIndex: c.turnIndex, prompt: prompt.slice(0, 200), kind: turnKind(prompt), steps: 0, thinkingTokens: 0 };
    t.steps += 1; t.thinkingTokens += think; byTurn.set(c.turnIndex, t);
  }
  if (!(kinds.text.tokens + kinds.thinking.tokens + kinds.toolCalls.tokens > 0)) return null;
  for (const k of Object.values(kinds)) k.tokens = Math.round(k.tokens);
  const topSteps = steps.sort((a, b) => b.tokens - a.tokens).slice(0, 5);
  return {
    note: 'The model\'s own output_tokens split by kind (billed at the full output rate — the priciest per-token tier). ' +
      'thinking.unstoredTokens = output_tokens beyond the visible content — interleaved thinking the transcript does not store (its text is unrecoverable); ' +
      'thinking.byTurn names which prompts drove the reasoning; thinking.topSteps are the heaviest single bursts, each with its trigger (what landed in context right before) and the action it took next. ' +
      'Estimates apportioned per call from exact output_tokens.',
    byKind: kinds,
    thinking: topSteps.length ? {
      storedTokens: Math.round(stored),
      unstoredTokens: Math.round(unstored),
      stepsWithThinking: withThinking,
      mainSteps: mainCalls.length,
      avgPerThinkingStep: withThinking ? Math.round((stored + unstored) / withThinking) : 0,
      peakStep: topSteps[0],
      topSteps,
      byTurn: [...byTurn.values()].filter((t) => t.thinkingTokens > 0)
        .map((t) => ({ ...t, thinkingTokens: Math.round(t.thinkingTokens) }))
        .sort((a, b) => b.thinkingTokens - a.thinkingTokens).slice(0, 8),
    } : null,
  };
}

// The context fillers that aren't tool results: the session baseline (system
// prompt + tool definitions — the first call's whole context) and the model's own
// accumulated output, split into what that output actually was — prose replies,
// extended-thinking blocks, and tool-call arguments (Edit payloads, Bash commands,
// subagent prompts). Each call's exact output_tokens are apportioned across those
// kinds by char share (a call with no content blocks counts as text). Without
// these rows the consumer table explains only a fraction of peak context and
// reads as if tool results were the whole story.
function syntheticConsumers(mainCalls, rate) {
  if (!mainCalls.length) return [];
  const n = mainCalls.length;
  const first = mainCalls[0].tokens;
  const baseline = first.cacheRead + first.cacheWrite + first.input;
  const acc = { text: { tok: 0, carried: 0 }, thinking: { tok: 0, carried: 0 } };
  const perTool = new Map(); // tool name → { tok, count }
  let toolTok = 0, toolCarried = 0, toolCount = 0, thinkingCalls = 0;
  mainCalls.forEach((c, i) => {
    if (!c.tokens.output) return;
    const f = (n - 1 - i) * rate; // carried $/token for output landing at step i
    const a = apportionOutput(c);
    acc.text.tok += a.text; acc.text.carried += a.text * f;
    const think = a.storedThinking + a.unstoredThinking;
    acc.thinking.tok += think; acc.thinking.carried += think * f;
    if (think > 0) thinkingCalls += 1;
    for (const [name, t] of Object.entries(a.perTool)) {
      toolTok += t.tok; toolCarried += t.tok * f; toolCount += t.count;
      const e = perTool.get(name) || { tok: 0, count: 0 };
      e.tok += t.tok; e.count += t.count; perTool.set(name, e);
    }
  });
  const kfmt = (x) => (x < 1000 ? String(Math.round(x)) : Math.round(x / 1000) + 'k');
  const toolList = [...perTool.entries()].sort((a, b) => b[1].tok - a[1].tok).slice(0, 4)
    .map(([name, e]) => `${name} ${kfmt(e.tok)}`).join(' · ');
  // synthetic: these rows aggregate the whole session, so their `count` is not a
  // "same target landed N times" repeat count — renderers must not show it as ×N.
  const rows = [
    { tool: 'session-overhead', target: '(system prompt + tool definitions — first-call context)',
      count: 1, estTokens: baseline, carriedCost: baseline * (n - 1) * rate },
    { tool: 'assistant-text', target: `(the model's prose replies across ${n} steps)`,
      count: n, estTokens: Math.round(acc.text.tok), carriedCost: acc.text.carried },
    { tool: 'assistant-thinking', target: '(reasoning before answers/tool calls — incl. thinking not stored in the transcript)',
      count: thinkingCalls, estTokens: Math.round(acc.thinking.tok), carriedCost: acc.thinking.carried },
    { tool: 'assistant-tool-calls', target: `(arguments the model wrote into tool calls${toolList ? ' — ' + toolList : ''})`,
      count: toolCount, estTokens: Math.round(toolTok), carriedCost: toolCarried },
  ];
  return rows.filter((r) => r.estTokens > 0).map((r) => ({ ...r, synthetic: true }));
}

// Roll consumer events up into "what actually filled the context": grouped per
// concrete target (same file read twice = one row, count 2) and per tool, plus
// the synthetic baseline/output rows so the table explains (approximately) the
// whole peak context. Each event's carriedCost ≈ estTokens × steps-remaining ×
// the session's blended cache-read rate — what re-reading that content on every
// later step cost. Estimates (usage data has no per-item attribution); the
// `note` states that so downstream consumers don't present them as exact.
function buildConsumers(events, totalSteps, cacheReadRate, extras) {
  const byKey = new Map();
  const byTool = new Map();
  let totalEstTokens = 0;
  const fold = (tool, target, count, estTokens, carried, synthetic) => {
    totalEstTokens += estTokens;
    const k = `${tool}\u0000${target}`;
    const g = byKey.get(k) || { tool, target, count: 0, estTokens: 0, carriedCost: 0 };
    g.count += count; g.estTokens += estTokens; g.carriedCost += carried;
    if (synthetic) g.synthetic = true;
    byKey.set(k, g);
    const t = byTool.get(tool) || { tool, count: 0, estTokens: 0, carriedCost: 0 };
    t.count += count; t.estTokens += estTokens; t.carriedCost += carried;
    byTool.set(tool, t);
  };
  for (const e of events) {
    fold(e.tool, e.target, 1, e.estTokens,
      e.estTokens * Math.max(0, totalSteps - e.afterStep) * cacheReadRate);
  }
  for (const x of extras || []) fold(x.tool, x.target, x.count, x.estTokens, x.carriedCost, x.synthetic);
  const desc = (a, b) => b.estTokens - a.estTokens;
  return {
    note: 'estTokens ≈ chars/4 of what landed in main-session context (tool results + user prompts; ' +
      'session-overhead covers the baseline; assistant-text / assistant-thinking / assistant-tool-calls split the model\'s own output by kind, apportioned from exact output_tokens); ' +
      'carriedCost ≈ estTokens × steps-remaining × blended cache-read rate — what re-reading it on every later step cost. Estimates, not billed figures.',
    totalEstTokens,
    byTool: [...byTool.values()].sort(desc),
    top: [...byKey.values()].sort(desc).slice(0, 30),
  };
}

// Token threshold above which a call counts as "high context" — re-reading this
// much accumulated context per step is the spend a /compact would have avoided.
const HIGH_CONTEXT = 200000;
// A step-to-step cacheRead drop this large marks a context reset (a /compact, a
// fresh turn that didn't carry prior context, or a /clear).
const RESET_DROP = 100000;

// Derived, analysis-ready rollups so a consumer doesn't hand-roll them (and can't
// cherry-pick a single early call as "the start" or mis-tally tools):
//  - durationMs: wall-clock between first and last main-session call.
//  - mainSteps: main-session billed calls (detail.calls also counts subagents).
//  - contextGrowth: per-step cacheRead — first call, per-quartile averages, peak —
//    the real growth curve (turns.tokens.cacheRead is a per-turn SUM, not context).
//  - byTurnKind: cost + token totals grouped by turnKind, cost-desc, so "how much
//    did all the skill-review / subagent-orchestration turns cost" is one lookup.
//  - toolTally: canonical main-session tool counts (consumers that re-aggregate
//    calls[].tools tend to inflate this — read it here instead).
//  - highContextCost: calls + cost spent above HIGH_CONTEXT (the compactable spend).
//  - contextResets: how many times context was cleared (drop > RESET_DROP);
//    contextResetDropTokens publishes the drop threshold (as highContextCost
//    publishes thresholdTokens) so renderers don't hardcode it.
function buildSummary(main, turns) {
  const ms = main.map((c) => c.ts).filter(Boolean).map((t) => Date.parse(t)).filter((n) => !isNaN(n));
  const durationMs = ms.length >= 2 ? Math.max(...ms) - Math.min(...ms) : 0;
  const cr = main.map((c) => c.tokens.cacheRead);
  const quartiles = [];
  for (let i = 0; i < 4; i++) {
    const seg = cr.slice(Math.floor((cr.length * i) / 4), Math.floor((cr.length * (i + 1)) / 4));
    quartiles.push(seg.length ? Math.round(seg.reduce((a, b) => a + b, 0) / seg.length) : 0);
  }
  const byKind = new Map();
  for (const t of turns) {
    const e = byKind.get(t.kind) || { kind: t.kind, cost: 0, turns: 0, steps: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
    e.cost += t.cost; e.turns += 1; e.steps += t.steps;
    e.cacheRead += t.tokens.cacheRead; e.cacheWrite += t.tokens.cacheWrite; e.output += t.tokens.output;
    byKind.set(t.kind, e);
  }
  const tools = new Map();
  for (const c of main) for (const tn of c.tools) tools.set(tn, (tools.get(tn) || 0) + 1);
  const hi = main.filter((c) => c.tokens.cacheRead > HIGH_CONTEXT);
  let resets = 0;
  for (let i = 1; i < cr.length; i++) if (cr[i - 1] - cr[i] > RESET_DROP) resets++;
  const f = main.length ? main[0].tokens : null;
  return {
    durationMs,
    mainSteps: main.length, // main-session billed calls — the denominator the timeline/thinking use (detail.calls also counts subagents)
    // First-call context (system prompt + tool defs + project context) — SAME
    // formula as syntheticConsumers' session-overhead row, published so renderers
    // don't re-derive it.
    sessionBaselineTokens: f ? f.cacheRead + f.cacheWrite + f.input : 0,
    contextGrowth: { firstCall: cr[0] || 0, quartileAvgContext: quartiles, peakContext: cr.length ? Math.max(...cr) : 0 },
    byTurnKind: [...byKind.values()].sort((a, b) => b.cost - a.cost),
    toolTally: [...tools.entries()].sort((a, b) => b[1] - a[1]),
    highContextCost: { thresholdTokens: HIGH_CONTEXT, calls: hi.length, cost: hi.reduce((a, c) => a + c.cost, 0) },
    contextResets: resets,
    contextResetDropTokens: RESET_DROP,
  };
}

module.exports = { promptText, parseCalls, buildDetail };
