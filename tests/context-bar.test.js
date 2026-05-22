'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { baseInput, runRaw, stripAnsi } = require('./helpers.js');

// Ramp B (muted): forest → olive → amber → red. One 256-color code per cell.
const RAMP = [34, 70, 106, 142, 178, 214, 208, 202, 196, 160];
const EMPTY_COLOR = 240;
const EMPTY_CODE = `\x1b[38;5;${EMPTY_COLOR}m`;
const cellCode = (i) => `\x1b[38;5;${RAMP[i]}m`;
const PANIC_CODE = '\x1b[5;31m';
const SKULL = '󰚌';

function inpPct(used) {
  const i = baseInput();
  i.context_window = { used_percentage: used };
  return i;
}
function inp200k(tokens) {
  const i = baseInput();
  // Inferred total = tokens / (usedPct/100). For 200k model with N tokens used,
  // usedPct = N/2000. Inferred total = N / (N/2000 / 100) = 200_000. Stays standard.
  i.context_window = { used_percentage: tokens / 2000, total_input_tokens: tokens };
  return i;
}
function inp1M(tokens) {
  const i = baseInput();
  // Inferred total = tokens / (usedPct/100). usedPct = tokens/10_000 ⇒ inferred total = 1M.
  i.context_window = { used_percentage: tokens / 10_000, total_input_tokens: tokens };
  return i;
}

test('null context — no bar emitted', async () => {
  assert.ok(!stripAnsi(await runRaw(baseInput())).includes('█'));
});

// ─── Fallback (percent-only, no token info) ──────────────────────────────────

test('fallback: 0% used → no filled cells, dim grey only', async () => {
  const raw = await runRaw(inpPct(0));
  assert.ok(raw.includes(EMPTY_CODE));
  for (let i = 0; i < 10; i++) assert.ok(!raw.includes(cellCode(i)));
  assert.ok(stripAnsi(raw).includes('0%'));
});

test('fallback: 50% used → 5 cells, last cell color ramp[4]', async () => {
  const raw = await runRaw(inpPct(50));
  assert.ok(raw.includes(cellCode(0)));
  assert.ok(raw.includes(cellCode(4)));
  assert.ok(!raw.includes(cellCode(5)));
  assert.ok(stripAnsi(raw).includes('50%'));
});

test('fallback: 95% used → 9 cells, no panic blink yet', async () => {
  const raw = await runRaw(inpPct(95));
  assert.ok(raw.includes(cellCode(8)));
  assert.ok(!raw.includes(cellCode(9)));
  assert.ok(!raw.includes(PANIC_CODE));
});

test('fallback: 100% used → panic blink + skull', async () => {
  const raw = await runRaw(inpPct(100));
  assert.ok(raw.includes(PANIC_CODE));
  assert.ok(stripAnsi(raw).includes(SKULL));
});

test('fallback: remaining_percentage=0 → panic', async () => {
  const i = baseInput();
  i.context_window = { remaining_percentage: 0 };
  const raw = await runRaw(i);
  assert.ok(raw.includes(PANIC_CODE));
  assert.ok(stripAnsi(raw).includes(SKULL));
});

// ─── 200k model — 20k tokens per cell, panic ≥ 200k ──────────────────────────

test('200k: 0 tokens → 0 cells filled', async () => {
  const raw = await runRaw(inp200k(0));
  for (let i = 0; i < 10; i++) assert.ok(!raw.includes(cellCode(i)));
});

test('200k: 19_999 tokens (just under 1st cell) → 0 cells', async () => {
  const raw = await runRaw(inp200k(19_999));
  assert.ok(!raw.includes(cellCode(0)));
});

test('200k: 20_000 tokens → 1 cell (ramp[0] forest)', async () => {
  const raw = await runRaw(inp200k(20_000));
  assert.ok(raw.includes(cellCode(0)));
  assert.ok(!raw.includes(cellCode(1)));
});

test('200k: 100_000 tokens (50%) → 5 cells', async () => {
  const raw = await runRaw(inp200k(100_000));
  assert.ok(raw.includes(cellCode(4)));
  assert.ok(!raw.includes(cellCode(5)));
});

test('200k: 180_000 tokens (90%) → 9 cells, ramp[8] = 196 red, no panic', async () => {
  const raw = await runRaw(inp200k(180_000));
  assert.ok(raw.includes(cellCode(8)));
  assert.ok(!raw.includes(cellCode(9)));
  assert.ok(!raw.includes(PANIC_CODE));
});

test('200k: 199_999 tokens → 9 cells, no panic', async () => {
  const raw = await runRaw(inp200k(199_999));
  assert.ok(raw.includes(cellCode(8)));
  assert.ok(!raw.includes(PANIC_CODE));
});

