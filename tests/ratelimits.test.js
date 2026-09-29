'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { baseInput, run, runRaw } = require('./helpers.js');

// 2026-10-01T00:00:00Z — the real reset instant (00:00 UTC on the 1st).
const RESETS_AT = Date.UTC(2026, 9, 1) / 1000;

function withSpend(spend_limit, extra = {}) {
  const i = baseInput();
  i.rate_limits = { ...extra, spend_limit };
  return i;
}

const full = (over = {}) => ({
  used_percentage: 54.28, resets_at: RESETS_AT, used_usd: 271.4, limit_usd: 500, period: 'this month', ...over,
});

test('spend limit: usd form with period and reset date', async () => {
  const out = await run(withSpend(full()));
  assert.match(out, /󰖄 \$271\.40\/\$500\.00 this month ↻ Oct 1/);
});

test('spend limit: small amounts keep cents', async () => {
  const out = await run(withSpend(full({ used_usd: 12.5, limit_usd: 50, used_percentage: 25 })));
  assert.match(out, /\$12\.50\/\$50\.00/);
});

test('spend limit: pre-2.1.284 payload (no usd) falls back to %', async () => {
  const out = await run(withSpend({ used_percentage: 62.8, resets_at: RESETS_AT }));
  assert.match(out, /󰖄 62% ↻ Oct 1/);
  assert.doesNotMatch(out, /\$/);
});

test('spend limit: appended after 5h/7d with the rsep', async () => {
  const out = await run(withSpend(full(), { five_hour: { used_percentage: 12 }, seven_day: { used_percentage: 40 } }));
  assert.match(out, /󰔚 5h 12% · 󰃭 7d 40% · 󰖄 \$271\.40\/\$500\.00/);
});

test('spend limit: absent → no chip, 5h/7d unchanged', async () => {
  const out = await run(withSpend(undefined, { five_hour: { used_percentage: 12 } }));
  assert.match(out, /󰔚 5h 12%/);
  assert.doesNotMatch(out, /󰖄/);
});

test('spend limit: % form colour dim <80, yellow ≥80, red ≥100', async () => {
  const dim = await runRaw(withSpend({ used_percentage: 54 }));
  const yellow = await runRaw(withSpend({ used_percentage: 88 }));
  const red = await runRaw(withSpend({ used_percentage: 104 }));
  assert.ok(dim.includes('\x1b[2m󰖄'));
  assert.ok(yellow.includes('\x1b[33m󰖄'));
  assert.ok(red.includes('\x1b[31m󰖄'));
});

test('spend limit: ascii icon set', async () => {
  const out = await run(withSpend(full()), { STATUSLINE_ICONS: 'ascii' });
  assert.match(out, /spend \$271\.40\/\$500\.00 this month reset Oct 1/);
});

test('spend limit: usd form colours from usd, not used_percentage', async () => {
  const raw = await runRaw(withSpend({ used_usd: 600, limit_usd: 500, used_percentage: 50, period: 'this month' }));
  assert.ok(raw.includes('\x1b[31m󰖄'));
});

test('spend limit: text never reads at-limit while not red', async () => {
  const usd = await runRaw(withSpend(full({ used_usd: 999.6, limit_usd: 1000, used_percentage: 100 })));
  assert.ok(usd.includes('\x1b[33m󰖄 $999.60/$1000.00'));
  const pct = await run(withSpend({ used_percentage: 99.6, resets_at: RESETS_AT }));
  assert.match(pct, /󰖄 99%/);
});

test('spend limit: reset date in UTC, not STATUSLINE_TIMEZONE', async () => {
  const out = await run(withSpend(full()), { STATUSLINE_TIMEZONE: 'America/Los_Angeles', TZ: 'America/Los_Angeles' });
  assert.match(out, /↻ Oct 1/);
});

test('spend limit: string limit_usd falls back to %, statusline survives', async () => {
  const out = await run(withSpend({ used_percentage: 2, used_usd: 10, limit_usd: '500', period: 'this month' }));
  assert.match(out, /Claude/);
  assert.match(out, /󰖄 2%/);
});

test('spend limit: amount rounding to the limit renders red', async () => {
  const raw = await runRaw(withSpend(full({ used_usd: 999.996, limit_usd: 1000 })));
  assert.ok(raw.includes('\x1b[31m󰖄 $1000.00/$1000.00'));
});

test('spend limit: non-monthly period shows local date + time', async () => {
  const at = Date.UTC(2026, 8, 30, 7, 5) / 1000;
  const out = await run(withSpend(full({ period: 'today', resets_at: at })), { TZ: 'America/Los_Angeles' });
  assert.match(out, /today ↻ Sep 30 00:05/);
});
