#!/usr/bin/env bash
# Builds the Rust side of the M0.5 memory spike for wasm32 (flags from
# .cargo/config.toml) and wasm64 (shared memory64, same features).
set -euo pipefail
cd "$(dirname "$0")/../../.."
cargo build --release --target wasm32-unknown-unknown -Zbuild-std=panic_abort,std -p waarm64-memspike "$@"
CARGO_TARGET_WASM64_UNKNOWN_UNKNOWN_RUSTFLAGS="-C target-feature=+bulk-memory,+mutable-globals,+simd128 -Zllvm-target-feature=+atomics -C link-arg=--import-memory -C link-arg=--shared-memory -C link-arg=--max-memory=17179869184" \
  cargo build --release --target wasm64-unknown-unknown -Zbuild-std=panic_abort,std -p waarm64-memspike "$@"
