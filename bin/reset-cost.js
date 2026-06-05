#!/usr/bin/env node
'use strict';
// Reset the period cost ledger to a known month-to-date total.
//
// Wipes cost.log (backing it up to cost.log.bak first) and writes a single
// synthetic line dated at the 1st of the month, so the monthly `m` chip shows
// the amount you provide while `d`/`w` restart from ~0 and accumulate going
// forward. Useful to seed the tracker with spend that predates it.
//
//   node bin/reset-cost.js <amount> [--config-dir <path>] [--month YYYY-MM]
//
// <amount>   month-to-date USD (e.g. 142.50). 0 clears the ledger entirely.
// --config-dir  per-subscription profile source (default: $CLAUDE_CONFIG_DIR).
// --month       target month (default: current local month).
const fs = require('fs');
const path = require('path');
const { resolveStateDir, readCostRows, bucketPeriods } = require('../lib/cost');

function die(msg) { process.stderr.write(`bin/reset-cost.js: ${msg}\n`); process.exit(1); }

function parseArgs(argv) {
  const opts = { amount: undefined, configDir: undefined, month: undefined };
  const needValue = (flag, i) => {
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) die(`${flag} requires a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config-dir') { opts.configDir = needValue('--config-dir', i); i++; }
    else if (a === '--month') { opts.month = needValue('--month', i); i++; }
    else if (a === '-h' || a === '--help') { opts.help = true; }
    else if (a.startsWith('--')) die(`unknown flag ${a}`);
    else if (opts.amount === undefined) opts.amount = a;
    else die(`unexpected argument ${a}`);
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || opts.amount === undefined || opts.amount.trim() === '') {
    process.stdout.write('usage: node bin/reset-cost.js <amount> [--config-dir <path>] [--month YYYY-MM]\n');
    process.exit(opts.help ? 0 : 1);
  }
  const amount = Number(opts.amount);
  if (!Number.isFinite(amount) || amount < 0) die('<amount> must be a non-negative number');

  // Target month → first-of-month local date + unix ts.
  const now = new Date();
  let year = now.getFullYear(), month = now.getMonth(); // 0-based
  if (opts.month !== undefined) {
    const m = /^(\d{4})-(\d{2})$/.exec(opts.month);
    if (!m) die('--month must be YYYY-MM');
    year = +m[1]; month = +m[2] - 1;
    if (month < 0 || month > 11) die('--month month out of range');
  }
  const first = new Date(year, month, 1);
  const ts = Math.floor(first.getTime() / 1000);
  const ym = `${year}-${String(month + 1).padStart(2, '0')}`;
  const dateCol = `${ym}-01`;

  const source = opts.configDir !== undefined ? opts.configDir : process.env.CLAUDE_CONFIG_DIR;
  const stateDir = resolveStateDir(source);
  const logFile = path.join(stateDir, 'cost.log');

  // Back up any existing ledger.
  if (fs.existsSync(logFile)) {
    fs.copyFileSync(logFile, logFile + '.bak');
    process.stdout.write(`backed up ${logFile} -> cost.log.bak\n`);
  } else {
    fs.mkdirSync(stateDir, { recursive: true });
  }

  // amount 0 → clear; else one synthetic line counted only toward the month.
  const content = amount > 0 ? `${dateCol} ${ts} reset-${ym} ${amount}\n` : '';
  fs.writeFileSync(logFile, content);
  process.stdout.write(amount > 0 ? `wrote: ${content}` : 'cleared cost.log (amount 0)\n');

  // Echo the resulting monthly total for the TARGET month. Bucket against a date
  // inside it (`first`), not `now` — a past --month wouldn't count toward the
  // current month, so `now` would misleadingly report $0.00 here. Daily/weekly
  // intentionally restart from ~0 and accumulate going forward.
  const rows = [...readCostRows(stateDir).values()];
  const { monthly } = bucketPeriods(rows, first);
  process.stdout.write(`\n${ym} ledger: m $${monthly.toFixed(2)}  (d/w restart from $0; + your live session)\n`);
}

main();
