#!/usr/bin/env node
'use strict';
// Pure merge helper for the optional Haiku summaries. Reads an analyze.js DETAIL payload
// on stdin and a summaries map, and writes the payload back with summary fields filled in,
// so render-report.js shows a "what this is" one-liner instead of the raw prompt/target.
// No network, no model call — the summaries are produced upstream by the skill agent
// dispatching cheap Haiku subagents (see SKILL.md), keeping this stage deterministic and
// testable. Two report sections take summaries:
//   • TOP TURNS              → keyed by each turn's `turnIndex` (stable, unlike prompt text)
//   • Top context consumers  → keyed by 0-based index into summary.contextConsumers.top
//
// Pipeline:
//   node scripts/analyze.js <prefix> > detail.json
//   # agent dispatches Haiku subagents over detail.json → summaries.json
//   node scripts/apply-summaries.js --summaries summaries.json < detail.json \
//     | node scripts/render-report.js --out ./session-cost-<id>.html
//
// summaries.json shapes (all keys are integers, all values short phrases):
//   namespaced : { "turns": { "<turnIndex>": "…" }, "consumers": { "<index>": "…" } }
//   flat        : { "<turnIndex>": "…" }  (or [{turnIndex,summary}])  → applied to turns only
//
// Unknown keys are ignored; un-summarized rows keep their deterministic label. A
// bad/absent map → the payload passes through unchanged, so the report always renders.
const fs = require('fs');

function parseArgs(argv) {
  const opts = { summaries: undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--summaries') {
      if (i + 1 >= argv.length) { process.stderr.write('apply-summaries.js: --summaries requires a path\n'); process.exit(1); }
      opts.summaries = argv[++i];
    }
  }
  return opts;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (buf += d));
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

// Normalize either shape — { "<turnIndex>": "text" } or [{turnIndex, summary}] — into a
// Map<number, string> of trimmed non-empty summaries.
function toMap(parsed) {
  const m = new Map();
  const put = (k, v) => {
    const idx = Number(k);
    const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
    if (Number.isFinite(idx) && s) m.set(idx, s);
  };
  if (Array.isArray(parsed)) for (const r of parsed) { if (r) put(r.turnIndex, r.summary); }
  else if (parsed && typeof parsed === 'object') for (const k of Object.keys(parsed)) put(k, parsed[k]);
  return m;
}

// Split the file into per-section maps. Namespaced shape ({turns,consumers}) routes each
// section; any other shape is the legacy flat map → turns only (back-compat).
function extractMaps(parsed) {
  const ns = parsed && !Array.isArray(parsed) && typeof parsed === 'object'
    && (parsed.turns !== undefined || parsed.consumers !== undefined);
  if (ns) return { turns: toMap(parsed.turns), consumers: toMap(parsed.consumers) };
  return { turns: toMap(parsed), consumers: new Map() };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const raw = await readStdin();
  let payload;
  try { payload = JSON.parse(raw); } catch { process.stdout.write(raw); return; } // passthrough non-JSON

  let maps = { turns: new Map(), consumers: new Map() };
  if (opts.summaries !== undefined) {
    try { maps = extractMaps(JSON.parse(fs.readFileSync(opts.summaries, 'utf8'))); }
    catch (e) { process.stderr.write(`apply-summaries.js: could not read summaries (${e.message}) — passing through\n`); }
  }

  let applied = 0;
  if (maps.turns.size && Array.isArray(payload.turns)) {
    for (const t of payload.turns) {
      if (t && maps.turns.has(t.turnIndex)) { t.summary = maps.turns.get(t.turnIndex); applied++; }
    }
  }
  let appliedCc = 0;
  const top = payload.summary && payload.summary.contextConsumers && payload.summary.contextConsumers.top;
  if (maps.consumers.size && Array.isArray(top)) {
    top.forEach((c, i) => {
      if (c && maps.consumers.has(i)) { c.summary = maps.consumers.get(i); appliedCc++; }
    });
  }
  process.stderr.write(`apply-summaries: applied ${applied} turn + ${appliedCc} consumer summaries\n`);
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
}

main();
