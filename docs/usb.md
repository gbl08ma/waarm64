# USB

USB devices from the user's computer reach the guest through an emulated xHCI. The plan, and the reasons
behind it, are in [plans/usb.md](plans/usb.md). The controller is the core's (`core/src/xhci.rs`). Its
devices are backends in the device worker, behind the glue in `web/usb.ts`. The device interface every
backend implements is `UsbDevice` in `web/usb-device.ts`, and the page's messages about the root
connectors are defined there too.

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
  none is lost. Events don't go into the ring while the controller is halted.
- **Commands:** Enable and Disable Slot, Address Device (with BSR), Configure Endpoint (with Deconfigure,
  drop and add flags), Evaluate Context (the slot's exit latency and interrupter, EP0's packet size),
  Reset Endpoint (a halted endpoint is stopped), Stop Endpoint, Set TR Dequeue Pointer, Reset Device
  and No-Op. Anything else is a TRB Error. Wrong states give Context State Error (Linux reads the output
  context to recover). Slots and endpoints that aren't enabled give Slot or Endpoint Not Enabled. The
  controller keeps the output device context current: slot state and address, each endpoint's state,
  and its dequeue pointer when it stops or halts.
- **Transfer rings:**
  - TRB types: Normal, Setup/Data/Status (a control transfer runs from its Setup TRB to its Status TRB),
    Isoch, Link (Toggle Cycle), Event Data and No-Op. A TD is its TRBs up to the one without Chain.
  - A TRB whose cycle bit isn't the ring's yet ends the walk until the next doorbell. Linux writes a TD's
    first TRB last.
  - Immediate data (IDT) goes into the request record.
  - Anything wrong is a TRB Error event, and the endpoint halts: a TRB out of RAM, a type that doesn't
    belong (a Setup TRB on a bulk ring), a TD over 1024 TRBs, a buffer outside RAM, immediate data on
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
  - Event Data TRBs report their parameter, with the bytes since the last one.
  - BEI suppresses the interrupt.
