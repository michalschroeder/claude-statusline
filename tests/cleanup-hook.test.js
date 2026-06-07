'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Integration tests for the SessionEnd hook (hooks/cleanup-skills-log.sh): it
// removes the ended session's skill log and prunes stale (>30d) skill logs from
// sessions that crashed without firing SessionEnd. The hook needs `jq` at runtime;
// skip the whole file gracefully when it's absent so the pure-node suite still
// runs on machines without jq.
const HOOK = path.resolve(__dirname, '../hooks/cleanup-skills-log.sh');
const hasJq = spawnSync('jq', ['--version']).status === 0;
const opts = { skip: hasJq ? false : 'jq not installed' };

const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

function mkState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-hook-'));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'claude-statusline', 'skills'), { recursive: true });
  return dir;
}
const csl = (dir, ...p) => path.join(dir, 'claude-statusline', ...p);
const nowTs = () => Math.floor(Date.now() / 1000);
const daysAgo = (n) => new Date(Date.now() - n * 86400 * 1000);

// Env for the spawned bash process: isolate via XDG_STATE_HOME and drop any
// inherited CLAUDE_CONFIG_DIR (which outranks XDG in the state-root resolution).
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

test('removes the session skill log', opts, () => {
  const dir = mkState();
  fs.writeFileSync(csl(dir, 'skills', 'sess-A.log'), `${nowTs()} some-skill\n`);
  runHook(dir, 'sess-A');
  assert.ok(!fs.existsSync(csl(dir, 'skills', 'sess-A.log')));
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

test('missing skill log — exits cleanly, no crash', opts, () => {
  const dir = mkState();
  const r = runHook(dir, 'sess-none'); // no skill log for this session
  assert.equal(r.status, 0);
});
