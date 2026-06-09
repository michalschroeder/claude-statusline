#!/usr/bin/env node
'use strict';
// JSON-only session cost analyzer. A trim of the repo's bin/sessions.js with all
// human rendering removed: emits the LIST payload (no prefix / `list`) or the
// full-fidelity DETAIL payload (with an id-prefix). Self-contained — vendored libs
// live in ./lib, the price snapshot in ../data. See SYNC.md for the canonical source.
const path = require('path');
const os = require('os');
const fs = require('fs');
const { readTitleRecap, projectDirs, listSessions } = require('./lib/transcript');
const { loadPricing } = require('./lib/pricing');
const { aggregate } = require('./lib/cost-aggregate');
const { buildDetail } = require('./lib/session-detail');
const { sumPeriods } = require('./lib/periods');
const { resolveBudget } = require('./lib/budget');
const { resolveStateDir } = require('./lib/state');

function parseArgs(argv) {
  const opts = { last: null, since: null, configDir: undefined, detail: undefined };
  const needValue = (flag, i) => {
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
      process.stderr.write(`analyze.js: ${flag} requires a value\n`);
      process.exit(1);
    }
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--last') {
      opts.last = parseInt(needValue('--last', i), 10); i++;
      if (isNaN(opts.last) || opts.last < 0) {
        process.stderr.write('analyze.js: --last requires a non-negative integer\n');
        process.exit(1);
      }
    }
    else if (a === '--since') { opts.since = needValue('--since', i); i++; }
    else if (a === '--config-dir') { opts.configDir = needValue('--config-dir', i); i++; }
    else if (a === 'list') { /* explicit list subcommand: leave opts.detail undefined */ }
    else if (a.startsWith('--')) { /* unknown flag: ignored */ }
    else if (opts.detail === undefined) { opts.detail = a; } // first bare token = session prefix
    else {
      process.stderr.write(`analyze.js: unexpected argument '${a}'\n`);
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

// Full-fidelity JSON for an LLM/agent to reason about *why* a session was costly.
function analysisPayload(detail, id, ts, title, recap) {
  return {
    session: id,
    title: title || null,
    recap: recap || null,
    startedAt: new Date(ts * 1000).toISOString(),
    totalCost: detail.total,
    steps: detail.calls,
    legend:
      'Cost ≈ context-size × steps, recomputed from raw tokens × LiteLLM prices (not Claude\'s reported cost). ' +
      'tokens.cacheRead = re-reading accumulated context and is the dominant driver; tokens.input (fresh) is usually negligible. ' +
      'turns and calls are in EXECUTION order. NOTE: a turn\'s tokens.cacheRead is a SUM across its steps, NOT the context size — use turn.avgContext / turn.peakContext and summary.contextGrowth (per-step cacheRead) for the real growth curve. ' +
      'A cacheWrite spike usually means the parent re-cached its whole context (e.g. on a subagent return). ' +
      'Use summary.byTurnKind for cost per kind of work, summary.toolTally for the canonical tool counts (do NOT re-aggregate calls[].tools — that over-counts), ' +
      'summary.highContextCost for the spend above 200k context (what a /compact would have cut), and summary.contextResets for how many times context was cleared.',
    components: detail.components,
    summary: detail.summary,
    byModel: detail.byModel,
    byAgent: detail.byAgent,
    subagents: { total: detail.subagentTotal, count: detail.subagentCount },
    turns: detail.turns,
    calls: detail.perCall,
  };
}

// Session list as JSON for an LLM/agent: one record per session, plus period totals.
function listPayload(rows, costOf, readTR, per, budget) {
  return {
    sessions: rows.map((r) => {
      const { title, recap } = readTR(r.file);
      return {
        session: r.id,
        title: title || null,
        recap: recap || null,
        startedAt: new Date(r.ts * 1000).toISOString(),
        cost: costOf(r.id),
      };
    }),
    periods: { today: per.daily, week: per.weekly, month: per.monthly },
    monthlyBudget: budget.budgetOptedOut ? null : budget.monthly,
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const sinceTs = sinceToTs(opts.since);
  if (opts.since && sinceTs === null) {
    process.stderr.write('analyze.js: --since requires a YYYY-MM-DD date\n');
    process.exit(1);
  }
  const source = opts.configDir !== undefined ? opts.configDir : process.env.CLAUDE_CONFIG_DIR;
  const transcriptRoot = source || path.join(os.homedir(), '.claude');

  const dirs = projectDirs(transcriptRoot);
  let rows = listSessions(transcriptRoot, dirs);

  const stateDir = resolveStateDir(source);
  const pricing = loadPricing(stateDir, { allowFetch: false });
  const agg = aggregate(transcriptRoot, pricing);
  const costOf = (id) => { const ps = agg.perSession[id]; return ps ? ps.total : 0; };

  if (opts.detail !== undefined) {
    const matches = rows.filter((r) => r.id.startsWith(opts.detail));
    if (matches.length === 0) {
      process.stderr.write(`analyze.js: no session matching '${opts.detail}'\n`);
      process.exit(1);
    }
    if (matches.length > 1) {
      process.stderr.write(`analyze.js: '${opts.detail}' is ambiguous:\n` +
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
    process.stdout.write(JSON.stringify(analysisPayload(detail, row.id, row.ts, title, recap), null, 2) + '\n');
    return;
  }

  const budget = resolveBudget(process.env.STATUSLINE_MONTHLY_BUDGET);
  const per = sumPeriods(agg.perSession, new Date());
  const emitJson = (rs) => process.stdout.write(
    JSON.stringify(listPayload(rs, costOf, readTitleRecap, per, budget), null, 2) + '\n');

  if (rows.length === 0) { emitJson(rows); return; }
  if (sinceTs != null) rows = rows.filter((r) => r.ts >= sinceTs);
  const cap = opts.last != null ? opts.last : (opts.since ? Infinity : 10);
  rows = rows.slice(0, cap);
  emitJson(rows);
}

main();
