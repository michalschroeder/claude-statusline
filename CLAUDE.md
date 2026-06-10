# CLAUDE.md

## Commands

- Run all tests: `node --test tests/*.test.js`
- Run a single test file: `node --test tests/cost.test.js`
- Manual statusline check: `echo '{"model":{"display_name":"Claude"},"workspace":{"current_dir":"/tmp","project_dir":"/tmp"}}' | node hooks/statusline.js`

No build step, no linter, no package.json — pure Node stdlib (Node 18+).

## Architecture

Single-process statusline renderer plus two bash logging hooks.

**State dir** (`<STATE>` below): resolved identically by the renderer and all three hooks as `${XDG_STATE_HOME:-$HOME/.local/state}/claude-statusline/<profile>`. Data **always lives in our own XDG namespace — never inside `CLAUDE_CONFIG_DIR`**, which is Claude Code's own managed dir (full of generic-named subdirs it prunes via `.last-cleanup`); writing there risks colliding with a future CC feature. `CLAUDE_CONFIG_DIR` is used only as a **per-subscription key**: its path (leading `/` stripped, remaining `/`→`_`, e.g. `/home/u/.claude-x` → `home_u_.claude-x`) becomes the `<profile>` subdir, so distinct subscriptions/profiles keep separate skill logs. When `CLAUDE_CONFIG_DIR` is unset (single-profile users), `<profile>` is empty → flat `…/claude-statusline/` layout, unchanged. The renderer (`hooks/statusline.js`, `replace(/^\//,'').replace(/\//g,'_')`) and the bash hooks (`${CLAUDE_CONFIG_DIR#/}` then `${profile//\//_}`) must produce the same profile string — covered by `tests/state-dir.test.js`.

### State-dir lib (`lib/state.js`)

`resolveStateDir(configDir)` (the `/`→`_` profile mangling) lives in `lib/state.js`, required by
the renderer (`hooks/statusline.js`) to locate the skills log. Single source of truth for the JS
side; the bash hooks reimplement the same mangling independently.

### Session viewer (`bin/sessions.js`)

