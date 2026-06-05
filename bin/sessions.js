#!/usr/bin/env node
'use strict';
const path = require('path');
const os = require('os');
const { resolveStateDir, readCostRows, readLiveCosts, bucketPeriods, resolveBudget } = require('../lib/cost');
const { findTranscript, readTitleRecap, projectDirs } = require('../lib/transcript');
const { dim, bold, green, colorByTier, SESSION_TIERS, BUDGET_TIERS } = require('../lib/color');

function parseArgs(argv) {
  const opts = { last: null, since: null, configDir: undefined };
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

function fmtWhen(ts) {
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function truncate(s, width) {
  if (s.length <= width) return s;
  return s.slice(0, Math.max(0, width - 1)) + '…';
}

// Table layout widths — header, data row, and the title-column offset are all
// built from these so spacing stays in sync.
const WHEN_W = 11;   // fmtWhen output: 'MM-DD HH:MM'
const ID_W = 8;      // shortId slice length
const GAP = '  ';    // 2-space column separator
const MARKER_W = 3;  // ' ● ' live-marker region between cost and id

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.since && sinceToTs(opts.since) === null) {
    process.stderr.write('bin/sessions.js: --since requires a YYYY-MM-DD date\n');
    process.exit(1);
  }
  const source = opts.configDir !== undefined ? opts.configDir : process.env.CLAUDE_CONFIG_DIR;
  const stateDir = resolveStateDir(source);                       // unset → flat (matches renderer)
  const transcriptRoot = source || path.join(os.homedir(), '.claude'); // default only for projects/

  const logged = readCostRows(stateDir);          // Map<id, {ts, cost}>
  const live = readLiveCosts(stateDir);           // Map<id, cost>
  const now = new Date();
  const nowTs = Math.floor(now.getTime() / 1000);

  // Merge: a live temp marks the session ● and buckets at now, but keep the LARGER
  // of logged/live cost (mirrors readCostRows' keep-max — a resumed session whose
  // counter reset, or a stale temp, must not shrink an already-logged cumulative).
  const merged = new Map();
  for (const [id, r] of logged) merged.set(id, { ts: r.ts, cost: r.cost, live: false });
  for (const [id, cost] of live) {
    const prev = merged.get(id);
    merged.set(id, { ts: nowTs, cost: prev ? Math.max(prev.cost, cost) : cost, live: true });
  }

  if (merged.size === 0) {
    process.stdout.write('no sessions recorded yet\n');
    return;
  }

  // Period totals over ALL merged rows (incl. live), before row filtering.
  const mergedRows = [...merged.values()];
  const totals = bucketPeriods(mergedRows, now);
  const anyLive = mergedRows.some((r) => r.live);

  // Rows: filter --since, sort desc by ts, cap --last (default 10; skipped when
  // --since given without --last).
  let rows = [...merged.entries()].map(([id, r]) => ({ id, ...r }));
  const sinceTs = sinceToTs(opts.since);
  if (sinceTs != null) rows = rows.filter((r) => r.ts >= sinceTs);
  rows.sort((a, b) => b.ts - a.ts);
  const cap = opts.last != null ? opts.last : (opts.since ? Infinity : 10);
  rows = rows.slice(0, cap);

  const termWidth = process.stdout.columns || 80;

  // Resolve title/recap up front so column widths can be sized from the data.
  // List projects/ once and reuse it across every lookup (vs re-reading per row).
  const dirs = projectDirs(transcriptRoot);
  const view = rows.map((r) => {
    const tr = findTranscript(transcriptRoot, r.id, dirs);
    const { title, recap } = tr ? readTitleRecap(tr) : { title: null, recap: null };
    return { ...r, costStr: '$' + r.cost.toFixed(2), shortId: r.id.slice(0, ID_W), title, recap };
  });

  // Cost field width = widest rendered cost (min 5 = "$0.00"), right-aligned. The
  // title column starts after when + cost + the live marker + the short id.
  const costW = Math.max(5, ...view.map((v) => v.costStr.length));
  const titleCol = WHEN_W + GAP.length + costW + MARKER_W + ID_W + GAP.length;
  const titleWidth = Math.max(0, termWidth - titleCol);

  const out = [];
  out.push(dim(`${'WHEN'.padEnd(WHEN_W)}${GAP}${'COST'.padStart(costW)}${' '.repeat(MARKER_W)}${'SESSION'.padEnd(ID_W)}${GAP}TITLE / RECAP`));

  for (const v of view) {
    const when = dim(fmtWhen(v.ts));
    const cost = colorByTier(v.cost, SESSION_TIERS)(v.costStr.padStart(costW));
    const marker = v.live ? green('●') : ' ';
    const sid = dim(v.shortId.padEnd(ID_W));
    const titleText = truncate(v.title || '—', titleWidth); // plain (default color)
    out.push(`${when}${GAP}${cost} ${marker} ${sid}${GAP}${titleText}`);
    if (v.recap) {
      const recapText = truncate(v.recap, Math.max(0, termWidth - titleCol - 2));
      out.push(`${' '.repeat(titleCol)}${dim('└ ' + recapText)}`);
    }
  }

  // Dim rule separating the session list from the totals footer (matches the
  // statusline's own ─ rules). Spans the terminal width.
  out.push(dim('─'.repeat(termWidth)));

  // Footer: budget-tiered amounts when STATUSLINE_MONTHLY_BUDGET > 0, else bold.
  // Same budget contract as the renderer (resolveBudget): explicit 0 opts out of
  // tier coloring (bold); unset/negative/NaN colors against the 500 default.
  const { budgetOptedOut, monthly, daily, weekly } = resolveBudget(process.env.STATUSLINE_MONTHLY_BUDGET);
  const amt = (total, limit) => {
    const s = '$' + total.toFixed(2);
    return budgetOptedOut ? bold(s) : colorByTier(total / limit, BUDGET_TIERS)(s);
  };
  const liveNote = anyLive ? dim('  (incl. live)') : '';
  out.push(
    `${dim('TODAY')} ${amt(totals.daily, daily)}   ` +
    `${dim('WEEK')} ${amt(totals.weekly, weekly)}   ` +
    `${dim('MONTH')} ${amt(totals.monthly, monthly)}${liveNote}`
  );
  process.stdout.write(out.join('\n') + '\n');
}

main();
