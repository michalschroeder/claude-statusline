# CLAUDE.md

## Commands

- Run all tests: `node --test tests/*.test.js`
- Run a single test file: `node --test tests/cost.test.js`
- Manual statusline check: `echo '{"model":{"display_name":"Claude"},"workspace":{"current_dir":"/tmp","project_dir":"/tmp"}}' | node hooks/statusline.js`

No build step, no linter, no package.json — pure Node stdlib (Node 18+).

## Architecture

Single-process statusline renderer plus two bash logging hooks.

**State dir** (`<STATE>` below): resolved identically by the renderer and all three hooks as `${XDG_STATE_HOME:-$HOME/.local/state}/claude-statusline/<profile>`. Data **always lives in our own XDG namespace — never inside `CLAUDE_CONFIG_DIR`**, which is Claude Code's own managed dir (full of generic-named subdirs it prunes via `.last-cleanup`); writing there risks colliding with a future CC feature. `CLAUDE_CONFIG_DIR` is used only as a **per-subscription key**: its path (leading `/` stripped, remaining `/`→`_`, e.g. `/home/u/.claude-x` → `home_u_.claude-x`) becomes the `<profile>` subdir, so distinct subscriptions/profiles keep separate cost.log + skill logs. When `CLAUDE_CONFIG_DIR` is unset (single-profile users), `<profile>` is empty → flat `…/claude-statusline/` layout, unchanged. The renderer (`hooks/statusline.js`, `replace(/^\//,'').replace(/\//g,'_')`) and the bash hooks (`${CLAUDE_CONFIG_DIR#/}` then `${profile//\//_}`) must produce the same profile string — covered by `tests/state-dir.test.js`.

### Shared cost lib (`lib/cost.js`)

`cost.log` parsing lives in `lib/cost.js` — `resolveStateDir(configDir)` (the `/`→`_`
profile mangling), `readCostRows(stateDir)` (dedup-by-id keep-max), `readLiveCosts(stateDir)`
(every `cost/<id>` temp), `bucketPeriods(rows, now)` (local-calendar day/week/month sums).
Both the renderer (`hooks/statusline.js`, whose `readPeriodCosts` is now a thin wrapper folding
the live session at `now`) and the viewer (`bin/sessions.js`) require it — single source of truth.

### Session viewer (`bin/sessions.js`)

Standalone CLI (NOT the renderer — may use whatever it needs, but is pure Node anyway). Lists
recent sessions with cost + ts (from `cost.log` + live `cost/<id>` temps) joined to ai-title +
recap parsed in-process from the CC transcript via `lib/transcript.js` (`findTranscript`,
`readTitleRecap` — last `ai-title` / last `away_summary`, disclaimer stripped, subagent
transcripts excluded). Config-dir resolution: `--config-dir` ?? `CLAUDE_CONFIG_DIR`; state-dir
profile uses that source raw (unset → flat, matching the renderer), transcript root defaults to
`~/.claude` only for `projects/` discovery. Flags: `--last N` (default 10), `--since YYYY-MM-DD`
(lower ts bound; without `--last` shows all matches), `--config-dir <path>`. Live sessions marked
`●` and folded into the TODAY/WEEK/MONTH footer. Titles/recaps are width-truncated only (no
redaction). No `--all-profiles` (the profile mangling is lossy).

Data flow:

1. Claude Code spawns `hooks/statusline.js` per render and pipes a JSON status payload on stdin.
2. `statusline.js` reads stdin, extracts fields, writes one ANSI-colored line to stdout. **Silent failure on any parse/render error** — never break the user's prompt.
3. The skills chip is sourced from `<STATE>/skills/<session_id>.log`, populated by two side-channel hooks:
   - `hooks/log-skill.sh` — `PreToolUse` matcher=`Skill`, logs the invoked skill name.
   - `hooks/log-slash-skill.sh` — `UserPromptSubmit`, parses `/<skill>` from prompts; logs only when the skill exists under `$CLAUDE_CONFIG_DIR/skills/` or `./.agents/skills/`.
   - `hooks/cleanup-skills-log.sh` — `SessionEnd`, folds the session's cost into `cost.log` then trims it to ~45 days (see Period cost tracking), removes the session's skill log, and prunes stale skill logs and orphaned cost temp files older than 30 days (for sessions that crashed without firing `SessionEnd`).
   Log format: `<unix_ts> <skill_name>` per line. Renderer reads last entries, dedupes; strips `plugin:` prefix.

