#!/usr/bin/env bash
# Before a push (T2, docs/testing.md "Tiers"; ~10.5 min on 2026-11-18: the quick checks at once, then the crates and
# builds at once, then the JS tests beside the native ones); works the same locally. CHROMIUM overrides the browser binary.
# docs/testing.md says which runner covers what. Distro boots: alpine, alpine-user and
# alpine-uefi run when their images are current; WAARM64_DISTROS (a comma list) overrides which
# ones. The Debian page boots are scripts/ci-debian.sh's, graphics' scripts/ci-graphics.sh's, the network
# tests on Debian scripts/ci-net.sh's, the JIT's JIT-stress and JIT-check variants scripts/ci-jit.sh's. The heaviest
# multi-vCPU runs (WAARM64_LONG_TESTS) are on.
set -euo pipefail
cd "$(dirname "$0")/.."
step() { printf '\n== %s (at %d s)\n' "$*" "$SECONDS"; }
# The Rust tests run under cargo-nextest (.config/nextest.toml).
cargo nextest --version > /dev/null 2>&1 || { echo 'cargo-nextest is missing: cargo +stable install --locked cargo-nextest@0.9.152 (docs/devenv.md)' >&2; exit 1; }
source scripts/ci-lock.sh; ci_lock exclusive # alone on the machine (scripts/ci-lock.sh)

step rust fmt;    cargo fmt --all --check
step npm deps;    [ node_modules/.package-lock.json -nt package-lock.json ] || npm ci --no-fund --no-audit
step lint deps;   [ tools/lint/node_modules/.package-lock.json -nt tools/lint/package-lock.json ] || npm ci --prefix tools/lint --no-fund --no-audit
source scripts/ci-group.sh
node=(node --disable-warning=ExperimentalWarning)
# The checks that take seconds first, at once (~15 s; ~45 s one after another): a type error or a lint once surfaced
# only after the Rust tests' ~170 s.
step 'static checks'
group "typecheck::npx tsc --noEmit" \
  "svelte-check::npm run -s svelte-check" \
  "lint::npm run -s lint" \
  "i18n::${node[*]} tools/i18n-check.ts" \
  "third-party::${node[*]} tools/third-party.ts" \
  "labels::${node[*]} tools/issue.ts labels --lint" \
  "backlog-refs::${node[*]} tools/backlog-refs.ts" \
  "harness-imports::${node[*]} tools/harness-imports.ts" \
  "areas::${node[*]} tools/ci-select.ts --check" \
  "clippy::cargo clippy --all-targets -q -- -D warnings"
# Then the crates' tests and the builds the JS tests need, at once (the machine was ~70% idle running them one after
# another, 2026-11-18). cargo-nextest: every test binary's tests at once (.config/nextest.toml); doctests apart.
# Clipboard sharing's guest agent (agent/: its own crate and toolchain), then its build (Podman; the host's cargo
# without it). TestFloat: waarm64_core::fp against Berkeley TestFloat's vectors. The tailnet client's test module too
# (tests/names-*.test.ts run it when it exists): a stale one tested the page's names agent against an older module and
# failed for no fault of the change (QA, 2026-11-18).
step 'crates and builds'
group "rust-test::cargo nextest run --cargo-quiet && cargo test -q --doc" \
  "agent::(cd agent && cargo fmt --check && cargo clippy --all-targets -q -- -D warnings && cargo test -q) && images/build.sh agent" \
  "testfloat::scripts/testfloat.sh" \
  "builds::scripts/build-wasm.sh -q && net/ts/build.sh && net/ts/build.sh --test-params"
current() { images/build.sh --check "$1" > /dev/null; }
export WAARM64_DISTROS=${WAARM64_DISTROS-$(current alpine && echo alpine)$(current alpine-user && echo ,alpine-user)$(current alpine-uefi && echo ,alpine-uefi)}
export WAARM64_LONG_TESTS=${WAARM64_LONG_TESTS-1}
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
  if [[ ",$WAARM64_DISTROS," == *",alpine,"* ]]; then image_test "alpine boot" alpine distros alpine; else step "alpine boot: SKIPPED (not in WAARM64_DISTROS)"; fi
}
# The native guest-image tests (~130 s) run beside the JS tests, which spend much of their time
# waiting on realtime guests and the Debian lock; their output follows the JS tests'.
native_log=$ci_group_logs/native.log
native > "$native_log" 2>&1 &
native_pid=$!
# npm test's files, with each file's wall time written to target/ci/timings.json (tools/test-timings.ts: tests/areas.ts's
# check keeps the fast lane's smoke set to the quick files from it). A test without its own timeout fails after 10 min
# (the longest here take ~100 s): a hang then names its test instead of holding the step until the run's timeout.
# WAARM64_JS_JOBS=N runs N files at a time instead of node's default (7 here): 4 was ~38 s slower and peaked ~1.9 GiB
# lower (2026-11-18), for a host with less memory.
mkdir -p target/ci
step js tests;    js=0; node --disable-warning=ExperimentalWarning --test --test-timeout=600000 ${WAARM64_JS_JOBS:+--test-concurrency=$WAARM64_JS_JOBS} --test-reporter=spec --test-reporter-destination=stdout \
  --test-reporter=./tools/test-timings.ts --test-reporter-destination=target/ci/timings.json.new 'tests/**/*.test.ts' || js=$?
# The reporter writes only at the end: a cancelled step leaves an empty file, which doesn't replace the last timings.
if [[ -s target/ci/timings.json.new ]]; then mv target/ci/timings.json.new target/ci/timings.json; fi
step 'native guest-image tests (ran beside the JS tests)'
native_rc=0; wait "$native_pid" || native_rc=$?
cat "$native_log"
if (( js || native_rc )); then printf '\nCI FAILED: js tests %d, native guest-image tests %d\n' "$js" "$native_rc"; exit 1; fi
printf '\nCI OK (%d s)\n' "$SECONDS"
