#!/usr/bin/env bash
# The tests that boot Debian on the page (docs/testing.md "Debian boots"): run it, besides
# scripts/ci.sh, when a change touches the page, the firmware or UEFI, the devices, disks or
# overlays, snapshots or the display (virtio-gpu and its presenter, the page's screen, the keys
# and the pointer on it, the guest's cursor, EDID); for guest-visible changes; and at the end of
# a milestone or a track. --platform adds what few changes reach (the built-in USB keyboard in the firmware, the game pad of ours, the clock
# catch-up through a snapshot or a suspend, clipboard sharing with a Wayland session and with an X11 one:
# images/debian-sway/build.sh, skipped without it): for changes to those, and at a track's end. ~5 min, ~7 with --platform: two Debian boots at a time (WAARM64_DEBIAN_SLOTS, tests/debian-lock.ts;
# nothing else runs beside them here), so the longest file, page-debian's, is the wall time. The network
# tests on Debian are scripts/ci-net.sh's, machines as the unit (stored machines, their disks and
# snapshots) scripts/ci-machines.sh's, graphics (3D or 2D, vkcube through Venus) scripts/ci-graphics.sh's. Needs the Debian image, the firmware and the wasm core
# (scripts/ci.sh builds it), and linux-snd's snd-play (page-debian plays sound through it).
set -euo pipefail
cd "$(dirname "$0")/.."
step() { printf '\n== %s (at %d s)\n' "$*" "$SECONDS"; }

for name in debian edk2 linux-snd agent; do images/build.sh --check "$name" > /dev/null || { echo "ci-debian: the $name image is missing or stale (images/build.sh $name)"; exit 1; }; done
platform=()
[ "${1:-}" = --platform ] && platform=(tests/page-usb-keyboard.test.ts tests/page-usb-gamepad.test.ts tests/page-clock.test.ts tests/page-clipboard.test.ts tests/page-clipboard-x11.test.ts)
export WAARM64_DISTROS=debian WAARM64_DEBIAN_SLOTS=${WAARM64_DEBIAN_SLOTS-2}
step 'Debian on the page'
node --disable-warning=ExperimentalWarning --test tests/page-debian.test.ts tests/page-disk.test.ts tests/start.test.ts tests/page-spill.test.ts tests/page-agent.test.ts "${platform[@]}"
printf '\nCI-DEBIAN OK (%d s)\n' "$SECONDS"
