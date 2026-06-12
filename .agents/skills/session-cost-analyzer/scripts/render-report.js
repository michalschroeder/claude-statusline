#!/usr/bin/env node
'use strict';
// Deterministic HTML report renderer. Reads an `analyze.js <prefix>` detail payload
// (JSON on stdin) and fills assets/report-template.html, so report generation is a
// tested, repeatable transform instead of hand-built <tr> rows on every run. All
// user-derived text (titles, prompts, subagent task labels) is HTML-escaped.
//
//   node scripts/analyze.js <prefix> | node scripts/render-report.js [--out <path>]
//
// Without --out the file is written into the current working directory as
// session-cost-<first8-of-session>.html (one file per session id); the final path is
// printed to stdout. Self-contained — no deps outside this folder.
const fs = require('fs');
const path = require('path');

const TEMPLATE = path.join(__dirname, '..', 'assets', 'report-template.html');

// ---- formatting helpers -------------------------------------------------------

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// USD with enough precision to stay informative for sub-cent sessions.
function money(n) {
  const v = Number(n) || 0;
  if (v >= 0.005) return '$' + v.toFixed(2);
  if (v > 0) return '$' + v.toFixed(4);
  return '$0.00';
}

// Token counts → compact "140k" / "1.2M".
function compactTokens(n) {
  const v = Number(n) || 0;
  if (v < 1000) return String(Math.round(v));
  if (v < 1e6) return Math.round(v / 1000) + 'k';
  return (v / 1e6).toFixed(1) + 'M';
}

function duration(ms) {
  const s = Math.round((Number(ms) || 0) / 1000);
  if (s < 60) return s + 's';
  const m = Math.round(s / 60);
  if (m < 60) return m + 'm';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}

