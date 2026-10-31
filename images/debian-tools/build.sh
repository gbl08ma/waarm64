#!/bin/bash
# The page's Debian with a compiler and git: a shared folder's real workload (tests/page-folders.test.ts). On demand
# only (not images/build.sh, SHA256SUMS or CI), as images/debian-chromium/build.sh, whose way it follows (QEMU through our
# EDK2, TCG, ~5 min): target/images/debian-tools/disk.qcow2.
set -euo pipefail
cd "$(dirname "$0")/../.."
DATE=20260924T000000Z
OUT=target/images/debian-tools
SNAP=http://snapshot.debian.org/archive
CMD="printf 'Types: deb\nURIs: $SNAP/debian/$DATE\nSuites: trixie trixie-updates\nComponents: main\nCheck-Valid-Until: no\n\nTypes: deb\nURIs: $SNAP/debian-security/$DATE\nSuites: trixie-security\nComponents: main\nCheck-Valid-Until: no\n' > /etc/apt/sources.list.d/debian.sources"
CMD="$CMD; ip -br a; mkdir -p /tmp/apt/partial; export DEBIAN_FRONTEND=noninteractive"
CMD="$CMD; apt-get -q update && apt-get -q -y -o Dir::Cache::archives=/tmp/apt install --no-install-recommends gcc libc6-dev make git"
CMD="$CMD; echo ==tools \$(gcc --version | head -1) \$(git --version); poweroff"
node tools/uefi-oracle.ts --smp 4 --mem 4096 --timeout 1500 \
  --extra='-netdev user,id=n0 -device virtio-net-device,netdev=n0' --cmd "$CMD" debian || true
LOG=target/uefi-oracle/debian.log
grep -a '==tools gcc' "$LOG" || { echo "the tools didn't install: $LOG"; exit 1; }
mkdir -p "$OUT"
qemu-img convert -c -O qcow2 target/uefi-oracle/debian/disk.qcow2 "$OUT/disk.qcow2.part"
mv "$OUT/disk.qcow2.part" "$OUT/disk.qcow2"
qemu-img info "$OUT/disk.qcow2" | grep -E 'virtual|disk size'
