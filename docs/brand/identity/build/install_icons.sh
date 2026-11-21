#!/usr/bin/env bash
# Install the Slonview app icon into src-tauri/icons (desktop only).
# 1. `pnpm tauri icon` generates every size from the 1024 master.
# 2. The 16 and 32 px slots are then replaced with the hand-tuned masters, because
#    `tauri icon` only downscales. Affects icon.icns, icon.ico and 32x32.png.
# Run from the repo root after `python3 docs/brand/identity/build/build.py`.
set -euo pipefail
ID=docs/brand/identity/appicon
ICONS=src-tauri/icons

pnpm tauri icon "$ID/icon-light-1024.png"
rm -rf "$ICONS/android" "$ICONS/ios"
cp "$ID/icon.svg" "$ICONS/icon.svg"
cp "$ID/icon-light-32.png" "$ICONS/32x32.png"

SET=$(mktemp -d)/icon.iconset
mkdir -p "$SET"
cp "$ID/icon-light-16.png" "$SET/icon_16x16.png"
cp "$ID/icon-light-32.png" "$SET/icon_16x16@2x.png"
cp "$ID/icon-light-32.png" "$SET/icon_32x32.png"
cp "$ID/icon-light-64.png" "$SET/icon_32x32@2x.png"
cp "$ID/icon-light-128.png" "$SET/icon_128x128.png"
cp "$ID/icon-light-256.png" "$SET/icon_128x128@2x.png"
cp "$ID/icon-light-256.png" "$SET/icon_256x256.png"
cp "$ID/icon-light-512.png" "$SET/icon_256x256@2x.png"
cp "$ID/icon-light-512.png" "$SET/icon_512x512.png"
cp "$ID/icon-light-1024.png" "$SET/icon_512x512@2x.png"
iconutil -c icns "$SET" -o "$ICONS/icon.icns"

python3 - "$ID" "$ICONS/icon.ico" <<'PY'
import sys
from PIL import Image
d, out = sys.argv[1], sys.argv[2]
sizes = [16, 24, 32, 48, 64, 256]
ims = {}
for n in sizes:
    src = f"{d}/icon-light-{n}.png" if n in (16, 32, 64, 256) else f"{d}/icon-light-1024.png"
    ims[n] = Image.open(src).convert("RGBA").resize((n, n), Image.LANCZOS) if n in (24, 48) else Image.open(src).convert("RGBA")
ims[256].save(out, sizes=[(n, n) for n in sizes], append_images=[ims[n] for n in sizes if n != 256])
PY
echo "installed"
