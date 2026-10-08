#!/usr/bin/env bash
# The tests that boot Debian on the page (docs/testing.md "Debian boots"): run it, besides
# scripts/ci.sh, when a change touches the page, the firmware or UEFI, the devices, disks or
# overlays, snapshots or the display (virtio-gpu and its presenter, the page's screen, the keys
# and the pointer on it, the guest's cursor, EDID); for guest-visible changes; and at the end of
# a milestone or a track. ~10 min: the Debian boots take turns (tests/debian-lock.ts), so their
# sum is the wall time. Their files' tests that boot no Debian run in ci.sh too. The network
# tests on Debian are scripts/ci-net.sh's. Needs the Debian image, the firmware and the wasm core
# (scripts/ci.sh builds it).
set -euo pipefail
cd "$(dirname "$0")/.."
step() { printf '\n== %s (at %d s)\n' "$*" "$SECONDS"; }

for name in debian edk2; do images/build.sh --check "$name" > /dev/null || { echo "ci-debian: the $name image is missing or stale (npm start, or images/build.sh $name)"; exit 1; }; done
export WEBPC_DISTROS=debian WEBPC_GFX_TESTS=1
step 'Debian on the page'
node --disable-warning=ExperimentalWarning --test tests/page-debian.test.ts tests/page-disk.test.ts tests/page-uefi-keys.test.ts tests/page-snapshot.test.ts tests/start.test.ts tests/page-resize.test.ts tests/page-grub-screen.test.ts tests/page-cursor.test.ts
printf '\nCI-DEBIAN OK (%d s)\n' "$SECONDS"