function truncate(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

// ---- row builders -------------------------------------------------------------

const COMPONENT_LABELS = {
  cacheRead: 'cache read', cacheWrite: 'cache write',
  input: 'input', output: 'output', web: 'web search',
};

function whereItWentRows(components, total) {
  const t = Number(total) || 0;
  const entries = Object.keys(COMPONENT_LABELS)
    .map((k) => ({ label: COMPONENT_LABELS[k], cost: Number(components[k]) || 0 }))
    .filter((e) => e.cost > 0)
    .sort((a, b) => b.cost - a.cost);
  if (!entries.length) return '<tr><td colspan="3" class="prompt">no cost recorded</td></tr>';
  return entries.map((e) => {
    const pct = t > 0 ? Math.round((e.cost / t) * 100) : 0;
    return `<tr><td>${esc(e.label)}</td><td class="num">${money(e.cost)}</td>` +
      `<td><div class="bar" style="width:${pct}%"></div></td></tr>`;
  }).join('\n');
}

function byModelRows(byModel) {
  if (!byModel || !byModel.length) return '<tr><td colspan="2" class="prompt">—</td></tr>';
  return byModel.map((m) =>
    `<tr><td>${esc(m.model)}</td><td class="num">${money(m.cost)}</td></tr>`).join('\n');
}

// The shared summary-cell hover contract (TOP TURNS / consumers / thinking rows):
// whenever the cell shows anything other than the full text — a Haiku summary or a
// truncation — the full text stays one hover away on the styled .tip card. Cells
// opt in via the `has-tip` class; data-tip-h is the card's header line.
function tipCell(what, full, tipHead) {
  return full && full !== what
    ? `<td class="prompt has-tip" data-tip-h="${esc(tipHead)}" data-full="${esc(full)}">${esc(what)}</td>`
    : `<td class="prompt">${esc(what)}</td>`;
}

// Cell text: a model-written summary (set when summaries were merged) wins with a
// generous cap; else the truncated raw text.
function whatText(summary, full) {
  return summary && summary.trim() ? truncate(summary, 600) : truncate(full, 110);
}

// The WHAT column. A model-written summary (turn.summary, set when merged) wins —
// now a descriptive sentence, so it gets a generous cap. Otherwise: skill rows go blank
// (the skill name has its own column), subagent-return turns get a fixed label, and
// genuine user turns keep their own (truncated) words.
function turnWhat(t) {
  if (t.summary) return truncate(t.summary, 600);
  if (t.kind === 'skill') return '';
  if (t.kind === 'subagent-orchestration') return '↩ subagent results';
  return truncate(t.prompt, 200);
}

function topTurnsRows(turns, limit) {
  const ranked = (turns || []).slice().sort((a, b) => b.cost - a.cost).slice(0, limit);
  if (!ranked.length) return '<tr><td colspan="5" class="prompt">—</td></tr>';
  return ranked.map((t) => {
    const what = turnWhat(t);
    // Tooltip only where the raw message adds detail beyond the cell — i.e. real user
    // turns, even a short "do it". Skill expansions and <task-notification> blobs are
    // boilerplate: full='' → no tooltip, no giant native popup.
    const full = t.kind === 'user' ? truncate(t.prompt, 600) : '';
    return `<tr><td class="num">${money(t.cost)}</td><td>${esc(t.kind)}</td>` +
      `<td>${esc(t.skill || '')}</td><td class="num">${compactTokens(t.peakContext)}</td>` +
      tipCell(what, full, `${t.kind} message`) + `</tr>`;
  }).join('\n');
}

// What filled the context, per tool — count of results, est tokens, share bar.
function consumerToolRows(cc) {
  const rows = (cc && cc.byTool) || [];
  if (!rows.length) return '<tr><td colspan="5" class="prompt">no consumer data (re-run analyze.js to regenerate)</td></tr>';
  const total = Math.max(1, Number(cc.totalEstTokens) || 0);
  return rows.map((t) => {
    const pct = Math.round((Number(t.estTokens) || 0) / total * 100);
    return `<tr><td>${esc(t.tool)}</td><td class="num">${esc(t.count)}</td>` +
      `<td class="num">${compactTokens(t.estTokens)}</td>` +
      `<td class="num">${money(t.carriedCost)}</td>` +
      `<td><div class="bar" style="width:${pct}%"></div></td></tr>`;
  }).join('\n');
}

// Top individual context consumers — the concrete file/command/prompt that landed
// in context, est tokens, and the carried re-read cost.
function consumerRows(cc, limit) {
  const rows = ((cc && cc.top) || []).slice(0, limit);
  if (!rows.length) return '<tr><td colspan="5" class="prompt">no consumer data (re-run analyze.js to regenerate)</td></tr>';
  const total = Math.max(1, Number(cc.totalEstTokens) || 0);
  return rows.map((c) => {
    const pct = Math.round((Number(c.estTokens) || 0) / total * 100);
    // synthetic rows aggregate the whole session — their count isn't a repeat count
    const tool = c.count > 1 && !c.synthetic ? `${c.tool} ×${c.count}` : c.tool;
    // The cell shows a model-written summary (c.summary, when merged) or the
    // truncated raw target; the exact file/command/prompt stays one hover away.
    const full = c.target || '';
    const what = whatText(c.summary, full);
    return `<tr><td class="num">${compactTokens(c.estTokens)}</td>` +
      `<td><div class="bar" style="width:${pct}%"></div></td>` +
      `<td class="num">${money(c.carriedCost)}</td><td>${esc(tool)}</td>` +
      tipCell(what, full, `${c.tool} target`) + `</tr>`;
  }).join('\n');
}

// Thinking drill-down headline: how much, billed cost, stored vs unstored split,
// per-step stats and the peak step. Plain text — the caller escapes it.
function thinkingSummary(ao) {
  const th = ao && ao.thinking;
  if (!th) return 'no thinking recorded (or payload predates summary.assistantOutput — re-run analyze.js)';
  const pk = th.peakStep || {};
  return `${compactTokens(th.storedTokens + th.unstoredTokens)} tokens ${money(ao.byKind.thinking.cost)} billed at the output rate — ` +
    `${compactTokens(th.unstoredTokens)} interleaved (billed, never saved to the transcript) + ` +
    `${compactTokens(th.storedTokens)} saved as thinking blocks · ` +
    `${th.stepsWithThinking}/${th.mainSteps} steps thought · avg ${compactTokens(th.avgPerThinkingStep)}/step · ` +
    `peak ${compactTokens(pk.tokens)} at step ${pk.seq}${(pk.nextTools || []).length ? ' → ' + pk.nextTools.join(', ') : ''}`;
}

// Which prompts drove the reasoning — one row per thinking.byTurn entry.
// byTurn rows carry the same turnIndex as turns[], so when summaries are merged we
// join on it and reuse that turn's summary (and full prompt) here instead
// of re-summarizing. Same hover contract as the other tables.
function thinkingTurnRows(ao, limit, turns) {
  const th = ao && ao.thinking;
  const rows = ((th && th.byTurn) || []).slice(0, limit);
  if (!rows.length) return '<tr><td colspan="4" class="prompt">—</td></tr>';
  const total = Math.max(1, (th.storedTokens + th.unstoredTokens) || 0);
  const byIndex = new Map((turns || []).filter((t) => t && t.turnIndex != null).map((t) => [t.turnIndex, t]));
  return rows.map((t) => {
    const pct = Math.round((Number(t.thinkingTokens) || 0) / total * 100);
    const match = byIndex.get(t.turnIndex) || {};
    const fullText = match.prompt || t.prompt || '';
    const what = whatText(match.summary, fullText);
    // Tooltip only for real user turns — skill expansions etc. are boilerplate (same policy as topTurnsRows).
    const full = t.kind === 'user' ? truncate(fullText, 600) : '';
    return `<tr><td class="num">${compactTokens(t.thinkingTokens)}</td>` +
      `<td><div class="bar" style="width:${pct}%"></div></td>` +
      `<td class="num">${esc(t.steps)}</td>` +
      tipCell(what, full, `${t.kind} message`) + `</tr>`;
  }).join('\n');
}

// The heaviest single reasoning bursts: trigger (what landed in context right
// before) → next action. The thinking text itself is never persisted.
function thinkingStepRows(ao, limit) {
  const rows = ((ao && ao.thinking && ao.thinking.topSteps) || []).filter((b) => b.trigger).slice(0, limit);
  if (!rows.length) return '<tr><td colspan="4" class="prompt">—</td></tr>';
  return rows.map((b) =>
    `<tr><td class="num">${compactTokens(b.tokens)}</td>` +
    `<td class="num">${esc(b.seq)}</td>` +
    `<td class="prompt">${esc(b.trigger.tool)}: ${esc(truncate(b.trigger.target, 90))}</td>` +
    `<td>${esc((b.nextTools || []).join(', ') || 'replied')}</td></tr>`).join('\n');
}

// Cost per skill dispatch — only the turns the skill itself drove.
function skillRows(bySkill) {
  const rows = bySkill || [];
  if (!rows.length) return '<tr><td colspan="4" class="prompt">no skill dispatches</td></tr>';
  return rows.map((s) =>
    `<tr><td>${esc(s.skill)}</td><td class="num">${esc(s.turns)}</td>` +
    `<td class="num">${esc(s.steps)}</td><td class="num">${money(s.cost)}</td></tr>`).join('\n');
}

// Chart-threshold fallbacks, mirroring the data layer (lib/session-detail.js).
// render() prefers the payload's own summary.highContextCost.thresholdTokens and
// summary.contextResetDropTokens; these defaults only cover older payloads.
const HIGH_CONTEXT = 200000;
const RESET_DROP = 100000;
// Context size at one step = the call's cacheRead (re-read accumulated context).
// SAME basis the data layer uses for summary.highContextCost and contextResets, so
// the chart's tiers and reset lines never contradict the cards rendered beside them.
const ctxOf = (c) => (c.tokens && c.tokens.cacheRead) || 0;
// Chart colors are CSS classes defined once in the template's <style> (next to
// the legend swatches, so chart and legend can't diverge).
const tierClass = (v, highCtx, resetDrop) => (v >= highCtx ? 'c-high' : v >= resetDrop ? 'c-mid' : 'c-low');
const KIND_CLASS = {
  user: 'c-user', skill: 'c-skill', 'subagent-orchestration': 'c-orch',
  'session-start': 'c-start', overhead: 'c-dim',
};

// Context-window timeline: one SVG bar per main-session step (subagents run in
// their own context and are excluded). Height = context size at that step,
// colored by the high-context tier. Turn-start ticks under the axis, dashed
// reset line on a context drop > resetDrop. Bars carry data-* attributes for
// the template's hover readout plus a native <title> tooltip; everything
// user-derived is escaped.
function contextTimeline(calls, turns, highCtx = HIGH_CONTEXT, resetDrop = RESET_DROP) {
  const main = (calls || []).filter((c) => c.isMain);
  if (!main.length) return '<p class="prompt">no per-call data in this payload — re-run analyze.js to regenerate</p>';
  const W = 860, H = 210, padL = 44, padR = 6, padT = 10, padB = 22;
  const chartW = W - padL - padR, chartH = H - padT - padB, baseY = padT + chartH;
  const peak = Math.max(...main.map(ctxOf), 1);
  // Keep a fixed minimum ceiling above 200k so the red danger zone is always a
  // real visible band (not a sliver) even when a session never gets there; tall
  // sessions still scale to their own peak.
  const yMax = Math.max(peak * 1.05, highCtx * 1.3);
  const xAt = (i) => padL + (i + 0.1) * (chartW / main.length);
  const yAt = (v) => padT + chartH * (1 - v / yMax);
  const barW = Math.max((chartW / main.length) * 0.8, 0.8);
  // Key on turnIndex, not prompt text: two distinct turns with identical text
  // (e.g. "continue" twice) stay separate ticks.
  const kindOf = new Map((turns || []).map((t) => [t.turnIndex, t.kind]));
  const parts = [];
  // Faint severity zones painted behind everything: green 0–100k, amber 100–200k,
  // red above 200k. They make all three tier colors legible even on a low session,
  // so the bar colors always read against a constant backdrop.
  const band = (cls, topV, botV) => {
    const y0 = yAt(topV), y1 = yAt(botV);
    parts.push(`<rect class="ctx-zone ${cls}" x="${padL}" y="${y0.toFixed(1)}" width="${chartW.toFixed(1)}" height="${(y1 - y0).toFixed(1)}"/>`);
  };
  band('zone-high', yMax, highCtx);
  band('zone-mid', highCtx, resetDrop);
  band('zone-low', resetDrop, 0);
  for (const g of [resetDrop, highCtx]) {
    const gy = yAt(g).toFixed(1);
    const warn = g === highCtx;
    parts.push(`<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" class="${warn ? 'grid-warn' : 'grid'}" stroke-dasharray="4 4"/>`);
    parts.push(`<text x="2" y="${(Number(gy) + 3).toFixed(1)}" class="ctx-axis">${g / 1000}k</text>`);
  }
  let prevTurn = null, prevCtx = 0;
  main.forEach((c, i) => {
    const v = ctxOf(c);
    const xv = xAt(i).toFixed(1);
    const step = i + 1; // main-session step ordinal (matches summary.mainSteps / thinking seq)
    if (i > 0 && prevCtx - v > resetDrop) {
      parts.push(`<line x1="${xv}" y1="${padT}" x2="${xv}" y2="${baseY}" class="reset-line" stroke-dasharray="2 3"><title>context dropped ${esc(compactTokens(prevCtx))} → ${esc(compactTokens(v))} — /compact, context clear, or a cache rebuild</title></line>`);
    }
    if (c.prompt && c.turnIndex !== prevTurn) {
      const tick = kindOf.get(c.turnIndex) === 'user' ? 'c-user' : 'c-dim';
      parts.push(`<rect class="ctx-turn ${tick}" x="${xv}" y="${baseY + 3}" width="${Math.max(barW, 2).toFixed(2)}" height="5"><title>${esc(truncate(c.prompt, 110))}</title></rect>`);
      prevTurn = c.turnIndex;
    }
    const h = Math.max(baseY - yAt(v), 0.5);
    parts.push(`<rect class="ctx-bar ${tierClass(v, highCtx, resetDrop)}" x="${xv}" y="${yAt(v).toFixed(1)}" width="${barW.toFixed(2)}" height="${h.toFixed(1)}"` +
      ` data-step="${esc(step)}" data-ctx="${esc(compactTokens(v))}" data-cost="${esc(money(c.cost))}" data-prompt="${esc(truncate(c.prompt || '', 110))}">` +
      `<title>step ${esc(step)} · ${esc(compactTokens(v))} context · ${esc(money(c.cost))}</title></rect>`);
    prevCtx = v;
  });
  parts.push(`<line x1="${padL}" y1="${baseY}" x2="${W - padR}" y2="${baseY}" class="grid"/>`);
  return `<svg class="ctx-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="context window size per step">${parts.join('')}</svg>`;
}

// Grouped horizontal context bar: consecutive main-session steps serving the same
// prompt collapse into ONE segment, whose width is how much the context grew while
// that turn ran (next turn's starting context − this turn's). A dim leading segment
// is the session's fixed overhead (everything in context before the first reply).
// Zero-growth turns are skipped; a drop > resetDrop renders as a dashed reset divider.
function contextGrowthBar(calls, turns, resetDrop = RESET_DROP, baselineTokens = null) {
  const main = (calls || []).filter((c) => c.isMain);
  if (!main.length) return '<p class="prompt">no per-call data in this payload — re-run analyze.js to regenerate</p>';
  const groups = [];
  for (const c of main) {
    const last = groups[groups.length - 1];
    if (last && last.turnIndex === c.turnIndex) {
      last.end = ctxOf(c); last.steps += 1; last.cost += c.cost;
    } else {
      groups.push({ turnIndex: c.turnIndex, prompt: c.prompt || '', start: ctxOf(c), end: ctxOf(c), steps: 1, cost: c.cost });
    }
  }
  const kindOf = new Map((turns || []).map((t) => [t.turnIndex, t.kind]));
  // Leading segment = the session baseline (system prompt + tool defs + project
  // context) — summary.sessionBaselineTokens, published by the data layer with the
  // SAME formula as the session-overhead consumer row. Local derivation only covers
  // payloads predating the field.
  const f = main[0].tokens || {};
  const baseline = baselineTokens != null
    ? baselineTokens
    : (f.cacheRead || 0) + (f.cacheWrite || 0) + (f.input || 0);
  // Growth attributed to a turn = the next turn's starting context − its own
  // (everything the turn read + wrote that later steps re-read). Negative = a reset.
  const items = [{ seg: { label: 'session start — system prompt, tool definitions, project context', from: 0, to: baseline, grow: baseline, steps: 0, cost: 0, kind: 'overhead' } }];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const nextStart = i + 1 < groups.length ? groups[i + 1].start : g.end;
    const grow = nextStart - g.start;
    if (grow < -resetDrop) { items.push({ reset: -grow }); continue; }
    if (grow <= 0) continue;
    items.push({ seg: { label: g.prompt, from: g.start, to: g.start + grow, grow, steps: g.steps, cost: g.cost, kind: kindOf.get(g.turnIndex) || 'user' } });
  }
  const total = items.reduce((a, it) => a + (it.seg ? it.seg.grow : 0), 0);
  if (total <= 0) return '<p class="prompt">context never grew — nothing to chart</p>';
  const W = 860, H = 56, barY = 6, barH = 26, padL = 2, padR = 2;
  const chartW = W - padL - padR;
  // Proportional widths with a small visible floor, then scaled so floors + segments
  // never exceed chartW — a session with hundreds of turns shrinks to fit instead of
  // drawing the latest (often priciest) segments off the edge.
  const MIN_W = 1.2;
  const segWidths = items.filter((it) => it.seg).map((it) => Math.max((it.seg.grow / total) * chartW, MIN_W));
  const sumW = segWidths.reduce((a, b) => a + b, 0);
  const scale = sumW > chartW ? chartW / sumW : 1;
  const parts = [];
  let x = padL, si = 0;
  for (const it of items) {
    if (it.reset) {
      parts.push(`<line x1="${x.toFixed(1)}" y1="${barY - 3}" x2="${x.toFixed(1)}" y2="${barY + barH + 3}" class="divider" stroke-dasharray="2 3"><title>context cleared here — dropped ${esc(compactTokens(it.reset))} (/compact or context clear)</title></line>`);
      continue;
    }
    const s = it.seg;
    const w = segWidths[si++] * scale;
    const tip = s.kind === 'overhead'
      ? `${s.label} · ${compactTokens(s.grow)}`
      : `${truncate(s.label, 110)} — grew context ${compactTokens(s.from)} → ${compactTokens(s.to)} (+${compactTokens(s.grow)}) · ${s.steps} steps · ${money(s.cost)}`;
    parts.push(`<rect class="ctx-seg ${KIND_CLASS[s.kind] || KIND_CLASS.user}" x="${x.toFixed(1)}" y="${barY}" width="${w.toFixed(1)}" height="${barH}"` +
      ` data-kind="${esc(s.kind)}" data-grow="${esc(compactTokens(s.grow))}" data-from="${esc(compactTokens(s.from))}" data-to="${esc(compactTokens(s.to))}"` +
      ` data-steps="${esc(s.steps)}" data-cost="${esc(money(s.cost))}" data-prompt="${esc(truncate(s.label, 110))}">` +
      `<title>${esc(tip)}</title></rect>`);
    x += w;
  }
  parts.push(`<text x="${padL}" y="${H - 4}" class="ctx-axis">0</text>`);
  parts.push(`<text x="${W - padR}" y="${H - 4}" class="ctx-axis" text-anchor="end">+${compactTokens(total)} total context added</text>`);
  return `<svg class="ctx-growbar" viewBox="0 0 ${W} ${H}" role="img" aria-label="context growth grouped by turn">${parts.join('')}</svg>`;
}

