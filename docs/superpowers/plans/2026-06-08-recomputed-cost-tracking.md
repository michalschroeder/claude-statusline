# Recomputed Cross-Session Cost Tracking — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore session + daily/weekly/monthly cost on the statusline and the session viewer, computed from raw token counts × LiteLLM per-token prices (never trusting Claude's `cost.total_cost_usd`).

**Architecture:** Pure cost math (`lib/cost-compute.js`) + a LiteLLM price table (`lib/pricing.js`) feed a shared aggregator (`lib/cost-aggregate.js`) that parses transcripts, globally dedups streaming message ids, and buckets per-call into local day keys. A `UserPromptSubmit` hook (`hooks/refresh-cost-cache.js`) rebuilds an incremental `cost-cache.json` off the render hot path. The renderer reads that cache (cheap), sums today/week/month excluding the current session, and folds in the current session's live payload cost. The viewer aggregates full history on demand.

**Tech Stack:** Pure Node stdlib (Node 18+), `node:test`, no build step, no deps.

---

## Spec reference

Design: `docs/superpowers/specs/2026-06-08-recomputed-cost-tracking-design.md`
Algorithm: `docs/claude-code-cost-replication.md` (in the `codeburn` repo) — §3–§7.

## File structure

| File | Responsibility |
|---|---|
| `data/model_prices.json` | **Create.** Bundled curated LiteLLM-shaped price snapshot (Claude models), offline fallback. |
| `lib/cost-compute.js` | **Create.** Pure per-call math: `extractCacheCreation`, `calculateCost`. No IO. |
| `lib/pricing.js` | **Create.** Load/sanitize price table, model lookup, ≤24h background fetch. |
| `lib/budget.js` | **Create.** `resolveBudget` (restored from removed `lib/cost.js`). |
| `lib/periods.js` | **Create.** Local-calendar window math + `sumPeriods`. |
| `lib/cost-aggregate.js` | **Create.** Transcript parse, dedup, day-bucketing, incremental cache I/O. |
| `lib/color.js` | **Modify.** Add `BUDGET_TIERS` to exports. |
| `hooks/refresh-cost-cache.js` | **Create.** `UserPromptSubmit` hook that rebuilds `cost-cache.json`. |
| `hooks/statusline.js` | **Modify.** Render s/d/w/m chip group from cache + live fold. |
| `bin/sessions.js` | **Modify.** Add per-session COST column + d/w/m footer. |
| `tests/*` | **Create/modify** one suite per unit (see tasks). |
| `README.md`, `SETUP_PROMPT.md`, `CLAUDE.md` | **Modify.** Document hook wiring + segment. |

Conventions to follow (existing): `'use strict';`, CommonJS `require`/`module.exports`, tests use `node:test` + `node:assert/strict`, temp dirs via `fs.mkdtempSync(path.join(os.tmpdir(), 'csl-...'))` cleaned in `after()`.

---

## Task 1: Bundled price snapshot

**Files:**
- Create: `data/model_prices.json`

A curated LiteLLM-shaped snapshot (only the common Claude models; the ≤24h fetch
fills in everything else). LiteLLM field names are used verbatim so the same
parser handles bundled + fetched data.

- [ ] **Step 1: Create the snapshot file**

```json
{
  "claude-opus-4-8": {
    "input_cost_per_token": 0.000005,
    "output_cost_per_token": 0.000025,
    "cache_creation_input_token_cost": 0.00000625,
    "cache_read_input_token_cost": 0.0000005
  },
  "claude-opus-4-6": {
    "input_cost_per_token": 0.000005,
    "output_cost_per_token": 0.000025,
    "cache_creation_input_token_cost": 0.00000625,
    "cache_read_input_token_cost": 0.0000005
  },
  "claude-sonnet-4-6": {
    "input_cost_per_token": 0.000003,
    "output_cost_per_token": 0.000015,
    "cache_creation_input_token_cost": 0.00000375,
    "cache_read_input_token_cost": 0.0000003
  },
  "claude-haiku-4-5": {
    "input_cost_per_token": 0.0000008,
    "output_cost_per_token": 0.000004,
    "cache_creation_input_token_cost": 0.000001,
    "cache_read_input_token_cost": 0.00000008
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add data/model_prices.json
git commit -m "feat: bundled LiteLLM price snapshot for cost recompute"
```

---

## Task 2: `lib/cost-compute.js` — pure per-call math

**Files:**
- Create: `lib/cost-compute.js`
- Test: `tests/cost-compute.test.js`

`calculateCost` takes a resolved `costs` object (see Task 3's `getModelCosts`),
keeping model-name logic out of the math.

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractCacheCreation, calculateCost } = require('../lib/cost-compute');

const COSTS = { input: 10, output: 20, cacheWrite: 4, cacheRead: 1, fastMultiplier: 0.5, webSearch: 0.01 };

test('extractCacheCreation: split form preferred, 1h clamped to total', () => {
  const r = extractCacheCreation({ cache_creation: { ephemeral_5m_input_tokens: 2000, ephemeral_1h_input_tokens: 345 } });
  assert.deepEqual(r, { fiveMinute: 2000, oneHour: 345 });
});

test('extractCacheCreation: legacy total when no split', () => {
  const r = extractCacheCreation({ cache_creation_input_tokens: 500 });
  assert.deepEqual(r, { fiveMinute: 500, oneHour: 0 });
});

test('extractCacheCreation: keeps larger of legacy vs split', () => {
  const r = extractCacheCreation({ cache_creation_input_tokens: 1000, cache_creation: { ephemeral_1h_input_tokens: 300 } });
  // split=300, legacy=1000 → total=1000, oneHour=min(300,1000)=300, five=700
  assert.deepEqual(r, { fiveMinute: 700, oneHour: 300 });
});

test('calculateCost: full formula with 1h×1.6', () => {
  const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 1,
    cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 1 },
    server_tool_use: { web_search_requests: 1 } };
  // 10 + 20 + (1*4) + (1*4*1.6) + 1 + 0.01 = 41.41
  assert.equal(calculateCost(usage, COSTS), 41.41);
});

