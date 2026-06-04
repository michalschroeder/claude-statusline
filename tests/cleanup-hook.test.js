'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Integration tests for the SessionEnd hook (hooks/cleanup-skills-log.sh): cost
// fold → cost.log, temp/skill-log cleanup, 45-day trim, >30d orphan prune. The
// hook needs `jq` at runtime; skip the whole file gracefully when it's absent so
// the pure-node suite still runs on machines without jq.
const HOOK = path.resolve(__dirname, '../hooks/cleanup-skills-log.sh');
const STATUSLINE = path.resolve(__dirname, '../hooks/statusline.js');
const hasJq = spawnSync('jq', ['--version']).status === 0;
const opts = { skip: hasJq ? false : 'jq not installed' };

const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

function mkState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-hook-'));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'claude-statusline', 'cost'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'claude-statusline', 'skills'), { recursive: true });
  return dir;
}
const csl = (dir, ...p) => path.join(dir, 'claude-statusline', ...p);
const nowTs = () => Math.floor(Date.now() / 1000);
const daysAgo = (n) => new Date(Date.now() - n * 86400 * 1000);

// Env for the spawned bash/node processes: isolate via XDG_STATE_HOME and drop any
// inherited CLAUDE_CONFIG_DIR (which now outranks XDG in the state-root resolution).
function isoEnv(stateDir, extra) {
  const e = { ...process.env, XDG_STATE_HOME: stateDir, ...(extra || {}) };
  delete e.CLAUDE_CONFIG_DIR;
  return e;
}

// Run the bash hook with a given session_id (omit the field entirely when null).
function runHook(stateDir, sessionId) {
  const payload = sessionId != null ? { session_id: sessionId } : {};
  return spawnSync('bash', [HOOK], {
    input: JSON.stringify(payload),
    env: isoEnv(stateDir),
    encoding: 'utf8',
  });
}

// Render the statusline against a state dir (to prove the hook's output parses back).
function render(stateDir, { session = 'reader', cost } = {}) {
  const payload = {
    session_id: session,
    model: { display_name: 'C' },
    workspace: { current_dir: '/tmp', project_dir: '/tmp' },
  };
  if (cost != null) payload.cost = { total_cost_usd: cost };
  const r = spawnSync(process.execPath, [STATUSLINE], {
    input: JSON.stringify(payload),
    env: isoEnv(stateDir, { STATUSLINE_ICONS: 'nerd', STATUSLINE_MONTHLY_BUDGET: '500' }),
    encoding: 'utf8',
  });
  return r.stdout.replace(/\x1b\[[0-9;]*m/g, '');
}

const readLog = (dir) => {
  try { return fs.readFileSync(csl(dir, 'cost.log'), 'utf8').trim().split('\n').filter(Boolean); }
  catch { return []; }
};

test('folds the session cost into cost.log (correct 4-field format) and round-trips through the renderer', opts, () => {
  const dir = mkState();
  fs.writeFileSync(csl(dir, 'cost', 'sess-A'), '2.50');
  const r = runHook(dir, 'sess-A');
  assert.equal(r.status, 0);

  const lines = readLog(dir);
  assert.equal(lines.length, 1);
  const parts = lines[0].split(' ');
  assert.equal(parts.length, 4, 'date ts session cost');
  assert.equal(parts[2], 'sess-A');
  assert.equal(parts[3], '2.50');
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(parts[0]), 'cosmetic ISO date column');
  assert.ok(Number(parts[1]) > 0, 'numeric ts column');

  // The renderer (a different reader session, no live cost) must parse the line
  // back and show today's daily total — proves the write/read format contract.
  const plain = render(dir, { session: 'other', cost: 0 });
  assert.ok(plain.includes('d $2.50'), 'logged cost round-trips into the daily chip');
});

test('deletes the cost temp file after folding', opts, () => {
  const dir = mkState();
  fs.writeFileSync(csl(dir, 'cost', 'sess-A'), '1.00');
  runHook(dir, 'sess-A');
  assert.ok(!fs.existsSync(csl(dir, 'cost', 'sess-A')));
});

