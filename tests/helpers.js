'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const STATUSLINE = path.resolve(__dirname, '../hooks/statusline.js');

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

function baseInput() {
  return {
    model: { display_name: 'Claude' },
    workspace: { current_dir: '/tmp', project_dir: '/tmp' },
  };
}

function _invoke(inputObj, env) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...process.env, STATUSLINE_ICONS: 'nerd', ...(env || {}) };
    // The renderer now prefers CLAUDE_CONFIG_DIR over XDG_STATE_HOME for its state
    // root; tests isolate via XDG_STATE_HOME, so drop any inherited CLAUDE_CONFIG_DIR
    // unless a test sets it on purpose — else it would override the temp state dir.
    if (!(env && 'CLAUDE_CONFIG_DIR' in env)) delete childEnv.CLAUDE_CONFIG_DIR;
    const proc = spawn(process.execPath, [STATUSLINE], { env: childEnv });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('close', (code) => {
      if (code !== 0 && err) reject(new Error(err));
      else resolve(out);
    });
    proc.stdin.write(JSON.stringify(inputObj));
    proc.stdin.end();
  });
}

async function run(inputObj, env) {
  return stripAnsi(await _invoke(inputObj, env));
}

async function runRaw(inputObj, env) {
  return _invoke(inputObj, env);
}

const SESSIONS = path.resolve(__dirname, '../bin/sessions.js');

// Spawn bin/sessions.js with CLI args + env, resolve stripped-ANSI stdout. Mirrors
// _invoke's CLAUDE_CONFIG_DIR scrub so XDG_STATE_HOME isolation holds in tests.
function runSessions(args = [], env) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...process.env, STATUSLINE_ICONS: 'nerd', ...(env || {}) };
    if (!(env && 'CLAUDE_CONFIG_DIR' in env)) delete childEnv.CLAUDE_CONFIG_DIR;
    const proc = spawn(process.execPath, [SESSIONS, ...args], { env: childEnv });
    let out = '', err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('close', (code) => {
      if (code !== 0 && err) reject(new Error(err));
      else resolve(stripAnsi(out));
    });
  });
}

function mkTmpGit(headContent, prefix = 'csl-git-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const gitDir = path.join(dir, '.git');
  fs.mkdirSync(gitDir);
  fs.writeFileSync(path.join(gitDir, 'HEAD'), headContent);
  return dir;
}

module.exports = { stripAnsi, baseInput, run, runRaw, mkTmpGit, runSessions };
