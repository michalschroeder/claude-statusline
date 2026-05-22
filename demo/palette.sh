#!/usr/bin/env bash
# Preview 256-color palette options for the context bar.
# Run from anywhere:   bash demo/palette.sh
set -u

bar() { printf '\x1b[38;5;%dm████████\x1b[38;5;240m░░░░░░░░░░\x1b[0m' "$1"; }
blink() { printf '\x1b[5;38;5;%dm\x1b[1m󰚌 ████████░░░░░░░░░░\x1b[0m' "$1"; }
hr() { printf '\x1b[2m────────────────────────────────────────────────────\x1b[0m\n'; }

show() {
  local name="$1"; shift
  printf '\n\x1b[1;35m%s\x1b[0m\n' "$name"
  hr
  local tiers=("safe " "notice" "warn " "urgent" "panic")
  local i=0
  for c in "$@"; do
    printf '  %s  [256:%3d]  ' "${tiers[$i]}" "$c"
    if [ "$i" -eq 4 ]; then blink "$c"; else bar "$c"; fi
    echo
    i=$((i+1))
  done
}

printf '\x1b[1mContext-bar palette options\x1b[0m  '
printf '\x1b[2m(left = filled cells in tier color, right = dim grey 240)\x1b[0m\n'

# args: safe, notice, warn, urgent, panic
show "Traffic-light bright (recommended)" 46  226 208 202 196
show "Heat-ramp warm"                     154 220 214 202 196
show "Solarized-muted"                    64  136 166 160 124
show "Synthwave/cool"                     51  87  213 201 196

echo
printf '\x1b[1mEmpty-cell comparison\x1b[0m  (traffic-light tier 1, safe)\n'
hr
printf '  current  (default empty): \x1b[38;5;46m████\x1b[0m░░░░░░░░░░\n'
printf '  proposed (dim grey 240) : \x1b[38;5;46m████\x1b[38;5;240m░░░░░░░░░░\x1b[0m\n'
echo

# 10-step gradients — one color per 10% bucket.
RAMP_A=(46 82 118 154 190 226 220 214 208 196)   # green → lime → yellow → orange → red
RAMP_B=(34 70 106 142 178 214 208 202 196 160)   # forest → olive → amber → red (no bright green)
RAMP_C=(48 84 120 156 192 228 222 216 209 197)   # softer/pastel variant of A

draw_ramp() {
  local name="$1"; shift
  local ramp=("$@")
  printf '\n\x1b[1;35m%s\x1b[0m\n' "$name"
  hr
  # Show the codes
  printf '  codes: '
  for c in "${ramp[@]}"; do printf '\x1b[38;5;%dm%3d\x1b[0m ' "$c" "$c"; done
  echo

  # Render the 10-cell bar at progressive fill levels.
  # Each filled cell colored by ramp[i]; empty cells dim grey 240.
  for fill in 1 3 5 7 9 10; do
    printf '  fill=%2d/10  ' "$fill"
    for ((i=0; i<10; i++)); do
      if [ "$i" -lt "$fill" ]; then
        printf '\x1b[38;5;%dm█\x1b[0m' "${ramp[$i]}"
      else
        printf '\x1b[38;5;240m░\x1b[0m'
      fi
    done
    echo
  done

  # Bonus: every cell colored regardless of fill — rainbow strip.
  printf '  rainbow    '
  for c in "${ramp[@]}"; do printf '\x1b[38;5;%dm█\x1b[0m' "$c"; done
  echo
}

printf '\n\x1b[1;36m=== 10-color gradient options (one color per 10%% bucket) ===\x1b[0m\n'
draw_ramp "Ramp A — green→lime→yellow→orange→red" "${RAMP_A[@]}"
draw_ramp "Ramp B — forest→olive→amber→red (muted)" "${RAMP_B[@]}"
draw_ramp "Ramp C — pastel variant of A" "${RAMP_C[@]}"

printf '\n\x1b[2mEach row shows the bar at a different fill level; the color of cell N comes from ramp[N].\nThe last row colors every cell regardless of fill — like a rainbow strip.\x1b[0m\n\n'

# Per-cell (rainbow) vs per-tier coloring — side by side using Ramp B.
B=("${RAMP_B[@]}")
printf '\x1b[1;36m=== Per-cell vs per-tier coloring (Ramp B muted) ===\x1b[0m\n'
hr
printf '%-12s   %-22s   %-22s\n' "fill" "per-cell (rainbow)" "per-tier (highest)"
for fill in 1 3 5 7 9 10; do
  printf '  fill=%2d/10   ' "$fill"

  # per-cell: cell i colored by ramp[i] when filled
  for ((i=0; i<10; i++)); do
    if [ "$i" -lt "$fill" ]; then
      printf '\x1b[38;5;%dm█\x1b[0m' "${B[$i]}"
    else
      printf '\x1b[38;5;240m░\x1b[0m'
    fi
  done
  printf '   '

  # per-tier: all filled cells use ramp[fill-1] (color of highest filled cell)
  local_color=${B[$((fill-1))]}
  for ((i=0; i<10; i++)); do
    if [ "$i" -lt "$fill" ]; then
      printf '\x1b[38;5;%dm█\x1b[0m' "$local_color"
    else
      printf '\x1b[38;5;240m░\x1b[0m'
    fi
  done
  echo
done
printf '\n\x1b[2mper-cell: each cell keeps its own ramp color — bar fades green→red as it fills.\nper-tier: all filled cells share one color (the color of the highest cell) — entire bar flips through tiers.\x1b[0m\n\n'

# Proposed thresholds with Ramp B.
printf '\x1b[1;36m=== Proposed thresholds (10-step linear) ===\x1b[0m\n'
hr
printf '  \x1b[1m200k model\x1b[0m: 20k per cell        →  cell N fills at %sk tokens\n' '20/40/60/80/100/120/140/160/180/200'
printf '  \x1b[1m1M model\x1b[0m  : 50k per cell        →  cell N fills at %sk tokens\n' '50/100/150/200/250/300/350/400/450/500'
printf '  \x1b[1mboth\x1b[0m      : ≥ last-cell = panic (blink-red + skull); 1M past 500k stays in panic\n\n'
