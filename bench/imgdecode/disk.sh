#!/bin/bash
# The two disks of the image-decoding workload (README.md), on demand only (not images/build.sh or CI):
# - target/images/debian-browsers/disk.qcow2: the page's Debian with Chromium and Firefox ESR, a variant of
#   images/debian-chromium/build.sh (QEMU through our EDK2, apt from snapshot.debian.org; ~10 min, needs
#   `node tools/debian.ts` and images/build.sh edk2 first). Skipped when it exists.
# - target/imgdecode/disk2.img: an ext4 image of loop.html and gen.py's images (needs Python's Pillow).
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=target/images/debian-browsers
if [ ! -f "$OUT/disk.qcow2" ]; then
  DATE=20260924T000000Z
  SNAP=http://snapshot.debian.org/archive
  CMD="printf 'Types: deb\nURIs: $SNAP/debian/$DATE\nSuites: trixie trixie-updates\nComponents: main\nCheck-Valid-Until: no\n\nTypes: deb\nURIs: $SNAP/debian-security/$DATE\nSuites: trixie-security\nComponents: main\nCheck-Valid-Until: no\n' > /etc/apt/sources.list.d/debian.sources"
  CMD="$CMD; ip -br a; mkdir -p /tmp/apt/partial; export DEBIAN_FRONTEND=noninteractive"
  CMD="$CMD; apt-get -q update && apt-get -q -y -o Dir::Cache::archives=/tmp/apt install --no-install-recommends chromium firefox-esr fonts-dejavu-core"
  CMD="$CMD; echo ==chromium \$(chromium --version) \$(firefox-esr --version) \$(df -h / | tail -1); poweroff"
  node tools/uefi-oracle.ts --smp 4 --mem 4096 --timeout 2400 \
    --extra='-netdev user,id=n0 -device virtio-net-device,netdev=n0' --cmd "$CMD" debian || true
  LOG=target/uefi-oracle/debian.log
  grep -a '==chromium Chromium' "$LOG" || { echo "the browsers didn't install: $LOG"; exit 1; }
  mkdir -p "$OUT"
  qemu-img convert -c -O qcow2 target/uefi-oracle/debian/disk.qcow2 "$OUT/disk.qcow2.part"
  mv "$OUT/disk.qcow2.part" "$OUT/disk.qcow2"
fi
D=target/imgdecode
rm -rf "$D/files" && mkdir -p "$D/files"
python3 bench/imgdecode/gen.py "$D/files"
cp bench/imgdecode/loop.html "$D/files/"
rm -f "$D/disk2.img" && truncate -s 64M "$D/disk2.img"
mkfs.ext4 -q -L imgs -d "$D/files" "$D/disk2.img"
ls "$D/files" | wc -l
