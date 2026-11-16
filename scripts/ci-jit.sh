#!/usr/bin/env bash
# The JIT's amplifying variants (docs/testing.md "Where each thing runs"): run it, besides scripts/ci.sh, when a change
# touches the JIT (core/src/jit/, its emitters and runtime, the dispatcher, the code cache, what compiled code reads
# of the Cpu, TLB or memory) and at the end of a JIT track. JIT-stress (a code cache of 4 blocks: the bare-metal tests,
# kvm-unit-tests' cache and debug, the golden corpus, lockstep) and JIT-check (every block compiled on sight with
# the stale-code checker: the parallel bare-metal tests and the litmus and atomics stress on 4 vCPUs); scripts/ci.sh
# keeps the plain JIT's runs, the default path. ~2 min, alone (the litmus run takes 4 vCPUs). WAARM64_JIT_STRESS=1 adds
# JIT-stress for the guests that skip it (Buildroot's, litmus). Needs the images the tests name (they skip without);
# builds the wasm core.
set -euo pipefail
cd "$(dirname "$0")/.."
step() { printf '\n== %s (at %d s)\n' "$*" "$SECONDS"; }

step 'wasm core'
scripts/build-wasm.sh -q
export WAARM64_JIT_VARIANTS=1 WAARM64_LONG_TESTS=1
step 'JIT-stress and JIT-check'
# JIT-stress runs compare with their interpreter run: those of the short guests come too.
node --disable-warning=ExperimentalWarning --test --test-name-pattern='JIT-stress|JIT-check|JIT stress' \
  --test-name-pattern='^(bare-metal|kvm-unit-tests) .*: interpreter$' \
  tests/boot-node.test.ts tests/boot-node-linux.test.ts tests/boot-node-parallel.test.ts tests/boot-node-litmus.test.ts \
  tests/corpus-wasm.test.ts tests/jit-lockstep.test.ts tests/spin.test.ts
printf '\nCI-JIT OK (%d s)\n' "$SECONDS"
