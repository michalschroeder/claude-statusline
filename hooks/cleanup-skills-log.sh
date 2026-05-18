#!/usr/bin/env bash
# SessionEnd hook: remove this session's skill log; prune stale logs (>30d) from crashed sessions.
input=$(cat)
session=$(printf '%s' "$input" | jq -r '.session_id // empty')
dir="${XDG_STATE_HOME:-$HOME/.local/state}/claude-statusline/skills"
[ -n "$session" ] && rm -f "$dir/$session.log"
[ -d "$dir" ] && find "$dir" -maxdepth 1 -type f -name '*.log' -mtime +30 -delete 2>/dev/null
exit 0
