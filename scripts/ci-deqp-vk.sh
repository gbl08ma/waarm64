#!/usr/bin/env bash
# dEQP-VK on the page (docs/testing.md "dEQP-VK"): run it, besides scripts/ci.sh, when a change touches Vulkan: the
# renderer's driver or translator (vk/), the GPU worker's WebGPU side (web/venus-gpu.ts), Venus's device; and at the end
# of a Vulkan track. ~4 min: the direct set's pass list (tests/deqp/vk.txt), one guest boot. Needs the wasm core
# (scripts/ci.sh builds it), the renderer (vk/build.sh) and images/deqp/build.sh vk's dEQP-VK disk and guest (on demand,
# ~25 min once). Skips where the page has no WebGPU adapter.
set -euo pipefail
cd "$(dirname "$0")/.."
step() { printf '\n== %s (at %d s)\n' "$*" "$SECONDS"; }

for f in target/deqp/deqp-vk.ext4 target/deqp/guest-vk.qcow2 target/vk/venus.wasm; do
  [ -f "$f" ] || { echo "ci-deqp-vk: $f is missing (images/deqp/build.sh vk; vk/build.sh)"; exit 1; }
done
export WEBPC_DEQP_VK=1
step 'dEQP-VK on the page'
node --disable-warning=ExperimentalWarning --test tests/page-deqp-vk.test.ts
printf '\nCI-DEQP-VK OK (%d s)\n' "$SECONDS"
