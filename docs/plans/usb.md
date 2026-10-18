# USB devices through WebUSB and WebHID

**Status:** proposed 2026-10-15; WebHID added 2026-10-18. **U0–U4 built 2026-10-18** (how it works now:
[docs/usb.md](../usb.md)); **U5 closed 2026-10-18** with the user's devices ("U5 findings"; the rest of its list,
untried, is in backlog.md "USB"), and U6 waits for the user's OK.
It answers the question "could
the user attach any USB device plugged into their computer to the guest, through WebUSB?". **Yes, for most devices
that matter here.** The guest gets an emulated xHCI controller, and each attached device is passed through to
Chromium's WebUSB. The limits come from WebUSB, not from the machine (§2).

WebUSB refuses HID interfaces, so game pads, joysticks, wheels, macro pads, Stream Decks, UPSes and the vendor
collections of keyboards and mice are out of its reach. **WebHID reaches them, and it belongs in the same plan:** it
needs the same controller, the same backend protocol, the same hot-plug and the same page menu. Only the device
end differs. A WebHID device is not passed through: the device worker serves the guest an emulated USB HID device,
built from what WebHID tells it, and moves reports between the two (§2a, §4 "The WebHID backend"). That backend is
smaller than the WebUSB passthrough, because it is a virtual device like Gadget Zero, and it needs nothing from
the host OS's drivers. It works for Bluetooth HID devices too, since WebHID doesn't care about the bus.

Starting it needs the user's OK: it adds a guest-visible controller, an ABI change and two new kinds of device
backend. The order is in §6.

## 1. What the machine has today, and what USB needs from it

- **No bus that enumerates.** Everything is described by the DT: virtio-mmio transports, the PL011, the PL031,
  fw_cfg and the flash bank ([platform.md](../platform.md) "Memory map"). There is no PCI host bridge
  ([uefi.md](uefi.md) "DT or ACPI"). [audio.md](../audio.md) already notes that USB audio is out for this reason.
- **No virtio transport for USB.** Upstream Linux has no virtio-usb driver; the proposals were never merged. The guest's
  stock USB stack only binds to a real host-controller interface: xHCI, EHCI, OHCI or UHCI, or the platform glue of a
  SoC.
- **xHCI does not need PCI.** Linux's `xhci-plat-hcd` binds a DT node `compatible = "generic-xhci"` with one MMIO
  window and one interrupt. The same driver serves the DWC3 and other SoC xHCIs, so distro kernels that support
  arm64 boards build it (which of our guests do: "U0 findings").
- **The shape fits the existing device split** ([devices.md](../devices.md)). The core owns the register file and the
  guest-memory data structures. The device worker owns the backend. Rings carry requests and completions between
  them:

  | | virtio today | xHCI here |
  |---|---|---|
  | registers | the virtio-mmio transport in the core | the xHCI capability, operational, runtime and doorbell registers, and the port registers, in the core |
  | structures in guest RAM | virtqueues, walked by the core | the command ring, the transfer rings, device contexts, the event ring and its segment table, walked and written by the core |
  | what crosses to the host | a flat segment list per chain (the host never parses rings) | a flat segment list per **transfer descriptor (TD)**, plus a setup packet for control transfers. The host never parses TRBs |
  | completion | {head, bytes written} | {TD tag, USB completion code, bytes transferred} |
  | doorbell | queue notify → `DEVICE` exit | xHCI doorbell write → `DEVICE` exit (the same path) |
  | interrupt | a level SPI per transport | one level SPI from interrupter 0 (`IMAN.IP && IMAN.IE && USBCMD.INTE`) |

  So the controller lives in Rust (`core/src/xhci.rs`), sits under `Vm::plat` in parallel SMP as the virtio
  transports do, is saved by `vm_snapshot_save`, and runs natively for `cargo test`. USB devices are backends in the
  device worker (`web/usb.ts`), with native twins in `core/tests/common` for the virtual ones.

## 2. What WebUSB allows, and what that means for "arbitrary"

These facts come from the WebUSB spec (WICG, read 2026-10-15) and Chromium. U0 re-checks them on the pinned
Chromium:

- **Protected interface classes cannot be claimed:** audio (0x01), HID (0x03), mass storage (0x08), hub (0x09),
  smart card (0x0B), video (0x0E), audio/video (0x10) and wireless controller (0xE0, which covers Bluetooth dongles).
  Chromium's blocklist adds specific devices, such as security keys. That excludes keyboards, mice, game pads, flash
  drives, webcams, headsets and Bluetooth adapters. Each has a better route that the page has, or could have (§7).
  What remains is most of the interesting long tail. The class lives in each interface descriptor, so the
  vendor-specific (0xFF), CDC (0x02/0x0A), printer (0x07), still-image/MTP (0x06), DFU (0xFE) and test-and-measurement
  devices are all allowed:
  - Android phones: adb and fastboot.
  - Microcontroller boards and debug probes: CDC-ACM, DFU, CMSIS-DAP v2, ST-Link, J-Link. These are what OpenOCD,
    probe-rs, dfu-util, esptool and picotool drive.
  - USB-serial adapters: FTDI, CP210x, CH34x.
  - Logic analysers (sigrok's fx2lafw) and SDRs (RTL-SDR, HackRF, Airspy).
  - Printers, FPGA boards, and anything libusb-based in general.
- **A composite device may be partly protected,** for example a board that exposes HID next to CDC. The guest must
  not see interfaces it can't use. Their class drivers would bind and get errors, and Linux's usbhid retries
  forever. The passthrough serves the guest a configuration descriptor with the protected interfaces removed
  (`bNumInterfaces`, `wTotalLength` and the IADs rewritten), which U3 checks against real composite devices.
- **The host OS's drivers come first.** On Linux, Chromium does not detach a kernel driver by default (its
  `AutomaticUsbDetach` feature is off). An interface that `cdc_acm`, `ftdi_sio`, `cp210x` or `usblp` holds therefore
  fails to claim until the user unbinds it or adds a udev rule. A user without permission on `/dev/bus/usb` sees no
  devices at all. macOS holds CDC and serial adapters in the same way. On Windows a device needs WinUSB bound, which
  Zadig can do. The page cannot fix any of this. It can only say which interface failed and why, with the OS's
  usual remedy (U4).
