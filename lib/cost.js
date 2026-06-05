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
      const parts = line.trim().split(/\s+/);
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

// Sum {ts, cost} rows into local-calendar windows: daily = since today's midnight,
// weekly = since this week's Monday ((getDay()+6)%7 days back), monthly = since the
// 1st. `rows` is any iterable of {ts, cost}. `now` is a Date.
function bucketPeriods(rows, now) {
  const sec = (d) => Math.floor(d.getTime() / 1000);
  const dayStart = sec(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
  const daysSinceMonday = (now.getDay() + 6) % 7; // getDay(): 0=Sun..6=Sat → Mon=0
  const weekStart = sec(new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysSinceMonday));
  const monthStart = sec(new Date(now.getFullYear(), now.getMonth(), 1));
  let daily = 0, weekly = 0, monthly = 0;
  for (const { ts, cost } of rows) {
    if (ts >= dayStart) daily += cost;
    if (ts >= weekStart) weekly += cost;
    if (ts >= monthStart) monthly += cost;
  }
  return { daily, weekly, monthly };
}

// Parse STATUSLINE_MONTHLY_BUDGET into period budget limits — shared by the
// renderer and the viewer so the budget contract lives in one place. Strict
// Number parse (rejects trailing garbage so `0abc`/`$500` fall back rather than
// mis-parse); empty/whitespace is treated as unset. Explicit 0 → budgetOptedOut
// (the user opted out of budget tracking); negative/non-numeric → 500 fallback
// (guards color inversion). Each consumer decides what opt-out means for it: the
// renderer hides the d/w/m chips, the viewer still shows the totals but un-tiered.
// Limits derive proportionally: daily = monthly/30, weekly = monthly·7/30.
function resolveBudget(raw) {
  const parsed = raw != null && raw.trim() !== '' ? Number(raw) : NaN;
  const budgetOptedOut = parsed === 0;
  const monthly = parsed > 0 ? parsed : 500;
  return { budgetOptedOut, monthly, daily: monthly / 30, weekly: monthly * 7 / 30 };
}

module.exports = { resolveStateDir, readCostRows, readLiveCosts, bucketPeriods, resolveBudget };
