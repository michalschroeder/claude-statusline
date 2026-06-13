'use strict';

/**
 * Format a number with k/M suffixes for compact display.
 * 523 → "523", 4500 → "4.5k", 15000 → "15k", 1200000 → "1.2M".
 * Returns '' for null/≤0 (callers that want "0" should coalesce).
 *
 * Single source of truth for compact token counts — shared by the statusline
 * renderer (`hooks/statusline.js`) and the session viewer (`bin/sessions.js`)
 * so the same magnitude renders identically in both.
 */
function formatCompact(n) {
  if (n == null || n <= 0) return '';
  if (n < 1000) return String(Math.round(n));
  if (n < 10000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  if (n < 1000000) return Math.round(n / 1000) + 'k';
  return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
}

module.exports = { formatCompact };
