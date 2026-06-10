'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveBudget } = require('../lib/budget');

test('unset → $1000 default, not opted out', () => {
  const b = resolveBudget(undefined);
  assert.equal(b.monthly, 1000);
  assert.equal(b.budgetOptedOut, false);
  assert.equal(b.daily, 1000 / 30);
  assert.equal(b.weekly, 1000 * 7 / 30);
});

test('explicit 0 → opted out', () => {
  const b = resolveBudget('0');
  assert.equal(b.budgetOptedOut, true);
});

test('positive number → that budget', () => {
  const b = resolveBudget('300');
  assert.equal(b.monthly, 300);
  assert.equal(b.budgetOptedOut, false);
});

test('garbage / negative → 1000 fallback', () => {
  assert.equal(resolveBudget('abc').monthly, 1000);
  assert.equal(resolveBudget('-5').monthly, 1000);
  assert.equal(resolveBudget('500abc').monthly, 1000);
});
