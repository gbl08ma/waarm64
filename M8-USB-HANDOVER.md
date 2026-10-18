# M8 USB: handover

The plan is [docs/plans/usb.md](docs/plans/usb.md); the user started it on 2026-10-18 ("drive it at least
through U4"; U5 needs their hardware, U6 their OK). How it works now is [docs/usb.md](docs/usb.md). This file
carries the work between sessions.

## State (2026-10-18)

**U0–U5 are done** (U5 closed with the devices the user has).

- **U0, the gates:** plans/usb.md "U0 findings". The dev VM's host rigs (dummy_hcd gadgets, uhid) are
  `tests/usb/gadget.sh`; Chromium's managed policy grants the test origins; the QEMU oracle is
  `tests/usb/oracle.sh`; the WebUSB sizing is `bench/usb/REPORT.md`.
- **U1 and U2, the controller and Gadget Zero:** `core/src/xhci.rs` (DT node at `0x0c00_0000`, INTID 80, off unless
  `VmConfig.xhci`; ABI 38), the glue `web/usb.ts`, Gadget Zero with its native twin. The `usb-hubs` and `usb`
  guests (`images/build.sh linux-usb`) take exact steps in every runner, hot-plug included. A read-only review's
  eleven guest-triggerable findings are fixed, each with a test (`core/src/xhci/review.rs`).
- **U3 and U3h, the backends:** the WebUSB passthrough (`web/webusb.ts`) and the WebHID device
  (`web/webhid.ts`, `web/hid-descriptor.ts`), round-tripped against Chromium's recorded parses. Through the rigs
  (`scripts/ci-usb.sh`, image `linux-usbhost`): the guest's `testusb -a` on the dummy_hcd Gadget Zero, `cdc_acm`
  on the ACM gadget, a uhid device through WebHID.
- **U4, the page:** `usb` in the record and the shape (off machines keep their hash), remembered devices, the USB
  tab, the wizard, the toolbar menu, device locks, Snapshot and Suspend emptying the ports, the problems with
  their remedies.
- **U5:** plans/usb.md "U5 findings": a NESDR (RTL-SDR) at its full 4.8 and 6.4 MB/s, an FT232R echoing
  at 3 Mbaud, a wired Xbox controller through `xpad`, on the Mac mini through Chrome for Testing
  (docs/testing.md "USB: real devices on the Mac").

- **U6, the firmware's keyboard** (the user's OK, 2026-10-18; isochronous transfers skipped): a HID boot keyboard
  of ours (`web/usb-keyboard.ts`) on the last connector, fed by the page's keys (`usb-key`); EDK2's USB stack on
  the DT's xHCI through `images/edk2/WebpcXhciDxe` (ours) and NonDiscoverablePciDeviceDxe; the page plugs it in
  until the guest's virtio keyboard is live (docs/usb.md "The keyboard"). The firmware changed, so `edk2-shell`
  and `edk2-shell-again` moved once. `tests/page-usb-keyboard.test.ts` (ci-debian) drives GRUB with it.

## Next
- U5's untried devices and the open questions it left are in backlog.md "USB".
- Loose ends are in docs/backlog.md "USB".
