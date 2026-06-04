'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { baseInput, run, runRaw, stripAnsi } = require('./helpers.js');

const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

// Local-calendar period starts (unix seconds), mirroring readPeriodCosts in statusline.js.
function boundaries() {
  const now = new Date();
  const dayStart = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000);
  const daysSinceMonday = (now.getDay() + 6) % 7;
  const weekStart = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysSinceMonday).getTime() / 1000);
  const monthStart = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000);
  return { now: Math.floor(now.getTime() / 1000), dayStart, weekStart, monthStart };
}

// Fresh temp XDG_STATE_HOME per test; optionally seed cost.log lines.
function mkState(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-cost-'));
  tmpDirs.push(dir);
  if (lines && lines.length) {
    const cslDir = path.join(dir, 'claude-statusline');
    fs.mkdirSync(cslDir, { recursive: true });
    fs.writeFileSync(path.join(cslDir, 'cost.log'), lines.join('\n') + '\n');
  }
  return dir;
}

// Build a cost.log line at an exact unix ts. The date column is cosmetic
// (bucketing uses the ts), but we keep it consistent for realism.
function logLineAt(cost, ts, session = 's') {
  const date = new Date(ts * 1000).toISOString().slice(0, 10);
  return `${date} ${ts} ${session} ${cost}`;
}

function inp(cost) {
  const i = baseInput();
  i.session_id = 'live-session';
  if (cost != null) i.cost = { total_cost_usd: cost };
  return i;
}

function env(stateDir, extra) {
  return { XDG_STATE_HOME: stateDir, STATUSLINE_MONTHLY_BUDGET: '500', ...(extra || {}) };
}

test('no cost log + no live cost — no period segments', async () => {
  const state = mkState();
  const plain = await run(inp(0), env(state));
  assert.ok(!plain.includes('d $'));
  assert.ok(!plain.includes('w $'));
  assert.ok(!plain.includes('m $'));
});

test('live cost only — session + daily/weekly/monthly all show live cost', async () => {
  const state = mkState();
  const plain = await run(inp(2.5), env(state));
  assert.ok(plain.includes('s $2.50'));
  assert.ok(plain.includes('d $2.50'));
  assert.ok(plain.includes('w $2.50'));
  assert.ok(plain.includes('m $2.50'));
});

test('today entries + live cost — correct daily sum', async () => {
  const { now } = boundaries();
  // Distinct session ids → two separate ended sessions (no dedup collapse).
  const state = mkState([logLineAt(1.0, now, 'a'), logLineAt(0.5, now, 'b')]);
  const plain = await run(inp(0.25), env(state));
  assert.ok(plain.includes('d $1.75')); // 1.0 + 0.5 + 0.25 live
});

test('same session_id logged twice (resume) is not double-counted', async () => {
  const { now } = boundaries();
  // A session ended at $5, then resumed and ended at cumulative $8 — two lines,
  // same id. Only the larger cumulative ($8) should count, not $13.
  const state = mkState([logLineAt(5.0, now, 'dup'), logLineAt(8.0, now, 'dup')]);
  const plain = await run(inp(null), env(state));
  assert.ok(plain.includes('d $8.00'));
  assert.ok(!plain.includes('d $13.00'));
});

test('current session already in cost.log (resume) — live cost supersedes, no double-count', async () => {
  const { now } = boundaries();
  // 'live-session' ended earlier today at $4 (logged); now resumed at cumulative $6.
  const state = mkState([logLineAt(4.0, now, 'live-session')]);
  const plain = await run(inp(6.0), env(state));
  assert.ok(plain.includes('s $6.00'));
  assert.ok(plain.includes('d $6.00')); // not 4+6=10
  assert.ok(!plain.includes('d $10.00'));
});

test('daily window — entry just before today midnight excluded', async () => {
  const { dayStart } = boundaries();
  const state = mkState([logLineAt(3.0, dayStart - 1)]); // yesterday 23:59:59
  const plain = await run(inp(null), env(state));
  assert.ok(!plain.includes('d $'));
});

test('daily window — entry at today midnight included', async () => {
  const { dayStart } = boundaries();
  const state = mkState([logLineAt(3.0, dayStart)]);
  const plain = await run(inp(null), env(state));
  assert.ok(plain.includes('d $3.00'));
});

