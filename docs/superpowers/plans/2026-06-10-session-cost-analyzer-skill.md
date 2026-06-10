# Session Cost Analyzer Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a self-contained, JSON-only `session-cost-analyzer` skill that drives a vendored copy of this repo's cost engine to analyze why a Claude Code session was expensive and emit an HTML report.

**Architecture:** Vendor the 8-file cost-engine closure (verbatim, except a one-line `pricing.js` path tweak) under `.agents/skills/session-cost-analyzer/scripts/lib/`, with `data/model_prices.json` at the skill root. A thin `scripts/analyze.js` (a trim of `bin/sessions.js` with all human rendering removed) emits two JSON payloads: `list` and `<id-prefix>` detail. SKILL.md drives the agent workflow; REFERENCE.md holds the cost-interpretation model; an HTML template renders the report. A repo-level parity test guards the vendored trim against `bin/sessions.js --analyze`.

**Tech Stack:** Pure Node stdlib (Node 18+), `node:test`. No build, no deps.

**Spec:** `docs/superpowers/specs/2026-06-10-session-cost-analyzer-skill-design.md`

---

## File Structure

| Path | Responsibility |
|---|---|
| `.agents/skills/session-cost-analyzer/SKILL.md` | Frontmatter (name/description) + agent workflow, < 100 lines |
| `.agents/skills/session-cost-analyzer/REFERENCE.md` | Cost-interpretation model (subagent/main-context learning) |
| `.agents/skills/session-cost-analyzer/SYNC.md` | Canonical source + re-vendor steps + the pricing.js delta |
| `.agents/skills/session-cost-analyzer/scripts/analyze.js` | JSON-only entry: `list` + `<prefix>` detail |
| `.agents/skills/session-cost-analyzer/scripts/lib/*.js` | 8 vendored libs (color.js excluded) |
| `.agents/skills/session-cost-analyzer/scripts/test/smoke.test.js` | Standalone JSON-shape test (survives extraction) |
| `.agents/skills/session-cost-analyzer/data/model_prices.json` | Vendored price snapshot, skill root |
| `.agents/skills/session-cost-analyzer/assets/report-template.html` | Reusable styled HTML shell |
| `tests/skill-analyze-parity.test.js` | Repo-level: analyze.js output == `bin/sessions.js --analyze` |

---

## Task 1: Vendor the cost engine into the skill

**Files:**
- Create: `.agents/skills/session-cost-analyzer/scripts/lib/{transcript,cost-aggregate,session-detail,cost-compute,pricing,periods,state,budget}.js`
- Create: `.agents/skills/session-cost-analyzer/data/model_prices.json`
- Modify (vendored copy only): `.agents/skills/session-cost-analyzer/scripts/lib/pricing.js:7`

- [ ] **Step 1: Copy the lib closure + data snapshot**

Run from repo root:

```bash
SKILL=.agents/skills/session-cost-analyzer
mkdir -p "$SKILL/scripts/lib" "$SKILL/data" "$SKILL/assets" "$SKILL/scripts/test"
cp lib/transcript.js lib/cost-aggregate.js lib/session-detail.js lib/cost-compute.js \
   lib/pricing.js lib/periods.js lib/state.js lib/budget.js "$SKILL/scripts/lib/"
cp data/model_prices.json "$SKILL/data/"
```

(`color.js` is intentionally NOT copied — it is human-rendering only.)

- [ ] **Step 2: Re-path the bundled-snapshot constant in the vendored pricing.js**

In `.agents/skills/session-cost-analyzer/scripts/lib/pricing.js` line 7, change:

```js
const BUNDLED = path.join(__dirname, '..', 'data', 'model_prices.json');
```

to (data is now two levels up — `scripts/lib/` → skill root):

```js
const BUNDLED = path.join(__dirname, '..', '..', 'data', 'model_prices.json');
```

- [ ] **Step 3: Verify the vendored libs load and pricing resolves the snapshot**

