#!/usr/bin/env bash
# Run each VICE PRG and capture its rendered frame to test/screenshots/vice/.
# 10M cycles is enough for BASIC startup + autostart + a few frames of
# our test program rendering.

set -e
cd "$(dirname "$0")/.."

# The x64sc path comes from test/external-assets.json (tools → vice-x64sc):
# $VICE_X64SC when set, else the first configured path.
VICE="${VICE_X64SC:-$(node -p "JSON.parse(require('fs').readFileSync('test/external-assets.json','utf8')).tools['vice-x64sc'].paths[0]")}"
OUT=test/vice-screenshots
mkdir -p "$OUT"

for prg in test/vice-prgs/*.prg; do
  name=$(basename "$prg" .prg)
  echo "running $name..."
  "$VICE" -warp -limitcycles 10000000 \
    -exitscreenshot "$OUT/$name.png" \
    -autostart "$(realpath "$prg")" \
    > /dev/null 2>&1 || true
  if [ -f "$OUT/$name.png" ]; then
    echo "  -> $OUT/$name.png"
  else
    echo "  FAILED: no screenshot"
  fi
done
echo "done"
