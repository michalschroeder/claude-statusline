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
