'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { windowStarts, sumPeriods } = require('../lib/periods');

// Fixed "now": Wed 2026-06-10 12:00 local. Week (Mon-based) starts Mon 2026-06-08.
const NOW = new Date(2026, 5, 10, 12, 0, 0);

test('windowStarts: day/week(Mon)/month starts', () => {
  const w = windowStarts(NOW);
  assert.equal(w.dayStart, new Date(2026, 5, 10).getTime());
  assert.equal(w.weekStart, new Date(2026, 5, 8).getTime());
  assert.equal(w.monthStart, new Date(2026, 5, 1).getTime());
});

test('sumPeriods: buckets by day key against windows', () => {
  const perSession = {
    a: { days: { '2026-06-10': 1, '2026-06-09': 2, '2026-06-05': 4, '2026-05-30': 8 }, total: 15 },
  };
  const r = sumPeriods(perSession, NOW);
  assert.equal(r.daily, 1);          // only the 10th
  assert.equal(r.weekly, 1 + 2);     // 10th + 9th (≥ Mon 8th)
  assert.equal(r.monthly, 1 + 2 + 4); // June days; May 30 excluded
});

test('sumPeriods: excludes a session id', () => {
  const perSession = {
    a: { days: { '2026-06-10': 1 }, total: 1 },
    b: { days: { '2026-06-10': 100 }, total: 100 },
  };
  assert.equal(sumPeriods(perSession, NOW, 'b').daily, 1);
});

test('windowStarts: tz shifts the calendar day of the same instant', () => {
  // 02:30 UTC on the 11th: the 10th in LA (-7), the 11th in Tokyo (+9). The edge
  // ms is built system-local from that tz-calendar date, so assert against it.
  const now = new Date('2026-06-11T02:30:00Z');
  assert.equal(windowStarts(now, 'America/Los_Angeles').dayStart, new Date(2026, 5, 10).getTime());
  assert.equal(windowStarts(now, 'Asia/Tokyo').dayStart, new Date(2026, 5, 11).getTime());
});

test('sumPeriods: tz decides whether a boundary spend is still "this month"', () => {
  // Spend dated June 30; "now" is 02:30 UTC on July 1.
  const perSession = { a: { days: { '2026-06-30': 5 }, total: 5 } };
  const now = new Date('2026-07-01T02:30:00Z');
  // LA (-7): it is still June 30 → month starts June 1 → the spend counts.
  assert.equal(sumPeriods(perSession, now, undefined, 'America/Los_Angeles').monthly, 5);
  // Tokyo (+9): it is already July 1 → month starts July 1 → June 30 excluded.
  assert.equal(sumPeriods(perSession, now, undefined, 'Asia/Tokyo').monthly, 0);
});
