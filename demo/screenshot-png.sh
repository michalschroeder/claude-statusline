#!/usr/bin/env bash
# Render demo/screenshots.sh to screenshot-demo.png: ANSI → HTML → headless Chrome.
# Needs google-chrome (or chromium / chromium-browser), ImageMagick `convert`, and JetBrainsMono Nerd Font.
# Run from repo root:   bash demo/screenshot-png.sh

set -euo pipefail
cd "$(dirname "$0")/.."
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
CHROME=$(command -v google-chrome || command -v chromium || command -v chromium-browser) ||
  { echo "screenshot-png.sh: no google-chrome/chromium/chromium-browser on PATH" >&2; exit 1; }

# 210 cols = widest scenario on one line; window width fits it at 16px JetBrains Mono.
# Render to a file first: a failed scenario aborts before the PNG is overwritten.
COLUMNS=210 bash demo/screenshots.sh > "$TMP/demo.ansi"
node demo/ansi2html.js "$TMP/demo.html" < "$TMP/demo.ansi"
# Height from line count (16px × 1.6 line-height + padding) so no scenario is cropped.
HEIGHT=$(( $(wc -l < "$TMP/demo.ansi") * 26 + 100 ))
"$CHROME" --headless --disable-gpu --hide-scrollbars --window-size=2080,"$HEIGHT" \
  --screenshot="$TMP/raw.png" "file://$TMP/demo.html" 2>/dev/null
convert "$TMP/raw.png" -trim -bordercolor '#2d303d' -border 16 screenshot-demo.png
echo "wrote screenshot-demo.png"
