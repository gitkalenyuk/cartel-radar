#!/bin/bash
# scripts/fetch-ytdlp.sh — завантажує yt-dlp у bin/ для поточної системи.
# Потрібен, бо бінарник не зберігається в репозиторії (36 МБ).
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$DIR/bin"
mkdir -p "$BIN"

case "$(uname -s)" in
  Darwin) FILE="yt-dlp_macos"; OUT="$BIN/yt-dlp" ;;
  Linux)  FILE="yt-dlp";       OUT="$BIN/yt-dlp" ;;
  MINGW*|MSYS*|CYGWIN*) FILE="yt-dlp.exe"; OUT="$BIN/yt-dlp.exe" ;;
  *) echo "✖ Невідома система: $(uname -s)"; exit 1 ;;
esac

URL="https://github.com/yt-dlp/yt-dlp/releases/latest/download/$FILE"

if [ -x "$OUT" ] && [ -s "$OUT" ]; then
  echo "  yt-dlp уже на місці: $OUT ($(du -h "$OUT" | cut -f1))"
  exit 0
fi

echo "▸ Завантажую yt-dlp…"
if command -v curl >/dev/null 2>&1; then
  curl -fL --progress-bar "$URL" -o "$OUT"
elif command -v wget >/dev/null 2>&1; then
  wget -q --show-progress "$URL" -O "$OUT"
else
  echo "✖ Потрібен curl або wget"; exit 1
fi
chmod +x "$OUT"
[ "$(uname -s)" = "Darwin" ] && xattr -c "$OUT" 2>/dev/null || true
echo "  готово: $OUT ($(du -h "$OUT" | cut -f1))"
"$OUT" --version || true
