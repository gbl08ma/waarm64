#!/bin/sh
# Builds the tailnet client (docs/tailnet.md) to
# target/net/ts.wasm. wasm32-wasip1, not the core's target: std's clocks and
# randomness go through a few WASI imports (web/ts-wasi.ts). Not shared memory,
# no threads: the root .cargo/config.toml's flags are for wasm32-unknown-unknown.
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
# No debug info (the release profile keeps line tables for the core's profiles); speed over
# size: opt-level 3 is ~17% faster than s for 16 KB more Brotli (bench/net/REPORT.md, T1).
CARGO_PROFILE_RELEASE_DEBUG=false CARGO_PROFILE_RELEASE_STRIP=true CARGO_PROFILE_RELEASE_OPT_LEVEL=3 \
	cargo build -q --release -p webpc_ts --target wasm32-wasip1
mkdir -p target/net
cp target/wasm32-wasip1/release/webpc_ts.wasm target/net/ts.wasm
ls -l target/net/ts.wasm | awk '{print $5, $9}'
