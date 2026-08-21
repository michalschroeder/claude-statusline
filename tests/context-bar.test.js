'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { baseInput, runRaw, stripAnsi } = require('./helpers.js');

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
  // usedPct = tokens / 2000 ⇒ inferred total = 200k → standard tier.
  i.context_window = { used_percentage: tokens / 2000, total_input_tokens: tokens };
  return i;
}
function inp1M(tokens) {
  const i = baseInput();
  // usedPct = tokens / 10_000 ⇒ inferred total = 1M → 1M tier. Bar spans the full 1M
  // window (100k/cell), so fill = actual usage: 500k → 5 cells, matching the 50% label.
  i.context_window = { used_percentage: tokens / 10_000, total_input_tokens: tokens };
  return i;
}

test('null context — no bar emitted', async () => {
  assert.ok(!stripAnsi(await runRaw(baseInput())).includes('█'));
});

// ─── Percent-only fallback (no token info) — panic at ≥80% (restores prior contract) ─

test('fallback: 0% used → no filled cells, dim grey only', async () => {
  const raw = await runRaw(inpPct(0));
  assert.ok(raw.includes(EMPTY_CODE));
  for (let i = 0; i < 10; i++) assert.ok(!raw.includes(cellCode(i)));
  assert.ok(stripAnsi(raw).includes('0%'));
});

test('fallback: 50% used → 5 cells, last cell color ramp[4]', async () => {
  const raw = await runRaw(inpPct(50));
  assert.ok(raw.includes(cellCode(4)));
  assert.ok(!raw.includes(cellCode(5)));
  assert.ok(!raw.includes(PANIC_CODE));
  assert.ok(stripAnsi(raw).includes('50%'));
});

test('fallback: 79% used → 7 cells, no panic yet', async () => {
  const raw = await runRaw(inpPct(79));
  assert.ok(raw.includes(cellCode(6)));
  assert.ok(!raw.includes(cellCode(7)));
  assert.ok(!raw.includes(PANIC_CODE));
});

test('fallback: 80% used → panic blink + skull (early-warning contract)', async () => {
  const raw = await runRaw(inpPct(80));
  assert.ok(raw.includes(PANIC_CODE));
  assert.ok(stripAnsi(raw).includes(SKULL));
});

test('fallback: 100% used → panic blink + skull', async () => {
  const raw = await runRaw(inpPct(100));
  assert.ok(raw.includes(PANIC_CODE));
  assert.ok(stripAnsi(raw).includes(SKULL));
});

test('fallback: remaining_percentage=20 (80% used) → panic', async () => {
  const i = baseInput();
  i.context_window = { remaining_percentage: 20 };
  const raw = await runRaw(i);
  assert.ok(raw.includes(PANIC_CODE));
  assert.ok(stripAnsi(raw).includes(SKULL));
});

// ─── 200k model — 20k tokens / cell, panic at ≥160k (80%) ────────────────────

test('200k: 0 tokens → 0 cells filled', async () => {
  const raw = await runRaw(inp200k(0));
  for (let i = 0; i < 10; i++) assert.ok(!raw.includes(cellCode(i)));
});

test('200k: 19_999 tokens → 0 cells', async () => {
  const raw = await runRaw(inp200k(19_999));
  assert.ok(!raw.includes(cellCode(0)));
});

test('200k: 20_000 tokens → 1 cell (ramp[0] forest)', async () => {
  const raw = await runRaw(inp200k(20_000));
  assert.ok(raw.includes(cellCode(0)));
  assert.ok(!raw.includes(cellCode(1)));
});

test('200k: 100_000 tokens (50%) → 5 cells, no panic', async () => {
  const raw = await runRaw(inp200k(100_000));
  assert.ok(raw.includes(cellCode(4)));
  assert.ok(!raw.includes(cellCode(5)));
  assert.ok(!raw.includes(PANIC_CODE));
});

test('200k: 159_999 tokens → 7 cells, no panic', async () => {
  const raw = await runRaw(inp200k(159_999));
  assert.ok(raw.includes(cellCode(6)));
  assert.ok(!raw.includes(cellCode(7)));
  assert.ok(!raw.includes(PANIC_CODE));
});

test('200k: 160_000 tokens (80%) → panic blink + skull (early-warning contract)', async () => {
  const raw = await runRaw(inp200k(160_000));
  assert.ok(raw.includes(PANIC_CODE));
  assert.ok(stripAnsi(raw).includes(SKULL));
});

