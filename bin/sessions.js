#!/usr/bin/env node
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const { readTitleRecap, projectDirs, listSessions } = require('../lib/transcript');
const { dim, cyan, colorByTier, SESSION_TIERS, BUDGET_TIERS } = require('../lib/color');
const { loadPricing } = require('../lib/pricing');
const { aggregate } = require('../lib/cost-aggregate');
const { buildDetail } = require('../lib/session-detail');
const { sumPeriods } = require('../lib/periods');
const { resolveBudget } = require('../lib/budget');
const { resolveStateDir } = require('../lib/state');

function parseArgs(argv) {
  const opts = { last: null, since: null, configDir: undefined, detail: undefined };
  const needValue = (flag, i) => {
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
      process.stderr.write(`bin/sessions.js: ${flag} requires a value\n`);
      process.exit(1);
    }
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--last') {
      opts.last = parseInt(needValue('--last', i), 10); i++;
      if (isNaN(opts.last) || opts.last < 0) {
        process.stderr.write('bin/sessions.js: --last requires a non-negative integer\n');
        process.exit(1);
      }
    }
    else if (a === '--since') { opts.since = needValue('--since', i); i++; }
    else if (a === '--config-dir') { opts.configDir = needValue('--config-dir', i); i++; }
    else if (a.startsWith('--')) { /* unknown flag: ignored, as before */ }
    else if (opts.detail === undefined) { opts.detail = a; } // first bare token = session prefix
    else {
      process.stderr.write(`bin/sessions.js: unexpected argument '${a}'\n`);
      process.exit(1);
    }
  }
  return opts;
}

// '2026-06-01' → local-midnight unix seconds, or null if unparseable.
function sinceToTs(s) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return Math.floor(new Date(+m[1], +m[2] - 1, +m[3]).getTime() / 1000);
}

function truncate(s, width) {
  if (width <= 0) return '';
  if (s.length <= width) return s;
  return s.slice(0, Math.max(0, width - 1)) + '…';
}

const money = (c) => '$' + c.toFixed(2);

