'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { baseInput, run } = require('./helpers.js');

test('normal cwd — basename shown', async () => {
  const i = baseInput();
  i.workspace.current_dir = '/home/user/projects/myapp';
  assert.ok((await run(i)).includes('myapp'));
});

test('cwd inside ~/.claude/worktrees — shows parent dir basename', async () => {
  const i = baseInput();
  i.workspace.current_dir = '/home/user/.claude/worktrees/foo-bar';
  i.worktree = { name: 'foo-bar' };
  const out = await run(i);
  // marker strips /.claude/worktrees/*, so parent is /home/user → basename "user"
  assert.ok(out.includes('user'));
});

test('cwd inside project/.claude/worktrees — shows project name', async () => {
  const i = baseInput();
  i.workspace.current_dir = '/home/user/projects/myapp/.claude/worktrees/reader';
  i.worktree = { name: 'reader' };
  const out = await run(i);
  assert.ok(out.includes('myapp'));
});
