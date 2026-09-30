#!/usr/bin/env bash
# Everything CI runs; works the same locally. CHROMIUM overrides the browser binary.
# docs/testing.md says which runner covers what. Distro boots: alpine,
# alpine-user and debian run when their images are current; WEBPC_DISTROS (a
# comma list: alpine,alpine-user,debian) overrides which ones. Debian's native
# run is interpreted (~2.5 min), so it needs WEBPC_DEBIAN_NATIVE=1 as well;
# by default Debian boots only in Chromium under the JIT (~1 min).
set -euo pipefail
cd "$(dirname "$0")/.."
step() { printf '\n== %s (at %d s)\n' "$*" "$SECONDS"; }

step rust fmt;    cargo fmt --all --check
step rust clippy; cargo clippy --all-targets -q -- -D warnings
step rust test;   cargo test -q
step testfloat;   scripts/testfloat.sh
step wasm build;  scripts/build-wasm.sh -q
step npm deps;    [ node_modules/.package-lock.json -nt package-lock.json ] || npm ci --no-fund --no-audit
step typecheck;   npx tsc --noEmit
current() { images/build.sh --check "$1" > /dev/null; }
export WEBPC_DISTROS=${WEBPC_DISTROS-$(current alpine && echo alpine)$(current alpine-user && echo ,alpine-user)$(current debian && echo ,debian)}
# The network tests on Debian (net-guest, page-network, net-tailnet: ~4 min) are scripts/ci-net.sh's.
# Guest-image tests: run when target/images has the images (a space-separated
# list) and they're current.
image_test() {
  step "$1"
  local msg= name
  for name in $2; do msg=$msg$(images/build.sh --check "$name"); done
  if [ -z "$msg" ]; then
    cargo test -q --release --test "$3" -- --ignored "${@:4}"
  else
    printf '\n**************** SKIPPED: %s ****************\n' "$msg"
  fi
}
native() {
  image_test 'boot test' 'linux buildroot' boot
  step tsan;        scripts/tsan.sh
  image_test kvm-unit-tests kvm-unit-tests kvm_unit_tests
  image_test 'litmus and stress' 'linux litmus' litmus
  image_test 'LTP and kselftests' 'ltp linux' ltp
  for d in alpine debian; do
    if [[ $d == debian && ${WEBPC_DEBIAN_NATIVE-} != 1 ]]; then step "debian boot (native): SKIPPED (set WEBPC_DEBIAN_NATIVE=1)"
    elif [[ ",$WEBPC_DISTROS," == *",$d,"* ]]; then image_test "$d boot" $d distros $d; else step "$d boot: SKIPPED (not in WEBPC_DISTROS)"; fi
  done
}
# The native guest-image tests (~130 s) run beside the JS tests, which spend much of their time
# waiting on realtime guests and the Debian lock; their output follows the JS tests'.
native_log=$(mktemp)
trap 'rm -f "$native_log"' EXIT
native > "$native_log" 2>&1 &
native_pid=$!
step js tests;    js=0; npm test --silent || js=$?
step 'native guest-image tests (ran beside the JS tests)'
native_rc=0; wait "$native_pid" || native_rc=$?
cat "$native_log"
if (( js || native_rc )); then printf '\nCI FAILED: js tests %d, native guest-image tests %d\n' "$js" "$native_rc"; exit 1; fi
printf '\nCI OK (%d s)\n' "$SECONDS"
