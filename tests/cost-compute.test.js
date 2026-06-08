'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractCacheCreation, calculateCost } = require('../lib/cost-compute');

const COSTS = { input: 10, output: 20, cacheWrite: 4, cacheRead: 1, fastMultiplier: 0.5, webSearch: 0.01 };

// Model with a long-context (>200K) premium tier.
const BIG = {
  input: 10, output: 20, cacheWrite: 4, cacheRead: 1, fastMultiplier: 1, webSearch: 0.01,
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

test('calculateCost: fast multiplies whole call', () => {
  const usage = { input_tokens: 1, speed: 'fast' };
  assert.equal(calculateCost(usage, COSTS), 0.5 * 10);
});

test('calculateCost: null costs → 0', () => {
  assert.equal(calculateCost({ input_tokens: 1000 }, null), 0);
});

test('calculateCost: clamps negative/NaN tokens to 0', () => {
  assert.equal(calculateCost({ input_tokens: -5, output_tokens: NaN }, COSTS), 0);
});
