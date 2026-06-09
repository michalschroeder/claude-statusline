'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { relativeTime, dayKey, dayLabel, clock, barFill, truncate } = require('../bin/sessions');

test('relativeTime: buckets', () => {
  const now = 1_000_000;
  assert.strictEqual(relativeTime(now, now), 'just now');
  assert.strictEqual(relativeTime(now, now + 50), 'just now'); // future clamps to 0
  assert.strictEqual(relativeTime(now, now - 30), 'just now');
  assert.strictEqual(relativeTime(now, now - 90), '1m ago');
  assert.strictEqual(relativeTime(now, now - 7200), '2h ago');
  assert.strictEqual(relativeTime(now, now - 2 * 86400), '2d ago');
});

test('barFill: clamps to [0,width]', () => {
  assert.strictEqual(barFill(0, 10, 8), 0);
  assert.strictEqual(barFill(5, 10, 8), 4);
  assert.strictEqual(barFill(10, 10, 8), 8);
  assert.strictEqual(barFill(20, 10, 8), 8); // over budget clamps
  assert.strictEqual(barFill(1, 0, 8), 0);   // no limit → 0
});

test('dayKey / dayLabel: same day groups, label shape', () => {
  const a = Math.floor(new Date(2026, 5, 9, 1, 0).getTime() / 1000);
  const b = Math.floor(new Date(2026, 5, 9, 23, 0).getTime() / 1000);
  const c = Math.floor(new Date(2026, 5, 8, 12, 0).getTime() / 1000);
  assert.strictEqual(dayKey(a), dayKey(b));
  assert.notStrictEqual(dayKey(a), dayKey(c));
  assert.match(dayLabel(a), /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{2}$/);
});

test('clock: zero-padded HH:MM', () => {
  const ts = Math.floor(new Date(2026, 5, 9, 3, 7).getTime() / 1000);
  assert.strictEqual(clock(ts), '03:07');
});

test('truncate: ellipsis at width', () => {
  assert.strictEqual(truncate('abcdef', 4), 'abc…');
  assert.strictEqual(truncate('ab', 5), 'ab');
  assert.strictEqual(truncate('abc', 0), '');
});