// '2h ago' style age. nowSec/ts both unix seconds; future clamps to 'just now'.
function relativeTime(nowSec, ts) {
  const d = Math.max(0, nowSec - ts);
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = (n) => String(n).padStart(2, '0');

// Local calendar-day key for grouping rows.
function dayKey(ts) {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// 'Mon Jun 09' for a day header.
function dayLabel(ts) {
  const d = new Date(ts * 1000);
  return `${DOW[d.getDay()]} ${MON[d.getMonth()]} ${pad2(d.getDate())}`;
}

// Local HH:MM.
function clock(ts) {
  const d = new Date(ts * 1000);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// Filled-cell count for a budget bar of `width` cells (clamped).
function barFill(spent, limit, width) {
  if (!(limit > 0)) return 0;
  return Math.max(0, Math.min(width, Math.round((spent / limit) * width)));
}

// Terminal width: real TTY wins, else COLUMNS env (piped output / tests), else 80.
function termWidth() {
  return process.stdout.columns || parseInt(process.env.COLUMNS, 10) || 80;
}


// Render the per-session detail view (see lib/session-detail.buildDetail).
function renderDetail(detail, sessionId, when, title, recap, width) {
  const out = [];
  out.push(`SESSION ${sessionId}`);
  out.push(title || '—');
  if (recap) out.push(dim('└ ' + truncate(recap, Math.max(0, width - 2))));
  out.push(dim(`${dayLabel(when)} ${clock(when)} · ${detail.calls} steps · ${money(detail.total)} total`));

  const t = detail.total || 1; // avoid divide-by-zero on an unbilled session
  const comp = [
    ['cache-read', detail.components.cacheRead],
    ['input', detail.components.input],
    ['output', detail.components.output],
    ['cache-write', detail.components.cacheWrite],
    ['web search', detail.components.web],
  ].filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]);
  if (comp.length) {
    out.push('');
    out.push(dim('WHERE IT WENT'));
    const lw = Math.max(...comp.map(([l]) => l.length));
    const BAR = 10;
    for (const [label, c] of comp) {
      const frac = c / t;
      const fill = Math.max(0, Math.min(BAR, Math.round(frac * BAR)));
      const bar = '▓'.repeat(fill) + dim('░'.repeat(BAR - fill));
      out.push(`  ${label.padEnd(lw)}  ${bar}  ${dim(String(Math.round(frac * 100)).padStart(3) + '%')}  ${money(c)}`);
    }
  }

  if (detail.byModel.length) {
    out.push('');
    out.push(dim('BY MODEL'));
    const mw = Math.max(...detail.byModel.map((m) => m.model.length));
    for (const m of detail.byModel) {
      out.push(`  ${m.model.padEnd(mw)}  ${money(m.cost)}  ${dim(m.calls + ' step' + (m.calls === 1 ? '' : 's'))}`);
    }
  }

  if (detail.topPrompts.length) {
    out.push('');
    out.push(dim('TOP PROMPTS') + dim('  · ranked by cost; steps = model responses, incl. each tool-use round'));
    const top = detail.topPrompts.slice(0, 10);
    const cw = Math.max(...top.map((p) => money(p.cost).length));
    for (const p of top) {
      const meta = `${money(p.cost).padStart(cw)}  ${String(p.calls).padStart(2)} step${p.calls === 1 ? ' ' : 's'}  `;
      out.push('  ' + meta + truncate(p.text, Math.max(0, width - 2 - meta.length)));
    }
    if (detail.subagentCount > 0) {
      out.push(dim(`  + ${money(detail.subagentTotal)} across ${detail.subagentCount} subagent${detail.subagentCount === 1 ? '' : 's'}`));
    }
  }

  if (detail.subagentCount > 0) {
    out.push('');
    out.push(dim('BY AGENT'));
    const aw = Math.max(...detail.byAgent.map((a) => a.name.length));
    for (const a of detail.byAgent) out.push(`  ${a.name.padEnd(aw)}  ${money(a.cost)}`);
  }

  return out.join('\n') + '\n';
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const sinceTs = sinceToTs(opts.since); // null when --since absent or unparseable
  if (opts.since && sinceTs === null) {
    process.stderr.write('bin/sessions.js: --since requires a YYYY-MM-DD date\n');
    process.exit(1);
  }
  const source = opts.configDir !== undefined ? opts.configDir : process.env.CLAUDE_CONFIG_DIR;
  const transcriptRoot = source || path.join(os.homedir(), '.claude'); // default only for projects/

  // Sessions come from the transcripts themselves (newest first by file mtime);
  // list projects/ once and reuse it for both enumeration and title/recap lookup.
  const dirs = projectDirs(transcriptRoot);
  let rows = listSessions(transcriptRoot, dirs);

  // Recompute spend from raw tokens × LiteLLM prices (never trust Claude's cost).
  // Full history (no mtime cap) — the viewer can afford the parse.
  const stateDir = resolveStateDir(source);
  // Offline like the renderer: a "list sessions" command shouldn't trigger a
  // network fetch or write pricing.json. The background refresh hook keeps prices
  // fresh; the viewer uses the cached/bundled snapshot.
  const pricing = loadPricing(stateDir, { allowFetch: false });
  const agg = aggregate(transcriptRoot, pricing);
  const costOf = (id) => { const ps = agg.perSession[id]; return ps ? ps.total : 0; };

  if (opts.detail !== undefined) {
    const matches = rows.filter((r) => r.id.startsWith(opts.detail));
    if (matches.length === 0) {
      process.stderr.write(`bin/sessions.js: no session matching '${opts.detail}'\n`);
      process.exit(1);
    }
    if (matches.length > 1) {
      process.stderr.write(`bin/sessions.js: '${opts.detail}' is ambiguous:\n` +
        matches.map((m) => '  ' + m.id).join('\n') + '\n');
      process.exit(1);
    }
    const row = matches[0];
    const subDir = path.join(path.dirname(row.file), row.id, 'subagents');
    let subFiles = [];
    try {
      subFiles = fs.readdirSync(subDir)
        .filter((n) => n.startsWith('agent-') && n.endsWith('.jsonl'))
        .map((n) => path.join(subDir, n));
    } catch {}
    const detail = buildDetail(row.file, subFiles, pricing);
    const { title, recap } = readTitleRecap(row.file);
    process.stdout.write(renderDetail(detail, row.id, row.ts, title, recap, termWidth()));
    return;
  }

  if (rows.length === 0) {
    process.stdout.write('no sessions found\n');
    return;
  }

  // Rows: filter --since, then cap --last (default 10; skipped when --since given
  // without --last). listSessions already returns newest-first.
  if (sinceTs != null) rows = rows.filter((r) => r.ts >= sinceTs);
  const cap = opts.last != null ? opts.last : (opts.since ? Infinity : 10);
  rows = rows.slice(0, cap);

  if (rows.length === 0) { // sessions exist, but --since/--last excluded them all
    process.stdout.write('no sessions match\n');
    return;
  }

  const width = termWidth();
  const nowSec = Math.floor(Date.now() / 1000);

  // Column geometry (plain-text widths; ANSI applied after).
  const CLOCK_W = 5, REL_W = 8, COST_W = 10, ID_W = 36, MIN_TITLE = 20; // COST_W fits '$99999.99' without column drift
  const ID_LABEL = 'id '; // precedes the session id so its purpose is obvious
  const INDENT = '  ', GAP = '  ';
  const leftWidth = INDENT.length + CLOCK_W + GAP.length + REL_W + GAP.length + COST_W + GAP.length;
  const idBlock = GAP.length + ID_LABEL.length + ID_W;
  const showId = width - leftWidth - idBlock >= MIN_TITLE;
  const titleWidth = showId ? width - leftWidth - idBlock : width - leftWidth;
  const recapIndent = ' '.repeat(leftWidth);

  const out = [];
  let curDay = null;
  for (const r of rows) {
    const { title, recap } = readTitleRecap(r.file);
    const key = dayKey(r.ts);
    if (key !== curDay) {
      curDay = key;
      const label = `── ${dayLabel(r.ts)} `;
      out.push(dim(label + '─'.repeat(Math.max(0, width - label.length))));
    } else {
      out.push(''); // blank line between sessions within a day
    }
    const clockCell = dim(clock(r.ts));
    const relCell = dim(relativeTime(nowSec, r.ts).padStart(REL_W));
    const cost = costOf(r.id);
    const plainCost = (cost > 0 ? '$' + cost.toFixed(2) : '—').padStart(COST_W);
    const costCell = cost > 0 ? colorByTier(cost, SESSION_TIERS)(plainCost) : dim(plainCost);
    const titleText = truncate(title || '—', titleWidth);
    let line = `${INDENT}${clockCell}${GAP}${relCell}${GAP}${costCell}${GAP}`;
    if (showId) line += titleText.padEnd(titleWidth) + GAP + dim(ID_LABEL) + cyan(r.id.padStart(ID_W));
    else line += titleText;
    out.push(line);
    if (recap) {
      const recapText = truncate(recap, Math.max(0, width - leftWidth - 2));
      out.push(`${recapIndent}${dim('└ ' + recapText)}`);
    }
  }

  // Footer: budget bars when a budget is set, else a plain d/w/m line.
  const { budgetOptedOut, monthly: mBudget, daily: dLimit, weekly: wLimit } =
    resolveBudget(process.env.STATUSLINE_MONTHLY_BUDGET);
  const per = sumPeriods(agg.perSession, new Date());
  out.push('');
  if (budgetOptedOut) {
    out.push(
      dim('today ') + money(per.daily) + dim(' · week ') + money(per.weekly) +
      dim(' · month ') + money(per.monthly)
    );
  } else {
    const BAR_W = 8;
    const periods = [
      ['today', per.daily, dLimit],
      ['week', per.weekly, wLimit],
      ['month', per.monthly, mBudget],
    ];
    const amtW = Math.max(...periods.map(([, s]) => money(s).length));
    for (const [label, spent, limit] of periods) {
      const ratio = limit > 0 ? spent / limit : 0;
      const fill = barFill(spent, limit, BAR_W);
      const bar = colorByTier(ratio, BUDGET_TIERS)('▓'.repeat(fill)) + dim('░'.repeat(BAR_W - fill));
      out.push(`${dim(label.padEnd(5))}  ${bar}  ${money(spent).padStart(amtW)}${dim(' / ' + money(limit))}`);
    }
  }

  process.stdout.write(out.join('\n') + '\n');
}

if (require.main === module) main();

module.exports = { relativeTime, dayKey, dayLabel, clock, barFill, truncate };
