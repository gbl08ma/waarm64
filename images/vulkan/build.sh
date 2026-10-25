#!/usr/bin/env bash
# VK0's scene in the guest (bench/vulkan/REPORT.md, arm 4): the native scene (bench/vulkan/scene: vk on the guest's
# lavapipe, gles on its virgl) built natively for Arch Linux (arch.bens.haus's aarch64 port, the desktop guest's
# distribution) in rootless Podman from localhost/arch-base (images/arch/base.sh). On demand only: not in
# images/build.sh, SHA256SUMS or CI. Results:
#   target/vulkan/disk.ext4    /vk0 (ext4, label vk0): vk, gles, their shaders, the asset pack and bench/vulkan/sweep.sh;
#                              the page's second disk, which bench/vulkan/guest.ts mounts
#   target/vulkan/guest.qcow2  the guest that runs them: Arch Linux with Mesa and lavapipe (images/arch/build.sh
#                              --packages; ~4 min more)
#   images/vulkan/build.sh [--guest-only | --disk-only]
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
W=$ROOT/target/vulkan
mkdir -p "$W"
guest() { "$ROOT/images/arch/build.sh" --packages "mesa vulkan-swrast vulkan-icd-loader" --out "$W/guest.qcow2"; }
if [ "${1-}" = --guest-only ]; then guest; exit; fi
[ -f "$W/aquarium.pack" ] || node --disable-warning=ExperimentalWarning "$ROOT/bench/vulkan/assets.ts"
node --disable-warning=ExperimentalWarning "$ROOT/bench/vulkan/scene/gles-shaders.ts" "$W/gles-shaders"
"$ROOT/images/arch/base.sh"
podman build -q -t localhost/webpc-vk0 "$ROOT/images/vulkan" >/dev/null
rm -rf "$W/tree"; mkdir -p "$W/tree/vk0"
cp -r "$W/gles-shaders" "$W/tree/vk0/"
cp "$W/aquarium.pack" "$ROOT/bench/vulkan/sweep.sh" "$W/tree/vk0/"
podman run --rm -v "$ROOT/bench/vulkan/scene:/src:ro,Z" -v "$W:/out:Z" localhost/webpc-vk0 sh -euc '
  NO_GLES= /src/build.sh /out/tree/vk0 >/dev/null
  du -sm /out/tree | cut -f1 > /out/size
  truncate -s $(( $(cat /out/size) * 12 / 10 + 32 ))M /out/disk.ext4.new
  mke2fs -q -t ext4 -L vk0 -d /out/tree /out/disk.ext4.new
  mv /out/disk.ext4.new /out/disk.ext4'
rm -rf "$W/tree" "$W/size"
ls -l "$W/disk.ext4"
[ "${1-}" = --disk-only ] || guest
