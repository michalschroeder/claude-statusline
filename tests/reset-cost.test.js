'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RESET = path.resolve(__dirname, '../bin/reset-cost.js');

const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

function mkXdg() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-reset-'));
  tmpDirs.push(dir);
  return dir;
}
// Run reset-cost.js with XDG isolation; drop inherited CLAUDE_CONFIG_DIR unless set.
function run(args, env) {
  const e = { ...process.env, ...(env || {}) };
  if (!(env && 'CLAUDE_CONFIG_DIR' in env)) delete e.CLAUDE_CONFIG_DIR;
  return spawnSync(process.execPath, [RESET, ...args], { env: e, encoding: 'utf8' });
}
const flat = (xdg) => path.join(xdg, 'claude-statusline', 'cost.log');
const read = (p) => fs.readFileSync(p, 'utf8');

test('wipes existing cost.log and writes a single month-start line', () => {
  const xdg = mkXdg();
  fs.mkdirSync(path.dirname(flat(xdg)), { recursive: true });
  fs.writeFileSync(flat(xdg), '2026-06-05 1780610769 sess-a 5.00\n2026-06-05 1780611070 sess-b 3.00\n');
  const r = run(['142.50', '--month', '2026-06'], { XDG_STATE_HOME: xdg });
  assert.equal(r.status, 0);
  const lines = read(flat(xdg)).trim().split('\n');
  assert.equal(lines.length, 1, 'old lines wiped, one synthetic line remains');
  const parts = lines[0].split(' ');
  assert.equal(parts[0], '2026-06-01');
  assert.equal(parts[2], 'reset-2026-06');
  assert.equal(parts[3], '142.5');
  // ts column is the 1st of the month at local midnight.
  assert.equal(parseInt(parts[1], 10), Math.floor(new Date(2026, 5, 1).getTime() / 1000));
});

test('backs up the previous ledger to cost.log.bak', () => {
  const xdg = mkXdg();
  fs.mkdirSync(path.dirname(flat(xdg)), { recursive: true });
  fs.writeFileSync(flat(xdg), 'OLD CONTENT\n');
  run(['10', '--month', '2026-06'], { XDG_STATE_HOME: xdg });
  assert.equal(read(flat(xdg) + '.bak'), 'OLD CONTENT\n');
});

test('amount 0 clears the ledger to an empty file', () => {
  const xdg = mkXdg();
  fs.mkdirSync(path.dirname(flat(xdg)), { recursive: true });
  fs.writeFileSync(flat(xdg), 'x 1 y 1\n');
  const r = run(['0'], { XDG_STATE_HOME: xdg });
  assert.equal(r.status, 0);
  assert.equal(read(flat(xdg)), '');
});

test('creates the state dir when no cost.log exists yet', () => {
  const xdg = mkXdg(); // nothing created
  const r = run(['7.25', '--month', '2026-06'], { XDG_STATE_HOME: xdg });
  assert.equal(r.status, 0);
  assert.ok(read(flat(xdg)).includes('reset-2026-06 7.25'));
  assert.ok(!fs.existsSync(flat(xdg) + '.bak'), 'no backup when there was nothing to back up');
});

test('--config-dir routes to the per-profile state dir', () => {
  const xdg = mkXdg();
  const cfg = '/home/u/.claude-work';
  const profile = cfg.replace(/^\//, '').replace(/\//g, '_');
  run(['50', '--month', '2026-06', '--config-dir', cfg], { XDG_STATE_HOME: xdg });
  const p = path.join(xdg, 'claude-statusline', profile, 'cost.log');
  assert.ok(fs.existsSync(p), 'wrote under the sanitized profile subdir');
  assert.ok(read(p).includes('reset-2026-06 50'));
});

for (const bad of ['-5', 'abc', '']) {
  test(`rejects invalid amount ${JSON.stringify(bad)}`, () => {
    const xdg = mkXdg();
    const r = run([bad], { XDG_STATE_HOME: xdg });
    assert.notEqual(r.status, 0);
  });
}

test('rejects a malformed --month', () => {
  const xdg = mkXdg();
  const r = run(['10', '--month', '2026-13'], { XDG_STATE_HOME: xdg });
  assert.notEqual(r.status, 0);
});
