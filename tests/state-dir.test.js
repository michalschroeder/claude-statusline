'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, baseInput } = require('./helpers');

// State-dir resolution: data always lives under <XDG_STATE_HOME>/claude-statusline
// (never inside CLAUDE_CONFIG_DIR — Claude Code's managed dir). CLAUDE_CONFIG_DIR is
// only a per-subscription KEY: its sanitized path (slashes → _) becomes a profile
// subdir, so distinct subscriptions keep separate ledgers. Unset → flat layout.

const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

function mkXdg() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-xdg-'));
  tmpDirs.push(dir);
  return dir;
}
const sanitize = (cfg) => cfg.replace(/^\//, '').replace(/\//g, '_');
// Write a recent ($cost today) cost.log under <xdg>/claude-statusline[/<profile>].
function seedCostLog(xdg, profile, session, cost) {
  const dir = path.join(xdg, 'claude-statusline', profile);
  fs.mkdirSync(dir, { recursive: true });
  const ts = Math.floor(Date.now() / 1000);
  fs.writeFileSync(path.join(dir, 'cost.log'), `2026-01-01 ${ts} ${session} ${cost}\n`);
}
const inp = () => ({ ...baseInput(), session_id: 'reader' });
const BUDGET = { STATUSLINE_MONTHLY_BUDGET: '500' }; // daily limit ~$16.67

test('never reads from inside CLAUDE_CONFIG_DIR; uses XDG namespace keyed by profile', async () => {
  const xdg = mkXdg();
  const cfg = '/home/u/.claude-work';
  // The booby trap: a cost.log placed INSIDE the config dir must be ignored.
  const insideCfg = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-cfg-'));
  tmpDirs.push(insideCfg);
  fs.mkdirSync(path.join(insideCfg, 'state', 'claude-statusline'), { recursive: true });
  fs.writeFileSync(path.join(insideCfg, 'state', 'claude-statusline', 'cost.log'),
    `2026-01-01 ${Math.floor(Date.now() / 1000)} trap 9.00\n`);
  // The real ledger lives under XDG, in the profile subdir derived from cfg.
  seedCostLog(xdg, sanitize(cfg), 'sess-cfg', '3.00');
  const out = await run(inp(), { ...BUDGET, CLAUDE_CONFIG_DIR: cfg, XDG_STATE_HOME: xdg });
  assert.ok(out.includes('d $3.00'), 'reads the XDG profile ledger');
  assert.ok(!out.includes('d $9.00'), 'never touches CLAUDE_CONFIG_DIR');
});

test('CLAUDE_CONFIG_DIR unset → flat layout (no profile subdir)', async () => {
  const xdg = mkXdg();
  seedCostLog(xdg, '', 'sess-flat', '4.00'); // profile '' → <xdg>/claude-statusline/cost.log
  // helpers strips inherited CLAUDE_CONFIG_DIR unless the test sets it → unset here.
  const out = await run(inp(), { ...BUDGET, XDG_STATE_HOME: xdg });
  assert.ok(out.includes('d $4.00'), 'flat layout unchanged for single-profile users');
});

test('two CLAUDE_CONFIG_DIRs under one XDG keep separate ledgers', async () => {
  const xdg = mkXdg(); // shared XDG root — the split comes purely from the profile key
  const a = '/home/u/.claude-a';
  const b = '/home/u/.claude-b';
  seedCostLog(xdg, sanitize(a), 'sess-a', '2.00');
  seedCostLog(xdg, sanitize(b), 'sess-b', '7.00');
  const outA = await run(inp(), { ...BUDGET, XDG_STATE_HOME: xdg, CLAUDE_CONFIG_DIR: a });
  const outB = await run(inp(), { ...BUDGET, XDG_STATE_HOME: xdg, CLAUDE_CONFIG_DIR: b });
  assert.ok(outA.includes('d $2.00') && !outA.includes('d $7.00'), 'subscription A sees only its own');
  assert.ok(outB.includes('d $7.00') && !outB.includes('d $2.00'), 'subscription B sees only its own');
});
