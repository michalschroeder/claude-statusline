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
// subdir, so distinct subscriptions keep separate skill logs. Unset → flat layout.
// Proven through the skills chip, which is the renderer's per-profile state reader.

const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

function mkXdg() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-xdg-'));
  tmpDirs.push(dir);
  return dir;
}
const sanitize = (cfg) => cfg.replace(/^\//, '').replace(/\//g, '_');
// Write a skills log under <xdg>/claude-statusline[/<profile>]/skills/<session>.log.
function seedSkillLog(xdg, profile, session, skill) {
  const dir = path.join(xdg, 'claude-statusline', profile, 'skills');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${session}.log`), `1000 ${skill}\n`);
}
const inp = () => ({ ...baseInput(), session_id: 'reader' });

test('never reads from inside CLAUDE_CONFIG_DIR; uses XDG namespace keyed by profile', async () => {
  const xdg = mkXdg();
  const cfg = '/home/u/.claude-work';
  // The booby trap: a skills log placed INSIDE the config dir must be ignored.
  const insideCfg = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-cfg-'));
  tmpDirs.push(insideCfg);
  fs.mkdirSync(path.join(insideCfg, 'state', 'claude-statusline', 'skills'), { recursive: true });
  fs.writeFileSync(path.join(insideCfg, 'state', 'claude-statusline', 'skills', 'reader.log'),
    '1000 trap-skill\n');
  // The real log lives under XDG, in the profile subdir derived from cfg.
  seedSkillLog(xdg, sanitize(cfg), 'reader', 'real-skill');
  const out = await run(inp(), { CLAUDE_CONFIG_DIR: cfg, XDG_STATE_HOME: xdg });
  assert.ok(out.includes('real-skill'), 'reads the XDG profile log');
  assert.ok(!out.includes('trap-skill'), 'never touches CLAUDE_CONFIG_DIR');
});

test('CLAUDE_CONFIG_DIR unset → flat layout (no profile subdir)', async () => {
  const xdg = mkXdg();
  seedSkillLog(xdg, '', 'reader', 'flat-skill'); // profile '' → <xdg>/claude-statusline/skills
  // helpers strips inherited CLAUDE_CONFIG_DIR unless the test sets it → unset here.
  const out = await run(inp(), { XDG_STATE_HOME: xdg });
  assert.ok(out.includes('flat-skill'), 'flat layout unchanged for single-profile users');
});

test('two CLAUDE_CONFIG_DIRs under one XDG keep separate logs', async () => {
  const xdg = mkXdg(); // shared XDG root — the split comes purely from the profile key
  const a = '/home/u/.claude-a';
  const b = '/home/u/.claude-b';
  seedSkillLog(xdg, sanitize(a), 'reader', 'skill-a');
  seedSkillLog(xdg, sanitize(b), 'reader', 'skill-b');
  const outA = await run(inp(), { XDG_STATE_HOME: xdg, CLAUDE_CONFIG_DIR: a });
  const outB = await run(inp(), { XDG_STATE_HOME: xdg, CLAUDE_CONFIG_DIR: b });
  assert.ok(outA.includes('skill-a') && !outA.includes('skill-b'), 'subscription A sees only its own');
  assert.ok(outB.includes('skill-b') && !outB.includes('skill-a'), 'subscription B sees only its own');
});
