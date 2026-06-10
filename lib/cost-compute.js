'use strict';

// Non-negative finite number, else 0.
function num(v) {
  const n = Number(v);
  return isFinite(n) && n > 0 ? n : 0;
}

// Split cache-write tokens into 5-minute and 1-hour TTL buckets. Prefers the
// newer cache_creation split; falls back to the legacy total; never drops tokens.
function extractCacheCreation(usage) {
  const legacy = num(usage && usage.cache_creation_input_tokens);
  const cc = (usage && usage.cache_creation) || {};
  const five = num(cc.ephemeral_5m_input_tokens);
  const one = num(cc.ephemeral_1h_input_tokens);
  const split = five + one;
  let total, oneHour;
  if (split === 0) { total = legacy; oneHour = 0; }
  else { total = Math.max(legacy, split); oneHour = Math.min(one, total); }
  return { fiveMinute: Math.max(0, total - oneHour), oneHour };
}

// 200K-token threshold for the long-context premium tier.
const LONG_CONTEXT_THRESHOLD = 200000;

// Shared all-zero breakdown for unknown/local models (no pricing) — frozen so the
// hot aggregate loop reuses one object instead of allocating per null-cost call.
const ZERO_BREAKDOWN = Object.freeze({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, web: 0, total: 0 });

// Price one assistant call, itemized. Returns USD per component plus `total`.
// `costs` is the resolved per-token rate object or null (unknown/local → all 0).
// Fast mode scales the whole call; >200K prompt switches the four token rates to
// the model's `above200k` premium tier when defined; the 1-hour cache-write
// premium is `cacheWrite × 1.6`.
function calculateCostBreakdown(usage, costs) {
  if (!costs || !usage) return ZERO_BREAKDOWN;
  const { fiveMinute, oneHour } = extractCacheCreation(usage);
  const inputTokens = num(usage.input_tokens);
  const cacheReadTokens = num(usage.cache_read_input_tokens);
  const promptTokens = inputTokens + cacheReadTokens + fiveMinute + oneHour;
  const rates = (costs.above200k && promptTokens > LONG_CONTEXT_THRESHOLD) ? costs.above200k : costs;
  const mult = usage.speed === 'fast' ? (costs.fastMultiplier || 1) : 1;
  const webReq = num(usage.server_tool_use && usage.server_tool_use.web_search_requests);
  const input = mult * inputTokens * rates.input;
  const output = mult * num(usage.output_tokens) * rates.output;
  const cacheWrite = mult * (fiveMinute * rates.cacheWrite + oneHour * rates.cacheWrite * 1.6);
  const cacheRead = mult * cacheReadTokens * rates.cacheRead;
  const web = mult * webReq * costs.webSearch;
  return { input, output, cacheWrite, cacheRead, web, total: input + output + cacheWrite + cacheRead + web };
}

// Single-number cost: the total of the itemized breakdown (no drift between paths).
function calculateCost(usage, costs) {
  return calculateCostBreakdown(usage, costs).total;
}

module.exports = { extractCacheCreation, calculateCost, calculateCostBreakdown };
