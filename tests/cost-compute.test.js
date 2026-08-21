'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractCacheCreation, calculateCost, calculateCostBreakdown } = require('../lib/cost-compute');

const COSTS = { input: 10, output: 20, cacheWrite: 4, cacheRead: 1, webSearch: 0.01 };

// Model with a long-context (>200K) premium tier.
const BIG = {
  input: 10, output: 20, cacheWrite: 4, cacheRead: 1, webSearch: 0.01,
  above200k: { input: 20, output: 40, cacheWrite: 8, cacheRead: 2 },
};

test('calculateCost: each category below 200K bills flat at base', () => {
  // No single category exceeds 200K, so the premium tier stays dormant per-category.
  const usage = { input_tokens: 100000, cache_read_input_tokens: 50000, output_tokens: 1 };
  // 100000*10 + 50000*1 + 1*20 = 1,000,000 + 50,000 + 20
  assert.equal(calculateCost(usage, BIG), 1050020);
});

test('calculateCost: a category over 200K bills marginally at the premium rate', () => {
  const usage = { input_tokens: 250000, output_tokens: 1 };
  // input: first 200000 @10 + excess 50000 @20 = 2,000,000 + 1,000,000; output 1 @20 (below)
  assert.equal(calculateCost(usage, BIG), 200000 * 10 + 50000 * 20 + 20);
});

test('calculateCost: tiering is per-category — only the over-200K category is premium', () => {
  // input stays flat (≤200K); cache-read alone exceeds 200K and tiers marginally.
  const usage = { input_tokens: 100000, cache_read_input_tokens: 300000 };
  // input 100000*10 = 1,000,000; cacheRead 200000*1 + 100000*2 = 200,000 + 200,000
  assert.equal(calculateCost(usage, BIG), 1000000 + (200000 * 1 + 100000 * 2));
});

test('calculateCost: no above200k tier → base rates even when huge', () => {
  const usage = { input_tokens: 500000 };
  assert.equal(calculateCost(usage, COSTS), 500000 * 10);
});

test('extractCacheCreation: split form preferred, 1h clamped to total', () => {
  const r = extractCacheCreation({ cache_creation: { ephemeral_5m_input_tokens: 2000, ephemeral_1h_input_tokens: 345 } });
  assert.deepEqual(r, { fiveMinute: 2000, oneHour: 345 });
});

test('extractCacheCreation: legacy total when no split', () => {
  const r = extractCacheCreation({ cache_creation_input_tokens: 500 });
  assert.deepEqual(r, { fiveMinute: 500, oneHour: 0 });
});

test('extractCacheCreation: keeps larger of legacy vs split', () => {
  const r = extractCacheCreation({ cache_creation_input_tokens: 1000, cache_creation: { ephemeral_1h_input_tokens: 300 } });
  // split=300, legacy=1000 → total=1000, oneHour=min(300,1000)=300, five=700
  assert.deepEqual(r, { fiveMinute: 700, oneHour: 300 });
});

test('calculateCost: full formula with 1h cache write @ input×2.0', () => {
  const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 1,
    cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 1 },
    server_tool_use: { web_search_requests: 1 } };
  // input 10 + output 20 + 5m(1*4) + 1h(1*input*2 = 20) + cacheRead 1 + web 0.01 = 55.01
  assert.equal(calculateCost(usage, COSTS), 55.01);
});

test('calculateCost: 1h cache write derives from input×2.0, not cacheWrite×1.6', () => {
  // COSTS.cacheWrite (4) ≠ input×1.25 (12.5): the two derivations diverge here, so
  // this pins the input×2.0 rule. 1h token alone: 1 * (input 10 * 2) = 20.
  const usage = { input_tokens: 0, output_tokens: 0,
    cache_creation: { ephemeral_1h_input_tokens: 1 } };
  assert.equal(calculateCost(usage, COSTS), 20);
});

test('calculateCost: fast mode scales the whole call by fastMultiplier', () => {
  const usage = { input_tokens: 1, output_tokens: 1, server_tool_use: { web_search_requests: 1 } };
  const std = calculateCost({ ...usage, speed: 'standard' }, { ...COSTS, fastMultiplier: 2 });
  const fast = calculateCost({ ...usage, speed: 'fast' }, { ...COSTS, fastMultiplier: 2 });
  assert.equal(std, 10 + 20 + 0.01);       // standard: multiplier not applied
  assert.equal(fast, (10 + 20 + 0.01) * 2); // fast: entire call (incl. web) ×2
});

