#!/usr/bin/env node
'use strict';
// Deterministic HTML report renderer. Reads an `analyze.js <prefix>` detail payload
// (JSON on stdin) and fills assets/report-template.html, so report generation is a
// tested, repeatable transform instead of hand-built <tr> rows on every run. All
// user-derived text (titles, prompts, subagent task labels) is HTML-escaped.
//
//   node scripts/analyze.js <prefix> | node scripts/render-report.js [--out <path>]
//
// Without --out the file is written to ./session-cost-<first8-of-session>.html in the
// cwd; the final path is printed to stdout. Self-contained — no deps outside this folder.
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

// Token counts → compact "140k" / "1.2M", matching the statusline's formatCompact tiers.
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

function topTurnsRows(turns, limit) {
  const ranked = (turns || []).slice().sort((a, b) => b.cost - a.cost).slice(0, limit);
  if (!ranked.length) return '<tr><td colspan="4" class="prompt">—</td></tr>';
  return ranked.map((t) =>
    `<tr><td class="num">${money(t.cost)}</td><td>${esc(t.kind)}</td>` +
    `<td class="num">${compactTokens(t.peakContext)}</td>` +
    `<td class="prompt">${esc(truncate(t.prompt, 120))}</td></tr>`).join('\n');
}

// byAgent carries the main session as label 'main session'; the Subagents table is
// the fan-out only, so drop that row. Empty → an explicit placeholder, not a blank table.
function subagentRows(byAgent) {
  const subs = (byAgent || []).filter((a) => a.label !== 'main session');
  if (!subs.length) return '<tr><td colspan="2" class="prompt">no subagents</td></tr>';
  return subs.map((a) =>
    `<tr><td class="prompt">${esc(truncate(a.label, 100))}</td>` +
    `<td class="num">${money(a.cost)}</td></tr>`).join('\n');
}

// ---- fill ---------------------------------------------------------------------

function fillSlots(tpl, slots) {
  let out = tpl;
  for (const [k, v] of Object.entries(slots)) out = out.split(`{{${k}}}`).join(v);
  return out;
}

function render(detail, template) {
  const s = detail.summary || {};
  const hc = s.highContextCost || {};
  const cg = s.contextGrowth || {};
  return fillSlots(template, {
    SESSION_ID: esc(detail.session),
    TITLE: esc(detail.title || '—'),
    STARTED_AT: esc(detail.startedAt),
    TOTAL_COST: money(detail.totalCost),
    STEP_COUNT: esc(detail.steps),
    DURATION: duration(s.durationMs),
    HIGH_CTX_COST: money(hc.cost),
    HIGH_CTX_CALLS: esc(hc.calls || 0),
    CONTEXT_RESETS: esc(s.contextResets || 0),
    PEAK_CONTEXT: compactTokens(cg.peakContext),
    WHERE_IT_WENT_ROWS: whereItWentRows(detail.components || {}, detail.totalCost),
    BY_MODEL_ROWS: byModelRows(detail.byModel),
    TOP_TURNS_ROWS: topTurnsRows(detail.turns, 10),
    SUBAGENT_ROWS: subagentRows(detail.byAgent),
  });
}

// ---- cli ----------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') { opts.out = argv[++i]; }
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
  const out = opts.out || `./session-cost-${String(detail.session).slice(0, 8)}.html`;
  fs.writeFileSync(out, html);
  process.stdout.write(out + '\n');
}

module.exports = { render, money, compactTokens, duration, esc, whereItWentRows, subagentRows };

if (require.main === module) main();
