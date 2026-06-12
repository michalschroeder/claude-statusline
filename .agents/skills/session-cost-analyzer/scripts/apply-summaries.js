#!/usr/bin/env node
'use strict';
// Pure merge helper for the model-written summaries. Reads an analyze.js DETAIL payload
// on stdin and a summaries map, and writes the payload back with summary fields filled in,
// so render-report.js shows a "what this is" one-liner instead of the raw prompt/target.
// No network, no model call — the summaries are produced upstream by the skill agent
// dispatching subagents (see SKILL.md). Three report sections take model output:
//   • TOP TURNS               → keyed by each turn's `turnIndex` (stable, unlike prompt text)
//   • Top context consumers   → keyed by 0-based index into summary.contextConsumers.top
//   • Spending less next time  → an AI assessment of the whole session: a 1–5 `rating`, a
//                               `headline`, and `cards` ({verdict good/bad/warn, title, what,
//                               why, how}), stored at summary.aiAssessment for the renderer.
//
// Pipeline:
//   node scripts/analyze.js <prefix> > detail.json
//   # agent dispatches subagents over detail.json → summaries.json
//   node scripts/apply-summaries.js --summaries summaries.json < detail.json \
//     | node scripts/render-report.js --out ./session-cost-<id>.html
//
// summaries.json shapes (turn/consumer keys are integers, values short phrases):
//   namespaced : { "turns": { "<turnIndex>": "…" }, "consumers": { "<index>": "…" },
//                  "tips": { "rating": 3, "headline": "…",
//                            "cards": [ { "verdict": "bad", "title": "…", "what": "…",
//                                        "why": "…", "how": "…" }, … ] } }
//   flat        : { "<turnIndex>": "…" }  (or [{turnIndex,summary}])  → applied to turns only
//   (A legacy `tips` LIST of { head, body } / strings is still accepted → what-only cards.)
//
// Unknown keys are ignored; un-summarized rows keep their raw label, and an absent
// `tips` leaves the assessment section empty (no fallback grade). A bad/absent map → the
// payload passes through unchanged, so the report always renders.
const fs = require('fs');

// Whitespace-collapsed trimmed string; non-string → ''.
const clean = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

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
    const s = clean(v);
    if (Number.isFinite(idx) && s) m.set(idx, s);
  };
  if (Array.isArray(parsed)) for (const r of parsed) { if (r) put(r.turnIndex, r.summary); }
  else if (parsed && typeof parsed === 'object') for (const k of Object.keys(parsed)) put(k, parsed[k]);
  return m;
}

// One of good/bad/warn (default warn); maps common synonyms a model might emit.
function normVerdict(v) {
  const s = clean(v).toLowerCase();
  if (s === 'good' || s === 'positive' || s === 'win' || s === 'strength') return 'good';
  if (s === 'bad' || s === 'negative' || s === 'problem' || s === 'issue') return 'bad';
  return 'warn';
}

// Integer 1–5, else null.
function toRating(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 1 && n <= 5 ? n : null;
}

// Normalize the AI session assessment into { rating, headline, cards:[{verdict,title,what,why,how}] }.
// Accepts the rich object { rating, headline, cards:[…] } or a legacy list of { head, body }
// cards / bare strings (→ verdict-less what-only cards). Trims, drops empties, caps length/count
// so a runaway model response can't blow up the report. Returns null when nothing usable.
function toAssessment(parsed) {
  let rating = null, headline = '', rawCards = [];
  if (Array.isArray(parsed)) {
    rawCards = parsed;
  } else if (parsed && typeof parsed === 'object') {
    rating = toRating(parsed.rating);
    headline = clean(parsed.headline || parsed.summary || '').slice(0, 160);
    rawCards = Array.isArray(parsed.cards) ? parsed.cards : [];
  } else {
    return null;
  }
  const cards = [];
  for (const c of rawCards) {
    if (typeof c === 'string') {
      const what = clean(c).slice(0, 600);
      if (what) cards.push({ verdict: 'warn', title: '', what, why: '', how: '' });
    } else if (c && typeof c === 'object') {
      const verdict = normVerdict(c.verdict);
      const title = clean(c.title || c.head || '').replace(/[.\s]+$/, '').slice(0, 80);
      const what = clean(c.what || c.body || c.text || c.detail || '').slice(0, 600);
      const why = clean(c.why).slice(0, 600);
      const how = clean(c.how).slice(0, 600);
      if (title || what || why || how) cards.push({ verdict, title, what, why, how });
    }
  }
  return cards.length || rating != null ? { rating, headline, cards: cards.slice(0, 8) } : null;
}

// Split the file into per-section maps. Namespaced shape ({turns,consumers,tips}) routes each
// section; any other shape is the legacy flat map → turns only (back-compat).
function extractMaps(parsed) {
  const ns = parsed && !Array.isArray(parsed) && typeof parsed === 'object'
    && (parsed.turns !== undefined || parsed.consumers !== undefined || parsed.tips !== undefined);
  if (ns) return { turns: toMap(parsed.turns), consumers: toMap(parsed.consumers), assessment: toAssessment(parsed.tips) };
  return { turns: toMap(parsed), consumers: new Map(), assessment: null };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const raw = await readStdin();
  let payload;
  try { payload = JSON.parse(raw); } catch { process.stdout.write(raw); return; } // passthrough non-JSON

  let maps = { turns: new Map(), consumers: new Map(), assessment: null };
  if (opts.summaries !== undefined) {
    try { maps = extractMaps(JSON.parse(fs.readFileSync(opts.summaries, 'utf8'))); }
    catch (e) { process.stderr.write(`apply-summaries.js: could not read summaries (${e.message}) — passing through\n`); }
  }

  // Nothing to apply → byte-true passthrough, skip restringifying a multi-MB payload.
  if (maps.turns.size + maps.consumers.size + (maps.assessment ? 1 : 0) === 0) {
    process.stderr.write('apply-summaries: applied 0 turn + 0 consumer summaries + 0 assessment\n');
    process.stdout.write(raw);
    return;
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
  let appliedCards = 0;
  if (maps.assessment) {
    payload.summary = payload.summary || {};
    payload.summary.aiAssessment = maps.assessment;
    appliedCards = maps.assessment.cards.length;
  }
  process.stderr.write(`apply-summaries: applied ${applied} turn + ${appliedCc} consumer summaries + ${maps.assessment ? 1 : 0} assessment (${appliedCards} cards)\n`);
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
}

main();
