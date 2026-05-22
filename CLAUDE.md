# CLAUDE.md

## Commands

- Run all tests: `node --test tests/*.test.js`
- Run a single test file: `node --test tests/cost.test.js`
- Manual statusline check: `echo '{"model":{"display_name":"Claude"},"workspace":{"current_dir":"/tmp","project_dir":"/tmp"}}' | node hooks/statusline.js`

No build step, no linter, no package.json — pure Node stdlib (Node 18+).

## Architecture

Single-process statusline renderer plus two bash logging hooks. Data flow:

1. Claude Code spawns `hooks/statusline.js` per render and pipes a JSON status payload on stdin.
2. `statusline.js` reads stdin, extracts fields, writes one ANSI-colored line to stdout. **Silent failure on any parse/render error** — never break the user's prompt.
3. The skills chip is sourced from `${XDG_STATE_HOME:-$HOME/.local/state}/claude-statusline/skills/<session_id>.log`, populated by two side-channel hooks:
   - `hooks/log-skill.sh` — `PreToolUse` matcher=`Skill`, logs the invoked skill name.
   - `hooks/log-slash-skill.sh` — `UserPromptSubmit`, parses `/<skill>` from prompts; logs only when the skill exists under `$CLAUDE_CONFIG_DIR/skills/` or `./.agents/skills/`.
   - `hooks/cleanup-skills-log.sh` — `SessionEnd`, removes the session's log file; also prunes any `*.log` older than 30 days (for sessions that crashed without firing `SessionEnd`).
   Log format: `<unix_ts> <skill_name>` per line. Renderer reads last entries, dedupes; strips `plugin:` prefix.

When any skills are logged the renderer emits 4 lines: segments, dim `─` rule, `{icons.skills} loaded skills: a, b, c, ...` (all uniques, oldest→newest, no truncation), dim `─` rule. Rule width = terminal columns, clamped 20–120. With no skills logged, just the single segment line is printed (no skills chip on line 1).

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
| cost | `cost.total_cost_usd` | `$X.XX`; green <$1, yellow <$5, orange <$10, red ≥$10 |
| duration | `cost.total_duration_ms` | `󰔛`; `Ns` / `Nm` / `Nh Nm` |
| lines | `cost.total_lines_added` / `total_lines_removed` | `󰷈 +A -R` (green/red) |
| rate limits | `rate_limits.five_hour.used_percentage`, `rate_limits.seven_day.used_percentage` | `󰔚 5h N%`, `󰃭 7d N%`, joined with `·` |
| context | `context_window.used_percentage` (falls back to `100 − remaining_percentage`), `context_window.total_input_tokens` | 10-cell block bar with per-cell coloring (256-color "ramp B": forest → olive → amber → red), dim grey empty cells, `N%` of panic threshold, followed by dim compact input tokens `Xk󰁝`. Replaces the prior standalone `tokens` segment — single segment name `context` |

### Context bar — per-cell palette and thresholds

The bar has 10 cells. Each filled cell gets its own 256-color code from `CTX_RAMP` (`[34, 70, 106, 142, 178, 214, 208, 202, 196, 160]` — forest-green → olive → amber → red → dark-red); empty cells use `CTX_EMPTY` (240, dim grey). So a half-full bar literally fades from forest-green at cell 0 through olive at cell 4; the rightmost filled cell tells you which tier you're in.

**Token-driven fill** (when `total_input_tokens > 0`):

| Model | Cell step | Panic threshold |
|---|---|---|
| 200k | 20k tokens / cell | `≥ 200k` tokens |
| 1M   | 50k tokens / cell | `≥ 500k` tokens |

So a 200k model fills cell N at `20k · N` tokens (panic at 200k = full window); a 1M model fills cell N at `50k · N` tokens (panic at 500k — half the real window, but the practical danger line where `/compact` or handoff should already be considered).

**Percent-driven fallback** (when `total_input_tokens` is missing): `filled = floor(used_percentage / 10)`; panic at `used_percentage ≥ 100`. Same per-cell ramp.

**Panic mode**: all 10 cells switch to blink-red and a `` skull is prefixed.

**1M detection**: inferred `total = total_input_tokens / (used_percentage / 100)`. The 1M tier engages only when `500k < total < 1.3M` — the upper bound guards against `total_input_tokens` ever being cumulative session input (would falsely promote 200k models). Inferred totals outside that band use 200k thresholds.

**Display percentage**: the `N%` label is the bar fill (% of the panic threshold), so the percentage and the bar always agree. For a 200k model this is identical to `used_percentage`; for a 1M model the label runs ahead of the model's true usage because the bar is calibrated to the danger line, not the model limit.

Read but currently unused: `data.thinking.enabled`, `data.session_name`, `data.version`.

## Configuration

`STATUSLINE_SEGMENTS` env var (set via `"env"` in `~/.claude/settings.json`) is an optional comma-separated allowlist that also controls render order. Unset/empty = render all. Names match the segment column above. Unknown names ignored. Each segment is tagged via `add(name, value)`; filter applied just before joining.

`STATUSLINE_ICONS=nerd|unicode|ascii` picks the icon set. `nerd` requires a Nerd Font; `unicode` is BMP symbols (no emoji); `ascii` is pure ASCII. Resolved by `resolveIconMode()`: env var wins; else read cached choice from `~/.cache/claude-statusline/icons`; else first-run writes `ascii` to the cache and appends a one-line install hint to the statusline. Per-mode glyphs live in `ICON_SETS` (`effort branch worktree dir duration lines r5h r7d rsep skull style vim agent barFill barEmpty sep skills hr`). Tests force `nerd` via `tests/helpers.js`; `tests/icons.test.js` exercises the other modes.

## Conventions

- **No subprocesses from the renderer.** Statusline runs frequently — keep it cheap. Git branch reads `.git/HEAD` directly.
- **Worktree/branch chip suppression**: when inside a worktree and branch equals `worktree-<name>`, the `󰘬` chip is hidden (the `󰘯` chip conveys it). Reappears on divergence (manual checkout, detached HEAD, rename). Enforced by `tests/worktree.test.js`, `tests/git-branch.test.js`.
- **Color thresholds are part of the contract** and are tested — change them only deliberately.
- **Token compaction** (`formatCompact`): `<1000` raw, `<10k` one decimal (`4.5k`), `<1M` rounded (`15k`), else `1.2M`.

## Testing pattern

`tests/helpers.js` exposes `run(input)` (spawns `statusline.js`, strips ANSI) and `baseInput()` (minimal valid payload). One test file per segment. When changing a segment, update its `tests/*.test.js`; when adding one, add a new file rather than expanding an existing one.
