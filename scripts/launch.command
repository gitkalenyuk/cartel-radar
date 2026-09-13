#!/bin/bash
# Niche Radar — локальний запуск. Закриття цього вікна зупиняє сервер.
set -u
DIR=""$(cd "$(dirname "$0")" && pwd)""
cd "$DIR" || { echo "Не знайдено теку застосунку: $DIR"; exit 1; }
PORT="${NICHE_RADAR_PORT:-8787}"
NODE_BIN="$(command -v node 2>/dev/null || echo /usr/local/bin/node)"
LINK="http://127.0.0.1:$PORT"

if curl -s -m 2 "$LINK/api/health" 2>/dev/null | grep -q '"ok":true'; then
  echo "Niche Radar вже працює — відкриваю $LINK"
  open "$LINK"
  exit 0
fi

if [ ! -x "$NODE_BIN" ]; then
  echo "╔══════════════════════════════════════════════╗"
  echo "║  Не знайдено Node.js                         ║"
  echo "╚══════════════════════════════════════════════╝"
  echo
  echo "Встановіть Node.js 18+ (LTS): https://nodejs.org"
  echo "або через Homebrew:  brew install node"
  echo
  read -r -p "Натисніть Enter, щоб закрити…"
  exit 1
fi

exec "$NODE_BIN" server.mjs --port "$PORT" --open