// byAgent carries the main session as name 'main'; the Subagents table is the
// fan-out only, so drop that row. Empty → an explicit placeholder, not a blank table.
function subagentRows(byAgent) {
  const subs = (byAgent || []).filter((a) => a.name !== 'main');
  if (!subs.length) return '<tr><td colspan="2" class="prompt">no subagents</td></tr>';
  return subs.map((a) =>
    `<tr><td class="prompt">${esc(truncate(a.label, 100))}</td>` +
    `<td class="num">${money(a.cost)}</td></tr>`).join('\n');
}

// "Spending less next time" — a 1–5 session grade plus verdict-tagged cards, each split into
// WHAT happened / WHY it cost / HOW to act. The grade is always AI-written: the analyzer
// workflow runs a strong-model draft + adversarial critic over EVALUATION.md and the report,
// and merges the result into summary.aiAssessment. This renderer just formats it (pure
// transform — no LLM in here); with no aiAssessment present the section renders empty.

const GRADE = {
  1: { word: 'Very poor' }, 2: { word: 'Poor' }, 3: { word: 'Fair' },
  4: { word: 'Good' }, 5: { word: 'Excellent' },
};
const normVerdict = (v) => (v === 'good' || v === 'bad' ? v : 'warn');
const clampRating = (v) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 1 && n <= 5 ? n : null;
};

