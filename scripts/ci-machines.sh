#!/usr/bin/env bash
# Machines as the unit on the page, on Debian (docs/testing.md "Debian boots", docs/machines.md):
# a stored machine with four disks (blank, ramdisk, read-only), a disk stored in the browser (import,
# overlay variants, merge, in place), kept snapshots (forks, the ramdisk, Suspend on pins, orphaned
# ones), USB (Gadget Zero attached from the menu, the ports emptied around a snapshot) and shared folders (docs/shares.md). Run it, besides scripts/ci.sh, when a change touches stored machines, their disks (stored,
# blank, ramdisk, overlays, serials), snapshots of them or the Machines page (web/app/store.ts,
# machines.ts, disks.ts, snapshots.ts, web/overlay.ts, web/stored.ts, web/ramdisk.ts, web/snapshot.ts,
# the worker's device list); and at the end of a milestone or a track. ~3.5 min: three Debian boots at
# a time (WEBPC_DEBIAN_SLOTS, tests/debian-lock.ts; nothing else runs beside them here), so the stored
# disk's two steps, one file, are the wall time. Needs the Debian image, the firmware and the wasm core
# (scripts/ci.sh builds it).
set -euo pipefail
cd "$(dirname "$0")/.."
step() { printf '\n== %s (at %d s)\n' "$*" "$SECONDS"; }

for name in debian edk2; do images/build.sh --check "$name" > /dev/null || { echo "ci-machines: the $name image is missing or stale (images/build.sh $name)"; exit 1; }; done
export WEBPC_DISTROS=debian WEBPC_DEBIAN_SLOTS=${WEBPC_DEBIAN_SLOTS-3}
step 'Machines on the page (Debian)'
node --disable-warning=ExperimentalWarning --test tests/page-machines.test.ts tests/page-stored.test.ts tests/page-snapshots.test.ts tests/page-quota.test.ts tests/page-incognito.test.ts tests/page-usb-guest.test.ts tests/page-folders.test.ts
printf '\nCI-MACHINES OK (%d s)\n' "$SECONDS"
