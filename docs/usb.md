# USB

USB devices from the user's computer reach the guest through an emulated xHCI. The plan, and the reasons
behind it, are in [plans/usb.md](plans/usb.md). The device interface every backend implements is
`UsbDevice` in `web/usb-device.ts`. This page covers the two backends for real devices. The controller,
the glue and the virtual devices get their own sections from the lanes that build them.

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
  of its own, and `zeroPacket` (a separate empty transfer after the data) is honoured too.
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