test('weekly window — entry before this Monday excluded', async () => {
  const { weekStart } = boundaries();
  const state = mkState([logLineAt(3.0, weekStart - 1)]); // Sunday 23:59:59
  const plain = await run(inp(null), env(state));
  assert.ok(!plain.includes('w $3.00'));
});

test('weekly window — entry at this Monday midnight included', async () => {
  const { weekStart } = boundaries();
  const state = mkState([logLineAt(3.0, weekStart)]);
  const plain = await run(inp(null), env(state));
  assert.ok(plain.includes('w $3.00'));
});

test('monthly window — entry before the 1st excluded', async () => {
  const { monthStart } = boundaries();
  const state = mkState([logLineAt(4.0, monthStart - 1)]); // last day of prev month
  const plain = await run(inp(null), env(state));
  assert.ok(!plain.includes('m $4.00'));
});

test('monthly window — entry at the 1st included', async () => {
  const { monthStart } = boundaries();
  const state = mkState([logLineAt(4.0, monthStart)]);
  const plain = await run(inp(null), env(state));
  assert.ok(plain.includes('m $4.00'));
});

// Color codes the renderer wraps each cost part in (see ANSI helpers in statusline.js).
const COLORS = { green: '\x1b[32m', yellow: '\x1b[33m', orange: '\x1b[38;5;208m', red: '\x1b[31m' };

// Which color tier wraps a given cost part (`d `/`w `/`m `) — each part is colored
// independently, so the code immediately preceding its `<prefix>$<amount>` is its tier.
function partColor(raw, prefix, cost) {
  const label = `${prefix}$${cost.toFixed(2)}`;
  for (const [name, code] of Object.entries(COLORS)) {
    if (raw.includes(code + label)) return name;
  }
  return null;
}

// A single logged entry at `now` lands in ALL three windows at once, so one render
// exercises d/w/m coloring simultaneously.
async function periodRaw(cost, budget) {
  const { now } = boundaries();
  const state = mkState([logLineAt(cost, now)]);
  return runRaw(inp(null), env(state, { STATUSLINE_MONTHLY_BUDGET: budget }));
}

// Budget 300 → round limits: daily $10, weekly $70, monthly $300. Ratio thresholds
// are [0.5, 0.75, 0.9] and colorByTier uses `value < threshold`, so an exact-boundary
// value lands in the HIGHER tier (0.5 → yellow, 0.75 → orange, 0.9 → red). Data-driven
// across all three periods, including the exact boundaries.
const BUDGET_300 = '300';
const periodColorCases = [
  { prefix: 'd ', cost: 4.99, color: 'green' },   // 49.9% of $10
  { prefix: 'd ', cost: 5.00, color: 'yellow' },  // 50% boundary
  { prefix: 'd ', cost: 7.49, color: 'yellow' },  // 74.9%
  { prefix: 'd ', cost: 7.50, color: 'orange' },  // 75% boundary
  { prefix: 'd ', cost: 8.99, color: 'orange' },  // 89.9%
  { prefix: 'd ', cost: 9.00, color: 'red' },     // 90% boundary
  { prefix: 'd ', cost: 9.99, color: 'red' },     // 99.9%
  { prefix: 'w ', cost: 34.99, color: 'green' },  // 49.9% of $70
  { prefix: 'w ', cost: 35.00, color: 'yellow' }, // 50%
  { prefix: 'w ', cost: 52.50, color: 'orange' }, // 75%
  { prefix: 'w ', cost: 63.00, color: 'red' },    // 90%
  { prefix: 'm ', cost: 149.99, color: 'green' }, // 49.9% of $300
  { prefix: 'm ', cost: 150.00, color: 'yellow' },// 50%
  { prefix: 'm ', cost: 225.00, color: 'orange' },// 75%
  { prefix: 'm ', cost: 270.00, color: 'red' },   // 90%
];
const PERIOD_NAME = { 'd ': 'daily', 'w ': 'weekly', 'm ': 'monthly' };
for (const { prefix, cost, color } of periodColorCases) {
  test(`${PERIOD_NAME[prefix]} budget color — $${cost.toFixed(2)} of ${PERIOD_NAME[prefix]} limit → ${color}`, async () => {
    const raw = await periodRaw(cost, BUDGET_300);
    assert.equal(partColor(raw, prefix, cost), color);
  });
}