- **Stop Endpoint:**
  1. What the backend finished is taken first, so no completed TD is cancelled.
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
that posted it. When every vCPU is idle (round-robin's `idle`, a parallel vCPU going to WFI), they are
written at once. The run loops look at the controller's next due time between chunks. In parallel SMP
it is `Shared::xhci_due`, so no lock is taken until something is due. A snapshot takes them at once.

Without it, a device that answers before the guest's CPU has moved on keeps the CPU in its interrupt
handler for good. usbtest's unlink tests resubmit a URB from its completion. Against an instant Gadget
Zero, process context never ran again, and the test's `msleep` never returned: 80,000 completions in a
minute, natively. With the latency the guest pays nothing when it waits (idle time is skipped in
deterministic mode), and testusb's run takes ~140M steps.

### Snapshots

`Xhci::save` keeps the registers, the ports' registers, each slot and endpoint's state with its rings'
positions, the event ring's producer and segment table, and the events waiting for room. It needs the
ports empty and nothing in flight. A machine with a device plugged in can't be saved:
`vm_snapshot_size` returns `u64::MAX` and `vm.snapshot()` says to detach it. The detach completes
in-flight TDs with errors, so the state is consistent without waiting on the guest (plans/usb.md §4a).
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

The core keeps at most 1024 TDs posted and not completed, so the completion ring never fills. Records
that don't fit the request ring wait in order, and are posted after the next completions.

**The glue** (`web/usb.ts` `Usb`, in `Devices`; natively `core/tests/common/usb.rs`):
- It reads a poll's records all at once. A transfer whose cancel is in the same batch never reaches its
  device: in realtime mode the guest may already have its buffer back.
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
- No isochronous alternate setting (U6), and no interrupt endpoints (f_sourcesink has none now).

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
   protected when any of its alternate settings has a class WebUSB refuses (plans/usb.md §2).
5. The configuration descriptors the guest gets leave out the protected interfaces, and the ones that
   failed to claim. A dropped interface takes with it its descriptors up to the next interface or
   IAD. `bNumInterfaces` and `wTotalLength` are rewritten. An IAD shrinks to the interfaces left in
   its range, and is dropped when none is left. Interface numbers are not renumbered, because the
   guest addresses requests by them. Linux logs a notice for the gap and binds the rest.
6. The speed is inferred from the descriptors:
   - **super:** a SuperSpeed endpoint companion, or `bMaxPacketSize0` = 9
   - **high:** a 512-byte bulk endpoint, or an interrupt or isochronous endpoint over 64 bytes
   - **low:** an 8-byte endpoint 0 with only interrupt endpoints of at most 8 bytes, and no bulk or
     isochronous ones
   - **full:** anything else

   A BOS that only declares SuperSpeed *capability* doesn't make a device super. An Android phone at
   high speed has one.

**Problems** are reported in `problems` (`UsbProblem`), and `notes()` turns them into the page's lines:
- `protected-interface`: a protected interface.
- `claim-failed`: an interface the host's OS holds. The message names the remedy for the host's OS
  (from the user agent). On Linux it names the driver that most likely holds the interface (`cdc_acm`,
  `usblp`, `ftdi_sio`, `cp210x`, `ch341`, `pl2303`, `dvb_usb_rtl28xxu`) and how to unbind it. On
  Windows it names WinUSB and Zadig.

A device left with no interface it can use fails to open with a `UsbOpenError`, which carries the
problems.

**Standard requests:** these are answered or interpreted by the backend. The rest pass through.

| Request | Here |
|---|---|
| GET_DESCRIPTOR device, configuration (filtered), BOS, cached strings | from the cache. A string not in the cache (a Microsoft OS string, an index only a class descriptor names) and other types pass through |
| SET_CONFIGURATION *n* | the active one: alternate settings back to 0. Another: release, `selectConfiguration`, claim again. *0*: release everything (GET_CONFIGURATION then answers 0) |
| SET_INTERFACE | `selectAlternateInterface`. An interface we don't hold, or an alternate it doesn't have, stalls |
| CLEAR_FEATURE(ENDPOINT_HALT) | `clearHalt`, and a stall carried over on that endpoint is spent |
| SET_FEATURE(ENDPOINT_HALT) | passed through (usbtest's halt test). Whether Chromium allows it is unchecked |
| other SET/CLEAR_FEATURE, SET_SEL, SET_ISOCH_DELAY | success, locally |
| GET_STATUS, GET_INTERFACE, SYNCH_FRAME | pass through. GET_INTERFACE on an interface we don't hold stalls |

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
- Isochronous TDs complete with `error` until U6.

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

**Reset** (after the attach's first) drops every endpoint's state, calls `device.reset()`, and claims
again whatever the reset released. A reset that fails, which on some hosts means WebUSB lost the device
when it re-enumerated, calls `gone`. **Detach** completes nothing more, then releases the interfaces and
closes the device.

**Tests:** `tests/usb-webusb.test.ts` runs the backend against a scripted fake (`tests/usb/fake-webusb.ts`).
The fake answers GET_DESCRIPTOR from raw descriptors, refuses protected classes as Chromium does, refuses
interfaces a "host driver" holds, and leaves each IN pending until the test answers it. The descriptors in
`tests/usb/webusb-fixtures.ts` are **transcribed** from public documentation and `lsusb -v` layouts, not
recorded:
- an FTDI FT232R, a CP2102, an RTL2832U
- a Pico with CDC and its reset interface, with a BOS
- an Android phone in MTP and adb
- a DAPLink with mass storage, CDC, HID and vendor interfaces
- an FX3 at SuperSpeed
- a low-speed USBasp

U5 replaces them with the user's dumps.

## The WebHID device (`web/webhid.ts`, `web/hid-descriptor.ts`)

`openWebHid(device, {serial})` builds an emulated USB HID device from a `HIDDevice`
(`WebHidDeviceLike`) and opens the device if it isn't open. The device is built on `VirtualDevice`
(`web/usb-virtual.ts`), which answers chapter 9 from the descriptors.

The device worker's opener, `webHidOpener(navigator.hid)`, finds the device by vendor and product, with
`index` among identical ones, since WebHID gives no serial number. It gives the guest the serial
`webpc-hid-<connector>`, and calls `gone` on WebHID's `disconnect`. A device whose every collection
WebHID hides fails with `no-collections`.

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

**Encoding the report descriptor:** `encodeReportDescriptor(collections)` writes each collection as its
usage page (when it changes), its usage, and a Collection item of its type. Then come its children and
its reports. For each report, the encoder writes its Report ID (when it changes) and its items. Each item
gets:
- The globals that changed. Logical and physical values use the shortest *signed* encoding, so 255 is
  `26 ff 00` and no parser can read it as -1. A maximum WebHID reads as negative over a non-negative
  minimum gets 4 bytes. The unit exponent is a nibble, and the unit is rebuilt from `unitSystem` and
  the six factor exponents.
- Its usages as 16-bit IDs on the current page. A usage on another page is written as an extended
  32-bit usage. A range is written as Usage Minimum and Maximum.
- The main item, with all nine flag bits. Buffered bytes makes it a 2-byte item.

**Parsing:** `parseReportDescriptor(bytes)` reads a descriptor into the same shape, grouped the way
Chromium groups it. Each main item goes to its innermost collection, in a report per type and report ID.
Usages resolve against the usage page in force at the main item. Push and pop are kept. A logical or
physical maximum is signed when its minimum is negative, and unsigned otherwise, read as int32 as
WebHID's are.

**What doesn't come back** from WebHID's form:
- the original bytes: the order of global items, push and pop, delimiters
- string indices, since WebHID resolves no strings
- how one report ID's items were interleaved between a collection and its children

WebHID lists a collection's own items apart from its children's. The encoder writes children first
(`childrenFirst`), which is what descriptors that mix the two (an Xbox controller over Bluetooth) mostly
do. A report's size, and so every driver that reads reports by offset (hid-playstation, hid-nintendo,
hid-steam), is the same either way. Only hid-input's generic mapping of such a descriptor could differ.

**Requests and reports:**
- **GET_REPORT, input:** the last input report with that ID, or zeros of its size before the first one.
  An ID the device doesn't have stalls.
- **GET_REPORT, feature:** `receiveFeatureReport`. A buffer one byte longer than the report and led by
  its ID is passed as it is. Any other buffer gets the ID put in front, since Chromium's framing differs
  by host.
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
- When `tests/usb/hid-fixtures/*.json` exist (recorded Chromium parses with their raw descriptors,
  from the gates lane), the same file also checks parse(raw) ≈ Chromium's parse and encode(Chromium's)
  → parse ≈ Chromium's.
- `tests/usb-webhid.test.ts` runs the device against a fake HIDDevice.

## The page

Files: `web/app/usb-ports.ts` (DOM-free: identities, lock names, connectors, matching, the messages' words, the
definition entries), `web/app/usb-live.ts` (the browser's devices and grants, the device locks, the running machine's
ports), `Usb.svelte` (the Machines page's USB tab), `AddUsb.svelte` (the Add a device wizard), `UsbMenu.svelte` (the
toolbar's USB menu), and the USB block of `web/app/main.ts`.

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
  `getDevices()` order (`matchDevices`, `identityAt`). The USB tab says so when a machine has such twins. WebHID
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
- **Errors:** an attach refused by the device worker is shown with its `UsbProblem`s in words (`problemText`):
  - a protected interface class, with where such a device goes instead;
  - an interface a host driver holds, with the remedy for Linux (unbinding `cdc_acm` and the like), macOS and
    Windows (WinUSB through Zadig);
  - a HID device whose every collection is hidden;
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