Standalone CLI (NOT the renderer — may use whatever it needs, but is pure Node anyway). Lists
recent sessions joined to ai-title + recap parsed in-process from the CC transcript via
`lib/transcript.js` (`findTranscript`, `readTitleRecap` — last `ai-title` / last `away_summary`,
disclaimer stripped, subagent transcripts excluded; `listSessions` enumerates
`projects/*/<id>.jsonl`, newest-first by file **mtime** — the session's `ts`). Config-dir
resolution: `--config-dir` ?? `CLAUDE_CONFIG_DIR`, the transcript root for `projects/` discovery
(default `~/.claude`). Flags: `--last N` (default 10), `--since YYYY-MM-DD` (lower ts bound;
without `--last` shows all matches), `--config-dir <path>`. A bare positional arg
(`sessions.js <id-prefix>`) switches to a per-session **detail view**: prefix-matched against
session ids (zero matches or ambiguous → exit 1). It renders a header (title/recap/total),
`WHERE IT WENT` (cost split by token type — cache-read/input/output/cache-write/web, with
proportion bars), `WHAT FILLED CONTEXT` (top 10 `summary.contextConsumers` rows — est tokens,
carried re-read cost, tool, concrete target), `THINKING` (only when `summary.assistantOutput.thinking`
exists — headline tokens/$ at the output rate, interleaved-vs-stored split, per-step stats + peak
step, `TOP BURSTS` (heaviest single reasoning bursts: trigger — what landed in context right
before — → next action) and a `BY TURN` sub-table naming which prompts drove the reasoning),
`BY SKILL` (only when skill dispatches exist — cost/steps of the turns each skill drove),
`BY MODEL`, `TOP PROMPTS` (main-session user prompts ranked by the cost of the
turns they drove, rendered as an aligned table with a header row:
`cost · steps · input · cache-rd · cache-wr · output · tools · prompt` — steps = model responses
incl. each tool-use round; the four token columns are the per-turn sums of fresh input / cache-read
/ cache-write / output, where **cache-rd** dominates the cost, which is why a short late prompt over
a large context can cost more than a long early one; tools = the turn's top-3 `tool_use` tally —
plus a `+ $X across N subagents` line), and `BY AGENT` (only when subagents exist; each agent is
labelled by its task — the subagent's first prompt, falling back to the `agent-<hash>` stem). A
`sessions.js <prefix> --analyze` flag swaps the rendered table for a full-fidelity **JSON** payload meant
for an LLM/agent to reason about *why* a session was costly: raw integer tokens (no compaction),
untruncated prompts, full tool tallies, a `legend` stating the cost model, plus `turns` (main-session
prompts in **execution** order, each with `turnIndex`/`kind`/`avgContext`/`peakContext`; turns are keyed
by a monotonic **turn index**, not prompt text, so repeated identical prompts like "continue" stay
distinct rows), `calls` (every billed assistant call, chronological, each carrying `turnIndex` (which
turn it served) and `tokens.cacheRead` = the context size at that step; the top-level `steps`/`calls`
count **all** billed calls incl. subagents, while `summary.mainSteps` is the main-session-only
denominator the per-step views — `contextGrowth`, the timeline, thinking `seq` — use), and a
derived `summary` — `durationMs`, `mainSteps`, `contextGrowth` (per-step cacheRead: firstCall + 4 quartile averages +
peak, the honest growth curve since a turn's `tokens.cacheRead` is a per-step **sum**, not context size),
`byTurnKind` (cost/token totals grouped by `turnKind` — `skill` / `subagent-orchestration` /
`user` / `session-start` — so "how much did all the review passes cost" is one lookup), `toolTally`
(canonical main-session tool counts — consumers that re-aggregate `calls[].tools` tend to inflate it),
`highContextCost` (calls + cost spent above 200k context — the spend a `/compact` would have cut),
`contextResets` (how many times context was cleared, a step-to-step cacheRead drop > 100k), and
`contextConsumers` (WHAT filled the context, attributed to concrete targets — which file each Read
pulled in, which Bash command, which user prompt — via tool_use→tool_result pairing, `estTokens`
≈ chars/4, `carriedCost` ≈ estTokens × steps-remaining × blended cache-read rate, plus synthetic
rows so the rollup explains ~all of peak context: `session-overhead` and the model's own output
split by kind — `assistant-text` / `assistant-thinking` / `assistant-tool-calls`, apportioned
from each call's exact `output_tokens` by content-block char share, with the tool-calls label
naming the top arg-writers, e.g. `Edit 36k · Bash 10k`), and `assistantOutput` (the drill-down
behind the assistant-* rows: `byKind` token/cost split — `text`/`thinking`/`toolCalls` — and a
`thinking` breakdown: `storedTokens` vs `unstoredTokens` (interleaved thinking billed in
`output_tokens` but never written to the transcript — inferred as output_tokens minus visible
chars/4), `stepsWithThinking`/`mainSteps`/`avgPerThinkingStep`, `peakStep`, `topSteps` (heaviest bursts,
each with its `trigger` — the tool result/prompt that landed right before — and `nextTools`), and
`byTurn` — which prompts drove the reasoning; `null` thinking when none), and `bySkill` (cost per
skill dispatch — skill name extracted from the expansion prompt's base-directory path or the
`/slash` command; sums only the turns the dispatch itself drove). Backed by the
pure `lib/session-detail.js` (`buildDetail`, which now also returns `turns`/`perCall`/`summary`), which
reuses the same dedup as
`lib/cost-aggregate.js` so the detail total equals the list COST, and by `calculateCostBreakdown` in
`lib/cost-compute.js` (the itemized form of `calculateCost`). Renders day-grouped rows (a dim
`── Ddd Mmm DD ──` rule per local day) of
`HH:MM · relative-age · cost · title · full-session-id`; titles/recaps are width-truncated only (no
redaction). The **full** session id (copy-paste-resumable via `claude --resume <id>`) is right-aligned,
prefixed with a dim `id ` label and rendered in steel-blue (`cyan` in `lib/color.js`), and dropped on
terminals too narrow to leave a usable title (< 20 cols). Sessions are separated by a blank line within a
day group. Recaps render as a dim `└` sub-line. No
`--all-profiles`. In **list** mode (no prefix) `--analyze` swaps the rendered list for a JSON payload for
agents: `{ sessions: [{ session, title, recap, startedAt (ISO), cost }], periods: {today,week,month},
monthlyBudget }` — sessions in the same newest-first order, honoring `--last`/`--since`, valid JSON even on
an empty store. (With a prefix `--analyze` is the detail payload above.) The footer shows today/week/month budget bars (`▓`/`░`, budget-relative coloring) when
`STATUSLINE_MONTHLY_BUDGET` is set, else a plain `today $X · week $Y · month $Z` line. Terminal width =
TTY columns, else `COLUMNS`, else 80. Same recomputed costs as the renderer. Subagent
transcripts are excluded from the **session listing** (they're not user sessions) but their cost IS
folded into the parent session's COST (via `lib/cost-aggregate.js`).

### Cost pipeline

Costs are **recomputed from raw token counts × LiteLLM per-token prices** — never Claude's reported
`cost.total_cost_usd`. Libs:

- `lib/cost-compute.js` — pure per-call math (tokens × prices). 5m cache write = 1.25× input, 1h cache write = 2× input (computed as `cacheWrite × 1.6`), cache read = 0.1× input. Supports a generic long-context (>200K input) `above200k` premium tier per call **when a price entry defines one** — but per Anthropic's current pricing **no Claude model has a >200K premium** (Opus 4.6+/Sonnet 4.6 serve the full 1M at standard rates), so the bundled snapshot defines none and the tier stays dormant. Also exports `calculateCostBreakdown` (itemized per-component cost — `{input, output, cacheWrite, cacheRead, web, total}`; `calculateCost` is its `.total`).
- `lib/pricing.js` — LiteLLM price table; bundled snapshot `data/model_prices.json` + background fetch at most every 24h. **Never fetched from the renderer.** Still extracts `*_above_200k_tokens` premium rates if an upstream entry carries them (dormant for current Claude models).
- `lib/cost-aggregate.js` — parses transcripts (main session files **and** nested `<session>/subagents/agent-*.jsonl`, whose token usage Anthropic bills — attributed to the parent session; only `agent-*.jsonl` are billed, other sidecar files under `subagents/` are ignored), dedups streaming message ids (within-file + globally across files), buckets each call into local-day keys, maintains an incremental `<STATE>/cost-cache.json` keyed by file mtime/size; cache invalidated on a pricing-hash change. `writeCache` also emits a slim `<STATE>/cost-summary.json` (`{pricingHash, perSession}`, no bulky `files`/`calls` blob) for the renderer; `readSummary` reads it (falling back to the full cache for back-compat).
- `lib/periods.js` — local-calendar day/week/month window sums over the buckets.
- `lib/budget.js` — `resolveBudget` (reads `STATUSLINE_MONTHLY_BUDGET`; daily = monthly/30, weekly = monthly×7/30).

The `UserPromptSubmit` hook `hooks/refresh-cost-cache.js` rebuilds `cost-cache.json` (and the slim
`cost-summary.json`) over the last 40 days, off the render hot path. The renderer reads the slim
summary (`readSummary`, only when the `cost` segment is enabled — keeps the read off the hot path
when hidden) and sums today/week/month across **all** sessions including the current one (whose
day-buckets carry correct per-day attribution). Claude's live payload cost is fresher but undated,
so the renderer folds only the **delta** (`max(0, live − cachedSessionTotal)`) into the current
windows — this keeps a session resumed across days from dumping its whole lifetime into "today" and
makes the `s` chip recomputed-based rather than the reported `total_cost_usd`.

Data flow:

1. Claude Code spawns `hooks/statusline.js` per render and pipes a JSON status payload on stdin.
2. `statusline.js` reads stdin, extracts fields, writes one ANSI-colored line to stdout. **Silent failure on any parse/render error** — never break the user's prompt.
3. The skills chip is sourced from `<STATE>/skills/<session_id>.log`, populated by two side-channel hooks:
   - `hooks/log-skill.sh` — `PreToolUse` matcher=`Skill`, logs the invoked skill name.
   - `hooks/log-slash-skill.sh` — `UserPromptSubmit`, parses `/<skill>` from prompts; logs only when the skill exists under `$CLAUDE_CONFIG_DIR/skills/` or `./.agents/skills/`.
   - `hooks/cleanup-skills-log.sh` — `SessionEnd`, removes the session's skill log and prunes stale skill logs older than 30 days (for sessions that crashed without firing `SessionEnd`).
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
| cost | `cost.total_cost_usd` + `cost-summary.json` | s/d/w/m chip group joined by dim `·`. `s` = this session's recomputed spend (cached recomputed total + live delta), absolute USD thresholds (green <$1, yellow <$5, orange <$10, red ≥$10), omitted when ≤0. `d`/`w`/`m` = today / this week / this month = **all sessions' recomputed, day-bucketed spend (from `cost-summary.json`) + the current session's live delta (`max(0, live − cached total)`) folded into the current windows**, budget-relative coloring via `STATUSLINE_MONTHLY_BUDGET`. d/w/m hidden when `STATUSLINE_MONTHLY_BUDGET=0` |
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

## Configuration

`STATUSLINE_SEGMENTS` env var (set via `"env"` in `~/.claude/settings.json`) is an optional comma-separated allowlist that also controls render order. Unset/empty = render all. Names match the segment column above. Unknown names ignored. Each segment is tagged via `add(name, value)`; filter applied just before joining.

`STATUSLINE_MONTHLY_BUDGET` env var sets the budget for the cost segment's d/w/m budget-relative
coloring. Unset → $1000/mo default; `0` → hide d/w/m chips; a number → that monthly budget. Derived:
daily = monthly/30, weekly = monthly×7/30. Resolved by `lib/budget.js` (`resolveBudget`).

`STATUSLINE_ICONS=nerd|unicode|ascii` picks the icon set. `nerd` requires a Nerd Font; `unicode` is BMP symbols (no emoji); `ascii` is pure ASCII. Resolved by `resolveIconMode()`: env var wins; else read cached choice from `~/.cache/claude-statusline/icons`; else first-run writes `ascii` to the cache and appends a one-line install hint to the statusline. Per-mode glyphs live in `ICON_SETS` (`effort branch worktree dir duration lines r5h r7d rsep skull style vim agent barFill barEmpty sep skills hr`). Tests force `nerd` via `tests/helpers.js`; `tests/icons.test.js` exercises the other modes.

## Conventions

- **No subprocesses from the renderer.** Statusline runs frequently — keep it cheap. Git branch reads `.git/HEAD` directly.
- **Worktree/branch chip suppression**: when inside a worktree and branch equals `worktree-<name>`, the `󰘬` chip is hidden (the `󰘯` chip conveys it). Reappears on divergence (manual checkout, detached HEAD, rename). Enforced by `tests/worktree.test.js`, `tests/git-branch.test.js`.
- **Color thresholds are part of the contract** and are tested — change them only deliberately.
- **Token compaction** (`formatCompact`): `<1000` raw, `<10k` one decimal (`4.5k`), `<1M` rounded (`15k`), else `1.2M`.

## Testing pattern

`tests/helpers.js` exposes `run(input)` (spawns `statusline.js`, strips ANSI) and `baseInput()` (minimal valid payload). One test file per segment. When changing a segment, update its `tests/*.test.js`; when adding one, add a new file rather than expanding an existing one.

The cost pipeline is covered by `tests/cost-compute.test.js`, `tests/pricing.test.js`, `tests/budget.test.js`, `tests/periods.test.js`, `tests/cost-aggregate.test.js`, `tests/refresh-cost-cache.test.js`, and `tests/period-cost.test.js` (renderer d/w/m chips). The `cost` segment is covered by `tests/cost.test.js` (session absolute thresholds). `tests/cleanup-hook.test.js` is an **integration** test that spawns the bash `SessionEnd` hook to verify skill-log removal/pruning; it `skip`s gracefully when `jq` is absent. The session viewer has `tests/sessions-viewer.test.js` (transcript-sourced listing, day grouping, full id,
budget-bar footer, `--last`/`--since`) and `tests/sessions-format.test.js` (pure formatting helpers:
relative time, day labels, bar fill, truncate); `lib/transcript.js` has `tests/transcript.test.js`.
The session detail view has `tests/session-detail.test.js` (`buildDetail`: dedup parity with
aggregate, token-type split, turn attribution, subagent split) plus detail-mode integration tests in
`tests/sessions-viewer.test.js`.