test('200k: 200_000 tokens → panic blink + skull', async () => {
  const raw = await runRaw(inp200k(200_000));
  assert.ok(raw.includes(PANIC_CODE));
  assert.ok(stripAnsi(raw).includes(SKULL));
});

// ─── 1M model — 100k tokens / cell (full window), panic at ≥500k (cell 5) ─────
// Bar fill = actual usage: 500k reads as a half-full bar and agrees with the "50%"
// label. The 500k danger line is conveyed by blink-red + skull, not a fake-full bar.

test('1M: 99_999 tokens → 0 cells', async () => {
  const raw = await runRaw(inp1M(99_999));
  assert.ok(!raw.includes(cellCode(0)));
});

test('1M: 100_000 tokens → 1 cell', async () => {
  const raw = await runRaw(inp1M(100_000));
  assert.ok(raw.includes(cellCode(0)));
  assert.ok(!raw.includes(cellCode(1)));
});

test('1M: 250_000 tokens (25%) → 2 cells, no panic', async () => {
  const raw = await runRaw(inp1M(250_000));
  assert.ok(raw.includes(cellCode(1)));
  assert.ok(!raw.includes(cellCode(2)));
  assert.ok(!raw.includes(PANIC_CODE));
});

test('1M: 400_000 tokens → 4 cells, no panic (1M tier panics only at 500k)', async () => {
  const raw = await runRaw(inp1M(400_000));
  assert.ok(raw.includes(cellCode(3)));
  assert.ok(!raw.includes(cellCode(4)));
  assert.ok(!raw.includes(PANIC_CODE));
});

test('1M: 499_999 tokens → 4 cells, no panic', async () => {
  const raw = await runRaw(inp1M(499_999));
  assert.ok(raw.includes(cellCode(3)));
  assert.ok(!raw.includes(cellCode(4)));
  assert.ok(!raw.includes(PANIC_CODE));
});

test('1M: 500_000 tokens (50%) → panic, honest half-full bar (5 cells)', async () => {
  const raw = await runRaw(inp1M(500_000));
  assert.ok(raw.includes(PANIC_CODE));
  assert.ok(stripAnsi(raw).includes(SKULL));
  assert.ok(stripAnsi(raw).includes('50%'));
  // 5 blink-red cells + 5 dim-grey empties — the bar still reads "half used".
  assert.equal(stripAnsi(raw).match(/█/g).length, 5);
  assert.ok(raw.includes(EMPTY_CODE));
});

test('1M: 900_000 tokens → panic; label shows raw used_percentage (90%)', async () => {
  const raw = await runRaw(inp1M(900_000));
  assert.ok(raw.includes(PANIC_CODE));
  assert.ok(stripAnsi(raw).includes('90%'));
});

test('1M: 218k tokens (22% of 1M) → label "22%" with bar at 2 cells', async () => {
  // The label and bar now agree: 218k is 22% of the 1M window → 2 filled cells.
  const raw = await runRaw(inp1M(218_000));
  assert.ok(stripAnsi(raw).includes('22%'));
  assert.ok(raw.includes(cellCode(1)));
  assert.ok(!raw.includes(cellCode(2)));
});

// ─── 1M detection band — tightened to (800k, 1.2M) ───────────────────────────

test('detection: inferred totalCtx 750k (cumulative-token leak) → 200k tier (panic)', async () => {
  // Old (500k, 1.3M) band would have falsely promoted this to 1M. New (800k, 1.2M)
  // band rejects it. 600k tokens >> 200k panic threshold → blink+skull panic.
  const i = baseInput();
  i.context_window = { used_percentage: 80, total_input_tokens: 600_000 };
  const raw = await runRaw(i);
  assert.ok(raw.includes(PANIC_CODE));
});

test('detection: inferred totalCtx 800k (lower edge) → still 200k tier', async () => {
  // usedPct=50, tokens=400k → inferred 800k exactly. Strict `>` excludes → standard tier.
  const i = baseInput();
  i.context_window = { used_percentage: 50, total_input_tokens: 400_000 };
  const raw = await runRaw(i);
  // 400k tokens >> 200k panic → blink+skull (would be 8 cells if treated as 1M).
  assert.ok(raw.includes(PANIC_CODE));
});