When any skills are logged the renderer emits 4 lines: segments, dim `─` rule, `{icons.skills} loaded skills: a, b, c, ...` (all uniques, oldest→newest, no truncation), dim `─` rule. Rule width = terminal columns (min 20, no upper cap). With no skills logged, just the single segment line is printed (no skills chip on line 1).

## Supported segments (rendered left-to-right)

Each segment is emitted only when its source field is present/non-empty. Separator: dim `┊`.

| Segment | Source field | Notes |
|---|---|---|
| model | `model.display_name` | dim; fallback `Claude` |
| effort | `effort.level` | yellow `󰾅` |
| output style | `output_style.name` | `󰏘`; only when not `default` |
| vim mode | `vim.mode` | `` |
| branch | parsed from `.git/HEAD` (no subprocess) | `󰘬`, truncated >50 chars (`first30...lastN`); supports worktree `gitdir:` indirection and detached HEAD (short hash) |
| worktree | `worktree.name`, falls back to `workspace.git_worktree` | `󰘯`; covers plain `git worktree add` worktrees, not only `--worktree` sessions |
| agent | `agent.name` | bold; `󰚩` |
| dir | `workspace.current_dir` basename | `󰉋`; when inside `.../.claude/worktrees/<name>/`, shows parent project name |
| added dirs | `workspace.added_dirs.length` | `+Ndir` |
| cost | `cost.total_cost_usd` + `cost.log` | one grouped segment `s $X.XX · d $X.XX · w $X.XX · m $X.XX` (session / today / since Monday / since the 1st), parts joined by the dim `rsep` dot. Session (`s`) uses absolute USD thresholds (green <$1, yellow <$5, orange <$10, red ≥$10); the period parts are budget-colored (see below). Any part is omitted when its total is ≤0; the whole segment disappears only when all are empty |
| duration | `cost.total_duration_ms` | `󰔛`; `Ns` / `Nm` / `Nh Nm` |
| lines | `cost.total_lines_added` / `total_lines_removed` | `󰷈 +A -R` (green/red) |
| rate limits | `rate_limits.five_hour.used_percentage`, `rate_limits.seven_day.used_percentage` | `󰔚 5h N%`, `󰃭 7d N%`, joined with `·` |
| context | `context_window.used_percentage` (falls back to `100 − remaining_percentage`), `context_window.total_input_tokens` | 10-cell block bar with per-cell coloring (256-color "ramp B": forest → olive → amber → red), dim grey empty cells, `N%` of panic threshold, followed by dim compact input tokens `Xk󰁝`. Replaces the prior standalone `tokens` segment — single segment name `context` |

### Context bar — per-cell palette and thresholds

The bar has 10 cells. Each filled cell gets its own 256-color code from `CTX_RAMP` (`[34, 70, 106, 142, 178, 214, 208, 202, 196, 160]` — forest-green → olive → amber → red → dark-red); empty cells use `CTX_EMPTY` (240, dim grey). So a half-full bar literally fades from forest-green at cell 0 through olive at cell 4; the rightmost filled cell tells you which tier you're in.

**Token-driven fill** (when `total_input_tokens > 0` AND `used_percentage > 0`):

| Model | Cell step | Panic (blink-red + ``) |
|---|---|---|
| 200k | 20k tokens / cell | `≥ 160k` tokens (cell 8 = 80%, restores the prior contract) |
| 1M   | 50k tokens / cell | `≥ 500k` tokens (cell 10 = user-defined danger line) |

So a 200k model fills cell N at `20k · N` tokens; a 1M model fills cell N at `50k · N` tokens. The 200k tier keeps the historical "blink+skull at 80%" alarm so users still get the loud early warning; the 1M tier panics only at the explicit 500k danger line (where `/compact` or handoff should already be considered).

