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

module.exports = { readTitleRecap };
