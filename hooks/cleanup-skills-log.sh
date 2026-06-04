#!/usr/bin/env bash
# SessionEnd hook: fold this session's cost into cost.log, remove its skill log,
# trim old cost.log lines, and prune stale skill logs / orphaned cost temp files.
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

if [ -n "$session" ]; then
  cost_file="$state/cost/$session"
  if [ -f "$cost_file" ]; then
    cost=$(cat "$cost_file")
    if [ -n "$cost" ] && [ "$cost" != "0" ]; then
      printf '%s %s %s %s\n' "$(date +%Y-%m-%d)" "$(date +%s)" "$session" "$cost" >> "$state/cost.log"
    fi
    rm -f "$cost_file"
  fi
  rm -f "$state/skills/$session.log"
fi

# Trim cost.log to the last ~45 days. The renderer's monthly window never looks
# past the 1st of the month (≤31 days), so older lines are dead weight on a file
# that is read+parsed on every statusline render. Drops malformed lines too.
if [ -f "$state/cost.log" ]; then
  cutoff=$(( $(date +%s) - 45 * 86400 ))
  tmp=$(mktemp) && awk -v c="$cutoff" '($2+0) >= c' "$state/cost.log" > "$tmp" 2>/dev/null \
    && mv "$tmp" "$state/cost.log" || rm -f "$tmp"
fi

# Prune stale skill logs and orphaned cost temp files (>30d) from sessions that
# crashed without firing SessionEnd.
[ -d "$state/skills" ] && find "$state/skills" -maxdepth 1 -type f -name '*.log' -mtime +30 -delete 2>/dev/null
[ -d "$state/cost" ]   && find "$state/cost"   -maxdepth 1 -type f -mtime +30 -delete 2>/dev/null
exit 0
