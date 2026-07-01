'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { aggregate, readCache, readSummary, writeCache } = require('../lib/cost-aggregate');

const tmp = [];
after(() => { for (const d of tmp) fs.rmSync(d, { recursive: true, force: true }); });

// Minimal pricing: 1 unit per input token, nothing else. pricingHash 'test'.
const PRICING = { map: { m: { input: 1, output: 0, cacheWrite: 0, cacheRead: 0, webSearch: 0 } }, pricingHash: 'test' };

// Build a configDir with projects/<proj>/<id>.jsonl from given entries; set mtime.
function mkConfig(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-agg-')); tmp.push(root);
  for (const f of files) {
    const dir = path.join(root, 'projects', f.proj || 'p');
    fs.mkdirSync(dir, { recursive: true });
    const fp = path.join(dir, `${f.id}.jsonl`);
    fs.writeFileSync(fp, f.entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
    if (f.mtime) fs.utimesSync(fp, new Date(f.mtime), new Date(f.mtime));
  }
  return root;
}

const asst = (id, model, input, ts) => ({ type: 'assistant', timestamp: ts, message: { id, model, usage: { input_tokens: input } } });

test('within-file dedup keeps last occurrence per id', () => {
  const root = mkConfig([{ id: 's1', entries: [
    asst('msg1', 'm', 10, '2026-06-10T10:00:00Z'),
    asst('msg1', 'm', 50, '2026-06-10T10:00:01Z'), // final usage
  ] }]);
  const r = aggregate(root, PRICING);
  assert.equal(r.perSession.s1.total, 50);
});

test('global dedup: resumed session replaying ids not double-counted', () => {
  const root = mkConfig([
    { id: 's1', mtime: '2026-06-10T10:00:00Z', entries: [asst('msg1', 'm', 30, '2026-06-10T10:00:00Z')] },
    { id: 's2', mtime: '2026-06-10T11:00:00Z', entries: [
      asst('msg1', 'm', 30, '2026-06-10T10:00:00Z'), // replay of s1's msg1
      asst('msg2', 'm', 7, '2026-06-10T11:00:00Z'),
    ] },
  ]);
  const r = aggregate(root, PRICING);
  // msg1 counted once (in s1, older mtime), msg2 once.
  assert.equal(r.byDay['2026-06-10'], 30 + 7);
  assert.equal(r.perSession.s1.total, 30);
  assert.equal(r.perSession.s2.total, 7);
});

test('per-call day bucketing splits across midnight (local)', () => {
  // 2026-06-10T01:00:00Z and 2026-06-12T01:00:00Z are >1 day apart in any TZ.
  const root = mkConfig([{ id: 's1', entries: [
    asst('a', 'm', 1, '2026-06-10T01:00:00Z'),
    asst('b', 'm', 2, '2026-06-12T01:00:00Z'),
  ] }]);
  const r = aggregate(root, PRICING);
  const days = Object.keys(r.perSession.s1.days).sort();
  assert.equal(days.length, 2);
});

test('unknown model → $0', () => {
  const root = mkConfig([{ id: 's1', entries: [asst('x', 'who-knows', 1000, '2026-06-10T10:00:00Z')] }]);
  assert.equal(aggregate(root, PRICING).perSession.s1.total, 0);
});

test('sinceMtimeMs skips old files', () => {
  const root = mkConfig([
    { id: 'old', mtime: '2026-01-01T00:00:00Z', entries: [asst('o', 'm', 100, '2026-01-01T00:00:00Z')] },
    { id: 'new', mtime: '2026-06-10T00:00:00Z', entries: [asst('n', 'm', 5, '2026-06-10T00:00:00Z')] },
  ]);
  const r = aggregate(root, PRICING, { sinceMtimeMs: new Date('2026-06-01T00:00:00Z').getTime() });
  assert.equal(r.perSession.old, undefined);
  assert.equal(r.perSession.new.total, 5);
});

test('incremental: unchanged file reuses cached calls; pricing change rebuilds', () => {
  const root = mkConfig([{ id: 's1', mtime: '2026-06-10T10:00:00Z', entries: [asst('a', 'm', 4, '2026-06-10T10:00:00Z')] }]);
  const first = aggregate(root, PRICING);
  const second = aggregate(root, PRICING, { cache: { pricingHash: 'test', files: first.files } });
  assert.equal(second.perSession.s1.total, 4);
  const PRICING2 = { map: { m: { input: 2, output: 0, cacheWrite: 0, cacheRead: 0, webSearch: 0 } }, pricingHash: 'other' };
  const third = aggregate(root, PRICING2, { cache: { pricingHash: 'test', files: first.files } });
  assert.equal(third.perSession.s1.total, 8);
});

test('dirty flag: fresh run dirty; unchanged re-run clean; eviction dirties (#38)', () => {
  const root = mkConfig([{ id: 's1', mtime: '2026-06-10T10:00:00Z', entries: [asst('a', 'm', 4, '2026-06-10T10:00:00Z')] }]);
  const first = aggregate(root, PRICING, { tz: undefined });
  assert.equal(first.dirty, true, 'first run parses → dirty');
  const cache = { pricingHash: 'test', tz: undefined, files: first.files };
  const second = aggregate(root, PRICING, { tz: undefined, cache });
  assert.equal(second.dirty, false, 'unchanged re-run → clean (skips write)');
  // a previously-cached file gone from candidates must force a write (eviction)
  const empty = aggregate(mkConfig([]), PRICING, { tz: undefined, cache });
  assert.equal(empty.dirty, true, 'cached file disappeared → dirty');
});

test('opts.tz buckets a boundary call into the tz-local day', () => {
  // 02:30 UTC on the 11th: the 10th in LA, the 11th in Tokyo.
  const root = mkConfig([{ id: 's1', entries: [asst('a', 'm', 1, '2026-06-11T02:30:00Z')] }]);
  assert.deepEqual(Object.keys(aggregate(root, PRICING, { tz: 'America/Los_Angeles' }).perSession.s1.days), ['2026-06-10']);
  assert.deepEqual(Object.keys(aggregate(root, PRICING, { tz: 'Asia/Tokyo' }).perSession.s1.days), ['2026-06-11']);
});

test('tz change invalidates the incremental cache (re-buckets stale calls)', () => {
  const root = mkConfig([{ id: 's1', mtime: '2026-06-11T02:30:00Z', entries: [asst('a', 'm', 1, '2026-06-11T02:30:00Z')] }]);
  const first = aggregate(root, PRICING, { tz: 'America/Los_Angeles' });
  assert.equal(first.tz, 'America/Los_Angeles');
  // Same files, but a different tz → cache is stale, so it must re-parse, not reuse.
  const second = aggregate(root, PRICING, { tz: 'Asia/Tokyo', cache: { pricingHash: 'test', tz: 'America/Los_Angeles', files: first.files } });
  assert.deepEqual(Object.keys(second.perSession.s1.days), ['2026-06-11']);
});

test('readCache/writeCache round-trip', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-cache-')); tmp.push(stateDir);
  assert.equal(readCache(stateDir), null);
  writeCache(stateDir, { pricingHash: 'h', files: { x: 1 }, perSession: { s: { days: {}, total: 0 } } });
  const c = readCache(stateDir);
  assert.equal(c.pricingHash, 'h');
  assert.deepEqual(c.perSession.s, { days: {}, total: 0 });
});