- **Standard OUT requests are refused** on the control endpoint. That means SET_ADDRESS, SET_CONFIGURATION,
  SET_INTERFACE, SET/CLEAR_FEATURE, SET_SEL and SET_ISOCH_DELAY. The API has replacements for some of them:
  `selectConfiguration`, `selectAlternateInterface` and `clearHalt`. The backend therefore interprets the guest's
  standard requests instead of forwarding them (§4). Standard IN requests (GET_DESCRIPTOR, GET_STATUS,
  GET_CONFIGURATION, GET_INTERFACE) and all class and vendor requests to claimed interfaces pass through.
- **There is no way to cancel a single transfer.** `close`, `reset`, `selectConfiguration` and
  `selectAlternateInterface` abort transfers only in bulk. The guest cancels URBs all the time: interrupt-IN polls
  when a driver unbinds or a tty closes, timeouts, and usbtest's unlink tests. The design for this is in §4, "IN
  data outlives a cancel".
- **The device's speed is not exposed.** It is inferred from the raw descriptors (§4).
- **No bulk streams** (UAS, which is mass storage and protected anyway), no LPM, and no suspend or remote wakeup.
  The controller hides all of these.
- **Isochronous transfers exist** (`isochronousTransferIn/Out` with per-packet lengths), but timing is the browser's.
  The classes that need isochronous transfers most (audio, video) are protected. Isochronous support is a late,
  separate step (U6).
- **Identity changes need a new permission.** A device that re-enumerates as something else is, to WebUSB, a new
  device without permission. Examples are DFU detach into a bootloader, fx2lafw's firmware upload, and an Android
  phone rebooted into fastboot. `requestDevice` needs a user gesture on the page, so the guest's flow pauses until
  the user clicks. The page watches `navigator.usb`'s `connect` event and offers a one-click "attach the device that
  just appeared" with a filter that matches it (U4). Permission persists per origin, so the second time no prompt
  appears for an already-granted vendor:product:serial.
- **Where it runs:** `navigator.usb` exists in dedicated workers (`WorkerNavigator.usb`), and `requestDevice` is
  Window-only. The page asks, then sends the worker {vendorId, productId, serialNumber}. The device worker finds the
  same device with `getDevices()` and opens it there, next to the other backends. U0 confirmed that this works on
  Chromium 153. Two identical devices without serial numbers are told apart by the order `getDevices()` lists them
  in. U0 found that order stable within a browser session only: a restarted browser can swap the twins
  ("U0 findings").
- **Only Chromium has WebUSB.** That is the target anyway (the project's rule: other browsers' gaps don't block).
  WebUSB works under COOP/COEP, and an embedding iframe needs `allow="usb"`.

So the honest answer to "arbitrary": any device whose interfaces are not in a protected class and that the host OS
lets go of. In practice that is the developer and maker hardware that people would otherwise need a native VM for.

## 2a. What WebHID allows

From the WebHID spec (WICG) and Chromium's source, as of 2026-10-18. U0 re-checks them on the pinned Chromium:

- **What the page gets is a HID device, not a USB device.** `HIDDevice` has the vendor and product IDs, the
  product name, and `collections`: the report descriptor **already parsed** into collections, reports and report
  items (usage page and usages, size and count, logical and physical ranges, units, the Input/Output/Feature flags).
  The raw report descriptor, the USB descriptors, the serial number, the bus and the polling interval are not
  exposed. Reports go out through `sendReport` and `sendFeatureReport`, come in through the `inputreport` event, and
  feature reports are read with `receiveFeatureReport`.
- **So the device can't be passed through; it is rebuilt.** The guest gets a USB device whose descriptors the
  backend writes: its vendor and product IDs, one HID interface (class 0x03, no boot subclass), an interrupt IN
  endpoint and an interrupt OUT one when the device has output reports, and a report descriptor encoded back from
  `collections`. The items carry almost everything the original had. What's lost is its exact bytes: push and pop,
  delimiters and the order of global items don't survive, but they don't change what a report means. Linux drivers
  that bind by vendor and product (hid-playstation, hid-nintendo, hid-logitech-hidpp, hid-steam…) parse reports by
  ID and offset, so they work when the layout is the same. The few that patch the original descriptor by its size
  or bytes in `report_fixup` will see a descriptor they don't recognise; those are listed in U5.
- **Protected usages are hidden.** Chromium keeps from pages the collections a page could use to read keystrokes or
  steer the pointer: the Keyboard usage page, the Generic Desktop keyboard, keypad and mouse collections (their
  feature reports stay open, which is how keyboard configuration tools such as VIA work), and the system control
  usages. U0 measured what this does to a keyboard composite and to a game pad's Pointer collection ("U0 findings"). FIDO security keys (usage page 0xF1D0) are on the blocklist. The rebuilt descriptor simply leaves
  out what WebHID doesn't show, so a composite device (a keyboard with a vendor configuration collection) becomes a
  guest device with only the vendor part. Keyboards and mice themselves stay the page's virtio-input.
- **The host keeps its driver.** WebHID opens the host's HID node (`hidraw` on Linux, IOHIDManager on macOS, the
  HID class driver on Windows) alongside the host's own use of the device; nothing has to be unbound. On Linux the
  user needs read and write permission on `/dev/hidraw*`, which a udev rule gives (U4 says so when it is missing).
  The host still sees a game pad's input too, which matters only if something on the host listens.
- **Where it runs:** the spec exposes `navigator.hid` in dedicated workers, with `requestDevice` Window-only, as
  WebUSB. U0 confirmed that the pinned Chromium ships the worker side: `getDevices()`, `open`, input reports,
  `sendReport` and the feature reports all work in a dedicated worker.
- **Identity:** permission persists per origin. With no serial number, two identical game pads are told apart by
  `getDevices()` order, as with WebUSB.
- **What WebHID can't reach:** HID devices whose only collections are protected (plain keyboards and mice), and
  game pads that aren't HID on the host. Wired Xbox controllers are vendor-class USB (xpad, XInput); they are a
  WebUSB device where the host driver lets go, and the Gamepad API route of §7 otherwise.

