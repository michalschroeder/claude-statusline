#!/usr/bin/env bash
# Render a series of statusline scenarios for README screenshots.
# Run from repo root:   bash demo/screenshots.sh
# Tip: maximize the terminal first; the skills rule scales to terminal width.

set -u
cd "$(dirname "$0")/.."
export STATUSLINE_ICONS=nerd

COLS=$(tput cols 2>/dev/null || echo 120)
THICK=$(printf '━%.0s' $(seq 1 "$COLS"))
THIN=$(printf '─%.0s' $(seq 1 "$COLS"))

# Isolated, deterministic state for the demo: a temp XDG_STATE_HOME seeded with a
# fake cost.log so the daily/weekly/monthly chips render stable numbers (and we
# never read or display the user's real spend). Cleaned up on exit.
DEFAULT_BUDGET=500
DEMO_STATE=$(mktemp -d)
export XDG_STATE_HOME="$DEMO_STATE"
trap 'rm -rf "$DEMO_STATE"' EXIT

# Seed cost.log with ended sessions in each calendar window, anchored to the real
# clock the renderer uses. Bucketing uses the unix-ts column; the date column is
# cosmetic. Note: in the first calendar week of a month "since Monday" and "since
# the 1st" cover the same span, so w == m on those days — a property of the
# calendar, not a bug.
seed_costs() {
  local f="$XDG_STATE_HOME/claude-statusline/cost.log"
  mkdir -p "$(dirname "$f")"
  local day dow week month
  day=$(date -d '00:00' +%s)
  dow=$(date +%u)                                   # 1=Mon..7=Sun
  week=$(date -d "$((dow - 1)) days ago 00:00" +%s)
  month=$(date -d "$(date +%Y-%m-01) 00:00" +%s)
  emit() { printf '%s %s %s %s\n' "$(date -d "@$2" +%F)" "$2" "$3" "$1"; }
  {
    emit 5.00 "$((month + 3600))" sess-month        # earlier this month (before this week)
    emit 2.00 "$((week + 3600))"  sess-week         # earlier this week (before today)
    emit 0.70 "$((day + 3600))"   sess-today-am     # earlier today
    emit 0.50 "$((day + 36000))"  sess-recent       # later today
  } > "$f"
  # Cumulative (excl. live): daily = 1.20, weekly = 3.20, monthly = 8.20.
}
seed_costs

render() {
  local title="$1"; shift
  local payload="$1"; shift
  local budget="${1:-$DEFAULT_BUDGET}"
  printf '\n\033[1m%s\033[0m\n' "$THICK"
  printf '\033[1;35m %s\033[0m\n' "$title"
  printf '\033[2m%s\033[0m\n' "$THIN"
  printf '%s' "$payload" | STATUSLINE_MONTHLY_BUDGET="$budget" node hooks/statusline.js
  echo
}

# 1. Fresh session — minimal payload
render "1. Fresh session" '{
  "model": {"display_name": "Opus 4.7"},
  "workspace": {"current_dir": "/home/ms/projects/claude-statusline", "project_dir": "/home/ms/projects/claude-statusline"}
}'

# 2. Typical mid-session
render "2. Mid-session (typical)" '{
  "model": {"display_name": "Sonnet 4.6"},
  "workspace": {"current_dir": "/home/ms/projects/claude-statusline", "project_dir": "/home/ms/projects/claude-statusline"},
  "cost": {"total_cost_usd": 0.42, "total_duration_ms": 185000, "total_lines_added": 47, "total_lines_removed": 12},
  "context_window": {"total_input_tokens": 18500, "used_percentage": 9}
}'

# 3. Heavy session — agent, effort, output style, vim, added dirs
render "3. Heavy session w/ agent" '{
  "model": {"display_name": "Opus 4.7"},
  "effort": {"level": "high"},
  "output_style": {"name": "explanatory"},
  "vim": {"mode": "NORMAL"},
  "agent": {"name": "code-reviewer"},
  "workspace": {
    "current_dir": "/home/ms/projects/claude-statusline",
    "project_dir": "/home/ms/projects/claude-statusline",
    "added_dirs": ["/tmp/notes", "/var/log"]
  },
  "cost": {"total_cost_usd": 6.85, "total_duration_ms": 2640000, "total_lines_added": 412, "total_lines_removed": 188},
  "context_window": {"total_input_tokens": 116000, "used_percentage": 58}
}'

