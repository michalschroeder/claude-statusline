'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { baseInput, run, runRaw } = require('./helpers.js');

// 2026-10-01T12:00:00Z — "Oct 1" in UTC.
const RESETS_AT = Date.UTC(2026, 9, 1, 12) / 1000;
const TZ = { STATUSLINE_TIMEZONE: 'UTC' };

function withSpend(spend_limit, extra = {}) {
  const i = baseInput();
  i.rate_limits = { ...extra, spend_limit };
  return i;
}

const full = (over = {}) => ({
  used_percentage: 54.28, resets_at: RESETS_AT, used_usd: 271.4, limit_usd: 500, period: 'this month', ...over,
});

test('spend limit: usd form with period and reset date', async () => {
  const out = await run(withSpend(full()), TZ);
  assert.match(out, /󰖄 \$271\/\$500 this month ↻ Oct 1/);
});

test('spend limit: amounts under $100 keep cents', async () => {
  const out = await run(withSpend(full({ used_usd: 12.5, limit_usd: 50, used_percentage: 25 })), TZ);
  assert.match(out, /\$12\.50\/\$50\.00/);
});

test('spend limit: pre-2.1.284 payload (no usd) falls back to %', async () => {
  const out = await run(withSpend({ used_percentage: 62.8, resets_at: RESETS_AT }), TZ);
  assert.match(out, /󰖄 63% ↻ Oct 1/);
  assert.doesNotMatch(out, /\$/);
});

test('spend limit: appended after 5h/7d with the rsep', async () => {
  const out = await run(withSpend(full(), { five_hour: { used_percentage: 12 }, seven_day: { used_percentage: 40 } }), TZ);
  assert.match(out, /󰔚 5h 12% · 󰃭 7d 40% · 󰖄 \$271\/\$500/);
});

test('spend limit: absent → no chip, 5h/7d unchanged', async () => {
  const out = await run(withSpend(undefined, { five_hour: { used_percentage: 12 } }));
  assert.match(out, /󰔚 5h 12%/);
  assert.doesNotMatch(out, /󰖄/);
});

test('spend limit: colour dim <80, yellow ≥80, red ≥100', async () => {
  const dim = await runRaw(withSpend(full({ used_percentage: 54 })), TZ);
  const yellow = await runRaw(withSpend(full({ used_percentage: 88 })), TZ);
  const red = await runRaw(withSpend(full({ used_percentage: 104 })), TZ);
  assert.ok(dim.includes('\x1b[2m󰖄'));
  assert.ok(yellow.includes('\x1b[33m󰖄'));
  assert.ok(red.includes('\x1b[31m󰖄'));
});

test('spend limit: ascii icon set', async () => {
  const out = await run(withSpend(full()), { ...TZ, STATUSLINE_ICONS: 'ascii' });
  assert.match(out, /spend \$271\/\$500 this month reset Oct 1/);
});
