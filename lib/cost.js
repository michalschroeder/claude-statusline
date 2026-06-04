'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

// State dir resolution (MUST match hooks/statusline.js and the bash hooks). Data
// lives in our own XDG namespace; CLAUDE_CONFIG_DIR is only a per-profile KEY —
// its sanitized path becomes a profile subdir. Falsy source → empty profile →
// flat layout (single-profile users), unchanged.
function resolveStateDir(configDir) {
  const xdgRoot = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  const profile = configDir ? configDir.replace(/^\//, '').replace(/\//g, '_') : '';
  return path.join(xdgRoot, 'claude-statusline', profile);
}

// Read cost.log → Map<id, {ts, cost}>, deduped keeping the LARGEST cumulative
// cost per session (total_cost_usd is cumulative; a resume logs a second larger
// line). Skips rows with <4 fields, NaN ts/cost, cost<=0, or empty id.
function readCostRows(stateDir) {
  const byId = new Map();
  try {
    const lines = fs.readFileSync(path.join(stateDir, 'cost.log'), 'utf8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      const parts = line.split(' ');
      if (parts.length < 4) continue;
      const ts = parseInt(parts[1], 10);
      const id = parts[2];
      const c = parseFloat(parts[3]);
      if (isNaN(ts) || isNaN(c) || c <= 0 || !id) continue;
      const prev = byId.get(id);
      if (!prev || c > prev.cost) byId.set(id, { ts, cost: c });
    }
  } catch {}
  return byId;
}

// Read every cost/<id> temp (plain float) for still-running sessions → Map<id, cost>.
// Skips NaN / non-positive. (The renderer only reads its own session's temp.)
function readLiveCosts(stateDir) {
  const live = new Map();
  try {
    const dir = path.join(stateDir, 'cost');
    for (const id of fs.readdirSync(dir)) {
      try {
        const c = parseFloat(fs.readFileSync(path.join(dir, id), 'utf8'));
        if (!isNaN(c) && c > 0) live.set(id, c);
      } catch {}
    }
  } catch {}
  return live;
}

module.exports = { resolveStateDir, readCostRows, readLiveCosts };