**Percent-driven fallback** (when `total_input_tokens` is missing OR the inference is unreliable — e.g. `used_percentage == 0`): `filled = floor(used_percentage / 10)`; panic at `used_percentage ≥ 80` (matches the original contract). Same per-cell ramp.

**Panic mode**: all 10 cells switch to blink-red and a `` skull is prefixed. The `N%` label keeps showing the raw `used_percentage` (% of context window) in panic too — the skull + blink convey severity, the number tells the user how much of the actual context is consumed.

**1M detection**: inferred `total = total_input_tokens / (used_percentage / 100)`. The 1M tier engages only when `800k < total < 1.2M` — a tight band that accepts integer-rounded 1M payloads but rejects cumulative-token leaks (e.g. a 200k-model session with cumulative input around 600k would have inferred ≈ 750k and stays on 200k thresholds).

**Display percentage**: the `N%` label is the raw `used_percentage` from the payload — i.e. the model's actual context usage. On the 1M tier this decouples from the bar fill, which is calibrated to the 500k panic threshold: e.g. 218k tokens on a 1M model renders a 4-cell bar with label `22%` (218k is 22% of 1M but 44% of the way to the 500k danger line). Keeping the label aligned to context usage matches what users expect when they see "N%".

### Period cost tracking (daily/weekly/monthly)

Cumulative spend across sessions, persisted via a temp-file relay (the `SessionEnd` payload carries no cost field, so the renderer must hand it off).

