#!/usr/bin/env bash
# The graphics tests on Debian (docs/testing.md): run it, besides scripts/ci.sh, when a change
# touches the display: virtio-gpu and its presenter, the page's screen (its size, the keys and the
# pointer on it, the guest's cursor), EDID; and at a milestone's end. The page's size reaching the
# guest, a key typed on the screen reaching GRUB, the guest's cursor as the canvas's. ~100 s: three
# Debian boots, one at a time. The graphics tests that boot no Debian (the gpu guest natively, in
# Node and in Chromium, the presenter, the display, EDID) stay in ci.sh. Needs the Debian image,
# the firmware and the wasm core (scripts/ci.sh builds it).
set -euo pipefail
cd "$(dirname "$0")/.."
step() { printf '\n== %s (at %d s)\n' "$*" "$SECONDS"; }

for name in debian edk2; do images/build.sh --check "$name" > /dev/null || { echo "ci-gfx: the $name image is missing or stale (npm start, or images/build.sh $name)"; exit 1; }; done
export WEBPC_DISTROS=debian WEBPC_GFX_TESTS=1
step 'graphics tests'
node --disable-warning=ExperimentalWarning --test tests/page-resize.test.ts tests/page-grub-screen.test.ts tests/page-cursor.test.ts
printf '\nCI-GFX OK (%d s)\n' "$SECONDS"
