# Setup prompt for Claude Code

Paste everything below the `---` into a Claude Code session. It is self-contained — Claude Code will install the statusline and (optionally) the skills-logging hooks into your Claude Code settings.

---

You are setting up the `claude-statusline` renderer + hooks for me. Do the steps below in order. Be concise; don't ask before each step — only ask where the prompt explicitly says to. At the end, print one short summary of what was changed.

## 0. Resolve the config dir

Claude Code's settings live at `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json`. Resolve that path once and use it everywhere below — refer to it as `<CONFIG_DIR>` and the settings file as `<CONFIG_DIR>/settings.json`. Do not hardcode `~/.claude`.

## 1. Repo location

1. If the current working directory looks like a clone of `claude-statusline` (contains `hooks/statusline.js`), use it as `<REPO>` and skip to step 2.
2. Otherwise, **ask me where to clone it.** Suggest `~/projects/claude-statusline` as a default but wait for my answer. Then clone:
   ```sh
   git clone https://github.com/michalschroeder/claude-statusline.git <chosen-path>
   ```
   Use the absolute path as `<REPO>` everywhere below.

3. Verify Node 18+ is available: `node --version`. If missing, stop and tell me to install Node 18+. Also check `command -v jq` — `jq` is required for the settings.json edit below and for the skill-logging hooks at runtime; if missing, tell me to install it (`apt install jq` / `brew install jq` / equivalent) before continuing.

4. Sanity-check the renderer works:
   ```sh
   echo '{"model":{"display_name":"Claude"},"workspace":{"current_dir":"/tmp","project_dir":"/tmp"}}' | node <REPO>/hooks/statusline.js
   ```
   It should print a single ANSI-colored line. If it errors, stop.

## 2. Pick icon mode

Three sets are available via the `STATUSLINE_ICONS` env var:

- **`nerd`** — prettiest; **requires a [Nerd Font](https://github.com/ryanoasis/nerd-fonts) installed AND selected as the terminal font.** The repo author uses `JetBrainsMono Nerd Font`, but any official Nerd Font works — they're all patched `--complete`, so they all carry the Material Design Icons glyphs the statusline uses. If no Nerd Font is selected in the terminal, `nerd` glyphs render as tofu/boxes.
- **`unicode`** — works in any modern Unicode-capable font (almost every desktop terminal). No extra install.
- **`ascii`** — pure ASCII, works anywhere.

Ask me which mode I want. Before recommending `nerd`, explicitly ask whether my terminal is already configured with a Nerd Font; if not, tell me to grab one from the [Nerd Fonts repo](https://github.com/ryanoasis/nerd-fonts) and set it as my terminal font first, or pick `unicode`/`ascii` instead. Remember the choice as `<ICONS>`.

## 3. Edit `<CONFIG_DIR>/settings.json`

Create the file as `{}` if missing. **Merge** — do not overwrite existing keys. Preserve any unrelated `statusLine`, `hooks`, `env`, etc.; only add what's missing.

Use `jq` for the edit (atomic write via tmpfile + `mv`). If `jq` is unavailable, parse the JSON in Node, mutate, and write it back — never hand-edit with sed.

### 3a. `statusLine` (required)

```json
"statusLine": {
  "type": "command",
  "command": "node <REPO>/hooks/statusline.js"
}
```

If a `statusLine` already exists pointing at a different command, ask me before replacing it.

### 3b. `env.STATUSLINE_ICONS` (required)

Set `env.STATUSLINE_ICONS` to `<ICONS>`. Leave other `env` keys alone.

### 3c. Hooks (optional — required only for the "loaded skills" chip)

Ask me whether to install the skill-logging hooks. If yes, append (don't replace) these three entries. Each lives under `hooks.<event>` as an array — append a new array element rather than overwriting existing matchers.

- `hooks.PreToolUse` — entry with `"matcher": "Skill"`, command `<REPO>/hooks/log-skill.sh`
- `hooks.UserPromptSubmit` — entry with no matcher and **two** commands: `<REPO>/hooks/log-slash-skill.sh` AND `node <REPO>/hooks/refresh-cost-cache.js`
- `hooks.SessionEnd` — entry with no matcher, command `<REPO>/hooks/cleanup-skills-log.sh`

The `PreToolUse`/`UserPromptSubmit` slash-logger hooks plus the `SessionEnd` hook write/clean the skills log — they only power the skills chip. The second `UserPromptSubmit` command, `refresh-cost-cache.js`, rebuilds the daily/weekly/monthly cost cache once per prompt; without it the d/w/m cost chips won't update (the session cost chip still works). The statusline works without any of these.

Shape of each entry:
```json
{ "matcher": "Skill", "hooks": [{ "type": "command", "command": "<REPO>/hooks/log-skill.sh" }] }
```
The `UserPromptSubmit` entry has no matcher and lists both commands:
```json
{ "hooks": [
  { "type": "command", "command": "<REPO>/hooks/log-slash-skill.sh" },
  { "type": "command", "command": "node <REPO>/hooks/refresh-cost-cache.js" }
]}
```
(`SessionEnd` is the same single-command shape as `PreToolUse` but with no matcher.)

Before appending, scan the existing array — if an identical command is already registered, skip it (idempotent).

The skill-logger hooks need `jq` at runtime. Check `command -v jq`; if missing, tell me to install it (`apt install jq` / `brew install jq` / etc.) but continue — the statusline itself works without `jq`.

### 3d. Make hook scripts executable

```sh
chmod +x <REPO>/hooks/*.sh
```

## 4. Verify

1. Show me the new keys added to `<CONFIG_DIR>/settings.json` (pretty-printed with `jq`).
2. Re-run the sanity-check echo from step 1.4.
3. Tell me to restart Claude Code (or open a new session) for the statusline + hooks to take effect.

## 5. Summary to print at the end

- Config dir resolved (and whether from `CLAUDE_CONFIG_DIR` or default)
- Repo path used
- Icon mode chosen (and reminder if `nerd` was chosen but font not yet installed)
- Whether skill-logging hooks were installed (yes/no, plus whether `jq` is present)
- Path to settings file edited
- "Next step: restart Claude Code"

That's it. Don't add anything I didn't ask for — no `STATUSLINE_SEGMENTS` (let it default to "render all"), no symlinks into `<CONFIG_DIR>/hooks/`.