test('200k: 200_000 tokens → panic blink + skull', async () => {
  const raw = await runRaw(inp200k(200_000));
  assert.ok(raw.includes(PANIC_CODE));
  assert.ok(stripAnsi(raw).includes(SKULL));
});

// ─── 1M model — 50k tokens per cell, panic ≥ 500k ────────────────────────────

test('1M: 49_999 tokens → 0 cells', async () => {
  const raw = await runRaw(inp1M(49_999));
  assert.ok(!raw.includes(cellCode(0)));
});

test('1M: 50_000 tokens → 1 cell', async () => {
  const raw = await runRaw(inp1M(50_000));
  assert.ok(raw.includes(cellCode(0)));
  assert.ok(!raw.includes(cellCode(1)));
});

test('1M: 200_000 tokens → 4 cells (last = ramp[3] olive-amber)', async () => {
  const raw = await runRaw(inp1M(200_000));
  assert.ok(raw.includes(cellCode(3)));
  assert.ok(!raw.includes(cellCode(4)));
});

test('1M: 250_000 tokens → 5 cells', async () => {
  const raw = await runRaw(inp1M(250_000));
  assert.ok(raw.includes(cellCode(4)));
  assert.ok(!raw.includes(cellCode(5)));
});

test('1M: 450_000 tokens (90% of panic) → 9 cells, ramp[8] = 196 red, no panic', async () => {
  const raw = await runRaw(inp1M(450_000));
  assert.ok(raw.includes(cellCode(8)));
  assert.ok(!raw.includes(cellCode(9)));
  assert.ok(!raw.includes(PANIC_CODE));
});

test('1M: 499_999 tokens → 9 cells, no panic', async () => {
  const raw = await runRaw(inp1M(499_999));
  assert.ok(!raw.includes(PANIC_CODE));
});

test('1M: 500_000 tokens → panic blink + skull', async () => {
  const raw = await runRaw(inp1M(500_000));
  assert.ok(raw.includes(PANIC_CODE));
  assert.ok(stripAnsi(raw).includes(SKULL));
});

test('1M: 900_000 tokens → panic (still blinking past threshold)', async () => {
  const raw = await runRaw(inp1M(900_000));
  assert.ok(raw.includes(PANIC_CODE));
});

// ─── Detection boundary and cumulative-token guard ───────────────────────────

test('detection boundary: inferred totalCtx == 500k → standard tier (20k/cell)', async () => {
  // usedPct=80, tokens=400k → inferred 500k. `>` is strict, so standard tier kicks in.
  // In standard tier 400k tokens is well past panic (200k) → panic.
  const i = baseInput();
  i.context_window = { used_percentage: 80, total_input_tokens: 400_000 };
  const raw = await runRaw(i);
  assert.ok(raw.includes(PANIC_CODE));
});

test('cumulative-token guard: inferred totalCtx > 1.3M → standard tier', async () => {
  // usedPct=30, tokens=800k → inferred ~2.67M. Falls back to standard tier (200k panic).
  // 800k tokens >> 200k panic threshold → panic.
  const i = baseInput();
  i.context_window = { used_percentage: 30, total_input_tokens: 800_000 };
  const raw = await runRaw(i);
  assert.ok(raw.includes(PANIC_CODE));
});

test('cumulative-token guard upper edge: inferred totalCtx == 1.3M → standard tier', async () => {
  // usedPct=10, tokens=130k → inferred 1.3M exactly. `<` is strict, so standard tier.
  const i = baseInput();
  i.context_window = { used_percentage: 10, total_input_tokens: 130_000 };
  const raw = await runRaw(i);
  // 130k in standard tier = 6 cells (130k / 20k); not panicking.
  assert.ok(raw.includes(cellCode(5)));
  assert.ok(!raw.includes(PANIC_CODE));
});

test('usedPct=0 with non-zero tokens → fallback path, 0 cells, no panic', async () => {
  const i = baseInput();
  i.context_window = { used_percentage: 0, total_input_tokens: 5000 };
  const raw = await runRaw(i);
  // inputTokens>0 ⇒ token-driven path. 5000 < 20k step → 0 cells. No panic.
  assert.ok(!raw.includes(cellCode(0)));
  assert.ok(!raw.includes(PANIC_CODE));
});

// ─── Empty-cell rendering ────────────────────────────────────────────────────

test('empty cells use dim grey 240 (not default fg)', async () => {
  const raw = await runRaw(inpPct(20));
  assert.ok(raw.includes(EMPTY_CODE));
});
