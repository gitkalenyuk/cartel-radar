#!/bin/bash
# install.sh — встановлення Cartel Radar на цей Mac
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/Applications/CartelRadar"
APP="$HOME/Applications/Cartel Radar.app"
DESKTOP="$HOME/Desktop/Cartel Radar.command"

echo "▸ Cartel Radar — інсталяція"
echo "  джерело:  $SRC"
echo "  застосунок: $DEST"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "✖ Не знайдено Node.js. Встановіть з https://nodejs.org (LTS) і повторіть."
  exit 1
fi
echo "  Node.js: $(node -v)"

if [ ! -s "$SRC/bin/yt-dlp" ]; then
  echo "▸ yt-dlp не знайдено — завантажую (без нього немає безкоштовних даних YouTube)…"
  bash "$SRC/scripts/fetch-ytdlp.sh" || echo "  ⚠ yt-dlp не завантажився — застосунок працюватиме через API або зовсім без реальних даних"
fi

echo "▸ Копіюю файли застосунку…"
# чищу попередню збірку: інакше архіви з dist/ з попередніх запусків
# лишаються всередині застосунку й роздувають його в рази
if [ -d "$DEST" ]; then
  find "$DEST" -maxdepth 2 -name "dist" -type d -prune -exec rm -rf {} + 2>/dev/null || true
  find "$DEST" -maxdepth 2 -name ".github" -type d -prune -exec rm -rf {} + 2>/dev/null || true
  find "$DEST" -maxdepth 2 -name "*.zip" -delete 2>/dev/null || true
fi
mkdir -p "$DEST"
rsync -a --delete \
  --exclude '/data/' --exclude 'node_modules/' --exclude '.git/' --exclude '.DS_Store' \
  --exclude '/dist/' --exclude '/.github/' --exclude '*.zip' \
  "$SRC/" "$DEST/"
mkdir -p "$DEST/data"

echo "▸ Створюю лаунчер…"
cat > "$DEST/launch.command" <<'LAUNCH'
#!/bin/bash
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR" || exit 1
PORT="${NICHE_RADAR_PORT:-8787}"
NODE_BIN="$(command -v node 2>/dev/null || echo /usr/local/bin/node)"
LINK="http://127.0.0.1:$PORT"
if curl -s -m 2 "$LINK/api/health" 2>/dev/null | grep -q '"ok":true'; then
  echo "Cartel Radar вже працює — відкриваю $LINK"
  open "$LINK"; exit 0
fi
if [ ! -x "$NODE_BIN" ]; then
  echo "Не знайдено Node.js. Встановіть з https://nodejs.org (LTS) або: brew install node"
  read -r -p "Натисніть Enter, щоб закрити…"; exit 1
fi
exec "$NODE_BIN" server.mjs --port "$PORT" --open
LAUNCH
chmod +x "$DEST/launch.command"

echo "▸ Створюю ярлик на Робочому столі…"
cat > "$DESKTOP" <<EOF
#!/bin/bash
exec "$DEST/launch.command"
EOF
chmod +x "$DESKTOP"

# ── Дані користувача живуть ПОЗА застосунком; рятуємо їх із попередньої збірки ──
SUPPORT_DATA="$HOME/Library/Application Support/CartelRadar/data"
mkdir -p "$SUPPORT_DATA"
if [ ! -f "$SUPPORT_DATA/config.json" ] && [ -f "$APP/Contents/Resources/app/data/config.json" ]; then
  cp "$APP/Contents/Resources/app/data/config.json" "$SUPPORT_DATA/config.json"
  echo "  · переношу збережені ключі й налаштування з попередньої версії"
  for extra in niches.json history.json pipeline.json; do
    [ -f "$APP/Contents/Resources/app/data/$extra" ] && cp "$APP/Contents/Resources/app/data/$extra" "$SUPPORT_DATA/$extra"
  done
  [ -d "$APP/Contents/Resources/app/data/runs" ] && cp -R "$APP/Contents/Resources/app/data/runs" "$SUPPORT_DATA/runs" 2>/dev/null