Run:

```bash
node -e "const {loadPricing}=require('./.agents/skills/session-cost-analyzer/scripts/lib/pricing'); const p=loadPricing('/tmp/csl-nope',{allowFetch:false}); console.log('models:', Object.keys(p).length)"
```

Expected: prints `models: <N>` with N > 0 (snapshot found via the re-pathed `BUNDLED`). No `ENOENT`.

- [ ] **Step 4: Commit**

```bash
git add .agents/skills/session-cost-analyzer/scripts/lib .agents/skills/session-cost-analyzer/data
git commit -m "feat(skill): vendor cost-engine libs + price snapshot"
```

---

## Task 2: Write the JSON-only analyze.js + repo parity test

**Files:**
- Create: `.agents/skills/session-cost-analyzer/scripts/analyze.js`
- Test: `tests/skill-analyze-parity.test.js`

- [ ] **Step 1: Write the failing parity test**

> **Fixture note:** the `fixture()` transcript entries below are a best-effort shape. Before
> running, open `tests/cost-aggregate.test.js` and copy its exact assistant-entry schema
> (field names for `usage` / model / timestamp) so the fixture actually produces a non-zero,
> deterministic cost. Parity (`deepStrictEqual`) holds regardless of the exact numbers, but a
> zero-cost or unparsed fixture would make the test vacuous.

Create `tests/skill-analyze-parity.test.js`:

```js
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SESSIONS = path.join(__dirname, '..', 'bin', 'sessions.js');
const ANALYZE = path.join(__dirname, '..', '.agents', 'skills', 'session-cost-analyzer', 'scripts', 'analyze.js');

const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

function mkProfile() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-parity-'));
  tmpDirs.push(configDir);
  return configDir;
}

function writeTranscript(configDir, sessionId, entries, when) {
  const proj = path.join(configDir, 'projects', '-test-proj');
  fs.mkdirSync(proj, { recursive: true });
  const file = path.join(proj, `${sessionId}.jsonl`);
  fs.writeFileSync(file, entries.map((o) => JSON.stringify(o)).join('\n') + '\n');
  if (when != null) { const d = new Date(when * 1000); fs.utimesSync(file, d, d); }
}

function runJson(script, args, configDir) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir,
      XDG_STATE_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'csl-state-')) };
    tmpDirs.push(env.XDG_STATE_HOME);
    const proc = spawn(process.execPath, [script, ...args], { env });
    let out = '', err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('close', (code) => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err)));
  });
}

// One assistant call with usage so cost is non-zero and deterministic.
const fixture = (sessionId) => [
  { type: 'user', message: { role: 'user', content: 'do the thing' }, uuid: 'u1' },
  { type: 'assistant', message: { id: 'm1', role: 'assistant', model: 'claude-sonnet-4-6',
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 },
      content: [{ type: 'text', text: 'done' }] }, uuid: 'a1' },
];

test('parity: list payload matches bin/sessions.js --analyze', async () => {
  const cfg = mkProfile();
  writeTranscript(cfg, 'parity01', fixture('parity01'), 1717200000);
  const a = await runJson(SESSIONS, ['--analyze'], cfg);
  const b = await runJson(ANALYZE, ['list'], cfg);
  assert.deepStrictEqual(b, a);
});

test('parity: detail payload matches bin/sessions.js <prefix> --analyze', async () => {
  const cfg = mkProfile();
  writeTranscript(cfg, 'parity02', fixture('parity02'), 1717200000);
  const a = await runJson(SESSIONS, ['parity02', '--analyze'], cfg);
  const b = await runJson(ANALYZE, ['parity02'], cfg);
  assert.deepStrictEqual(b, a);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/skill-analyze-parity.test.js`
Expected: FAIL — `analyze.js` does not exist yet (spawn error / cannot find module).

- [ ] **Step 3: Write analyze.js**