test('detection: inferred totalCtx 850k → 1M tier engages', async () => {
  // usedPct=20, tokens=170k → inferred 850k. Inside (800k, 1.2M).
  // 1M tier (full-window scale): 170k tokens → floor(170/100)=1 cell, no panic.
  const i = baseInput();
  i.context_window = { used_percentage: 20, total_input_tokens: 170_000 };
  const raw = await runRaw(i);
  assert.ok(raw.includes(cellCode(0)));
  assert.ok(!raw.includes(cellCode(1)));
  assert.ok(!raw.includes(PANIC_CODE));
});

test('detection: inferred totalCtx 1.2M (upper edge) → 200k tier', async () => {
  // usedPct=10, tokens=120k → inferred 1.2M exactly. Strict `<` excludes → standard tier.
  const i = baseInput();
  i.context_window = { used_percentage: 10, total_input_tokens: 120_000 };
  const raw = await runRaw(i);
  // 120k tokens in 200k tier = 6 cells, no panic (below 160k threshold).
  assert.ok(raw.includes(cellCode(5)));
  assert.ok(!raw.includes(cellCode(6)));
  assert.ok(!raw.includes(PANIC_CODE));
});

// ─── Degenerate input handling ───────────────────────────────────────────────

test('usedPct=0 with non-zero tokens → percent-only fallback (no premature coloring)', async () => {
  // Inference is unreliable when usedPct=0; we should NOT mis-color a possibly-1M
  // session as if it were 50% full of a 200k model.
  const i = baseInput();
  i.context_window = { used_percentage: 0, total_input_tokens: 100_000 };
  const raw = await runRaw(i);
  // Fallback path with usedPct=0 → 0 cells filled, no panic, no amber/yellow.
  for (let i = 0; i < 10; i++) assert.ok(!raw.includes(cellCode(i)));
  assert.ok(!raw.includes(PANIC_CODE));
});

// ─── displayPct floor: no "100%" without panic ───────────────────────────────

test('1M: 499_500 tokens (just below panic) → label "50%" (raw usedPct), no panic', async () => {
  // displayPct = round(usedPct) = round(49.95) = 50. Bar fills floor(499.5/100)=4 cells;
  // panic is at cell 5 (500k), so this is one cell short — no blink/skull yet.
  const raw = await runRaw(inp1M(499_500));
  assert.ok(stripAnsi(raw).includes('50%'));
  assert.ok(!raw.includes(PANIC_CODE));
});

// ─── Empty-cell rendering ────────────────────────────────────────────────────

test('empty cells use dim grey 240 (not default fg)', async () => {
  const raw = await runRaw(inpPct(20));
  assert.ok(raw.includes(EMPTY_CODE));
});

// ─── Label contract: the N% label MUST equal raw used_percentage ─────────────
// Lives above implementation details so a refactor that re-introduces "% of panic"
// or any other denominator gets caught immediately, regardless of bar-fill logic.

function extractLabelPct(plainText) {
  const m = plainText.match(/(\d+)%/);
  return m ? Number(m[1]) : null;
}

const labelCases = [
  // [used_percentage payload, total_input_tokens, expected label]
  { used: 0, tokens: undefined, label: 0 },
  { used: 5, tokens: 10_000, label: 5 },
  { used: 22, tokens: 218_000, label: 22 },   // 1M @ 22% — the live-session case
  { used: 25, tokens: 250_000, label: 25 },   // 1M @ 25%
  { used: 50, tokens: 100_000, label: 50 },   // 200k @ 50%
  { used: 50, tokens: 500_000, label: 50 },   // 1M panic — still raw payload
  { used: 80, tokens: 160_000, label: 80 },   // 200k @ panic threshold
  { used: 80, tokens: undefined, label: 80 }, // percent-only fallback panic
  { used: 90, tokens: 900_000, label: 90 },   // 1M @ 90% (panic)
  { used: 100, tokens: 200_000, label: 100 }, // 200k @ 100%
];

for (const { used, tokens, label } of labelCases) {
  test(`label contract: used_percentage=${used}${tokens ? ` tokens=${tokens}` : ''} → label "${label}%"`, async () => {
    const i = baseInput();
    i.context_window = { used_percentage: used };
    if (tokens !== undefined) i.context_window.total_input_tokens = tokens;
    const plain = stripAnsi(await runRaw(i));
    assert.equal(extractLabelPct(plain), label,
      `expected label ${label}%, got ${extractLabelPct(plain)}% in: ${plain}`);
  });
}
