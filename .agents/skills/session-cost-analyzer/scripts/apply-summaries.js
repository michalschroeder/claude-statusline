#!/usr/bin/env node
'use strict';
// Pure merge helper for the optional TOP TURNS Haiku summaries. Reads an analyze.js
// DETAIL payload on stdin and a summaries map, and writes the payload back with
// turns[].summary filled in, so render-report.js shows a "what this turn did" one-liner
// instead of the raw prompt. No network, no model call — the summaries are produced
// upstream by the skill agent dispatching cheap Haiku subagents (see SKILL.md), keeping
// this stage deterministic and testable.
//
// Pipeline:
//   node scripts/analyze.js <prefix> > detail.json
//   # agent dispatches Haiku subagents over detail.json's top turns → summaries.json
//   #   summaries.json = { "<turnIndex>": "short phrase", ... }  (or [{turnIndex,summary}])
//   node scripts/apply-summaries.js --summaries summaries.json < detail.json \
//     | node scripts/render-report.js --out ./session-cost-<id>.html
//
// Summaries are keyed by each turn's `turnIndex` (stable, unlike prompt text). Unknown
// keys are ignored; missing turns just keep their deterministic label. Bad/absent map →
// the payload passes through unchanged, so the report always renders.
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

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const raw = await readStdin();
  let payload;
  try { payload = JSON.parse(raw); } catch { process.stdout.write(raw); return; } // passthrough non-JSON

  let summaries = new Map();
  if (opts.summaries !== undefined) {
    try { summaries = toMap(JSON.parse(fs.readFileSync(opts.summaries, 'utf8'))); }
    catch (e) { process.stderr.write(`apply-summaries.js: could not read summaries (${e.message}) — passing through\n`); }
  }

  let applied = 0;
  if (summaries.size && Array.isArray(payload.turns)) {
    for (const t of payload.turns) {
      if (t && summaries.has(t.turnIndex)) { t.summary = summaries.get(t.turnIndex); applied++; }
    }
  }
  process.stderr.write(`apply-summaries: applied ${applied} turn summaries\n`);
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
}

main();