Create `.agents/skills/session-cost-analyzer/scripts/analyze.js`:

```js
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
```

- [ ] **Step 4: Run the parity test to verify it passes**

Run: `node --test tests/skill-analyze-parity.test.js`
Expected: PASS — both `list` and detail payloads deep-equal the `bin/sessions.js --analyze` output.

- [ ] **Step 5: Commit**

```bash
git add .agents/skills/session-cost-analyzer/scripts/analyze.js tests/skill-analyze-parity.test.js
git commit -m "feat(skill): JSON-only analyze.js + repo parity test"
```

---

## Task 3: Standalone smoke test (survives extraction)

**Files:**
- Create: `.agents/skills/session-cost-analyzer/scripts/test/smoke.test.js`

This test depends only on files inside the skill folder, so it keeps working after the skill is lifted into its own repo (unlike the repo parity test, which references `bin/sessions.js`).

- [ ] **Step 1: Write the smoke test**

Create `.agents/skills/session-cost-analyzer/scripts/test/smoke.test.js`:

```js
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ANALYZE = path.join(__dirname, '..', 'analyze.js');
const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

function mkProfile() {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-smoke-'));
  tmpDirs.push(cfg);
  return cfg;
}

function writeTranscript(cfg, id, entries, when) {
  const proj = path.join(cfg, 'projects', '-test-proj');
  fs.mkdirSync(proj, { recursive: true });
  const file = path.join(proj, `${id}.jsonl`);
  fs.writeFileSync(file, entries.map((o) => JSON.stringify(o)).join('\n') + '\n');
  if (when != null) { const d = new Date(when * 1000); fs.utimesSync(file, d, d); }
}

function runJson(args, cfg) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, CLAUDE_CONFIG_DIR: cfg,
      XDG_STATE_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'csl-st-')) };
    tmpDirs.push(env.XDG_STATE_HOME);
    const proc = spawn(process.execPath, [ANALYZE, ...args], { env });
    let out = '', err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('close', (code) => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err)));
  });
}

const fixture = [
  { type: 'user', message: { role: 'user', content: 'do the thing' }, uuid: 'u1' },
  { type: 'assistant', message: { id: 'm1', role: 'assistant', model: 'claude-sonnet-4-6',
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 },
      content: [{ type: 'text', text: 'done' }] }, uuid: 'a1' },
];

test('smoke: list payload has the documented top-level keys', async () => {
  const cfg = mkProfile();
  writeTranscript(cfg, 'smoke001', fixture, 1717200000);
  const out = await runJson(['list'], cfg);
  assert.ok(Array.isArray(out.sessions));
  assert.deepStrictEqual(Object.keys(out.periods).sort(), ['month', 'today', 'week']);
  assert.ok('monthlyBudget' in out);
  assert.strictEqual(out.sessions[0].session, 'smoke001');
});

test('smoke: detail payload exposes the precomputed summary rollups', async () => {
  const cfg = mkProfile();
  writeTranscript(cfg, 'smoke002', fixture, 1717200000);
  const out = await runJson(['smoke002'], cfg);
  assert.strictEqual(out.session, 'smoke002');
  assert.ok(out.totalCost > 0);
  for (const k of ['contextGrowth', 'byTurnKind', 'toolTally', 'highContextCost', 'contextResets']) {
    assert.ok(k in out.summary, `summary.${k} present`);
  }
});

test('smoke: empty store still emits valid list JSON', async () => {
  const cfg = mkProfile();
  const out = await runJson(['list'], cfg);
  assert.deepStrictEqual(out.sessions, []);
});
```

- [ ] **Step 2: Run the smoke test to verify it passes**

Run: `node --test .agents/skills/session-cost-analyzer/scripts/test/smoke.test.js`
Expected: PASS (3 tests).

- [ ] **Step 3: Commit**

```bash
git add .agents/skills/session-cost-analyzer/scripts/test/smoke.test.js
git commit -m "test(skill): standalone JSON-shape smoke test"
```

