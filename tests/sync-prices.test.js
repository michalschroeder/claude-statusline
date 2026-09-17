'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { syncSnapshot, serialize } = require('../scripts/sync-prices');

const SNAPSHOT_PATH = path.join(__dirname, '..', 'data', 'model_prices.json');
const snap = () => JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
const rates = (i, o) => ({
  input_cost_per_token: i, output_cost_per_token: o,
  cache_creation_input_token_cost: i * 1.25, cache_read_input_token_cost: i * 0.1,
});

test('sync: bundled snapshot round-trips byte-identically against itself', () => {
  const text = fs.readFileSync(SNAPSHOT_PATH, 'utf8');
  const { next, changes } = syncSnapshot(JSON.parse(text), JSON.parse(text));
  assert.deepEqual(changes, []);
  assert.equal(serialize(next), text);
});

test('sync: rate drift mirrors upstream, reported per field', () => {
  const s = snap();
  const up = { 'claude-opus-5': { ...rates(0.000005, 0.000025), cache_read_input_token_cost: 0.00000025 } };
  const { next, changes } = syncSnapshot(s, up);
  assert.equal(next['claude-opus-5'].cache_read_input_token_cost, 0.00000025);
  assert.deepEqual(changes, ['claude-opus-5: cache_read_input_token_cost 0.0000005 → 0.00000025']);
  assert.equal(next['claude-opus-5'].provider_specific_entry.fast, 2, 'our multipliers kept when upstream has none');
});

test('sync: above_200k rates added and removed as upstream carries them', () => {
  const s = { a: rates(1e-6, 5e-6), b: { ...rates(1e-6, 5e-6), input_cost_per_token_above_200k_tokens: 2e-6 } };
  const up = { a: { ...rates(1e-6, 5e-6), input_cost_per_token_above_200k_tokens: 2e-6 }, b: rates(1e-6, 5e-6) };
  const { next, changes } = syncSnapshot(s, up);
  assert.equal(next.a.input_cost_per_token_above_200k_tokens, 2e-6);
  assert.equal('input_cost_per_token_above_200k_tokens' in next.b, false);
  assert.deepEqual(changes, ['a: input_cost_per_token_above_200k_tokens added', 'b: input_cost_per_token_above_200k_tokens removed']);
});

test('sync: provider_specific_entry merges — upstream wins, ours kept when absent', () => {
  const s = { a: { ...rates(1e-6, 5e-6), provider_specific_entry: { us: 1.1 } } };
  const { next, changes } = syncSnapshot(s, { a: { ...rates(1e-6, 5e-6), provider_specific_entry: { fast: 2 } } });
  assert.deepEqual(next.a.provider_specific_entry, { us: 1.1, fast: 2 });
  assert.deepEqual(changes, ['a: fast added']);
});

test('sync: key missing upstream is left untouched; anthropic/ prefix is accepted', () => {
  const s = { 'claude-opus-5': rates(5e-6, 25e-6), 'claude-sonnet-5': rates(3e-6, 15e-6) };
  const up = { 'anthropic/claude-sonnet-5': { ...rates(3e-6, 15e-6), input_cost_per_token: 4e-6 } };
  const { next, changes } = syncSnapshot(s, up);
  assert.deepEqual(next['claude-opus-5'], s['claude-opus-5']);
  assert.equal(next['claude-sonnet-5'].input_cost_per_token, 4e-6);
  assert.equal(changes.length, 1);
});

test('sync: adds a newer generation after its tier, skips older/dated/prefixed/preview keys', () => {
  const s = { 'claude-opus-5': rates(5e-6, 25e-6), 'claude-opus-4-8': rates(5e-6, 25e-6), 'claude-sonnet-5': rates(3e-6, 15e-6) };
  const up = {
    'claude-opus-6': rates(5e-6, 25e-6),
    'claude-opus-5-1': rates(5e-6, 25e-6),
    'claude-opus-4-1': rates(15e-6, 75e-6),
    'claude-opus-6-20270101': rates(5e-6, 25e-6),
    'anthropic/claude-opus-7': rates(5e-6, 25e-6),
    'claude-mythos-preview': rates(1e-5, 5e-5),
    'claude-haiku-5': rates(1e-6, 5e-6),
    'claude-sonnet-5': rates(3e-6, 15e-6),
  };
  const { next, changes } = syncSnapshot(s, up);
  assert.deepEqual(Object.keys(next), ['claude-opus-5', 'claude-opus-4-8', 'claude-opus-6', 'claude-opus-5-1', 'claude-sonnet-5']);
  assert.deepEqual(changes, ['claude-opus-6: added (new opus generation)', 'claude-opus-5-1: added (new opus generation)']);
});

test('serialize: plain decimals, no exponent notation, trailing newline', () => {
  const out = serialize({ a: { x: 2.5e-7, y: 0.0000225, z: 2, w: 1.1 } });
  assert.equal(out, '{\n  "a": {\n    "x": 0.00000025,\n    "y": 0.0000225,\n    "z": 2,\n    "w": 1.1\n  }\n}\n');
});
