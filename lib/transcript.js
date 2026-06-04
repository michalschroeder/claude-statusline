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
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o && o.type === 'ai-title' && typeof o.aiTitle === 'string') {
      title = o.aiTitle;
    } else if (o && o.type === 'system' && o.subtype === 'away_summary' && typeof o.content === 'string') {
      recap = o.content.replace(DISCLAIMER, '');
    }
  }
  return { title, recap };
}

// Locate a session's transcript: <root>/projects/<enc-cwd>/<sessionId>.jsonl.
// Scans the immediate project subdirs (the real CC layout) and returns the first
// match. Subagent transcripts live under .../<sessionId>/subagents/ — a nested
// path that never matches projects/<enc>/<id>.jsonl, so they're excluded by
// construction. Returns null when projects/ is absent or no match exists.
function findTranscript(root, sessionId) {
  const projects = path.join(root, 'projects');
  const target = `${sessionId}.jsonl`;
  let entries;
  try {
    entries = fs.readdirSync(projects, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const candidate = path.join(projects, e.name, target);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

module.exports = { readTitleRecap, findTranscript };
