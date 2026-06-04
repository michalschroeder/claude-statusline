'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readTitleRecap } = require('../lib/transcript');

function mkJsonl(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-tr-'));
  const fp = path.join(dir, 's.jsonl');
  fs.writeFileSync(fp, lines.map((o) => (typeof o === 'string' ? o : JSON.stringify(o))).join('\n') + '\n');
  return fp;
}

test('readTitleRecap: takes LAST ai-title and LAST away_summary, strips disclaimer', () => {
  const fp = mkJsonl([
    { type: 'ai-title', aiTitle: 'First title' },
    { type: 'user', text: 'noise' },
    { type: 'system', subtype: 'away_summary', content: 'Old recap (disable recaps in /config)' },
    { type: 'ai-title', aiTitle: 'Final title' },
    { type: 'system', subtype: 'away_summary', content: 'Latest recap (disable recaps in /config)' },
  ]);
  assert.deepStrictEqual(readTitleRecap(fp), { title: 'Final title', recap: 'Latest recap' });
});

test('readTitleRecap: title only → recap null', () => {
  const fp = mkJsonl([{ type: 'ai-title', aiTitle: 'Only title' }]);
  assert.deepStrictEqual(readTitleRecap(fp), { title: 'Only title', recap: null });
});

test('readTitleRecap: recap only → title null', () => {
  const fp = mkJsonl([{ type: 'system', subtype: 'away_summary', content: 'A recap (disable recaps in /config)' }]);
  assert.deepStrictEqual(readTitleRecap(fp), { title: null, recap: 'A recap' });
});

test('readTitleRecap: neither → both null', () => {
  const fp = mkJsonl([{ type: 'user', text: 'hi' }]);
  assert.deepStrictEqual(readTitleRecap(fp), { title: null, recap: null });
});

test('readTitleRecap: tolerates unparseable lines', () => {
  const fp = mkJsonl([
    'not json at all',
    { type: 'ai-title', aiTitle: 'Survives' },
    '{ broken json',
  ]);
  assert.deepStrictEqual(readTitleRecap(fp), { title: 'Survives', recap: null });
});

test('readTitleRecap: recap without disclaimer left intact', () => {
  const fp = mkJsonl([{ type: 'system', subtype: 'away_summary', content: 'Bare recap' }]);
  assert.strictEqual(readTitleRecap(fp).recap, 'Bare recap');
});
