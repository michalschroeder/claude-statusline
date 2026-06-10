'use strict';

// Local-calendar window starts (unix ms): today's midnight, this week's Monday,
// the 1st of this month. getDay(): 0=Sun..6=Sat → Monday-based via (dow+6)%7.
function windowStarts(now) {
  const ms = (d) => d.getTime();
  const dow = (now.getDay() + 6) % 7;
  return {
    dayStart: ms(new Date(now.getFullYear(), now.getMonth(), now.getDate())),
    weekStart: ms(new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow)),
    monthStart: ms(new Date(now.getFullYear(), now.getMonth(), 1)),
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
function sumPeriods(perSession, now, excludeId) {
  const { dayStart, weekStart, monthStart } = windowStarts(now);
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
