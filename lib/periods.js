'use strict';
const { resolveTimezone, ymd } = require('./timezone');

// Calendar window starts (unix ms): today's midnight, this week's Monday, the 1st
// of this month, all in `tz` (STATUSLINE_TIMEZONE) or system-local. The calendar
// date is taken in `tz` but the edge ms is built with system-local `new Date` to
// match dayKeyMs below — comparisons are pure date ordering, so the offset cancels.
// getDay(): 0=Sun..6=Sat → Monday-based via (dow+6)%7.
function windowStarts(now, tz = resolveTimezone()) {
  const { y, m, d } = ymd(now, tz);
  const day0 = new Date(y, m - 1, d);
  const dow = (day0.getDay() + 6) % 7;
  return {
    dayStart: day0.getTime(),
    weekStart: new Date(y, m - 1, d - dow).getTime(),
    monthStart: new Date(y, m - 1, 1).getTime(),
  };
}

// 'YYYY-MM-DD' → local-midnight unix ms, or NaN.
function dayKeyMs(k) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : NaN;
}

// Sum a perSession map's day-buckets into {daily, weekly, monthly} relative to
// `now`'s local windows. `excludeId` omits one session (the live one, folded
// separately by the renderer).
function sumPeriods(perSession, now, excludeId, tz = resolveTimezone()) {
  const { dayStart, weekStart, monthStart } = windowStarts(now, tz);
  let daily = 0, weekly = 0, monthly = 0;
  for (const [id, ps] of Object.entries(perSession || {})) {
    if (id === excludeId || !ps || !ps.days) continue;
    for (const [k, cost] of Object.entries(ps.days)) {
      const t = dayKeyMs(k);
      if (isNaN(t)) continue;
      if (t >= dayStart) daily += cost;
      if (t >= weekStart) weekly += cost;
      if (t >= monthStart) monthly += cost;
    }
  }
  return { daily, weekly, monthly };
}

module.exports = { windowStarts, dayKeyMs, sumPeriods };