---

## Task 4: Author SKILL.md, REFERENCE.md, SYNC.md

**Files:**
- Create: `.agents/skills/session-cost-analyzer/SKILL.md`
- Create: `.agents/skills/session-cost-analyzer/REFERENCE.md`
- Create: `.agents/skills/session-cost-analyzer/SYNC.md`

- [ ] **Step 1: Write SKILL.md**

Create `.agents/skills/session-cost-analyzer/SKILL.md`:

```md
---
name: session-cost-analyzer
description: >-
  Analyze why a Claude Code session was expensive — break down its cost by token type,
  model, turn, and subagent, and produce an HTML report. Use when the user asks where a
  session's cost or tokens went, why a session was costly, to analyze or audit token or
  dollar spend, to list recent sessions by cost, or mentions session cost, /compact
  savings, or context growth.
---

# Session Cost Analyzer

Drives `scripts/analyze.js` (self-contained, JSON-only) to explain a session's cost.

## Quick start

```bash
# List recent sessions (newest first) with their recomputed cost:
node scripts/analyze.js list --last 10

# Full cost breakdown for one session (id or unambiguous prefix):
node scripts/analyze.js <session-id-prefix>
```

Both print JSON to stdout. `--config-dir <path>` points at a non-default `~/.claude`.
`list` also takes `--since YYYY-MM-DD` and `--last N`.

## Workflow

1. **Select the session.**
   - If the user gave a session id/prefix, skip to step 2 with it.
   - Otherwise run `node scripts/analyze.js list --last 10`, summarize the sessions
     inline (`title · $cost · age`), and ask which one to analyze.

2. **Pull the detail.** Run `node scripts/analyze.js <prefix>` and parse the JSON.
   Read the `legend` field first — it states the cost model.

3. **Read the precomputed rollups, do NOT hand-aggregate `calls[]`.**
   Use `summary.contextGrowth`, `summary.byTurnKind`, `summary.toolTally`,
   `summary.highContextCost`, `summary.contextResets`. Re-aggregating `calls[]` is a
   known trap: it over-counts tools ~3× and invents false "10× growth" from one early
   call. The script already computed the honest numbers — use them.

4. **Interpret** with the cost model in [REFERENCE.md](REFERENCE.md).

5. **Report.**
   - Narrate the cost story inline (where the money went, the biggest lever).
   - Generate an HTML report: read `assets/report-template.html`, fill its
     `{{PLACEHOLDER}}` slots from the JSON (see the comment block at the top of the
     template for the slot list), and write it to `./session-cost-<shortid>.html`
     unless the user gives another path. Tell the user the file path.

## Notes

- Costs are recomputed from raw tokens × LiteLLM prices — never Claude's reported cost.
- The analyzer is offline; it uses the bundled `data/model_prices.json` snapshot.
```

- [ ] **Step 2: Write REFERENCE.md**

Create `.agents/skills/session-cost-analyzer/REFERENCE.md`:

