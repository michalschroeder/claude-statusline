#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { readTitleRecap, projectDirs, listSessions, listSubagentTranscripts } = require('../lib/transcript');
const { dim, cyan, colorByTier, SESSION_TIERS, BUDGET_TIERS } = require('../lib/color');
const { loadPricing } = require('../lib/pricing');
const { aggregate } = require('../lib/cost-aggregate');
const { buildDetail } = require('../lib/session-detail');
const { sumPeriods } = require('../lib/periods');
const { resolveBudget } = require('../lib/budget');
const { resolveStateDir } = require('../lib/state');

function parseArgs(argv) {
  const opts = { last: null, since: null, configDir: undefined, detail: undefined, analyze: false };
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
    else if (a === '--analyze') { opts.analyze = true; } // emit JSON: full-fidelity detail (with a session prefix) or the session list (without)
    else if (a.startsWith('--')) {
      process.stderr.write(`bin/sessions.js: unknown flag '${a}'\n`);
      process.exit(1);
    }
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
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  // Reject rollover: new Date(2026, 12, 40) silently becomes Feb 2027.
  if (d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[3]) return null;
  return Math.floor(d.getTime() / 1000);
}

function truncate(s, width) {
  if (width <= 0) return '';
  if (s.length <= width) return s;
  return s.slice(0, Math.max(0, width - 1)) + '…';
}

const money = (c) => '$' + c.toFixed(2);

// Compact token count: 950, 12k, 4.1M.
function tok(n) {
  if (n < 1000) return String(n);
  if (n < 1e6) return Math.round(n / 1000) + 'k';
  return (n / 1e6).toFixed(1) + 'M';
}

