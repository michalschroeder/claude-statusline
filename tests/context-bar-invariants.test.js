'use strict';
// Property-style sweeps over the context-bar contract. Hand-written, no deps.
// Catches off-by-one between filled-cell logic and panic-trigger logic, and
// guarantees the displayed "N%" label always equals raw used_percentage.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { baseInput, runRaw, stripAnsi } = require('./helpers.js');

const PANIC_CODE = '\x1b[5;31m';

function inpPct(p) {
  const i = baseInput();
  i.context_window = { used_percentage: p };
  return i;
}
function inpTok(usedPct, tokens) {
  const i = baseInput();
  i.context_window = { used_percentage: usedPct, total_input_tokens: tokens };
  return i;
}
function labelPct(plain) {
  const m = plain.match(/(\d+)%/);
  return m ? Number(m[1]) : null;
}
const isPanic = (raw) => raw.includes(PANIC_CODE);

// ─── Bar-vs-panic invariant ──────────────────────────────────────────────────
// The contract: panic fires exactly when the bar would otherwise reach panicCell.
//   200k tier: panicCell=8 → panic iff tokens >= 160_000
//   1M tier:   panicCell=10 → panic iff tokens >= 500_000
//   percent fallback:       panic iff displayPct >= 80

test('invariant: 200k tier — panic iff tokens >= 160k (sweep 0..200k step 5k)', async () => {
  for (let tok = 0; tok <= 200_000; tok += 5_000) {
    const usedPct = tok / 2_000; // inferred total = 200k
    const raw = await runRaw(inpTok(usedPct, tok));
    const expected = tok >= 160_000;
    assert.equal(isPanic(raw), expected,
      `200k tier @ ${tok} tokens: expected panic=${expected}, got panic=${isPanic(raw)}`);
  }
});

test('invariant: 1M tier — panic iff tokens >= 500k (sweep 0..600k step 25k)', async () => {
  for (let tok = 0; tok <= 600_000; tok += 25_000) {
    const usedPct = tok / 10_000; // inferred total = 1M
    const raw = await runRaw(inpTok(usedPct, tok));
    const expected = tok >= 500_000;
    assert.equal(isPanic(raw), expected,
      `1M tier @ ${tok} tokens: expected panic=${expected}, got panic=${isPanic(raw)}`);
  }
});

test('invariant: percent fallback — panic iff displayPct >= 80 (sweep 0..100)', async () => {
  for (let p = 0; p <= 100; p++) {
    const raw = await runRaw(inpPct(p));
    const expected = p >= 80;
    assert.equal(isPanic(raw), expected,
      `fallback @ ${p}%: expected panic=${expected}, got panic=${isPanic(raw)}`);
  }
});

// ─── Dense usedPct sweep — label MUST equal raw used_percentage ──────────────

test('label sweep: percent-only fallback — label === used_percentage for 0..100', async () => {
  for (let p = 0; p <= 100; p++) {
    const plain = stripAnsi(await runRaw(inpPct(p)));
    assert.equal(labelPct(plain), p, `fallback @ ${p}% → got "${labelPct(plain)}%" in: ${plain}`);
  }
});

test('label sweep: 200k tier — label === round(usedPct) across token range', async () => {
  // tokens 0..200_000 step 4_000 → usedPct 0..100 step 2.
  for (let tok = 0; tok <= 200_000; tok += 4_000) {
    const usedPct = tok / 2_000;
    const plain = stripAnsi(await runRaw(inpTok(usedPct, tok)));
    assert.equal(labelPct(plain), Math.round(usedPct),
      `200k @ ${tok} tokens (${usedPct}%) → got "${labelPct(plain)}%"`);
  }
});

test('label sweep: 1M tier — label === round(usedPct) across token range', async () => {
  // tokens 0..600_000 step 12_000 → usedPct 0..60 step 1.2.
  for (let tok = 0; tok <= 600_000; tok += 12_000) {
    const usedPct = tok / 10_000;
    const plain = stripAnsi(await runRaw(inpTok(usedPct, tok)));
    assert.equal(labelPct(plain), Math.round(usedPct),
      `1M @ ${tok} tokens (${usedPct}%) → got "${labelPct(plain)}%"`);
  }
});
