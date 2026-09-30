#!/usr/bin/env bash
# The heaviest multi-vCPU runs, left out of scripts/ci.sh for its time (docs/testing.md): run it,
# besides scripts/ci.sh, for changes to the JIT, parallel SMP, broadcast maintenance or the memory
# model, and at a milestone's end. In Node: the parallel litmus and atomics stress under the JIT
# (-r 50, where ci.sh runs -r 10) and JIT-check, and Alpine on 4 parallel vCPUs
# (WEBPC_PARALLEL_RUNS boots). Needs the wasm core (scripts/ci.sh
# builds it) and the linux, litmus and alpine images.
set -euo pipefail
cd "$(dirname "$0")/.."
step() { printf '\n== %s (at %d s)\n' "$*" "$SECONDS"; }

for name in linux litmus alpine; do images/build.sh --check "$name" > /dev/null || { echo "ci-long: the $name image is missing or stale (images/build.sh $name)"; exit 1; }; done
export WEBPC_DISTROS=alpine WEBPC_LONG_TESTS=1
step 'long multi-vCPU tests'
node --disable-warning=ExperimentalWarning --test --test-name-pattern='^parallel: (litmus and stress on 4 vCPUs \(JIT(-check)?\)|Alpine on 4 vCPUs \(JIT\))$' tests/boot-node-litmus.test.ts tests/boot-node-parallel.test.ts
printf '\nCI-LONG OK (%d s)\n' "$SECONDS"
