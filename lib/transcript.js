'use strict';
const fs = require('fs');
const path = require('path');

const DISCLAIMER = / *\(disable recaps in \/config\)$/;

// Parse a transcript .jsonl in-process (no jq). Returns the LAST ai-title and the
// LAST away_summary (the /recap output), each string or null. Unparseable lines
// are skipped. Trailing " (disable recaps in /config)" is stripped from the recap.
function readTitleRecap(filePath) {
  let title = null, recap = null;
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { title, recap };
  }
  // Scan from the END (the wanted entries are usually the most recent) and stop
  // once both are found — avoids JSON.parsing the whole, ever-growing transcript.
  // Collapse whitespace so a multi-line recap can't break the viewer's single-line row.
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0 && (title === null || recap === null); i--) {
    const line = lines[i];
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (title === null && o && o.type === 'ai-title' && typeof o.aiTitle === 'string') {
      title = o.aiTitle.replace(/\s+/g, ' ').trim();
    } else if (recap === null && o && o.type === 'system' && o.subtype === 'away_summary' && typeof o.content === 'string') {
      recap = o.content.replace(DISCLAIMER, '').replace(/\s+/g, ' ').trim();
    }
  }
  return { title, recap };
}

// List the immediate project subdirs under <root>/projects/ (absolute paths).
// Empty when projects/ is absent. Callers resolving many sessions list once and
// pass the result into findTranscript, rather than re-reading the dir per lookup.
function projectDirs(root) {
  try {
    return fs.readdirSync(path.join(root, 'projects'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(root, 'projects', e.name));
  } catch {
    return [];
  }
}

// Locate a session's transcript: <root>/projects/<enc-cwd>/<sessionId>.jsonl.
// Probes each project subdir directly (the real CC layout). Subagent transcripts
// live under .../<sessionId>/subagents/ — a nested path that never matches
// projects/<enc>/<id>.jsonl, so they're excluded by construction. Returns null
// when projects/ is absent or no match exists. `dirs` (from projectDirs) may be
// passed to avoid re-listing projects/ across many lookups.
function findTranscript(root, sessionId, dirs) {
  const target = `${sessionId}.jsonl`;
  for (const d of dirs || projectDirs(root)) {
    const candidate = path.join(d, target);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

// Enumerate every session transcript under <root>/projects/*/<id>.jsonl, newest
// first. Returns [{ id, ts, file }] with ts = file mtime (unix seconds) — the
// closest available "when" now that the cost ledger (which carried end timestamps)
// is gone — and file = the transcript path (so callers needn't re-locate it via
// findTranscript). Subagent transcripts live under <id>/subagents/ (nested), so
// listing only the immediate *.jsonl of each project dir excludes them by
// construction. `dirs` (from projectDirs) may be passed to avoid re-listing projects/.
function listSessions(root, dirs) {
  const out = [];
  for (const d of dirs || projectDirs(root)) {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const file = path.join(d, e.name);
      try {
        const ts = Math.floor(fs.statSync(file).mtimeMs / 1000);
        out.push({ id: e.name.slice(0, -'.jsonl'.length), ts, file });
      } catch {}
    }
  }
  out.sort((a, b) => b.ts - a.ts);
  return out;
}

module.exports = { readTitleRecap, findTranscript, projectDirs, listSessions };
