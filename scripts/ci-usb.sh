#!/usr/bin/env bash
# The USB tests that need the dev VM's host rigs (docs/testing.md "USB", docs/testing.md "USB: the dev VM's host rigs"): WebUSB against
# dummy_hcd gadgets and WebHID against uhid devices, in the pinned Chromium, and the guest through them. Run it,
# besides scripts/ci.sh, when a change touches USB: the xHCI, its glue, the WebUSB and WebHID backends, the USB tab.
# Alone, in the background, as the other ci-*.sh. When a rig can't come up (no passwordless sudo, no kernel build
# tree, a cloud container, tests/usb/gadget.sh install not run) it says why and exits 0: "skipped: <why>".
# Lanes add their end-to-end tests to TESTS below; each test file also skips by itself without WEBPC_USB_TESTS=1 or
# its rig (tests/usb/rig.ts).
set -euo pipefail
cd "$(dirname "$0")/.."
step() { printf '\n== %s (at %d s)\n' "$*" "$SECONDS"; }
skipped() { printf '\nCI-USB skipped: %s\n' "$*"; exit 0; }

TESTS=(tests/usb-e2e-webusb.test.ts tests/usb-e2e-hid.test.ts tests/usb-guest.test.ts)
GADGETS=(zero acm)

why=$(tests/usb/gadget.sh check 2>&1) || skipped "${why//$'\n'/; }"
[ -c /dev/uhid ] || sudo -n modprobe uhid 2> /dev/null || true
[ -r /dev/uhid ] && [ -w /dev/uhid ] || skipped "/dev/uhid isn't usable by $(id -un) (tests/usb/gadget.sh install)"

step "gadgets up: ${GADGETS[*]}"
tests/usb/gadget.sh up "${GADGETS[@]}" || skipped 'the gadgets did not come up (tests/usb/gadget.sh up)'
trap 'tests/usb/gadget.sh down "${GADGETS[@]}" || true' EXIT

export WEBPC_USB_TESTS=1
step 'USB tests'
node --disable-warning=ExperimentalWarning --test --test-concurrency=1 "${TESTS[@]}" # one at a time: they share the gadgets and uhid devices
printf '\nCI-USB OK (%d s)\n' "$SECONDS"
