#!/usr/bin/env bash
# Rebuilds the native libghostty-vt used by crates/terminal-core (issue #286).
# Same pinned ghostty commit and zig version as build.sh (the wasm artifact);
# the kitty-on-wasm.patch is wasm-only — native builds already enable Kitty
# graphics upstream.
#
#   ZIG=/path/to/zig scripts/ghostty-vt/build-native.sh
#
# Output: native/libghostty-vt.{a,dylib,so} under the repo root (gitignored)
# plus native/BUILD_INFO.txt recording commit + zig version + target.
set -euo pipefail
GHOSTTY_COMMIT=e95bed63330cc921f3cf2fe3d14e024396b09d43
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
zig="${ZIG:-zig}"
out="$repo/native"
mkdir -p "$out"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
if [ ! -d "$work/ghostty/.git" ]; then
  git -C "$work" init -q ghostty
  git -C "$work/ghostty" fetch -q --depth 1 https://github.com/ghostty-org/ghostty "$GHOSTTY_COMMIT"
  git -C "$work/ghostty" checkout -q FETCH_HEAD
fi
(cd "$work/ghostty" && "$zig" build -Demit-lib-vt -Doptimize=ReleaseFast --prefix "$work/out")
# libghostty-vt lands as libghostty-vt.{a,dylib,so} under bin/ or lib/
find "$work/out" -name "libghostty-vt*" -exec cp {} "$out/" \;
# crates/terminal-core links the archive alone (see its build.rs)
mkdir -p "$out/static"
cp "$out/libghostty-vt.a" "$out/static/libghostty-vt.a"
{
  echo "ghostty_commit=$GHOSTTY_COMMIT"
  echo "zig_version=$("$zig" version)"
  echo "target=$(uname -s)-$(uname -m)"
  echo "built_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$out/BUILD_INFO.txt"
ls -la "$out"
