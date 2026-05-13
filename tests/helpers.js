'use strict';
const { spawn } = require('child_process');
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

function _invoke(inputObj) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [STATUSLINE]);
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

async function run(inputObj) {
  return stripAnsi(await _invoke(inputObj));
}

async function runRaw(inputObj) {
  return _invoke(inputObj);
}

module.exports = { stripAnsi, baseInput, run, runRaw };
