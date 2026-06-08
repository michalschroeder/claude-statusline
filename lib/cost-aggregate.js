'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { projectDirs } = require('./transcript');
const { getModelCosts } = require('./pricing');
const { calculateCost } = require('./cost-compute');

// Local calendar YYYY-MM-DD from an ISO timestamp, or null if unparseable.
function dayKey(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Parse one transcript into a per-file call list: [{ id, dayKey, cost }].
// within-file dedup: keep the LAST occurrence per message.id (final usage),
// carrying the FIRST occurrence's timestamp. id-less calls get id:null (always
// kept; never globally deduped).
function parseFileCalls(file, pricing) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const byKey = new Map();   // internalKey -> { id, ts, usage, model }
  const order = [];          // first-seen internal keys
  let synth = 0;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!o || o.type !== 'assistant' || !o.message) continue;
    const m = o.message;
    if (!m.usage || !m.model) continue;
    const realId = typeof m.id === 'string' && m.id ? m.id : null;
    const key = realId || `__synth__${synth++}`;
    if (!byKey.has(key)) order.push(key);
    const prev = byKey.get(key);
    byKey.set(key, { id: realId, ts: prev ? prev.ts : o.timestamp, usage: m.usage, model: m.model });
  }
  const calls = [];
  for (const key of order) {
    const { id, ts, usage, model } = byKey.get(key);
    const dk = dayKey(ts);
    if (!dk) continue;
    const cost = calculateCost(usage, getModelCosts(pricing.map, model));
    calls.push({ id, dayKey: dk, cost });
  }
  return calls;
}

// Aggregate all transcripts under configDir's projects/* (main session files
// AND nested <session>/subagents/agent-*.jsonl, attributed to the parent). Returns
// { perSession: {id:{days,total}}, byDay: {key:cost}, files: {path:{...,calls}}, pricingHash }.
// Incremental: a file whose mtime+size match the prior cache (and pricingHash
// matches) reuses its cached `calls`. Global dedup (first occurrence wins) runs
// files mtime-ascending and is rebuilt fresh each call from the per-file lists.
// NOTE on sinceMtimeMs: it excludes files older than the bound for performance.
// A file's calls are always dated ≤ its mtime, so excluded files only hold
// out-of-window calls. Per-day buckets WITHIN the window are therefore correct,
// but per-session TOTALS are only complete in a full run (no sinceMtimeMs). The
// renderer uses only windowed day-sums; the viewer runs full history.
function aggregate(configDir, pricing, opts = {}) {
  const { sinceMtimeMs = 0, cache = null } = opts;
  const root = configDir || path.join(os.homedir(), '.claude');
  const prevFiles = (cache && cache.pricingHash === pricing.pricingHash && cache.files) || {};

  const candidates = [];
  const addCandidate = (file, sessionId) => {
    if (!sessionId) return;
    let st; try { st = fs.statSync(file); } catch { return; }
    if (st.mtimeMs < sinceMtimeMs) return;
    candidates.push({ file, sessionId, mtime: st.mtimeMs, size: st.size });
  };
  for (const d of projectDirs(root)) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        addCandidate(path.join(d, e.name), e.name.slice(0, -'.jsonl'.length));
      } else if (e.isDirectory()) {
        // Subagent transcripts live under <sessionId>/subagents/agent-*.jsonl.
        // Anthropic bills their token usage, so include them, attributed to the
        // parent session (the dir name) — keeps per-session totals complete.
        const subDir = path.join(d, e.name, 'subagents');
        let subEntries;
        try { subEntries = fs.readdirSync(subDir, { withFileTypes: true }); } catch { continue; }
        for (const se of subEntries) {
          // Only agent-*.jsonl are billable subagent transcripts; ignore any
          // other sidecar files CC may place under subagents/ (e.g. *.meta.json).
          if (se.isFile() && se.name.startsWith('agent-') && se.name.endsWith('.jsonl')) {
            addCandidate(path.join(subDir, se.name), e.name);
          }
        }
      }
    }
  }
  candidates.sort((a, b) => a.mtime - b.mtime); // oldest first → first-occurrence wins

  const files = {};
  const perSession = {};
  const byDay = {};
  const seen = new Set();
  for (const c of candidates) {
    const prev = prevFiles[c.file];
    const calls = (prev && prev.mtime === c.mtime && prev.size === c.size)
      ? prev.calls
      : parseFileCalls(c.file, pricing);
    files[c.file] = { mtime: c.mtime, size: c.size, sessionId: c.sessionId, calls };
    const ps = perSession[c.sessionId] || (perSession[c.sessionId] = { days: {}, total: 0 });
    for (const call of calls) {
      if (call.id) { if (seen.has(call.id)) continue; seen.add(call.id); }
      ps.days[call.dayKey] = (ps.days[call.dayKey] || 0) + call.cost;
      ps.total += call.cost;
      byDay[call.dayKey] = (byDay[call.dayKey] || 0) + call.cost;
    }
  }
  return { perSession, byDay, files, pricingHash: pricing.pricingHash };
}

// Read <stateDir>/cost-cache.json → parsed object or null. The full cache carries
// the bulky per-file `calls` blob (the incremental-rebuild scratch state); use
// readSummary on the render hot path instead.
function readCache(stateDir) {
  try { return JSON.parse(fs.readFileSync(path.join(stateDir, 'cost-cache.json'), 'utf8')); }
  catch { return null; }
}

// Slim renderer-facing summary: {pricingHash, perSession} only — no `files` blob,
// so the hot path parses kilobytes, not megabytes. Falls back to the full cache
// for back-compat (older caches / before the first refresh writes the summary).
function readSummary(stateDir) {
  try { return JSON.parse(fs.readFileSync(path.join(stateDir, 'cost-summary.json'), 'utf8')); }
  catch {}
  return readCache(stateDir);
}

function writeJsonAtomic(file, obj) {
  const tmp = `${file}.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

// Atomically write the full incremental cache ({pricingHash, files, perSession})
// plus the slim renderer summary ({pricingHash, perSession}).
function writeCache(stateDir, result) {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    writeJsonAtomic(path.join(stateDir, 'cost-cache.json'),
      { pricingHash: result.pricingHash, files: result.files, perSession: result.perSession });
    writeJsonAtomic(path.join(stateDir, 'cost-summary.json'),
      { pricingHash: result.pricingHash, perSession: result.perSession });
  } catch {}
}

module.exports = { dayKey, parseFileCalls, aggregate, readCache, readSummary, writeCache };
