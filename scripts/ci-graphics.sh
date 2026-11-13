#!/usr/bin/env bash
# Graphics on Debian on the page (docs/testing.md "ci-graphics"): run it, besides scripts/ci.sh, when a change touches the
# display or 3D (virtio-gpu, its presenter, the GPU worker, the Machine menu's graphics, Venus's device), and at the end
# of a milestone or a track. ~3 min, two Debian boots at a time: page-machine's choice of 3D or 2D graphics, and
# page-venus (vkcube through Venus, its frames presented through sway and compared with lavapipe's; also
# scripts/ci-deqp-vk.sh's). Needs the Debian image, the firmware and the wasm core (scripts/ci.sh builds it); page-venus
# skips without images/debian-vulkan/build.sh's Debian or vk/build.sh's renderer.
set -euo pipefail
cd "$(dirname "$0")/.."
step() { printf '\n== %s (at %d s)\n' "$*" "$SECONDS"; }

for name in debian edk2; do images/build.sh --check "$name" > /dev/null || { echo "ci-graphics: the $name image is missing or stale (images/build.sh $name)"; exit 1; }; done
export WAARM64_DISTROS=debian WAARM64_DEBIAN_SLOTS=${WAARM64_DEBIAN_SLOTS-2}
step 'Graphics on Debian on the page'
node --disable-warning=ExperimentalWarning --test tests/page-machine.test.ts tests/page-venus.test.ts
printf '\nCI-GRAPHICS OK (%d s)\n' "$SECONDS"
