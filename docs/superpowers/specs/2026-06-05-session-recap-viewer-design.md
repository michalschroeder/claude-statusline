# Per-session recap + cost viewer — design

Status: approved (brainstorm). Date: 2026-06-05. Repo: `claude-statusline` (branch `main`).

## Goal

A standalone CLI that lists recent Claude Code sessions per profile with **cost + ts**
(from existing on-disk data) joined to **title + recap** (reused from the transcript CC
already writes). Plus today/week/month cost totals. No statusline-render change.

## Key facts (verified prior session — do not re-investigate)

- Hooks CANNOT invoke slash commands / drive the agent. We READ what CC already wrote.
- Transcript jsonl entries reused (one per line, `JSON.parse`-able):
  - `{"type":"ai-title","aiTitle":"<title>","sessionId":"…"}` — short title, repeated; take **last**.
  - `{"type":"system","subtype":"away_summary","content":"<recap> (disable recaps in /config)"}`
    — the `/recap` output; take **last**, strip trailing `" (disable recaps in /config)"`.
- Coverage: rich sessions have both; short/`/clear`/headless may have neither → `—`.
- Transcript path: `<CLAUDE_CONFIG_DIR>/projects/<encoded-cwd>/<session_id>.jsonl`.
  Subagent transcripts under `.../<session_id>/subagents/*.jsonl` — **EXCLUDE**.
- `session_id` is the join key (it is the transcript filename and the `cost.log` 3rd column).

## Cost data on disk (reuse)

Per-profile state dir: `${XDG_STATE_HOME:-$HOME/.local/state}/claude-statusline/<profile>/`,
`<profile>` = `CLAUDE_CONFIG_DIR` with leading `/` stripped, remaining `/`→`_` (empty when
unset → flat layout). Files:
- `cost.log` — lines `<YYYY-MM-DD> <unix_ts> <session_id> <cost>` (ended; cumulative;
  dedup-by-id keep-max on read; positive cost only; trimmed ~45 days).
- `cost/<session_id>` — live cost temp (plain float) for running sessions.

## Decisions (locked)

1. **Architecture A — viewer-only, read live.** No hook change, no new persisted file.
   Pure Node stdlib (matches renderer). Transcript parsed **in-process** (`fs` + `JSON.parse`
   per line) — no `jq`, no `find`, no subprocess.
2. **Config-dir resolution.** Source = `--config-dir <path>` if given, else env
   `CLAUDE_CONFIG_DIR` (may be **unset**). Two derivations from that source, mirroring the
   renderer exactly:
   - **State-dir profile** = source mangled (`/`→`_`); **unset source → flat layout**
     (empty profile), NOT defaulted to `~/.claude`. This must match `statusline.js` so the
     viewer reads the same `cost.log` the renderer wrote.
   - **Transcript root** = source if set, else default `~/.claude`. The `~/.claude` default
     applies ONLY to transcript discovery (`<root>/projects/`), never to the profile.

   **No `--all-profiles`** — the `/`→`_` mangling is lossy and can't be reliably reversed;
   run once per config dir instead.
3. **Label.** title line = **ai-title** strictly (`—` if absent). recap shown ONLY as the
   `└` sub-line, never promoted to the title line. Both shown when both present.
   Degradation: title+recap → both lines; title only → title line, no `└`; recap only →
   `—` with `└ recap`; neither → `—`.
4. **Redaction.** Truncate only (width-cap), **no** secret scrubbing. User owns the screenshot.
5. **Running sessions.** Included, marked `●`. Cost from `cost/<id>` temp; title/recap live.
   Live cost supersedes any logged line for the same id. Folded into period totals.
6. **Flags.** `--last N` (default 10), `--since YYYY-MM-DD`, `--config-dir <path>`.
   Interaction: `--since` sets a lower ts bound (date local-midnight); `--last` caps count
   AFTER `--since`; default `--last 10` when neither given; `--since` without `--last` →
   no count cap (all matches).
7. **Code sharing.** Extract a shared `lib/cost.js`; both `statusline.js` and the viewer
   require it (single source of truth). Renderer behavior unchanged.

## Components

### `lib/cost.js` (extracted from `statusline.js`)

- `resolveStateDir(configDir)` → state dir path. The `/`→`_` profile mangling currently
  inlined in `statusline.js` (~L306). `configDir` undefined/empty → flat layout (no profile).
- `readCostRows(stateDir)` → `Map<id, {ts, cost}>`. The dedup-keep-max loop currently inside
  `readPeriodCosts`: skip rows with <4 fields, NaN ts/cost, `cost <= 0`, or empty id; keep
  the largest cost per id.
