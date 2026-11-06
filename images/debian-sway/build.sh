#!/bin/bash
# The tests' Debian with a Wayland session for clipboard sharing (tests/page-clipboard.test.ts; docs/images.md "Debian
# with sway"): the pinned Debian (images/debian.json, `node tools/debian.ts` first) booted in QEMU through our EDK2 (the
# UEFI oracle, TCG) with user-mode networking, apt pointed at snapshot.debian.org (the date images/Containerfile pins),
# sway, wl-clipboard and grim installed without recommends, and images/debian-sway/setup.sh run: the user `user` logged in on
# tty1 at boot, whose login shell starts a headless sway. The overlay flattened and compressed:
# target/images/debian-sway/disk.qcow2 (~6 min). On demand, as debian-tools: not images/build.sh, SHA256SUMS or CI.
set -euo pipefail
cd "$(dirname "$0")/../.."
DATE=20260924T000000Z
OUT=target/images/debian-sway
SNAP=http://snapshot.debian.org/archive
CMD="printf 'Types: deb\nURIs: $SNAP/debian/$DATE\nSuites: trixie trixie-updates\nComponents: main\nCheck-Valid-Until: no\n\nTypes: deb\nURIs: $SNAP/debian-security/$DATE\nSuites: trixie-security\nComponents: main\nCheck-Valid-Until: no\n' > /etc/apt/sources.list.d/debian.sources"
CMD="$CMD; ip -br a; mkdir -p /tmp/apt/partial; export DEBIAN_FRONTEND=noninteractive"
CMD="$CMD; apt-get -q -o Acquire::Retries=10 update && apt-get -q -y -o Acquire::Retries=10 -o Dir::Cache::archives=/tmp/apt install --no-install-recommends sway wl-clipboard grim"
# The setup script, gzipped, in base64 on the command line (the serial console's line holds 4 KiB).
CMD="$CMD && echo $(gzip -9c images/debian-sway/setup.sh | base64 -w0) | base64 -d | gzip -dc | sh; poweroff"
node tools/uefi-oracle.ts --smp 4 --mem 4096 --timeout 1500 \
  --extra='-netdev user,id=n0 -device virtio-net-device,netdev=n0' --cmd "$CMD" debian || true
LOG=target/uefi-oracle/debian.log
grep -a '==sway sway version' "$LOG" || { echo "sway didn't install: $LOG"; exit 1; }
mkdir -p "$OUT"
qemu-img convert -c -O qcow2 target/uefi-oracle/debian/disk.qcow2 "$OUT/disk.qcow2.part"
mv "$OUT/disk.qcow2.part" "$OUT/disk.qcow2"
qemu-img info "$OUT/disk.qcow2" | grep -E 'virtual|disk size'
