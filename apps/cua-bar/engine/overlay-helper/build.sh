#!/bin/sh
# Builds cuabar-overlay (arm64 + x86_64, macOS 13 on) next to its source and records the source's hash in
# cuabar-overlay.source-sha256, which the engine tests compare with the source. Run it after changing the source and
# commit the binary with it: the engine copies take the binary as it is and never compile.
set -eu
cd "$(dirname "$0")"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
for arch in arm64 x86_64; do
  xcrun swiftc -O -target "$arch-apple-macos13" -o "$work/$arch" cuabar-overlay.swift
done
xcrun lipo -create "$work/arm64" "$work/x86_64" -output "$work/cuabar-overlay"
codesign --force --sign - "$work/cuabar-overlay"
chmod 755 "$work/cuabar-overlay"
mv "$work/cuabar-overlay" cuabar-overlay
shasum -a 256 cuabar-overlay.swift | cut -d' ' -f1 > cuabar-overlay.source-sha256
