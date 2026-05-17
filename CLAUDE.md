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
3. The skills chip is sourced from `/tmp/claude-skills-<session_id>.log`, populated by two side-channel hooks:
   - `hooks/log-skill.sh` — `PreToolUse` matcher=`Skill`, logs the invoked skill name.
   - `hooks/log-slash-skill.sh` — `UserPromptSubmit`, parses `/<skill>` from prompts; logs only when the skill exists under `$CLAUDE_CONFIG_DIR/skills/` or `./.agents/skills/`.
   Log format: `<unix_ts> <skill_name>` per line. Renderer reads last entries, dedupes most-recent-first, shows 3 with `+N` overflow; strips `plugin:` prefix.

## Supported segments (rendered left-to-right)

Each segment is emitted only when its source field is present/non-empty. Separator: dim `│`.

| Segment | Source field | Notes |
|---|---|---|
| model | `model.display_name` | dim; fallback `Claude` |
| effort | `effort.level` | yellow `󰾅` |
| skills | `/tmp/claude-skills-<session>.log` | last 3 unique, most-recent-first, reversed; `+N` overflow |
| output style | `output_style.name` | only when not `default` |
| vim mode | `vim.mode` | `vim:<mode>` |
| branch | parsed from `.git/HEAD` (no subprocess) | `⎇`, truncated >50 chars (`first30...lastN`); supports worktree `gitdir:` indirection and detached HEAD (short hash) |
| worktree | `worktree.name` | `⊕` |
| agent | `agent.name` | bold |
| dir | `workspace.current_dir` basename | `󰉋`; when inside `.../.claude/worktrees/<name>/`, shows parent project name |
| added dirs | `workspace.added_dirs.length` | `+Ndir` |
| cost | `cost.total_cost_usd` | `$X.XX`; green <$1, yellow <$5, orange <$10, red ≥$10 |
| tokens | `context_window.total_input_tokens` / `total_output_tokens` | compact (`k`/`M`), `↑` input, `↓` output |
| duration | `cost.total_duration_ms` | `⏱`; `Ns` / `Nm` / `Nh Nm` |
| lines | `cost.total_lines_added` / `total_lines_removed` | `󰷈 +A -R` (green/red) |
| rate limits | `rate_limits.five_hour.used_percentage`, `rate_limits.seven_day.used_percentage` | `󰔚 5h N%`, `󰃭 7d N%`, joined with `·` |
| context bar | `context_window.remaining_percentage` | 10-cell block bar + `N%`; green <50%, yellow <65%, orange <80%, blink-red 💀 ≥80% |

Read but currently unused: `data.thinking.enabled`, `data.session_name`, `data.version`.

## Configuration

`STATUSLINE_SEGMENTS` env var (set via `"env"` in `~/.claude/settings.json`) is an optional comma-separated allowlist that also controls render order. Unset/empty = render all. Names match the segment column above. Unknown names ignored. Each segment is tagged via `add(name, value)`; filter applied just before joining.

`STATUSLINE_ICONS=nerd|unicode|ascii` picks the icon set. `nerd` requires a Nerd Font; `unicode` is BMP symbols (no emoji); `ascii` is pure ASCII. Resolved by `resolveIconMode()`: env var wins; else read cached choice from `~/.cache/claude-statusline/icons`; else first-run writes `ascii` to the cache and appends a one-line install hint to the statusline. Per-mode glyphs live in `ICON_SETS` (`effort branch worktree dir duration lines r5h r7d rsep skull up down barFill barEmpty sep`). Tests force `nerd` via `tests/helpers.js`; `tests/icons.test.js` exercises the other modes.

## Conventions

- **No subprocesses from the renderer.** Statusline runs frequently — keep it cheap. Git branch reads `.git/HEAD` directly.
- **Worktree/branch chip suppression**: when inside a worktree and branch equals `worktree-<name>`, the `⎇` chip is hidden (the `⊕` chip conveys it). Reappears on divergence (manual checkout, detached HEAD, rename). Enforced by `tests/worktree.test.js`, `tests/git-branch.test.js`.
- **Color thresholds are part of the contract** and are tested — change them only deliberately.
- **Token compaction** (`formatCompact`): `<1000` raw, `<10k` one decimal (`4.5k`), `<1M` rounded (`15k`), else `1.2M`.

## Testing pattern

`tests/helpers.js` exposes `run(input)` (spawns `statusline.js`, strips ANSI) and `baseInput()` (minimal valid payload). One test file per segment. When changing a segment, update its `tests/*.test.js`; when adding one, add a new file rather than expanding an existing one.