test('STATUSLINE_MONTHLY_BUDGET respected — smaller budget reddens sooner', async () => {
  // budget 30 → daily limit 1.0; cost 0.95 = 95% → red
  const { now } = boundaries();
  const state = mkState([logLineAt(0.95, now)]);
  const raw = await runRaw(inp(null), env(state, { STATUSLINE_MONTHLY_BUDGET: '30' }));
  assert.ok(stripAnsi(raw).includes('d $0.95'));
  assert.ok(raw.includes('\x1b[31m'));
});

test('invalid STATUSLINE_MONTHLY_BUDGET falls back to 500 (no color inversion)', async () => {
  const { now } = boundaries();
  // $10 of daily spend. Negative budget must NOT make it green; it falls back to
  // 500 → daily limit ~16.67 → 60% → yellow (not red, not green).
  const state = mkState([logLineAt(10.0, now)]);
  // `0abc`/`5,000`/`$500`/`''` are non-numeric (trailing garbage or empty) → 500,
  // NOT the `=== 0` opt-out and NOT a parseFloat-truncated wrong budget.
  for (const bad of ['-100', 'abc', '0abc', '5,000', '$500', '']) {
    const raw = await runRaw(inp(null), env(state, { STATUSLINE_MONTHLY_BUDGET: bad }));
    assert.ok(stripAnsi(raw).includes('d $10.00'), `budget="${bad}" renders amount`);
    assert.ok(raw.includes('\x1b[33m'), `budget="${bad}" → yellow (fell back to 500)`);
    assert.ok(!raw.includes('\x1b[32md '), `budget="${bad}" not green`);
    assert.ok(stripAnsi(raw).includes('d $'), `budget="${bad}" still shows period chips`);
  }
});

test('STATUSLINE_MONTHLY_BUDGET=0 hides d/w/m period chips, keeps session s', async () => {
  const { now } = boundaries();
  // Seed an ended session today so d/w/m would render if not hidden. `0`, `0.0`,
  // and ` 0 ` are all the numeric-zero opt-out (Number coerces them to 0).
  const state = mkState([logLineAt(3.0, now, 'ended')]);
  for (const zero of ['0', '0.0', ' 0 ']) {
    const plain = await run(inp(2.0), env(state, { STATUSLINE_MONTHLY_BUDGET: zero }));
    assert.ok(plain.includes('$2.00'), `budget="${zero}" session cost still shown`);
    assert.ok(!plain.includes('s $'), `budget="${zero}" no s prefix when only cost`);
    assert.ok(!plain.includes('d $'), `budget="${zero}" daily hidden`);
    assert.ok(!plain.includes('w $'), `budget="${zero}" weekly hidden`);
    assert.ok(!plain.includes('m $'), `budget="${zero}" monthly hidden`);
  }
});

test('session + period costs grouped into one segment, dot-separated', async () => {
  const state = mkState();
  const plain = await run(inp(2.0), env(state));
  // s/d/w/m sit in a single run joined by ' · ', not the ' ┊ ' segment separator.
  assert.ok(plain.includes('s $2.00 · d $2.00 · w $2.00 · m $2.00'));
});

test('STATUSLINE_SEGMENTS filter — cost is one toggle for session + periods', async () => {
  const state = mkState();
  const plain = await run(inp(2.0), env(state, { STATUSLINE_SEGMENTS: 'cost' }));
  assert.ok(plain.includes('s $2.00 · d $2.00 · w $2.00 · m $2.00'));

  const without = await run(inp(2.0), env(state, { STATUSLINE_SEGMENTS: 'model' }));
  assert.ok(!without.includes('$2.00'));
});

test('live session cost persisted to cost/<session> temp file', async () => {
  const state = mkState();
  await run(inp(1.23), env(state));
  const f = path.join(state, 'claude-statusline', 'cost', 'live-session');
  assert.equal(fs.readFileSync(f, 'utf8'), '1.23');
});

// --- Malformed / corrupt cost.log handling (data-driven) ---

const malformedCases = [
  { name: 'too few fields', line: () => '2020-01-01 12345 onlythree' },
  { name: 'non-numeric ts', line: ({ now }) => `2020-01-01 notanum sess 5.00` },
  { name: 'non-numeric cost', line: ({ now }) => `2020-01-01 ${now} sess abc` },
  { name: 'empty session id', line: ({ now }) => `2020-01-01 ${now}  5.00` },
  { name: 'negative cost', line: ({ now }) => `2020-01-01 ${now} sess -5.00` },
  { name: 'zero cost', line: ({ now }) => `2020-01-01 ${now} sess 0.00` },
];
for (const { name, line } of malformedCases) {
  test(`malformed cost.log line ignored — ${name}`, async () => {
    const b = boundaries();
    // One bad line + one good $4 line today. Only the good one should count.
    const state = mkState([line(b), logLineAt(4.0, b.now, 'good')]);
    const plain = await run(inp(null), env(state));
    assert.ok(plain.includes('d $4.00'), `${name}: good entry still counted`);
    assert.ok(!plain.includes('d $9.00') && !plain.includes('d $-1.00'),
      `${name}: bad entry not summed`);
  });
}

