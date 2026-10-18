# M8 USB: handover

The plan is [docs/plans/usb.md](docs/plans/usb.md); the user started it on 2026-10-18 ("drive it at least
through U4"; U5 needs their hardware, U6 their OK). This file carries the work between sessions.

## Lanes (2026-10-18)

The work runs in four lanes, each on its own branch off `worktree-usb`, merged back there:

| Lane | Steps | Owns |
|---|---|---|
| gates | U0 | the host test devices (dummy_hcd gadgets, the uhid rig), Chromium's WebUSB and WebHID in workers, the guest kernels' `xhci-plat-hcd`, the QEMU oracle, `bench/usb/REPORT.md` |
| xhci | U1, U2 | `core/src/xhci.rs`, the DT node, `VmConfig.xhci`, the ABI, snapshots, `web/usb.ts` (the glue), Gadget Zero and its native twin, the guest's `testusb` |
| backends | U3, U3h | `web/webusb.ts` (passthrough), `web/webhid.ts` and the report-descriptor encoder, their Node tests |
| page | U4 | `usb` in the record and the shape, remembered devices, the USB tab, the wizard, the toolbar menu, the device locks, Snapshot and Suspend emptying the ports |

The contract between them is `web/usb-device.ts`: the `UsbDevice` interface every device implements,
and the page ↔ device worker messages. Change it in one lane only with the others told.

## State

Nothing built yet.
