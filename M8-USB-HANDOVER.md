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

**xhci lane (U1, U2): done** on `usb-xhci-lane` ([docs/usb.md](docs/usb.md) "The controller", "The backend
protocol", "Virtual devices", "The usb guest"):
- The controller: `core/src/xhci.rs`, the `generic-xhci` DT node at `0x0c00_0000` (INTID 80), `VmConfig.xhci`
  and `vm_xhci` (ABI 38). It is off by default, so no other guest's steps move. TD completions come at least
  125 µs after the doorbell unless the machine idles (`xhci::LATENCY_NS`: without it, usbtest's unlink test
  starved process context). Snapshots need its ports empty.
- The protocol and the glue: `web/usb.ts`, with the opener registry (`registerUsbOpener`). The device worker
  registers WebUSB's and WebHID's openers. bootVm's `usb: {port?, attach?, events?}` turns it on. Gadget Zero
  (`web/usb-gadget-zero.ts`) is built on `web/usb-virtual.ts`, with its native twin in
  `core/tests/common/usb.rs`.
- The test kernel is `images/build.sh linux-usb` (it boots on QEMU's `qemu-xhci` too). Its two runs, with
  steps in tests/steps.txt:
  - `usb-hubs` (23,701,201)
  - `usb` (143,567,602): `testusb -a` against a high-speed and a super-speed Gadget Zero, unplugged at 80M
    and replugged at 100M
  
  Both run natively, in Node and in Chromium (interpreter and JIT). Parallel SMP runs a clean pass, natively
  and in Node. A planted short-packet bug was caught by testusb and the unit tests.
- Left: IMOD moderation, isochronous devices (U6), the realtime Stop Endpoint window (docs/backlog.md "USB").
  The QEMU oracle comparison of event order is the gates lane's.
