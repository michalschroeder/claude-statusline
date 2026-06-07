#!/usr/bin/env bash
# SessionEnd hook: remove this session's skill log; prune stale logs (>30d) from
# sessions that crashed without firing SessionEnd.
input=$(cat)
session=$(printf '%s' "$input" | jq -r '.session_id // empty')
# State dir (must match hooks/statusline.js): data lives in our own XDG namespace,
# never inside CLAUDE_CONFIG_DIR (Claude Code's managed dir). CLAUDE_CONFIG_DIR is
# only a per-subscription key — its sanitized path becomes a profile subdir; unset
# → empty → flat layout.
root="${XDG_STATE_HOME:-$HOME/.local/state}/claude-statusline"
profile="${CLAUDE_CONFIG_DIR#/}"; profile="${profile//\//_}"
state="${profile:+$root/$profile}"
state="${state:-$root}"

[ -n "$session" ] && rm -f "$state/skills/$session.log"

# Prune stale skill logs (>30d) from sessions that crashed without firing SessionEnd.
[ -d "$state/skills" ] && find "$state/skills" -maxdepth 1 -type f -name '*.log' -mtime +30 -delete 2>/dev/null
exit 0