fi
if [ ! -f "$SUPPORT_DATA/config.json" ] && [ -f "$SRC/data/config.json" ]; then
  cp "$SRC/data/config.json" "$SUPPORT_DATA/config.json"
  echo "  · переношу налаштування з робочої копії"
fi

echo "▸ Збираю Cartel Radar.app (нативне вікно)…"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
rsync -a --delete \
  --exclude '/data/' --exclude 'node_modules/' --exclude '.git/' --exclude '.DS_Store' \
  --exclude '/dist/' --exclude '/.github/' --exclude '*.zip' \
  "$SRC/" "$APP/Contents/Resources/app/"
mkdir -p "$APP/Contents/Resources/app/data"

if [ -f "$SRC/assets/icon.icns" ]; then
  cp "$SRC/assets/icon.icns" "$APP/Contents/Resources/icon.icns"
fi

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Cartel Radar</string>
  <key>CFBundleDisplayName</key><string>Cartel Radar</string>
  <key>CFBundleIdentifier</key><string>local.cartelradar.app</string>
  <key>CFBundleVersion</key><string>1.0.0</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>CartelRadar</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
    <key>NSExceptionDomains</key>
    <dict>
      <key>127.0.0.1</key><dict><key>NSExceptionAllowsInsecureHTTPLoads</key><true/></dict>
      <key>localhost</key><dict><key>NSExceptionAllowsInsecureHTTPLoads</key><true/></dict>
    </dict>
  </dict>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
</dict>
</plist>
PLIST

# нативний виконуваний файл: WKWebView у власному вікні, без браузера
NATIVE_OK=0
if command -v swiftc >/dev/null 2>&1; then
  echo "  · компілюю нативне вікно (swiftc)…"
  if swiftc -O "$SRC/desktop/main.swift" -o "$APP/Contents/MacOS/CartelRadar" -framework Cocoa -framework WebKit 2>/tmp/nr-swiftc.log; then
    NATIVE_OK=1
  else
    echo "  ! компіляція не вдалася — ставлю резервний лаунчер (див. /tmp/nr-swiftc.log)"
  fi
fi

if [ "$NATIVE_OK" = "0" ]; then
cat > "$APP/Contents/MacOS/CartelRadar" <<'EXEC'
#!/bin/bash
set -u
RES="$(cd "$(dirname "$0")/../Resources" && pwd)"
cd "$RES/app" || exit 1
PORT="${NICHE_RADAR_PORT:-8787}"
NODE_BIN="$(command -v node 2>/dev/null || echo /usr/local/bin/node)"
LINK="http://127.0.0.1:$PORT"
if curl -s -m 2 "$LINK/api/health" 2>/dev/null | grep -q '"ok":true'; then open "$LINK"; exit 0; fi
if [ ! -x "$NODE_BIN" ]; then
  osascript -e 'display alert "Cartel Radar" message "Не знайдено Node.js. Встановіть з https://nodejs.org (LTS)."' >/dev/null 2>&1
  exit 1
fi
exec "$NODE_BIN" server.mjs --port "$PORT" --open
EXEC
fi
chmod +x "$APP/Contents/MacOS/CartelRadar"

# прибираємо карантин, якщо є
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
touch "$APP"

echo
echo "╔══════════════════════════════════════════════════╗"
echo "║  Готово! Три способи запуску:                    ║"
echo "╚══════════════════════════════════════════════════╝"
echo
if [ "$NATIVE_OK" = "1" ]; then
  echo "  ★ Cartel Radar.app — ВЛАСНЕ ВІКНО застосунку (не браузер)."
else
  echo "  ★ Cartel Radar.app — резервний режим (відкриває браузер)."
fi
echo
echo "  1) Робочий стіл → «Cartel Radar.command»  (подвійний клік)"
echo "  2) Applications → «Cartel Radar.app»      (іконка в Dock, ⌘Q — вихід)"
echo "  3) Термінал:  $DEST/launch.command"
echo
echo "  Зупинити: ⌘Q у вікні застосунку або кнопка «Вимкнути сервер» в інтерфейсі."
echo "  Оновлення: запустіть ./install.sh знову — ключі й ніші збережуться."
echo
