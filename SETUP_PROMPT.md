# Setup prompt for Claude Code

Paste everything below the `---` into a Claude Code session. It is self-contained: Claude Code will clone the repo, edit your settings and, if you want, wire up the skills-logging and cost-cache hooks.

---

Set up the `claude-statusline` renderer + hooks for me. Do the steps in order. Be concise. Ask only when a wrong guess would touch my config or my preferences; otherwise proceed. Print one short summary at the end.

## 0. Config dir

Claude Code's settings live at `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json`. Resolve that once, call it `<CONFIG_DIR>`, use it everywhere below, even where the README shows `~/.claude`.

## 1. Repo + prerequisites

1. If the cwd is already a clone (contains `hooks/statusline.js`), use it as `<REPO>`. Otherwise **ask me where to clone**, suggesting `~/projects/claude-statusline`, then:
   ```sh
   git clone https://github.com/michalschroeder/claude-statusline.git <chosen-path>
   ```
   `<REPO>` is the absolute path.
2. `node --version` must be 18+. If not, stop and tell me to install Node.
3. `command -v jq`. Optional: only the skills-logging hooks need it at runtime. If missing, say so (`apt install jq` / `brew install jq`) and continue.
4. Sanity check:
   ```sh
   echo '{"model":{"display_name":"Claude"},"workspace":{"current_dir":"/tmp","project_dir":"/tmp"}}' | node <REPO>/hooks/statusline.js
   ```
   Expect one ANSI-colored line plus a dim rule. A one-line "icons" hint may follow because `STATUSLINE_ICONS` isn't set yet; that's fine. If the renderer fails, fix or report it before touching settings.

## 2. Icon mode

`STATUSLINE_ICONS` picks the set:

- `nerd`: prettiest, **needs a [Nerd Font](https://github.com/ryanoasis/nerd-fonts) installed AND selected as the terminal font**, else glyphs render as boxes. Any official Nerd Font works.
- `unicode`: any modern terminal font, no install.
- `ascii`: works anywhere.

Ask me which. Before offering `nerd`, ask whether my terminal already uses a Nerd Font; if not, tell me to set one up first or pick `unicode`/`ascii`. Call the choice `<ICONS>`.

## 3. Edit `<CONFIG_DIR>/settings.json`

Create as `{}` if missing. **Merge**: every existing key, including other `hooks`/`env` content, must survive intact. The only key you may replace is `statusLine`, and only after I say yes (3.1). Edit with a JSON-aware tool so the file stays valid JSON: `jq` (write to a tmpfile, then `mv`), or Node if `jq` is absent.

`<REPO>/README.md` under **Install** is the reference for the JSON *shape* of every key below; don't invent fields. Its file paths use `~/.claude`; substitute `<CONFIG_DIR>`.

1. `statusLine` (required): `{"type":"command","command":"node <REPO>/hooks/statusline.js"}`. If a `statusLine` pointing at a different command already exists, ask me before replacing it.
2. `env.STATUSLINE_ICONS` (required): `<ICONS>`. Leave other `env` keys alone.
3. Hooks (optional). Ask me whether to install them. If yes, add entries to the `hooks.<event>` arrays so that afterwards each command appears exactly once in its event array and existing entries are untouched:
   - `PreToolUse`, matcher `Skill` → `<REPO>/hooks/log-skill.sh`
   - `UserPromptSubmit`, no matcher, two commands → `<REPO>/hooks/log-slash-skill.sh` and `node <REPO>/hooks/refresh-cost-cache.js`
   - `SessionEnd`, no matcher → `<REPO>/hooks/cleanup-skills-log.sh`

   The three `.sh` hooks power the loaded-skills line (need `jq`). `refresh-cost-cache.js` rebuilds the daily/weekly/monthly cost cache once per prompt; without it the `d`/`w`/`m` chips never update (the session chip still works). The statusline itself works with none of them.
4. `chmod +x <REPO>/hooks/*.sh`

Install only what makes the statusline render. Tuning vars (`STATUSLINE_SEGMENTS`, `STATUSLINE_MONTHLY_BUDGET`, `STATUSLINE_TIMEZONE`, `STATUSLINE_COST_MULTIPLIER`) and symlinks into `<CONFIG_DIR>/hooks/` are mine to add later from the README; defaults already render everything.

## 4. Verify

1. Show the keys you added to `<CONFIG_DIR>/settings.json`, pretty-printed.
2. Re-run the sanity check from step 1.4.
3. Tell me to restart Claude Code (or open a new session) so the statusline and hooks take effect.

## 5. Summary

- Config dir (and whether it came from `CLAUDE_CONFIG_DIR` or the default)
- Repo path
- Icon mode (plus a reminder if `nerd` and the font isn't set up yet)
- Hooks installed yes/no, and whether `jq` is present
- Settings file edited
- "Next step: restart Claude Code"
