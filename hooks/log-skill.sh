#!/usr/bin/env bash
# PreToolUse hook for the Skill tool: append "{ts} {skill}" to per-session log.
input=$(cat)
session=$(printf '%s' "$input" | jq -r '.session_id // empty')
skill=$(printf '%s' "$input" | jq -r '.tool_input.skill // empty')
if [ -n "$session" ] && [ -n "$skill" ]; then
  dir="${XDG_STATE_HOME:-$HOME/.local/state}/claude-statusline/skills"
  mkdir -p "$dir"
  printf '%s %s\n' "$(date +%s)" "$skill" >> "$dir/$session.log"
fi
exit 0
