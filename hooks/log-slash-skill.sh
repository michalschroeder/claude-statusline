#!/usr/bin/env bash
# UserPromptSubmit hook: log slash-command skill invocations to the session skill log.
input=$(cat)
session=$(printf '%s' "$input" | jq -r '.session_id // empty')
prompt=$(printf '%s' "$input" | jq -r '.prompt // empty')
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty')

[ -z "$session" ] && exit 0

case "$prompt" in
  /*)
    skill=$(printf '%s' "$prompt" | sed 's|^/||; s| .*||')
    [ -z "$skill" ] && exit 0
    config_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
    [ -e "${cwd:-$PWD}/.agents/skills/$skill" ] || [ -e "$config_dir/skills/$skill" ] || exit 0
    root="${XDG_STATE_HOME:-$HOME/.local/state}/claude-statusline"
    profile="${CLAUDE_CONFIG_DIR#/}"; profile="${profile//\//_}"
    base="${profile:+$root/$profile}"; base="${base:-$root}"
    dir="$base/skills"
    mkdir -p "$dir"
    printf '%s %s\n' "$(date +%s)" "$skill" >> "$dir/$session.log"
    ;;
esac

exit 0
