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

// Price one assistant call. `costs` is the resolved per-token rate object or null
// for unknown/local models → $0. Fast mode multiplies the ENTIRE call cost by the
// model's fast multiplier. When the request's total input (fresh + cache read +
// cache created) exceeds 200K tokens and the model defines an `above200k` tier,
// the four token rates switch to that premium tier (the 1M-context pricing).
function calculateCost(usage, costs) {
  if (!costs || !usage) return 0;
  const { fiveMinute, oneHour } = extractCacheCreation(usage);
  const inputTokens = num(usage.input_tokens);
  const cacheReadTokens = num(usage.cache_read_input_tokens);
  const promptTokens = inputTokens + cacheReadTokens + fiveMinute + oneHour;
  const rates = (costs.above200k && promptTokens > LONG_CONTEXT_THRESHOLD) ? costs.above200k : costs;
  const mult = usage.speed === 'fast' ? (costs.fastMultiplier || 1) : 1;
  const web = num(usage.server_tool_use && usage.server_tool_use.web_search_requests);
  return mult * (
      inputTokens * rates.input
    + num(usage.output_tokens) * rates.output
    + fiveMinute * rates.cacheWrite
    + oneHour * rates.cacheWrite * 1.6
    + cacheReadTokens * rates.cacheRead
    + web * costs.webSearch
  );
}

module.exports = { extractCacheCreation, calculateCost };
