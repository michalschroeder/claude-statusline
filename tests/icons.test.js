'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, baseInput, mkTmpGit } = require('./helpers');

function inp() {
  const i = baseInput();
  i.effort = { level: 'high' };
  i.cost = { total_duration_ms: 45000, total_lines_added: 3, total_lines_removed: 1 };
  // 90% used with no token info → panic path → exercises skull glyph in each icon mode.
  i.context_window = { used_percentage: 90 };
  i.rate_limits = { five_hour: { used_percentage: 50 }, seven_day: { used_percentage: 20 } };
  return i;
}

test('nerd mode keeps Nerd Font glyphs', async () => {
  const out = await run(inp(), { STATUSLINE_ICONS: 'nerd' });
  assert.ok(out.includes('󰾅'));      // effort
  assert.ok(out.includes('󰉋'));      // dir
  assert.ok(out.includes('󰷈'));      // lines
  assert.ok(out.includes('󰔚 5h'));   // rate5h
  assert.ok(out.includes('󰃭 7d'));   // rate7d
  assert.ok(out.includes('┊'));      // separator
  assert.ok(out.includes('󰚌'));      // skull (90% used → panic path)
});

test('unicode mode swaps Nerd glyphs for BMP fallbacks', async () => {
  const out = await run(inp(), { STATUSLINE_ICONS: 'unicode' });
  assert.ok(!out.includes('󰾅'));
  assert.ok(!out.includes('󰉋'));
  assert.ok(!out.includes('󰷈'));
  assert.ok(!out.includes('󰚌'));     // nerd skull must be absent
  assert.ok(out.includes('⚡'));      // effort
  assert.ok(out.includes('▸'));      // dir
  assert.ok(out.includes('Δ'));      // lines
  assert.ok(out.includes('⏱'));      // duration retained (BMP)
  assert.ok(out.includes('‼'));      // BMP skull (panic path)
});

test('ascii mode uses pure ASCII', async () => {
  const out = await run(inp(), { STATUSLINE_ICONS: 'ascii' });
  // No Nerd Font glyphs
  assert.ok(!out.includes('󰾅'));
  assert.ok(!out.includes('󰉋'));
  assert.ok(!out.includes('󰷈'));
  assert.ok(!out.includes('󰚌'));     // nerd skull must be absent
  // No emoji / BMP icons
  assert.ok(!out.includes('⚡'));
  assert.ok(!out.includes('⏱'));
  assert.ok(!out.includes('▸'));
  assert.ok(!out.includes('‼'));     // BMP skull must be absent
  // ASCII labels present
  assert.ok(out.includes('dir:'));
  assert.ok(out.includes('t: 45s'));
  assert.ok(out.includes('|'));      // ascii separator
  assert.ok(out.includes('!!'));     // ASCII skull (panic path)
  // Whole string should be ASCII-safe
  assert.ok(/^[\x00-\x7F\s]+$/.test(out), `non-ASCII char in ascii mode: ${JSON.stringify(out)}`);
});

// ─── Per-mode glyph parity ───────────────────────────────────────────────────
// One payload that fires every icon slot in ICON_SETS, so we catch any glyph
// that silently disappears in a future refactor. Keeps each mode honest.

function richInput(stateDir, projectDir, session) {
  // Pre-seed the skills log so the renderer emits the skills chip + hr rules.
  const skillsDir = path.join(stateDir, 'claude-statusline', 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.writeFileSync(path.join(skillsDir, `${session}.log`), `${Date.now()} alpha\n${Date.now()} beta\n`);

  const i = baseInput();
  i.workspace = { current_dir: projectDir, project_dir: projectDir };
  i.session_id = session;
  i.effort = { level: 'high' };
  i.output_style = { name: 'concise' };
  i.vim = { mode: 'NORMAL' };
  i.agent = { name: 'feature-dev' };
  i.worktree = { name: 'wt-foo' };
  i.cost = { total_duration_ms: 45000, total_lines_added: 3, total_lines_removed: 1 };
  // 1M tier, no panic — exercises barFill (per-cell ramp) + barEmpty + rsep (token suffix).
  i.context_window = { used_percentage: 22, total_input_tokens: 218000 };
  i.rate_limits = { five_hour: { used_percentage: 50 }, seven_day: { used_percentage: 20 } };
  return i;
}

// Per-segment shape patterns anchor each glyph to its rendered context — a loose
// `out.includes(glyph)` would false-pass when a glyph is also a common char
// elsewhere in the output (notably ascii '-' which collides between barEmpty,
// hr, the lines '-1', the tmp dir basename, etc.).
//
// richInput renders: 4 filled + 6 empty cells (1M @ 22%), hr rule ≥20 chars,
// branch `main`, worktree `wt-foo`, duration `45s`, rate limits `50%`/`20%`,
// style `concise`, vim `NORMAL`, agent `feature-dev`.
const PARITY_CASES = [
  { mode: 'nerd', patterns: {
      bar:        /█{4}░{6} 22%/,
      hr:         /─{20,}/,
      branch:     /󰘬 main/,
      worktree:   /󰘯 wt-foo/,
      duration:   /󰔛 45s/,
      rateLimits: /󰔚 5h 50% · 󰃭 7d 20%/,
      style:      /󰏘 concise/,
      vim:        / NORMAL/,
      agent:      /󰚩 feature-dev/,
      skills:     / loaded skills:/,
      sep:        /┊/,
    } },
  { mode: 'unicode', patterns: {
      bar:        /█{4}░{6} 22%/,
      hr:         /─{20,}/,
      branch:     /⎇ main/,
      worktree:   /⊕ wt-foo/,
      duration:   /⏱ 45s/,
      rateLimits: /5h 50% · 7d 20%/,
      style:      /❖ concise/,
      vim:        /V NORMAL/,
      agent:      /◉ feature-dev/,
      skills:     /✦ loaded skills:/,
      sep:        /┊/,
    } },
  { mode: 'ascii', patterns: {
      bar:        /#{4}-{6} 22%/,
      hr:         /-{20,}/,
      branch:     /git: main/,
      worktree:   /wt: wt-foo/,
      duration:   /t: 45s/,
      rateLimits: /5h 50% , 7d 20%/,
      style:      /S concise/,
      vim:        /V NORMAL/,
      agent:      /@ feature-dev/,
      skills:     /\* loaded skills:/,
      sep:        /\|/,
    } },
];

for (const { mode, patterns } of PARITY_CASES) {
  test(`${mode} mode: every ICON_SETS glyph renders in its segment`, async () => {
    const projectDir = mkTmpGit('ref: refs/heads/main\n', `csl-icons-${mode}-`);
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), `csl-state-${mode}-`));
    const session = `parity-${mode}`;
    const out = await run(
      richInput(stateDir, projectDir, session),
      { STATUSLINE_ICONS: mode, XDG_STATE_HOME: stateDir, COLUMNS: '80' },
    );
    for (const [name, re] of Object.entries(patterns)) {
      assert.match(out, re, `${mode}/${name}: expected ${re} in ${JSON.stringify(out)}`);
    }
  });
}

test('invalid STATUSLINE_ICONS falls through to cache/default', async () => {
  // Should not crash — falls to cached or first-run ascii.
  const out = await run(baseInput(), { STATUSLINE_ICONS: 'bogus' });
  assert.ok(out.length > 0);
});
