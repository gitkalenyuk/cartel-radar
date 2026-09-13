#!/bin/bash
# uninstall.sh — видалення Cartel Radar з Mac
set -u
DEST="$HOME/Applications/CartelRadar"
APP="$HOME/Applications/Cartel Radar.app"
DESKTOP="$HOME/Desktop/Cartel Radar.command"

echo "Видаляю:"
for p in "$APP" "$DESKTOP"; do [ -e "$p" ] && rm -rf "$p" && echo "  ✓ $p"; done
if [ -d "$DEST" ]; then
  echo
  echo "Дані застосунку лежать у: $DEST/data"
  read -r -p "Видалити їх разом із налаштуваннями та ключами? (y/N) " a
  if [ "$a" = "y" ] || [ "$a" = "Y" ]; then rm -rf "$DEST"; echo "  ✓ видалено $DEST"; else echo "  · дані залишено"; fi
fi
echo "Готово."