```md
# Cost interpretation model

**Cost ≈ context-size × steps. Subagents are cheap; bloated MAIN-session context is the real cost.**

- The MAIN thread re-reading/re-caching its own accumulated context dominates: typically
  `cache-read` (~47%) + `cache-write` (~31%) ≫ `output` (~20%) ≫ fresh `input` (~2%).
- Each subagent spawns with its **own fresh ~5–35k context** — it does **not** inherit the
  parent's 200k+. It returns only a few-KB summary. So fan-out (planning, parallel review
  lenses, research) costs cents. In one measured $32.94 session, all 11 subagents (226 calls)
  were **$1.04 (3%)**; the main session (192 calls) was **$31.90 (97%)**.
- `summary.highContextCost` = spend on calls **above 200k context** = exactly what a `/compact`
  would have cut.
- `summary.byTurnKind` "subagent-orchestration" cost is **not** the subagents — it's the parent
  taking steps while already at 200k+. The fix is always: shrink the parent's context.

## Levers, by impact

1. Keep MAIN-session context small — `/compact` or a fresh session between distinct phases.
   Context never shed = every later step pays the full tax.
2. Push heavy exploration INTO subagents — nearly free, keeps the parent lean.
3. Treat "subagent-orchestration" cost as a parent-context problem, not a subagent problem.

## How to read the detail JSON

- `legend` — the cost model, embedded so numbers are interpreted correctly.
- `components` — itemized `{input, output, cacheWrite, cacheRead, web, total}` dollars.
- `summary.contextGrowth` — `{firstCall, quartileAvgContext[4], peakContext}` per-step cacheRead:
  the honest growth curve. A turn's `tokens.cacheRead` is a SUM across its steps, NOT context size.
- `summary.toolTally` — canonical main-session tool counts. Do not recompute from `calls[]`.
- `byModel` / `byAgent` / `subagents` — cost split by model, by subagent task, and the subagent total.
- `turns` (execution order) carry `kind` / `avgContext` / `peakContext`.
```

- [ ] **Step 3: Write SYNC.md**

Create `.agents/skills/session-cost-analyzer/SYNC.md`:

```md
# Vendoring / sync

This skill bundles a copy of the claude-statusline cost engine so it can run standalone
(and eventually live in its own repo). **Canonical source = the claude-statusline repo.**

## Vendored files (source → here)

| Source (repo root) | Here |
|---|---|
| `lib/transcript.js` | `scripts/lib/transcript.js` |
| `lib/cost-aggregate.js` | `scripts/lib/cost-aggregate.js` |
| `lib/session-detail.js` | `scripts/lib/session-detail.js` |
| `lib/cost-compute.js` | `scripts/lib/cost-compute.js` |
| `lib/pricing.js` | `scripts/lib/pricing.js` (one delta — see below) |
| `lib/periods.js` | `scripts/lib/periods.js` |
| `lib/state.js` | `scripts/lib/state.js` |
| `lib/budget.js` | `scripts/lib/budget.js` |
| `data/model_prices.json` | `data/model_prices.json` |

`lib/color.js` is deliberately NOT vendored (human rendering only).

## The one non-verbatim delta

`scripts/lib/pricing.js` `BUNDLED` constant: `__dirname/../data` → `__dirname/../../data`
(because `data/` sits at the skill root, one level above `scripts/`). Re-apply after any re-copy.

## Re-sync

```bash
# from the claude-statusline repo root
SKILL=.agents/skills/session-cost-analyzer
cp lib/{transcript,cost-aggregate,session-detail,cost-compute,pricing,periods,state,budget}.js "$SKILL/scripts/lib/"
cp data/model_prices.json "$SKILL/data/"
# then re-apply the BUNDLED delta in scripts/lib/pricing.js
```

The repo test `tests/skill-analyze-parity.test.js` fails loudly if the vendored trim ever
diverges in output from `bin/sessions.js --analyze`.
```

- [ ] **Step 4: Verify SKILL.md stays under 100 lines**

Run: `wc -l .agents/skills/session-cost-analyzer/SKILL.md`
Expected: a number < 100.

- [ ] **Step 5: Commit**

```bash
git add .agents/skills/session-cost-analyzer/SKILL.md .agents/skills/session-cost-analyzer/REFERENCE.md .agents/skills/session-cost-analyzer/SYNC.md
git commit -m "docs(skill): SKILL.md workflow + REFERENCE + SYNC"
```

---

## Task 5: Reusable HTML report template

**Files:**
- Create: `.agents/skills/session-cost-analyzer/assets/report-template.html`

- [ ] **Step 1: Write the template**