// Top-3 tools of a turn as 'NN×Tool …', e.g. '40×Bash 26×Edit 13×Read'. '—' if none.
function toolStr(tools, n = 3) {
  if (!tools || !tools.length) return '—';
  return tools.slice(0, n).map(([name, count]) => `${count}×${name}`).join(' ');
}

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
  const mainSteps = (detail.summary && detail.summary.mainSteps != null) ? detail.summary.mainSteps : detail.calls;
  const subs = detail.subagentCount ? ` + ${detail.subagentCount} subagents` : '';
  out.push(dim(`${dayLabel(when)} ${clock(when)} · ${mainSteps} steps${subs} · ${money(detail.total)} total`));
  if (detail.unpriced) {
    const models = detail.unpricedModels.join(', ');
    out.push(dim(`  ⚠ ${detail.unpriced} call${detail.unpriced === 1 ? '' : 's'} unpriced (model not in price table${models ? ': ' + models : ''}) — cost undercounted`));
  }

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
      const fill = barFill(c, t, BAR);
      const bar = '▓'.repeat(fill) + dim('░'.repeat(BAR - fill));
      out.push(`  ${label.padEnd(lw)}  ${bar}  ${dim(String(Math.round(frac * 100)).padStart(3) + '%')}  ${money(c)}`);
    }
  }

  const cc = detail.summary && detail.summary.contextConsumers;
  if (cc && cc.top && cc.top.length) {
    out.push('');
    out.push(dim('WHAT FILLED CONTEXT') + dim('  · est tokens (~chars/4) · carried = re-read tax on later steps'));
    const top = cc.top.slice(0, 10);
    const toolCell = (c) => c.tool + (c.count > 1 && !c.synthetic ? ` ×${c.count}` : '');
    const tw = Math.max(...top.map((c) => tok(c.estTokens).length));
    const cw2 = Math.max(...top.map((c) => money(c.carriedCost).length));
    const nw = Math.max(...top.map((c) => toolCell(c).length));
    const metaW = 2 + tw + 2 + cw2 + 2 + nw + 2;
    for (const c of top) {
      const meta = `  ${dim(tok(c.estTokens).padStart(tw))}  ${money(c.carriedCost).padStart(cw2)}  ${toolCell(c).padEnd(nw)}  `;
      out.push(meta + dim(truncate(c.target, Math.max(0, width - metaW))));
    }
  }

  const ao = detail.summary && detail.summary.assistantOutput;
  if (ao && ao.thinking) {
    const th = ao.thinking;
    out.push('');
    out.push(dim('THINKING') + dim(`  · ${tok(th.storedTokens + th.unstoredTokens)} tokens ${money(ao.byKind.thinking.cost)} — billed at the output rate, the priciest tier`));
    out.push(`  ${tok(th.unstoredTokens)} interleaved ${dim('(billed, never saved to the transcript)')} · ${tok(th.storedTokens)} saved as thinking blocks`);
    const pk = th.peakStep;
    out.push(`  ${th.stepsWithThinking}/${th.mainSteps} steps thought · avg ${tok(th.avgPerThinkingStep)}/step · peak ${tok(pk.tokens)} at step ${pk.seq}${pk.nextTools.length ? dim(' → ' + pk.nextTools.join(', ')) : ''}`);
    const bursts = (th.topSteps || []).filter((b) => b.trigger);
    if (bursts.length) {
      out.push(dim('  TOP BURSTS') + dim('  · what landed in context right before → what it did next'));
      const bw = Math.max(...bursts.map((b) => tok(b.tokens).length));
      for (const b of bursts) {
        const next = b.nextTools.length ? b.nextTools.join(', ') : 'replied';
        const meta = `  ${tok(b.tokens).padStart(bw)}  `;
        const tail = ` → ${next}`;
        const trig = `${b.trigger.tool}: ${b.trigger.target}`;
        out.push(meta + dim(truncate(trig, Math.max(0, width - meta.length - tail.length))) + dim(tail));
      }
    }
    if (th.byTurn.length) {
      out.push(dim('  BY TURN') + dim('  · which prompts drove the reasoning'));
      const turns = th.byTurn.slice(0, 5);
      const tw = Math.max(...turns.map((t) => tok(t.thinkingTokens).length));
      const sw = Math.max(...turns.map((t) => String(t.steps).length));
      for (const t of turns) {
        const meta = `  ${tok(t.thinkingTokens).padStart(tw)}  ${dim(String(t.steps).padStart(sw) + ' steps')}  `;
        const metaW = 2 + tw + 2 + sw + 6 + 2;
        out.push(meta + dim(truncate(t.prompt, Math.max(0, width - metaW))));
      }
    }
  }

  const bs = (detail.summary && detail.summary.bySkill) || [];
  if (bs.length) {
    out.push('');
    out.push(dim('BY SKILL') + dim('  · cost of the turns each skill dispatch drove'));
    const cw3 = Math.max(...bs.map((s) => money(s.cost).length));
    const sw3 = Math.max(...bs.map((s) => String(s.steps).length));
    for (const s of bs) {
      out.push(`  ${money(s.cost).padStart(cw3)}  ${dim(String(s.steps).padStart(sw3) + ' steps')}  ${truncate(s.skill, Math.max(0, width - cw3 - sw3 - 12))}`);
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

  if (detail.turns.length) {
    out.push('');
    out.push(dim('TOP PROMPTS') + dim('  · turns ranked by cost; cache-rd is the dominant driver'));
    const top = detail.turns.slice().sort((a, b) => b.cost - a.cost).slice(0, 10);
    // Aligned columns: numeric cells right-padded, tools left-padded; a header row
    // sits above them. cost+steps render at normal weight, token/tool cells dim.
    const cols = [
      { h: 'cost',     get: (p) => money(p.cost),             end: false, dim: false },
      { h: 'steps',    get: (p) => String(p.steps),           end: false, dim: false },
      { h: 'input',    get: (p) => tok(p.tokens.input),       end: false, dim: true },
      { h: 'cache-rd', get: (p) => tok(p.tokens.cacheRead),   end: false, dim: true },
      { h: 'cache-wr', get: (p) => tok(p.tokens.cacheWrite),  end: false, dim: true },
      { h: 'output',   get: (p) => tok(p.tokens.output),      end: false, dim: true },
      { h: 'tools',    get: (p) => toolStr(p.tools),          end: true,  dim: true },
    ];
    for (const c of cols) c.w = Math.max(c.h.length, ...top.map((p) => c.get(p).length));
    const pad = (s, c) => (c.end ? s.padEnd(c.w) : s.padStart(c.w));
    const prefixW = 2 + cols.reduce((s, c) => s + c.w, 0) + 2 * cols.length; // gaps incl. one before prompt
    out.push(dim('  ' + cols.map((c) => pad(c.h, c)).join('  ') + '  prompt'));
    for (const p of top) {
      const cells = cols.map((c) => { const s = pad(c.get(p), c); return c.dim ? dim(s) : s; });
      out.push('  ' + cells.join('  ') + '  ' + truncate(p.prompt, Math.max(0, width - prefixW)));
    }
    if (detail.subagentCount > 0) {
      out.push(dim(`  + ${money(detail.subagentTotal)} across ${detail.subagentCount} subagent${detail.subagentCount === 1 ? '' : 's'}`));
    }
  }

  if (detail.subagentCount > 0) {
    out.push('');
    out.push(dim('BY AGENT'));
    const cw = Math.max(...detail.byAgent.map((a) => money(a.cost).length));
    for (const a of detail.byAgent) {
      const meta = `${money(a.cost).padStart(cw)}  `;
      out.push('  ' + meta + truncate(a.label, Math.max(0, width - 2 - meta.length)));
    }
  }

  return out.join('\n') + '\n';
}

// Full-fidelity JSON for an LLM/agent to reason about *why* a session was costly.
// Raw integer tokens, untruncated prompts, full tool tallies, execution-ordered
// turns + per-call records. The `legend` states the cost model so the consumer can
// interpret the numbers without re-deriving it.
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

// Session list as JSON for an LLM/agent: one record per session (post --since/--last
// filtering, newest-first like the rendered list), plus the same today/week/month
// period totals the footer shows. Costs are the recomputed spend (not Claude's).
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

  // Costs recomputed from raw tokens × LiteLLM prices (never trust Claude's cost).
  const stateDir = resolveStateDir(source);
  // Offline like the renderer: a "list sessions" command shouldn't trigger a
  // network fetch or write pricing.json. The background refresh hook keeps prices
  // fresh; the viewer uses the cached/bundled snapshot.
  const pricing = loadPricing(stateDir, { allowFetch: false });

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
    // A session resumed under a different cwd has a transcript half under each
    // projects/<enc-cwd>/ dir; collect all of them so the detail total matches
    // the list COST (aggregate sums every dir's <id>.jsonl + its subagents).
    const mainFiles = [], subFiles = [];
    for (const d of dirs) {
      const f = path.join(d, `${row.id}.jsonl`);
      try { if (fs.statSync(f).isFile()) mainFiles.push(f); } catch {}
      for (const s of listSubagentTranscripts(f, row.id)) subFiles.push(s);
    }
    const detail = buildDetail(mainFiles, subFiles, pricing);
    const { title, recap } = readTitleRecap(row.file);
    if (opts.analyze) {
      process.stdout.write(JSON.stringify(analysisPayload(detail, row.id, row.ts, title, recap), null, 2) + '\n');
    } else {
      process.stdout.write(renderDetail(detail, row.id, row.ts, title, recap, termWidth()));
    }
    return;
  }

  // List mode from here on. Recompute every session's spend (full history, no
  // mtime cap — the one-shot viewer can afford the parse); detail mode above
  // skips this since buildDetail re-derives the one session it needs.
  const agg = aggregate(transcriptRoot, pricing);
  const costOf = (id) => { const ps = agg.perSession[id]; return ps ? ps.total : 0; };

  // Period totals + budget (footer in text mode, top-level fields in JSON mode).
  const budget = resolveBudget(process.env.STATUSLINE_MONTHLY_BUDGET);
  const per = sumPeriods(agg.perSession, new Date());
  const emitJson = (rs) => process.stdout.write(
    JSON.stringify(listPayload(rs, costOf, per, budget), null, 2) + '\n');

  if (rows.length === 0) { // truly-empty store (no transcripts at all)
    if (opts.analyze) { emitJson(rows); return; }
    process.stdout.write('no sessions found\n');
    return;
  }

  // Rows: filter --since, then cap --last (default 10; skipped when --since given
  // without --last). listSessions already returns newest-first.
  if (sinceTs != null) rows = rows.filter((r) => r.ts >= sinceTs);
  const cap = opts.last != null ? opts.last : (opts.since ? Infinity : 10);
  rows = rows.slice(0, cap);

  if (opts.analyze) { emitJson(rows); return; } // JSON list for agents (valid even when empty)

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
  const { budgetOptedOut, monthly: mBudget, daily: dLimit, weekly: wLimit } = budget;
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
