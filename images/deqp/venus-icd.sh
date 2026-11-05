#!/usr/bin/env bash
# A Venus guest driver from another Mesa than the dEQP-VK guest's (VK4 T24: Mesa 26.2's Venus leaves out
# VK_KHR_maintenance8, 26.3's passes it on), for dEQP-VK runs until the guest's own Mesa has it (docs/images.md "dEQP
# for the Arch image"). Builds libvulkan_virtio.so in a container of localhost/arch-base (images/arch/base.sh: the
# guest's distribution, so its libraries match) and puts it, with an ICD manifest naming it, in /venus of a copy of
# dEQP-VK's disk (debugfs: no root, no mount).
#   images/deqp/venus-icd.sh [mesa tag, default mesa-26.3.0-rc3]   -> target/deqp/deqp-vk-venus.ext4
# Then: DISK2=target/deqp/deqp-vk-venus.ext4 GUEST_ENV=VK_DRIVER_FILES=/mnt/vdb/venus/virtio_icd.json \
#       node bench/gpu/deqp-run.ts vk target/deqp/guest-vk.qcow2 <out>   (bench/gpu/sway-mac.sh passes both on)
# Needs images/deqp/build.sh vk's disk, podman and e2fsprogs' debugfs; ~2 min.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
TAG=${1:-mesa-26.3.0-rc3}
W=$ROOT/target/deqp
DISK=$W/deqp-vk.ext4
OUT=$W/deqp-vk-venus.ext4
[ -f "$DISK" ] || { echo "venus-icd: $DISK is missing (images/deqp/build.sh vk)" >&2; exit 1; }
DEBUGFS=$(command -v debugfs || echo /usr/sbin/debugfs)
[ -x "$DEBUGFS" ] || { echo "venus-icd: no debugfs (e2fsprogs)" >&2; exit 1; }
"$ROOT/images/arch/base.sh"
TMP=$(mktemp -d "$W/venus-icd.XXXXXX")
trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/build.sh" <<EOF
set -euo pipefail
pacman -Syu --noconfirm --noprogressbar --needed base-devel git meson ninja python-mako python-packaging python-yaml \
  libdrm glslang > /tmp/pacman.log 2>&1 || { tail -20 /tmp/pacman.log; exit 1; }
git clone -q --depth 1 --branch $TAG https://gitlab.freedesktop.org/mesa/mesa.git /mesa
# Venus alone (no WSI platforms: dEQP-VK runs surfaceless), as vk/build.sh's native Mesa.
meson setup /build /mesa -Dbuildtype=release -Dprefix=/opt/venus -Dvulkan-drivers=virtio -Dgallium-drivers= \
  -Dplatforms= -Dglx=disabled -Degl=disabled -Dgbm=disabled -Dopengl=false -Dgles1=disabled -Dgles2=disabled \
  -Dllvm=disabled -Dvideo-codecs= -Dvulkan-layers= -Dtools= -Dbuild-tests=false > /tmp/meson.log 2>&1 || { tail -30 /tmp/meson.log; exit 1; }
ninja -C /build install > /tmp/ninja.log 2>&1 || { tail -30 /tmp/ninja.log; exit 1; }
cp /opt/venus/lib/libvulkan_virtio.so /out/
sed 's#"library_path": "[^"]*"#"library_path": "/mnt/vdb/venus/libvulkan_virtio.so"#' /opt/venus/share/vulkan/icd.d/virtio_icd.*.json > /out/virtio_icd.json
EOF
podman run --rm --security-opt label=disable -v "$TMP:/out" localhost/arch-base bash /out/build.sh
cp --reflink=auto "$DISK" "$OUT.part"
"$DEBUGFS" -w -R "mkdir venus" "$OUT.part" > /dev/null 2>&1
"$DEBUGFS" -w -f - "$OUT.part" > /dev/null 2>&1 <<EOF
cd venus
write $TMP/libvulkan_virtio.so libvulkan_virtio.so
write $TMP/virtio_icd.json virtio_icd.json
EOF
"$DEBUGFS" -R "ls -l venus" "$OUT.part" 2>/dev/null | grep -q libvulkan_virtio.so || { echo "venus-icd: the driver didn't reach the disk" >&2; exit 1; }
mv "$OUT.part" "$OUT"
echo "venus-icd: $OUT (Mesa $TAG's Venus in /venus)"