// → { rating: 1–5|null, headline, cards:[{verdict,title,what,why,how}] }.
// The assessment is always AI-written (the analyzer workflow grades every session via subagents
// and merges the result into summary.aiAssessment). When it's absent — only a raw manual
// `render-report.js < detail.json` with no merge step — the grade section renders empty.
function buildAssessment(detail) {
  const s = detail.summary || {};
  const ai = s.aiAssessment;
  if (ai && typeof ai === 'object' && (Array.isArray(ai.cards) && ai.cards.length || ai.rating != null)) {
    const cards = (Array.isArray(ai.cards) ? ai.cards : []).map((c) => ({
      verdict: normVerdict(c.verdict), title: String(c.title || ''),
      what: String(c.what || ''), why: String(c.why || ''), how: String(c.how || ''),
    }));
    return { rating: clampRating(ai.rating), headline: String(ai.headline || ''), cards };
  }
  return { rating: null, headline: '', cards: [] };
}

// The 1–5 grade badge that sits at the very top of the report. Empty when unrated.
function ratingBadge(a) {
  const r = clampRating(a.rating);
  if (r == null) return '';
  const word = (GRADE[r] || GRADE[3]).word;
  const pips = Array.from({ length: 5 }, (_, i) =>
    `<span class="pip${i < r ? ' on' : ''}"></span>`).join('');
  return `<div class="grade grade-${r}">
    <div class="grade-score"><span class="grade-num">${r}</span><span class="grade-max">/5</span></div>
    <div class="grade-meta"><div class="grade-word">${esc(word)}</div>
      <div class="grade-pips">${pips}</div>` +
    (a.headline ? `<div class="grade-line">${esc(a.headline)}</div>` : '') +
    `</div></div>`;
}

