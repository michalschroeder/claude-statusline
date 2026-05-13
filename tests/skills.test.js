'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { baseInput, run } = require('./helpers.js');

const SESSION = `test-${process.pid}`;
const LOG = `/tmp/claude-skills-${SESSION}.log`;

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

test('4+ unique skills — first 3 + overflow indicator', async () => {
  writeLog('1000 alpha\n1001 beta\n1002 gamma\n1003 delta\n');
  try {
    const i = baseInput();
    i.session_id = SESSION;
    const out = await run(i);
    assert.ok(out.includes('+1'));
    // only 3 shown
    assert.ok(!out.includes('alpha'));
  } finally { cleanup(); }
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
    // 2 unique: other (most recent), hookify
    assert.ok(out.includes('other'));
    assert.ok(out.includes('hookify'));
    assert.ok(!out.includes('+'));
  } finally { cleanup(); }
});
