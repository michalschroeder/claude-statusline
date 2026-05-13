'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { baseInput, run } = require('./helpers.js');

function mkTmpGit(branch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-wt-'));
  const gitDir = path.join(dir, '.git');
  fs.mkdirSync(gitDir);
  fs.writeFileSync(path.join(gitDir, 'HEAD'), `ref: refs/heads/${branch}\n`);
  return dir;
}

test('matching worktree branch — ⎇ hidden', async () => {
  const dir = mkTmpGit('worktree-reader-text-size');
  try {
    const i = baseInput();
    i.workspace.project_dir = dir;
    i.worktree = { name: 'reader-text-size' };
    assert.ok(!(await run(i)).includes('⎇'));
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('diverged branch — ⎇ shown', async () => {
  const dir = mkTmpGit('main');
  try {
    const i = baseInput();
    i.workspace.project_dir = dir;
    i.worktree = { name: 'reader-text-size' };
    assert.ok((await run(i)).includes('⎇ main'));
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('different worktree name — ⎇ shown', async () => {
  const dir = mkTmpGit('worktree-other-name');
  try {
    const i = baseInput();
    i.workspace.project_dir = dir;
    i.worktree = { name: 'reader-text-size' };
    assert.ok((await run(i)).includes('⎇ worktree-other-name'));
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('no worktree in input — ⎇ shown normally', async () => {
  const dir = mkTmpGit('feature/my-branch');
  try {
    const i = baseInput();
    i.workspace.project_dir = dir;
    assert.ok((await run(i)).includes('⎇ feature/my-branch'));
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});
