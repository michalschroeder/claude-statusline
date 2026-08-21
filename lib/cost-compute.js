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

// Premium for inference pinned to US-only infrastructure (data-residency
// workspaces). Applies to the whole call, on top of any speed multiplier.
const US_INFERENCE_MULTIPLIER = 1.1;

// 200K-token threshold for the long-context premium tier.
const LONG_CONTEXT_THRESHOLD = 200000;

// Marginal long-context pricing, applied PER token category: the first 200K tokens
// bill at `base`, the excess at `above`. When the model defines no above-rate for
// this category (`above == null`) the tier is dormant and everything bills at `base`.
// The threshold is per-category, never on a combined prompt total.
function tiered(tokens, base, above) {
  if (above != null && tokens > LONG_CONTEXT_THRESHOLD) {
    return LONG_CONTEXT_THRESHOLD * base + (tokens - LONG_CONTEXT_THRESHOLD) * above;
  }
  return tokens * base;
}

// Shared all-zero breakdown for unknown/local models (no pricing) — frozen so the
// hot aggregate loop reuses one object instead of allocating per null-cost call.
const ZERO_BREAKDOWN = Object.freeze({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, web: 0, total: 0 });

// Price one assistant call, itemized. Returns USD per component plus `total`.
// `costs` is the resolved per-token rate object or null (unknown/local → all 0).
// Each priced token category is tiered independently at the 200K marginal threshold
// (dormant unless the model defines an `above200k` rate for that category); the
// 1-hour cache-write rate is `input × 2.0` (its above-rate `input_above_200k × 2.0`).
// `usage.speed === 'fast'` scales the ENTIRE call (tokens + web) by `fastMultiplier`;
// `usage.inference_geo === 'us'` scales it by US_INFERENCE_MULTIPLIER (1.1). Both compose.
function calculateCostBreakdown(usage, costs) {
  if (!costs || !usage) return ZERO_BREAKDOWN;
  const { fiveMinute, oneHour } = extractCacheCreation(usage);
  const inputTokens = num(usage.input_tokens);
  const outputTokens = num(usage.output_tokens);
  const cacheReadTokens = num(usage.cache_read_input_tokens);
  const webReq = num(usage.server_tool_use && usage.server_tool_use.web_search_requests);
  // No allocation on the common no-premium path (a undefined): tiered's `above != null`
  // guard already tolerates undefined, so `a && a.x` needs no throwaway `{}`.
  const a = costs.above200k;
  const input = tiered(inputTokens, costs.input, a && a.input);
  const output = tiered(outputTokens, costs.output, a && a.output);
  // 1h cache writes bill at 2× the input rate; tiered is linear so the factor pulls out.
  const cacheWrite = tiered(fiveMinute, costs.cacheWrite, a && a.cacheWrite) + 2.0 * tiered(oneHour, costs.input, a && a.input);
  const cacheRead = tiered(cacheReadTokens, costs.cacheRead, a && a.cacheRead);
  const web = webReq * costs.webSearch;
  const sum = input + output + cacheWrite + cacheRead + web;
  // Two whole-call multipliers, applied together. `speed: 'fast'` uses the model's
  // own fastMultiplier (default 1 — no Claude entry defines one today). US-only
  // inference (data-residency workspaces, `inference_geo: 'us'`) bills at 1.1x;
  // 'global' and 'not_available' are unpriced. Claude Code's own estimates added
  // this premium in 2026-08, so without it we read ~10% under /cost on such a
  // workspace. Dormant everywhere else.
  const mult = (usage.speed === 'fast' ? (costs.fastMultiplier || 1) : 1)
    * (usage.inference_geo === 'us' ? US_INFERENCE_MULTIPLIER : 1);
  return {
    input: input * mult,
    output: output * mult,
    cacheWrite: cacheWrite * mult,
    cacheRead: cacheRead * mult,
    web: web * mult,
    total: sum * mult,
  };
}

// Single-number cost: the total of the itemized breakdown (no drift between paths).
function calculateCost(usage, costs) {
  return calculateCostBreakdown(usage, costs).total;
}

module.exports = { extractCacheCreation, calculateCost, calculateCostBreakdown, US_INFERENCE_MULTIPLIER };
