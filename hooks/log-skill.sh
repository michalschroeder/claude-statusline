#!/usr/bin/env bash
# PreToolUse hook for the Skill tool: append "{ts} {skill}" to per-session log.
input=$(cat)
session=$(printf '%s' "$input" | jq -r '.session_id // empty')
skill=$(printf '%s' "$input" | jq -r '.tool_input.skill // empty')
[ -n "$session" ] && [ -n "$skill" ] && printf '%s %s\n' "$(date +%s)" "$skill" >> "/tmp/claude-skills-$session.log"
exit 0
