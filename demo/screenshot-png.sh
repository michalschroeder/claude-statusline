#!/usr/bin/env bash
# Render demo/screenshots.sh to screenshot-demo.png: ANSI → HTML → headless Chrome.
# Needs google-chrome (or chromium / chromium-browser), ImageMagick `convert`, and JetBrainsMono Nerd Font.
# Run from repo root:   bash demo/screenshot-png.sh

set -eu
cd "$(dirname "$0")/.."
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
CHROME=$(command -v google-chrome || command -v chromium || command -v chromium-browser) ||
  { echo "screenshot-png.sh: no google-chrome/chromium/chromium-browser on PATH" >&2; exit 1; }

# 210 cols = widest scenario on one line; window width fits it at 16px JetBrains Mono.
COLUMNS=210 bash demo/screenshots.sh | node demo/ansi2html.js "$TMP/demo.html"
"$CHROME" --headless --disable-gpu --hide-scrollbars --window-size=2080,1500 \
  --screenshot="$TMP/raw.png" "file://$TMP/demo.html" 2>/dev/null
convert "$TMP/raw.png" -trim -bordercolor '#2d303d' -border 16 screenshot-demo.png
echo "wrote screenshot-demo.png"