test('cost.log with only malformed lines → no period segments', async () => {
  const { now } = boundaries();
  const state = mkState(['garbage', `x y z`, `2020 ${now} id notacost`]);
  const plain = await run(inp(null), env(state));
  assert.ok(!plain.includes('d $') && !plain.includes('w $') && !plain.includes('m $'));
});

test('empty cost.log file → no period segments', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-cost-'));
  tmpDirs.push(dir);
  const cslDir = path.join(dir, 'claude-statusline');
  fs.mkdirSync(cslDir, { recursive: true });
  fs.writeFileSync(path.join(cslDir, 'cost.log'), ''); // exists but empty
  const plain = await run(inp(null), env(dir));
  assert.ok(!plain.includes('d $'));
});

test('blank lines and extra whitespace tolerated', async () => {
  const { now } = boundaries();
  const state = mkState(['', `   `, logLineAt(2.0, now, 'a'), '']);
  const plain = await run(inp(null), env(state));
  assert.ok(plain.includes('d $2.00'));
});

// --- Dedup / supersede scenarios ---

test('dedup keeps the max cost across differing timestamps', async () => {
  const { now, weekStart } = boundaries();
  // Same session: $8 at this week's Monday, $3 now. Both are within the week, so
  // weekly must equal the MAX ($8), never the sum ($11) nor the newer ($3).
  const state = mkState([logLineAt(8.0, weekStart, 'x'), logLineAt(3.0, now, 'x')]);
  const plain = await run(inp(null), env(state));
  assert.ok(plain.includes('w $8.00'), 'weekly = max cost');
  assert.ok(!plain.includes('w $11.00') && !plain.includes('w $3.00'));
});

test('live session supersedes a logged line in an earlier window (cross-window resume)', async () => {
  const { weekStart } = boundaries();
  // 'live-session' was logged earlier this week at $4; it has resumed and now reports
  // cumulative $6. The live value supersedes the logged one and buckets at now, so all
  // windows show $6 — never 4+6=10.
  const state = mkState([logLineAt(4.0, weekStart, 'live-session')]);
  const plain = await run(inp(6.0), env(state));
  assert.ok(plain.includes('s $6.00') && plain.includes('w $6.00') && plain.includes('m $6.00'));
  assert.ok(!plain.includes('$10.00'));
});

test('multiple distinct sessions today are summed (no dedup across ids)', async () => {
  const { now } = boundaries();
  const state = mkState([
    logLineAt(1.0, now, 'a'),
    logLineAt(2.0, now, 'b'),
    logLineAt(3.0, now, 'c'),
  ]);
  const plain = await run(inp(null), env(state));
  assert.ok(plain.includes('d $6.00')); // 1 + 2 + 3
});

// --- Live cost present/absent interplay with logged periods ---

test('live cost 0 with logged entries — periods show logged, session s omitted', async () => {
  const { now } = boundaries();
  const state = mkState([logLineAt(3.0, now, 'ended')]);
  const plain = await run(inp(0), env(state));
  assert.ok(!plain.includes('s $'), 'no session part when live cost is 0');
  assert.ok(plain.includes('d $3.00'), 'logged period still shown');
  assert.ok(plain.includes('w $3.00') && plain.includes('m $3.00'));
});

test('no session_id in payload — live cost not folded, logged periods still render', async () => {
  const { now } = boundaries();
  const state = mkState([logLineAt(5.0, now, 'ended')]);
  const i = baseInput(); // no session_id
  i.cost = { total_cost_usd: 2.0 };
  const plain = await run(i, env(state));
  assert.ok(plain.includes('s $2.00'), 'session cost from payload still shown');
  assert.ok(plain.includes('d $5.00'), 'logged period shown, live not double-folded');
  assert.ok(!plain.includes('d $7.00'), 'live cost not added without a session id');
});
