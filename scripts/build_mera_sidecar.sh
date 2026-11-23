#!/usr/bin/env bash
# Build the portable MERA RTK/PPK sidecar binary from the sibling Mera repo
# and stage it for Mappa Tauri bundling (src-tauri/binaries/mera-rtk-<triple>).
set -euo pipefail

MAPPA_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MERA_ENGINE="${MERA_ENGINE_DIR:-$MAPPA_ROOT/../Mera/mera-engine}"
BUILD_DIR="${MERA_BUILD_DIR:-$MERA_ENGINE/build-release}"

if [[ ! -f "$MERA_ENGINE/CMakeLists.txt" ]]; then
  echo "build_mera_sidecar: MERA engine not found at $MERA_ENGINE (set MERA_ENGINE_DIR)" >&2
  exit 2
fi

if ! command -v rustc >/dev/null 2>&1 && [[ -d "$HOME/.cargo/bin" ]]; then
  export PATH="$HOME/.cargo/bin:$PATH"
fi

TARGET_TRIPLE="${CARGO_BUILD_TARGET:-$(rustc -vV | awk '/^host:/ { print $2 }')}"
if [[ -z "$TARGET_TRIPLE" ]]; then
  echo "build_mera_sidecar: cannot determine Rust host target triple" >&2
  exit 2
fi

echo "== configure portable MERA release ($TARGET_TRIPLE) =="
cmake -S "$MERA_ENGINE" -B "$BUILD_DIR" \
  -DCMAKE_BUILD_TYPE=Release \
  -DMERA_NATIVE=OFF \
  -DMERA_SANITIZE=OFF >/dev/null

echo "== build mera-rtk =="
cmake --build "$BUILD_DIR" --target mera-rtk -j"$(nproc)"

echo "== self-test =="
"$BUILD_DIR/mera-rtk" --self-test

DEST_DIR="$MAPPA_ROOT/src-tauri/binaries"
mkdir -p "$DEST_DIR"
EXT=""
if [[ "$TARGET_TRIPLE" == *windows* ]]; then
  EXT=".exe"
fi
DEST="$DEST_DIR/mera-rtk-${TARGET_TRIPLE}${EXT}"
cp -f "$BUILD_DIR/mera-rtk${EXT}" "$DEST"
chmod +x "$DEST"
echo "staged sidecar: $DEST ($(du -h "$DEST" | cut -f1))"