test('calculateCost: fast multiplies whole call', () => {
  const usage = { input_tokens: 1, speed: 'fast' };
  assert.equal(calculateCost(usage, COSTS), 0.5 * 10);
});

test('calculateCost: null costs → 0', () => {
  assert.equal(calculateCost({ input_tokens: 1000 }, null), 0);
});

test('calculateCost: clamps negative/NaN tokens to 0', () => {
  assert.equal(calculateCost({ input_tokens: -5, output_tokens: NaN }, COSTS), 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/cost-compute.test.js`
Expected: FAIL — `Cannot find module '../lib/cost-compute'`.

- [ ] **Step 3: Write the implementation**

```js
'use strict';

// Non-negative finite number, else 0.
function num(v) {
  const n = Number(v);
  return isFinite(n) && n > 0 ? n : 0;
}

// Split cache-write tokens into 5-minute and 1-hour TTL buckets (§3). Prefers the
// newer cache_creation split; falls back to the legacy total; never drops tokens.
function extractCacheCreation(usage) {
  const legacy = num(usage && usage.cache_creation_input_tokens);
  const cc = (usage && usage.cache_creation) || {};
  const five = num(cc.ephemeral_5m_input_tokens);
  const one = num(cc.ephemeral_1h_input_tokens);
  const split = five + one;
  let total, oneHour;
  if (split === 0) { total = legacy; oneHour = 0; }
  else { total = Math.max(legacy, split); oneHour = Math.min(one, total); }
  return { fiveMinute: Math.max(0, total - oneHour), oneHour };
}

// Price one assistant call (§5). `costs` is the resolved per-token rate object
// (lib/pricing.getModelCosts) or null for unknown/local models → $0. Fast mode
// multiplies the ENTIRE call cost by the model's fast multiplier.
function calculateCost(usage, costs) {
  if (!costs || !usage) return 0;
  const { fiveMinute, oneHour } = extractCacheCreation(usage);
  const mult = usage.speed === 'fast' ? (costs.fastMultiplier || 1) : 1;
  const web = num(usage.server_tool_use && usage.server_tool_use.web_search_requests);
  return mult * (
      num(usage.input_tokens) * costs.input
    + num(usage.output_tokens) * costs.output
    + fiveMinute * costs.cacheWrite
    + oneHour * costs.cacheWrite * 1.6
    + num(usage.cache_read_input_tokens) * costs.cacheRead
    + web * costs.webSearch
  );
}

module.exports = { extractCacheCreation, calculateCost };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/cost-compute.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/cost-compute.js tests/cost-compute.test.js
git commit -m "feat: pure per-call cost math (lib/cost-compute)"
```

---

## Task 3: `lib/pricing.js` — price table + model lookup

**Files:**
- Create: `lib/pricing.js`
- Test: `tests/pricing.test.js`

Exposes `buildMap`, `getModelCosts`, `hashMap`, `loadPricing`. `loadPricing` is
**synchronous** (returns cache-or-bundled immediately) and fires a background
fetch when the cache is stale, so callers never block. The renderer never calls
this module.

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildMap, getModelCosts, hashMap, loadPricing } = require('../lib/pricing');

const tmp = [];
after(() => { for (const d of tmp) fs.rmSync(d, { recursive: true, force: true }); });

const RAW = {
  'claude-opus-4-8': { input_cost_per_token: 0.000005, output_cost_per_token: 0.000025 },
  'anthropic/claude-sonnet-4-6': { input_cost_per_token: 0.000003, output_cost_per_token: 0.000015 },
  'bad-no-output': { input_cost_per_token: 0.000001 },
  'bad-negative': { input_cost_per_token: -1, output_cost_per_token: 0.00001 },
  'overpriced': { input_cost_per_token: 5, output_cost_per_token: 0.00001 },
};

test('buildMap: applies cache fallbacks (write=input×1.25, read=input×0.1)', () => {
  const m = buildMap(RAW);
  const c = m['claude-opus-4-8'];
  assert.equal(c.cacheWrite, 0.000005 * 1.25);
  assert.equal(c.cacheRead, 0.000005 * 0.1);
  assert.equal(c.webSearch, 0.01);
  assert.equal(c.fastMultiplier, 1);
});

test('buildMap: indexes provider-stripped alias', () => {
  const m = buildMap(RAW);
  assert.ok(m['claude-sonnet-4-6']);
  assert.equal(m['claude-sonnet-4-6'].input, 0.000003);
});

test('buildMap: skips entries missing input or output cost', () => {
  const m = buildMap(RAW);
  assert.equal(m['bad-no-output'], undefined);
});

test('buildMap: rejects negative rate (entry dropped — input invalid)', () => {
  const m = buildMap(RAW);
  assert.equal(m['bad-negative'], undefined);
});

test('buildMap: clamps per-token rate > 1 down to 1', () => {
  const m = buildMap(RAW);
  assert.equal(m['overpriced'].input, 1);
});

test('getModelCosts: exact, date-stripped, and longest-prefix match', () => {
  const m = buildMap(RAW);
  assert.equal(getModelCosts(m, 'claude-opus-4-8').input, 0.000005);
  assert.equal(getModelCosts(m, 'claude-opus-4-8-20260601').input, 0.000005);
  assert.equal(getModelCosts(m, 'claude-opus-4-8@beta').input, 0.000005);
});

test('getModelCosts: unknown and local models → null', () => {
  const m = buildMap(RAW);
  assert.equal(getModelCosts(m, 'gpt-9'), null);
  assert.equal(getModelCosts(m, 'llama3:8b'), null);
  assert.equal(getModelCosts(m, 'mistral-7b-q4'), null);
});

test('hashMap: stable + changes when a rate changes', () => {
  const a = hashMap(buildMap(RAW));
  const b = hashMap(buildMap(RAW));
  const c = hashMap(buildMap({ ...RAW, 'claude-opus-4-8': { input_cost_per_token: 0.000009, output_cost_per_token: 0.000025 } }));
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('loadPricing: falls back to bundled snapshot when no cache, no fetch', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-price-')); tmp.push(stateDir);
  const p = loadPricing(stateDir, { allowFetch: false });
  assert.ok(p.map['claude-opus-4-8']);
  assert.equal(typeof p.pricingHash, 'string');
  assert.equal(getModelCosts(p.map, 'gpt-9'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/pricing.test.js`
Expected: FAIL — `Cannot find module '../lib/pricing'`.

- [ ] **Step 3: Write the implementation**

```js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const BUNDLED = path.join(__dirname, '..', 'data', 'model_prices.json');
const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const FETCH_TTL_MS = 24 * 60 * 60 * 1000;

// Valid per-token rate: finite, non-negative; clamp >1 down to 1. Else null.
function sanitizeRate(v) {
  if (typeof v !== 'number' || !isFinite(v) || v < 0) return null;
  return v > 1 ? 1 : v;
}

// Build a {modelKey: costs} map from a LiteLLM-shaped object. Requires valid
// input+output rates; applies fallbacks; indexes provider-stripped aliases
// (first write wins, so direct-provider entries beat re-hosters).
function buildMap(rawObj) {
  const map = {};
  const put = (k, v) => { if (k && !(k in map)) map[k] = v; };
  for (const [name, e] of Object.entries(rawObj || {})) {
    if (!e || typeof e !== 'object') continue;
    const input = sanitizeRate(e.input_cost_per_token);
    const output = sanitizeRate(e.output_cost_per_token);
    if (input == null || output == null) continue;
    const cacheWrite = sanitizeRate(e.cache_creation_input_token_cost);
    const cacheRead = sanitizeRate(e.cache_read_input_token_cost);
    const val = {
      input, output,
      cacheWrite: cacheWrite == null ? input * 1.25 : cacheWrite,
      cacheRead: cacheRead == null ? input * 0.1 : cacheRead,
      fastMultiplier: 1,
      webSearch: 0.01,
    };
    put(name, val);
    const slash = name.indexOf('/');
    if (slash !== -1) put(name.slice(slash + 1), val);
  }
  return map;
}

// Resolve message.model → costs object, or null (unknown/local → $0). §4.
function getModelCosts(map, model) {
  if (!model) return null;
  if (model.includes(':') || /-(q4|bf16|fp16|gguf|f16|f32)$/.test(model)) return null;
  const name = model.replace(/@.*$/, '').replace(/-\d{8}$/, '');
  if (map[name]) return map[name];
  if (map[model]) return map[model];
  const keys = Object.keys(map).sort((a, b) => b.length - a.length);
  for (const k of keys) { if (name === k || name.startsWith(k + '-')) return map[k]; }
  return null;
}

// Short deterministic hash of the rate map — cache invalidation key.
function hashMap(map) {
  const h = crypto.createHash('sha1');
  for (const k of Object.keys(map).sort()) {
    const v = map[k];
    h.update(`${k}:${v.input},${v.output},${v.cacheWrite},${v.cacheRead}`);
  }
  return h.digest('hex').slice(0, 12);
}

// Fire-and-forget LiteLLM fetch → <stateDir>/pricing.json. Never throws.
function backgroundFetch(stateDir) {
  try {
    const req = https.get(LITELLM_URL, { timeout: 8000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return; }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          const raw = JSON.parse(body);
          fs.mkdirSync(stateDir, { recursive: true });
          const tmp = path.join(stateDir, `pricing.json.${process.pid}`);
          fs.writeFileSync(tmp, JSON.stringify({ fetchedAt: Date.now(), raw }));
          fs.renameSync(tmp, path.join(stateDir, 'pricing.json'));
        } catch {}
      });
    });
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
    req.unref(); // don't keep the hook process alive for the fetch
  } catch {}
}

// Sync load: cached fetch if present, else bundled snapshot. Kicks a background
// refresh when the cache is older than 24h (unless allowFetch:false).
function loadPricing(stateDir, opts = {}) {
  const { allowFetch = true } = opts;
  let raw = null, fetchedAt = 0;
  try {
    const c = JSON.parse(fs.readFileSync(path.join(stateDir, 'pricing.json'), 'utf8'));
    if (c && c.raw) { raw = c.raw; fetchedAt = c.fetchedAt || 0; }
  } catch {}
  if (!raw) { try { raw = JSON.parse(fs.readFileSync(BUNDLED, 'utf8')); } catch { raw = {}; } }
  if (allowFetch && Date.now() - fetchedAt > FETCH_TTL_MS) backgroundFetch(stateDir);
  const map = buildMap(raw);
  return { map, pricingHash: hashMap(map) };
}

module.exports = { sanitizeRate, buildMap, getModelCosts, hashMap, loadPricing };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/pricing.test.js`
Expected: PASS (9 tests). (Tests pass `allowFetch:false`, so no network.)

- [ ] **Step 5: Commit**

```bash
git add lib/pricing.js tests/pricing.test.js
git commit -m "feat: LiteLLM price table with sanitize/lookup/24h fetch (lib/pricing)"
```

---

## Task 4: `lib/budget.js` — budget contract

**Files:**
- Create: `lib/budget.js`
- Test: `tests/budget.test.js`

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveBudget } = require('../lib/budget');

test('unset → $500 default, not opted out', () => {
  const b = resolveBudget(undefined);
  assert.equal(b.monthly, 500);
  assert.equal(b.budgetOptedOut, false);
  assert.equal(b.daily, 500 / 30);
  assert.equal(b.weekly, 500 * 7 / 30);
});

test('explicit 0 → opted out', () => {
  const b = resolveBudget('0');
  assert.equal(b.budgetOptedOut, true);
});

test('positive number → that budget', () => {
  const b = resolveBudget('300');
  assert.equal(b.monthly, 300);
  assert.equal(b.budgetOptedOut, false);
});

test('garbage / negative → 500 fallback', () => {
  assert.equal(resolveBudget('abc').monthly, 500);
  assert.equal(resolveBudget('-5').monthly, 500);
  assert.equal(resolveBudget('500abc').monthly, 500);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/budget.test.js`
Expected: FAIL — `Cannot find module '../lib/budget'`.

- [ ] **Step 3: Write the implementation**

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/budget.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/budget.js tests/budget.test.js
git commit -m "feat: restore budget contract (lib/budget)"
```

---

## Task 5: `lib/color.js` — add `BUDGET_TIERS`

**Files:**
- Modify: `lib/color.js`

- [ ] **Step 1: Add the tier tuple and export it**

In `lib/color.js`, after the `SESSION_TIERS` line, add:

```js
// BUDGET_TIERS: ratio of cost/limit for period chips. Period goes red at ≥90% of
// its limit (warns before hitting it). Part of the contract (tested).
const BUDGET_TIERS = [0.5, 0.75, 0.9];
```

Then change the exports line to include it:

```js
module.exports = { dim, bold, green, yellow, orange, red, COST_TIERS, colorByTier, SESSION_TIERS, BUDGET_TIERS };
```

- [ ] **Step 2: Verify nothing broke**

Run: `node --test tests/*.test.js`
Expected: PASS (all existing suites unaffected; `BUDGET_TIERS` is additive).

- [ ] **Step 3: Commit**

```bash
git add lib/color.js
git commit -m "feat: restore BUDGET_TIERS in lib/color"
```

---

## Task 6: `lib/periods.js` — window math + period summing

**Files:**
- Create: `lib/periods.js`
- Test: `tests/periods.test.js`

Shared by renderer and viewer. `sumPeriods` sums a `perSession` map's day-buckets
into daily/weekly/monthly totals, optionally excluding one session id.

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { windowStarts, sumPeriods } = require('../lib/periods');

// Fixed "now": Wed 2026-06-10 12:00 local. Week (Mon-based) starts Mon 2026-06-08.
const NOW = new Date(2026, 5, 10, 12, 0, 0);

test('windowStarts: day/week(Mon)/month starts', () => {
  const w = windowStarts(NOW);
  assert.equal(w.dayStart, new Date(2026, 5, 10).getTime());
  assert.equal(w.weekStart, new Date(2026, 5, 8).getTime());
  assert.equal(w.monthStart, new Date(2026, 5, 1).getTime());
});

test('sumPeriods: buckets by day key against windows', () => {
  const perSession = {
    a: { days: { '2026-06-10': 1, '2026-06-09': 2, '2026-06-05': 4, '2026-05-30': 8 }, total: 15 },
  };
  const r = sumPeriods(perSession, NOW);
  assert.equal(r.daily, 1);          // only the 10th
  assert.equal(r.weekly, 1 + 2);     // 10th + 9th (≥ Mon 8th)
  assert.equal(r.monthly, 1 + 2 + 4); // June days; May 30 excluded
});

test('sumPeriods: excludes a session id', () => {
  const perSession = {
    a: { days: { '2026-06-10': 1 }, total: 1 },
    b: { days: { '2026-06-10': 100 }, total: 100 },
  };
  assert.equal(sumPeriods(perSession, NOW, 'b').daily, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/periods.test.js`
Expected: FAIL — `Cannot find module '../lib/periods'`.

- [ ] **Step 3: Write the implementation**

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/periods.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/periods.js tests/periods.test.js
git commit -m "feat: local-calendar period summing (lib/periods)"
```

---

## Task 7: `lib/cost-aggregate.js` — transcript aggregation + cache

**Files:**
- Create: `lib/cost-aggregate.js`
- Test: `tests/cost-aggregate.test.js`

The core. Parses transcripts, dedups within-file (keep last per id) and globally
(first occurrence wins, files processed mtime-ascending), prices each call, and
buckets per-call into local day keys. Incremental: reuses cached per-file `calls`
when mtime+size are unchanged and the pricing hash matches.

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { aggregate, readCache, writeCache } = require('../lib/cost-aggregate');

const tmp = [];
after(() => { for (const d of tmp) fs.rmSync(d, { recursive: true, force: true }); });

// Minimal pricing: 1 unit per input token, nothing else. pricingHash 'test'.
const PRICING = { map: { m: { input: 1, output: 0, cacheWrite: 0, cacheRead: 0, fastMultiplier: 1, webSearch: 0 } }, pricingHash: 'test' };

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
  // Use Z times that are clearly different local days regardless of test TZ:
  // 2026-06-10T01:00:00Z and 2026-06-12T01:00:00Z are >1 day apart.
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
  // Same pricing hash → cache hit (calls reused). Sanity: same total.
  const second = aggregate(root, PRICING, { cache: { pricingHash: 'test', files: first.files } });
  assert.equal(second.perSession.s1.total, 4);
  // Different pricing hash → ignore cache, recompute with new rates (input×2).
  const PRICING2 = { map: { m: { input: 2, output: 0, cacheWrite: 0, cacheRead: 0, fastMultiplier: 1, webSearch: 0 } }, pricingHash: 'other' };
  const third = aggregate(root, PRICING2, { cache: { pricingHash: 'test', files: first.files } });
  assert.equal(third.perSession.s1.total, 8);
});

test('readCache/writeCache round-trip', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-cache-')); tmp.push(stateDir);
  assert.equal(readCache(stateDir), null);
  writeCache(stateDir, { pricingHash: 'h', files: { x: 1 }, perSession: { s: { days: {}, total: 0 } } });
  const c = readCache(stateDir);
  assert.equal(c.pricingHash, 'h');
  assert.deepEqual(c.perSession.s, { days: {}, total: 0 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/cost-aggregate.test.js`
Expected: FAIL — `Cannot find module '../lib/cost-aggregate'`.

- [ ] **Step 3: Write the implementation**

```js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { projectDirs } = require('./transcript');
const { getModelCosts } = require('./pricing');
const { extractCacheCreation, calculateCost } = require('./cost-compute');

// Local calendar YYYY-MM-DD from an ISO timestamp, or null if unparseable.
function dayKey(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Parse one transcript into a per-file call list: [{ id, dayKey, cost }].
// within-file dedup: keep the LAST occurrence per message.id (final usage),
// carrying the FIRST occurrence's timestamp. id-less calls get id:null (always
// kept; never globally deduped).
function parseFileCalls(file, pricing) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const byKey = new Map();   // internalKey -> { id, ts, usage, model }
  const order = [];          // first-seen internal keys
  let synth = 0;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!o || o.type !== 'assistant' || !o.message) continue;
    const m = o.message;
    if (!m.usage || !m.model) continue;
    const realId = typeof m.id === 'string' && m.id ? m.id : null;
    const key = realId || `__synth__${synth++}`;
    if (!byKey.has(key)) order.push(key);
    const prev = byKey.get(key);
    byKey.set(key, { id: realId, ts: prev ? prev.ts : o.timestamp, usage: m.usage, model: m.model });
  }
  const calls = [];
  for (const key of order) {
    const { id, ts, usage, model } = byKey.get(key);
    const dk = dayKey(ts);
    if (!dk) continue;
    const cost = calculateCost(usage, getModelCosts(pricing.map, model));
    calls.push({ id, dayKey: dk, cost });
  }
  return calls;
}

// Aggregate all transcripts under configDir's projects/*. Returns
// { perSession: {id:{days,total}}, byDay: {key:cost}, files: {path:{...,calls}}, pricingHash }.
// Incremental: a file whose mtime+size match the prior cache (and pricingHash
// matches) reuses its cached `calls`. Global dedup (first occurrence wins) runs
// files mtime-ascending and is rebuilt fresh each call from the per-file lists.
function aggregate(configDir, pricing, opts = {}) {
  const { sinceMtimeMs = 0, cache = null } = opts;
  const root = configDir || path.join(os.homedir(), '.claude');
  const prevFiles = (cache && cache.pricingHash === pricing.pricingHash && cache.files) || {};

  const candidates = [];
  for (const d of projectDirs(root)) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const sessionId = e.name.slice(0, -'.jsonl'.length);
      if (!sessionId) continue;
      const file = path.join(d, e.name);
      let st; try { st = fs.statSync(file); } catch { continue; }
      if (st.mtimeMs < sinceMtimeMs) continue;
      candidates.push({ file, sessionId, mtime: st.mtimeMs, size: st.size });
    }
  }
  candidates.sort((a, b) => a.mtime - b.mtime); // oldest first → first-occurrence wins

  const files = {};
  const perSession = {};
  const byDay = {};
  const seen = new Set();
  for (const c of candidates) {
    const prev = prevFiles[c.file];
    const calls = (prev && prev.mtime === c.mtime && prev.size === c.size)
      ? prev.calls
      : parseFileCalls(c.file, pricing);
    files[c.file] = { mtime: c.mtime, size: c.size, sessionId: c.sessionId, calls };
    const ps = perSession[c.sessionId] || (perSession[c.sessionId] = { days: {}, total: 0 });
    for (const call of calls) {
      if (call.id) { if (seen.has(call.id)) continue; seen.add(call.id); }
      ps.days[call.dayKey] = (ps.days[call.dayKey] || 0) + call.cost;
      ps.total += call.cost;
      byDay[call.dayKey] = (byDay[call.dayKey] || 0) + call.cost;
    }
  }
  return { perSession, byDay, files, pricingHash: pricing.pricingHash };
}

// Read <stateDir>/cost-cache.json → parsed object or null.
function readCache(stateDir) {
  try { return JSON.parse(fs.readFileSync(path.join(stateDir, 'cost-cache.json'), 'utf8')); }
  catch { return null; }
}

// Atomically write the aggregate result's {pricingHash, files, perSession}.
function writeCache(stateDir, result) {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const out = { pricingHash: result.pricingHash, files: result.files, perSession: result.perSession };
    const tmp = path.join(stateDir, `cost-cache.json.${process.pid}`);
    fs.writeFileSync(tmp, JSON.stringify(out));
    fs.renameSync(tmp, path.join(stateDir, 'cost-cache.json'));
  } catch {}
}

module.exports = { dayKey, parseFileCalls, aggregate, readCache, writeCache };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/cost-aggregate.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/cost-aggregate.js tests/cost-aggregate.test.js
git commit -m "feat: transcript cost aggregation with incremental cache (lib/cost-aggregate)"
```

---

## Task 8: `hooks/refresh-cost-cache.js` — UserPromptSubmit refresh

**Files:**
- Create: `hooks/refresh-cost-cache.js`
- Test: `tests/refresh-cost-cache.test.js`

A node hook (invoked as `node <repo>/hooks/refresh-cost-cache.js`). Reads
`CLAUDE_CONFIG_DIR` from env, loads pricing, runs incremental `aggregate` over the
last 40 days, writes `cost-cache.json`. Fully silent; never blocks the prompt.

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK = path.resolve(__dirname, '../hooks/refresh-cost-cache.js');
const tmp = [];
after(() => { for (const d of tmp) fs.rmSync(d, { recursive: true, force: true }); });

test('builds cost-cache.json from transcripts under CLAUDE_CONFIG_DIR', () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-cfg-')); tmp.push(configDir);
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-xdg-')); tmp.push(xdg);
  const proj = path.join(configDir, 'projects', 'p');
  fs.mkdirSync(proj, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(proj, 's1.jsonl'),
    JSON.stringify({ type: 'assistant', timestamp: now, message: { id: 'm1', model: 'claude-opus-4-8', usage: { input_tokens: 1000 } } }) + '\n');

  const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir, XDG_STATE_HOME: xdg };
  const res = spawnSync(process.execPath, [HOOK], { env, encoding: 'utf8' });
  assert.equal(res.status, 0);

  // State dir mangles CLAUDE_CONFIG_DIR path → profile subdir.
  const profile = configDir.replace(/^\//, '').replace(/\//g, '_');
  const cachePath = path.join(xdg, 'claude-statusline', profile, 'cost-cache.json');
  const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  assert.ok(cache.perSession.s1);
  assert.ok(cache.perSession.s1.total > 0);
});

test('exits 0 even with no projects dir', () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-cfg2-')); tmp.push(configDir);
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-xdg2-')); tmp.push(xdg);
  const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir, XDG_STATE_HOME: xdg };
  const res = spawnSync(process.execPath, [HOOK], { env, encoding: 'utf8' });
  assert.equal(res.status, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/refresh-cost-cache.test.js`
Expected: FAIL — hook file does not exist (non-zero status / read error).

- [ ] **Step 3: Write the implementation**

```js
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
  writeCache(stateDir, result);
}

try { main(); } catch {}                          // never break the prompt
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/refresh-cost-cache.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Make the hook executable + commit**

```bash
chmod +x hooks/refresh-cost-cache.js
git add hooks/refresh-cost-cache.js tests/refresh-cost-cache.test.js
git commit -m "feat: UserPromptSubmit hook to refresh cost cache (hooks/refresh-cost-cache)"
```

---

## Task 9: Renderer — s/d/w/m chip group

**Files:**
- Modify: `hooks/statusline.js`
- Test: `tests/period-cost.test.js` (create)

Replace the single session-cost chip with the s/d/w/m group: session (absolute
`SESSION_TIERS`) + daily/weekly/monthly (budget-relative `BUDGET_TIERS`), joined
by the dim `·` separator. d/w/m = `sumPeriods(cache.perSession, now, currentId)` +
live payload cost folded into all three windows. `budgetOptedOut` → session chip
only (no `s ` prefix).

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { baseInput, run } = require('./helpers.js');

const tmp = [];
after(() => { for (const d of tmp) fs.rmSync(d, { recursive: true, force: true }); });

// Build an isolated XDG state dir holding a cost-cache.json with the given perSession.
function stateWithCache(perSession) {
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-pc-')); tmp.push(xdg);
  const dir = path.join(xdg, 'claude-statusline'); // empty profile (no CLAUDE_CONFIG_DIR)
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'cost-cache.json'), JSON.stringify({ pricingHash: 'h', files: {}, perSession }));
  return xdg;
}

function todayKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

test('d/w/m chips sum cached other-sessions + folded live session cost', async () => {
  const xdg = stateWithCache({ other: { days: { [todayKey()]: 2 }, total: 2 } });
  const i = baseInput();
  i.session_id = 'current';
  i.cost = { total_cost_usd: 3 };
  const out = await run(i, { XDG_STATE_HOME: xdg, STATUSLINE_MONTHLY_BUDGET: '300' });
  // session chip = $3.00; daily = other(2) + live(3) = $5.00
  assert.ok(out.includes('s $3.00'));
  assert.ok(out.includes('d $5.00'));
});

test('current session excluded from cache sum (no double count)', async () => {
  const xdg = stateWithCache({ current: { days: { [todayKey()]: 99 }, total: 99 } });
  const i = baseInput();
  i.session_id = 'current';
  i.cost = { total_cost_usd: 3 };
  const out = await run(i, { XDG_STATE_HOME: xdg, STATUSLINE_MONTHLY_BUDGET: '300' });
  assert.ok(out.includes('d $3.00')); // only the live fold, cached 'current' ignored
});

test('budget opt-out (0) → only session chip, no d/w/m', async () => {
  const xdg = stateWithCache({ other: { days: { [todayKey()]: 2 }, total: 2 } });
  const i = baseInput();
  i.session_id = 'current';
  i.cost = { total_cost_usd: 3 };
  const out = await run(i, { XDG_STATE_HOME: xdg, STATUSLINE_MONTHLY_BUDGET: '0' });
  assert.ok(out.includes('$3.00'));
  assert.ok(!out.includes('d $'));
  assert.ok(!out.includes('w $'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/period-cost.test.js`
Expected: FAIL — output has `$3.00` but not `s $3.00` / `d $5.00` (renderer still emits the single chip).

- [ ] **Step 3: Update the renderer**

In `hooks/statusline.js`:

(a) Extend the color/lib imports (line ~7–8):

```js
const { resolveStateDir } = require('../lib/state');
const { dim, bold, green, yellow, orange, red, colorByTier, SESSION_TIERS, BUDGET_TIERS } = require('../lib/color');
const { readCache } = require('../lib/cost-aggregate');
const { sumPeriods } = require('../lib/periods');
const { resolveBudget } = require('../lib/budget');
```

(b) Replace `formatCost` (the current single-chip version) with the prefixed
version plus a period formatter:

```js
/**
 * Format session cost as [prefix]$X.XX with absolute-USD color thresholds.
 */
function formatCost(totalCost, prefix = '') {
  if (totalCost == null || totalCost <= 0) return '';
  return colorByTier(totalCost, SESSION_TIERS)(prefix + '$' + totalCost.toFixed(2));
}

/**
 * Format a period cost with budget-relative color thresholds (red at ≥90% limit).
 */
function formatPeriodCost(cost, limit, prefix) {
  if (!cost || cost <= 0) return '';
  return colorByTier(cost / limit, BUDGET_TIERS)(prefix + '$' + cost.toFixed(2));
}
```

(c) Replace the cost-emit block (currently the two lines after the "Added dirs"
comment, ~line 319–321) with the chip group:

```js
    // Cost group: session (s) + daily/weekly/monthly, joined by the dim `·`
    // separator (like rate limits). Session uses absolute $ thresholds; d/w/m are
    // budget-relative. d/w/m = other sessions' spend (from cost-cache.json,
    // excluding THIS session to avoid double-count) + this session's live payload
    // cost folded into all three windows. Budget opt-out (0) hides d/w/m.
    const { budgetOptedOut, monthly: monthlyBudget, daily: dailyLimit, weekly: weeklyLimit } =
      resolveBudget(process.env.STATUSLINE_MONTHLY_BUDGET);
    const costParts = [formatCost(totalCost, budgetOptedOut ? '' : 's ')];
    if (!budgetOptedOut) {
      const cache = readCache(stateDir);
      const live = totalCost > 0 ? totalCost : 0;
      const { daily, weekly, monthly } = cache && cache.perSession
        ? sumPeriods(cache.perSession, new Date(), session)
        : { daily: 0, weekly: 0, monthly: 0 };
      costParts.push(
        formatPeriodCost(daily + live, dailyLimit, 'd '),
        formatPeriodCost(weekly + live, weeklyLimit, 'w '),
        formatPeriodCost(monthly + live, monthlyBudget, 'm '),
      );
    }
    const costShown = costParts.filter(Boolean);
    if (costShown.length) add('cost', costShown.join(` ${dim(icons.rsep)} `));
```

(Remove the old `const costStr = formatCost(totalCost); if (costStr) add('cost', costStr);` lines.)

- [ ] **Step 4: Run the new test + the existing cost test**

Run: `node --test tests/period-cost.test.js tests/cost.test.js`
Expected: `tests/period-cost.test.js` PASS. `tests/cost.test.js` may now FAIL on
chips that became `s $X.XX` — proceed to Step 5.

- [ ] **Step 5: Update `tests/cost.test.js` for the new prefix**

The single-chip suite still asserts the session color thresholds, which are
unchanged — only the label gains an `s ` prefix (default budget is $500, so d/w/m
also render, but each chip keeps its own color). Update each assertion's expected
string from `$X.XX` to `s $X.XX`. Example:

```js
test('cost 0.50 — green', async () => {
  const { plain, raw } = await rawAndPlain(0.50);
  assert.ok(plain.includes('s $0.50'));
  assert.ok(raw.includes('\x1b[32m'));
});
```

Apply the `s ` prefix to every `$X.XX` assertion in the file (the zero-cost test
stays: assert no `$`). `EMPTY_STATE` has no cost-cache.json, so d/w/m fold only
the live cost — the session chip color assertions remain valid.

- [ ] **Step 6: Run both suites to verify pass**

Run: `node --test tests/period-cost.test.js tests/cost.test.js`
Expected: PASS (both).

- [ ] **Step 7: Full suite + commit**

```bash
node --test tests/*.test.js
git add hooks/statusline.js tests/period-cost.test.js tests/cost.test.js
git commit -m "feat: render s/d/w/m cost chips from recomputed cache + live fold"
```

Expected full run: PASS.

---

## Task 10: Viewer — per-session COST column + d/w/m footer

**Files:**
- Modify: `bin/sessions.js`
- Test: `tests/sessions-viewer.test.js` (extend)

Aggregate full history (no `sinceMtimeMs`) and add a COST column per row plus a
d/w/m summary footer.

- [ ] **Step 1: Write the failing test (append to the existing suite)**

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runSessions } = require('./helpers.js');

test('viewer: shows per-session COST column + d/w/m footer', async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-vc-'));
  const proj = path.join(configDir, 'projects', 'p');
  fs.mkdirSync(proj, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(proj, 'sess1.jsonl'),
    JSON.stringify({ type: 'assistant', timestamp: now, message: { id: 'm1', model: 'claude-opus-4-8', usage: { input_tokens: 1000000 } } }) + '\n');
  const out = await runSessions(['--config-dir', configDir], { XDG_STATE_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'csl-vx-')) });
  fs.rmSync(configDir, { recursive: true, force: true });
  assert.match(out, /COST/);            // header
  assert.match(out, /\$\d+\.\d{2}/);    // a dollar amount on the row
  assert.match(out, /today|day|week|month/i); // footer line
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/sessions-viewer.test.js`
Expected: FAIL — no `COST` header / no footer.

- [ ] **Step 3: Update `bin/sessions.js`**

(a) Extend imports:

```js
const { readTitleRecap, projectDirs, listSessions } = require('../lib/transcript');
const { dim, colorByTier, SESSION_TIERS, BUDGET_TIERS } = require('../lib/color');
const { loadPricing } = require('../lib/pricing');
const { aggregate } = require('../lib/cost-aggregate');
const { sumPeriods } = require('../lib/periods');
const { resolveBudget } = require('../lib/budget');
```

(b) Add a COST column width constant near the other widths:

```js
const COST_W = 8;    // '$1234.56'
```

(c) In `main`, after `let rows = listSessions(transcriptRoot, dirs);`, compute the
full-history aggregate once (reuse it for per-session totals and the footer):

```js
  // Recompute spend from raw tokens × LiteLLM prices (never trust Claude's cost).
  // Full history (no mtime cap) — the viewer can afford the parse.
  const stateDir = require('../lib/state').resolveStateDir(source);
  const pricing = loadPricing(stateDir);
  const agg = aggregate(transcriptRoot, pricing);
  const costOf = (id) => {
    const ps = agg.perSession[id];
    return ps ? ps.total : 0;
  };
```

(d) Add the COST column to the header and rows. Update the header line:

```js
  out.push(dim(`${'WHEN'.padEnd(WHEN_W)}${GAP}${'SESSION'.padEnd(ID_W)}${GAP}${'COST'.padEnd(COST_W)}${GAP}TITLE / RECAP`));
```

Recompute `titleCol` to include the cost column:

```js
  const titleCol = WHEN_W + GAP.length + ID_W + GAP.length + COST_W + GAP.length;
```

In the row loop, insert the cost cell before the title. ANSI codes inflate string
length, so pad the **plain** text first, then color the padded string (the reset
is appended after the trailing spaces, which is safe for alignment):

```js
  for (const v of view) {
    const when = dim(fmtWhen(v.ts));
    const sid = dim(v.shortId.padEnd(ID_W));
    const cost = costOf(v.id);
    const plainCost = (cost > 0 ? '$' + cost.toFixed(2) : '—').padEnd(COST_W);
    const costCell = cost > 0 ? colorByTier(cost, SESSION_TIERS)(plainCost) : dim(plainCost);
    const titleText = truncate(v.title || '—', titleWidth);
    out.push(`${when}${GAP}${sid}${GAP}${costCell}${GAP}${titleText}`);
    if (v.recap) {
      const recapText = truncate(v.recap, Math.max(0, termWidth - titleCol - 2));
      out.push(`${' '.repeat(titleCol)}${dim('└ ' + recapText)}`);
    }
  }
```

(e) After the row loop, before `process.stdout.write(...)`, add the footer:

```js
  // d/w/m footer: full-history period sums (local-calendar windows), budget-colored.
  const { budgetOptedOut, monthly: mBudget, daily: dLimit, weekly: wLimit } =
    resolveBudget(process.env.STATUSLINE_MONTHLY_BUDGET);
  const per = sumPeriods(agg.perSession, new Date());
  const tier = (c, limit) => budgetOptedOut ? ((s) => s) : colorByTier(c / limit, BUDGET_TIERS);
  const money = (c) => '$' + c.toFixed(2);
  out.push('');
  out.push(
    dim('today ') + tier(per.daily, dLimit)(money(per.daily)) + dim('   week ') +
    tier(per.weekly, wLimit)(money(per.weekly)) + dim('   month ') +
    tier(per.monthly, mBudget)(money(per.monthly))
  );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/sessions-viewer.test.js`
Expected: PASS (existing tests + the new one).

- [ ] **Step 5: Commit**

```bash
git add bin/sessions.js tests/sessions-viewer.test.js
git commit -m "feat: per-session COST column + d/w/m footer in session viewer"
```

---

## Task 11: Documentation + hook wiring

**Files:**
- Modify: `README.md`, `SETUP_PROMPT.md`, `CLAUDE.md`

- [ ] **Step 1: Document the new `UserPromptSubmit` hook in README**

In `README.md`, the `UserPromptSubmit` hooks array currently lists only
`log-slash-skill.sh`. Add the refresh hook alongside it:

```json
"UserPromptSubmit": [
  { "hooks": [
    { "type": "command", "command": "<repo>/hooks/log-slash-skill.sh" },
    { "type": "command", "command": "node <repo>/hooks/refresh-cost-cache.js" }
  ]}
]
```

Also add a short subsection describing the cost feature: session chip + d/w/m
chips, that costs are recomputed from raw tokens × LiteLLM prices, the
`STATUSLINE_MONTHLY_BUDGET` env var (unset → $500/mo default; `0` → hide d/w/m),
and that the d/w/m totals refresh once per prompt.

- [ ] **Step 2: Document in SETUP_PROMPT.md**

In the `hooks.UserPromptSubmit` bullet, note it now has **two** command entries:
`log-slash-skill.sh` and `node <REPO>/hooks/refresh-cost-cache.js`. Add the
`refresh-cost-cache.js` entry to the example JSON the same way as Step 1.

- [ ] **Step 3: Update CLAUDE.md architecture section**

Update the `cost` segment row in the segment table to describe the s/d/w/m group
(session absolute thresholds; d/w/m budget-relative via `STATUSLINE_MONTHLY_BUDGET`).
Add a short paragraph under Architecture describing the cost pipeline:
`lib/cost-compute.js` (per-call math), `lib/pricing.js` (LiteLLM table, bundled
snapshot + ≤24h fetch), `lib/cost-aggregate.js` (transcript parse, global dedup,
day buckets, incremental `cost-cache.json`), `lib/periods.js` (window sums),
`lib/budget.js`, and the `UserPromptSubmit` `hooks/refresh-cost-cache.js`
refresh + renderer live-fold. Note the viewer's COST column + d/w/m footer.
Add the new test files to the Testing section.

- [ ] **Step 4: Run the full suite one final time**

Run: `node --test tests/*.test.js`
Expected: PASS (all suites).

- [ ] **Step 5: Manual smoke check**

```bash
echo '{"model":{"display_name":"Claude"},"session_id":"x","cost":{"total_cost_usd":2.5},"workspace":{"current_dir":"/tmp","project_dir":"/tmp"}}' | node hooks/statusline.js
```
Expected: a line containing `s $2.50` (and d/w/m chips against the $500 default,
folding the live $2.50).

- [ ] **Step 6: Commit**

```bash
git add README.md SETUP_PROMPT.md CLAUDE.md
git commit -m "docs: document recomputed cost tracking + refresh hook wiring"
```

---

## Self-review notes

- **Spec coverage:** pricing (Task 3) ✓, per-call math + cache split + fast + 1h×1.6 (Task 2) ✓, within+global dedup + day buckets + incremental (Task 7) ✓, bundled snapshot + ≤24h fetch (Tasks 1, 3) ✓, UserPromptSubmit refresh + 40-day window (Task 8) ✓, renderer cache-sum + current-session exclude + live fold + budget coloring + opt-out (Task 9) ✓, viewer COST column + d/w/m footer (Task 10) ✓, BUDGET_TIERS (Task 5) ✓, period window math (Task 6) ✓, docs/wiring (Task 11) ✓.
- **Type consistency:** `loadPricing` → `{ map, pricingHash }`; `aggregate` → `{ perSession, byDay, files, pricingHash }`; `perSession[id]` = `{ days, total }`; `getModelCosts(map, model)` → costs-or-null; `calculateCost(usage, costs)`; `sumPeriods(perSession, now, excludeId)` → `{ daily, weekly, monthly }`; `resolveBudget(raw)` → `{ budgetOptedOut, monthly, daily, weekly }`. Used consistently across tasks.
- **Decisions:** `firstTs` from the spec's `perSession` shape was dropped as unused (the viewer already has each session's `ts` from `listSessions`); `perSession[id]` is `{ days, total }`.
- **Cache `byDay`** is computed by `aggregate` but only `perSession` is persisted (renderer needs per-session to exclude the current one); `byDay` stays an in-memory convenience.
