#!/usr/bin/env node
'use strict';
const path = require('path');
const os = require('os');
const { resolveStateDir, readCostRows, readLiveCosts, bucketPeriods } = require('../lib/cost');
const { findTranscript, readTitleRecap } = require('../lib/transcript');

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
      if (isNaN(opts.last)) {
        process.stderr.write('bin/sessions.js: --last requires an integer\n');
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

  // Merge: live cost supersedes logged for the same id; live rows bucket at now.
  const merged = new Map();
  for (const [id, r] of logged) merged.set(id, { ts: r.ts, cost: r.cost, live: false });
  for (const [id, cost] of live) merged.set(id, { ts: nowTs, cost, live: true });

  if (merged.size === 0) {
    process.stdout.write('no sessions recorded yet\n');
    return;
  }

  // Period totals over ALL merged rows (incl. live), before row filtering.
  const totals = bucketPeriods([...merged.values()], now);
  const anyLive = [...merged.values()].some((r) => r.live);

  // Rows: filter --since, sort desc by ts, cap --last (default 10; skipped when
  // --since given without --last).
  let rows = [...merged.entries()].map(([id, r]) => ({ id, ...r }));
  const sinceTs = sinceToTs(opts.since);
  if (sinceTs != null) rows = rows.filter((r) => r.ts >= sinceTs);
  rows.sort((a, b) => b.ts - a.ts);
  const cap = opts.last != null && !isNaN(opts.last)
    ? opts.last
    : (opts.since ? Infinity : 10);
  rows = rows.slice(0, cap);

  const width = process.stdout.columns || 80;
  const out = [];
  out.push('WHEN         COST     SESSION   TITLE / RECAP');
  for (const r of rows) {
    const tr = findTranscript(transcriptRoot, r.id);
    const { title, recap } = tr ? readTitleRecap(tr) : { title: null, recap: null };
    const when = fmtWhen(r.ts);
    const cost = `$${r.cost.toFixed(2)}${r.live ? ' ●' : '  '}`;
    const shortId = r.id.slice(0, 8);
    const titleText = title || '—';
    out.push(truncate(`${when}  ${cost.padEnd(8)} ${shortId.padEnd(8)}  ${titleText}`, width));
    if (recap) out.push(truncate(`${' '.repeat(32)}└ ${recap}`, width));
  }
  const liveNote = anyLive ? '  (incl. live)' : '';
  out.push(
    `TODAY: $${totals.daily.toFixed(2)}   WEEK: $${totals.weekly.toFixed(2)}   MONTH: $${totals.monthly.toFixed(2)}${liveNote}`
  );
  process.stdout.write(out.join('\n') + '\n');
}

main();
