'use strict';
// Smoke tests against representative Claude Code status payloads. Fixtures live in
// tests/fixtures/ — fabricated examples (not real captures) covering minimal,
// fully-populated, and panic-state cases. They pin the renderer's expectation of
// the payload shape; if Claude Code rearranges fields, these break loudly.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { stripAnsi, runRaw, mkTmpGit } = require('./helpers.js');

const PANIC_CODE = '\x1b[5;31m';
const FIX = path.join(__dirname, 'fixtures');
const load = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));

test('fixture: minimal payload renders model + dir, no crash', async () => {
  const out = stripAnsi(await runRaw(load('payload-minimal.json')));
  assert.match(out, /Sonnet 4.6/);
  assert.match(out, /widget/);
  assert.ok(out.length > 0);
});

test('fixture: full payload renders all expected segments', async () => {
  // Real on-disk git dir so getGitBranch actually fires — using a non-default
  // branch name ('feature/widget') that diverges from the worktree convention
  // ('worktree-context-bar-tiers') so the 󰘬 chip is forced to surface.
  const tmpDir = mkTmpGit('ref: refs/heads/feature/widget\n', 'csl-fixture-full-');
  const payload = load('payload-full.json');
  payload.workspace.current_dir = tmpDir;
  payload.workspace.project_dir = tmpDir;

  const raw = await runRaw(payload);
  const plain = stripAnsi(raw);
  // Each segment derived from a distinct payload field — if any disappears, the
  // segment-mapping has drifted.
  assert.match(plain, /Opus 4.7/, 'model');
  assert.match(plain, /high/, 'effort level');
  assert.match(plain, /concise/, 'output_style');
  assert.match(plain, /NORMAL/, 'vim mode');
  assert.match(plain, /feature-dev/, 'agent name');
  assert.match(plain, /context-bar-tiers/, 'worktree name');
  assert.match(plain, /󰘬 feature\/widget/, 'branch chip with diverged branch');
  assert.match(plain, new RegExp(`󰉋 ${path.basename(tmpDir)}`), 'dir basename');
  assert.match(plain, /\+1dir/, 'added_dirs count');
  assert.match(plain, /\$2\.47/, 'cost');
  assert.match(plain, /1h 2m/, 'duration formatting');
  assert.match(plain, /\+142/, 'lines added');
  assert.match(plain, /-31/, 'lines removed');
  assert.match(plain, /5h 42%/, 'rate limit 5h');
  assert.match(plain, /7d 18%/, 'rate limit 7d');
  assert.match(plain, /22%/, 'context label = raw used_percentage');
  assert.match(plain, /218k/, 'compact input tokens');
  // 1M tier inferred (218k / 0.22 ≈ 991k, within (800k, 1.2M)) → no panic.
  assert.ok(!raw.includes(PANIC_CODE), 'no panic for 1M @ 22%');
});

test('fixture: 200k panic payload triggers blink+skull', async () => {
  const raw = await runRaw(load('payload-200k-panic.json'));
  const plain = stripAnsi(raw);
  assert.ok(raw.includes(PANIC_CODE), 'expected blink-red panic ANSI');
  assert.match(plain, /󰚌/, 'expected skull glyph');
  assert.match(plain, /85%/, 'label still shows raw used_percentage in panic');
});
