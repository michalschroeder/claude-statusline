'use strict';

// Shared ANSI color primitives + the cost-severity tier ladder. Single source of
// truth for both the renderer (hooks/statusline.js) and the viewer (bin/sessions.js).
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const orange = (s) => `\x1b[38;5;208m${s}\x1b[0m`;

// Cost color ladder, low→high severity. `thresholds` are the upper bounds for the
// first three tiers; anything at/above the last threshold is red.
const COST_TIERS = [green, yellow, orange, red];
function colorByTier(value, thresholds) {
  for (let i = 0; i < thresholds.length; i++) {
    if (value < thresholds[i]) return COST_TIERS[i];
  }
  return COST_TIERS[COST_TIERS.length - 1];
}

// Threshold tuples for colorByTier — part of the contract (tested). SESSION_TIERS:
// absolute USD for the session cost. BUDGET_TIERS: ratio of cost/limit for periods
// (reddens at 90%, before the limit is hit). Shared so renderer + viewer agree.
const SESSION_TIERS = [1, 5, 10];
const BUDGET_TIERS = [0.5, 0.75, 0.9];

module.exports = { dim, bold, green, yellow, orange, red, COST_TIERS, colorByTier, SESSION_TIERS, BUDGET_TIERS };
