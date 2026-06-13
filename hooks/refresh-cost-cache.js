#!/usr/bin/env node
'use strict';
const { resolveStateDir } = require('../lib/state');
const { loadPricing } = require('../lib/pricing');
const { aggregate, readCache, writeCache } = require('../lib/cost-aggregate');

// Only files touched in the last ~40 days matter for today/week/month windows
// (covers the current month + week spillover). Older transcripts are skipped.
const RETENTION_MS = 40 * 24 * 60 * 60 * 1000;

function main() {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  const stateDir = resolveStateDir(configDir);
  const pricing = loadPricing(stateDir);          // sync; may kick a background fetch
  const cache = readCache(stateDir);
  const result = aggregate(configDir, pricing, { sinceMtimeMs: Date.now() - RETENTION_MS, cache });
  // Skip the two full serializations + atomic writes when nothing changed since
  // the last run (every file hit the mtime+size cache and none disappeared) (#38).
  // Always write when there's no cache yet, so the first run populates it.
  if (result.dirty || !cache) writeCache(stateDir, result);
}

try { main(); } catch {}                          // never break the prompt
