#!/usr/bin/env bash
# Build the distributable plugin zip for Decky "Install from ZIP".
# The Electron player is NOT bundled — it is downloaded on first run (see
# PLAYER_DOWNLOAD_URL in main.py). Run this AFTER setting that URL.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"
PLUGIN="apple-music-plugin"
OUT="$ROOT/$PLUGIN.zip"

echo "Building frontend…"
npm run build >/dev/null

if grep -q "<OWNER>/<REPO>" main.py; then
  echo "WARNING: PLAYER_DOWNLOAD_URL in main.py is still a placeholder."
  echo "         The in-plugin 'Install Player' button will not work until you set it."
fi

STAGE="$(mktemp -d)"
DEST="$STAGE/$PLUGIN"
mkdir -p "$DEST/dist"
cp plugin.json package.json main.py ducker.py "$DEST/"
[ -f README.md ] && cp README.md "$DEST/" || true
[ -f LICENSE ] && cp LICENSE "$DEST/" || true
cp dist/index.js "$DEST/dist/"

rm -f "$OUT"
( cd "$STAGE" && zip -r -q "$OUT" "$PLUGIN" )
rm -rf "$STAGE"

echo "Built: $OUT"
du -h "$OUT" | awk '{print "Size: "$1}'