// The assessment cards: each a colored panel with WHAT / WHY / HOW blocks. The HOW block is
// "Keep it up" on a good card (reinforce) and "How to fix" on a bad/warn card; omitted if empty.
function assessmentCards(a) {
  if (!a.cards.length) {
    return '<div class="acard acard-good"><div class="ablk"><span class="atext">No assessment ' +
      'available for this session.</span></div></div>';
  }
  const blk = (label, text) => text
    ? `<div class="ablk"><span class="alabel">${label}</span><span class="atext">${esc(text)}</span></div>` : '';
  return a.cards.map((c) => {
    const howLabel = c.verdict === 'good' ? 'Keep it up' : 'How to fix';
    const body = blk('What', c.what) + blk('Why', c.why) + blk(howLabel, c.how);
    return `<div class="acard acard-${normVerdict(c.verdict)}">` +
      (c.title ? `<div class="acard-title">${esc(c.title)}</div>` : '') +
      (body || '<div class="ablk"><span class="atext"></span></div>') + `</div>`;
  }).join('\n');
}

// ---- fill ---------------------------------------------------------------------

// Single pass over the ORIGINAL template: a {{TOKEN}} that appears inside an
// already-substituted value (e.g. a prompt or title containing the literal text
// "{{SUBAGENT_ROWS}}") is never rescanned, so user-derived text can't inject
// generated markup. The replacer form also leaves `$` sequences in values intact.
function fillSlots(tpl, slots) {
  return tpl.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in slots ? slots[k] : m));
}

