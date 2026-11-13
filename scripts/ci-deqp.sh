#!/usr/bin/env bash
# dEQP on the page (docs/testing.md "dEQP"): run it, besides scripts/ci.sh, when a change touches 3D: the virgl
# renderer, the TGSI translator, the caps, the GPU worker or virtio-gpu's 3D commands; and at the end of a graphics
# track. GLES2's and GLES3's pass lists (tests/deqp/), a machine each, both at once: a sample of each list, its seed
# drawn each run and printed (WAARM64_DEQP_SEED=<n> runs it again); --full the whole lists (track ends, changes across
# groups). Four dEQP processes a machine (WAARM64_DEQP_JOBS). Needs the wasm core (scripts/ci.sh builds it) and
# images/deqp/build.sh's dEQP disk and guest (on demand, ~15 min once).
set -euo pipefail
cd "$(dirname "$0")/.."
step() { printf '\n== %s (at %d s)\n' "$*" "$SECONDS"; }

for f in target/deqp/deqp.ext4 target/deqp/guest.qcow2; do
  [ -f "$f" ] || { echo "ci-deqp: $f is missing (images/deqp/build.sh; --guest-only for the guest alone)"; exit 1; }
done
export WAARM64_DEQP=1
what='a sample'
if [ "${1:-}" = --full ]; then export WAARM64_DEQP_FULL=1; what='the whole lists'; fi
step "dEQP on the page ($what)"
node --disable-warning=ExperimentalWarning --test tests/page-deqp.test.ts
printf '\nCI-DEQP OK (%d s)\n' "$SECONDS"