**Flow** (append-always on the hook side, dedup-on-read on the renderer side):
1. On every render `statusline.js` writes the live `cost.total_cost_usd` to `<STATE>/cost/<session_id>` (plain float).
2. `SessionEnd` (`hooks/cleanup-skills-log.sh`) reads that temp file, appends `<YYYY-MM-DD> <unix_ts> <session_id> <cost>` to `.../claude-statusline/cost.log`, deletes the temp file, then **trims `cost.log` to the last ~45 days** (the monthly window never looks past ≤31 days, so older lines are dead weight on a file read every render) and **prunes orphaned `cost/<session>` temp files >30 days** (crashed sessions that never fired `SessionEnd`), mirroring the skills-log prune.
3. Each render `readPeriodCosts()` buckets `cost.log` by period. Malformed rows (fewer than 4 fields, non-numeric ts/cost, empty id) and **non-positive costs** are skipped (the `c <= 0` guard mirrors the write side, so a corrupt/hand-edited negative can't subtract from a total). Entries are **deduped by `session_id`, keeping the largest (latest cumulative) cost per session** — `total_cost_usd` is cumulative, so a session that ends/resumes/ends-again logs a second larger line; summing both would double-count. The **current live session** is folded in at "now" using its payload cost, which supersedes any logged line for the same id (the resume case). Periods are **local-calendar windows, not rolling age**: period-start unix timestamps — today's midnight, this week's Monday (`(getDay()+6)%7` days back), this month's 1st — and a session counts when its `ts ≥` the relevant start. The `date` column in `cost.log` is cosmetic (human grep); bucketing uses the `ts` column.

   *Known limitations*: (1) a concurrently-running sibling session's in-flight cost (its `cost/<id>` temp file) is not added — each statusline shows ended sessions + its own live cost — so two live sessions transiently under-count the shared day total until one ends. Reading sibling temp files was rejected because stale/orphaned temp files would then persistently inflate every render. (2) Period attribution is whole-session, not per-day: a session's *cumulative* cost is bucketed entirely at one timestamp (`now` for the live session, its end-`ts` for logged ones), so a session left running across midnight (or resumed days later) attributes its full cumulative spend to the day/week it's counted in. The payload only exposes cumulative `total_cost_usd`, not per-day deltas, so finer attribution isn't possible; in practice sessions are usually same-day. The monthly figure is unaffected unless a session spans a month boundary.

**Budget-relative color** (`formatPeriodCost`, % of the period limit): green <50%, yellow <75%, orange <90%, red ≥90% (reddens *before* the limit is hit). Limits derive from `STATUSLINE_MONTHLY_BUDGET`: `daily = budget/30`, `weekly = budget·7/30`, `monthly = budget`. **`STATUSLINE_MONTHLY_BUDGET=0` is an explicit opt-out**: the `d`/`w`/`m` parts are hidden entirely and `readPeriodCosts` is skipped (no `cost.log` read that render). The session cost then renders bare (`$X.XX`, no `s ` prefix — it's the only cost left, so the disambiguator is dropped). A *negative or non-numeric* budget instead falls back to `500` (guards against negatives inverting the color scale). The budget applies only to the `d`/`w`/`m` parts; the session `s` part keeps absolute USD thresholds. The color ladder itself (`green→yellow→orange→red`) is shared via `colorByTier()` between `formatCost` (absolute `[1,5,10]`) and `formatPeriodCost` (ratio `[0.5,0.75,0.9]`).

**Grouping**: session + the three periods render as a single `cost` segment (like `ratelimits`), parts joined by ` <rsep> ` (dim dot in nerd/unicode, `,` in ascii) rather than the top-level `┊` separator — so `STATUSLINE_SEGMENTS` toggles/orders the whole cost cluster as one unit under the name `cost`. Labels are bare `s/d/w/m $X.XX`; the dot between them is the separator.

## Configuration

`STATUSLINE_SEGMENTS` env var (set via `"env"` in `~/.claude/settings.json`) is an optional comma-separated allowlist that also controls render order. Unset/empty = render all. Names match the segment column above. Unknown names ignored. Each segment is tagged via `add(name, value)`; filter applied just before joining.

`STATUSLINE_ICONS=nerd|unicode|ascii` picks the icon set. `nerd` requires a Nerd Font; `unicode` is BMP symbols (no emoji); `ascii` is pure ASCII. Resolved by `resolveIconMode()`: env var wins; else read cached choice from `~/.cache/claude-statusline/icons`; else first-run writes `ascii` to the cache and appends a one-line install hint to the statusline. Per-mode glyphs live in `ICON_SETS` (`effort branch worktree dir duration lines r5h r7d rsep skull style vim agent barFill barEmpty sep skills hr`). Tests force `nerd` via `tests/helpers.js`; `tests/icons.test.js` exercises the other modes.

`STATUSLINE_MONTHLY_BUDGET` — monthly spend limit in USD (default `500`; negative/non-numeric values are ignored and fall back to `500`). **Set to `0` to hide the `d`/`w`/`m` period chips** (the session `s` part still shows). Daily/weekly limits derive proportionally (`budget/30`, `budget·7/30`). Drives the `d`/`w`/`m` parts of the `cost` segment: green <50%, yellow <75%, orange <90%, red ≥90% of period limit.

## Conventions

- **No subprocesses from the renderer.** Statusline runs frequently — keep it cheap. Git branch reads `.git/HEAD` directly.
- **Worktree/branch chip suppression**: when inside a worktree and branch equals `worktree-<name>`, the `󰘬` chip is hidden (the `󰘯` chip conveys it). Reappears on divergence (manual checkout, detached HEAD, rename). Enforced by `tests/worktree.test.js`, `tests/git-branch.test.js`.
- **Color thresholds are part of the contract** and are tested — change them only deliberately.
- **Token compaction** (`formatCompact`): `<1000` raw, `<10k` one decimal (`4.5k`), `<1M` rounded (`15k`), else `1.2M`.

## Testing pattern

`tests/helpers.js` exposes `run(input)` (spawns `statusline.js`, strips ANSI) and `baseInput()` (minimal valid payload). One test file per segment. When changing a segment, update its `tests/*.test.js`; when adding one, add a new file rather than expanding an existing one.

The `cost` segment spans two files: `tests/cost.test.js` (session `s` absolute thresholds) and `tests/period-cost.test.js` (period bucketing, budget colors via data-driven boundary tables, dedup/supersede, malformed-log handling, `STATUSLINE_MONTHLY_BUDGET` parsing/opt-out). `tests/cleanup-hook.test.js` is an **integration** test that spawns the bash `SessionEnd` hook and round-trips its `cost.log` output back through the renderer (proving the cross-process format contract); it `skip`s gracefully when `jq` is absent.
