'use strict';

// Optional STATUSLINE_TIMEZONE override for cost day-bucketing / d-w-m windows.
// An IANA name (e.g. 'Europe/Warsaw'); unset/empty/invalid → system local time.
// Both the bucketing (lib/cost-aggregate dayKey) and the window boundaries
// (lib/periods windowStarts) read this so a call's day and the "today/week/month"
// edges are decided under one clock — they must agree or the sums drift.

let cachedKey;   // last-seen raw env value ('' when unset)
let cachedTz;    // validated tz (string) or undefined for system-local
// Resolve+validate the env override. Memoized on the raw value so repeated calls
// (dayKey runs per assistant call) don't reconstruct a formatter each time.
function resolveTimezone(env = process.env) {
  const raw = env.STATUSLINE_TIMEZONE || '';
  if (raw === cachedKey) return cachedTz;
  cachedKey = raw;
  cachedTz = undefined;
  if (raw) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: raw }); cachedTz = raw; }
    catch { cachedTz = undefined; } // invalid name → silent fall back to local
  }
  return cachedTz;
}

const fmtCache = new Map(); // tz -> Intl.DateTimeFormat
function fmtFor(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

// Calendar {y, m, d} (m 1-based) of `date` in `tz`, or system-local when tz is
// falsy. Callers turn this into a bucket string and into window edges via
// system-local `new Date(y, m-1, d)` — the offset cancels since both sides do.
function ymd(date, tz) {
  if (!tz) return { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() };
  const parts = fmtFor(tz).formatToParts(date);
  const g = (t) => +parts.find((p) => p.type === t).value;
  return { y: g('year'), m: g('month'), d: g('day') };
}

module.exports = { resolveTimezone, ymd };
