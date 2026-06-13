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

test('calculateCost: uses base rates when prompt ≤ 200K', () => {
  // prompt = input + cacheRead + cacheCreate = 100000 + 50000 = 150000 (≤200K)
  const usage = { input_tokens: 100000, cache_read_input_tokens: 50000, output_tokens: 1 };
  // 100000*10 + 50000*1 + 1*20 = 1,000,000 + 50,000 + 20
  assert.equal(calculateCost(usage, BIG), 1050020);
});

test('calculateCost: uses above-200K rates when prompt > 200K', () => {
  // prompt = 150000 + 100000 = 250000 (>200K) → premium rates
  const usage = { input_tokens: 150000, cache_read_input_tokens: 100000, output_tokens: 1 };
  // 150000*20 + 100000*2 + 1*40 = 3,000,000 + 200,000 + 40
  assert.equal(calculateCost(usage, BIG), 3200040);
});

test('calculateCost: threshold counts cached + created input tokens', () => {
  // input 10000 + cacheRead 150000 + cacheCreate 60000 = 220000 (>200K) → premium
  const usage = { input_tokens: 10000, cache_read_input_tokens: 150000, cache_creation_input_tokens: 60000 };
  // premium: 10000*20 + 150000*2 + 60000*8 = 200000 + 300000 + 480000
  assert.equal(calculateCost(usage, BIG), 980000);
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

test('calculateCost: full formula with 1h×1.6', () => {
  const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 1,
    cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 1 },
    server_tool_use: { web_search_requests: 1 } };
  // 10 + 20 + (1*4) + (1*4*1.6) + 1 + 0.01 = 41.41
  assert.equal(calculateCost(usage, COSTS), 41.41);
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
  assert.equal(b.cacheWrite, 100 * 4 + 50 * 4 * 1.6);     // 400 + 320 = 720
  assert.equal(b.web, 3 * 0.01);                          // 0.03
  assert.equal(b.total, b.input + b.output + b.cacheRead + b.cacheWrite + b.web);
  assert.equal(b.total, calculateCost(usage, COSTS));     // single source of truth
});

test('calculateCostBreakdown: above-200K tier applies per component', () => {
  const usage = { input_tokens: 150000, cache_read_input_tokens: 100000, output_tokens: 1 };
  const b = calculateCostBreakdown(usage, BIG); // premium: input20 output40 cacheRead2
  assert.equal(b.input, 150000 * 20);
  assert.equal(b.cacheRead, 100000 * 2);
  assert.equal(b.output, 1 * 40);
  assert.equal(b.total, calculateCost(usage, BIG)); // 3200040
});

test('calculateCostBreakdown: null costs/usage → all zeros', () => {
  const z = calculateCostBreakdown(null, null);
  assert.deepEqual(z, { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, web: 0, total: 0 });
});
