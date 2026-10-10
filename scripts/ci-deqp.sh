#!/usr/bin/env bash
# dEQP on the page (docs/testing.md "dEQP"): run it, besides scripts/ci.sh, when a change touches 3D: the virgl
# renderer, the TGSI translator, the caps, the GPU worker or virtio-gpu's 3D commands; and at the end of a graphics
# track. ~6 min: GLES2's and GLES3's pass lists (tests/deqp/), a guest boot each. Needs the wasm core (scripts/ci.sh
# builds it) and images/deqp/build.sh's dEQP disk and guest (on demand, ~15 min once).
set -euo pipefail
cd "$(dirname "$0")/.."
step() { printf '\n== %s (at %d s)\n' "$*" "$SECONDS"; }

for f in target/deqp/deqp.ext4 target/deqp/guest.qcow2; do
  [ -f "$f" ] || { echo "ci-deqp: $f is missing (images/deqp/build.sh; --guest-only for the guest alone)"; exit 1; }
done
export WEBPC_DEQP=1
step 'dEQP on the page'
node --disable-warning=ExperimentalWarning --test tests/page-deqp.test.ts
printf '\nCI-DEQP OK (%d s)\n' "$SECONDS"
