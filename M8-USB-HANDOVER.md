# M8 USB: handover

The plan is [docs/plans/usb.md](docs/plans/usb.md); the user started it on 2026-10-18 ("drive it at least
through U4"; U5 needs their hardware, U6 their OK). How it works now is [docs/usb.md](docs/usb.md). This file
carries the work between sessions.

## State (2026-10-18)

**U0–U4 are done**, and U5 has begun with the user's devices.

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
- **U5 so far:** plans/usb.md "U5 findings": a NESDR (RTL-SDR) at its full 4.8 and 6.4 MB/s, an FT232R echoing
  at 3 Mbaud, a wired Xbox controller through `xpad`, on the Mac mini through Chrome for Testing
  (docs/testing.md "USB: real devices on the Mac").

## Next

- **U5, the rest of its list** (plans/usb.md §6), with the user's hardware: an Android phone, a CDC-ACM board with
  the host driver unbound, `dfu-util`, a sigrok analyser's re-enumeration, WebHID game pads (a DualSense, a
  Switch Pro), a Stream Deck, VIA. Also from the backends lane: whether `device.reset()` loses a real device,
  `receiveFeatureReport`'s framing on macOS and Windows, HID drivers that patch descriptors by their bytes.
- **U6** needs the user's OK: isochronous transfers, the USB keyboard for EDK2.
- Loose ends are in docs/backlog.md "USB".
