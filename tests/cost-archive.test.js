'use strict';
// Append-only ledger: Claude Code prunes transcripts at cleanupPeriodDays
// (default 30), and `files` is rebuilt from what exists on disk — so a deleted
// transcript's spend must survive in `archived` or it vanishes from d/w/m.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { aggregate, writeCache, readCache } = require('../lib/cost-aggregate');

const tmp = [];
after(() => { for (const d of tmp) fs.rmSync(d, { recursive: true, force: true }); });

const PRICING = { map: { m: { input: 1, output: 0, cacheWrite: 0, cacheRead: 0, webSearch: 0 } }, pricingHash: 'test' };
const asst = (id, input, ts) => ({ type: 'assistant', timestamp: ts, message: { id, model: 'm', usage: { input_tokens: input } } });

function mkRoot() { const r = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-arc-')); tmp.push(r); return r; }
function writeSession(root, id, entries) {
  const dir = path.join(root, 'projects', 'p');
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(fp, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return fp;
}
const agg = (root, cache) => aggregate(root, PRICING, { tz: undefined, cache });
const toCache = (r) => ({ pricingHash: r.pricingHash, tz: r.tz, files: r.files, archived: r.archived });

test('deleted transcript keeps its day-buckets and session total', () => {
  const root = mkRoot();
  const fp = writeSession(root, 's1', [asst('a', 7, '2026-06-10T10:00:00Z')]);
  const first = agg(root);
  assert.equal(first.byDay['2026-06-10'], 7);

  fs.rmSync(fp);                                   // Claude Code's 30-day prune
  const after1 = agg(root, toCache(first));
  assert.equal(after1.byDay['2026-06-10'], 7, 'day bucket survives deletion');
  assert.equal(after1.perSession.s1.total, 7, 'session total survives deletion');
  assert.equal(after1.dirty, true, 'archiving forces a cache write');
  assert.deepEqual(after1.archived[fp], { sessionId: 's1', days: { '2026-06-10': 7 } });
});

test('archive is not double-counted when it is carried forward', () => {
  const root = mkRoot();
  const fp = writeSession(root, 's1', [asst('a', 7, '2026-06-10T10:00:00Z')]);
  const first = agg(root);
  fs.rmSync(fp);
  const second = agg(root, toCache(first));
  const third = agg(root, toCache(second));       // archive re-read, file still gone
  assert.equal(third.byDay['2026-06-10'], 7, 'still 7, not 14');
  assert.equal(third.perSession.s1.total, 7);
  assert.equal(third.dirty, false, 'steady state → no rewrite');
});

test('a live transcript is never archived, so it is not counted twice', () => {
  const root = mkRoot();
  writeSession(root, 's1', [asst('a', 7, '2026-06-10T10:00:00Z')]);
  const first = agg(root);
  // Dropped from candidates by the window bound, but still on disk.
  const windowed = aggregate(root, PRICING, { tz: undefined, cache: toCache(first), sinceMtimeMs: Date.now() + 1e6 });
  assert.equal(windowed.archived && Object.keys(windowed.archived).length, 0, 'exists on disk → not archived');
  const back = agg(root, toCache(windowed));
  assert.equal(back.byDay['2026-06-10'], 7, 'reparsed once, not archive + file');
});

test('deleted and live sessions sum together on the same day', () => {
  const root = mkRoot();
  const gone = writeSession(root, 's1', [asst('a', 4, '2026-06-10T10:00:00Z')]);
  const first = agg(root);
  fs.rmSync(gone);
  writeSession(root, 's2', [asst('b', 6, '2026-06-10T11:00:00Z')]);
  const second = agg(root, toCache(first));
  assert.equal(second.byDay['2026-06-10'], 10);
  assert.equal(second.perSession.s1.total, 4);
  assert.equal(second.perSession.s2.total, 6);
});

test('archive survives a pricing-hash change (source file is gone, cannot reprice)', () => {
  const root = mkRoot();
  const fp = writeSession(root, 's1', [asst('a', 7, '2026-06-10T10:00:00Z')]);
  const first = agg(root);
  fs.rmSync(fp);
  const archivedRun = agg(root, toCache(first));
  const repriced = aggregate(root, { map: PRICING.map, pricingHash: 'DIFFERENT' },
    { tz: undefined, cache: toCache(archivedRun) });
  assert.equal(repriced.byDay['2026-06-10'], 7, 'kept at its recorded cost');
});

test('writeCache round-trips the archive', () => {
  const root = mkRoot();
  const state = mkRoot();
  const fp = writeSession(root, 's1', [asst('a', 7, '2026-06-10T10:00:00Z')]);
  const first = agg(root);
  fs.rmSync(fp);
  const second = agg(root, toCache(first));
  writeCache(state, second);
  assert.deepEqual(readCache(state).archived[fp], { sessionId: 's1', days: { '2026-06-10': 7 } });
});
