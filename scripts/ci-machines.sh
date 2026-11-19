#!/usr/bin/env bash
# Machines as the unit on the page, on Debian (docs/testing.md "Debian boots", docs/machines.md):
# a stored machine with five disks (blank, ramdisk, read-only, a swap ramdisk), a disk stored in the browser (import,
# overlay variants, merge, grown with the guest's agent growing its root, in place), kept snapshots (forks, the ramdisk, Suspend on pins, orphaned
# ones), a demo from the store's page to a prompt (the Alpine demo's template made from this build first: tools/build-demos.ts into target/ci-demos, its publish planned, a dry run), a disk's map live, USB (Gadget Zero attached from the menu, the ports emptied around a snapshot) and shared folders (docs/shares.md). Run it, besides scripts/ci.sh, when a change touches stored machines, their disks (stored,
# blank, ramdisk, overlays, serials), snapshots of them or the Home page (web/app/store.ts,
# machines.ts, disks.ts, snapshots.ts, web/overlay.ts, web/stored.ts, web/ramdisk.ts, web/snapshot.ts,
# the worker's device list); and at the end of a milestone or a track. ~4 min (the demo's template ~30 s first): three Debian boots at
# a time (WAARM64_DEBIAN_SLOTS, tests/debian-lock.ts, the longest chains first; nothing else runs beside them here);
# the tests that don't test a boot start from booted-Debian fixtures (tests/debian-fixture.ts `storedFixture`). Needs the Debian image, the firmware, the agent and the wasm core
# (scripts/ci.sh builds it).
set -euo pipefail
cd "$(dirname "$0")/.."
step() { printf '\n== %s (at %d s)\n' "$*" "$SECONDS"; }
source scripts/ci-lock.sh; ci_lock exclusive # alone on the machine (scripts/ci-lock.sh)

for name in debian edk2 agent alpine-demo; do images/build.sh --check "$name" > /dev/null || { echo "ci-machines: the $name image is missing or stale (images/build.sh $name)"; exit 1; }; done
export WAARM64_DISTROS=debian WAARM64_DEBIAN_SLOTS=${WAARM64_DEBIAN_SLOTS-3} WAARM64_DEMO_TESTS=1
# The demo's template from this build (~1 min; the image as built: images/build.sh alpine-demo is checked above), and
# the publish's checks on it (the core's format, the shape hash): what a deploy's rebuild does (docs/remote-disks.md).
step "The Alpine demo's template from this build"
rm -rf target/ci-demos && mkdir -p target/ci-demos
# The store's source with the Alpine demo alone: its publish is planned on its own (the desktops are made by hand,
# not by CI: docs/remote-disks.md "A desktop").
node -e 'const fs = require("fs"); const s = JSON.parse(fs.readFileSync("deploy/disks/demos.json", "utf8")); s.demos = s.demos.filter((d) => d.demo.id === "alpine-term"); fs.writeFileSync("target/ci-demos/demos.json", JSON.stringify(s))'
node --disable-warning=ExperimentalWarning tools/build-demos.ts target/ci-demos/demos.json --only alpine-term --out target/ci-demos --no-images --site target/ci-demos/.site
export WAARM64_DEMO_SITE=target/ci-demos
step 'Machines on the page (Debian)'
node --disable-warning=ExperimentalWarning --test tests/page-machines.test.ts tests/page-stored.test.ts tests/page-snapshots.test.ts tests/page-quota.test.ts tests/page-incognito.test.ts tests/page-usb-guest.test.ts tests/page-folders.test.ts tests/page-surface-debian.test.ts tests/page-demos-guest.test.ts
printf '\nCI-MACHINES OK (%d s)\n' "$SECONDS"
