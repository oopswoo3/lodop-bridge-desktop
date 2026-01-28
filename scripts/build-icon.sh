#!/bin/bash
# 从 public/icon.png 生成 build/icon.icns，供 electron-builder Mac 构建使用
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
SRC="$ROOT/public/icon.png"
BUILD="$ROOT/build"
ICONSET="$BUILD/icon.iconset"

mkdir -p "$ICONSET"
for size in 16 32 64 128 256 512; do
  sips -z $size $size "$SRC" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  [ $size -lt 512 ] && sips -z $((size*2)) $((size*2)) "$SRC" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
sips -z 1024 1024 "$SRC" --out "$ICONSET/icon_512x512@2x.png" >/dev/null
iconutil -c icns "$ICONSET" -o "$BUILD/icon.icns"
echo "Generated $BUILD/icon.icns"