- `readLiveCosts(stateDir)` → `Map<id, cost>`. Read **every** `cost/<id>` temp (plain float;
  skip NaN / `<= 0`). (Renderer previously read only its own session's temp.)
- `bucketPeriods(rows, now)` → `{daily, weekly, monthly}`. Local-calendar windows:
  daily = since today's midnight; weekly = since this week's Monday (`(getDay()+6)%7` days
  back); monthly = since the 1st. Sum a row when its `ts >=` the window start. `rows` is an
  iterable of `{ts, cost}`.

`statusline.js`'s `readPeriodCosts(stateDir, liveSession, liveCost)` becomes a thin wrapper:
merge `readCostRows(stateDir)` with the single live `{liveSession → liveCost}` (live folded
at `now`, superseding any logged line), then `bucketPeriods`. Existing renderer tests stay green.

### `lib/transcript.js` (new)

- `findTranscript(configDir, sessionId)` → path | null. Scan `<configDir>/projects/*/` for a
  file named `<sessionId>.jsonl`; **exclude any path containing `/subagents/`**. Return first match.
- `readTitleRecap(path)` → `{title, recap}` (each string | null). Read file, split lines,
  `JSON.parse` each (skip parse errors). Keep the **last** `type==="ai-title"` → `title`
  (its `aiTitle`), and the **last** `type==="system" && subtype==="away_summary"` → `recap`
  (its `content`, with trailing `" (disable recaps in /config)"` stripped). Missing → null.

### `bin/sessions.js` (new viewer)

1. Parse flags. `source = flag ?? env CLAUDE_CONFIG_DIR` (may be undefined).
   `stateDir = resolveStateDir(source)` (undefined → flat). `transcriptRoot = source || ~/.claude`.
2. `rows = merge(readCostRows(stateDir), readLiveCosts(stateDir))`: live cost supersedes
   logged cost for the same id; tag live ids for the `●` marker. Live rows bucket at `now`.
3. Filter `--since` (ts ≥ date local-midnight). Sort desc by ts. Cap to `--last`
   (skip cap when `--since` given without `--last`).
4. Per row: `findTranscript(transcriptRoot, id)` → `readTitleRecap`. Missing transcript → both null.
5. Render table. Columns: WHEN (`MM-DD HH:MM` local), COST (`$X.XX`, `●` if live), SESSION
   (short id, e.g. first 8 chars), TITLE/RECAP. Title = ai-title or `—`; recap as `└` sub-line
   only when present. Width-cap each text line to terminal width (truncate, ellipsis `…`).
6. Footer: `TODAY / WEEK / MONTH` via `bucketPeriods(rows, now)` (incl. live), with
   `(incl. live)` note when any live row present.
7. Empty `cost.log` and no live temps → print "no sessions recorded yet".

Output shape:

```
WHEN         COST     SESSION   TITLE / RECAP
06-05 14:02  $1.20 ●  e7ddfb1f  Refactor cost parser
06-05 00:25  $0.83    a3f1c0d2  Address timezone comment
                                └ Applied 4 reviewer changes…
TODAY: $5.41   WEEK: $48.20   MONTH: $210.00  (incl. live)
```

## Testing (repo pattern: one file per unit; spawn + strip-ANSI; data-provider arrays)

- `tests/cost-lib.test.js` — `readCostRows` dedup/malformed/negative; `bucketPeriods`
  boundary table (just-before / just-after each window start); `resolveStateDir` mangling
  (set/unset `CLAUDE_CONFIG_DIR`); `readLiveCosts` multi-temp + skip bad.
- `tests/transcript.test.js` — `readTitleRecap` over fixtures: last-wins for both types,
  disclaimer strip, title-only, recap-only, neither, unparseable lines. `findTranscript`
  subagent-path exclusion + not-found.
- `tests/sessions-viewer.test.js` — spawn `bin/sessions.js`, strip ANSI; assert rows,
  `●` marker, `└` sub-line, `--last`/`--since` filtering, footer totals, empty-state line.
  Isolate via temp `XDG_STATE_HOME` + scrubbed inherited `CLAUDE_CONFIG_DIR`; build a fixture
  `projects/<enc>/<id>.jsonl` tree + `cost.log` + `cost/<id>` temps.
- Real clock/date — NO fake clock (hard user constraint). Tests that assert period bucketing
  build rows relative to the real `now` (e.g. ts = now, now−1day, last-month) rather than
  pinning absolute dates.
- Existing renderer tests (`tests/cost.test.js`, `tests/period-cost.test.js`,
  `tests/cleanup-hook.test.js`, etc.) must stay green after the `lib/cost.js` extraction.

## Docs

- `CLAUDE.md`: add a "Session viewer" section (purpose, flags, `lib/cost.js` + `lib/transcript.js`
  roles) and note the `readPeriodCosts` refactor into `lib/cost.js`.
- `README.md`: usage example (the output shape above) + flag reference.

## Conventions

- Viewer is a separate CLI, NOT the renderer — MAY use whatever stdlib it needs, but per the
  architecture it stays pure Node (no subprocess) anyway.
- Do NOT adjust prod code for tests; no fake clock.
- Conventional Commits; this is its own change/PR on top of the (uncommitted) state-dir +
  period-cost work. Branch off `main` before committing; commit/push only when asked.
- Embed actual glyph chars (`●`, `└`, `…`) in edits, not `\uXXXX`.

## Out of scope (YAGNI)

- `--all-profiles` (lossy reconstruction).
- Redaction / secret scrubbing.
- Any statusline-render change.
- Persisted `sessions.log` snapshot (architecture B/C rejected).

## Unresolved questions

None.
