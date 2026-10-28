#!/usr/bin/env bash
# dEQP-VK on the page (docs/testing.md "dEQP-VK"): run it, besides scripts/ci.sh, when a change touches Vulkan: the
# renderer's driver or translator (vk/), the GPU worker's WebGPU side (web/venus-gpu.ts), Venus's device; and at the end
# of a Vulkan track. ~12 min: the direct set's pass list (tests/deqp/vk.txt), one guest boot; then the programs'
# captures replayed against lavapipe's frames (tests/page-venus.test.ts, also scripts/ci-debian.sh's: VK3 L6c, vkQuake's
# first frame went 80% wrong over three loops that ran only this script). Needs the wasm core (scripts/ci.sh builds it),
# the renderer (vk/build.sh), images/deqp/build.sh vk's dEQP-VK disk and guest (on demand, ~25 min once),
# images/debian-vulkan/build.sh's Debian and images/vkframes/build.sh's disk. Skips where the page has no WebGPU adapter.
set -euo pipefail
cd "$(dirname "$0")/.."
step() { printf '\n== %s (at %d s)\n' "$*" "$SECONDS"; }

for f in target/deqp/deqp-vk.ext4 target/deqp/guest-vk.qcow2 target/vk/venus.wasm target/images/debian-vulkan/disk.qcow2 target/vkframes/vkframes.ext4; do
  [ -f "$f" ] || { echo "ci-deqp-vk: $f is missing (images/deqp/build.sh vk; vk/build.sh; images/debian-vulkan/build.sh; images/vkframes/build.sh)"; exit 1; }
done
export WEBPC_DEQP_VK=1
step 'dEQP-VK on the page'
node --disable-warning=ExperimentalWarning --test tests/page-deqp-vk.test.ts
step 'The programs replayed through Venus on the page'
WEBPC_DISTROS=debian node --disable-warning=ExperimentalWarning --test tests/page-venus.test.ts
printf '\nCI-DEQP-VK OK (%d s)\n' "$SECONDS"
