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

# Isolated state for the demo: a temp XDG_STATE_HOME so the seeded cost summary
# and scenario 7's skills log don't touch the user's real state. Cleaned up on exit.
DEMO_STATE=$(mktemp -d)
export XDG_STATE_HOME="$DEMO_STATE"
trap 'rm -rf "$DEMO_STATE"' EXIT
STATE_ROOT="$XDG_STATE_HOME/claude-statusline"
mkdir -p "$STATE_ROOT"

# Seed <STATE>/cost-summary.json the way refresh-cost-cache.js would have left it
# after a few weeks of use: a handful of earlier sessions bucketed by day, plus the
# demo session itself already cached at its payload cost. Without this every d/w/m
# chip would just echo the s chip (clamped to $5), which is what an empty cache
# looks like — not what a user sees after their first prompt.
#   seed_cost <session_id> <session_cost_usd>
seed_cost() {
  node -e '
    const fs = require("fs");
    const [out, sid, cost] = [process.argv[1], process.argv[2], +process.argv[3]];
    const key = (ago) => {
      const x = new Date(); x.setDate(x.getDate() - ago);
      const p = (n) => String(n).padStart(2, "0");
      return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
    };
    const prior = [[0, 9.30], [1, 22.15], [6, 31.80], [13, 48.60], [20, 57.25]];
    const perSession = {};
    prior.forEach(([ago, c], i) => { perSession[`prior-${i}`] = { total: c, days: { [key(ago)]: c } }; });
    perSession[sid] = { total: cost, days: { [key(0)]: cost } };
    fs.writeFileSync(out, JSON.stringify({ pricingHash: "demo", perSession, unpricedModels: [], approxModels: [] }));
  ' "$STATE_ROOT/cost-summary.json" "$1" "$2"
}

render() {
  local title="$1"; shift
  local payload="$1"; shift
  printf '\n\033[1m%s\033[0m\n' "$THICK"
  printf '\033[1;35m %s\033[0m\n' "$title"
  printf '\033[2m%s\033[0m\n' "$THIN"
  printf '%s' "$payload" | node hooks/statusline.js
  echo
}

# 1. Fresh session — minimal payload
render "1. Fresh session" '{
  "session_id": "demo-1",
  "model": {"display_name": "Fable 5.1"},
  "workspace": {"current_dir": "/home/ms/projects/claude-statusline", "project_dir": "/home/ms/projects/claude-statusline"}
}'

# 2. Typical mid-session
seed_cost demo-2 0.42
render "2. Mid-session (typical)" '{
  "session_id": "demo-2",
  "model": {"display_name": "Sonnet 5"},
  "workspace": {"current_dir": "/home/ms/projects/claude-statusline", "project_dir": "/home/ms/projects/claude-statusline"},
  "cost": {"total_cost_usd": 0.42, "total_duration_ms": 185000, "total_lines_added": 47, "total_lines_removed": 12},
  "context_window": {"total_input_tokens": 18500, "used_percentage": 9}
}'

# 3. Heavy session — agent, effort, vim, added dirs.
#    Cost ≥60s so the s-chip carries a dim burn rate ($/h); $6.85 = yellow tier.
seed_cost demo-3 6.85
render "3. Heavy session w/ agent (s-chip: burn rate + yellow tier)" '{
  "session_id": "demo-3",
  "model": {"display_name": "Opus 5"},
  "effort": {"level": "high"},
  "vim": {"mode": "NORMAL"},
  "agent": {"name": "code-reviewer"},
  "workspace": {
    "current_dir": "/home/ms/projects/claude-statusline",
    "project_dir": "/home/ms/projects/claude-statusline",
    "added_dirs": ["/tmp/notes"]
  },
  "cost": {"total_cost_usd": 6.85, "total_duration_ms": 2640000, "total_lines_added": 412, "total_lines_removed": 188},
  "context_window": {"total_input_tokens": 116000, "used_percentage": 58}
}'

# 4. Worktree + rate limits
seed_cost demo-4 2.10
render "4. Worktree + rate limits" '{
  "session_id": "demo-4",
  "model": {"display_name": "Sonnet 5"},
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

# 5. 1M context — 250k tokens. Bar spans the full 1M window, so 250k fills 2/10 cells
#    and agrees with the 25% label (250k of 1M).
seed_cost demo-5 4.20
render "5. 1M model — 250k tokens (2/10 cells, label 25% = 250k of 1M)" '{
  "session_id": "demo-5",
  "model": {"display_name": "Opus 5 (1M)"},
  "effort": {"level": "high"},
  "workspace": {"current_dir": "/home/ms/projects/claude-statusline", "project_dir": "/home/ms/projects/claude-statusline"},
  "cost": {"total_cost_usd": 4.20, "total_duration_ms": 1800000, "total_lines_added": 320, "total_lines_removed": 140},
  "context_window": {"total_input_tokens": 250000, "used_percentage": 25}
}'

# 6. Danger zone — 1M model at the 500k panic line: honest half-full bar (5/10) goes
#    blink-red + skull; the label reads 50% (500k of 1M) and agrees with the fill.
seed_cost demo-6 14.27
render "6. Danger zone (1M at 500k danger line — half bar, blink-red + skull)" '{
  "session_id": "demo-6",
  "model": {"display_name": "Opus 5 (1M)"},
  "effort": {"level": "high"},
  "workspace": {"current_dir": "/home/ms/projects/claude-statusline", "project_dir": "/home/ms/projects/claude-statusline"},
  "cost": {"total_cost_usd": 14.27, "total_duration_ms": 5400000, "total_lines_added": 1240, "total_lines_removed": 760},
  "context_window": {"total_input_tokens": 500000, "used_percentage": 50},
  "rate_limits": {"five_hour": {"used_percentage": 88}, "seven_day": {"used_percentage": 74}}
}'

# 7. With loaded skills (writes a temp skills log keyed to a fake session id)
SESSION="demo-$$"
STATE_DIR="$STATE_ROOT/skills"
mkdir -p "$STATE_DIR"
LOG="$STATE_DIR/$SESSION.log"
NOW=$(date +%s)
{
  echo "$((NOW-300)) superpowers:brainstorming"
  echo "$((NOW-200)) superpowers:test-driven-development"
  echo "$((NOW-100)) document-skills:frontend-design"
  echo "$((NOW-50)) using-superpowers"
} > "$LOG"

seed_cost "$SESSION" 3.40
render "7. With loaded skills" "{
  \"session_id\": \"$SESSION\",
  \"model\": {\"display_name\": \"Opus 5\"},
  \"effort\": {\"level\": \"high\"},
  \"workspace\": {\"current_dir\": \"/home/ms/projects/claude-statusline\", \"project_dir\": \"/home/ms/projects/claude-statusline\"},
  \"cost\": {\"total_cost_usd\": 3.40, \"total_duration_ms\": 1200000, \"total_lines_added\": 210, \"total_lines_removed\": 64},
  \"context_window\": {\"total_input_tokens\": 140000, \"used_percentage\": 70}
}"

rm -f "$LOG"

echo