function render(detail, template) {
  const s = detail.summary || {};
  const hc = s.highContextCost || {};
  const cg = s.contextGrowth || {};
  // Thresholds come from the payload so chart and cards can't disagree;
  // module constants only cover payloads predating the fields.
  const highCtx = hc.thresholdTokens || HIGH_CONTEXT;
  const resetDrop = s.contextResetDropTokens || RESET_DROP;
  const assess = buildAssessment(detail);
  return fillSlots(template, {
    SESSION_ID: esc(detail.session),
    TITLE: esc(detail.title || '—'),
    STARTED_AT: esc(detail.startedAt),
    TOTAL_COST: money(detail.totalCost),
    // main-session steps — what the timeline draws and thinking counts (detail.steps
    // also counts subagent calls, which would not match the bars below).
    STEP_COUNT: esc(s.mainSteps != null ? s.mainSteps : detail.steps),
    DURATION: duration(s.durationMs),
    HIGH_CTX_COST: money(hc.cost),
    HIGH_CTX_CALLS: esc(hc.calls || 0),
    CONTEXT_RESETS: esc(s.contextResets || 0),
    PEAK_CONTEXT: compactTokens(cg.peakContext),
    CONTEXT_TIMELINE: contextTimeline(detail.calls, detail.turns, highCtx, resetDrop),
    CONTEXT_GROWTH_BAR: contextGrowthBar(detail.calls, detail.turns, resetDrop, s.sessionBaselineTokens),
    WHERE_IT_WENT_ROWS: whereItWentRows(detail.components || {}, detail.totalCost),
    CONSUMER_TOOL_ROWS: consumerToolRows(s.contextConsumers),
    CONSUMER_ROWS: consumerRows(s.contextConsumers, 20),
    CONSUMERS_NOTE: esc((s.contextConsumers && s.contextConsumers.note) || ''),
    THINKING_SUMMARY: esc(thinkingSummary(s.assistantOutput)),
    THINKING_TURN_ROWS: thinkingTurnRows(s.assistantOutput, 8, detail.turns),
    THINKING_STEP_ROWS: thinkingStepRows(s.assistantOutput, 5),
    SKILL_ROWS: skillRows(s.bySkill),
    BY_MODEL_ROWS: byModelRows(detail.byModel),
    TOP_TURNS_ROWS: topTurnsRows(detail.turns, 10),
    SUBAGENT_ROWS: subagentRows(detail.byAgent),
    RATING_BADGE: ratingBadge(assess),
    ASSESS_CARDS: assessmentCards(assess),
  });
}

