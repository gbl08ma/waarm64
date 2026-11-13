#!/usr/bin/env bash
# ThreadSanitizer on the native parallel SMP runner (M7): every bare-metal
# test in parallel mode, then (with their images) Buildroot on 1, 2 and 4
# vCPUs, a thread each, and the litmus image's tests and atomics stress on 4
# (small: ~1 min), and each of those again through snapshots (the VM saved between
# runs of its threads and a new one restored: the test names match the same filters).
# Any report fails the run (nothing is suppressed: guest
# RAM is accessed with atomics too). Builds std with the sanitizer into target/tsan.
set -euo pipefail
cd "$(dirname "$0")/.."
export RUSTFLAGS=-Zsanitizer=thread TSAN_OPTIONS=halt_on_error=1
host=$(rustc -vV | sed -n 's/^host: //p')
t() { cargo test -q --config 'profile.release.panic="unwind"' -Zbuild-std --target "$host" --release --target-dir target/tsan "$@"; }
WAARM64_PARALLEL_RUNS=3 t --test baremetal baremetal_parallel
if images/build.sh --check linux > /dev/null && images/build.sh --check buildroot > /dev/null; then
  WAARM64_PARALLEL_RUNS=1 t --test boot -- --ignored linux_boots_in_parallel
else
  echo 'tsan: Buildroot SKIPPED (images not current)'
fi
if images/build.sh --check linux > /dev/null && images/build.sh --check litmus > /dev/null; then
  WAARM64_LITMUS=-s,100,-r,1 WAARM64_STRESS=-n,10000 t --test litmus -- --ignored litmus_parallel
else
  echo 'tsan: litmus SKIPPED (images not current)'
fi
