'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildMap, isUsablePriceTable, getModelCosts, hashMap, loadPricing } = require('../lib/pricing');

const tmp = [];
after(() => { for (const d of tmp) fs.rmSync(d, { recursive: true, force: true }); });

const RAW = {
  'claude-opus-4-8': { input_cost_per_token: 0.000005, output_cost_per_token: 0.000025 },
  'anthropic/claude-sonnet-4-6': { input_cost_per_token: 0.000003, output_cost_per_token: 0.000015 },
  'bad-no-output': { input_cost_per_token: 0.000001 },
  'bad-negative': { input_cost_per_token: -1, output_cost_per_token: 0.00001 },
  'overpriced': { input_cost_per_token: 5, output_cost_per_token: 0.00001 },
};

test('buildMap: applies cache fallbacks (write=input×1.25, read=input×0.1)', () => {
  const m = buildMap(RAW);
  const c = m['claude-opus-4-8'];
  assert.equal(c.cacheWrite, 0.000005 * 1.25);
  assert.equal(c.cacheRead, 0.000005 * 0.1);
  assert.equal(c.webSearch, 0.01);
});

test('buildMap: indexes provider-stripped alias', () => {
  const m = buildMap(RAW);
  assert.ok(m['claude-sonnet-4-6']);
  assert.equal(m['claude-sonnet-4-6'].input, 0.000003);
});

test('buildMap: skips entries missing input or output cost', () => {
  const m = buildMap(RAW);
  assert.equal(m['bad-no-output'], undefined);
});

test('buildMap: rejects negative rate (entry dropped — input invalid)', () => {
  const m = buildMap(RAW);
  assert.equal(m['bad-negative'], undefined);
});

test('buildMap: clamps per-token rate > 1 down to 1', () => {
  const m = buildMap(RAW);
  assert.equal(m['overpriced'].input, 1);
});

test('buildMap: extracts >200K premium tier when present', () => {
  const m = buildMap({
    big: {
      input_cost_per_token: 0.000003, output_cost_per_token: 0.000015,
      input_cost_per_token_above_200k_tokens: 0.000006,
      output_cost_per_token_above_200k_tokens: 0.0000225,
      cache_creation_input_token_cost_above_200k_tokens: 0.0000075,
      cache_read_input_token_cost_above_200k_tokens: 0.0000006,
    },
  });
  assert.equal(m.big.above200k.input, 0.000006);
  assert.equal(m.big.above200k.output, 0.0000225);
  assert.equal(m.big.above200k.cacheWrite, 0.0000075);
  assert.equal(m.big.above200k.cacheRead, 0.0000006);
});

test('buildMap: no above200k key when premium fields absent', () => {
  const m = buildMap(RAW);
  assert.equal(m['claude-opus-4-8'].above200k, undefined);
});

test('buildMap: bundled snapshot — opus-4-7 present, sonnet-4-6 has NO >200K premium, haiku-4-5 at 4.5 rates', () => {
  const fs = require('fs'); const path = require('path');
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'model_prices.json'), 'utf8'));
  const m = buildMap(raw);
  assert.ok(m['claude-opus-4-7'], 'opus-4-7 present in bundled snapshot');
  // Official pricing: Sonnet 4.6 serves the full 1M context at standard rates —
  // there is no >200K premium tier.
  assert.equal(m['claude-sonnet-4-6'].above200k, undefined);
  // Haiku 4.5 is $1/$5 per MTok (not the Haiku 3.5 $0.80/$4 rates).
  assert.equal(m['claude-haiku-4-5'].input, 0.000001);
  assert.equal(m['claude-haiku-4-5'].output, 0.000005);
});

test('bundled snapshot resolves current Claude models', () => {
  // Extend this id list whenever a new Claude model ships, so CI fails loudly
  // instead of silently pricing the new model $0 (issue #25).
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'model_prices.json'), 'utf8'));
  const map = buildMap(raw);
  for (const id of ['claude-fable-5', 'claude-opus-4-8', 'claude-opus-4-7',
                    'claude-opus-4-6', 'claude-opus-4-5', 'claude-sonnet-4-6',
                    'claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-haiku-4-5-20251001'])
    assert.ok(getModelCosts(map, id), `${id} missing from bundled snapshot`);
  assert.equal(getModelCosts(map, 'claude-fable-5').input, 0.00001);
});

test('getModelCosts: exact, date-stripped, and longest-prefix match', () => {
  const m = buildMap(RAW);
  assert.equal(getModelCosts(m, 'claude-opus-4-8').input, 0.000005);
  assert.equal(getModelCosts(m, 'claude-opus-4-8-20260601').input, 0.000005);
  assert.equal(getModelCosts(m, 'claude-opus-4-8@beta').input, 0.000005);
  // bracket suffix (1M-context variant form) strips to the base id (issue #31)
  assert.equal(getModelCosts(m, 'claude-opus-4-8[1m]').input, 0.000005);
  assert.equal(getModelCosts(m, 'claude-opus-4-8[1m]-20260601').input, 0.000005);
});

test('getModelCosts: unknown and local models → null', () => {
  const m = buildMap(RAW);
  assert.equal(getModelCosts(m, 'gpt-9'), null);
  assert.equal(getModelCosts(m, 'llama3:8b'), null);
  assert.equal(getModelCosts(m, 'mistral-7b-q4'), null);
});

