# Іконки застосунку

Сюди кладуться готові іконки для збірок:

- `icon.icns` — macOS (використовується вже, лежить у `assets/icon.icns`)
- `icon.ico` — Windows (потрібен для інсталятора; якщо його немає, electron-builder візьме PNG)

## Як зробити .icns із PNG (macOS)

```bash
mkdir icon.iconset
for s in 16 32 64 128 256 512; do
  sips -z $s $s icon.png --out icon.iconset/icon_${s}x${s}.png
  sips -z $((s*2)) $((s*2)) icon.png --out icon.iconset/icon_${s}x${s}@2x.png
done
iconutil -c icns icon.iconset -o icon.icns
```

## Як зробити .ico (ImageMagick)

```bash
convert icon.png -define icon:auto-resize=256,128,64,48,32,16 icon.ico
```

Іконка має бути квадратною PNG не менше 1024×1024.
