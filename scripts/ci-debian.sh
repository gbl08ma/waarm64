#!/usr/bin/env bash
# The tests that boot Debian on the page (docs/testing.md "Debian boots"): run it, besides
# scripts/ci.sh, when a change touches the page, the firmware or UEFI, the devices, disks or
# overlays, snapshots or the display (virtio-gpu and its presenter, the page's screen, the keys
# and the pointer on it, the guest's cursor, EDID); for guest-visible changes; and at the end of
# a milestone or a track (page-clock: the clock catch-up through snapshots). ~3.5 min: two Debian boots at a time (WEBPC_DEBIAN_SLOTS, tests/debian-lock.ts;
# nothing else runs beside them here), so the longest file, page-debian's, is the wall time. The network
# tests on Debian are scripts/ci-net.sh's, machines as the unit (stored machines, their disks and
# snapshots) scripts/ci-machines.sh's. Needs the Debian image, the firmware and the wasm core
# (scripts/ci.sh builds it), and linux-snd's snd-play (page-debian plays sound through it).
set -euo pipefail
cd "$(dirname "$0")/.."
step() { printf '\n== %s (at %d s)\n' "$*" "$SECONDS"; }

for name in debian edk2 linux-snd; do images/build.sh --check "$name" > /dev/null || { echo "ci-debian: the $name image is missing or stale (images/build.sh $name)"; exit 1; }; done
export WEBPC_DISTROS=debian WEBPC_DEBIAN_SLOTS=${WEBPC_DEBIAN_SLOTS-2}
step 'Debian on the page'
node --disable-warning=ExperimentalWarning --test tests/page-debian.test.ts tests/page-disk.test.ts tests/start.test.ts tests/page-machine.test.ts tests/page-usb-keyboard.test.ts tests/page-spill.test.ts tests/page-venus.test.ts tests/page-clock.test.ts
printf '\nCI-DEBIAN OK (%d s)\n' "$SECONDS"