## 3. Alternatives considered

- **USB/IP** (the guest's `vhci-hcd` plus `usbip attach` to a server of ours in the device worker): no core work,
  but every guest needs the module, the tool and a command run inside it. It also needs a TCP endpoint on the host
  side, which the Ethernet gateway doesn't have ([networking.md](networking.md) §3: it forwards IP; it isn't a TCP
  stack). This is not transparent. Rejected as the main path.
- **EHCI with companion OHCI/UHCI controllers:** two controllers for full and low speed, no USB 3, and an older,
  quirkier interface. xHCI covers every speed with one controller and is what Linux, EDK2 and every current OS
  expect. Rejected.
- **xHCI behind PCI** (as QEMU's `qemu-xhci`): it needs an ECAM host bridge, config space, BARs and interrupt
  routing in the core first. That bridge is worth having only for its own reasons ([uefi.md](uefi.md) "DT or ACPI"
  lists them). The controller's register block is written bus-agnostic, so a later PCI wrapper reuses it.
- **A virtual-HCI driver of ours in the guest:** this needs a module per guest kernel, so it is not unmodified
  images. Rejected.

## 4. Design

### The controller (core)

- **Placement:** one xHCI at `0x0c00_0000` (QEMU `virt`'s platform-bus window, which is free here), 64 KiB, on
  a free SPI. INTIDs 80–95 are free after the virtio window; the GIC has SPIs up to INTID 95 (`gicv3::NIRQ`).
  The DT node is `generic-xhci` with `dma-coherent` and a level-high interrupt. It is off by default:
  `VmConfig.xhci` (number of USB 2 and USB 3 root ports), so the tests' guests and their step counts don't move.
  A machine has it when its definition says so (§4a).
- **Interface subset** (xHCI 1.2, written from Intel's public specification):
  - Root ports: 4 USB 2 and 4 USB 3, each in its own Supported Protocol extended capability.
  - 32-byte contexts, 64-bit addressing (RAM ends above 4 GiB), no scratchpad buffers.
  - One interrupter with an event-ring segment table and IMOD moderation.
  - MFINDEX from the machine's time (steps in deterministic mode).
  - Commands: Enable/Disable Slot, Address Device (BSR handled), Configure Endpoint, Evaluate Context, Reset
    Endpoint, Stop Endpoint, Set TR Dequeue Pointer, Reset Device, No-Op.
  - Transfer TRBs: Normal, Setup/Data/Status, Isoch, Link, Event Data, No-Op. TRBs with immediate data (IDT) are
    copied into the request record.
  - Short packets: ISP and IOC events are placed on the right TRB, with the residual.
  - Not supported: streams (MaxPSASize 0), LPM (no HLC or LEC), virtualization, debug capability, MSI.
- **USB 3 ports** go straight to U0 on connect. **USB 2 ports** become enabled on the driver's port reset. The
  first reset after an attach stays inside the core: the device was just opened. Later resets go to the backend as
  a `reset` event (§"The backend protocol").
- **Suspend** (PLS = U3, which Linux's autosuspend does after ~2 s idle) is only a port state. Resume completes at
  once. The real device never suspends.
- **Hot-plug:** an attach or detach from the host sets the port's connect-status change and raises a Port Status
  Change event. The guest re-enumerates, exactly as with a real plug.
- **Reference code:** crosvm's xHCI (`devices/src/usb/xhci/`, BSD-3, already in `THIRD_PARTY.md`'s permissive
  table) and bhyve's `pci_xhci.c` (BSD-2) may be ported from, with an attribution row. QEMU's `hcd-xhci.c` and
  Linux's `xhci-*.c` are GPL: they are oracles and behavioral references only. Size estimate: ~2,000–2,500 lines of
  Rust with its unit tests (hand-built rings, as `virtio.rs`'s tests do).

### The backend protocol (core ↔ device worker)

- A shared block `vm_xhci(vm) -> *const XhciShared`: events, a request ring and a completion ring. These are SPSC
  u32 rings with `DevShared`'s mechanics, so `Devices.serve` takes them with the virtio devices on the same doorbell.
  ABI bump; the layout goes in [abi.md](../abi.md).
- **Request record:** `w0` = TD tag | epoch << 24; `w1` = port | endpoint (DCI) << 8 | kind << 16; then for
  control transfers the 8-byte setup packet; then (RAM offset, length) segments, as virtio's.
- **Kinds:** `transfer` (control, bulk, interrupt, isoch with its packet lengths), and device events that keep
  their order with the transfers:
  - `attach` and `detach`
  - `reset`
  - `cancel` (DCI and the tags the guest stopped)
  - `configured` (the endpoints after Configure Endpoint)
  - `clear-halt`
- **Completion record:** `w0` as posted, the completion code (Success, Short Packet, Stall, USB Transaction Error,
  Babble), and the bytes transferred. The core turns it into a Transfer Event on the TD's TRB.
- **Stop Endpoint completes in the core at once** (Linux waits on it synchronously in `usb_kill_urb`). The
  cancelled TDs get their Stopped events. The endpoint's epoch moves so that late completions for them are dropped,
  as the reset epochs drop stale virtio completions. A `cancel` record tells the backend.
- **Deterministic mode:** virtual devices complete like any backend, so `testusb` runs take exact steps. WebUSB
  passthrough and WebHID devices are refused in deterministic mode (a real device isn't deterministic).

### The WebUSB passthrough backend (device worker)

- **At attach:**
  1. Open the device, and select configuration 1 if it has none.
  2. Read the **raw** descriptors through `controlTransferIn` GET_DESCRIPTOR: device, every configuration, BOS,
     the language IDs and every string they reference.
  3. Claim every non-protected interface of the active configuration and filter the protected ones out of the
     served descriptors.
  4. Infer the speed:
     - SuperSpeed endpoint companions or `bMaxPacketSize0` = 9 → SuperSpeed on a USB 3 port.
     - Otherwise a bulk `wMaxPacketSize` of 512, an interrupt endpoint over 64, an isochronous one over 1023, or
      high-bandwidth bits (11–12) → high speed (full speed allows isochronous packets up to 1023 bytes).
     - Otherwise an 8-byte endpoint 0 with ≤ 8-byte interrupt endpoints → low speed.
     - Otherwise full speed.
     U3 checks the heuristic on real devices. The guest's xhci-hcd validates packet sizes against the speed, so a
     wrong guess shows up at Configure Endpoint, not as silent corruption.
- **Standard requests the guest sends:**

  | Request | What the backend does |
  |---|---|
  | GET_DESCRIPTOR | answers from the cache (configuration descriptors filtered); unknown types pass through |
  | SET_ADDRESS | never reaches the backend (Address Device is the core's) |
  | SET_CONFIGURATION *n* | `selectConfiguration(n)` if it changes, re-claim, refresh the cache; *0* releases the interfaces |
  | SET_INTERFACE | `selectAlternateInterface` |
  | CLEAR_FEATURE(ENDPOINT_HALT) | `clearHalt` (Linux also sends it after a Reset Endpoint) |
  | SET/CLEAR_FEATURE (remote wakeup, U1/U2), SET_SEL, SET_ISOCH_DELAY | answered success locally |
  | GET_STATUS, GET_CONFIGURATION, GET_INTERFACE | pass through |

  Class and vendor requests pass through to the interface, endpoint or device they name.
- **Transfers:** each TD is one WebUSB call. Bulk and interrupt IN use `transferIn(ep, TD length)`. OUT gathers
  the segments into one buffer for `transferOut`. A TD that ends with the zero-length TRB that Linux adds for
  `URB_ZERO_PACKET` sends a separate empty `transferOut`. The backend keeps several transfers in flight per
  endpoint, as the guest queues them; WebUSB completes them in order per endpoint.
  Results map to completion codes:
  - `ok` → Success, or Short Packet when fewer bytes than asked.
  - `stall` → Stall.
  - `babble` → Babble.
  - A rejected promise (the device gone, a host error) → USB Transaction Error.
- **IN data outlives a cancel.** A cancelled IN transfer can't be withdrawn from WebUSB, and the device may already
  have sent its data. When the orphaned transfer resolves, its bytes go into the endpoint's carry-over queue and are
  delivered to the next IN TD on that endpoint. While an orphan is pending, no new `transferIn` is issued for that
  TD's bytes. The guest's next read then gets what it would have received from a real host whose URB was cancelled
  just after the data arrived. Nothing is lost or reordered. The cost is that an endpoint nobody reads again keeps
  one transfer pending until detach. An orphaned OUT has already been sent, as on hardware when the packet left
  before the unlink. usbtest's unlink tests and closing a `cdc_acm` tty exercise this path.
- **Detach:** the `disconnect` event or the page's Detach button clears the port's connect status. In-flight TDs
  complete with Transaction Error and the device is closed.
- **Reset** from the guest after the first one: `device.reset()`. On some hosts this re-enumerates the device and
  WebUSB loses it; the backend then reports a detach, and the `connect` path re-attaches it when its identity is
  unchanged. U3 measures this.
- **Snapshots:** the controller's state is in the core's snapshot. A passthrough device can't be in it: a machine
  is snapshotted only with its ports empty, as a machine with a live video codec can't be snapshotted mid-stream
  ([video.md](video.md) §9). §4a says how the page gets there without just refusing.

### The WebHID backend (an emulated HID device, device worker)

- **At attach:** open the `HIDDevice`, and build the guest's descriptors from it:
  - The device descriptor: its vendor and product IDs, `bcdUSB` 2.00, a product string from `productName`, no
    serial number (a fixed one per port, so the guest's udev names stay stable).
  - One configuration with one interface, class 0x03, subclass and protocol 0, and the HID class descriptor.
  - The interrupt IN endpoint's `wMaxPacketSize` is the largest input report (plus its report ID byte), up to 1024;
    the device is high speed when that exceeds 64 and full speed otherwise. `bInterval` is 1 ms: WebHID doesn't say
    how often the real device reports, and the reports arrive when they arrive anyway. An interrupt OUT endpoint is
    added when the device has output reports.
  - The report descriptor, encoded from `collections`: each collection's items in order, report IDs where the
    device uses them, globals emitted only when they change. A round trip in Node checks it: encode, parse with our
    parser and with a recorded copy of Chromium's parse, compare.
- **Requests:** GET_DESCRIPTOR (device, configuration, string, HID and report) is answered from what was built.
  HID class requests:

  | Request | What the backend does |
  |---|---|
  | GET_REPORT (input) | the last input report with that ID, or zeros of its length before the first one |
  | GET_REPORT (feature) | `receiveFeatureReport` |
  | SET_REPORT (output) | `sendReport` |
  | SET_REPORT (feature) | `sendFeatureReport` |
  | SET_IDLE, GET_IDLE, SET_PROTOCOL, GET_PROTOCOL | answered locally (no boot protocol is offered) |

  The standard requests are the core's and the backend's alone, as with any virtual device.
- **Transfers:** each `inputreport` event becomes one completion of the oldest queued IN TD on the interrupt
  endpoint, with the report ID byte in front when the device uses IDs. Reports that arrive with no TD queued wait
  in a short queue (the guest's usbhid always keeps one URB queued, so it stays empty in practice), and the oldest
  is dropped past a few dozen, as a real device would have overwritten them. An OUT TD is one `sendReport`, its
  first byte the report ID when the device uses IDs. A rejected `sendReport` is a Stall.
- **Cancel** is trivial here: nothing is in flight in the browser for an IN TD, so a cancelled TD is just removed.
- **Detach:** WebHID's `disconnect` event or the page's Detach clears the port's connect status and closes the
  device. A Bluetooth game pad that sleeps and wakes comes back through `connect` and is re-attached on the same
  port.
- **Snapshots:** as for passthrough, the ports are emptied first (§4a). The emulated device's state (idle rate,
  the last reports) is small, so a later step could save it and re-open the `HIDDevice` at resume, keeping a game
  pad across Suspend without the guest seeing an unplug.

### Virtual devices

- **Gadget Zero** (`0525:a4a0`: source/sink and loopback configurations, as Linux's `g_zero`), in TypeScript with a
  Rust twin. The guest's `usbtest` driver and `testusb` tool test control, bulk, interrupt, unlink and halt paths
  against it in every runner, with exact step counts. It is what tests the controller.
- Later, for their own reasons and not part of this plan: a USB keyboard and tablet would give EDK2 a keyboard on
  the screen. EDK2's `XhciDxe` takes a non-discoverable xHCI registered by a small DT-reading driver, which would
  close backlog "A real keyboard driver in EDK2". A USB mass-storage disk is another candidate.

## 4a. Machines ([machines.md](machines.md))

The split follows what the guest sees. The **controller** is part of the machine's shape, like the network card,
because the guest sees a DT node. **Devices** are not part of the shape, because they are hot-plugged: a snapshot
restores onto a machine whether or not a device is plugged in. Devices are the machine's **remembered devices**.

- **The controller in the record and the shape.** `MachineRecord.usb: boolean`, beside `network`. The shape gains
  `usb: true` only when it is on, and the key is left out when it is off, so the canonical JSON and the shape hash of
  every existing machine stay as they are and no snapshot is orphaned by the upgrade. The ports (4 USB 2, 4 USB 3)
  are fixed, so the flag is all the shape needs; if they become a setting, their counts join the shape then.
  - New machines get it on.
  - Existing machines keep it off until the user turns it on in Settings. Settings says that this orphans the
    machine's snapshots, as a RAM change does.
  - The xHCI is not a virtio transport, so `slots()` and the room kept for 16 disks don't change.
  - Transient machines (the tests') take `?usb=1`; without it their guests and step counts stay as they are.
- **Remembered devices** are a list in the machine record. Each entry has:
  - an id;
  - the API (`usb` or `hid`);
  - the vendor and product IDs, the serial number where there is one, and the product name;
  - the root port it goes on;
  - *attach at start*.

  The port is fixed per entry, so the guest's `/dev/serial/by-path` names and udev rules stay stable from one boot
  to the next. A device that both APIs reach (HID beside CDC on one board) is two entries and two guest devices.
  Identical devices without serials are matched in `getDevices()` order, and the USB tab says so.
- **Permission is easier than for files.** WebUSB and WebHID grants persist per origin, so at start the page finds
  remembered devices with `getDevices()`, with no click, unlike a file handle (machines.md §3.2). Forgetting an entry
  that no other machine remembers calls `device.forget()`, which revokes the grant.
- **One machine at a time per device.** A Web Lock named after the device's identity is held while it is attached.
  WebUSB's interface claims are exclusive anyway. Two tabs could both open a WebHID device and both read its input,
  so the lock makes the rule explicit. Attaching a device that another machine holds says which machine has it and
  offers Detach there, through the store's `BroadcastChannel`.
- **Attach and detach work while the machine runs.** Unlike disks (machines.md §4.1), that is what hot-plug is for.
  Editing the remembered list doesn't need the machine off either. *Attach at start* attaches at power-on: EDK2
  doesn't drive the xHCI, and Linux enumerates the device as it boots.
- **A device that isn't plugged in** is skipped at start without an error. The USB tab shows each entry's state:
  attached, plugged in, not plugged in, or held by another machine. When the device appears later (`connect`), an
  entry with *attach at start* attaches then.
- **Snapshots and Suspend empty the ports first.** The toolbar's Snapshot is meant to be a one-click panic button
  (machines.md decision 14), so it doesn't simply refuse. With devices attached it asks once to detach them, naming
  them, because the guest sees an unplug and anything mid-transfer breaks (an `adb push`, a firmware flash). Then it
  detaches them, saves, and attaches them again. The controller completes the in-flight TDs with errors at the
  detach, so its saved state is consistent without waiting on the guest. A restored snapshot has empty ports. After
  the restore, the machine's *attach at start* entries are hot-plugged as they would be at a start. The shape isn't
  involved, so nothing is orphaned.
- **Definitions** (machines.md §6) carry `usb` and the remembered entries' identities. No grant travels with them:
  on another browser or computer, the first start lists the entries that have no grant and offers one click each
  (`requestDevice` filtered on vendor, product and serial). That is the same flow as re-picking a file. An entry the
  user skips stays in the list as not granted.
- **Re-enumeration** (DFU, fastboot, firmware loaders: §2) adds the new identity as an entry of its own, on the same
  port, so the second flash needs no click at all.
- **The Machines page:**
  - A **USB** tab beside Disks and Network. It holds the controller switch (also in Settings, where the shape's
    settings are), the remembered devices with their state, and Attach, Detach, attach at start and Forget.
  - **Add a device…** is a wizard, as Add a disk is (machines.md decision 16). It asks for the kind first, each
    explained: a USB device (WebUSB: developer and maker hardware, phones, serial adapters) or a HID device
    (WebHID: game pads, macro pads, a keyboard's configuration interface). Then it opens the browser's chooser.
  - The toolbar gets a USB quick menu for the running machine: its remembered devices with attach toggles, Add a
    device…, and the "a device just appeared" offer.
- **What changes:**
  - `web/app/shape.ts`: `usb` in the record and the shape, and its line in `shapeDiff`.
  - `web/app/store.ts`: the record's fields.
  - `web/app/definitions.ts`: export and import.
  - A `Usb.svelte` tab, the toolbar menu, and the device locks.

## 5. Testing

- **Unit:** the controller on hand-built command, transfer and event rings (`cargo test`). The request mapping and
  the descriptor filter in Node (`tests/usb.test.ts`).
- **Every runner (native, Node, Chromium):** Buildroot with `xhci-plat-hcd`, `usbtest` and `testusb`. The fragment
  gains `CONFIG_USB`, `CONFIG_USB_XHCI_HCD`, `CONFIG_USB_XHCI_PLATFORM` and `CONFIG_USB_TEST`. The run uses
  `testusb -a` against the virtual Gadget Zero, with exact steps, and hot-plug and unplug mid-test.
- **Real WebUSB, end to end, in the dev VM:** Lima's `vz` passes no host USB devices through, so the test device
  comes from the VM's own kernel. `dummy_hcd` plus a configfs gadget (`f_sourcesink` and `f_loopback`: Gadget Zero
  for real; `f_acm` for a CDC device) appears to Chromium as a USB device. Setup:
  - `usbtest` and `cdc_acm` are blocklisted on the host side so the gadgets stay free.
  - A udev rule opens them to the user.
  - Permission comes without a prompt, through the `WebUsbAllowDevicesForUrls` policy (U0: the DevTools
    protocol's prompt handling doesn't work for WebUSB).

  The guest then runs the same `testusb -a` through the real Chromium and usbfs stack. It goes in
  `scripts/ci-usb.sh`, the script for tests that need the dev VM's host rigs, never in `ci.sh` or `ci-debian.sh`.
  Without the rigs it is skipped. Cloud containers can't load modules.
- **Oracle:** QEMU (`qemu-xhci` on PCI with `usb-host` on the same dummy gadget) in the dev VM,
  `tests/usb/oracle.sh`. The same `testusb` results and QEMU's `usb_xhci_*` trace events are compared on
  behavior: event order, completion codes, residuals. The linux-usb guest has no tracepoints of its own.
- **WebHID, end to end, in the dev VM:** the VM's kernel makes the test device again, this time through `uhid`
  (`/dev/uhid`): a small rig of ours creates HID devices from recorded report descriptors (a DualSense, a Stream
  Deck, a vendor collection with feature reports, a device with report IDs and one without), and Chromium sees each
  as a `hidraw` device. Permission comes through the `WebHidAllowAllDevicesForUrls` policy, as for WebUSB. The
  guest's view is checked against the rig: `/sys/.../report_descriptor` parses to the same items, `hid-tools`'
  `hid-recorder` sees the input reports the rig sends, and output and feature reports written in the guest arrive
  at the rig. In `scripts/ci-usb.sh`, skipped when `/dev/uhid` isn't usable.
- **Real devices, by the user** (the dev VM has none): a checklist in U5.

## 6. Steps, when scheduled

- **U0: gates and measurements** (no core code):
  1. `navigator.usb` and `navigator.hid` in a dedicated worker on the pinned Chromium, and `getDevices()` there
     after the page's grant.
  2. The dummy_hcd gadget visible to the Playwright Chromium, with permission granted without a prompt.
  3. One WebUSB transfer's round trip and bulk throughput from a worker (to size what a guest can expect).
  4. Which guest kernels have `xhci-plat-hcd`: Debian (expected, for the DWC3), the Arch desktop image,
     Alpine's `virt` kernel (unknown), and Buildroot (ours to add).
  5. The QEMU oracle on the same gadget.
  6. A `uhid` device visible to the Playwright Chromium's WebHID, with permission granted without a prompt, and
     which collections Chromium hides on the recorded descriptors.
- **U1: the controller.** `core/src/xhci.rs`, the DT node, `VmConfig.xhci`, the ABI bump, snapshot state, and unit
  tests. `usb` in the machine record and the shape, left out when off, with a test that an existing machine's shape
  hash doesn't move. Buildroot binds `xhci-plat-hcd` and shows two empty root hubs, in every runner.
- **U2: the backend protocol and Gadget Zero.** `web/usb.ts`, its twin, and `testusb -a` passing with exact steps,
  hot-plug included. Plant a bug in the controller and check that `testusb` catches it.
- **U3: WebUSB passthrough.**
  - The backend of §4, run against the dummy_hcd gadget end to end: the same `testusb -a`, now through Chromium.
  - The CDC gadget with the guest's `cdc_acm`: open, echo, close and reopen, which exercises the carry-over.
  - The speed heuristic and the descriptor filter on recorded descriptors of real devices.
- **U3h: the WebHID backend.** It needs U2 only, so it can come before U3 or beside it.
  - The report-descriptor encoder and its round trip in Node.
  - The backend of §4 against the `uhid` rig end to end.
- **U4: the page,** as §4a has it:
  - The USB tab and the Add a device… wizard: WebUSB's `requestDevice` with no filter, or WebHID's with an empty
    filter list, which lists every device it may show.
  - Remembered devices, attach at start and the device locks.
  - The toolbar's menu, and the "a device just appeared" offer.
  - Snapshot and Suspend emptying the ports and re-attaching after.
  - Definitions with their entries, granted again on another profile.
  - Clear messages for a protected or host-held interface, and for a HID device whose every collection is hidden
    or whose `hidraw` node the user can't open.

  The page tests go in `scripts/ci-machines.sh`'s set.

  Document it in [frontend.md](../frontend.md) and a new `docs/usb.md` (or a section of devices.md).
- **U5: breadth, with the user's hardware:**
  - an Android phone (`adb shell`, `adb push` throughput, `fastboot devices` after a reboot into the bootloader)
  - a Pico or Arduino over CDC-ACM with the host driver unbound
  - an FTDI or CP210x adapter
  - `dfu-util`
  - an RTL-SDR (`rtl_test`: about 4.8 MB/s of bulk IN without drops, a useful throughput target)
  - a sigrok logic analyser (firmware upload, then re-enumeration)
  - through WebHID: a DualSense or DualShock 4 (hid-playstation: buttons, sticks, rumble, the light bar, over USB
    and Bluetooth), a Switch Pro controller (hid-nintendo), a Stream Deck, a keyboard's VIA configuration, a UPS
    (`upower` or NUT)

  What fails becomes a backlog line or a fix. **Closed 2026-10-18** with the devices the user has: an RTL-SDR, an
  FTDI adapter and a wired Xbox controller ("U5 findings"); the rest is in backlog.md "USB".
- **U6 (optional, its own OK):** isochronous transfers, and the USB keyboard for EDK2 (§4, "Virtual devices").

## U0 findings (2026-10-18)

Measured on the dev VM: Chromium 153.0.8010.52 headless through Playwright, kernel 7.2.9-1-default, QEMU 11.1.2.
The rigs and how to bring them up are in [testing.md](../testing.md) "USB: the dev VM's host rigs".

- **Workers:** `navigator.usb` and `navigator.hid` exist in a dedicated worker. `getDevices()` there lists the
  granted devices, and opening a device, transfers, input reports, `sendReport` and the feature reports all work
  in the worker. The device worker owns its devices, as §2 and §2a planned. No `MessagePort` fallback is needed.
- **Permission without a prompt:** only the managed policy works. `/etc/chromium/policies/managed/` is read by the
  pinned Chromium, also when Playwright launches it. `WebUsbAllowDevicesForUrls` grants the 0525 gadgets and
  `WebHidAllowAllDevicesForUrls` grants every HID device, both for exact origins only (`http://127.0.0.1:8190`–`8197`;
  another port gets nothing). The DevTools protocol's `DeviceAccess.deviceRequestPrompted` never fires for WebUSB
  or WebHID. `requestDevice` in headless Chromium just waits, even with a user gesture, so no test can drive the
  chooser. Tests of the page's own Allow flow keep faking the API (`tests/page-usb.test.ts`).
- **`getDevices()` order** is the same on every call within a browser session, in the page and in a worker alike.
  Across browser launches, two serial-less Gadget Zeros came back in either order (6 launches, 3 of each). Matching
  identical devices by index therefore holds within a session only; docs/usb.md says what that means for
  remembered devices.
- **WebUSB's cost per transfer** (Gadget Zero on dummy_hcd at high speed, from a worker; a sizing with other
  work on the VM, not a benchmark): a control or bulk transfer takes 0.335 ms (median, p99 0.36–1.2), against
  0.20 ms through usbfs natively, so **WebUSB adds ~0.13 ms per transfer**. The 0.20 ms floor is dummy_hcd's own
  timer. An echo (OUT, then IN) takes 0.665 ms against 0.405. A guest driver that waits on each transfer gets about
  3,000 a second. Bulk transfers of 1 MiB move ~180 MB/s (70–80% of native), so throughput is no limit for a
  high-speed device. On dummy_hcd more transfers in flight were slower (64 KiB: 112 MB/s at one, 37 at eight); it
  isn't known whether that is dummy_hcd or Chromium. usbfs caps buffered transfers at 16 MiB
  (`usbcore.usbfs_memory_mb`), shared by every device Chromium has open: sixteen 1 MiB transfers in flight failed.
  The numbers and JSON are in `bench/usb/` (`results/2026-10-18-sizing.json`).
- **Guest kernels** (`xhci-plat-hcd`, then `usbtest`, `cdc_acm`, `usbhid`, `hid-generic`, `uhid`):

  | Guest | `xhci-plat-hcd` | the rest |
  |---|---|---|
  | Debian 13 (6.12.107+deb13-arm64) | module, autoloaded by its `of:…Cgeneric-xhci` alias | all modules; `hidraw` built in |
  | Arch desktop (7.2.9-arch1-1) | **built in** (with usbcore, xhci-hcd, hid, hid-generic, usbhid) | `usbtest`, `cdc_acm`, `uhid`, `hid-playstation` modules |
  | Alpine `linux-virt` (6.18.52, our alpine images) | **missing** (only `xhci-pci`) | `usbhid`, `hid-generic`, `uhid` modules; no `usbtest`, no `cdc_acm` |
  | Alpine `linux-lts`, `linux-stable` | module (pkgs.alpinelinux.org) | `usbtest`, `cdc_acm` in lts's config |
  | our Buildroot kernel (`linux`) | none (`CONFIG_USB_SUPPORT` off) | the `linux-usb` guest has what the tests need |

  So Alpine on `linux-virt` sees no controller; §8's remedy is `linux-lts`.
- **The QEMU oracle** (`tests/usb/oracle.sh`: linux-usb on `qemu-xhci` with `usb-host` on the dummy_hcd Gadget
  Zero, one boot per test): every testusb test passes or is skipped by usbtest for this device except **test 24**
  (unlink from queues of writes). It hangs every time on QEMU. With 32-deep queues the guest's xhci-hcd logged
  events for TRBs outside any TD first, so this is QEMU's `qemu-xhci`/`usb-host`, not the gadget. Ours: the xhci
  lane's `testusb -a` passes on our virtual Gadget Zero (all tests, 24 among them), and through WebUSB on the
  dummy_hcd gadget (`tests/usb-guest.test.ts` in `ci-usb.sh`) once the passthrough answers halts itself (§2's list
  of refused requests gains SET_FEATURE(ENDPOINT_HALT), and GET_STATUS and CLEAR_FEATURE on endpoint 0).
- **WebHID's parse** of the uhid rig's six descriptors is recorded in `tests/usb/hid-fixtures/`. What the backend
  needs to know:
  - Reports within a collection don't come in descriptor order (a vendor collection's input reports came as 2, 6,
    1). The order is the same from run to run. Usages are 32-bit (page << 16 | usage), and constant padding items
    are listed.
  - **Protected collections**, on a keyboard composite: the Keyboard collection stays, with only its feature
    report (no input, no LED output). System Control goes entirely. The Mouse collection stays as an empty
    application collection, though its Pointer child still lists its input report. At runtime the keyboard's and
    mouse's input reports never arrive, and `sendReport` to the LED report is a `NotAllowedError`. Consumer Control
    and vendor collections work. A game pad's Pointer physical collection isn't protected.
  - **Framing:** an `inputreport` event's data has no report ID byte (`reportId` carries it), but
    `receiveFeatureReport`'s data starts with the ID when the device uses IDs. Without IDs the ID is 0 and nothing
    is prefixed. On Linux the host's hidraw sees a 0 byte in front of a no-ID device's output and feature writes.
  - The transcribed DualSense descriptor is accepted by the host's own `hid-playstation`, which reads its feature
    reports and sends 64-byte output reports through it. That checks the sizes against a real driver.
- **Host rigs:** openSUSE doesn't ship `dummy_hcd`. `tests/usb/gadget.sh install` builds it from kernel.org's source
  for the running kernel. Installing `qemu-hw-usb-host` for the oracle moved QEMU to 11.1.2.

**What changed in the plan:** the device worker owns WebUSB and WebHID devices, with no fallback. Permission in
tests is the managed policy only. The rig tests go in `scripts/ci-usb.sh` (§5), not `ci-debian.sh`. The
`getDevices()` index of serial-less twins is per session (§2, §4a; docs/usb.md). Alpine `linux-virt`'s missing
`xhci-plat-hcd` is confirmed (§8).

## U5 findings: real devices (2026-10-18)

The user's devices on the Mac mini (macOS 26.6.2), Chrome for Testing 153.0.8010.12 headless on the Mac, driven
over the DevTools protocol from the dev VM, which served the page through an SSH tunnel (the recipe is in
[testing.md](../testing.md) "USB: real devices on the Mac"). The guest is Debian 13 (6.12.107+deb13-arm64) on a
stored machine with the controller on and both devices remembered, attached at start.

- **Permission on macOS:** Chrome for Testing reads its policies from the `com.google.ChromeForTesting` domain
  (`/Library/Managed Preferences/com.google.ChromeForTesting.plist`), not from its bundle identifier
  (`com.google.chrome.for.testing`), and only after `cfprefsd` is restarted.
- **A Nooelec NESDR SMArt v5** (RTL2832U, `0bda:2838`, vendor class, high speed):
  - the speed heuristic says high, right; both interfaces claim (macOS has no driver for it);
  - Debian's `dvb_usb_rtl28xxu` and `rtl2832_sdr` initialise it whole (the tuner over I²C tunnelled in control
    transfers; a DVB adapter, `swradio0` and the IR receiver);
  - bulk IN through `/dev/swradio0`, 10 URBs of 64 KiB queued: **4.80 MB/s at 2.4 MS/s** (the plan's `rtl_test`
    target) and **6.40 MB/s at 3.2 MS/s** (the chip's highest rate), exactly the device's rate, with no loss. The
    guest resubmits each URB 0.3–0.5 ms after its completion. A stream's start costs ~1.6 s (the tuner's setup in
    many small control transfers);
  - unplugged and plugged back while the guest ran: the guest saw the disconnect, and the page's attach-at-start
    entry put it back on the same connector (`1-1`), where the driver initialised again.
- **An FTDI FT232R** (`0403:6001`, full speed): macOS's `AppleUSBFTDI` (DriverKit) holds its interface, yet Chrome's
  `claimInterface` succeeds and takes it over: on macOS this adapter needs no remedy. The heuristic says full speed,
  right. Debian's `ftdi_sio` attaches `/dev/ttyUSB0`; with TX wired to RX, random data comes back whole at 115200,
  1M and 3M baud (the chip's highest), at 96–97% of the line rate.
- **A PowerA wired Xbox Series X controller** (`20d6:2001`, full speed, class `ff/47/d0`: Xbox One's GIP, not HID,
  so WebUSB's and not WebHID's): both interfaces claim on macOS. Its audio interface's alternate setting has
  228-byte isochronous endpoints, which **the speed heuristic took for high speed**; full speed allows isochronous
  packets up to 1023 bytes, so only larger ones, or high-bandwidth bits, now mean high speed (§4; the device is a
  recorded fixture in `tests/usb/webusb-fixtures.ts`, with the NESDR and the FT232R). Debian's `xpad` binds it
  (`js0`), and every button, both sticks, both triggers and the pad reach the guest's event device. A GIP controller
  sends nothing until the host's init packet, so the interrupt OUT works too.
- **Chrome for Testing on macOS** listed none of the policy's devices in a profile it had used before (the page
  never calls `forget()` but from Forget), and all of them in a fresh one. So the recipe starts each session with a
  fresh profile.

## 7. What WebUSB can't attach, and where it should go instead

| Device | Route |
|---|---|
| Keyboards, mice, tablets | already the page's input, as virtio-input |
| Game pads, other HID | WebHID → an emulated USB HID device (§2a, §4 "The WebHID backend") |
| Game pads that aren't HID on the host (wired Xbox controllers under XInput or xpad) | the Gamepad API → an emulated USB HID game pad with a fixed descriptor of ours (its standard mapping; no rumble beyond `vibrationActuator`). Small, on the same controller; its own step after U4 if wanted |
| Flash drives, disks | the disk path the page has (Open disk, a second disk); a raw USB disk is out of reach in a browser |
| Webcams, microphones, headsets | `getUserMedia` (the page already records through virtio-snd: [audio.md](../audio.md)); a camera would be an emulated UVC device or a virtio-video, a plan of its own |
| Serial adapters held by the host's driver | WebSerial → a virtio-console port (the multiport work in [agent.md](agent.md)) |
| Bluetooth adapters | none in the browser (Web Bluetooth is GATT-level only) |

## 8. Risks and open questions

- **Host-driver friction** decides how many devices "just work": Linux users with `cdc_acm` loaded, and Windows
  without WinUSB. The page's messages matter as much as the emulation.
- **Latency:** each transfer crosses guest driver → xHCI → device worker → Chromium's USB service (Mojo IPC) →
  the host OS. Chatty protocols, such as debug probes doing many small control transfers, may be slow. U0's
  measurement says how slow. Batching can't help, because the guest waits on each transfer.
- **Re-enumeration flows** (DFU, firmware loaders, adb ↔ fastboot) depend on the user clicking at the right
  moment. The guest may time out first, and some tools retry, others don't. Measured in U5.
- **Carry-over correctness** for drivers that read an endpoint, cancel, and then expect the *next* data to be fresh
  (rare; a protocol with sequence numbers would notice). Watched in U5.
- **Rebuilt report descriptors** that a guest driver doesn't accept, because it patches the original by its bytes
  or checks its length. Found per device in U5; a table of known originals keyed by vendor and product could serve
  those few devices their real descriptor when its parse matches WebHID's.
- **Guest kernels without `xhci-plat-hcd`** get nothing. Alpine's `linux-virt` is one (U0); `linux-lts` and
  `linux-stable` have it. That is a reason to ask the distribution, and to recommend `linux-lts` there meanwhile.
- **Parallel SMP:** the controller sits under `Vm::plat` like the transports. A busy device's completions take the
  lock at chunk boundaries as virtio's do, so no new design is needed. Check it under the stress runs.
