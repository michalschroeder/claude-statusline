'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { baseInput, run } = require('./helpers.js');

const SESSION = `test-${process.pid}`;
const STATE_DIR = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
const LOG_DIR = path.join(STATE_DIR, 'claude-statusline', 'skills');
const LOG = path.join(LOG_DIR, `${SESSION}.log`);
fs.mkdirSync(LOG_DIR, { recursive: true });

function writeLog(content) {
  fs.writeFileSync(LOG, content);
}

function cleanup() {
  try { fs.unlinkSync(LOG); } catch {}
}

test('no log file — skills chip absent', async () => {
  cleanup();
  const i = baseInput();
  i.session_id = SESSION;
  // no log file → no skill names in output
  const out = await run(i);
  assert.ok(!out.includes('hookify'));
  assert.ok(!out.includes('alpha'));
});

test('single skill entry', async () => {
  writeLog('1000 hookify\n');
  try {
    const i = baseInput();
    i.session_id = SESSION;
    assert.ok((await run(i)).includes('hookify'));
  } finally { cleanup(); }
});

test('3 unique skills — all shown most-recent-first', async () => {
  writeLog('1000 alpha\n1001 beta\n1002 gamma\n');
  try {
    const i = baseInput();
    i.session_id = SESSION;
    const out = await run(i);
    // most-recent-first after reversal: gamma,beta,alpha
    assert.ok(out.includes('gamma'));
    assert.ok(out.includes('beta'));
    assert.ok(out.includes('alpha'));
  } finally { cleanup(); }
});

test('4+ unique skills — only on line 2, no truncation', async () => {
  writeLog('1000 alpha\n1001 beta\n1002 gamma\n1003 delta\n');
  try {
    const i = baseInput();
    i.session_id = SESSION;
    const out = await run(i);
    const lines = out.split('\n');
    // 4 lines: segments, divider, skills, divider
    assert.equal(lines.length, 4);
    assert.ok(!lines[0].includes('alpha'));
    assert.ok(!lines[0].includes('+1'));
    assert.ok(lines[2].includes('loaded skills:'));
    assert.ok(lines[2].includes('alpha'));
    assert.ok(lines[2].includes('delta'));
    // dividers (line 1 and 3) are horizontal-rule glyphs
    assert.match(lines[1], /^─+$/);
    assert.match(lines[3], /^─+$/);
  } finally { cleanup(); }
});

test('no skills logged — single line, no dividers', async () => {
  cleanup();
  const i = baseInput();
  i.session_id = SESSION;
  const out = await run(i);
  assert.ok(!out.includes('\n'));
});

test('plugin:skill prefix stripped', async () => {
  writeLog('1000 hookify:my-skill\n');
  try {
    const i = baseInput();
    i.session_id = SESSION;
    const out = await run(i);
    assert.ok(out.includes('my-skill'));
    assert.ok(!out.includes('hookify:'));
  } finally { cleanup(); }
});

test('duplicate entries — deduplicated', async () => {
  writeLog('1000 hookify\n1001 hookify\n1002 other\n');
  try {
    const i = baseInput();
    i.session_id = SESSION;
    const out = await run(i);
    assert.ok(out.includes('other'));
    assert.ok(out.includes('hookify'));
    // no overflow indicator since 2 uniques and no truncation logic
    assert.ok(!out.includes('+1'));
  } finally { cleanup(); }
});