test('calculateCost: missing fastMultiplier treated as 1 even when fast', () => {
  const usage = { input_tokens: 1, output_tokens: 1, speed: 'fast' };
  assert.equal(calculateCost(usage, COSTS), 10 + 20); // no fastMultiplier → ×1
});

test('calculateCost: null costs → 0', () => {
  assert.equal(calculateCost({ input_tokens: 1000 }, null), 0);
});

test('calculateCost: clamps negative/NaN tokens to 0', () => {
  assert.equal(calculateCost({ input_tokens: -5, output_tokens: NaN }, COSTS), 0);
});

test('calculateCostBreakdown: components priced and sum to total', () => {
  // COSTS = { input:10, output:20, cacheWrite:4, cacheRead:1, webSearch:0.01 }
  const usage = {
    input_tokens: 1000,
    output_tokens: 500,
    cache_read_input_tokens: 2000,
    cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 50 },
    server_tool_use: { web_search_requests: 3 },
  };
  const b = calculateCostBreakdown(usage, COSTS);
  assert.equal(b.input, 1000 * 10);                       // 10000
  assert.equal(b.output, 500 * 20);                       // 10000
  assert.equal(b.cacheRead, 2000 * 1);                    // 2000
  assert.equal(b.cacheWrite, 100 * 4 + 50 * (10 * 2));    // 5m 400 + 1h 1000 = 1400
  assert.equal(b.web, 3 * 0.01);                          // 0.03
  assert.equal(b.total, b.input + b.output + b.cacheRead + b.cacheWrite + b.web);
  assert.equal(b.total, calculateCost(usage, COSTS));     // single source of truth
});

test('calculateCostBreakdown: above-200K tier is marginal, per component', () => {
  const usage = { input_tokens: 250000, cache_read_input_tokens: 300000, output_tokens: 1 };
  const b = calculateCostBreakdown(usage, BIG);
  assert.equal(b.input, 200000 * 10 + 50000 * 20);   // 3,000,000
  assert.equal(b.cacheRead, 200000 * 1 + 100000 * 2); // 400,000
  assert.equal(b.output, 1 * 20);                     // below threshold → base rate
  assert.equal(b.total, calculateCost(usage, BIG));
});

test('calculateCostBreakdown: null costs/usage → all zeros', () => {
  const z = calculateCostBreakdown(null, null);
  assert.deepEqual(z, { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, web: 0, total: 0 });
});

// --- US-only inference premium (data-residency workspaces) ---
test('inference_geo "us" bills the whole call at 1.1x', () => {
  const costs = { input: 1e-6, output: 2e-6, cacheWrite: 1.25e-6, cacheRead: 1e-7, webSearch: 0.01 };
  const usage = { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000,
    cache_creation_input_tokens: 400, server_tool_use: { web_search_requests: 1 } };
  const base = calculateCost(usage, costs);
  const us = calculateCost({ ...usage, inference_geo: 'us' }, costs);
  assert.ok(Math.abs(us - base * 1.1) < 1e-12, 'flat 1.1x over every component');
});

test('inference_geo "global" / "not_available" / absent are unpriced', () => {
  const costs = { input: 1e-6, output: 0, cacheWrite: 0, cacheRead: 0, webSearch: 0 };
  const usage = { input_tokens: 1000 };
  const base = calculateCost(usage, costs);
  for (const geo of ['global', 'not_available', undefined, null]) {
    assert.equal(calculateCost({ ...usage, inference_geo: geo }, costs), base, `geo=${geo}`);
  }
});

test('US premium composes with the fast-mode multiplier', () => {
  const costs = { input: 1e-6, output: 0, cacheWrite: 0, cacheRead: 0, webSearch: 0, fastMultiplier: 2 };
  const usage = { input_tokens: 1000, speed: 'fast', inference_geo: 'us' };
  assert.ok(Math.abs(calculateCost(usage, costs) - 1000 * 1e-6 * 2 * 1.1) < 1e-12);
});
