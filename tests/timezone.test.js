'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveTimezone, ymd } = require('../lib/timezone');

test('resolveTimezone: valid IANA name passes through', () => {
  assert.equal(resolveTimezone({ STATUSLINE_TIMEZONE: 'Asia/Tokyo' }), 'Asia/Tokyo');
});

test('resolveTimezone: unset/empty → undefined (system-local)', () => {
  assert.equal(resolveTimezone({}), undefined);
  assert.equal(resolveTimezone({ STATUSLINE_TIMEZONE: '' }), undefined);
});

test('resolveTimezone: invalid name falls back to undefined (never throws)', () => {
  assert.equal(resolveTimezone({ STATUSLINE_TIMEZONE: 'Not/AZone' }), undefined);
});

test('ymd: same instant lands in different calendar days per tz', () => {
  // 02:30 UTC on the 11th: still the 10th in Los Angeles (-7), the 11th in Tokyo (+9).
  const t = new Date('2026-06-11T02:30:00Z');
  assert.deepEqual(ymd(t, 'America/Los_Angeles'), { y: 2026, m: 6, d: 10 });
  assert.deepEqual(ymd(t, 'Asia/Tokyo'), { y: 2026, m: 6, d: 11 });
});

test('ymd: falsy tz uses system-local fields', () => {
  const t = new Date('2026-06-11T02:30:00Z');
  assert.deepEqual(ymd(t, undefined), { y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate() });
});
