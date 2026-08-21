'use strict';

// Parse STATUSLINE_MONTHLY_BUDGET → period budget limits. Strict Number parse
// (rejects trailing garbage so `500abc`/`$500` fall back). Empty/whitespace =
// unset. Explicit 0 → budgetOptedOut (renderer hides d/w/m). Negative/non-numeric
// → 1000 fallback. Limits derive proportionally: daily=monthly/30, weekly=monthly·7/30.
function resolveBudget(raw) {
  const parsed = raw != null && String(raw).trim() !== '' ? Number(raw) : NaN;
  const budgetOptedOut = parsed === 0;
  const monthly = parsed > 0 ? parsed : 1000;
  return { budgetOptedOut, monthly, daily: monthly / 30, weekly: monthly * 7 / 30 };
}

// Parse STATUSLINE_COST_MULTIPLIER → a display-time scale factor for the cost
// chips. Recomputed cost is API-equivalent (tokens × published per-token rates);
// a plan's own meter may value the same tokens differently — an Enterprise
// consumption meter is an org-level valuation, not a per-token invoice, and has
// been observed running ~1.15× our figure on the same tokens. This knob lets a
// user calibrate the DISPLAY to their meter without touching the recompute, which
// stays the honest API-equivalent basis. Unset/empty/non-numeric/≤0 → 1 (no-op);
// 0 is rejected rather than honoured because a zeroed chip conveys nothing.
function resolveCostMultiplier(raw) {
  const parsed = raw != null && String(raw).trim() !== '' ? Number(raw) : NaN;
  return isFinite(parsed) && parsed > 0 ? parsed : 1;
}

module.exports = { resolveBudget, resolveCostMultiplier };
