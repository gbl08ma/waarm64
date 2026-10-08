#!/bin/bash
# The page's Debian with Chromium installed: the guest workload of the "complex app" benchmark
# (bench/apps/). On demand only (not images/build.sh, SHA256SUMS or CI). Boots the pinned
# Debian (images/debian.json, `node tools/debian.ts` first) in QEMU through our EDK2 (the UEFI
# oracle, TCG) with user-mode networking, points apt at snapshot.debian.org (the date
# images/Containerfile pins), installs `chromium` (no recommends) and a font, and writes the
# overlay flattened and compressed to target/images/debian-chromium/disk.qcow2 (~10 min).
set -euo pipefail
cd "$(dirname "$0")/../.."
DATE=20260924T000000Z
OUT=target/images/debian-chromium
SNAP=http://snapshot.debian.org/archive
CMD="printf 'Types: deb\nURIs: $SNAP/debian/$DATE\nSuites: trixie trixie-updates\nComponents: main\nCheck-Valid-Until: no\n\nTypes: deb\nURIs: $SNAP/debian-security/$DATE\nSuites: trixie-security\nComponents: main\nCheck-Valid-Until: no\n' > /etc/apt/sources.list.d/debian.sources"
CMD="$CMD; ip -br a; mkdir -p /tmp/apt/partial; export DEBIAN_FRONTEND=noninteractive"
CMD="$CMD; apt-get -q update && apt-get -q -y -o Dir::Cache::archives=/tmp/apt install --no-install-recommends chromium fonts-dejavu-core"
CMD="$CMD; echo ==chromium \$(chromium --version) \$(df -h / | tail -1); poweroff"
node tools/uefi-oracle.ts --smp 4 --mem 4096 --timeout 2400 \
  --extra='-netdev user,id=n0 -device virtio-net-device,netdev=n0' --cmd "$CMD" debian || true
LOG=target/uefi-oracle/debian.log
grep -a '==chromium Chromium' "$LOG" || { echo "chromium didn't install: $LOG"; exit 1; }
mkdir -p "$OUT"
qemu-img convert -c -O qcow2 target/uefi-oracle/debian/disk.qcow2 "$OUT/disk.qcow2.part"
mv "$OUT/disk.qcow2.part" "$OUT/disk.qcow2"
qemu-img info "$OUT/disk.qcow2" | grep -E 'virtual|disk size'
