#!/bin/sh
# Builds the tailnet client (docs/networking/tailnet.md) to
# target/net/ts.wasm. wasm32-wasip1, not the core's target: std's clocks and
# randomness go through a few WASI imports (web/ts-wasi.ts). Not shared memory,
# no threads: the root .cargo/config.toml's flags are for wasm32-unknown-unknown.
#
# `--test-params`: the page tests' module instead, target/net/ts-test.wasm, which runs room names on the tests' pretend
# Bitcoin (the `test-params` feature: room/names.rs `Params::BUILT`); built in a target directory of its own
# (target/ts-test), so the two don't rebuild each other. Never shipped: `npm run dist` takes ts.wasm.
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
out=target/net/ts.wasm
dir=target
features=
if [ "${1:-}" = --test-params ]; then
	out=target/net/ts-test.wasm
	dir=target/ts-test
	features='--features test-params'
fi
# No debug info (the release profile keeps line tables for the core's profiles); speed over
# size: opt-level 3 is ~17% faster than s for 16 KB more Brotli (bench/net/REPORT.md, T1).
# shellcheck disable=SC2086
CARGO_PROFILE_RELEASE_DEBUG=false CARGO_PROFILE_RELEASE_STRIP=true CARGO_PROFILE_RELEASE_OPT_LEVEL=3 \
	cargo build -q --release -p waarm64_ts --target wasm32-wasip1 --target-dir "$dir" $features
mkdir -p target/net
cp "$dir/wasm32-wasip1/release/waarm64_ts.wasm" "$out"
ls -l "$out" | awk '{print $5, $9}'