// ---- cli ----------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') {
      const v = argv[i + 1];
      if (v == null || v.startsWith('--')) { process.stderr.write('render-report.js: --out requires a path\n'); process.exit(1); }
      opts.out = v; i++;
    }
    else { process.stderr.write(`render-report.js: unexpected argument '${argv[i]}'\n`); process.exit(1); }
  }
  return opts;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let s = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (s += d));
    process.stdin.on('end', () => resolve(s));
    process.stdin.on('error', reject);
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const raw = await readStdin();
  let detail;
  try { detail = JSON.parse(raw); }
  catch { process.stderr.write('render-report.js: stdin is not valid JSON (pipe `analyze.js <prefix>` into me)\n'); process.exit(1); }
  if (!detail || !detail.session) {
    process.stderr.write('render-report.js: input is not a detail payload (missing `session`)\n');
    process.exit(1);
  }
  const template = fs.readFileSync(TEMPLATE, 'utf8');
  const html = render(detail, template);
  const id = String(detail.session).slice(0, 8);
  // Default: the current working directory (one file per session id, so re-running a session
  // overwrites its own report rather than piling up). An explicit --out still writes exactly
  // where asked.
  const out = opts.out || path.join(process.cwd(), `session-cost-${id}.html`);
  fs.writeFileSync(out, html);
  process.stdout.write(out + '\n');
}

module.exports = { render, money, compactTokens, duration };

if (require.main === module) main();