test('incremental cache + cross-file replay: cached file still seeds global dedup', () => {
  // File A (older, cached) owns msg1; file B (newer, re-parsed) replays msg1 + adds msg2.
  // Even though A's calls come from cache, A's ids must seed `seen` before B is walked.
  const root = mkConfig([
    { id: 's1', proj: 'p', mtime: '2026-06-10T10:00:00Z', entries: [asst('msg1', 'm', 30, '2026-06-10T10:00:00Z')] },
  ]);
  const first = aggregate(root, PRICING);
  // Now add file B replaying msg1; A is unchanged (cache hit), B is new (parsed).
  const fs = require('fs'); const path = require('path');
  const dir = path.join(root, 'projects', 'p');
  const fpB = path.join(dir, 's2.jsonl');
  fs.writeFileSync(fpB, [
    JSON.stringify(asst('msg1', 'm', 30, '2026-06-10T10:00:00Z')),
    JSON.stringify(asst('msg2', 'm', 7, '2026-06-10T11:00:00Z')),
  ].join('\n') + '\n');
  fs.utimesSync(fpB, new Date('2026-06-10T11:00:00Z'), new Date('2026-06-10T11:00:00Z'));
  const second = aggregate(root, PRICING, { cache: { pricingHash: 'test', files: first.files } });
  assert.equal(second.byDay['2026-06-10'], 30 + 7); // msg1 not double-counted
  assert.equal(second.perSession.s1.total, 30);
  assert.equal(second.perSession.s2.total, 7);
});

test('id-less (synthetic) calls are counted in every file, never globally deduped', () => {
  const noId = (model, input, ts) => ({ type: 'assistant', timestamp: ts, message: { model, usage: { input_tokens: input } } });
  const root = mkConfig([
    { id: 's1', entries: [noId('m', 5, '2026-06-10T10:00:00Z')] },
    { id: 's2', entries: [noId('m', 5, '2026-06-10T11:00:00Z')] },
  ]);
  const r = aggregate(root, PRICING);
  assert.equal(r.byDay['2026-06-10'], 10); // both counted (5 + 5), not deduped to 5
});

