#!/usr/bin/env bash
# ThreadSanitizer on the native parallel SMP runner (M7): every bare-metal
# test in parallel mode, then (with its images) Buildroot on 1, 2 and 4
# vCPUs, a thread each. Any report fails the run; guest-RAM accesses are
# suppressed (core/tsan.supp). Builds std with the sanitizer into target/tsan.
set -euo pipefail
cd "$(dirname "$0")/.."
export RUSTFLAGS=-Zsanitizer=thread TSAN_OPTIONS="suppressions=$PWD/core/tsan.supp halt_on_error=1"
host=$(rustc -vV | sed -n 's/^host: //p')
t() { cargo test -q --config 'profile.release.panic="unwind"' -Zbuild-std --target "$host" --release --target-dir target/tsan "$@"; }
WEBPC_PARALLEL_RUNS=3 t --test baremetal baremetal_parallel
if images/build.sh --check linux > /dev/null && images/build.sh --check buildroot > /dev/null; then
  WEBPC_PARALLEL_RUNS=1 t --test boot -- --ignored linux_boots_in_parallel
else
  echo 'tsan: Buildroot SKIPPED (images not current)'
fi
