#!/usr/bin/env bash
# The bundle for VK2's NVIDIA run (bench/vulkan/nvidia.sh page): on the dev VM, one tar of what the page needs there
# that git doesn't carry or the desktop can't build without the dev VM's tools: the repository's tracked files as they
# are in this checkout, the wasm core, Vulkan's renderer (vk/build.sh), the UEFI firmware, and the guests' images: the
# page's Debian, the tests' Debian with Venus (images/debian-vulkan/build.sh), the programs' frames
# (images/vkframes/build.sh), the desktop guest (images/arch/desktop.sh), the media disk (bench/video/media-disk.sh)
# and VK0's scene's disk (images/vulkan/build.sh); since VK3 L8 the dEQP-VK guest and its disk (images/deqp/build.sh vk)
# and vkd3d's (bench/vulkan/vkd3d.ts disk, with its tests built by target/vkd3d/build-tests.sh). ~4.8 GB; the user copies
# it to the desktop.
#   bench/vulkan/nvidia-bundle.sh [out.tar]      (default target/vk2-nvidia-bundle.tar)
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=$(realpath -m "${1:-target/vk2-nvidia-bundle.tar}")
FILES=(
  target/wasm32-unknown-unknown/release/webpc_core.wasm target/vk/venus.wasm target/vk/LICENSES.txt
  target/images/edk2/QEMU_EFI.fd target/images/edk2/LICENSES.txt target/images/debian/disk.qcow2
  target/images/debian-vulkan/disk.qcow2 target/vkframes/vkframes.ext4 target/arch/desktop.qcow2
  target/video/media.ext4 target/vulkan/disk.ext4
  target/deqp/guest-vk.qcow2 target/deqp/deqp-vk.ext4 target/vkd3d/vkd3d.ext4
)
missing=()
for f in "${FILES[@]}"; do [ -f "$f" ] || missing+=("$f"); done
[ ${#missing[@]} -eq 0 ] || { echo "nvidia-bundle: not built: ${missing[*]}" >&2; exit 1; }
# What the run needs to know about the bundle: the commit (and whether the checkout had changes), the files' sizes.
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
{
  echo "webpc VK2 NVIDIA bundle, made $(date -u +%Y-%m-%dT%H:%M:%SZ) from $(git rev-parse --short=12 HEAD)$(git diff --quiet HEAD || echo ' (with uncommitted changes)')"
  for f in "${FILES[@]}"; do printf '  %s %s\n' "$(du -h "$f" | cut -f1)" "$f"; done
} > "$T/BUNDLE.txt"
git ls-files -z | tar --null -cf "$OUT" -T -
tar -rf "$OUT" "${FILES[@]}"
tar -rf "$OUT" -C "$T" BUNDLE.txt
cat "$T/BUNDLE.txt"
ls -lh "$OUT"
echo "Copy it to the desktop, then there, in a checkout of the repository: bench/vulkan/nvidia.sh page <the bundle>"
