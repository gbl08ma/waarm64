#!/usr/bin/env bash
# The JIT's amplifying variants (docs/testing.md "Where each thing runs"): run it, besides scripts/ci.sh, when a change
# touches the JIT (core/src/jit/, its emitters and runtime, the dispatcher, the code cache, what compiled code reads
# of the Cpu, TLB or memory) and at the end of a JIT track. JIT-stress (a code cache of 4 blocks: the bare-metal tests,
# kvm-unit-tests' cache and debug, the golden corpus, lockstep) and JIT-check (every block compiled on sight with
# the stale-code checker: the parallel bare-metal tests and the litmus and atomics stress on 4 vCPUs); scripts/ci.sh
# keeps the plain JIT's runs, the default path. ~2 min, alone (the litmus run takes 4 vCPUs). WAARM64_JIT_STRESS=1 adds
# JIT-stress for the guests that skip it (Buildroot's, litmus). Needs the images the tests name (they skip without);
# builds the wasm core, and the polled test core (Cargo feature `polled`, target/polled/) for the differential test,
# the user-mode lockstep and the corpus on parallel SMP's polled code, and the differential test on its polled code
# without `acc` (docs/testing.md "Polled code against the interpreter").
set -euo pipefail
cd "$(dirname "$0")/.."
step() { printf '\n== %s (at %d s)\n' "$*" "$SECONDS"; }
source scripts/ci-lock.sh; ci_lock exclusive # alone on the machine (scripts/ci-lock.sh)

step 'wasm core'
scripts/build-wasm.sh -q
export WAARM64_JIT_VARIANTS=1 WAARM64_LONG_TESTS=1
step 'JIT-stress and JIT-check'
# JIT-stress runs compare with their interpreter run: those of the short guests come too.
node --disable-warning=ExperimentalWarning --test --test-name-pattern='JIT-stress|JIT-check|JIT stress' \
  --test-name-pattern='^(bare-metal|kvm-unit-tests) .*: interpreter$' \
  tests/boot-node.test.ts tests/boot-node-linux.test.ts tests/boot-node-parallel.test.ts tests/boot-node-litmus.test.ts \
  tests/corpus-wasm.test.ts tests/jit-lockstep.test.ts
# Alone: its spinning vCPUs and their bounds in µs shouldn't share the cores with the parallel boots above (beside
# them, both missed their bounds once, PERF loop 33).
step 'spin tests'
node --disable-warning=ExperimentalWarning --test --test-name-pattern='JIT-stress|JIT-check|the block interpreter' \
  tests/spin.test.ts
step 'polled code against the interpreter'
CARGO_TARGET_DIR=target/polled scripts/build-wasm.sh -q --features polled
WAARM64_CORE=target/polled/wasm32-unknown-unknown/release/waarm64_core.wasm WAARM64_POLLED=1 WAARM64_JIT_DIFF=1024 \
  node --disable-warning=ExperimentalWarning --test --test-name-pattern='^(JIT vs interpreter|lockstep: .*user mode, JIT$|golden corpus on the wasm core: JIT)' \
  tests/jit-diff-[1-4].test.ts tests/jit-lockstep.test.ts tests/corpus-wasm.test.ts
# The same core's polled code without `acc` (`jit_uncounted`): a run to the first poll, the interpreter stepped to
# its state (the steps uncounted; docs/testing.md "Polled code against the interpreter").
WAARM64_CORE=target/polled/wasm32-unknown-unknown/release/waarm64_core.wasm WAARM64_POLLED=2 WAARM64_JIT_DIFF=1024 \
  node --disable-warning=ExperimentalWarning --test --test-name-pattern='^JIT vs interpreter' tests/jit-diff-[1-4].test.ts
printf '\nCI-JIT OK (%d s)\n' "$SECONDS"
