'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const BUNDLED = path.join(__dirname, '..', 'data', 'model_prices.json');
const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const FETCH_TTL_MS = 24 * 60 * 60 * 1000;
// Fallback US-only-inference premium for entries upstream hasn't annotated.
const US_INFERENCE_FALLBACK = 1.1;
const FETCH_RETRY_MS = 60 * 60 * 1000; // throttle attempts (success or failure) — keyed on a stamp file, so failing fetches don't retry every prompt

// A model string whose pricing is legitimately absent — a local/Ollama tag
// (`:` separator) or a quantization suffix. Single authority for the "unpriced
// on purpose, don't warn" rule, shared with cost-aggregate's warning path.
function isLocalModel(model) {
  return !!model && (model.includes(':') || /-(q4|bf16|fp16|gguf|f16|f32)$/.test(model));
}

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
    // Per-call price multipliers LiteLLM carries in `provider_specific_entry`:
    //   fast — speed:'fast' premium (Opus 5 = 2)
    //   us   — US-only inference on a data-residency workspace (1.1)
    // `fast` defaults to 1 (no premium). `us` defaults to US_INFERENCE_FALLBACK
    // rather than 1: the premium is a workspace-level charge that applies whatever
    // the model, and upstream only annotates the newer entries — defaulting to 1
    // would silently drop it for any model LiteLLM hasn't tagged yet.
    const mult = (v, dflt) => (typeof v === 'number' && isFinite(v) && v > 0 ? v : dflt);
    const ps = e.provider_specific_entry;
    const fast = mult(ps && ps.fast, 1);
    const us = mult(ps && ps.us, US_INFERENCE_FALLBACK);
    const val = {
      input, output,
      cacheWrite: cacheWrite == null ? input * 1.25 : cacheWrite,
      cacheRead: cacheRead == null ? input * 0.1 : cacheRead,
      webSearch: 0.01,
      fastMultiplier: fast,
      usMultiplier: us,
    };
    // Long-context (>200K) premium tier, applied marginally & per-category by
    // calculateCost. Store ONLY the rates present upstream; an absent category stays
    // null so its tier is dormant (billed flat at base) rather than backfilled.
    const bigIn = sanitizeRate(e.input_cost_per_token_above_200k_tokens);
    const bigOut = sanitizeRate(e.output_cost_per_token_above_200k_tokens);
    const bigCW = sanitizeRate(e.cache_creation_input_token_cost_above_200k_tokens);
    const bigCR = sanitizeRate(e.cache_read_input_token_cost_above_200k_tokens);
    if (bigIn != null || bigOut != null || bigCW != null || bigCR != null) {
      val.above200k = { input: bigIn, output: bigOut, cacheWrite: bigCW, cacheRead: bigCR };
    }
    put(name, val);
    const slash = name.indexOf('/');
    if (slash !== -1) put(name.slice(slash + 1), val);
  }
  return map;
}

// A payload is usable only if it prices at least one Claude model — the real
// invariant this tool depends on. Rejects CDN/error bodies, schema renames, and
// tables whose Claude entries all have malformed rates (dropped by buildMap). A
// model-count threshold can't work: the curated bundled snapshot has ~5 keys
// while the live LiteLLM table has hundreds, so no single count is safe.
function hasClaudeModel(map) {
  return Object.keys(map).some((k) => k.startsWith('claude-'));
}

function isUsablePriceTable(raw) {
  return hasClaudeModel(buildMap(raw));
}

// Per-map resolution cache: model-string → costs (or null). Keyed on the map via
// WeakMap so distinct maps in one process (tests build several) never collide,
// and entries are GC'd with the map. Each entry also lazily caches the
// length-sorted key list so the O(n log n) sort runs once per map, not per miss —
// the stale-snapshot case turns every transcript line into a miss, and without
// this each line re-sorted ~2000 keys.
const resolveCache = new WeakMap();

function getCacheEntry(map) {
  let entry = resolveCache.get(map);
  if (!entry) { entry = { resolved: new Map(), keys: null }; resolveCache.set(map, entry); }
  return entry;
}

// Resolve message.model → costs object, or null (unknown/local → $0).
function getModelCosts(map, model) {
  if (!model) return null;
  const entry = getCacheEntry(map);
  const hit = entry.resolved.get(model);
  if (hit !== undefined) return hit;
  const out = resolveModelCosts(map, entry, model);
  entry.resolved.set(model, out);
  return out;
}

function resolveModelCosts(map, entry, model) {
  if (isLocalModel(model)) return null;
  const name = model.replace(/@.*$/, '').replace(/\[[^\]]*\]/, '').replace(/-\d{8}$/, '');
  if (map[name]) return map[name];
  if (map[model]) return map[model];
  if (!entry.keys) entry.keys = Object.keys(map).sort((a, b) => b.length - a.length);
  for (const k of entry.keys) { if (name === k || name.startsWith(k + '-')) return map[k]; }
  return null;
}

// Short deterministic hash of the rate map — cache invalidation key.
function hashMap(map) {
  const h = crypto.createHash('sha1');
  for (const k of Object.keys(map).sort()) {
    const v = map[k];
    const b = v.above200k;
    const big = b ? `|${b.input},${b.output},${b.cacheWrite},${b.cacheRead}` : '';
    h.update(`${k}:${v.input},${v.output},${v.cacheWrite},${v.cacheRead},${v.fastMultiplier || 1},${v.usMultiplier || 1}${big}`);
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
          if (!isUsablePriceTable(raw)) return; // schema change / error body — keep the old table
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
  let raw = null, fetchedAt = 0, map = null;
  try {
    const c = JSON.parse(fs.readFileSync(path.join(stateDir, 'pricing.json'), 'utf8'));
    if (c && c.raw) { raw = c.raw; fetchedAt = c.fetchedAt || 0; }
  } catch {}
  // Self-heal: a present-but-unusable cache file (junk-but-valid-JSON) must not
  // stick for the 24h TTL and zero out all costs — fall back to bundled now, and
  // the staleness check below still kicks a refresh. Build the map once here and
  // reuse it below — the LiteLLM table has thousands of entries and this runs on
  // every prompt submit.
  if (raw) {
    map = buildMap(raw);
    if (!hasClaudeModel(map)) { map = null; fetchedAt = 0; }
  }
  if (!map) {
    let bundled; try { bundled = JSON.parse(fs.readFileSync(BUNDLED, 'utf8')); } catch { bundled = {}; }
    map = buildMap(bundled);
  }
  // Two gates: the 24h success-TTL (fetchedAt only advances on success) AND a 1h
  // attempt-throttle (a stamp file written on every attempt). Without the stamp a
  // persistently failing fetch — fetchedAt stuck at 0 — would fire on every prompt.
  if (allowFetch && Date.now() - fetchedAt > FETCH_TTL_MS) {
    const stamp = path.join(stateDir, 'pricing.last-attempt');
    let lastAttempt = 0;
    try { lastAttempt = fs.statSync(stamp).mtimeMs; } catch {}
    if (Date.now() - lastAttempt > FETCH_RETRY_MS) {
      try {
        fs.mkdirSync(stateDir, { recursive: true });
        fs.writeFileSync(stamp, '');
      } catch {}
      backgroundFetch(stateDir);
    }
  }
  return { map, pricingHash: hashMap(map) };
}

module.exports = { sanitizeRate, isLocalModel, buildMap, isUsablePriceTable, getModelCosts, hashMap, loadPricing };