test('hashMap: stable + changes when a rate changes', () => {
  const a = hashMap(buildMap(RAW));
  const b = hashMap(buildMap(RAW));
  const c = hashMap(buildMap({ ...RAW, 'claude-opus-4-8': { input_cost_per_token: 0.000009, output_cost_per_token: 0.000025 } }));
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('loadPricing: falls back to bundled snapshot when no cache, no fetch', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-price-')); tmp.push(stateDir);
  const p = loadPricing(stateDir, { allowFetch: false });
  assert.ok(p.map['claude-opus-4-8']);
  assert.equal(typeof p.pricingHash, 'string');
  assert.equal(getModelCosts(p.map, 'gpt-9'), null);
});

test('isUsablePriceTable: true only when a claude- model is priced', () => {
  assert.equal(isUsablePriceTable(RAW), true);            // has claude-opus-4-8
  assert.equal(isUsablePriceTable({ oops: 'not a table' }), false);
  assert.equal(isUsablePriceTable({}), false);
  // non-Claude-only table (valid rates, but no claude- key) → rejected
  assert.equal(isUsablePriceTable({ 'gpt-4': { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 } }), false);
  // claude model present but every rate malformed → dropped by buildMap → rejected
  assert.equal(isUsablePriceTable({ 'claude-opus-4-8': { input_cost_per_token: -1, output_cost_per_token: -1 } }), false);
});

test('loadPricing: self-heals a junk-but-valid-JSON cache file → bundled (issue #26)', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-price-bad-')); tmp.push(stateDir);
  fs.writeFileSync(path.join(stateDir, 'pricing.json'),
    JSON.stringify({ fetchedAt: Date.now(), raw: { oops: 'not a table' } }));
  const p = loadPricing(stateDir, { allowFetch: false });
  // Before the fix: empty map, opus → null ($0). After: fell back to bundled.
  assert.ok(p.map['claude-opus-4-8']);
  assert.notEqual(getModelCosts(p.map, 'claude-opus-4-8'), null);
});

test('loadPricing: a good cache file is preferred (self-heal does not clobber valid data)', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-price-good-')); tmp.push(stateDir);
  // A valid (Claude-pricing) cache with a distinctive rate — must be used, not bundled.
  fs.writeFileSync(path.join(stateDir, 'pricing.json'),
    JSON.stringify({ fetchedAt: Date.now(), raw: { 'claude-opus-4-8': { input_cost_per_token: 0.000009, output_cost_per_token: 0.000025 } } }));
  const p = loadPricing(stateDir, { allowFetch: false });
  assert.equal(p.map['claude-opus-4-8'].input, 0.000009); // from cache, not bundled
});

// --- fetch attempt-throttle (issue #29) ---
// The stamp file <stateDir>/pricing.last-attempt is the observable proxy for "fetch
// attempted": backgroundFetch is fire-and-forget, but the stamp is written
// synchronously before it, independent of network outcome.
const STAMP = 'pricing.last-attempt';

test('loadPricing: fresh stamp suppresses a retry within the 1h window', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-price-stamp-fresh-')); tmp.push(stateDir);
  fs.writeFileSync(path.join(stateDir, STAMP), '');
  const before = fs.statSync(path.join(stateDir, STAMP)).mtimeMs;
  loadPricing(stateDir, { allowFetch: true }); // no pricing.json → 24h gate open
  const after = fs.statSync(path.join(stateDir, STAMP)).mtimeMs;
  assert.equal(after, before); // not re-stamped → no new attempt
});

test('loadPricing: a >1h-stale stamp permits a retry and re-stamps to now', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-price-stamp-stale-')); tmp.push(stateDir);
  const stamp = path.join(stateDir, STAMP);
  fs.writeFileSync(stamp, '');
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2h ago
  fs.utimesSync(stamp, old, old);
  const before = fs.statSync(stamp).mtimeMs;
  loadPricing(stateDir, { allowFetch: true });
  const after = fs.statSync(stamp).mtimeMs;
  assert.ok(after > before); // re-stamped → a fresh attempt fired
});

test('loadPricing: no stamp permits a retry and creates the stamp', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-price-stamp-none-')); tmp.push(stateDir);
  loadPricing(stateDir, { allowFetch: true });
  assert.ok(fs.existsSync(path.join(stateDir, STAMP)));
});

test('loadPricing: allowFetch:false never stamps (offline-test contract)', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-price-stamp-off-')); tmp.push(stateDir);
  loadPricing(stateDir, { allowFetch: false });
  assert.equal(fs.existsSync(path.join(stateDir, STAMP)), false);
});

test('loadPricing: fresh pricing.json (success TTL closed) never stamps', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-price-stamp-fresh-json-')); tmp.push(stateDir);
  fs.writeFileSync(path.join(stateDir, 'pricing.json'),
    JSON.stringify({ fetchedAt: Date.now(), raw: RAW }));
  loadPricing(stateDir, { allowFetch: true });
  assert.equal(fs.existsSync(path.join(stateDir, STAMP)), false); // 24h gate short-circuits the throttle
});
