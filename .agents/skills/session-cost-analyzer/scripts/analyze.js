#!/usr/bin/env node
'use strict';
// JSON-only session cost analyzer. A trim of the repo's bin/sessions.js with all
// human rendering removed: emits the LIST payload (no prefix / `list`) or the
// full-fidelity DETAIL payload (with an id-prefix). Self-contained — vendored libs
// live in ./lib, the price snapshot in ../data. See SYNC.md for the canonical source.
const path = require('path');
const os = require('os');
const { readTitleRecap, projectDirs, listSessions, listSubagentTranscripts } = require('./lib/transcript');
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
  let sawPositional = false;
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
    else if (a.startsWith('--')) { /* unknown flag: ignored */ }
    else if (!sawPositional) {
      // First positional only: 'list' = explicit list subcommand (detail stays
      // undefined); anything else = session prefix. A second positional errors.
      sawPositional = true;
      if (a !== 'list') opts.detail = a;
    }
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
    unpriced: detail.unpriced,
    unpricedModels: detail.unpricedModels,
    legend:
      'Cost ≈ context-size × steps, recomputed from raw tokens × LiteLLM prices (not Claude\'s reported cost). ' +
      'tokens.cacheRead = re-reading accumulated context and is the dominant driver; tokens.input (fresh) is usually negligible. ' +
      'turns and calls are in EXECUTION order. steps (top level) = total billed assistant calls incl. subagents; summary.mainSteps = main-session steps only (the denominator for per-step views like contextGrowth and the timeline). Each main call carries turnIndex (which turn it served). ' +
      'NOTE: a turn\'s tokens.cacheRead is a SUM across its steps, NOT the context size — use turn.avgContext / turn.peakContext and summary.contextGrowth (per-step cacheRead) for the real growth curve. ' +
      'A cacheWrite spike usually means the parent re-cached its whole context (e.g. on a subagent return). ' +
      'Use summary.byTurnKind for cost per kind of work, summary.toolTally for the canonical tool counts (do NOT re-aggregate calls[].tools — that over-counts), ' +
      'summary.highContextCost for the spend above 200k context (what a /compact would have cut), and summary.contextResets for how many times context was cleared. ' +
      'summary.contextConsumers names WHAT filled the context — each tool result (which file was read, which command ran) and user prompt, with estimated tokens (~chars/4) and carriedCost (the re-read tax it incurred on every later step) — use it to say which exact file/command consumed the context; its assistant-text / assistant-thinking / assistant-tool-calls rows split the model\'s ' +
      'own output by kind (apportioned from exact output_tokens), so a fat assistant share means verbosity, not reads. ' +
      'summary.assistantOutput drills into that output: byKind token/cost split and a thinking breakdown — storedTokens vs unstoredTokens (interleaved thinking billed in output_tokens but never saved to the transcript), ' +
      'thinking.byTurn (which prompts drove the reasoning) and thinking.topSteps (the heaviest single bursts, each with its trigger — what landed in context right before — and the action it took next; ' +
      'the thinking text itself is never persisted, so trigger → next-action is the maximum attribution) — use it to explain WHY assistant-thinking is large. ' +
      'summary.bySkill attributes cost to skill dispatches (turns whose prompt is a skill expansion or /slash command) — only the turns the skill itself drove, not later work it influenced. ' +
      'unpriced = billed calls EXCLUDED from totalCost/components/byModel because their model (unpricedModels) is missing from the price table — totalCost is undercounted by their unknown amount.',
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
function listPayload(rows, costOf, per, budget) {
  return {
    sessions: rows.map((r) => {
      const { title, recap } = readTitleRecap(r.file);
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
    const detail = buildDetail(row.file, listSubagentTranscripts(row.file, row.id), pricing);
    const { title, recap } = readTitleRecap(row.file);
    process.stdout.write(JSON.stringify(analysisPayload(detail, row.id, row.ts, title, recap), null, 2) + '\n');
    return;
  }

  // List mode: recompute every session's spend (detail mode above skips this —
  // buildDetail re-derives the one session it needs).
  const agg = aggregate(transcriptRoot, pricing);
  const costOf = (id) => { const ps = agg.perSession[id]; return ps ? ps.total : 0; };
  const budget = resolveBudget(process.env.STATUSLINE_MONTHLY_BUDGET);
  const per = sumPeriods(agg.perSession, new Date());
  const emitJson = (rs) => process.stdout.write(
    JSON.stringify(listPayload(rs, costOf, per, budget), null, 2) + '\n');

  if (sinceTs != null) rows = rows.filter((r) => r.ts >= sinceTs);
  const cap = opts.last != null ? opts.last : (opts.since ? Infinity : 10);
  rows = rows.slice(0, cap);
  emitJson(rows);
}

main();
