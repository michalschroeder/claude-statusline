'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { baseInput, run } = require('./helpers.js');

test('normal cwd — basename shown', async () => {
  const i = baseInput();
  i.workspace.current_dir = '/home/ms/projects/myapp';
  assert.ok((await run(i)).includes('myapp'));
});

test('cwd inside ~/.claude/worktrees — shows parent dir basename', async () => {
  const i = baseInput();
  i.workspace.current_dir = '/home/ms/.claude/worktrees/foo-bar';
  i.worktree = { name: 'foo-bar' };
  const out = await run(i);
  // marker strips /.claude/worktrees/*, so parent is /home/ms → basename "ms"
  assert.ok(out.includes('ms'));
});

test('cwd inside project/.claude/worktrees — shows project name', async () => {
  const i = baseInput();
  i.workspace.current_dir = '/home/ms/projects/myapp/.claude/worktrees/reader';
  i.worktree = { name: 'reader' };
  const out = await run(i);
  assert.ok(out.includes('myapp'));
});
