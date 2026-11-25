#!/usr/bin/env bash
# Ensures native/libghostty-vt.a exists for crates/terminal-core (issue #286).
# Builds it via build-native.sh when missing; needs zig 0.17.1 on PATH or in
# $ZIG. CI caches native/ so this is normally a no-op there.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
if [ -f "$repo/native/static/libghostty-vt.a" ]; then
  exit 0
fi
if ! command -v "${ZIG:-zig}" >/dev/null 2>&1; then
  echo "error: native libghostty-vt.a missing and zig not found." >&2
  echo "install zig 0.17.1 or set ZIG=/path/to/zig, then rerun." >&2
  exit 1
fi
"$here/build-native.sh"
