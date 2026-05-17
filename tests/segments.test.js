'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const path = require('path');
const { baseInput } = require('./helpers');

const STATUSLINE = path.resolve(__dirname, '../hooks/statusline.js');

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

function runWithEnv(inputObj, env) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [STATUSLINE], {
      env: { ...process.env, ...env },
    });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('close', (code) => {
      if (code !== 0 && err) reject(new Error(err));
      else resolve(stripAnsi(out));
    });
    proc.stdin.write(JSON.stringify(inputObj));
    proc.stdin.end();
  });
}

// A rich input that exercises many segments at once.
function richInput() {
  return {
    model: { display_name: 'Claude' },
    workspace: { current_dir: '/tmp', project_dir: '/tmp' },
    cost: {
      total_cost_usd: 0.5,
      total_duration_ms: 65000,
      total_lines_added: 10,
      total_lines_removed: 5,
    },
    context_window: {
      total_input_tokens: 1500,
      total_output_tokens: 800,
      remaining_percentage: 70,
    },
  };
}

test('unset STATUSLINE_SEGMENTS renders all available segments', async () => {
  // Strip any inherited value so the test reflects unset behaviour.
  const env = { ...process.env };
  delete env.STATUSLINE_SEGMENTS;
  const out = await runWithEnv(richInput(), { STATUSLINE_SEGMENTS: '' });
  assert.match(out, /Claude/);
  assert.match(out, /\$0\.50/);
  assert.match(out, /1\.5k/);
  assert.match(out, /1m/);
  assert.match(out, /30%/); // context bar
});

test('STATUSLINE_SEGMENTS=model renders only the model segment', async () => {
  const out = await runWithEnv(richInput(), { STATUSLINE_SEGMENTS: 'model' });
  assert.match(out, /Claude/);
  assert.doesNotMatch(out, /\$0\.50/);
  assert.doesNotMatch(out, /1\.5k/);
  assert.doesNotMatch(out, /30%/);
  assert.doesNotMatch(out, /│/);
});

test('STATUSLINE_SEGMENTS controls order', async () => {
  const out = await runWithEnv(richInput(), {
    STATUSLINE_SEGMENTS: 'cost,model',
  });
  const costIdx = out.indexOf('$0.50');
  const modelIdx = out.indexOf('Claude');
  assert.ok(costIdx >= 0 && modelIdx >= 0);
  assert.ok(costIdx < modelIdx, `expected cost before model, got: ${out}`);
});

test('STATUSLINE_SEGMENTS ignores unknown names', async () => {
  const out = await runWithEnv(richInput(), {
    STATUSLINE_SEGMENTS: 'nope,model,bogus',
  });
  assert.match(out, /Claude/);
  assert.doesNotMatch(out, /nope/);
  assert.doesNotMatch(out, /bogus/);
});

test('STATUSLINE_SEGMENTS tolerates whitespace and empty entries', async () => {
  const out = await runWithEnv(richInput(), {
    STATUSLINE_SEGMENTS: ' model , , cost ',
  });
  assert.match(out, /Claude/);
  assert.match(out, /\$0\.50/);
});

test('absent segments stay absent under filter', async () => {
  const input = baseInput(); // no cost
  const out = await runWithEnv(input, {
    STATUSLINE_SEGMENTS: 'model,cost',
  });
  assert.match(out, /Claude/);
  assert.doesNotMatch(out, /\$/);
});
