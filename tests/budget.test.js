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

test('explicit env beats monthly spend_limit.limit_usd, which beats the default', () => {
  const sl = (limit_usd, period = 'this month') => ({ limit_usd, period });
  assert.equal(resolveBudget('300', sl(500)).monthly, 300);
  assert.equal(resolveBudget(undefined, sl(500)).monthly, 500);
  assert.equal(resolveBudget('abc', sl(500)).monthly, 500);
  assert.equal(resolveBudget('300', undefined).monthly, 300);
  assert.equal(resolveBudget('300', sl(0)).monthly, 300);
});

test('non-monthly spend_limit period is ignored', () => {
  assert.equal(resolveBudget(undefined, { limit_usd: 500, period: 'this week' }).monthly, 1000);
  assert.equal(resolveBudget(undefined, { limit_usd: 500 }).monthly, 1000);
  assert.equal(resolveBudget(undefined, { limit_usd: 500, period: 'every 3 months' }).monthly, 1000);
});

test('monthly period variants accepted', () => {
  for (const period of ['this month', 'Monthly', 'per month', 'month']) {
    assert.equal(resolveBudget(undefined, { limit_usd: 500, period }).monthly, 500, period);
  }
});

test('non-numeric limit_usd is ignored', () => {
  assert.equal(resolveBudget(undefined, { limit_usd: '500', period: 'this month' }).monthly, 1000);
});

test('spend_limit does not cancel the env 0 opt-out', () => {
  assert.equal(resolveBudget('0', { limit_usd: 500, period: 'this month' }).budgetOptedOut, true);
});

// --- STATUSLINE_COST_MULTIPLIER: display-time calibration to a plan's meter ---
const { resolveCostMultiplier } = require('../lib/budget');

test('cost multiplier: unset/empty/whitespace → 1 (no-op)', () => {
  for (const v of [undefined, null, '', '   ']) assert.equal(resolveCostMultiplier(v), 1, `${JSON.stringify(v)}`);
});

test('cost multiplier: positive number → that factor', () => {
  assert.equal(resolveCostMultiplier('1.15'), 1.15);
  assert.equal(resolveCostMultiplier(2), 2);
});

test('cost multiplier: 0, negative and non-numeric fall back to 1', () => {
  // 0 is rejected rather than honoured — a zeroed chip conveys nothing.
  for (const v of ['0', '-1', 'abc', '1.15x', '$1.15', NaN, Infinity]) {
    assert.equal(resolveCostMultiplier(v), 1, `${String(v)}`);
  }
});
