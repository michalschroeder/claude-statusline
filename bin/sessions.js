#!/usr/bin/env node
'use strict';
const path = require('path');
const os = require('os');
const { readTitleRecap, projectDirs, listSessions } = require('../lib/transcript');
const { dim } = require('../lib/color');

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

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.since && sinceToTs(opts.since) === null) {
    process.stderr.write('bin/sessions.js: --since requires a YYYY-MM-DD date\n');
    process.exit(1);
  }
  const source = opts.configDir !== undefined ? opts.configDir : process.env.CLAUDE_CONFIG_DIR;
  const transcriptRoot = source || path.join(os.homedir(), '.claude'); // default only for projects/

  // Sessions come from the transcripts themselves (newest first by file mtime);
  // list projects/ once and reuse it for both enumeration and title/recap lookup.
  const dirs = projectDirs(transcriptRoot);
  let rows = listSessions(transcriptRoot, dirs);

  if (rows.length === 0) {
    process.stdout.write('no sessions found\n');
    return;
  }

  // Rows: filter --since, then cap --last (default 10; skipped when --since given
  // without --last). listSessions already returns newest-first.
  const sinceTs = sinceToTs(opts.since);
  if (sinceTs != null) rows = rows.filter((r) => r.ts >= sinceTs);
  const cap = opts.last != null ? opts.last : (opts.since ? Infinity : 10);
  rows = rows.slice(0, cap);

  const termWidth = process.stdout.columns || 80;

  // Resolve title/recap up front so column widths can be sized from the data.
  // listSessions already gave us each transcript path — readTitleRecap returns
  // nulls if the file is unreadable, so no existence guard is needed.
  const view = rows.map((r) => {
    const { title, recap } = readTitleRecap(r.file);
    return { ...r, shortId: r.id.slice(0, ID_W), title, recap };
  });

  // The title column starts after when + the short id.
  const titleCol = WHEN_W + GAP.length + ID_W + GAP.length;
  const titleWidth = Math.max(0, termWidth - titleCol);

  const out = [];
  out.push(dim(`${'WHEN'.padEnd(WHEN_W)}${GAP}${'SESSION'.padEnd(ID_W)}${GAP}TITLE / RECAP`));

  for (const v of view) {
    const when = dim(fmtWhen(v.ts));
    const sid = dim(v.shortId.padEnd(ID_W));
    const titleText = truncate(v.title || '—', titleWidth); // plain (default color)
    out.push(`${when}${GAP}${sid}${GAP}${titleText}`);
    if (v.recap) {
      const recapText = truncate(v.recap, Math.max(0, termWidth - titleCol - 2));
      out.push(`${' '.repeat(titleCol)}${dim('└ ' + recapText)}`);
    }
  }

  process.stdout.write(out.join('\n') + '\n');
}

main();
