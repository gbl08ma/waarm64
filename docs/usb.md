# USB

USB devices go to the guest through an emulated xHCI: WebUSB passthrough, WebHID devices rebuilt as USB HID, and
virtual devices of ours (Gadget Zero). The design and its steps are in [plans/usb.md](plans/usb.md). The contract
between the page, the device worker and the device backends is `web/usb-device.ts`.

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
