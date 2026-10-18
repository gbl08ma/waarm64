# USB

USB devices from the user's computer reach the guest through an emulated xHCI. The controller is the core's
(`core/src/xhci.rs`). Its devices are backends in the device worker, behind the glue in `web/usb.ts`: a WebUSB
passthrough, an emulated HID device rebuilt from what WebHID gives, and virtual devices of ours (Gadget Zero for
the tests, the built-in keyboard). The device interface every backend implements is `UsbDevice` in
`web/usb-device.ts`, and the page's messages about the root connectors are defined there too. Built 2026-10-18
(the plan, U0–U6, is in git history: `docs/plans/usb.md`); loose ends are in [backlog.md](backlog.md) "USB".

## What the browser allows

**WebUSB** (WICG spec, Chromium 153):
- **Protected interface classes can't be claimed:** audio (0x01), HID (0x03), mass storage (0x08), hub (0x09), smart
  card (0x0B), video (0x0E), audio/video (0x10), wireless controller (0xE0: Bluetooth dongles); Chromium's blocklist
  adds devices such as security keys. The class is per interface, so vendor-specific (0xFF), CDC (0x02/0x0A),
  printer (0x07), still image/MTP (0x06), DFU (0xFE) and test-and-measurement interfaces are open: phones (adb,
  fastboot), boards and debug probes (CDC-ACM, DFU, CMSIS-DAP v2, ST-Link, J-Link), serial adapters (FTDI, CP210x,
  CH34x), logic analysers and SDRs, printers, FPGA boards, libusb devices in general. A composite device that is
  partly protected is served with those interfaces left out ("The WebUSB passthrough").
- **The host's drivers come first.** On Linux Chromium doesn't detach a kernel driver (`AutomaticUsbDetach` is off):
  an interface `cdc_acm`, `ftdi_sio`, `cp210x` or `usblp` holds fails to claim until it is unbound or a udev rule
  keeps the driver off, and without permission on `/dev/bus/usb` no device is listed at all. On Windows a device
  needs WinUSB (Zadig). On macOS Chrome took the FT232R from Apple's `AppleUSBFTDI` without help ("Findings").
  The page says which interface failed, with the remedy for the user's OS.
- **Standard OUT requests are refused** on endpoint 0 (SET_ADDRESS, SET_CONFIGURATION, SET_INTERFACE,
  SET/CLEAR_FEATURE, SET_SEL, SET_ISOCH_DELAY), and so are SET_FEATURE(ENDPOINT_HALT) and GET_STATUS and
  CLEAR_FEATURE on endpoint 0. `selectConfiguration`, `selectAlternateInterface` and `clearHalt` replace some; the
  passthrough interprets the rest itself.
- **No single transfer can be cancelled** (only in bulk, by `close`, `reset` or a configuration change), so a
  cancelled IN's data is carried over to the next read. **The device's speed isn't exposed**, so it is inferred from
  the descriptors. **No bulk streams, LPM, suspend or remote wakeup.** **Isochronous transfers exist**, but the
  classes that use them most are protected; they aren't implemented (the user, 2026-10-18).
- **A device that re-enumerates as something else** (DFU detach, a firmware loader, adb ↔ fastboot) is a new device
  without permission: the page offers it from `connect`, and the grant persists per origin after that.
- **Workers:** `navigator.usb` exists in dedicated workers (`requestDevice` is Window-only), so the page asks and the
  device worker opens the device by its identity. `getDevices()` order, which tells identical serial-less devices
  apart, holds within a browser session only. Only Chromium has WebUSB; it works under COOP/COEP (an embedding
  iframe needs `allow="usb"`).

**WebHID:**
- **A HID device, not a USB one:** `HIDDevice` has the vendor and product IDs, the product name and `collections`, the
  report descriptor already parsed; the raw descriptor, the USB descriptors, the serial number and the polling
  interval aren't exposed. So the device is rebuilt, not passed through ("The WebHID device"). Drivers that read
  reports by ID and offset work; the few that patch the original descriptor by its bytes (`report_fixup`) see ours.
- **Protected usages are hidden:** the Keyboard page, Generic Desktop keyboard, keypad, mouse and pointer
  collections (their feature reports stay open: VIA works) and System Control; FIDO keys are blocklisted. A
  keyboard's vendor collection reaches the guest without its keyboard. Keyboards and mice themselves stay virtio-input.
- **The host keeps its driver** (hidraw, IOHIDManager, the Windows HID driver): nothing is unbound, and on Linux the
  user needs access to `/dev/hidraw*`. `navigator.hid` works in dedicated workers too.
- **Out of its reach:** devices whose only collections are protected, and game pads that aren't HID on the host
  (wired Xbox controllers are vendor-class: WebUSB's, and `xpad` drives them: "Findings").

## Why an xHCI, and on the DT

- **xHCI** covers every speed with one controller, and is what Linux and EDK2 expect. EHCI with companion OHCI/UHCI
  controllers needs two controllers, has no USB 3 and an older, quirkier interface.
- **On the DT, not PCI:** Linux's `xhci-plat-hcd` binds `generic-xhci` with one MMIO window and one interrupt, and
  distribution kernels for arm64 boards build it (Alpine's `linux-virt` doesn't: "Findings"). PCI would need an ECAM
  host bridge first, worth having only for its own reasons ([firmware.md](firmware.md) "DT or ACPI"); the register
  block is bus-agnostic, so a PCI wrapper could reuse it. EDK2 takes it as a non-discoverable device ("The keyboard").
- **Not USB/IP:** every guest would need `vhci-hcd`, the tool and a command run inside it, and a TCP endpoint the
  Ethernet gateway doesn't have. **Not a virtual-HCI driver of ours:** a module per guest kernel, so not unmodified
  images. Upstream Linux has no virtio-usb.

## What WebUSB can't attach, and where it goes instead

| Device | Route |
|---|---|
| Keyboards, mice, tablets | the page's input, as virtio-input (and the built-in USB keyboard in the firmware) |
| Game pads and other HID | WebHID → the emulated HID device |
| Game pads that aren't HID and that the host holds | the Gamepad API → an emulated USB HID game pad with a fixed descriptor of ours (not built: backlog) |
| Flash drives, disks | the page's disks; a raw USB disk is out of reach in a browser |
| Webcams, microphones, headsets | `getUserMedia` (the page already records through virtio-snd); a camera would be an emulated UVC device or virtio-video |
| Serial adapters the host's driver holds | WebSerial → a virtio-console port (not built: backlog) |
| Bluetooth adapters | none (Web Bluetooth is GATT-level only) |

## Findings

**Before building (2026-10-18; Chromium 153.0.8010.52, kernel 7.2.9, QEMU 11.1.2).** The rigs are in
[testing.md](testing.md) "USB: the dev VM's host rigs".
- **Permission without a prompt** comes only from Chromium's managed policy (exact origins). DevTools'
  `DeviceAccess.deviceRequestPrompted` never fires for WebUSB or WebHID, and headless `requestDevice` just waits.
- **WebUSB's cost** (Gadget Zero on dummy_hcd, from a worker; a sizing, `bench/usb/REPORT.md`): ~0.13 ms per
  transfer over usbfs's 0.20 ms (dummy_hcd's own floor), so a driver that waits on each transfer gets ~3,000 a
  second; 1 MiB bulk transfers ~180 MB/s. More transfers in flight were slower on dummy_hcd (cause not separated).
  usbfs caps buffered transfers at 16 MiB (`usbcore.usbfs_memory_mb`) for every device Chromium has open.
