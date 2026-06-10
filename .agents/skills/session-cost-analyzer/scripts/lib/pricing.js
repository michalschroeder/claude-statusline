'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const BUNDLED = path.join(__dirname, '..', '..', 'data', 'model_prices.json');
const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const FETCH_TTL_MS = 24 * 60 * 60 * 1000;

// Valid per-token rate: finite, non-negative; clamp >1 down to 1. Else null.
function sanitizeRate(v) {
  if (typeof v !== 'number' || !isFinite(v) || v < 0) return null;
  return v > 1 ? 1 : v;
}

// Build a {modelKey: costs} map from a LiteLLM-shaped object. Requires valid
// input+output rates; applies fallbacks; indexes provider-stripped aliases
// (first write wins, so direct-provider entries beat re-hosters).
function buildMap(rawObj) {
  const map = {};
  const put = (k, v) => { if (k && !(k in map)) map[k] = v; };
  for (const [name, e] of Object.entries(rawObj || {})) {
    if (!e || typeof e !== 'object') continue;
    const input = sanitizeRate(e.input_cost_per_token);
    const output = sanitizeRate(e.output_cost_per_token);
    if (input == null || output == null) continue;
    const cacheWrite = sanitizeRate(e.cache_creation_input_token_cost);
    const cacheRead = sanitizeRate(e.cache_read_input_token_cost);
    const val = {
      input, output,
      cacheWrite: cacheWrite == null ? input * 1.25 : cacheWrite,
      cacheRead: cacheRead == null ? input * 0.1 : cacheRead,
      fastMultiplier: 1,
      webSearch: 0.01,
    };
    // Long-context (>200K input) premium tier. Anthropic charges higher rates when
    // a request's input exceeds 200K tokens (the 1M-context tier). Captured only
    // when present; each field falls back to its base rate. calculateCost selects
    // this tier per-call by prompt size.
    const bigIn = sanitizeRate(e.input_cost_per_token_above_200k_tokens);
    const bigOut = sanitizeRate(e.output_cost_per_token_above_200k_tokens);
    const bigCW = sanitizeRate(e.cache_creation_input_token_cost_above_200k_tokens);
    const bigCR = sanitizeRate(e.cache_read_input_token_cost_above_200k_tokens);
    if (bigIn != null || bigOut != null || bigCW != null || bigCR != null) {
      val.above200k = {
        input: bigIn == null ? val.input : bigIn,
        output: bigOut == null ? val.output : bigOut,
        cacheWrite: bigCW == null ? val.cacheWrite : bigCW,
        cacheRead: bigCR == null ? val.cacheRead : bigCR,
      };
    }
    put(name, val);
    const slash = name.indexOf('/');
    if (slash !== -1) put(name.slice(slash + 1), val);
  }
  return map;
}

// Resolve message.model → costs object, or null (unknown/local → $0).
function getModelCosts(map, model) {
  if (!model) return null;
  if (model.includes(':') || /-(q4|bf16|fp16|gguf|f16|f32)$/.test(model)) return null;
  const name = model.replace(/@.*$/, '').replace(/-\d{8}$/, '');
  if (map[name]) return map[name];
  if (map[model]) return map[model];
  const keys = Object.keys(map).sort((a, b) => b.length - a.length);
  for (const k of keys) { if (name === k || name.startsWith(k + '-')) return map[k]; }
  return null;
}

// Short deterministic hash of the rate map — cache invalidation key.
function hashMap(map) {
  const h = crypto.createHash('sha1');
  for (const k of Object.keys(map).sort()) {
    const v = map[k];
    const b = v.above200k;
    const big = b ? `|${b.input},${b.output},${b.cacheWrite},${b.cacheRead}` : '';
    h.update(`${k}:${v.input},${v.output},${v.cacheWrite},${v.cacheRead}${big}`);
  }
  return h.digest('hex').slice(0, 12);
}

// Fire-and-forget LiteLLM fetch → <stateDir>/pricing.json. Never throws.
function backgroundFetch(stateDir) {
  try {
    const req = https.get(LITELLM_URL, { timeout: 8000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return; }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          const raw = JSON.parse(body);
          fs.mkdirSync(stateDir, { recursive: true });
          const tmp = path.join(stateDir, `pricing.json.${process.pid}`);
          fs.writeFileSync(tmp, JSON.stringify({ fetchedAt: Date.now(), raw }));
          fs.renameSync(tmp, path.join(stateDir, 'pricing.json'));
        } catch {}
      });
    });
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
    req.unref(); // don't keep the hook process alive for the fetch
  } catch {}
}

// Sync load: cached fetch if present, else bundled snapshot. Kicks a background
// refresh when the cache is older than 24h (unless allowFetch:false, or the
// STATUSLINE_PRICING_NO_FETCH env is set — used by tests to stay offline and
// avoid writing into the state dir).
function loadPricing(stateDir, opts = {}) {
  const allowFetch = opts.allowFetch !== undefined ? opts.allowFetch : !process.env.STATUSLINE_PRICING_NO_FETCH;
  let raw = null, fetchedAt = 0;
  try {
    const c = JSON.parse(fs.readFileSync(path.join(stateDir, 'pricing.json'), 'utf8'));
    if (c && c.raw) { raw = c.raw; fetchedAt = c.fetchedAt || 0; }
  } catch {}
  if (!raw) { try { raw = JSON.parse(fs.readFileSync(BUNDLED, 'utf8')); } catch { raw = {}; } }
  if (allowFetch && Date.now() - fetchedAt > FETCH_TTL_MS) backgroundFetch(stateDir);
  const map = buildMap(raw);
  return { map, pricingHash: hashMap(map) };
}

module.exports = { sanitizeRate, buildMap, getModelCosts, hashMap, loadPricing };
