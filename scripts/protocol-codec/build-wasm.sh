#!/usr/bin/env bash
# Rebuilds shared/protocol-codec.wasm: crates/protocol-codec as a wasm32
# cdylib (ADR-0025, issue #315). The product ingress guards load it through
# shared/protocolWasm.ts; it ships inside the packaged app via the
# electron-builder files entry — a data artifact, no codesign delta.
#
#   rustup target add wasm32-unknown-unknown   # once
#   scripts/protocol-codec/build-wasm.sh
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo"
cargo build -p protocol-codec --target wasm32-unknown-unknown --release
cp target/wasm32-unknown-unknown/release/protocol_codec.wasm \
  shared/protocol-codec.wasm
shasum -a 256 shared/protocol-codec.wasm
