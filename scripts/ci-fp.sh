#!/usr/bin/env bash
# The FP suite in the guest (docs/testing.md "The FP suite"): run it, besides scripts/ci.sh, when a change touches
# floating point: the JIT's FP fast paths (core/src/jit/emit/float.rs), the FP core (core/src/fp*) or the FP
# interpreter. Berkeley TestFloat's level-1 cases through every scalar and vector FP form under every FPCR mode,
# on 4 parallel vCPUs under the JIT, on both arms of its FMA (a host that fuses); not part of scripts/ci.sh. ~8.5 min, alone. WEBPC_FPTEST_INTERP=1 adds the
# interpreter's run, WEBPC_FPTEST_ARGS the suite's options (images/fptest/fptest.c). Needs the linux and fptest
# images (images/build.sh linux fptest); builds the wasm core.
set -euo pipefail
cd "$(dirname "$0")/.."
step() { printf '\n== %s (at %d s)\n' "$*" "$SECONDS"; }

for i in linux fptest; do
  images/build.sh --check $i > /dev/null || { echo "ci-fp: the $i image is missing or stale (images/build.sh $i)"; exit 1; }
done
step 'wasm core'
scripts/build-wasm.sh
export WEBPC_FPTEST=1
step 'FP suite'
node --disable-warning=ExperimentalWarning --test tests/fptest.test.ts
printf '\nCI-FP OK (%d s)\n' "$SECONDS"
