'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { baseInput, run } = require('./helpers.js');

function mkTmpGit(headContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-git-'));
  const gitDir = path.join(dir, '.git');
  fs.mkdirSync(gitDir);
  fs.writeFileSync(path.join(gitDir, 'HEAD'), headContent);
  return dir;
}

test('no .git dir — branch absent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-nogit-'));
  try {
    const i = baseInput();
    i.workspace.project_dir = dir;
    assert.ok(!(await run(i)).includes('⎇'));
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('HEAD ref → ⎇ main', async () => {
  const dir = mkTmpGit('ref: refs/heads/main\n');
  try {
    const i = baseInput();
    i.workspace.project_dir = dir;
    assert.ok((await run(i)).includes('⎇ main'));
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('detached HEAD → ⎇ short hash', async () => {
  const hash = 'a'.repeat(40);
  const dir = mkTmpGit(hash + '\n');
  try {
    const i = baseInput();
    i.workspace.project_dir = dir;
    const out = await run(i);
    assert.ok(out.includes('⎇ aaaaaaa'));
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('worktree .git file indirection', async () => {
  // Create a bare-style real git dir with HEAD
  const realGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-realgit-'));
  fs.writeFileSync(path.join(realGitDir, 'HEAD'), 'ref: refs/heads/feat\n');

  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-wt-'));
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${realGitDir}\n`);
  try {
    const i = baseInput();
    i.workspace.project_dir = wt;
    assert.ok((await run(i)).includes('⎇ feat'));
  } finally {
    fs.rmSync(realGitDir, { recursive: true });
    fs.rmSync(wt, { recursive: true });
  }
});

test('branch > 50 chars — ellipsized', async () => {
  const longBranch = 'a'.repeat(31) + 'b'.repeat(30); // 61 chars
  const dir = mkTmpGit(`ref: refs/heads/${longBranch}\n`);
  try {
    const i = baseInput();
    i.workspace.project_dir = dir;
    const out = await run(i);
    assert.ok(out.includes('⎇'));
    assert.ok(out.includes('...'));
    // full branch name should NOT appear
    assert.ok(!out.includes(longBranch));
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});
