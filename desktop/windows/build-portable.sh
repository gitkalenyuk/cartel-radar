#!/bin/bash
# desktop/windows/build-portable.sh — збирає портативну версію Cartel Radar для Windows.
# Windows-машина не потрібна: це просто архів із кодом, yt-dlp.exe і .bat-лаунчером.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VERSION="$(node -p "require('$ROOT/package.json').version")"
NAME="Cartel-Radar-$VERSION-Windows-Portable"
WORK="$(mktemp -d)"
OUT="$ROOT/dist/$NAME.zip"
mkdir -p "$ROOT/dist"

echo "▸ Збираю $NAME"
mkdir -p "$WORK/$NAME/bin"
cp "$ROOT/server.mjs" "$ROOT/package.json" "$ROOT/README.md" "$ROOT/LICENSE" "$WORK/$NAME/"
cp -R "$ROOT/lib" "$ROOT/public" "$ROOT/docs" "$ROOT/desktop" "$WORK/$NAME/"

# бінарник yt-dlp для Windows
if [ -s "$ROOT/bin/yt-dlp.exe" ]; then
  cp "$ROOT/bin/yt-dlp.exe" "$WORK/$NAME/bin/"
else
  echo "  тягну yt-dlp.exe…"
  curl -fL -s -o "$WORK/$NAME/bin/yt-dlp.exe" \
    https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe
fi

cat > "$WORK/$NAME/Cartel Radar.bat" <<'BAT'
@echo off
chcp 65001 >nul
title Cartel Radar
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Install LTS from https://nodejs.org and run again.
  pause
  start "" "https://nodejs.org/en/download"
  exit /b 1
)
start "" http://127.0.0.1:8787
node server.mjs
pause
BAT

( cd "$WORK" && zip -qr "$OUT" "$NAME" )
rm -rf "$WORK"
echo "✓ готово: $OUT ($(du -h "$OUT" | cut -f1))"