Create `.agents/skills/session-cost-analyzer/assets/report-template.html`. The agent
fills the `{{...}}` slots from the detail JSON. `{{WHERE_IT_WENT_ROWS}}`,
`{{BY_MODEL_ROWS}}`, `{{TOP_TURNS_ROWS}}`, and `{{SUBAGENT_ROWS}}` are each filled with
repeated `<tr>...</tr>` HTML built from the corresponding JSON arrays.

```html
<!doctype html>
<!--
  Session cost report template. Fill these slots from `analyze.js <prefix>` JSON:
    {{SESSION_ID}}      session
    {{TITLE}}           title (or "—")
    {{STARTED_AT}}      startedAt
    {{TOTAL_COST}}      totalCost, formatted "$0.00"
    {{STEP_COUNT}}      steps
    {{DURATION}}        summary.durationMs → "Xh Ym"
    {{HIGH_CTX_COST}}   summary.highContextCost.cost → "$0.00" (what /compact would save)
    {{HIGH_CTX_CALLS}}  summary.highContextCost.calls
    {{CONTEXT_RESETS}}  summary.contextResets
    {{PEAK_CONTEXT}}    summary.contextGrowth.peakContext → "Nk"
    {{WHERE_IT_WENT_ROWS}}  one <tr> per components entry: <td>label</td><td>$cost</td><td><bar></td>
    {{BY_MODEL_ROWS}}       one <tr> per byModel entry
    {{TOP_TURNS_ROWS}}      one <tr> per top turn (cost, kind, peakContext, prompt)
    {{SUBAGENT_ROWS}}       one <tr> per byAgent entry (task, cost) — omit table if none
-->
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Session cost · {{SESSION_ID}}</title>
<style>
  :root { --bg:#0f1115; --fg:#e6e6e6; --dim:#8a8f98; --accent:#7aa2f7; --warn:#e0af68; --bar:#3b4261; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; background:var(--bg); color:var(--fg); }
  .wrap { max-width:900px; margin:0 auto; padding:32px 20px; }
  h1 { font-size:18px; margin:0 0 4px; }
  .sub { color:var(--dim); margin:0 0 24px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin-bottom:28px; }
  .card { background:#161922; border:1px solid #232838; border-radius:8px; padding:14px; }
  .card .k { color:var(--dim); font-size:12px; }
  .card .v { font-size:20px; margin-top:4px; }
  .card .v.warn { color:var(--warn); }
  h2 { font-size:14px; color:var(--accent); border-bottom:1px solid #232838; padding-bottom:6px; margin:28px 0 10px; }
  table { width:100%; border-collapse:collapse; }
  td, th { text-align:left; padding:6px 8px; border-bottom:1px solid #1c2030; vertical-align:top; }
  th { color:var(--dim); font-weight:normal; font-size:12px; }
  td.num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
  .bar { height:8px; background:var(--bar); border-radius:4px; }
  .prompt { color:var(--dim); }
  footer { color:var(--dim); font-size:12px; margin-top:32px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>{{TITLE}}</h1>
  <p class="sub">{{SESSION_ID}} · started {{STARTED_AT}}</p>

  <div class="cards">
    <div class="card"><div class="k">total cost</div><div class="v">{{TOTAL_COST}}</div></div>
    <div class="card"><div class="k">steps</div><div class="v">{{STEP_COUNT}}</div></div>
    <div class="card"><div class="k">duration</div><div class="v">{{DURATION}}</div></div>
    <div class="card"><div class="k">peak context</div><div class="v">{{PEAK_CONTEXT}}</div></div>
    <div class="card"><div class="k">above-200k cost (/compact would cut)</div><div class="v warn">{{HIGH_CTX_COST}}</div><div class="k">{{HIGH_CTX_CALLS}} calls · {{CONTEXT_RESETS}} resets</div></div>
  </div>

  <h2>Where it went</h2>
  <table><thead><tr><th>component</th><th class="num">cost</th><th>share</th></tr></thead>
  <tbody>{{WHERE_IT_WENT_ROWS}}</tbody></table>

  <h2>By model</h2>
  <table><thead><tr><th>model</th><th class="num">cost</th></tr></thead>
  <tbody>{{BY_MODEL_ROWS}}</tbody></table>

  <h2>Top turns</h2>
  <table><thead><tr><th class="num">cost</th><th>kind</th><th class="num">peak ctx</th><th>prompt</th></tr></thead>
  <tbody>{{TOP_TURNS_ROWS}}</tbody></table>

  <h2>Subagents</h2>
  <table><thead><tr><th>task</th><th class="num">cost</th></tr></thead>
  <tbody>{{SUBAGENT_ROWS}}</tbody></table>

  <footer>Costs recomputed from raw tokens × LiteLLM prices (not Claude's reported cost).</footer>
</div>
</body>
</html>
```