# 4. Worktree + rate limits
render "4. Worktree + rate limits" '{
  "model": {"display_name": "Sonnet 4.6"},
  "effort": {"level": "medium"},
  "worktree": {"name": "feature-icons"},
  "workspace": {
    "current_dir": "/home/ms/projects/claude-statusline/.claude/worktrees/feature-icons",
    "project_dir": "/home/ms/projects/claude-statusline"
  },
  "cost": {"total_cost_usd": 2.10, "total_duration_ms": 920000, "total_lines_added": 86, "total_lines_removed": 30},
  "context_window": {"total_input_tokens": 92000, "used_percentage": 46},
  "rate_limits": {"five_hour": {"used_percentage": 34}, "seven_day": {"used_percentage": 61}}
}'

# 5. 1M context — 250k tokens. Bar fills 5/10 cells (calibrated to 500k panic),
#    label reads 25% (raw used_percentage — 250k of 1M context).
render "5. 1M model — 250k tokens (5/10 cells, label 25% = 250k of 1M)" '{
  "model": {"display_name": "Opus 4.7 (1M)"},
  "effort": {"level": "high"},
  "workspace": {"current_dir": "/home/ms/projects/claude-statusline", "project_dir": "/home/ms/projects/claude-statusline"},
  "cost": {"total_cost_usd": 4.20, "total_duration_ms": 1800000, "total_lines_added": 320, "total_lines_removed": 140},
  "context_window": {"total_input_tokens": 250000, "used_percentage": 25}
}'

# 6. Danger zone — 1M model right at the 500k panic threshold (borderline panic)
render "6. Danger zone (1M at 500k panic threshold)" '{
  "model": {"display_name": "Opus 4.7 (1M)"},
  "effort": {"level": "high"},
  "workspace": {"current_dir": "/home/ms/projects/claude-statusline", "project_dir": "/home/ms/projects/claude-statusline"},
  "cost": {"total_cost_usd": 14.27, "total_duration_ms": 5400000, "total_lines_added": 1240, "total_lines_removed": 760},
  "context_window": {"total_input_tokens": 500000, "used_percentage": 50},
  "rate_limits": {"five_hour": {"used_percentage": 88}, "seven_day": {"used_percentage": 74}}
}'

# 7. With loaded skills (writes a temp skills log keyed to a fake session id)
SESSION="demo-$$"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/claude-statusline/skills"
mkdir -p "$STATE_DIR"
LOG="$STATE_DIR/$SESSION.log"
NOW=$(date +%s)
{
  echo "$((NOW-300)) superpowers:brainstorming"
  echo "$((NOW-200)) superpowers:test-driven-development"
  echo "$((NOW-100)) document-skills:frontend-design"
  echo "$((NOW-50)) using-superpowers"
} > "$LOG"

render "7. With loaded skills" "{
  \"session_id\": \"$SESSION\",
  \"model\": {\"display_name\": \"Opus 4.7\"},
  \"effort\": {\"level\": \"high\"},
  \"workspace\": {\"current_dir\": \"/home/ms/projects/claude-statusline\", \"project_dir\": \"/home/ms/projects/claude-statusline\"},
  \"cost\": {\"total_cost_usd\": 3.40, \"total_duration_ms\": 1200000, \"total_lines_added\": 210, \"total_lines_removed\": 64},
  \"context_window\": {\"total_input_tokens\": 140000, \"used_percentage\": 70}
}"

rm -f "$LOG"

# 8. Budget pressure — same seeded cost.log, but a low STATUSLINE_MONTHLY_BUDGET
#    so the d/w/m parts of the cost group (s $.. · d $.. · w $.. · m $..) show
#    their threshold colors. With budget=20 the derived limits are daily $0.67 /
#    weekly $4.67 / monthly $20, so the small daily/weekly limits redden while
#    monthly stays green (session keeps its absolute-$ color). Exact figures track
#    the run date as entries fold into nearer windows.
render "8. Budget pressure (STATUSLINE_MONTHLY_BUDGET=20 — d/w/m colors)" '{
  "model": {"display_name": "Sonnet 4.6"},
  "effort": {"level": "medium"},
  "workspace": {"current_dir": "/home/ms/projects/claude-statusline", "project_dir": "/home/ms/projects/claude-statusline"},
  "cost": {"total_cost_usd": 0.30, "total_duration_ms": 600000, "total_lines_added": 40, "total_lines_removed": 9},
  "context_window": {"total_input_tokens": 64000, "used_percentage": 32}
}' 20

echo
