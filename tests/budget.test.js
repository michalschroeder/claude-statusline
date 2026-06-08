'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveBudget } = require('../lib/budget');

test('unset → $500 default, not opted out', () => {
  const b = resolveBudget(undefined);
  assert.equal(b.monthly, 500);
  assert.equal(b.budgetOptedOut, false);
  assert.equal(b.daily, 500 / 30);
  assert.equal(b.weekly, 500 * 7 / 30);
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

test('garbage / negative → 500 fallback', () => {
  assert.equal(resolveBudget('abc').monthly, 500);
  assert.equal(resolveBudget('-5').monthly, 500);
  assert.equal(resolveBudget('500abc').monthly, 500);
});
