#!/usr/bin/env bash
# Builds the wasm core. std is rebuilt with atomics (needs the pinned nightly).
set -euo pipefail
cd "$(dirname "$0")/.."
cargo build --release --target wasm32-unknown-unknown -Zbuild-std=panic_abort,std -p waarm64-core "$@"