test('subagent transcripts counted, attributed to parent session', () => {
  const root = mkConfig([{ id: 's1', proj: 'p', entries: [asst('a', 'm', 3, '2026-06-10T10:00:00Z')] }]);
  // Add <s1>/subagents/agent-x.jsonl (+ a .meta.json that must be ignored).
  const subDir = path.join(root, 'projects', 'p', 's1', 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, 'agent-x.jsonl'),
    JSON.stringify(asst('sub1', 'm', 9, '2026-06-10T10:05:00Z')) + '\n');
  fs.writeFileSync(path.join(subDir, 'agent-x.meta.json'), '{"ignored":true}');
  // A non-agent sidecar .jsonl under subagents/ must NOT be billed.
  fs.writeFileSync(path.join(subDir, 'summary.jsonl'),
    JSON.stringify(asst('side1', 'm', 1000, '2026-06-10T10:06:00Z')) + '\n');
  const r = aggregate(root, PRICING);
  assert.equal(r.perSession.s1.total, 3 + 9); // subagent folded in; summary.jsonl ignored
  assert.equal(r.byDay['2026-06-10'], 12);
});

test('resumed old session: subagent in-window via parent mtime, not its own (#30)', () => {
  // Main transcript freshly resumed (mtime now), subagent file untouched (old mtime).
  const root = mkConfig([{ id: 's1', proj: 'p', mtime: '2026-06-13T10:00:00Z',
    entries: [asst('a', 'm', 3, '2026-06-13T10:00:00Z')] }]);
  const subDir = path.join(root, 'projects', 'p', 's1', 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  const subFile = path.join(subDir, 'agent-x.jsonl');
  fs.writeFileSync(subFile, JSON.stringify(asst('sub1', 'm', 9, '2026-05-01T10:00:00Z')) + '\n');
  fs.utimesSync(subFile, new Date('2026-05-01T10:00:00Z'), new Date('2026-05-01T10:00:00Z'));
  // Window bound excludes the subagent's own old mtime, but the parent main file
  // is in-window → subagent cost still folded in.
  const r = aggregate(root, PRICING, { sinceMtimeMs: new Date('2026-06-01T00:00:00Z').getTime() });
  assert.equal(r.perSession.s1.total, 3 + 9);
});

test('orphan old subagent (no in-window parent) still excluded (#30)', () => {
  // Both main and subagent are old → both out of window, subagent stays excluded.
  const root = mkConfig([{ id: 's1', proj: 'p', mtime: '2026-05-01T10:00:00Z',
    entries: [asst('a', 'm', 3, '2026-05-01T10:00:00Z')] }]);
  const subDir = path.join(root, 'projects', 'p', 's1', 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  const subFile = path.join(subDir, 'agent-x.jsonl');
  fs.writeFileSync(subFile, JSON.stringify(asst('sub1', 'm', 9, '2026-05-01T10:00:00Z')) + '\n');
  fs.utimesSync(subFile, new Date('2026-05-01T10:00:00Z'), new Date('2026-05-01T10:00:00Z'));
  const r = aggregate(root, PRICING, { sinceMtimeMs: new Date('2026-06-01T00:00:00Z').getTime() });
  assert.equal(r.perSession.s1, undefined);
});

test('writeCache emits slim cost-summary.json; readSummary prefers it over full cache', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-sum-')); tmp.push(stateDir);
  writeCache(stateDir, {
    pricingHash: 'h',
    files: { '/big.jsonl': { mtime: 1, size: 2, sessionId: 's', calls: [{ id: 'a', cost: 1, dayKey: '2026-06-10' }] } },
    perSession: { s: { days: { '2026-06-10': 1 }, total: 1 } },
  });
  const summary = JSON.parse(fs.readFileSync(path.join(stateDir, 'cost-summary.json'), 'utf8'));
  assert.equal(summary.files, undefined);           // no bulky blob in the slim file
  assert.deepEqual(summary.perSession.s, { days: { '2026-06-10': 1 }, total: 1 });
  assert.deepEqual(readSummary(stateDir).perSession.s, { days: { '2026-06-10': 1 }, total: 1 });
});

test('readSummary falls back to full cost-cache.json when summary absent', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-sum2-')); tmp.push(stateDir);
  fs.writeFileSync(path.join(stateDir, 'cost-cache.json'),
    JSON.stringify({ pricingHash: 'h', files: {}, perSession: { s: { days: {}, total: 7 } } }));
  assert.equal(readSummary(stateDir).perSession.s.total, 7);
});

test('enumerates files across multiple project dirs', () => {
  const root = mkConfig([
    { id: 's1', proj: 'projA', entries: [asst('a', 'm', 3, '2026-06-10T10:00:00Z')] },
    { id: 's2', proj: 'projB', entries: [asst('b', 'm', 4, '2026-06-10T10:00:00Z')] },
  ]);
  const r = aggregate(root, PRICING);
  assert.equal(r.perSession.s1.total, 3);
  assert.equal(r.perSession.s2.total, 4);
  assert.equal(r.byDay['2026-06-10'], 7);
});
