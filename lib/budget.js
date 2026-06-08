'use strict';

// Parse STATUSLINE_MONTHLY_BUDGET → period budget limits. Strict Number parse
// (rejects trailing garbage so `500abc`/`$500` fall back). Empty/whitespace =
// unset. Explicit 0 → budgetOptedOut (renderer hides d/w/m). Negative/non-numeric
// → 500 fallback. Limits derive proportionally: daily=monthly/30, weekly=monthly·7/30.
function resolveBudget(raw) {
  const parsed = raw != null && String(raw).trim() !== '' ? Number(raw) : NaN;
  const budgetOptedOut = parsed === 0;
  const monthly = parsed > 0 ? parsed : 500;
  return { budgetOptedOut, monthly, daily: monthly / 30, weekly: monthly * 7 / 30 };
}

module.exports = { resolveBudget };
