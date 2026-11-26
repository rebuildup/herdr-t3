#!/usr/bin/env bash
# Rebuilds src/lib/state-projections.wasm: crates/state-projections as a
# wasm32 cdylib (ADR-0025, issue #316). The view-model consumer surface
# (workspace_view_model / agent_view_model / goto_eval) is JSON in/out —
# a data artifact like ghostty-vt.wasm, no codesign/notarize impact.
#
#   rustup target add wasm32-unknown-unknown   # once
#   scripts/state-projections/build-wasm.sh
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo"
cargo build -p state-projections --target wasm32-unknown-unknown --release
cp target/wasm32-unknown-unknown/release/state_projections.wasm \
  src/lib/state-projections.wasm
shasum -a 256 src/lib/state-projections.wasm
