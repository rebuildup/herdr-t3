#!/usr/bin/env bash
# Rebuilds src/lib/ghostty/terminal-input.wasm: crates/terminal-input as a
# wasm32 cdylib (ADR-0025, issue #319). The product path loads it through
# src/lib/ghostty/inputRuntime.ts; it is a data artifact like
# shared/ghostty/ghostty-vt.wasm — no codesign/notarize impact.
#
#   rustup target add wasm32-unknown-unknown   # once
#   scripts/terminal-input/build-wasm.sh
#
# Requires a wasm32-capable Rust toolchain; no other pins.
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo"
cargo build -p terminal-input --target wasm32-unknown-unknown --release
cp target/wasm32-unknown-unknown/release/terminal_input.wasm \
  src/lib/ghostty/terminal-input.wasm
shasum -a 256 src/lib/ghostty/terminal-input.wasm