- **Guest kernels:** Debian 13 has `xhci-plat-hcd` as a module (autoloaded) and the rest as modules; Arch builds it
  in; **Alpine's `linux-virt` lacks it** (only `xhci-pci`), so Alpine needs `linux-lts` or `linux-stable` for USB.
- **The QEMU oracle** (`tests/usb/oracle.sh`: `qemu-xhci` with `usb-host` on the dummy_hcd Gadget Zero): every
  testusb test passes or is skipped except 24 (unlink from queues), which hangs on QEMU every time, with events for
  TRBs outside any TD. Ours passes 24, natively and through WebUSB.
- **WebHID's parse** (`tests/usb/hid-fixtures/`): Chromium lists each item in its collection and every collection
  around it, reports not in descriptor order (stable from run to run), usages 32-bit. On a keyboard composite the
  Keyboard collection keeps only its feature report, System Control goes, Mouse stays empty though its Pointer child
  lists its input report (which never arrives). `inputreport` data has no ID byte, `receiveFeatureReport`'s starts
  with the ID when the device uses IDs (recorded on Linux).

**Real devices (2026-10-18; the user's, on the Mac mini, macOS 26.6.2, Chrome for Testing 153 driven from the dev
VM; the recipe is in [testing.md](testing.md) "USB: real devices on the Mac"; guest Debian 13):**
- **A Nooelec NESDR SMArt v5** (RTL2832U, high speed): `dvb_usb_rtl28xxu` and `rtl2832_sdr` initialise it whole;
  bulk IN through `/dev/swradio0` at **4.80 MB/s at 2.4 MS/s and 6.40 MB/s at 3.2 MS/s** (the chip's highest), the
  device's whole rate, with no loss; a stream's start costs ~1.6 s (the tuner's setup in many control transfers).
  Unplugged and plugged back while the guest ran, it came back on the same connector.
- **An FTDI FT232R** (full speed): Chrome claims it although macOS's `AppleUSBFTDI` holds it; `ftdi_sio` attaches,
  and with TX wired to RX data comes back whole at 115200, 1M and 3M baud, at 96–97% of the line rate.
- **A PowerA wired Xbox Series X controller** (`20d6:2001`, full speed, GIP): its audio interface's 228-byte
  isochronous endpoints made the speed heuristic say high speed (fixed: only what full speed can't do counts).
  `xpad` binds it, every input reaches the guest, and its init packet proves interrupt OUT.
- **Chrome for Testing on macOS** reads its policies from `com.google.ChromeForTesting`, not its bundle ID, and
  listed none of the policy's devices in a reused profile.
- **A reset with interfaces claimed** leaves Chromium's claims stale on Linux (reported claimed; release and claim
  fail until close), and WebUSB's `NotFoundError` also means "not a claimed endpoint": the passthrough releases
  before `device.reset()` and takes only "The device was disconnected." as an unplug.

## The controller (`core/src/xhci.rs`)

**Where:** a DT node `usb@c000000`, `compatible = "generic-xhci"`: 64 KiB at `0x0c00_0000` (QEMU `virt`'s
platform-bus window), INTID 80 (SPI 48, the first after the virtio window) level-high, `dma-coherent`.
Linux's `xhci-plat-hcd` binds it. The controller exists only when `VmConfig.xhci` is set (ABI 38). The
value is the USB 2 ports | the USB 3 ports << 8, and only `xhci::CONFIG` (4 and 4) is built, so every
other machine's DT, guests and step counts stay as they were. It sits under `Vm::plat`, as the virtio
transports do.

**What the guest sees:**
- An xHCI 1.0 controller (HCIVERSION 0x100):
  - 32 slots, one interrupter, 8 root ports
  - 32-byte contexts and 64-bit addressing
  - an event ring segment table of up to 16 entries
  - no scratchpad buffers, streams, LPM, port power control, MSI or debug capability
- Two Supported Protocol capabilities: USB 2.0 on ports 1–4 and USB 3.0 on ports 5–8. Connector *c*
  (0–3, the contract's number) is port *c* + 1 and port *c* + 5. A device goes on one of them by its
  speed: `super` on the USB 3 port, anything else on the USB 2 port. One device per connector.
- Registers, as the specification has them:
  - capability, operational (USBCMD with HCRST, R/S and INTE; USBSTS; CRCR with its stop and abort;
    DCBAAP; CONFIG)
  - the port registers
  - runtime (MFINDEX; IMAN, IMOD, ERSTSZ, ERSTBA, ERDP)
  - the doorbells

  64-bit registers are written low half first, as Linux does (the high half's write takes the pair).
  Reads of 1, 2, 4 and 8 bytes work; writes of 4 and 8. Other sizes and unaligned accesses are external
  aborts.
- **MFINDEX** counts 125 µs microframes of machine time: the clock in realtime mode, the counter in
  deterministic mode.
- **IMOD** is a register, and interrupts aren't moderated.
- **The interrupter** sets IMAN.IP (with EHB) when an event that interrupts is written. The line is
  IP && IE && USBCMD.INTE. When the guest moves ERDP and clears EHB with events still unread, IP is set
  again. Events that don't fit the ring wait inside the controller and are written as ERDP moves, so
  none is lost. Events don't go into the ring while the controller is halted. Meanwhile the command
  ring waits (it goes on when the guest makes room, or starts the event ring or the controller), and
  so does an endpoint's walk once 256 events wait. Past 4096 waiting events (`xhci::MAX_PENDING`: a
  guest that never reads them) the controller sets USBSTS.HSE and drops them.
- **Commands:** Enable and Disable Slot, Address Device (with BSR), Configure Endpoint (with Deconfigure,
  drop and add flags), Evaluate Context (the slot's exit latency and interrupter, EP0's packet size),
  Reset Endpoint (a halted endpoint is stopped), Stop Endpoint, Set TR Dequeue Pointer, Reset Device
  and No-Op. Anything else is a TRB Error. Configure Endpoint takes its change whole or not at all
  (a context it can't take is a Parameter Error before any endpoint changes). Wrong states give Context State Error (Linux reads the output
  context to recover). Slots and endpoints that aren't enabled give Slot or Endpoint Not Enabled. The
  controller keeps the output device context current: slot state and address, each endpoint's state,
  and its dequeue pointer when it stops or halts.
- **Transfer rings:**
  - TRB types: Normal, Setup/Data/Status (a control transfer runs from its Setup TRB to its Status TRB),
    Isoch, Link (Toggle Cycle), Event Data and No-Op. A TD is its TRBs up to the one without Chain.
  - A TRB whose cycle bit isn't the ring's yet ends the walk until the next doorbell. Linux writes a TD's
    first TRB last.
  - Immediate data (IDT) goes into the request record. It is a TD of one TRB, OUT, at most 8 bytes;
    anything else with IDT is a TRB Error.
  - A walk reads at most 256 TDs (`WALK_TDS`) and the endpoint goes on at the next chunk boundary: a
    ring of No-Ops linked to itself is a TD for ever. So does one that found 1024 TDs in flight
    (`MAX_TDS`), once some leave.
  - A control TD's Data and Status stages follow its Setup stage; without one it is a TRB Error (a
    device never gets a control transfer without a setup packet).
  - Anything wrong is a TRB Error event, and the endpoint halts: a TRB out of RAM, a type that doesn't
    belong (a Setup TRB on a bulk ring), a TD of 1024 TRBs or more, a record too big for the request ring, a buffer outside RAM, immediate data on
    an IN TRB. A zero-length TRB may point anywhere (Linux's zero-length packet points at 0).
  - A TD of No-Ops and Event Data completes in the core.
  - A TD's dequeue position is its first TRB, past the Link TRBs before it. Linux finds the new dequeue
    state after a halt by walking from it.
- **Completions to events:**
  - A TD's bytes fill its data TRBs in order.
  - The TRB where the data ran out gets the Short Packet event, with the residual, when it has ISP or
    IOC. Without either, the TD's last IOC TRB reports it. The data TRBs after it are skipped.
  - A control transfer's Status stage reports Success after a short Data stage.
  - IOC TRBs get Success.
  - An error (Stall, Babble, USB Transaction Error) is reported on the TRB where the data stopped: the
    Data stage of a control transfer, or the Status stage when there is none. The endpoint halts with
    its dequeue pointer on that TD. The TDs after it leave the backend (a cancel record) and are posted
    again once the guest has moved the dequeue pointer and rung the doorbell.
  - On an isochronous endpoint an error is reported and the endpoint goes on: isochronous transfers
    don't halt.
  - Event Data TRBs report their parameter, with the bytes since the last one.
  - BEI suppresses the interrupt.
- **Stop Endpoint:**
  1. What the backend finished is taken first, so no completed TD is cancelled. If that halted the
     endpoint (a stall that waited for its latency), the command is a Context State Error and the
     endpoint stays halted, as Linux's Reset Endpoint expects.
  2. The oldest TD still in flight gets a Stopped event on its first TRB.
  3. The TDs in flight leave the backend (a cancel record). Their late completions find no TD and are
     dropped.
  4. The dequeue pointer goes back to the oldest of them.

  The guest moves the dequeue pointer past what it cancelled. Its next doorbell posts the rest again,
  with new tags.
- **Root ports:**
  - A USB 3 port goes straight to U0, enabled, on connect.
  - A USB 2 port connects in Polling and is enabled (U0) by the driver's port reset.
  - Resets complete at once with PRC (WRC too for a warm reset).
  - **The first reset after an attach stays in the core:** the device was just opened. Every later one
    is a `reset` record to the backend.
  - Suspend is a port state only: U3. Resume (U0 from U3, or USB 2's Resume then U0) completes at once
    with PLC. The device never suspends.
  - Every change bit that goes to 1 (CSC, PEC, WRC, PRC, PLC…) raises a Port Status Change event and
    USBSTS.PCD. Changes that come while the controller is halted are reported when it runs.
  - HCRST keeps the devices: their ports connect again, without counting as a new attach.
- **Hot-plug:** an attach or detach from the host is a connect status change. On a detach, the TDs in
  flight on the port complete with USB Transaction Error, its records leave the outbox, and the
  connector's generation moves on (`Records` below). TDs rung afterwards fail at once until the guest
  disables the slot.

### Latency

A TD's events are written no sooner than `xhci::LATENCY_NS` (125 µs, a microframe) after the doorbell
that posted it. When every vCPU is idle (round-robin's `idle`), they are written at once. A parallel
vCPU going to WFI doesn't force them (another vCPU may be the one an interrupt storm keeps busy): its
IDLE exit's time is the earlier of its timer and the controller's due time, and its next run takes
them. The run loops look at the controller's next due time between chunks. In parallel SMP
it is `Shared::xhci_due`, so no lock is taken until something is due. A snapshot takes them at once.

Without it, a device that answers before the guest's CPU has moved on keeps the CPU in its interrupt
handler for good. usbtest's unlink tests resubmit a URB from its completion. Against an instant Gadget
Zero, process context never ran again, and the test's `msleep` never returned: 80,000 completions in a
minute, natively. With the latency the guest pays nothing when it waits (idle time is skipped in
deterministic mode), and testusb's run takes ~140M steps.

### Snapshots

`Xhci::save` keeps the registers, the ports' registers, each slot and endpoint's state with its rings'
positions, the event ring's producer and segment table, the events waiting for room, and the low halves of
ERSTBA and ERDP written without their high ones yet. It needs the
ports empty and nothing in flight. A machine with a device plugged in can't be saved:
`vm_snapshot_size` returns `u64::MAX` and `vm.snapshot()` says to detach it. The detach completes
in-flight TDs with errors, so the state is consistent without waiting on the guest ("The page", "Snapshot and Suspend").
A restored controller has empty ports, and its connectors' generations start again at 0, as the new
glue's do. The machine's configuration words gain `xhci` only when it is set, so the snapshots of
machines without one keep their format.

## The backend protocol (`vm_xhci`)

The shared block (`xhci::XhciShared`) holds:
- `events` at 0: `EV_REQUEST` when the core posted records
- a request ring at 8 and a completion ring at 16400: `virtio::WordRing`s of 4096 words, SPSC, with the
  layout of virtio's (docs/abi.md "USB")

A doorbell or command that posts records ends the run with a `DEVICE` exit whose slot is 32
(`xhci::EXIT_SLOT`). `Devices.serve` takes the xHCI's records on the same doorbell as the virtio
devices, and completions come back through `SIGNAL_DEVICE` and are drained at the next chunk boundary.
In deterministic mode the device worker answers before it acks the doorbell, so completions land at a
fixed step.

**Records** (core → host):
- `w0` = tag | generation << 24. The tag numbers TDs from 1, and is 0 for the other kinds. The
  generation is the connector's detach count, mod 256.
- `w1` = connector | DCI << 8 | kind << 16
- `w2` = the number of words that follow

The kinds are:
- **transfer** (0):
  - segment count | xHCI endpoint type << 16 | has-setup << 24
  - the length
  - the setup packet's 8 bytes (two words), for a control transfer
  - per segment, (RAM offset, length). Immediate data is (0, length | `SEG_IMMEDIATE`) and two words of
    bytes.

  The direction is the setup's for a control transfer, the DCI's otherwise (odd is IN). Linux's
  zero-length packet after an OUT is a transfer of its own, of length 0.
- **reset** (1): a port reset after the attach's first.
- **cancel** (2): a count, then the tags the guest stopped. They are not completed, and their late
  completions are dropped.
- **configured** (3): a count, then (DCI | type << 8 | interval << 16, max packet) per enabled
  endpoint, after Configure Endpoint.
- **clear-halt** (4): Reset Endpoint of DCI.

**Completions** (host → core): three words, `w1 & 0xff` the kind.
- done (0): `w0` as posted, `w1` = code << 8 (an xHCI completion code), `w2` = the bytes transferred.
  Success short of the TD's length becomes Short Packet. Unknown codes become Transaction Error.
- attach (1): `w0` = connector, `w1` = speed << 8 (1 full, 2 low, 3 high, 4 super)
- detach (2): `w0` = connector

The core keeps at most 1024 TDs posted and not completed, so the completion ring fills only with
completions of TDs it stopped (those wait in the glue). Tags in flight are never given again. Records
that don't fit the request ring wait in order, and are posted after the next completions.

**The glue** (`web/usb.ts` `Usb`, in `Devices`; natively `core/tests/common/usb.rs`):
- It reads a poll's records all at once. A transfer whose cancel comes later in the same batch never
  reaches its device: in realtime mode the guest may already have its buffer back. (Scanned from the
  end: a tag given again after its cancel is the new TD's.)
- A device that throws fails its TD with a transaction error (or loses that call: a reset, a cancel),
  and the device worker, with its disks and network, goes on.
- Completion records that find the core's ring full wait in the glue, in order, for the next poll (a
  backend may complete TDs the core already stopped and gave their room to new ones).
- For a transfer, it gathers the OUT data, calls `UsbDevice.submit`, scatters IN data, and posts the
  completion. A device's `done` for a cancelled tag, or for a connector whose device has changed, is
  dropped. The other kinds go to `reset`, `cancel`, `configured` and `clearHalt`.
- **Opening devices:**
  - `virtual` devices are made here: Gadget Zero, from its options in `UsbVirtual`.
  - `usb` and `hid` identities go to the opener registered for their API (`registerUsbOpener`). The
    device worker registers WebUSB's and WebHID's when it has `navigator.usb` and `navigator.hid`.
  - An opener gets `{connector, gone}`. `gone()` detaches the connector (`usb-state` detached,
    `unplugged`).
  - Real devices are refused in deterministic mode.
- **The page's messages** come on the port in `BootOptions.usb.port`, whenever they come, before the
  guest's driver runs too:
  - `usb-attach` gets one `usb-state`: attached (with the speed) or error.
  - `usb-detach` gets one detached.
  - Devices plugged in at start (`usb.attach`) get none.

  Without a port, `bootVm` makes a channel and the VM's `usb.attach`/`usb.detach` resolve with the
  answer. `usb.events` plugs and unplugs at step counts for `runToPowerOff`, exactly there in
  deterministic mode: the run stops at the step, and the plug is in the ring before the vCPU runs on.

## Virtual devices

**`VirtualDevice`** (`web/usb-virtual.ts`) is chapter 9 from descriptors:
- It answers the standard requests from the descriptors it is given: device, configurations, strings
  (string 0 is US English), the device qualifier, other-speed configurations, BOS, and class
  descriptors through `extra`.
- It keeps the configuration, each interface's alternate setting, endpoint halts and remote wakeup.
- A TD to an endpoint the active configuration doesn't have is a transaction error. A TD to a halted
  one stalls.
- Class and vendor requests go to the subclass's `control`, and the other endpoints' TDs to its
  `transfer`.
- Default-pipe requests stay in order, also behind an asynchronous answer.

The WebHID device is built on it.

**Gadget Zero** (`web/usb-gadget-zero.ts`, 0525:a4a0) is what Linux's `usbtest` and `testusb` test the
controller with. It behaves as Linux's `g_zero` (f_sourcesink and f_loopback), from their behavior.
- **Configuration 3, source/sink** (the first, which Linux chooses):
  - bulk IN 0x81 sends the pattern
  - bulk OUT 0x01 checks it; a wrong byte halts the endpoint
  - vendor requests 0x5b (write up to 4 KiB) and 0x5c (read it back), with wValue and wIndex 0
- **Configuration 2, loopback:** what OUT TDs take comes back to IN TDs, one each, in order, up to 32
  buffers. Then OUT waits, as a device NAKs. An IN with nothing to give waits for the next OUT.
- **The pattern** is 0 (zeros, `g_zero`'s default) or 1 (byte *i* of a TD is (*i* mod max packet)
  mod 63, usbtest's `pattern=1`).
- **Speeds:** high (512-byte bulk packets, a device qualifier, full-speed other-speed configurations),
  super (1024 bytes with companions, `bcdUSB` 3.20, a BOS with the USB 2.0 extension and the SuperSpeed
  capability) or full (64 bytes).
- No isochronous alternate setting, and no interrupt endpoints (f_sourcesink has none now).

Its native twin is in `core/tests/common/usb.rs`, so native boots give the guest the same bytes.

## The usb guest

`images/build.sh linux-usb` builds Linux with `xhci-plat-hcd` and `usbtest`, a static init
(`images/usb/init.c`) and the kernel's own `testusb` (docs/images.md).
- **`usb-hubs`:** no device. The guest shows the two root hubs: usb1 at 480 Mb/s and usb2 at 5000 Mb/s,
  four ports each.
- **`usb`:** a high-speed Gadget Zero on connector 0 and a super-speed one on connector 1, both
  `pattern=1`. It runs `testusb -a -c 10 -s 1024 -v 512 -g 16`:
  1. A clean pass: 23 tests per device, the isochronous, interrupt and performance ones skipped by
     usbtest.
  2. Passes again until the host unplugs connector 0 at step 80M. That lands in pass 2, whose remaining
     tests fail with ENODEV.
  3. The host plugs it in again at step 100M, and the guest enumerates it again.
  4. A clean pass, then it powers off.

  It runs in every runner with exact steps (tests/steps.txt):
  - `core/tests/usb_guest.rs`, natively (in `scripts/ci.sh`)
  - `tests/boot-node-suite.ts`, in Node, interpreter and JIT
  - `tests/browser.test.ts`, in Chromium, interpreter and JIT
- **Parallel SMP**, natively and in Node: two vCPUs, one clean pass, three runs each.

The unit tests (`core/src/xhci/tests.rs`) drive the controller as Linux does, on hand-built rings, and
check:
- bring-up and the protocol capabilities
- attach, reset, suspend and resume, detach
- enumeration with BSR and a short control read
- bulk TDs across a Link TRB, immediate data, a short bulk IN
- a stall through Reset Endpoint and Set TR Dequeue
- Stop Endpoint with TDs in flight, an unplug in flight
- TRB errors, a full event ring, Deconfigure, HCRST
- the latency
- snapshots

`tests/usb-glue.test.ts` checks Gadget Zero and the glue on the core's ring layout, and
`tests/usb.test.ts` checks the virtual device base. A short-packet bug planted in the controller (the
Short Packet event reported as Success) fails two unit tests and testusb's first pass.

## The usbhost guest

`images/build.sh linux-usbhost` is the usb guest for real devices: the same kernel with `cdc_acm`, `usbhid`,
`hid-generic` and `hidraw` (`images/usbhost/linux.fragment`), and an init (`images/usbhost/init.c`, which includes
`images/usb/init.c` unchanged) whose `usb_mode=` picks the run. It is an image of its own so that `linux-usb`, its
runs and their steps stay as they are. `tests/usb-guest.test.ts` boots it in Chromium, realtime and under the JIT
(`tests/browser/boot-worker.ts` `?usbhost=`), with a host device on connector 0. It runs in `scripts/ci-usb.sh`'s
set, on the dev VM's rigs, and writes each run's console to `target/tests/usb-guest-<mode>.log`.

| Mode | Device | What passes |
|---|---|---|
| `testusb` | the dummy_hcd Gadget Zero (`webpc-zero`) through the WebUSB passthrough, left in configuration 2 (loopback) first, as a real device may be | `testusb -a -c 10 -s 1024 -v 512 -g 16` with `usbtest.pattern=1` (configfs's source/sink default): all 23 tests, after the guest's reset and SET_CONFIGURATION 1 switched it |
| `acm` | the ACM gadget (`webpc-acm`) through the WebUSB passthrough, the guest's `cdc_acm` on it | three rounds of open `/dev/ttyACM0`, write 300 bytes, read the gadget tty's echo, close. Each close cancels `cdc_acm`'s reads, so the next round's reads are served by the cancelled ones' transfers (the carry-over) |
| `hid` | a uhid device (`vendor-ids`) through WebHID | the report descriptor the guest got parses to what the page can use of Chromium's parse; three input reports from the rig arrive in order; an output report (`write`) and a feature report (`HIDIOCSFEATURE`) reach the rig; `HIDIOCGFEATURE` gets the rig's |

What the runs found:
- **Chromium refuses SET_FEATURE(ENDPOINT_HALT)**, and GET_STATUS and CLEAR_FEATURE on endpoint 0. The
  passthrough answers them itself (the table above).
- **The guest's port reset reaches the device** through `reset()`. On a gadget, that is a disconnect: its
  tty hangs up, and the test's echo opens it again.
- **A reset with interfaces claimed leaves Chromium's claims stale** (on Linux). Chromium still says the
  interfaces are claimed, but releasing them fails, and so does claiming them in another configuration. A
  device left in configuration 2 lost the guest at its first transfer, after the guest's reset and its
  SET_CONFIGURATION 1. The passthrough now releases the interfaces before `reset()`.
- **WebUSB throws NotFoundError for an endpoint outside a claimed interface** as well as for a disconnect. Only
  the disconnect ("The device was disconnected.") means the device is gone.

## The WebUSB passthrough (`web/webusb.ts`)

`openWebUsb(device, {gone, os})` takes any object with WebUSB's `USBDevice` methods (`WebUsbDeviceLike`)
and returns a `UsbDevice`. The device worker's opener, `webUsbOpener(navigator.usb)`, finds the granted
device with `getDevices()` and opens it. It matches on vendor, product and serial number; among
identical devices without a serial number, `index` picks one in `getDevices()` order. The opener also
calls `gone` on WebUSB's `disconnect` event.

**At attach:**
1. The device is opened.
2. Its raw descriptors are read through `controlTransferIn` GET_DESCRIPTOR and cached: the device
   descriptor, every configuration, the BOS (only when `bcdUSB` ≥ 2.01), the language IDs, and every
   string index the descriptors reference, in every language.
3. If the device has no configuration, its first one is selected.
4. Every interface of the active configuration that isn't protected is claimed. An interface is
   protected when any of its alternate settings has a class WebUSB refuses ("What the browser allows").
5. The configuration descriptors the guest gets leave out the protected interfaces, and the ones that
   failed to claim. A dropped interface takes with it its descriptors up to the next interface or
   IAD. `bNumInterfaces` and `wTotalLength` are rewritten. An IAD shrinks to the interfaces left in
   its range, and is dropped when none is left. Interface numbers are not renumbered, because the
   guest addresses requests by them. Linux logs a notice for the gap and binds the rest.
6. The speed is inferred from the descriptors:
   - **super:** a SuperSpeed endpoint companion, or `bMaxPacketSize0` = 9
   - **high:** what only high speed allows: a 512-byte bulk endpoint, an interrupt endpoint over 64 bytes, an
     isochronous one over 1023 (a wired Xbox controller's full-speed audio interface has 228-byte ones), or
     high-bandwidth bits (11–12 of `wMaxPacketSize`)
   - **low:** an 8-byte endpoint 0 with only interrupt endpoints of at most 8 bytes, and no bulk or
     isochronous ones
   - **full:** anything else

   A BOS that only declares SuperSpeed *capability* doesn't make a device super. An Android phone at
   high speed has one.

**Problems:** what the guest doesn't get is in `problems` (`UsbProblem`). The glue sends it with the
attach's `usb-state` (`problems`), and the page puts it in words with the host OS's remedy (`problemText`,
"Attach and detach" below):
- `protected-interface`: a protected interface.
- `claim-failed`: an interface the host's OS holds, with the browser's message.

A device left with no interface it can use fails to open with a `UsbOpenError`. Its problems go in the
error's `detail`.

**Standard requests:** these are answered or interpreted by the backend. The rest pass through.

| Request | Here |
|---|---|
| GET_DESCRIPTOR device, configuration (filtered), BOS, cached strings | from the cache. A string not in the cache (a Microsoft OS string, an index only a class descriptor names) and other types pass through |
| SET_CONFIGURATION *n* | the active one: alternate settings back to 0. Another: release, `selectConfiguration`, claim again. *0*: release everything (GET_CONFIGURATION then answers 0) |
| SET_INTERFACE | `selectAlternateInterface`. An interface we don't hold, or an alternate it doesn't have, stalls |
| CLEAR_FEATURE(ENDPOINT_HALT) | our halt cleared, then `clearHalt` (which resets the device's data toggle), and a stall carried over on that endpoint is spent. On endpoint 0, success locally |
| SET_FEATURE(ENDPOINT_HALT) | ours: Chromium refuses it (a standard OUT request; usbtest's halt test got a transaction error). The endpoint's TDs stall here and GET_STATUS says halted, until CLEAR_FEATURE |
| other SET/CLEAR_FEATURE, SET_SEL, SET_ISOCH_DELAY | success, locally |
| GET_STATUS | an endpoint we halted, or endpoint 0 (WebUSB reaches only a claimed interface's endpoints), locally; the rest pass through |
| GET_INTERFACE, SYNCH_FRAME | pass through. GET_INTERFACE on an interface we don't hold stalls |

Class and vendor requests go to `controlTransferIn` or `controlTransferOut`, with the recipient taken
from `bmRequestType`. A request whose recipient is an interface we don't hold stalls without reaching
WebUSB. The controller's `clearHalt` (Reset Endpoint) does nothing here: the guest's CLEAR_FEATURE that
follows it does the work.

**Transfers:**
- Each bulk or interrupt TD is one `transferIn` or `transferOut`.
- A length-0 OUT TD is an empty `transferOut`. Linux queues URB_ZERO_PACKET's zero-length packet as a TD
  of its own.
- WebUSB calls start in submit order. Device-wide changes (configuration, alternate settings, clearing
  a halt, reset, close) wait for the calls before them to finish, and later calls wait for them.
  Transfers on different endpoints run side by side.
- Each endpoint's TDs complete in submit order, whatever order WebUSB's promises settle in.
- Results map to codes: `ok` is `success`, or `short` when fewer bytes than asked; `stall` is `stall`;
  `babble` is `babble` (with its data); a rejected promise is `error`. A `NotFoundError` also calls
  `gone`.
- Isochronous TDs complete with `error` (isochronous transfers aren't implemented: backlog.md "USB").

**IN data outlives a cancel.** Each IN endpoint is a stream:
- WebUSB transfers in flight, in order.
- The guest's TDs waiting, in order.
- A carry-over queue of what arrived when no TD was waiting.

An arriving result goes to the oldest waiting TD, or to the carry-over when none waits. A submitted TD is
served from the carry-over first. A new `transferIn` is issued only while fewer are in flight than TDs
wait, so a cancelled TD's transfer serves the next TD. A carried-over chunk longer than the TD is split,
and the rest stays at the head of the queue.

What a cancelled transfer brings: data, and a stall (a halted endpoint stays halted), are kept. Empty
results and errors are dropped. Nothing is lost or reordered. An endpoint nobody reads again keeps one
transfer pending until detach. Configure Endpoint (`configured`), SET_CONFIGURATION, SET_INTERFACE (for
that interface's endpoints), reset and detach discard an endpoint's state, so their late results are
ignored.

**Reset** (after the attach's first) drops every endpoint's state, releases the interfaces, calls
`device.reset()`, and claims them again (see "The usbhost guest" for why the release comes first). The
host keeps the device's configuration across the reset. A reset that fails, which on some hosts means WebUSB lost the device
when it re-enumerated, calls `gone`. **Detach** completes nothing more, then releases the interfaces and
closes the device.

**Tests:** `tests/usb-webusb.test.ts` runs the backend against a scripted fake (`tests/usb/fake-webusb.ts`).
The fake answers GET_DESCRIPTOR from raw descriptors, refuses protected classes as Chromium does, refuses
interfaces a "host driver" holds, and leaves each IN pending until the test answers it. The descriptors in
`tests/usb/webusb-fixtures.ts`:
- **recorded** from the user's devices through WebUSB: an FTDI FT232R, a Nooelec NESDR (RTL2832U) and a PowerA
  wired Xbox controller;
- **transcribed** from public documentation and `lsusb -v` layouts: a CP2102, a Pico with CDC and its reset
  interface (with a BOS), an Android phone in MTP and adb, a DAPLink with mass storage, CDC, HID and vendor
  interfaces, an FX3 at SuperSpeed and a low-speed USBasp. A real dump replaces one when such a device is at hand.

## The WebHID device (`web/webhid.ts`, `web/hid-descriptor.ts`)

`openWebHid(device, {serial})` builds an emulated USB HID device from a `HIDDevice`
(`WebHidDeviceLike`) and opens the device if it isn't open. The device is built on `VirtualDevice`
(`web/usb-virtual.ts`), which answers chapter 9 from the descriptors.

The device worker's opener, `webHidOpener(navigator.hid)`, finds the device by vendor and product, with
`index` among identical ones, since WebHID gives no serial number. It gives the guest the serial
`webpc-hid-<connector>`, and calls `gone` on WebHID's `disconnect`.

**Only what the page can use** reaches the guest (`visibleCollections`). Chromium hides a protected
top-level collection's input and output reports (a keyboard's, a mouse's) at the top level, but its
children still list them. They never arrive, and `sendReport` refuses them (NotAllowedError, on the
recorded keyboard composite). So a child keeps only the reports its top-level collection lists, and a
collection left with no reports goes. A keyboard keeps its feature report, which is how VIA-style tools
work, and a mouse disappears. Each collection cut down that way is a `protected-collection` problem in the
attach's `usb-state`, which says whether any of its reports were kept. A device left with nothing fails with
`no-collections`.

**The descriptors** (`hidLayout`):
- The device's vendor and product IDs, `bcdUSB` 2.00, `bcdDevice` 1.00.
- No manufacturer string. The product string is `productName`, and the serial is the connector's.
- One configuration with one interface: class 3, subclass 0, protocol 0, and the HID class descriptor
  (HID 1.11).
- An interrupt IN endpoint 0x81. Its `wMaxPacketSize` is the largest input report, plus 1 when the
  device uses report IDs, capped at 1024.
- An interrupt OUT endpoint 0x01 when there are output reports, sized the same way.
- The device is high speed when either endpoint is over 64 bytes, and full speed otherwise.
  `bInterval` is 1 ms in either encoding (4 at high speed, 1 at full speed).
- The report descriptor (GET_DESCRIPTOR 0x22) and the HID descriptor (0x21) go to an interface
  recipient.

**Chromium's shape** (from the recorded parses in `tests/usb/hid-fixtures/`):
- A main item belongs to its collection *and to every collection around it*. A top-level collection
  therefore lists each of its reports whole, in descriptor order, and a child lists the run of those
  items that lies inside it.
- Reports within a collection come in Chromium's own order, which is stable but not the descriptor's.
- Usages are extended (page << 16 | ID).

**Encoding the report descriptor:** `encodeReportDescriptor(collections)` writes each collection as its
usage page (when it changes), its usage, and a Collection item of its type. Then it walks the
collection's reports. Each child's run is found in the parent's lists, the parent's items before that run
are written, then the child, and the rest after. This puts every Collection and End Collection back where
they were, so the layout of a report is the original's. For each run of items, the encoder writes its
Report ID (when it changes) and its items. Each item gets:
- The globals that changed. Logical and physical values use the shortest *signed* encoding, so 255 is
  `26 ff 00` and no parser can read it as -1. A maximum WebHID reads as negative over a non-negative
  minimum gets 4 bytes. The unit exponent is a nibble, and the unit is rebuilt from `unitSystem` and
  the six factor exponents.
- Its usages as 16-bit IDs on the current page. A usage on another page is written as an extended
  32-bit usage. A range is written as Usage Minimum and Maximum.
- The main item, with all nine flag bits. Buffered bytes makes it a 2-byte item.

**Parsing:** `parseReportDescriptor(bytes)` reads a descriptor into the same shape, grouped the way
Chromium groups it. Each main item goes to its collection and to every collection around it, in a report
per type and report ID.
Usages resolve against the usage page in force at the main item. Push and pop are kept. A logical or
physical maximum is signed when its minimum is negative, and unsigned otherwise, read as int32 as
WebHID's are.

**What doesn't come back** from WebHID's form:
- the original bytes: the order of global items, push and pop, delimiters
- string indices, since WebHID resolves no strings
- the order of reports within a collection, which doesn't matter because reports are keyed by ID

**Requests and reports:**
- **GET_REPORT, input:** the last input report with that ID, or zeros of its size before the first one.
  An ID the device doesn't have stalls.
- **GET_REPORT, feature:** `receiveFeatureReport`'s buffer, as it is. Chromium leads it with the report
  ID when the device uses IDs, and gives no prefix without them (report ID 0). That is the framing the
  guest expects. `inputreport` data has no ID byte, and the device adds one.
- **SET_REPORT, output and feature:** `sendReport` and `sendFeatureReport`, with the ID byte taken from
  the front when the device uses IDs. A rejected promise stalls.
- **SET_IDLE, GET_IDLE, SET_PROTOCOL and GET_PROTOCOL** are answered locally. GET_PROTOCOL says report
  protocol, since no boot protocol is offered.
- **Input reports:** each `inputreport` completes the oldest IN TD, with the ID byte first when IDs are
  used. With no TD waiting, it waits in a queue of 32, which drops the oldest.
- **OUT TDs:** an OUT TD is one `sendReport` (the ID is its first byte), in order. A rejected one stalls.
- **Cancel** removes waiting IN TDs. **Reset** drops the queued reports and TDs. **Detach** stops the
  reports and closes the device.

**Tests:**
- `tests/usb-hid-descriptor.test.ts`: round trips of hand-built collections (a game pad with report IDs
  and a nested physical collection, VIA's raw HID, and the odd corners: signed and wide values, units,
  flags, mixed-page usages, nested children); the exact bytes of the encoding; the HID spec's mouse
  (Appendix E.10); push and pop.
- The six recorded Chromium parses in `tests/usb/hid-fixtures/` (a DualSense, a Stream Deck shape,
  vendor collections with and without IDs, a game pad, a keyboard composite), compared without regard to
  report order. The same file checks that our parse of each raw descriptor, with Chromium's hiding
  applied, is Chromium's. It checks that encoding what is visible parses back to it. And where nothing is
  hidden, it checks that the encoding has the original's report sizes.
- `tests/usb-webhid.test.ts` runs the device against a fake HIDDevice.

## The keyboard

A machine with the controller has a **built-in USB keyboard** on its last connector (`KEYBOARD_CONNECTOR`, 3; the
USB tab lists only 1–3 for remembered devices and says what 4 is). It is the firmware's and the boot loader's
keyboard: EDK2 has no virtio-input driver, so before this the screen's keys went to the serial console as a
terminal sends them (`terminalBytes`), which left out every key without a terminal encoding, key-ups and modifiers
by themselves.

- **The device** (`web/usb-keyboard.ts`, `{api: 'virtual', kind: 'keyboard'}`): a full-speed HID boot keyboard on
  `VirtualDevice`, pid.codes' test IDs (1209:0001).
  - Interface class 3, subclass 1, protocol 1, with HID 1.11's boot report descriptor (63 bytes).
  - Interrupt IN 0x81 carries 8-byte reports: the modifier bits (0xE0–0xE7 as bits 0–7), a reserved byte, and up
    to six usages, or ErrorRollOver (1) in all six while more are held.
  - The LEDs come by SET_REPORT(output). GET_REPORT, GET/SET_IDLE and GET/SET_PROTOCOL are answered; the two
    protocols share the layout.
  - Every change of the held keys is a report, sent in order (a press and its release both reach the host), to the
    IN TD the host keeps queued. Up to 32 wait while none is queued. While unconfigured, the state is only kept.
  - The idle rate is kept, but no report is repeated: EDK2 and Linux repeat keys themselves.
- **Its keys** are the page's `KeyboardEvent.code`s, mapped to HID usages as web/input.ts maps them for
  virtio-input (a US layout: a key is where it is on the keyboard, whatever the host's layout prints on it). They
  go to the device worker as `usb-key` messages on the controller's port (no answer; `code` '' releases them all,
  when the screen loses the focus).
- **The firmware side** (`images/edk2/WebpcXhciDxe`, a driver of ours): it finds the DT's `generic-xhci` nodes
  through FdtClient and registers each as a non-discoverable xHCI, with coherent DMA and its MMIO window.
  NonDiscoverablePciDeviceDxe (added to the build by `images/edk2/usb-xhci.patch`) gives it a PCI I/O protocol, and
  EDK2's XhciDxe, UsbBusDxe and UsbKbDxe drive it as a PCI controller. The boot manager's ConIn already lists "any
  USB keyboard", and its ConnectAll reaches it: the UEFI shell, the boot manager's menus and GRUB read it beside the
  serial console. The drivers are dispatched on every machine (the firmware's step counts moved once for them:
  `edk2-shell`, `edk2-shell-again`).
- **On the page** (web/app/main.ts):
  - The keyboard is plugged in when the machine runs and its guest has no driver on the virtio keyboard (the
    worker's `keyboard {live}`). It is unplugged once that driver is live, so Linux doesn't get every key twice,
    and plugged in again if the driver goes away. A guest reboot is a new machine on the page, so the keyboard is
    there again at power-on.
  - While it is plugged in, the screen's keys go to it (`attachInput`'s `text.usb`), the toolbar's chords too. Else
    they go to virtio-input, or, on a machine without the controller, to the serial console as before.
  - Snapshot and Suspend unplug it with the other devices, without asking about it, and plug it back after. That
    happens only while the guest's virtio keyboard isn't live: a snapshot of a running Linux has it unplugged
    anyway.
  - It isn't counted or listed among the USB menu's devices. The USB tab says it is connector 4's.
  - Linux sees it too until it is unplugged: a USB keyboard that comes and goes during the boot.
- **Tests:**
  - `tests/usb-keyboard.test.ts` (Node): the descriptors, reports, rollover, modifiers, LEDs, idle and protocol,
    and the `usb-key` path through the glue.
  - `tests/page-usb-keyboard.test.ts` (Chromium, Debian, ci-debian):
    1. GRUB's countdown is stopped by `c` on the screen.
    2. A command typed at `grub>` runs.
    3. `keystatus --shift` sees a Shift held through Enter. No terminal sends a modifier by itself, so this is the
       USB path, not the serial one.
    4. After the boot the guest no longer lists the keyboard, and the screen's keys reach tty1 once each.
  - In Node, the UEFI shell takes Esc and typed commands from the keyboard alone
    (`bench/results/local/fw-kbd.ts`, ad hoc).

## The page

Files: `web/app/usb-ports.ts` (DOM-free: identities, lock names, connectors, matching, the messages' words, the
definition entries), `web/app/usb-live.ts` (the browser's devices and grants, the device locks, the running machine's
ports), `Usb.svelte` (the Machines page's USB tab), `AddUsb.svelte` (the Add a device wizard), `UsbMenu.svelte` (the
toolbar's USB menu), `UsbProblems.svelte` (a device's problems, with their remedies folded), and the USB block of `web/app/main.ts`.

### The controller and the shape

`MachineRecord.usb` turns the controller on. The shape has `usb: true` only when it is on. When it is off the key is
left out, so a machine made before USB keeps its canonical JSON and its shape hash (`tests/store.test.ts` pins the
hash). New machines (`createMachine`: New machine, a disk file opened or dropped) have the controller; a definition
without `machine.usb` imports with it off. It is turned on or off with the **USB controller** checkbox, which is on
the Settings tab and on the USB tab. The checkbox warns that the change orphans the machine's snapshots, as a RAM
change does, and Save asks again when there are snapshots to orphan. `shapeDiff` says "it had (no) a USB controller".
A transient machine (a test's) has the controller with `?usb=1` only. With a controller, the page passes a
`MessagePort` in the worker's `start` message (`protocol.ts` `usb`). The page's `usb-attach` and `usb-detach` go
through it, and the device worker's `usb-state` comes back.

### Remembered devices

`MachineRecord.usbDevices` holds `UsbEntry`s: an id, the API (`usb` or `hid`), the vendor and product IDs, the
serial number and product name where the browser gives them, `index`, the connector (0–3) and *attach at start*.
Each entry is an identity, not a device. The browser's grant persists per origin, so at a start the page finds the
device again with `getDevices()` and needs no click.
- **Identical devices without a serial number** are told apart by `index`, their position among their twins in
  `getDevices()` order (`matchDevices`, `identityAt`). **That order holds only within a browser session.** It is
  the same on every call, and the same in the page and in a worker (measured on Chromium 153 with two
  serial-less Gadget Zeros). A restarted browser can list the twins the other way round, so after a restart an
  entry's twin may be the other device, on the entry's connector. That is harmless for truly identical devices,
  but not for two boards flashed differently. The USB tab says so when a machine has such twins. WebHID
  never gives a serial number, and it lists a device with several HID interfaces as several `HIDDevice`s. Each of
  those becomes its own entry, with its own index.
- **Grants:** WebUSB and WebHID list only devices that are both granted and plugged in, so a missing grant looks the
  same as a device that is unplugged. The page keeps the identities it has seen granted in localStorage
  (`webpc.usbGranted`) to tell the two apart. An entry that isn't listed there and isn't found has *no permission in
  this browser*. That happens to a definition's entries on another browser. **Allow…** opens the browser's chooser
  filtered on the entry's IDs (and its serial number, for WebUSB), and so does the menu's offer at the first start.
- **States** (`entryStates`):
  - *attached*: on a connector of this page's machine.
  - *held by …*: another tab's machine has it. The page sees the entry's Web Lock held, and the holder answers with
    its machine's name.
  - *plugged in*.
  - *not plugged in*: skipped at start without a word.
  - *no permission in this browser*.
- **Forget** detaches the device first. When no other machine remembers the device, Forget also calls
  `device.forget()`, so the browser's grant goes too.
- **Edits:** the list is edited while the machine runs, so a settings save (`updateMachine`) keeps the stored list
  rather than the draft's. **Duplicate** copies the entries with new ids.
- **Definitions** carry `machine.usb` and `usbDevices`, which are the entries without their ids. No grants travel.

### Device locks

A Web Lock `webpc-usb:<api>:<vid>:<pid>:s:<serial>|n:<index>` is held while the device is attached. Tabs talk over
the store's `BroadcastChannel`, with notes (`Store.tell`, `onNote`):
- `usb-who` asks who holds a lock, and the holder answers `usb-held` with its machine's name.
- `usb-release` asks the holder to detach the device.

Attaching a device that another machine holds names that machine and offers **Detach it there**. The holder's page
then detaches it and says so.

### Attach and detach

They work while the machine runs on this page, from the USB tab or the toolbar's menu (its toggles).
- **When:** the *attach at start* entries that are plugged in go on once the machine runs: at the first `booting` or
  `running` state of each start. A start, a resume and a restored snapshot are treated alike, because a snapshot's
  ports are empty.
- **Plugging in:** a granted device that is plugged in later (`connect`) is attached when its entry has *attach at
  start* and its connector is free. Otherwise the menu offers it: *Attach* for an entry, *Attach and remember* for a
  device the machine doesn't remember.
- **Re-enumeration:** when an attached device is unplugged, the menu offers **Pick it…**. That opens the chooser in
  case the device came back as another one, such as a bootloader, because a device without a grant raises no
  `connect`. For 60 s after the unplug, a new granted device is offered on the same connector, as its own entry.
- **What's left out:** an attach that worked can still leave part of the device out. Its `usb-state` lists those
  `problems`: a protected or host-held interface, or a HID collection the browser keeps. The USB tab shows them in
  words under the entry (`data-usb-problems`). The menu gives a line under the device, and its tooltip has the
  short words.
- **Errors:** an attach refused by the device worker is shown with its `UsbProblem`s in words (`problemText`). Each
  problem is a short plain sentence (`text`); the host OS's remedy (`fix`: numbered steps, the commands to copy in
  their own boxes) and the browser's own message (`said`) sit folded under it in a `<details>` (`UsbProblems.svelte`,
  in the menu, the Add a device wizard and the Machines page). The message bar, which shows plain text, gets the
  short sentences only. The words are text, never Markdown:
  - a protected interface class, with where such a device goes instead;
  - an interface a host driver holds, with the remedy for Linux (unbinding `cdc_acm` and the like), macOS and
    Windows (WinUSB through Zadig);
  - a HID device whose every collection is hidden, or one collection that is (a keyboard's, a mouse's);
  - a device that can't be opened: on Linux the `hidraw` or `/dev/bus/usb` udev rule; on Windows WinUSB.

### Snapshot and Suspend

With devices attached, Snapshot (kept or to a file) and Suspend ask once, naming the devices: the guest sees them
unplugged. The page detaches them, saves, and attaches them again. Suspend instead leaves the *attach at start*
entries to the next start, as with a restore.

### Gadget Zero on the page

`?usbzero=1` adds a **Gadget Zero** toggle to the USB menu. It attaches the virtual `{api: 'virtual', kind:
'gadget-zero'}` on the first free connector, so the page's tests can attach, detach and snapshot without host
hardware. It takes no lock and is no entry.

### Tests

- `tests/usb-page.test.ts` (Node) covers:
  - identities, connectors, matching and the messages;
  - the ports against a fake device worker on a `MessageChannel`, including attach, refusal, detach all and attach
    again, and unplug;
  - the locks between two Stores on one channel: who holds a lock, and Detach there;
  - the record: new machines with the controller, a settings save keeping the entries, definitions round trip and
    validation.
- `tests/page-usb.test.ts` (Chromium, with WebUSB and WebHID faked per profile) covers:
  - the USB tab and the wizard, twins, and an entry held by another tab's machine;
  - a definition on a second profile: no permission, Allow, Forget revoking;
  - an old machine's controller off, and turning it on, which warns and orphans its snapshot.
- `tests/page-usb-guest.test.ts` (Debian, `scripts/ci-machines.sh`) covers a stored machine with the controller:
  - Gadget Zero attached from the menu (`?usbzero=1`), and the guest enumerating it;
  - a kept snapshot that asks first, empties the ports and attaches the device again;
  - a detach.

  Planted: Snapshot not emptying the ports first (the core refuses the save; caught).
- Real WebUSB and WebHID in the pinned Chromium run on the dev VM's host rigs: dummy_hcd gadgets and uhid devices,
  with permission from Chromium's managed policy. They run in `scripts/ci-usb.sh`, not in `ci.sh`. The rigs, the
  recorded HID fixtures and the QEMU oracle are in [testing.md](testing.md) "USB: the dev VM's host rigs".