- [ ] **Step 2: Sanity-check the template is valid standalone HTML**

Run: `node -e "const s=require('fs').readFileSync('.agents/skills/session-cost-analyzer/assets/report-template.html','utf8'); if(!s.includes('{{WHERE_IT_WENT_ROWS}}')||!s.includes('</html>')) throw new Error('template malformed'); console.log('template ok')"`
Expected: prints `template ok`.

- [ ] **Step 3: Commit**

```bash
git add .agents/skills/session-cost-analyzer/assets/report-template.html
git commit -m "feat(skill): reusable HTML report template"
```

---

## Task 6: Final full-suite verification

- [ ] **Step 1: Run the entire repo test suite**

Run: `node --test tests/*.test.js`
Expected: all pass, including the new `tests/skill-analyze-parity.test.js`. 0 fail.

- [ ] **Step 2: Run the skill's standalone test**

Run: `node --test .agents/skills/session-cost-analyzer/scripts/test/smoke.test.js`
Expected: 3 pass, 0 fail.

- [ ] **Step 3: End-to-end manual check against a real session**

Run: `node .agents/skills/session-cost-analyzer/scripts/analyze.js list --last 3`
Expected: valid JSON listing up to 3 real sessions with non-null `cost` fields.

Then pick one id from that output and run:

Run: `node .agents/skills/session-cost-analyzer/scripts/analyze.js <that-id-prefix> | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('total',j.totalCost,'keys',Object.keys(j.summary))})"`
Expected: prints a total cost and the `summary` keys including `highContextCost`, `toolTally`.

---

## Self-Review

**Spec coverage:**
- Vendor 8 libs + data, drop color.js → Task 1. ✓
- pricing.js one-line re-path → Task 1 Step 2. ✓
- JSON-only analyze.js, `list` + `<prefix>`, no `--analyze` flag → Task 2. ✓
- Parity with `bin/sessions.js --analyze` → Task 2 test (repo) + Task 3 smoke (standalone). ✓
- SKILL.md description with triggers, < 100 lines → Task 4 Steps 1, 4. ✓
- REFERENCE.md cost model (subagent learning) → Task 4 Step 2. ✓
- SYNC.md drift management → Task 4 Step 3. ✓
- HTML report from reusable template, cwd default + override → Task 5 + SKILL.md workflow step 5. ✓
- "Read summary.*, never re-aggregate calls[]" → SKILL.md workflow step 3 + REFERENCE.md. ✓

**Placeholder scan:** No TBD/TODO; all code blocks complete; the `{{...}}` tokens in the HTML template are intentional fill-slots, documented in the template's own header comment and in SKILL.md step 5.

**Type/name consistency:** `analyze.js` payload field names (`session, title, recap, startedAt, totalCost, steps, legend, components, summary, byModel, byAgent, subagents, turns, calls`) match `analysisPayload` and the spec. `list` payload (`sessions, periods{today,week,month}, monthlyBudget`) matches `listPayload`. Smoke + parity tests use the same field names. The `list` subcommand recognized in `parseArgs` matches the SKILL.md `analyze.js list` invocations.
