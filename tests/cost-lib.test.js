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

const { readCostRows } = require('../lib/cost');

function mkState(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-cost-'));
  if (lines != null) fs.writeFileSync(path.join(dir, 'cost.log'), lines);
  return dir;
}

test('readCostRows: dedup by id keeps the largest cumulative cost', () => {
  const dir = mkState(
    '2026-06-05 1000 sessA 0.50\n' +
    '2026-06-05 1100 sessA 1.20\n' +   // resume → larger, wins
    '2026-06-05 1000 sessB 0.30\n'
  );
  const rows = readCostRows(dir);
  assert.strictEqual(rows.get('sessA').cost, 1.20);
  assert.strictEqual(rows.get('sessA').ts, 1100);
  assert.strictEqual(rows.get('sessB').cost, 0.30);
  assert.strictEqual(rows.size, 2);
});

test('readCostRows: skips malformed / non-positive / short rows', () => {
  const dir = mkState(
    'too few fields\n' +
    '2026-06-05 notanum sessC 0.10\n' +    // NaN ts
    '2026-06-05 1000 sessD notanum\n' +    // NaN cost
    '2026-06-05 1000 sessE -5\n' +         // negative
    '2026-06-05 1000 sessF 0\n' +          // zero
    '2026-06-05 1000  0.40\n' +            // empty id (double space → parts[2]='')
    '2026-06-05 1000 sessG 0.40\n'         // the only valid row
  );
  const rows = readCostRows(dir);
  assert.deepStrictEqual([...rows.keys()], ['sessG']);
});

test('readCostRows: missing cost.log → empty map', () => {
  const dir = mkState(null);
  assert.strictEqual(readCostRows(dir).size, 0);
});
