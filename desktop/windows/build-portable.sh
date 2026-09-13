#!/bin/bash
# desktop/windows/build-portable.sh — збирає портативну версію Cartel Radar для Windows.
# Windows-машина не потрібна: це просто архів із кодом, yt-dlp.exe і .bat-лаунчером.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# версію читаємо текстом, а не через node: на Windows шлях у форматі Git Bash
# (/d/a/...) для Node-бінарника недосяжний
VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -1)"
[ -n "$VERSION" ] || { echo "✖ не вдалося прочитати версію з package.json"; exit 1; }
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

make_zip() {
  if command -v zip >/dev/null 2>&1; then
    ( cd "$WORK" && zip -qr "$OUT" "$NAME" )
  elif command -v powershell.exe >/dev/null 2>&1; then
    # Windows-раннер: PowerShell вміє те саме
    WIN_SRC="$(cygpath -w "$WORK/$NAME" 2>/dev/null || echo "$WORK/$NAME")"
    WIN_OUT="$(cygpath -w "$OUT" 2>/dev/null || echo "$OUT")"
    # шляхи передаємо змінними середовища: вкладені лапки у зв'язці
    # Git Bash + PowerShell псуються, і PowerShell отримує сам текст '$WIN_SRC'
    MSYS_NO_PATHCONV=1 PS_SRC="$WIN_SRC" PS_OUT="$WIN_OUT" powershell.exe -NoProfile -Command 'Compress-Archive -Path $env:PS_SRC -DestinationPath $env:PS_OUT -Force'
  else
    echo "✖ Ні zip, ні PowerShell — архів не створити"; exit 1
  fi
}
make_zip
rm -rf "$WORK"
echo "✓ готово: $OUT ($(du -h "$OUT" | cut -f1))"
