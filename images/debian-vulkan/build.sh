#!/bin/bash
# The tests' Debian with Vulkan through Venus (VK1, docs/devices.md "Venus"): the pinned Debian (images/debian.json,
# `node tools/debian.ts` first) booted in QEMU through our EDK2 (the UEFI oracle, TCG) with user-mode networking, apt
# pointed at snapshot.debian.org (the date images/Containerfile pins), Mesa's Vulkan drivers (Venus's ICD among them),
# vulkan-tools (vulkaninfo, vkcube), sway (a headless compositor for vkcube's window) and grim (its screenshots), Xwayland (X11 clients: their WSI takes the prime blit) and x11-utils (xdpyinfo) and python3 (tests/venus/vkmap.py: host-visible memory mapped at once, GD G8) installed
# without recommends, and the overlay written flattened and compressed to target/images/debian-vulkan/disk.qcow2
# (~10 min). On demand, as debian-chromium: not images/build.sh, SHA256SUMS or CI's builds.
set -euo pipefail
cd "$(dirname "$0")/../.."
DATE=20260924T000000Z
OUT=target/images/debian-vulkan
SNAP=http://snapshot.debian.org/archive
CMD="printf 'Types: deb\nURIs: $SNAP/debian/$DATE\nSuites: trixie trixie-updates\nComponents: main\nCheck-Valid-Until: no\n\nTypes: deb\nURIs: $SNAP/debian-security/$DATE\nSuites: trixie-security\nComponents: main\nCheck-Valid-Until: no\n' > /etc/apt/sources.list.d/debian.sources"
CMD="$CMD; ip -br a; mkdir -p /tmp/apt/partial; export DEBIAN_FRONTEND=noninteractive"
# Two installs: all at once, apt-get grew past the guest's 4 GiB at "Preconfiguring packages" and the OOM killer took it.
APT="apt-get -q -y -o Acquire::Retries=10 -o Dir::Cache::archives=/tmp/apt install --no-install-recommends"
CMD="$CMD; apt-get -q -o Acquire::Retries=10 update && $APT mesa-vulkan-drivers vulkan-tools sway grim && $APT xwayland x11-utils python3"
CMD="$CMD; echo ==vulkan \$(ls /usr/share/vulkan/icd.d/) \$(dpkg-query -W -f='\${Version}' mesa-vulkan-drivers) \$(df -h / | tail -1) \$(command -v Xwayland python3); poweroff"
node tools/uefi-oracle.ts --smp 4 --mem 6144 --timeout 2400 \
  --extra='-netdev user,id=n0 -device virtio-net-device,netdev=n0' --cmd "$CMD" debian || true
LOG=target/uefi-oracle/debian.log
grep -a '==vulkan .*virtio_icd' "$LOG" || { echo "the Vulkan drivers didn't install: $LOG"; exit 1; }
grep -a '==vulkan .*Xwayland.*python3' "$LOG" || { echo "Xwayland or python3 didn't install: $LOG"; exit 1; }
mkdir -p "$OUT"
qemu-img convert -c -O qcow2 target/uefi-oracle/debian/disk.qcow2 "$OUT/disk.qcow2.part"
mv "$OUT/disk.qcow2.part" "$OUT/disk.qcow2"
qemu-img info "$OUT/disk.qcow2" | grep -E 'virtual|disk size'
