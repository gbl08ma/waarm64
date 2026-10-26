#!/usr/bin/env bash
# dEQP for G4's conformance subset (docs/graphics.md "Testing"; the G4 kickoff's decision 3): VK-GL-CTS
# opengl-es-cts-3.2.14.1 (Apache-2.0: a workload, built and run, nothing copied), deqp-gles2 and deqp-gles3 on EGL's
# surfaceless platform, built natively for Arch Linux (arch.bens.haus's aarch64 port: the desktop guest's
# distribution) in rootless Podman from localhost/arch-base (images/arch/base.sh). On demand only: not in
# images/build.sh, SHA256SUMS or CI. Results:
#   target/deqp/deqp.ext4   the two binaries, their data and the GLES mustpass lists in /deqp (ext4, label deqp): the
#                           page's second disk (?disk2=), which the guest mounts (bench/gpu/deqp-run.ts)
#   target/deqp/guest.qcow2 the guest that runs them on the page: Arch Linux with mesa and libpng
#                           (images/arch/build.sh --packages; ~4 min more), scripts/ci-deqp.sh's
#   localhost/webpc-deqp    the build's image: the same binaries on Mesa's virpipe against the vtest oracle
#                           (tools/virgl-oracle/deqp.sh), for the expected results
#   images/deqp/build.sh [--guest-only]
# And with `vk`, dEQP-VK for VK2 (docs/testing.md "dEQP-VK"; scripts/ci-deqp-vk.sh): VK-GL-CTS vulkan-cts-1.4.7.0's
# deqp-vk (Containerfile.vk, ~20 min once), the same way:
#   target/deqp/deqp-vk.ext4   deqp-vk and its data in /deqp/vk, and /deqp/vk-main.txt: the mustpass list's groups the
#                              direct set can pass (VK_GROUPS below; ext4, label deqp-vk)
#   target/deqp/guest-vk.qcow2 Arch Linux with mesa, vulkan-virtio (Venus's guest driver) and the loader
#   images/deqp/build.sh vk [--guest-only]
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
W=$ROOT/target/deqp
mkdir -p "$W"
if [ "${1-}" = vk ]; then
  guest_vk() { "$ROOT/images/arch/build.sh" --packages "mesa vulkan-virtio vulkan-icd-loader libpng" --out "$W/guest-vk.qcow2"; }
  if [ "${2-}" = --guest-only ]; then guest_vk; exit; fi
  # The mustpass files (external/vulkancts/mustpass/main/vk-default/) of the direct set's groups (docs/plans/graphics.md
  # §4's direct rows); the pass lists (tests/deqp/vk-*.txt) take their cases from these.
  VK_GROUPS="info api memory draw compute pipeline/monolithic/* renderpasses ubo ssbo texture glsl binding-model query-pool rasterization fragment-operations clipping dynamic-state"
  "$ROOT/images/arch/base.sh"
  podman build -q -t localhost/webpc-deqp-vk -f "$ROOT/images/deqp/Containerfile.vk" "$ROOT/images/deqp" >/dev/null
  rm -rf "$W/tree-vk"; mkdir -p "$W/tree-vk"
  podman run --rm -v "$W:/out:Z" -e VK_GROUPS="$VK_GROUPS" localhost/webpc-deqp-vk sh -euc '
    d=/out/tree-vk/deqp/vk
    mkdir -p $d
    cp /build/external/vulkancts/modules/vulkan/deqp-vk $d/
    strip $d/deqp-vk
    cp -r /build/external/vulkancts/modules/vulkan/vulkan $d/
    m=/cts/external/vulkancts/mustpass/main/vk-default
    for g in $VK_GROUPS; do cat $m/$g.txt; done > /out/tree-vk/deqp/vk-main.txt
    du -sm /out/tree-vk | cut -f1 > /out/size
    truncate -s $(( $(cat /out/size) * 13 / 10 + 64 ))M /out/deqp-vk.ext4.new
    mke2fs -q -t ext4 -L deqp-vk -d /out/tree-vk /out/deqp-vk.ext4.new
    mv /out/deqp-vk.ext4.new /out/deqp-vk.ext4'
  rm -rf "$W/tree-vk" "$W/size"
  ls -l "$W/deqp-vk.ext4"
  [ -f "$W/guest-vk.qcow2" ] || guest_vk
  exit
fi
guest() { "$ROOT/images/arch/build.sh" --packages "mesa libpng" --out "$W/guest.qcow2"; }
if [ "${1-}" = --guest-only ]; then guest; exit; fi
"$ROOT/images/arch/base.sh"
podman build -q -t localhost/webpc-deqp "$ROOT/images/deqp" >/dev/null
rm -rf "$W/tree"; mkdir -p "$W/tree"
podman run --rm -v "$W:/out:Z" localhost/webpc-deqp sh -euc '
  d=/out/tree/deqp
  for m in gles2 gles3; do
    mkdir -p $d/$m
    cp /build/modules/$m/deqp-$m $d/$m/
    cp -r /build/modules/$m/$m $d/$m/ 2>/dev/null || cp -r /cts/data/$m $d/$m/$m
  done
  cp /cts/external/openglcts/data/gl_cts/data/mustpass/gles/aosp_mustpass/main/gles2-main.txt \
     /cts/external/openglcts/data/gl_cts/data/mustpass/gles/aosp_mustpass/main/gles3-main.txt $d/
  du -sm $d | cut -f1 > /out/size
  truncate -s $(( $(cat /out/size) * 13 / 10 + 64 ))M /out/deqp.ext4.new
  mke2fs -q -t ext4 -L deqp -d /out/tree /out/deqp.ext4.new
  mv /out/deqp.ext4.new /out/deqp.ext4'
rm -rf "$W/tree" "$W/size"
ls -l "$W/deqp.ext4"
guest
