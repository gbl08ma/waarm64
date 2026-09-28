#!/usr/bin/env bash
# Everything CI runs; works the same locally. CHROMIUM overrides the browser binary.
# docs/testing.md says which runner covers what. Distro boots: alpine and
# alpine-user run when their images are current; WEBPC_DISTROS (a comma list:
# alpine,alpine-user,debian) overrides which ones. Debian is occasional: its
# native run here is interpreted (~8 min); Chromium boots it under the JIT (~1 min).
set -euo pipefail
cd "$(dirname "$0")/.."
step() { printf '\n== %s\n' "$*"; }

step rust fmt;    cargo fmt --all --check
step rust clippy; cargo clippy --all-targets -q -- -D warnings
step rust test;   cargo test -q
step testfloat;   scripts/testfloat.sh
step wasm build;  scripts/build-wasm.sh -q
step npm deps;    [ -d node_modules ] || npm ci --no-fund --no-audit
step typecheck;   npx tsc --noEmit
current() { images/build.sh --check "$1" > /dev/null; }
export WEBPC_DISTROS=${WEBPC_DISTROS-$(current alpine && echo alpine)$(current alpine-user && echo ,alpine-user)}
step js tests;    npm test --silent
# Guest-image tests: run when target/images has the image and it's current.
image_test() {
  step "$1"
  if msg=$(images/build.sh --check "$2"); then
    cargo test -q --release --test "$3" -- --ignored "${@:4}"
  else
    printf '\n**************** SKIPPED: %s ****************\n' "$msg"
  fi
}
image_test 'boot test' linux boot
image_test kvm-unit-tests kvm-unit-tests kvm_unit_tests
image_test 'LTP and kselftests' ltp ltp
for d in alpine debian; do
  if [[ ",$WEBPC_DISTROS," == *",$d,"* ]]; then image_test "$d boot" $d distros $d; else step "$d boot: SKIPPED (not in WEBPC_DISTROS)"; fi
done
printf '\nCI OK\n'
