'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { green, yellow, orange, red, colorByTier, COST_TIERS } = require('../lib/color');

test('colorByTier: absolute [1,5,10] ladder picks tier by upper bound', () => {
  assert.strictEqual(colorByTier(0.99, [1, 5, 10]), green);
  assert.strictEqual(colorByTier(1, [1, 5, 10]), yellow);   // at threshold → next tier
  assert.strictEqual(colorByTier(4.99, [1, 5, 10]), yellow);
  assert.strictEqual(colorByTier(5, [1, 5, 10]), orange);
  assert.strictEqual(colorByTier(9.99, [1, 5, 10]), orange);
  assert.strictEqual(colorByTier(10, [1, 5, 10]), red);
  assert.strictEqual(colorByTier(100, [1, 5, 10]), red);
});

test('colorByTier: ratio [0.5,0.75,0.9] ladder', () => {
  assert.strictEqual(colorByTier(0.49, [0.5, 0.75, 0.9]), green);
  assert.strictEqual(colorByTier(0.5, [0.5, 0.75, 0.9]), yellow);
  assert.strictEqual(colorByTier(0.75, [0.5, 0.75, 0.9]), orange);
  assert.strictEqual(colorByTier(0.9, [0.5, 0.75, 0.9]), red);
  assert.strictEqual(colorByTier(2.0, [0.5, 0.75, 0.9]), red);
});

test('color helpers wrap with the expected ANSI codes', () => {
  assert.strictEqual(green('x'), '\x1b[32mx\x1b[0m');
  assert.strictEqual(red('x'), '\x1b[31mx\x1b[0m');
  assert.strictEqual(orange('x'), '\x1b[38;5;208mx\x1b[0m');
  assert.strictEqual(COST_TIERS.length, 4);
  assert.strictEqual(COST_TIERS[0], green);
  assert.strictEqual(COST_TIERS[3], red);
});