test('does not fold a zero or empty cost', opts, () => {
  for (const val of ['0', '']) {
    const dir = mkState();
    fs.writeFileSync(csl(dir, 'cost', 'sess-Z'), val);
    runHook(dir, 'sess-Z');
    assert.equal(readLog(dir).length, 0, `cost="${val}" not folded`);
    assert.ok(!fs.existsSync(csl(dir, 'cost', 'sess-Z')), `cost="${val}" temp still removed`);
  }
});

test('removes the session skill log', opts, () => {
  const dir = mkState();
  fs.writeFileSync(csl(dir, 'skills', 'sess-A.log'), `${nowTs()} some-skill\n`);
  runHook(dir, 'sess-A');
  assert.ok(!fs.existsSync(csl(dir, 'skills', 'sess-A.log')));
});

test('trims cost.log entries older than ~45 days, keeps recent', opts, () => {
  const dir = mkState();
  const old = nowTs() - 50 * 86400;
  const recent = nowTs() - 1 * 86400;
  fs.writeFileSync(csl(dir, 'cost.log'),
    `2020-01-01 ${old} old-sess 9.99\n2026-01-01 ${recent} recent-sess 1.11\n`);
  const r = runHook(dir, null); // no session: fold skipped, trim still runs
  assert.equal(r.status, 0);
  const lines = readLog(dir);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('recent-sess'));
  assert.ok(!lines.join('\n').includes('old-sess'));
});

test('prunes orphaned cost temp files older than 30 days, keeps fresh', opts, () => {
  const dir = mkState();
  const orphan = csl(dir, 'cost', 'crashed-sess');
  const fresh = csl(dir, 'cost', 'live-sess');
  fs.writeFileSync(orphan, '3.00');
  fs.writeFileSync(fresh, '4.00');
  const t = daysAgo(31);
  fs.utimesSync(orphan, t, t);
  runHook(dir, null);
  assert.ok(!fs.existsSync(orphan), 'stale temp pruned');
  assert.ok(fs.existsSync(fresh), 'fresh temp kept');
});

test('prunes stale skill logs older than 30 days, keeps fresh', opts, () => {
  const dir = mkState();
  const stale = csl(dir, 'skills', 'old.log');
  const fresh = csl(dir, 'skills', 'new.log');
  fs.writeFileSync(stale, 'x\n');
  fs.writeFileSync(fresh, 'y\n');
  const t = daysAgo(31);
  fs.utimesSync(stale, t, t);
  runHook(dir, null);
  assert.ok(!fs.existsSync(stale), 'stale skill log pruned');
  assert.ok(fs.existsSync(fresh), 'fresh skill log kept');
});

test('no session_id in payload — exits cleanly, no crash', opts, () => {
  const dir = mkState();
  const r = runHook(dir, null);
  assert.equal(r.status, 0);
});

test('missing cost.log — exits cleanly, no crash', opts, () => {
  const dir = mkState(); // cost.log never created
  const r = runHook(dir, 'sess-none'); // no temp file either
  assert.equal(r.status, 0);
  assert.equal(readLog(dir).length, 0);
});

test('append-always: a second end for the same session adds a line (dedup happens on read)', opts, () => {
  const dir = mkState();
  // First end at $5, second (resumed) end at cumulative $8 → two lines, same id.
  fs.writeFileSync(csl(dir, 'cost', 'sess-R'), '5.00');
  runHook(dir, 'sess-R');
  fs.writeFileSync(csl(dir, 'cost', 'sess-R'), '8.00');
  runHook(dir, 'sess-R');
  const lines = readLog(dir);
  assert.equal(lines.length, 2, 'hook appends both ends');
  // Renderer dedups by session id, keeping the max ($8), not the sum ($13).
  const plain = render(dir, { session: 'other', cost: 0 });
  assert.ok(plain.includes('d $8.00'));
  assert.ok(!plain.includes('d $13.00'));
});
