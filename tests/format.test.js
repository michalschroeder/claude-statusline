'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { formatCompact } = require('../lib/format');

test('formatCompact: raw below 1000 (rounded)', () => {
  assert.equal(formatCompact(0), '');
  assert.equal(formatCompact(1), '1');
  assert.equal(formatCompact(523), '523');
  assert.equal(formatCompact(950.4), '950');
  assert.equal(formatCompact(999), '999');
});

test('formatCompact: one-decimal k tier below 10k, strips .0', () => {
  assert.equal(formatCompact(1000), '1k');
  assert.equal(formatCompact(4500), '4.5k');
  assert.equal(formatCompact(9990), '10k'); // 9.99k rounds to 10.0 → "10k"
});

test('formatCompact: rounded k tier below 1M', () => {
  assert.equal(formatCompact(15000), '15k');
  assert.equal(formatCompact(999000), '999k');
});

test('formatCompact: M tier, strips .0', () => {
  assert.equal(formatCompact(1200000), '1.2M');
  assert.equal(formatCompact(4000000), '4M');
});

test('formatCompact: null/negative → empty', () => {
  assert.equal(formatCompact(null), '');
  assert.equal(formatCompact(undefined), '');
  assert.equal(formatCompact(-5), '');
});
