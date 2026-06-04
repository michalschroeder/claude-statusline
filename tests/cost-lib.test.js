'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveStateDir } = require('../lib/cost');

test('resolveStateDir: CLAUDE_CONFIG_DIR mangled into profile subdir', () => {
  const prev = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = '/tmp/xdg';
  try {
    assert.strictEqual(
      resolveStateDir('/home/u/.claude-x'),
      path.join('/tmp/xdg', 'claude-statusline', 'home_u_.claude-x')
    );
  } finally {
    if (prev === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = prev;
  }
});

test('resolveStateDir: undefined/empty source → flat layout (empty profile)', () => {
  const prev = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = '/tmp/xdg';
  try {
    assert.strictEqual(resolveStateDir(undefined), path.join('/tmp/xdg', 'claude-statusline', ''));
    assert.strictEqual(resolveStateDir(''), path.join('/tmp/xdg', 'claude-statusline', ''));
  } finally {
    if (prev === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = prev;
  }
});

test('resolveStateDir: no XDG_STATE_HOME → ~/.local/state', () => {
  const prev = process.env.XDG_STATE_HOME;
  delete process.env.XDG_STATE_HOME;
  try {
    assert.strictEqual(
      resolveStateDir('/a/b'),
      path.join(os.homedir(), '.local', 'state', 'claude-statusline', 'a_b')
    );
  } finally {
    if (prev !== undefined) process.env.XDG_STATE_HOME = prev;
  }
});
