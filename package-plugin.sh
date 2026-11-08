#!/usr/bin/env bash
# Build the distributable plugin zip for Decky "Install from ZIP".
# The Electron player is NOT bundled — it is downloaded on first run (see
# PLAYER_DOWNLOAD_URL in main.py). Run this AFTER setting that URL.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"
PLUGIN="apple-music-plugin"
OUT="$ROOT/$PLUGIN.zip"

# The release tag MUST equal package.json's version (v<version>): update checkers such as DeckyHub
# compare the installed plugin's version with the latest release tag. The permanent `v1.0.0`
# release only hosts the player tarballs that PLAYER_DOWNLOAD_URL points at.
VERSION="$(node -p "require('./package.json').version")"

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
echo "Plugin version: $VERSION"
echo "Publish as release tag: v$VERSION   (the tag must match the version above)"
if git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null 2>&1; then
  echo "NOTE: tag v$VERSION already exists — bump \"version\" in package.json for a new release."
fi
