#!/usr/bin/env bash
# What every change runs (~6 min); works the same locally. CHROMIUM overrides the browser binary.
# docs/testing.md says which runner covers what. Distro boots: alpine, alpine-user and
# alpine-uefi run when their images are current; WEBPC_DISTROS (a comma list) overrides which
# ones. The Debian page boots are scripts/ci-debian.sh's, graphics' scripts/ci-graphics.sh's, the network
# tests on Debian scripts/ci-net.sh's, the JIT's JIT-stress and JIT-check variants scripts/ci-jit.sh's. The heaviest
# multi-vCPU runs (WEBPC_LONG_TESTS) are on.
set -euo pipefail
cd "$(dirname "$0")/.."
step() { printf '\n== %s (at %d s)\n' "$*" "$SECONDS"; }

step rust fmt;    cargo fmt --all --check
step rust clippy; cargo clippy --all-targets -q -- -D warnings
step rust test;   cargo test -q
# Clipboard sharing's guest agent (agent/: its own crate and toolchain), then its build (Podman; the host's cargo without it).
step agent;       (cd agent && cargo fmt --check && cargo clippy --all-targets -q -- -D warnings && cargo test -q) && images/build.sh agent
step testfloat;   scripts/testfloat.sh
step wasm build;  scripts/build-wasm.sh -q
step tailnet client; net/ts/build.sh
step npm deps;    [ node_modules/.package-lock.json -nt package-lock.json ] || npm ci --no-fund --no-audit
step typecheck;   npx tsc --noEmit
step svelte-check; npm run -s svelte-check
step i18n;        node --disable-warning=ExperimentalWarning tools/i18n-check.ts
step third-party; node --disable-warning=ExperimentalWarning tools/third-party.ts
current() { images/build.sh --check "$1" > /dev/null; }
export WEBPC_DISTROS=${WEBPC_DISTROS-$(current alpine && echo alpine)$(current alpine-user && echo ,alpine-user)$(current alpine-uefi && echo ,alpine-uefi)}
export WEBPC_LONG_TESTS=${WEBPC_LONG_TESTS-1}
# Guest-image tests: run when target/images has the images (a space-separated
# list) and they're current.
image_test() {
  step "$1"
  local msg= name
  for name in $2; do msg=$msg$(images/build.sh --check "$name" || true); done
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
  # A cloud session fetches the firmware but not shell.img (docs/cloud.md): no disk, no test.
  if [ -f target/images/edk2/shell.img ]; then image_test 'firmware (EDK2)' edk2 firmware; else step 'firmware (EDK2)'; printf '\n**************** SKIPPED: no edk2/shell.img: run images/build.sh edk2 ****************\n'; fi
  image_test 'gpu guest' linux-gpu gpu_guest
  image_test 'snd guest' linux-snd snd_guest
  image_test 'usb guest' linux-usb usb_guest
  if [[ ",$WEBPC_DISTROS," == *",alpine,"* ]]; then image_test "alpine boot" alpine distros alpine; else step "alpine boot: SKIPPED (not in WEBPC_DISTROS)"; fi
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
