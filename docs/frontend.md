# The page

The interactive machine (M8 phase A): one VM per page, its screen on a canvas and its serial
console on xterm.js. `npm start` prepares everything and serves it at
`http://127.0.0.1:8080/` (below, "`npm start`"); `npm run serve` only
serves (and builds the Tailscale client, below, "Network"). Chromium only.

## Files

| File | What |
|---|---|
| `web/app/index.html` | the page's shell: the theme's stylesheets, its module, and the fallback that says the scripts didn't load (its few rules); the markup and its styles are the components' |
| `web/app/theme/tokens.css`, `web/app/theme/base.css` | the design tokens (colors, space, text, radii, shadows, control heights, by role) and the element defaults (the reset, form controls, `.sr`): the page's only global styles ([frontend-code.md](frontend-code.md) §1) |
| `web/app/ui/` | the primitives every component is built of ([frontend-code.md](frontend-code.md) §2): `Button`, `Card`/`CardList`, `Note`, `Field`/`Fields`, `Check`, `Radio`, `Choice`, `ErrorBanner`, `StatusDot`, `NameInput`, `Modal`, `Pane`, `Menu`, `Icon` |
| `vite.config.ts`, `tools/serve.ts`, `tools/stamp.ts`, `web/app/public/` | the build and the servers (below, "The build"), the build stamp, the static copy's files copied as they are |
| `web/app/App.svelte`, `Toolbar.svelte` (its menus: `LoadSnapshotMenu`, `ScreenMenu`, `KeysMenu`, `MouseMenu`, `SizeMenu`, and the areas' `Sound`, `Network`, `UsbMenu`, `FoldersMenu`, `ClipboardMenu`), `Ask.svelte` | the page's components (below, "The page's code"): the toolbar and its menus, the message bar, the screen and the terminal, the status line, the questions |
| `web/app/osk.ts`, `Osk.svelte`, `OskBar.svelte`, `osk-frame.svelte.ts` | the on-screen keyboard (below, "The on-screen keyboard"): its layout and keys, the overlay |
| `web/app/areas/`, `web/app/page.ts`, `web/app/changes.ts`, `web/app/command.ts`, `web/app/ask.svelte.ts`, `web/app/settings.ts` | the page's state by area and its actions (`page`), the change signal and the commands they use (below, "The page's code"), the questions (`ask`), what's remembered per browser |
| `web/app/statusbar.ts`, `StatusBar.svelte`, `StatusPiece.svelte`, `StatusEditor.svelte` (`StatusOptions.svelte`, `status-drag.svelte.ts`) | the status bar, its elements and the Preferences' editor (below, "The status bar") |
| `web/app/icons.ts` | the icons (Tabler's, below, "Icons") |
| `web/app/main.ts` | the controller: runs the machine (starts and stops machine workers, the canvas's scaling, xterm.js), writes the areas' state, provides `page` |
| `web/app/worker.ts` | the machine worker: boots a machine with `bootVm` and drives it with `runAsync` |
| `web/app/protocol.ts` | the messages between the two (types only) |
| the toolbar's Snapshot and Load snapshot, `main.ts`'s `saveSnapshot` and `loadSnapshot`, `worker.ts`'s `saveSnapshot` and its start from a snapshot | snapshots on the page (below, "Snapshots") |
| `web/app/shape.ts`, `web/app/store.ts` | machines as the unit (below, "Machines in the browser"): the records and their shape; IndexedDB and OPFS, the sweep, the change notices between tabs |
| `web/app/machines.ts`, `web/app/disks.ts`, `web/app/urlcheck.ts` | what the Machines page does: machines and attachments; disks, overlays as variants, stored disks (import, merge), exports; a disk URL's check |
| `web/app/MachinesPage.svelte`, `MachinesNav.svelte`, `machines-panes.ts`, `MachinePane.svelte`, `machine-edit.svelte.ts`, `SettingsTab.svelte` (`RamSplit`, `KeyboardField`, `DeviceSwitches`, `UsbSwitch`, `SaveRow`), `NetworkTab.svelte` (`AdapterCard`), `UsbTab.svelte`, `FoldersTab.svelte`, `PagePane.svelte`, `ConnectionsPane.svelte`, `connection-kind.ts`, `PreferencesPane.svelte`, `StorageBar.svelte`, `Disks.svelte`, `AddDisk.svelte` (`AddDiskUrl`, `AddDiskFile`, `add-disk.ts`: what it makes), `DisksPane.svelte`, `Overlays.svelte`, `AttachDisk.svelte`, `ExportMenu.svelte`, `Snapshots.svelte` | the Machines page (below, "The Machines page"): the page that composes, its list, a machine's pane and its tabs (the machine being edited, its draft and Save), the transient machine's pane, Connections, Preferences, the storage bar, the Add a disk wizard, the browser's Disks pane and its dialogs |
| `web/app/actions.svelte.ts`, `ErrorWords.svelte`, `file-pickers.ts`, `FilePickers.svelte` | the components' action runner (busy, the error as the page shows it) and its error's view; the page's hidden file inputs and what opens them (below, "The page's code") |
| `web/app/disk-worker.ts`, `web/app/sources.ts`, `web/stored.ts`, `web/ramdisk.ts` | the stored disks' jobs, a disk's bytes in a worker, the block store over nothing, the ramdisk |
| `web/app/machine.ts` | the machines, in one place: image URLs (the firmware, for UEFI machines), command line, the credentials a card adds, RAM, screen size, the `ready` marker, the default vCPU count |
| `web/audio.ts`, `web/audio-worklet.ts`, `web/audio-ring.ts` | the page's sound: the AudioContext, the worklet that plays the device worker's sound ring, the volume (below, "Sound") |
| `web/app/connections.ts`, `web/app/locks.ts` | the browser's network connections (docs/network-adapters.md §2: stored and ephemeral, their state keys, the migration of the single connection kept before; not on the page yet); the locks of what one running machine has at a time (USB devices, connections) |
| `web/app/usb-ports.ts`, `web/app/usb-live.ts`, `Usb.svelte`, `AddUsb.svelte`, `UsbMenu.svelte`, `UsbProblems.svelte` | a machine's USB devices: remembered entries, their grants and locks, the running machine's ports, the USB tab, the Add a device wizard, the toolbar's USB menu ([usb.md](usb.md) "The page") |
| `web/app/network.ts`, `web/app/net-live.ts`, `Network.svelte` (`NetAdapter.svelte` per adapter, `CopyField.svelte`), `NetWizard.svelte` and its `Net*Step.svelte`, `net-wizard.ts` | the network, DOM-free but for the components: settings parsers, the view of a client's state, an adapter's IP port across restarts and disconnects; the page's adapters live (their connections, clients, locks, the default way out); the menu and the wizard (below, "Network") |
| `tools/start.js`, `tools/start.ts` | `npm start` (below) |
| `tools/dist.ts` | `npm run dist`: the page as a static copy (below, "A static copy") |
| `tools/tailscale.ts` | builds the Tailscale client when missing or stale, for `npm run serve`, `npm start` and `scripts/ci-net.sh` ("Network") |
| `tools/debian.ts` | Debian's download and preparation (the tests' guest), for `images/build.sh debian` |

Query parameters (development and tests; no settings UI yet): `?machine=debian|buildroot|snd` (the
default is `debian`), `?ncpus=N`, `?ram=MiB` (both over the toolbar's Machine menu's choice), `?view=screen|terminal|both` (over the remembered view),
`?params=…` (extra kernel parameters for a direct-boot machine, placed before a `--`: e.g.
`init=/nonexistent` to make Buildroot panic, as a test does; Debian's bootloader owns its command
line: edit it in GRUB), `?credential=name:value` (repeatable: a systemd credential over fw_cfg for a
firmware machine; tests pass `tests/debian-unattended.ts`'s to boot Debian unattended, the page
passes none), `?clipboard=1` (a transient machine with clipboard sharing's device, docs/devices.md "agent";
`window.__agent` is the page's end of its port), `?disk2=<url>` (a second,
read-only virtio-blk over HTTP ranges, `/dev/vdb` in the guest, no overlay; for tests: the stress
test's `--disk2` gives it the Go toolchain image, docs/images.md "The Go compiler on a second disk"), `?snd=stats[,timer]`
(the sound device's completion timing once a second in `window.__audio.stats`, and the timer instead of the
worklet's notify; any `?snd=` also exposes `window.__audio`, the serial log and the status, for tests and
`bench/audio/snd-page.ts`), `?jit=nocw` (the JIT without its compile worker: each vCPU compiles what it installs,
for A/B measurements; docs/jit.md "Sharing"), `?fma=emul` (the JIT's FMA forms emulated on a host that fuses them, for
A/B measurements: docs/jit.md "Floating point"), `?growcore` (the core on the memory's growable import instead of its
exact-limits copy, for A/B measurements: [abi.md](abi.md) "A fixed-size memory"), `?jitmb=MiB` (the JIT's code cache budget, over a stored machine's
own: `VmConfig.jit_bytes`, docs/jit.md "Memory"), `?usb=1` (a transient machine with a USB controller; a stored machine's is
its record's), `?usbzero=1` (Gadget Zero in the USB menu, for tests: [usb.md](usb.md) "Gadget Zero on the page"),
`#net=ws://127.0.0.1:<port>/<token>` (the local helper's pairing link: the Network wizard opens on it, "Network" below).

## The machines

- **`uefi`**, the page's machine (M8 decision 1, since 2026-10-17): EDK2 and **no disk of its own**. The page
  opens idle, says how to bring a disk ("Open a disk image…", with an **[Open disk…](ui:machine:main.openDisk)** button) and starts nothing until
  one is opened (below, "Your own disk": the picker, a drop, `?disk=<url>`); Start without one says the same. The
  toolbar shows "AArch64 machine · no disk", then the machine made for the disk (named after its file); Suspend
  appears with a disk. 2 GiB, a 1024×768 screen on virtio-gpu, the same devices and network credential as `debian`;
  `ready` is a getty's login prompt. The page names no distribution. A preloaded image with a snapshot, loaded with
  the page, is later work (PLAN.md, M8 decision 1).
- **`debian`**, the tests' and benchmarks' guest (`?machine=debian`; the page's own machine until 2026-10-17;
  `tests/debian-unattended.ts` `unattendedQuery()` asks for it): Debian's published nocloud qcow2, **unmodified,
  booted through UEFI** (M8 phase B: EDK2's `QEMU_EFI.fd` as the machine's `firmware`, then shim
  and GRUB from the disk: docs/firmware.md; below, "Debian through UEFI"), under the JIT,
  realtime, a worker per vCPU; 1 GiB; a 1024×768 framebuffer; rng, the disk (virtio-blk over HTTP
  ranges, writable through the OPFS overlay `webpc-debian`), keyboard, tablet, the display, a sound card
  (virtio-snd, below "Sound"; every page machine has one). No virtio-console
  (it would only add an output-only `hvc0` getty) and, by default, no network card: the Network menu (below) adds one. Its command line is GRUB's
  (`root=PARTUUID=… ro`; the old direct boot's is in [images.md](images.md) "Debian for interaction"). vCPUs: `min(4, cores − 2)` (the page and the
  device worker keep a core each). `ready` is the serial console's login prompt (`localhost login: `
  at a line's start, anywhere in the output: below, "The end-to-end test"), ~30 s after
  the page loads (bench/boot/REPORT.md "M8 loop 0"; through UEFI ~53 s, "M8 phase B loop 3").
  **A first boot runs as on a regular machine:** the published image locks root
  (`root:!unprovisioned`) and has no other user, and its first boot runs `systemd-firstboot` on
  `/dev/console`, the serial port (GRUB passes no `console=`, so the kernel takes the device
  tree's PL011): it asks for a timezone, a locale and a root password on the serial terminal,
  with the screen waiting. The page passes no credentials (the user's answer); the boot card says
  where the questions are ([Show serial console](ui:common:App.boot.serial.show) opens the serial view). Tests pass them over fw_cfg
  (`tests/debian-unattended.ts`: `login.noauth`, `firstboot.*`, an empty root password).
- **`buildroot`**, the test guest: `-- /bin/sh` on the serial console, 256 MiB, a 640×480
  framebuffer that stays black (its kernel has no fbcon), the overlay `webpc-buildroot` (mounted
  read-only; it's there so restarts hand an overlay over). Up in under a second.
- **`snd`**, the sound test guest (`images/build.sh linux-snd`, audio S2): its init plays a 440/660 Hz tone through
  virtio-snd for `?params=snd_seconds=N` (1.024 s without) and powers off. No disk (a machine without `disk` has no
  virtio-blk), a black screen, 256 MiB; `ready` is its hw params line. `tests/audio-browser.test.ts` and
  `bench/audio/snd-page.ts` run it.

URLs are relative to `machine.ts`, so nothing but the location of `target/` ties the page to the
dev server (decision 7).

## Machines in the browser

The model, its rules and why ([machines.md](machines.md)); here, what the page does with it.
- **Records** (`web/app/store.ts`): IndexedDB `webpc` has `machines`, `disks`, `overlays`, `snapshots` and `connections` (version 2; the network's, below), keyed by
  a 12-hex-digit id; their bytes are in OPFS: `overlays/<id>/` (`data`, `map`, `meta`, `base`), `disks/<id>/` (a
  stored disk, the same block store), `machines/<id>/` (`flash`, the firmware's variable store: the machine's,
  so an install's boot entries stay with it; `suspend`; `snapshots/<id>`). A record is written after its bytes and
  deleted before them; `Store.sweep` removes bytes without a record (only id-named ones: a transient machine's
  overlays are named otherwise) and waits for writers (`Store.writing`, a shared Web Lock). Other tabs hear every
  change (`onChange`, a BroadcastChannel).
- **A machine** has a name (generated: "Brisk Heron"), vCPUs, RAM, the display (2D or 3D), a network card, and up
  to 16 attachments in slot order: a disk, read-only or not, the overlay chosen, written in place (a stored disk).
  Its transports are the other devices first (rng, keyboard, tablet, net, gpu, snd, then the mouse and the
  touchscreen where it has them), then the disks
  (`shape.ts` `slots`); a disk's serial is its attachment's (`webpc-<id>`: `/dev/disk/by-id/virtio-webpc-…`).
- **The shape** (`shapeOf`, `shapeHash`): what the guest sees (vCPUs, RAM, display, CPU features, devices, each
  disk's size, read-only flag, serial and base identity), canonical JSON hashed with SHA-256; names, the overlay
  chosen and writing in place aren't in it.
- **Opening one:** `?m=<id>` opens a stored machine on the page (its record and its disks'; a missing one is a
  `failed` page that says so). A writable attachment without an overlay gets an empty one ("Changes") at the
  start; each start's disks go to the worker resolved (`StartDisk`: a URL, a `File` from the remembered handle, a
  blank or ramdisk size, a stored disk's directory). **Every start reads the record again** (`reloadStored`: the
  Machines page edits it while the machine is off, and this tab hears no notice of its own writes), with the size and
  display it now has; closing the Machines page does too, for the toolbar. After it stops the page reads each overlay's (and in-place
  disk's) generation and size from its files into the records. Without `?m=` the machine is transient, made from
  the query as before (`?machine=`, `?disk=`, `?disk2=`): its overlays keep their old single names.
- **Disks:** a URL (checked when added: `urlcheck.ts`, what fails and what the server needs; a URL disk is slow and
  the Machines page says so), a file (its `FileSystemFileHandle` kept in the record), a file [stored in this browser](ui:disks:disk-kind.stored)
  (converted into the block store, `web/stored.ts`; the confirmation says what it takes and that it duplicates the
  file), **blank** (zeros, always writable through its overlay) or a **ramdisk** (`web/ramdisk.ts`: empty at every
  boot, the guest's reboot too; its memory counts in the page's memory check). A snapshot and a suspended copy hold
  its blocks (machines.md §4.3).
- **Overlays are the base disk's**, named variants any machine attaching it can choose (`disks.ts`): new empty,
  rename, switch, delete (refused while a machine has it open: its Web Lock), export (changes only, or the whole
  disk), Import changes… into a new one. A stored disk can take one **in place** (merge: the disk's other overlays are
  deleted, the confirmation lists them first) and can be **written in place** (no overlay; its own generation moves).
- **Definitions** (`web/app/definitions.ts`): Export the definition writes `<name>.webpc-machine.json` (`webpc-machine`,
  version 1: the settings, and per attachment the disk's kind, name, size, identity, URL, hash where known, read-only,
  in place, serial; no handles, overlays, snapshots or contents). Import a definition… makes a new machine (the name
  made unique, the same shape): a disk the browser has by identity is attached again, URL, blank and ramdisk disks
  come back, and file disks (and stored disks the browser doesn't have, as files) are picked at its first start:
  taken when the name, size and date match, or when the hash does (the definition's), else asked about.

## The page's code

Svelte 5 (runes), compiled by Vite's Svelte plugin (below, "The build": `.svelte` components, and `.svelte.ts`
modules with runes). `main.ts` mounts `App.svelte` on the
body first, then finds the canvas and the terminal's element in it and runs the machine as before. **What the page
shows is its areas' state** ([frontend-code.md](frontend-code.md) §3), each a `$state` object or class in
`web/app/areas/`: `power` (the state, its words, `busy` while a switch or a save runs; `isLive`), `messageBar`,
`bootCard`, `current` (the page's machine: its id, title, what it has, a transient machine's size), `screen` (the
view), `machinesNav` (the Machines page open, its tab, the chosen pane, `selected` derived from the records), `keys`,
`mouse`, `status`, `sound` (following `PageAudio`), `clipboard` (following the run's `ClipboardShare`), `usb`,
`shares` (shared folders), `network` and `records` (the browser's machines, disks, overlays and snapshots, read again
on the store's `onChange` and, after this tab's own writes, `records.reread()`). main.ts writes them instead of the
DOM and reads them back (`power.state` is the state; `App.svelte` writes the body's `data-state`, `data-view`,
`data-graphics` and `data-page` from them). The live network, folders and on-screen keyboard keys are plain classes
whose reads track a change signal (`changes.ts` `Changes`, Svelte's `createSubscriber`), so a component reads
`net.views()` or `folders.folders` directly. A menu or wizard that opens itself (the Network and Folders menus, the
USB menu, the Network and Folder wizards) answers a `Command` (`command.ts`; `network.openWizard(o)`,
`shares.openMenu()`) while it is mounted, a call made before it is there waiting for it; the keys' events
(`keys.released`, `keys.typed`) are listened to by the on-screen keyboard. **What the components do is `page`**
(`page.ts`'s `Page`: restart, power off, suspend, take, load and restore snapshots, save disks, import changes, open
machines, save settings…), which main.ts fills in before the first start. Ids the tests and tools use stay (`#state`,
`#message[data-snapshot]`, `#status[data-status]`, `#restart`, `#save-snapshot`, `#suspend`, the menus' `details`,
the hidden file inputs `#open-disk-input`, `#load-snapshot-input`, `#load-changes-input`: `FilePickers.svelte` owns them, and a
button opens one with `file-pickers.ts` `openPicker('disk' | 'snapshot' | 'changes')`). **Actions** a click starts that can fail
run through one runner (`actions.svelte.ts` `Actions`: `run(what, f)` says what runs in `busy` and keeps the error in
`error`, as usb-ports.ts `errorView` words it; `ErrorWords.svelte` shows it, a USB attach's problems with their
remedies): a dialog or a menu makes its own, the Machines page's panes and tabs share the page's (`act`, shown in its
bar and its error banner). **Sizes are in binary units**
everywhere on the page (KiB, MiB, GiB: `bytes.ts` `bytesText`), as the sizes users enter are (a disk in MiB, RAM).

**Styles** are the components': each `<style>` is scoped to the component that writes it and reaches only its own
markup (and the markup it passes to a child as a snippet, which is still its own), never a child's insides. What every
component shares comes from two places ([frontend-code.md](frontend-code.md) §1–§2): the **tokens** and element
defaults of `theme/` (`index.html` links them, so the scripts' fallback has them too), and the **primitives** of `ui/`,
which carry the look of a button, a row of a list, a note, a field, a choice, an error bar. A component builds with them
(`<Button variant="primary">`, `<CardList>`/`<Card>`, `<Note tone="warn">`, `<Fields>`/`<Field>`) and styles only its
own layout, on the tokens; a tab or a pane can be a component of its own and still look like the rest. A parent places
a child with its own wrapper, or passes a CSS custom property (`--card-bg`: Modal sets it, so a dialog's rows take the
page's background); `class` on a primitive is for a test's hook. Stylelint holds values to the tokens
([frontend-code.md](frontend-code.md) §7).
Every pane on the right of the Machines page (a machine, Disks, Shared folders, Connections, Preferences, About) is a
`ui/Pane.svelte`: its head (title, small line, the `actions` snippet's buttons), its tabs (`tabs`, `tab`, `ontab`) and
its body (`.tab`), so a new pane looks like the others by using it. The title is at one place whether the head has buttons
or not (its line is a button's height, `--control-h`), a long small line wraps under the title and leaves the buttons beside it,
and the body starts at one place under a head of one line (`tests/page-layout.test.ts`).
Dialogs are built on `ui/Modal.svelte` (Add a disk…, Add a device…, the Network and Folder wizards, a disk's Overlays,
Attach to a machine; the page's questions are `Ask.svelte`'s): the shell, its title, its row of buttons (`buttons` at
the end, `back` at the start) and a column for its content, which is made of the primitives (Note, Field, Choice, Card,
Button; a wizard's steps are `ui/Step.svelte`, a fold `ui/Disclosure.svelte`, numbered steps `ui/Steps.svelte`), so a new
dialog looks like the others by using them. The wizards' particular layout (the Network wizard's
sub-steps and disclosures) is in their own components.
A disk in a list is `DiskInfo.svelte` (its kind's icon, name and line), and a disk's kind in words and icon is
`disk-kind.ts`.

**Types:** `tsc` doesn't read the components; `npm run svelte-check` (a step of `scripts/ci.sh`, ~2 s) checks them
with `tsconfig.svelte.json` (`web/app`, ESM resolution: svelte-check made the shared config's `nodenext` node10) and
the Svelte options in `vite.config.ts` (`--config`: without it, svelte-check crawls the whole repository, `target/`
included, for config files). Vite's own types (`vite/client`: CSS imports, `?worker&url`) are in `tsconfig.json`.
svelte-check and the page's linters (ESLint, Stylelint, Prettier: [frontend-code.md](frontend-code.md) §7) run on
TypeScript 6, in their own package **`tools/lint`** with its own lockfile and `node_modules` (`npm ci --prefix
tools/lint`, which `scripts/ci.sh` and `scripts/cloud-setup.sh` run when it's stale; its `.npmrc` leaves the peers,
Svelte, to the root's): they need the compiler API TypeScript 7 doesn't have, and a package linked from the root's
had its dependencies hoisted next to the root's TypeScript 7, where they loaded it. ESLint runs under
`tools/lint/ts6.ts`, a module hook that makes every `typescript` import the package's (eslint-plugin-svelte loads it
from the working directory).

**Screenshots:** `node tools/screens.ts --label <name>` (headless Chromium on the dev server, ~1 min; `--only <part>`
for the states whose names contain it) seeds a profile through the page's own modules (two machines, disks with
overlays, kept snapshots, three connections, a folder), then captures each state that needs no guest as
`bench/results/local/screens/<name>/<state>.png` at 1280×800: the toolbar and each of its menus (with every menu a
machine can have shown through its areas' state), the message bar (warn, error), the Machines page's panes and a machine's tabs
(also 720 px wide, `-narrow`), every dialog, each Add a disk source, the Network and Folder wizards' steps and the
page's questions. `missed.txt` lists what it couldn't reach (a guest's states, the browser's pickers). A change to the
page's look is compared with a baseline set taken before it (`--label before`): `node tools/screens.ts --compare before
--label <name>` lists each state whose pixels differ, and where. The seed's times, addresses and orders are fixed, so
what differs besides the change is the dev server's port (in Add a disk's URL) and a new adapter's MAC.

## The toolbar

A desktop application's toolbar (`Toolbar.svelte`): tool buttons with icons and tooltips, in groups split by
separators; the main gates also have their names. Left to right: **[Machines](ui:toolbar:Toolbar.machines)** (the Machines page), the machine's name,
**Start/Restart/Retry** and [Power off](ui:toolbar:Toolbar.powerOff) (a hard stop, asked first; only while it runs), **[Suspend](ui:toolbar:Toolbar.suspend)**,
**[Snapshot](ui:toolbar:Toolbar.snapshot)** (one click: a stored machine's is kept in the browser at once, named by the time, renamed later on the
Snapshots tab, the panic button; a transient machine's is saved to a file), **Load snapshot** (a menu: the machine's
five latest kept snapshots, orphaned ones disabled; All snapshots… (the Snapshots tab); From a file…), the views
(Screen, Serial terminal, Both), **Screen** (size and HiDPI, virtio-gpu machines), **Keys**, **[Mouse lock](ui:statusbar:statusbar.kind.pointer)** (a menu: on or
off, and Pointer or Raw, remembered per browser; the button looks pressed while it's on: "Input", "[Mouse lock](ui:statusbar:statusbar.kind.pointer)"), [Full screen](ui:toolbar:Toolbar.fullscreen),
**Sound**, **Network**, **USB** (a machine with a USB controller: its remembered devices with attach toggles, the
offers of a device that just appeared or has no permission here yet, Add a device…; [usb.md](usb.md) "The page"), **Folders**,
**Clipboard** (below), and for a transient machine (a test's `?machine=`) the **Machine** menu (vCPUs, RAM, graphics);
a stored machine's are its Settings. The power state (Booting, Running, Powered off…) is the status bar's first item
by default (below, "The status bar"). Menus (`ui/Menu.svelte`) keep the `<details>`/`<summary>` shape, close on a click
elsewhere and open under their right edge (a page's Export menus under their left).

**Clipboard** (`ClipboardMenu.svelte`, [plans/clipboard.md](plans/clipboard.md) §4–§5; the logic is
`web/app/clipboard.ts`'s `ClipboardShare`, wired in `main.ts`): shown while the running machine has
**[Share the clipboard with the guest](ui:machines:DeviceSwitches.clipboard)** (or `?clipboard=1`). The button's state (`data-state`): *sharing* (pressed), *paused*
(the icon crossed out), or *waiting* for the guest's program (before its HELLO, or since its port closed), each with
its tooltip; a mark (and its tooltip says what is limited) while it shares but Chromium's `clipboard-read` permission is
`prompt` or `denied`, or the focus reads stopped (below). The menu: **[Allow seeing the clipboard…](ui:clipboard:ClipboardMenu.allow)** while the
permission is `prompt` (its click's read is what makes Chromium ask), how to allow it in the site's settings while
it is `denied`, a note while it is `granted`; **[Share the clipboard](ui:clipboard:ClipboardMenu.share)**, the switch, which pauses both ways for the run
(PAUSE to the agent; the pending text dropped; the pause isn't in snapshots: the link says PAUSE or RESUME at every
opening of the agent's port, so an agent restored paused is resumed); **[Send the clipboard to the guest](ui:clipboard:ClipboardMenu.send)** and
**[Type the clipboard](ui:clipboard:ClipboardMenu.type)** (TYPE on the console), which read on their click (Send reads `read()`, for an image too); the menu stays open while one runs and closes when it succeeds (for Type, at the agent's TYPED DONE), a failure keeping it open with its note; after Type, the menu says what went
wrong as the agent's TYPED says it: "[Nothing was typed, because the guest is showing a graphical desktop rather than a text console. Paste with the keyboard while the guest's screen has the focus instead.](ui:clipboard:ClipboardMenu.notText)"
or "[Some of the text wasn't typed, as the guest's console didn't consume all of it.](ui:clipboard:ClipboardMenu.untyped)"; and
**[Copy the screen](ui:clipboard:ClipboardMenu.screen)**, which needs no agent (shown while waiting or paused too): a PNG of the display
written to the host's clipboard (`write` with a promise, so the click's activation outlasts the read-back; `main.ts`
`screenPng`): a 3D machine's screen read back by its GPU worker (`grab`) and encoded in `web/app/png-worker.ts`, a 2D
machine's from whoever draws it over the display port (`png`: virtio-gpu's scanout in the device worker,
`gpu-present.ts` `scanoutPng`, or the framebuffer's canvas in the machine worker); a failure says "[The screen wasn't copied. There may have been no video output yet, or this web app ran into a browser limitation.](ui:clipboard:ClipboardMenu.screen.failed)". The permission is followed
(`watchReadPermission`: `navigator.permissions.query`, its `change` event; `none` in Firefox and Safari, which throw
on the name). What the page does with it:
- **Sync** (way 1): while the permission is `granted`, a focus of the page (`focus`, `visibilitychange` to visible,
  only while `document.hasFocus()`), the agent's HELLO and SESSION (the guest's clipboard changed hands) and the
  permission's becoming `granted` read the host's clipboard (`readText`; `read()` too after an empty one or a
  `clipboardchange`, for the types, a PNG and `text/html`) and offer it to the guest (text, an image and HTML in one
  OFFER, the text inline when short; HTML only beside the text or the image, as Chromium sanitised it, and not in the
  hashes: the same text with other HTML is the same content) if it changed since the page last knew it or the guest
  isn't known to have it; where
  `clipboardchange` exists (Chromium 155 has it), a focus reads only after one (or after HELLO, SESSION, the port's
  opening), and the event reads at once. Never a read while it is `prompt` but on the user's clicks above.
- **The guest's copies** (§4.2): written at once while the document has focus; otherwise (or refused: Firefox wants
  activation) the newest is pending, written on a focus whose read finds the host's clipboard unchanged (dropped if
  it changed: the host's newer copy wins), or on the next key or pointer down on the screen (at the document's
  capture); a paste chord drops it instead. One with an image (§4.4) is written as one `ClipboardItem` of promises:
  its bytes requested from the guest at the write, a type other than PNG converted in a worker (`web/app/png.ts`
  `toPng`: `createImageBitmap`, `OffscreenCanvas`, `convertToBlob`; Chromium refuses to write `image/jpeg`, measured),
  its text in the same item; one with HTML (plan §3.2) the same way, its text and HTML (and image) in one item, the
  HTML requested at the write (HTML that doesn't come is the text's, escaped: the rest is written all the same; with no
  image, the text's hash is the guest's, as `writeText`'s); a pending image or HTML is the guest's offer, not its
  bytes. Without `ClipboardItem` writes, the text alone. After the write the clipboard is read
  back once (with the permission and focus): Chromium re-encodes the PNG it writes (measured: 3142 bytes written, 2630
  read, the same at each read, and the paste event's `File` the same bytes as `read()`), so that hash stands for the
  guest's image and the next sync doesn't send it back.
- **Placeholders** (§4.3): an empty read is never offered and doesn't stand for the host's clipboard; an empty
  `readText` asks `read()` for the types, and `EMPTY_RUN` (3) empties in a row while the types say text stop the
  focus reads for the run (the menu says why); refusals are silent.
- A paste chord right after a sync of the same text waits for that offer's ACK instead of offering it again; the
  chord's `paste` event gives the text, a PNG `File` among its items and `text/html`, offered together.

### Icons

Tabler Icons' outline set (MIT), from the npm package `@tabler/icons-svelte-runes` (a component per icon). `icons.ts`
imports the ones the page uses by name (`@tabler/icons-svelte-runes/icons/<name>`: one module each, so the dev server
loads only those and the build carries only those) into `ICONS`; `ui/Icon.svelte` draws one by name (`IconName`, which
the status bar's and dialogs' tables use) at 1.75 stroke, `currentColor`. A new icon is an import and an entry in
`icons.ts`; icons aren't drawn by hand. The license reaches the static copy in `THIRD-PARTY-LICENSES.md`.

### The status bar

The bar under the machine is a row of elements the user chooses and orders in **[Preferences](ui:machines:MachinesNav.preferences)** (the Machines page),
kept per browser as `webpc.settings` `statusBar` (absent: the defaults; `[]`: no bar). `web/app/statusbar.ts` is the
model, DOM-free (tests/statusbar.test.ts): the kinds (`KINDS`: name, group, icon, default look), the defaults (power
state, a divider, vCPUs, RAM, uptime, MIPS, JIT share, IRQ/s), `normalize` (a kept list from another version: unknown
kinds and fields dropped), `metrics` (the last second from two `status` messages; none across a new run, whose
counters start at 0), `graphics` (the screen's report: a 3D machine's GPU worker `stats`, a 2D one's presenter
`screen-stats`) and `render` (an element's pieces: words, an icon and a short value, a tone, per-vCPU bars, or values
with icons of their own, the network's received and sent arrows). `StatusBar.svelte` draws the bar (neighbours split by
a dot; a spacer is `flex: 1`; no element that shows anything, no bar, and `#state[data-state]` stays, hidden, for the
tests), `StatusPiece.svelte` an element's pieces, `StatusEditor.svelte` the Preferences' editor (its chosen chip's settings `StatusOptions.svelte`, its drags `status-drag.svelte.ts`).
- **Elements:** power state, vCPUs, RAM, uptime, clock, tab memory (the memory signal's estimate); MIPS and JIT share,
  IRQ/s, blocks compiled, compile time, the JIT cache against its budget; network traffic and totals, each adapter's
  connection; disk speed and totals; USB traffic and totals (a machine with the USB controller: its devices together,
  in and out as the guest sees them, counted as the xHCI's transfers complete, `web/usb.ts`); the renderer (3D or 2D,
  WebGL2 or a canvas, amber when WebGL2 is software; [Framebuffer](ui:statusbar:statusbar.gpu.framebuffer) on a machine
  without virtio-gpu, `?display=simple`), frame rate (frames that drew something a second: the GPU worker's or
  presenter's, or the simple framebuffer's draws, which the machine worker counts and reports as `screen-stats`), Vulkan activity (a Vulkan machine's: the guest's Venus contexts, roughly its programs holding a Vulkan device, and
  the WebGPU submits a second, its draws and the adapter in the tooltip; amber on a software adapter, [Vulkan idle](ui:statusbar:statusbar.vulkan.idle) with
  none, red without a WebGPU device: the worker's `stats` `vulkan`), video decode (the streams' codecs, hardware as asked: WebCodecs doesn't say what a decoder got, and pictures a
  second); mouse lock, keyboard (where keys go: the machine when the screen or the terminal has the focus, what the
  screen's [Click to type](ui:common:App.screen.hint) hint says otherwise, and its shortcuts too with full screen's Keyboard Lock), microphone (shown while it records);
  spacer and divider.
- **Per device:** MIPS, the JIT share, and the network's and disks' elements come summed (`all`), for `each` device
  (vCPUs as bars or numbers; adapters and disks one after another) or for `one`, by its number: vCPUs from 0, as the
  guest names them, adapters and disks from 1, as the machine's tabs list them. An element whose device the running
  machine hasn't isn't drawn (dimmed in the editor). USB devices count only together, in the USB elements (they come
  and go while the machine runs): not in the disks' or adapters' (a USB stick isn't a disk of the machine's).
- **Looks:** words (`812 MIPS`), an icon and the bare value (the words for screen readers and in the tooltip), or both;
  the states (mouse lock, keyboard, the connection, the microphone) default to the icon, coloured by their tone.
- **The editor:** a copy of the bar, its elements as chips that draw what the running machine shows (a made-up
  machine's numbers, `SAMPLE`, while none runs): dragged to move (Alt+←/→ with the focus on one), × or dragged onto the
  palette to remove, chosen to set their look, bars or numbers and device number (and its ←/→ buttons move it). A
  mouse drags through HTML5 drag and drop; a finger or a pen through pointer events, after a long press (350 ms held
  within 8 px: moving first scrolls the page, and the drag's touchmoves are cancelled so the page stays put under
  it). The palette under it adds an element at the end on a click, where it's dropped on a drag. Restore defaults forgets the kept list.
- **In full screen:** off by default (the machine alone, edge to edge: full screen is `<main>`'s); Preferences' [Show the
  status bar in full screen](ui:machines:PreferencesPane.statusFullscreen) (`statusFullscreen`) makes it the page's, without its toolbar and message bar (their components' `body:fullscreen` rules).
- **Per-vCPU bars** are drawn against the run's highest vCPU MIPS so far (`cpuPeak`): a fixed scale wouldn't fit
  every host and guest, whose rates differ by far more than the bars could show (decided 2026-11-09).
- **Costs:** none to the emulation: the per-vCPU steps were counted already; the disk, adapter and USB bytes are one add per
  completed request in the device worker, into a shared buffer the machine worker reads once a second (devices.md
  "Threads and determinism"); the GPU's numbers are increments where the work already happens, posted once a second.

## Dialogs and the message bar

**Questions** are the page's own dialogs, not the browser's `confirm`, `alert` and `prompt`: `ask.confirm`,
`ask.alert` and `ask.prompt` (`ask.svelte.ts`) queue a question and resolve when it's answered; `Ask.svelte` shows the
first in a modal `<dialog id="ask">` (a title, the text, OK and Cancel with the action's own words; one that loses
data has its OK drawn as a warning; Esc is Cancel). Clicking OK is a user activation, so a file picker or a permission
request after it still works. Tests answer them by clicking (`tests/page-ask.ts` `answerAsks`).

**The message bar** (under the toolbar) says what stops a machine (below, "Errors") and what happened: it has a close
button, and a notice or error that leaves the machine as it was (a snapshot kept or saved, or not; a disk saved or not
from another machine; changes loaded into a machine that's off) clears itself after 30 s (`notify`). A problem that
keeps the machine from running (it failed, it waits for a disk) stays until it's closed or solved.

## The Machines page

The page's side of [machines.md](machines.md). `MachinesPage.svelte` composes it: it reads the records, runs the
panes' actions and holds the machine being edited (`machine-edit.svelte.ts` `MachineEdit`: the record, the draft the tabs
edit, `dirty`, the switches' orphan warnings, Save and Revert, one for every tab), and shows the list
(`MachinesNav.svelte`; the other panes' ids in `machines-panes.ts`) and the chosen pane: a machine's
(`MachinePane.svelte`: its head and a component per tab, `SettingsTab`, `Disks`, `NetworkTab`, `UsbTab`, `FoldersTab`,
`Snapshots`), the transient machine's (`PagePane.svelte`), `DisksPane`, `FoldersPane`, `ConnectionsPane`,
`PreferencesPane`, About; `StorageBar.svelte` at the bottom. It takes the machine's place on the page (the machine runs on behind it; `#machines` in the
address opens it, so a reload keeps it): **[Back to the machine](ui:machines:MachinesPage.back)** (or a view button) returns. The machines on the left
(new, **from a disk image…** (what Open disk… and a drop do), import a definition), each said running (its Web Lock
is held, in any tab), suspended (a suspended copy is kept, `machines/<id>/suspend`) or off, and the chosen one on the right:
Open in this tab (for the page's own machine, **[Start](ui:machines:MachinePane.start)** while it's off, "[Running in this tab](ui:machines:MachinePane.runningHere)" while it runs),
Duplicate, Export the definition, Delete; then tabs:
- **[Settings](ui:machines:MachinePane.tab.settings):** name, vCPUs, RAM (512 MiB to 16 GiB, `machine.ts` `RAM_CHOICES`; past `MEMORY0_MIB`, 3071 MiB, the rest goes to spill memories (on a machine with Vulkan
  the first holds at most 1,536 MiB: Venus's arena and window come first in memory 1) that the guest sees
  as NUMA nodes, slower to reach, and a note under the choice says so (`numaNote`, with the machine's Vulkan setting): [spill-memories.md](spill-memories.md); a machine or definition with another size is shown as it
  is), **[Memory split (advanced)](ui:machines:RamSplit.split)**, closed unless the machine has one: *[Set the split myself](ui:machines:RamSplit.split.custom)* starts from the
  automatic split and takes memory 0's size and the NUMA nodes' sizes (MiB, comma-separated), checked as typed
  (`ramSplitError`), the RAM then being their sum (the machine's `ramSplit`, in its shape and its definition), display,
  **keyboard layout** (a new machine's follows the browser; "Input" below, "The keyboard layout"). Save; on the machine running on this page it reads **[Save and restart](ui:machines:SaveRow.saveRestart)**
  (asked first), the USB controller, the **[Mouse (the mouse lock's Raw mode)](ui:machines:DeviceSwitches.mouse)** and the **[Touchscreen](ui:machines:DeviceSwitches.touch)**, and
  **[Share the clipboard with the guest](ui:machines:DeviceSwitches.clipboard)** (off by default, its note under it; ticking it asks for the browser's read permission). A change of shape
  asks first when it orphans snapshots; a box whose change does (Vulkan, the USB controller, the mouse, touchscreen and
  clock device, clipboard sharing, shared folders) warns under it only when the machine has snapshots, while the note under Save always says it. The three are peripherals the guest sees: absent on machines made before
  them (off, so their shapes and snapshots stay as they were), on for new ones.
- **Disks** (`Disks.svelte`): the attachments in slot order (read-only, write in place, up, down, Detach); per writable
  disk its overlays (switch, New empty, **[Overlays…](ui:disks:Disks.overlaysButton)**), **[Export](ui:disks:ExportMenu.label)** (a menu, `ExportMenu.svelte`: changes only, the
  whole disk as qcow2 or raw, compressed or not; a machine on this page running from it stops while the file is
  written and starts again after) and [Import changes…](ui:disks:Disks.importChanges) (a changes file becomes a new overlay, which the disk switches
  to). There is no Reset for a stored machine: New empty is it, and keeps the old overlay. Overlays… opens the disk's
  **Overlays** dialog (`Overlays.svelte`, also from the Disks pane below): every overlay of the disk with what it holds,
  when it was made and the machines that write to it; Rename, Delete (a machine that wrote to it is left without one,
  and makes a new one at its next boot), Merge into the disk (a stored disk) and Export each. [Add a disk…](ui:disks:Disks.add) opens a
  wizard (`AddDisk.svelte`; what it makes is `add-disk.ts`): the source first (**a disk already in this browser**, a file read where it is, a file
  copied into the browser, a URL, blank, a ramdisk), each explained, then its details and Read-only. A disk already
  in this browser is one another machine has or one detached (Detach keeps the disk and its overlays, and says so):
  listed with its overlays and the machines that have it, and attached again as it was. A file or URL added again (or opened, or
  dropped) is the disk the browser has for it, by identity (`machines.ts` `knownDisk`: a file's name, size and date,
  a URL's path, size and validator), so its overlays come back with it.
- **[Network](ui:machines:MachinePane.tab.network):** the machine's network adapters (docs/network-adapters.md): up to four, each with its MAC (random,
  `newMac`, since 2026-11-03: machines share LANs, such as a local helper's, whose network knows a guest by its MAC;
  machines made before have `52:54:00:12:34:56` first, as the one card was), added, removed and moved up or down
  with the machine off (the order is the guest's `eth<n>` and decides the default way out), and each with its connection (below, "Network"): **[Attach…](ui:machines:AdapterCard.adapter.attach)** or [Change connection…](ui:network:NetAdapter.change) (the Network wizard),
  **[Detach](ui:machines:AdapterCard.adapter.detach)**, **[Connect at start](ui:machines:AdapterCard.adapter.atStart)**, and Connect or Disconnect while it runs on this page. Attaching is saved at
  once, running or not (a connection isn't in the shape), and a machine running in another tab connects it at once. **[Take the connection's settings in the guest](ui:machines:NetworkTab.netConfig)** (on; off is
  `MachineRecord.netConfig: false`, carried by definitions, not in the shape): below, "What the page sets in the guest". **[Connections](ui:machines:ConnectionsPane.connections.heading)** (in the list of machines) is the
  browser's connections; **[Preferences](ui:machines:MachinesNav.preferences)** under it is the page's, per browser (below, "Leaving the page" and "The status bar"), and **[About](ui:machines:MachinesPage.about)** after it (below, "About"). A machine made before adapters keeps its card (`network`), read as one adapter at that MAC, so its
  shape and snapshots stay as they were; definitions carry the MACs (`machine.macs`) and no connections.
- **[USB](ui:machines:MachinePane.tab.usb)** (`Usb.svelte`): the USB controller's switch (also on Settings: it is in the shape), the remembered devices
  with their state (attached, plugged in, not plugged in, held by another machine, no permission in this browser),
  connector, attach at start, Attach and Detach (while the machine runs on this page), Allow…, Forget. [Add a
  device…](ui:usb:UsbMenu.add) opens a wizard (`AddUsb.svelte`): two numbered steps (the kind, then the browser's chooser) over the kinds, a
  USB device (WebUSB) or a HID device (WebHID), each explained, and a note on what the machine remembers. [usb.md](usb.md) "The page".
- **[Shared folders](ui:machines:MachinePane.tab.folders):** the machine's switch (in the shape), **[Mount shared folders in the guest](ui:machines:FoldersTab.sharesMount)** and its [Mount
  point](ui:machines:FoldersTab.sharesPath), and the attached folders (`Folders.svelte`: order, Read-only, Allow…, Use it here, Detach), changed at once,
  running or not. **[Attach a folder…](ui:folders:Folders.attach)** opens the Folder wizard (`FolderWizard.svelte`). **[Shared folders](ui:machines:MachinesPage.folders.heading)** in the list of machines
  is the browser's (`FoldersPane.svelte`): rename, Read-only, Delete, a folder in the browser's files. The toolbar has a
  **Folders** menu while the page's machine runs with them. [shares.md](shares.md) §4.
- **[Snapshots](ui:machines:MachinePane.tab.snapshots):** the kept ones (below, "A stored machine's snapshots").

**[Disks](ui:machines:MachinesPage.disks.heading)** in the list of machines is the browser's disks (`DisksPane.svelte`): every disk and ramdisk, attached
or detached, with what it is, its overlays and the machines that have it. [Overlays…](ui:disks:DisksPane.overlaysButton) (a disk with overlays) opens
its Overlays dialog; **[Attach to a machine…](ui:disks:DisksPane.attach)** opens a dialog (`AttachDisk.svelte`) that lists the machines, each
attaching the disk last with its overlays (the machine running in this tab is powered off first, after asking); a
machine that has the disk already, has as many disks as a machine can (`MAX_DISKS`), or runs in another tab says so
and can't take it. **[Delete](ui:disks:DisksPane.deleteButton)** is for a disk no machine has (its tooltip names the machines otherwise), with its
overlays (`Store.deleteDisk`: the space comes back).

A transient machine (a test's `?machine=`, or `?disk=`) is listed first as this page's machine, with a Disks tab (its
disk's Export, Import changes…, **[Reset disk…](ui:machines:PagePane.resetDisk)**) and a Snapshots tab (restore from a file, save to a file). The
storage's estimate is at the bottom, with what takes it and, while remote disks' blocks are kept (docs/devices.md "Over
HTTP"), **Clear the URL disks' cache** (a running machine reading one gives its store up too, and reads from memory and the
network from then on); while Vulkan's translated shaders are kept, **[Clear Vulkan's shaders (…)](ui:machines:StorageBar.storage.clearShaders)**
(vk/README.md "The shader cache"; the store's size counts what IndexedDB holds, deflated).

### About

**[About](ui:machines:MachinesPage.about)**, last under the list of machines (after Preferences; `About.svelte`), is webpc's own: a link to its
repository (`package.json`'s `repository`), the version it was built from (the tag on the commit when one was cut, with
the commit; otherwise the commit; "with local changes" when tracked files differed), that commit's date (the console's
line has the same: below, "A static copy"), webpc's license, and **[Third-party software](ui:machines:About.thirdParty)**: a table per part
of the web app (the interface, the emulator, OpenGL's and Vulkan's renderers, networking, the UEFI firmware) of the
projects built into it or whose code ours is derived from, each with its version, its license (SPDX) and links to its
license texts at that version, and under a table the license file served beside the page that holds them all
(`EDK2-LICENSES.txt`, `VENUS-LICENSES.txt`, `THIRD-PARTY-LICENSES.md`). The rows are `THIRD_PARTY.json`'s marked
`about`, which Vite gives the page as `virtual:webpc-about` at build time, nothing else of that file
([third-party.md](third-party.md)). A link to another site opens in a new tab with `rel="external nofollow noopener
noreferrer"`; a file beside the page in a new tab. `tests/page-about.test.ts`.

## The worker protocol

The seed of phase D's embedding API; not frozen. One machine per worker: a restart stops the
worker and starts a new one (fresh memory, fresh ports).

Page → worker:
- `start {machine, ncpus, ramMiB, keyboard, tablet, serial, screen, params?, credentials?}`: three transferred `MessagePort`s
  and a transferred `OffscreenCanvas`. The keyboard's and the tablet's ports go to the device
  worker (web/input.ts's `attachInput` sends Linux input events to the other ends; LED changes
  come back on the keyboard's). `serial` is `BootOptions.serialIn`: strings or bytes for the
  PL011, handled on the machine worker's thread while `runAsync` awaits. `screen` is the page's
  canvas (`transferControlToOffscreen`, sized as the machine's framebuffer): the machine worker
  draws the framebuffer on it (web/display.ts) on its own animation frames. `params`: extra kernel
  parameters (direct-boot machines). `credentials`: systemd credentials over fw_cfg for a firmware
  machine, beside the machine's own (the network card's). `disk2`: a URL for the second disk.
  `disk`: `{url?, file?, overlay}`, the root disk to boot instead of the machine's (below, "Your own disk").
  `snapshot`: a `File` to start from instead of booting (below, "Snapshots"); `ncpus` and `ramMiB`, the kernel
  and the command line are then the file's.
- `snapshot {handle?}`: save a snapshot of the running machine to the file handle's stream, or,
  without one, back in `snapshot-chunk` messages; answered by `snapshot-done` or `snapshot-error`.
- `suspend`: stop the machine with its memory kept beside its disk ("Snapshots": Suspend); answered
  by the state `suspended`, or by `snapshot-error` (the machine runs on). `start.resume` false
  boots even if a suspended machine is there (it is dropped); otherwise a start resumes one.
- `stop`: stop the vCPUs and release the backends (the overlay's OPFS handles); answered by
  `stopped`. A machine still booting (`bootVm` not returned: its device worker may already have
  the overlay) is closed once it's there. The page then terminates the worker (after 3 s without
  an answer, anyway).

Worker → page:
- `state {state, error?, note?, problem?}`: `loading` (fetching the wasm, kernel, initrd), `booting`
  (the VM runs), `running` (the machine's `ready` marker appeared on the serial console:
  `readyWatcher` in machine.ts, over the output so far, across drains), `off`
  (PSCI SYSTEM_OFF), `rebooting` (PSCI SYSTEM_RESET: the page starts a new machine), `crashed`
  (the guest's `Kernel panic - not syncing` line, an emulator error, an unimplemented exit),
  `failed` (the machine couldn't start). `crashed` and `failed` carry an `error` for the user and a
  `problem` (below, "Errors"), from which the page picks the actions it offers. After a panic the
  state stays `crashed` even if the guest resets (`panic=N`), so the message stays on show. The worker renders no
  words ([i18n.md](i18n.md)): `error` is a `MsgError` as `toWire` posts it (its message the headline, its causes the
  details: the kernel's panic line, the emulator's stack, the overlay's lock), and `note` a message the page says
  beside the state (resumed, suspended). An `error` without a `problem` is a note too (a suspended machine that
  couldn't be resumed, so the machine boots).
- `progress {loaded, total}`: bytes downloaded of the core, the kernel and the initrd (from
  `Content-Length`), at most every 100 ms while `loading`.
- `screen`: the screen first showed a pixel that isn't black (the guest's console took it), once
  per machine.
- `serial {data}`: the serial console's output, UTF-8 decoded. The worker drains the TX ring
  after every `runAsync`, which returns as soon as there's new output (the core notifies the TX
  ring's head, docs/abi.md "Signal word and console").
- `status {status}`: once a second: vCPUs, RAM, uptime, steps, the JIT's blocks compiled since boot
  (a total: the flushes that the code cache's budget makes don't reset it), its flushes and compile time, IRQs. The page shows MIPS and IRQ/s from the differences.
  It also carries the run loop's cadence (`loopMaxMs`, `loopAgeMs`) and each vCPU worker's
  liveness (`vcpus`, web/liveness.ts: chunks, time inside the current `vm_run_cpu`, the longest
  chunk and the longest host-side handling of an exit). The worker posts it from a timer, not from
  its run loop, so a stuck loop shows as a growing `loopAgeMs` instead of silence. The page keeps
  the last status as JSON in the status bar's `data-status` (for `bench/stress`). For the status bar's
  rates it carries totals since this start (a restart, a resume or a snapshot's load starts them at 0):
  `disks` (bytes read and written, one per start message's `disks`, by slot), `nets` (bytes to and from
  the guest, one per `nets`; none without `network`) and `cpus` (each vCPU's steps and JIT steps,
  `Vm.cpuStats`; none in round-robin mode). The disk and adapter counters are the device worker's
  (`Vm.deviceIo`, devices.md "Threads and determinism").
- `phase {text}`: what a machine `loading` from a snapshot is doing (it has no download to report), a message.
- `notice {message}`: what the devices say while the machine runs on (a ramdisk out of memory, the storage full), a
  message.
- `snapshot-progress {phase, fraction}` (the phase a message), `snapshot-chunk {data}` (transferred; without a handle),
  `snapshot-done {bytes, pausedMs}` (the file is complete; the ms from the pause request to the
  resume) and `snapshot-error {error}` (the machine runs on; `toWire`'s error).
- `serial` also has `replay` for a restored terminal's saved tail.
- `stopped`.

The machine runs without `idleLimitMs`: an idle guest may sleep as long as it likes.

## Loading and boot progress

While a machine loads and boots, a card over the screen says what's happening: "Starting
Debian 13" with a progress bar over the downloads (the state reads "Loading 45%"), then "Booting
Debian 13" with the machine's latest serial line, until the machine worker reports `screen` (or the
machine is `running`). For a direct-boot machine, from there **the screen is the boot's progress**:
the kernel's console (fbcon) replays the boot log from the first line and systemd's status lines
follow, so the Screen view stays the default (loop 0's finding). **Through UEFI it isn't**: GRUB
passes no `console=tty0`, so the screen stays black until tty1's getty, and the firmware's menus
and the first boot's questions are on the serial console; the card stays until `running` and
says so, with a [Show serial console](ui:common:App.boot.serial.show) button for the serial view. On this host (M8 loop 4): the downloads (77.6 MB:
Debian's kernel, its initrd and the core; the 403 MB disk is read by ranges as the guest needs it)
take ~0.15 s from localhost, fbcon takes the screen ~2.4 s after the VM starts, and the login
prompt comes at ~29 s (page load to `running`: 28.6, 29.1, 28.9, 29.0 s; loop 3: 28.6–29.0).

## Errors

What stops a machine is said in the message bar under the toolbar: what happened, why, and what to do, with
buttons for the actions that apply. Checked on the page before a worker starts:

- **No cross-origin isolation** (`crossOriginIsolated` false: served without COOP/COEP, or from
  a file): the shared memory can't exist. The page says to run `npm start` and open its URL; it
  starts nothing.
- **The page's scripts didn't load** (xterm.js missing from `node_modules`, so the module graph
  fails): an `onerror` on the module's `<script>` tag says to run `npm start`.
- **Too little memory** for the machine: Chromium has no catchable out-of-memory error (the
  renderer is killed; PLAN.md §4 "Guest RAM ceiling"), so the page compares
  `navigator.deviceMemory` (GB, rounded down to a power of two, at most 8 in Chromium) with
  `hostMemoryGiB` in machine.ts: the guest's RAM + 1 GiB + 0.3 GiB per vCPU (M8 loop 0's RSS: 2.3
  GiB on 1 vCPU, 3.1 on 4, with 1 GiB of guest RAM), plus the JIT's budget past 160 MiB four times over
  (`jitHostGiB`: the rule was measured with up to 160 MiB; Firefox's pages session at 320 MiB took the renderer
  0.5-0.7 GiB higher; a smaller budget takes at most 0.25 GiB off), so 0.625 GiB more at the default 320. Below it the page doesn't start the machine
  (state `idle`, "[Not started](ui:machine:main.state.idle)") and offers **[Start anyway](ui:machine:main.memory.start)**, naming a vCPU count that fits if one
  does. A device that reports 4 GB or more runs Debian's default on up to 4 vCPUs.
- **A tab that went away with its machine running** (the memory signal, `web/app/memory.ts`; [jit.md](jit.md) "The
  page's memory signal"): while a machine runs, the page keeps a mark of it in `localStorage` (`webpc.alive.<stored
  machine's id>`, or `webpc.alive.transient-<machine>`) with its RAM, vCPUs, JIT budget and what it costs by the
  emulator's own accounting (the estimate and its peak), renewed every 10 s and cleared at every clean stop. A mark
  that no tab has renewed for 30 s means the tab was closed for it, most likely out of memory: the next start of that
  machine (state `idle`) says so, with the estimate, and offers **Start with a 160 MiB JIT cache** (64 if it was 160
  or less), **Start with N MiB of RAM** (half or less; a stored machine's snapshots of the old size are orphaned, so
  it asks first) and **[Start as it is](ui:machine:main.crashed.asIs)**. The choice is saved in the stored machine's record, or for a transient
  machine in `webpc.settings` (`jitMiB`, `ramMiB`). While it runs, past what `navigator.deviceMemory` reports the
  machine worker caps the JIT cache at what it holds (it flushes there).
- Another browser than Chromium (no `Chromium` brand in `navigator.userAgentData`): a standing
  note that webpc is developed and tested in Chromium; nothing else changes.

From the machine worker, as `problem`:

| `problem` | When | Actions |
|---|---|---|
| `missing-core` | the wasm answers 404 (or the server doesn't answer) | Retry (the message says `npm start` builds it) |
| `missing-image` | the kernel, initrd or disk (a `HEAD`) answers 404 | Retry (the message names the file and the machine's `prepare` command) |
| `disk-in-use` | the overlay's files are locked (`NoModificationAllowedError`, or web/overlay.ts's `overlay-in-use` problem, which crosses from the device worker with its fields): another tab runs the machine | Retry, once that tab is closed |
| `disk-mismatch` | the overlay's `base` names another image (web/overlay.ts's `overlay-mismatch`) | Reset disk… (a transient machine); Disks… (a stored one: its Disks tab, where New empty starts over) |
| `memory` | reserving the guest's RAM throws a `RangeError` | Retry |
| `panic` | the guest's `Kernel panic - not syncing` line | Show serial log, Copy serial log, Save serial log |
| `snapshot` | a snapshot was refused (`SnapshotError`: another machine, another disk, damaged or truncated, devices this page can't make; below, "Snapshots") | Start, Load snapshot… |
| `emulator` | anything else (an exception, an unimplemented exit) | the same three |

Retry and Restart start a new machine worker. The failed states (`failed`) make the toolbar's
Start button read Retry. **The serial log** is kept by the page (the last 1–2 MB of the serial console's
output, beyond xterm.js's 5,000 lines of scrollback) for Copy (the clipboard) and Save (a
`webpc-<machine>-serial-<time>.log` download); Show serial log switches the Screen view to Both.

## Snapshots

The running machine, RAM and the disk's changes and all, in a file; and back (the format and the
machinery: [platform.md](platform.md) "Snapshots" and "The snapshot file").

**[Snapshot](ui:toolbar:Toolbar.snapshot)** (the toolbar, enabled while the state is `running` or `booting`; a transient machine's goes to a file, a
stored machine's is kept: below, "A stored machine's snapshots"): the picker first
(`showSaveFilePicker`, which needs the click's user activation; suggested name
`<machine>-<yyyy-mm-dd-hhmm>.webpcsnap`), else a Blob download, as a disk's Export does. No confirmation:
the machine isn't stopped. One exception, asked before the picker (its OK is the click the picker needs): a machine
whose 3D state would add 64 MiB or more (the GPU worker's count of its resources' bytes, before compression:
`VirglRenderer.snapshotBytes`) says how much, and that the machine pauses while it is read (graphics.md "Snapshots with 3D in use"); the
same for a stored machine's kept snapshot. The worker pauses it (`vm.pause()`), writes the file with
`writeSnapshot` and resumes, also on an error. The state line shows the phase and a fraction
("Writing the snapshot 40%"); afterwards a notice in the message bar says the file, its size and how
long the machine was paused (the numbers are also in `#message`'s `data-snapshot`, JSON, for
tools), and the machine runs as before. Only the writing is between pause and resume: the picked
file's stream is opened before and closed (flushed) after, and nothing is hashed. One save at a
time: while it runs Restart, Power off, Suspend, Snapshot and Load snapshot are disabled, and a disk's Export, Open
disk and Import changes say to wait. The run loop is not disturbed by the pause
(`runAsync` keeps returning `BUDGET`), the status timer and the flash keeper only read.

**Load snapshot** › From a file… (the toolbar's menu; also the Snapshots tab's Restore from a file…), and a snapshot
file chosen with Open disk… or dropped on the page, told from a disk image by its first 8 bytes (`WEBPCSNP`). The page reads the
header (`openSnapshot` without a codec) before it asks anything, and refuses at once, with the
machine running on: a file that isn't a snapshot or whose header is damaged, a snapshot of another
machine (`?machine=` differs), and one taken on another disk by name (the header's `disk`, for a
disk opened with Open disk… or `?disk=`; the user opens that disk first). Then a confirmation says
what the file is (machine, date, size, vCPUs) and that **the machine is stopped, like pulling the
plug, and replaced by the snapshot's, and what this machine's disk has written (the overlay's size,
as Reset disk says) is replaced by the snapshot's changes to the disk**. Then, through
`exclusively`: `stop()`, a new worker with `start.snapshot` (the `File`).

**The worker's start from a snapshot** downloads the core only (no kernel or initrd), compiles it
once (the same module goes to `bootVm` and to the LZ codec, `lzCodec`), reads the header, and makes
the devices **as the header says** (`devices`, below) from what the page passed, with `ncpus` and the RAM size (`ramSize`) from
the header (the status line shows them, not the page's `?ncpus=` or Machine menu). Then `readSnapshot` checks
everything that can be refused before anything is touched (the whole file's checksums, the core's
state version, the disk's identity), and only `bootVm` with `restore` replaces the overlay by the
file's blocks. For a firmware machine the restored flash bank is written back beside the new
overlay (the restore deleted the copy) before `running` is posted. The state goes from `loading`
(with `phase` messages: "[Checking the snapshot](ui:snapshots:worker.phase.checking)", "[Restoring the machine](ui:snapshots:worker.phase.restoring)"; there is no byte
progress) straight to `running`: the machine is where it was, there is no marker to wait for. The
saved serial tail is written to the terminal first (`serial` with `replay`: xterm.js answers a
cursor-position query in it while parsing, and the page doesn't send those answers to the guest, which
isn't asking now: bash printed them as `;1R;80R`).

**The header's fields** (beside `web/snapshot-file.ts`'s own: `format`, `coreVersion`, `abi`,
`created`, `ramSize`, `disks`, and `spill`, the spill memories' sizes, only on a machine with RAM past memory 0):

| Field | What |
|---|---|
| `machine` | the `MachineName` (`debian`, `buildroot`) |
| `label` | the machine's label, for messages |
| `ncpus` | vCPUs the machine ran with |
| `disk` | the display name of the disk it was on when that was a chosen disk (file name, or a URL's last segment); `null` for the machine's own |
| `devices` | the device kinds in slot order (`shape.ts` `slots`: `rng`, `keyboard`, `tablet`, `net`, `gpu`, `snd`, `mouse`, `touch`, then a `blk` per disk); a restore refuses one whose list isn't the machine's now, naming both |
| `cpu` | the vCPUs' optional features, of `rng`, `e0pd`, `sha3`, `jscvt`, `rcpc`, `sb`, `flagm`, `dit`, `frintts`, `dotprod`, `i8mm`, `rdm`, `rcpc2`, `fcma`, `fp16`, `fhm` and `bf16` (docs/cpu.md; the page's `?<feature>=0` turns one off, `?i8mm=1`, `?fcma=1`, `?fp16=1`, `?fhm=1` and `?bf16=1` turn FEAT_I8MM, FEAT_FCMA, FEAT_FP16, FEAT_FHM and FEAT_BF16 on); a restore gives the machine the same, and a snapshot without the field (before ABI 35) none. A shape's hash leaves `sha3` out (it came after shapes), so snapshots kept before it still match their machine |
| `serial` | the last ~4 KiB of serial output the worker posted, cut at a line start |
| `name`, `shape`, `shapeHash`, `urls` | a stored machine's (format 2): its name, its shape and the shape's hash (a restore onto a machine whose hash is another is refused), and its URL disks' URLs by slot (a machine like it can be made again) |

`disks` (`SnapshotDisk`, web/snapshot.ts) pins each writable disk: its slot, identity, size, the blocks the file
carries, the overlay's path and its **generation** when the snapshot was taken (the device worker reports it while
the machine is paused, and sets the next write to move it on: writes after a snapshot are another generation), and
`ram` for a ramdisk.

**Errors.** `SnapshotError` (`web/snapshot-file.ts`) becomes the `snapshot` problem, whose actions are
Start (a normal boot) and Load snapshot… again. The message says what was refused and, from
`readSnapshot`, that nothing was touched ("the machine isn't running and its disk is as it was");
past that point (`bootVm` has the file) it says the disk may hold part of the snapshot's changes
and offers Reset disk.

### A stored machine's snapshots

[machines.md](machines.md) §5. The toolbar's **[Snapshot](ui:toolbar:Toolbar.snapshot)** on a stored machine **keeps** one at once (no question: it's
the panic button), named by the date and time; the Snapshots tab renames it. Keeping: the worker writes the file to
OPFS `machines/<id>/snapshots/<id>` (`start`'s `snapshot.keep`), then the page writes its record (its pins, the
shape) inside `Store.writing`. The toolbar's **Load snapshot** lists the five latest (orphaned ones disabled). The
Machines page's Snapshots tab lists them all, newest first: **[Restore](ui:snapshots:Snapshots.restore)** (on the page's machine), **[Rename](ui:snapshots:Snapshots.rename)**,
**[Download](ui:snapshots:Snapshots.download)** (the file as kept), **[Delete](ui:snapshots:Snapshots.delete)**; [Import a file…](ui:snapshots:Snapshots.import) copies a file into them (one of another shape is kept,
orphaned), [Restore from a file…](ui:snapshots:Snapshots.restoreFile) restores one at once, and [Save a snapshot to a file](ui:snapshots:Snapshots.toFile) writes one out (asking
first, when a disk is written in place, whether the whole disk goes in, §4.4).
- **Orphaned:** a kept snapshot whose shape hash isn't the machine's now (its RAM, vCPUs, display, disks…). It is
  struck through, with what differs (`shapeDiff`: "memory: 1024 MiB then, 2048 MiB now"), and offers **Make a machine
  like it** (`machineLike`: the settings and disks from the shape, the disks the browser has attached again by
  identity, blank disks and ramdisks made again under their ids, the attachments under the snapshot's serials; the
  snapshot moves to it). [Delete orphaned snapshots](ui:snapshots:Snapshots.deleteOrphaned) deletes them all after one confirmation with their total size.
  Saving changed settings warns that they orphan the snapshots.
- **A restore never destroys a disk's state** (`planRestore`, web/app/snapshots.ts): per writable disk, an overlay
  that is the snapshot's pinned one at its pinned generation is **kept** (nothing written: the restore is RAM and
  state); one that moved on **forks**: a new overlay named after the snapshot gets its blocks and is attached, the old
  one stays as it was; an earlier fork of the same snapshot that hasn't moved since (its generation is still the
  restore's, 1) is attached again instead of forking once more. The confirmation says which disks fork, and a second
  one offers to **replace** instead (the attached overlay takes the blocks; what was written since is lost). A
  replaced overlay's generation goes on from its old one, never back to one a snapshot pinned. A disk written in place
  keeps only at its pinned generation; else a file with the whole disk forks it into an overlay (zeroed first, so the
  moved store under it doesn't matter), and one without is refused with the reason. A ramdisk takes the file's blocks
  (its new chunks are handed to the device: `BlkSpec.ramInit`). The page passes the worker the plan
  (`start.plan`); transient machines (the tests') have none, and a restore replaces their overlays as before.

**[Suspend](ui:toolbar:Toolbar.suspend)** (the toolbar, for a machine with an overlay; enabled while `running` or `booting`): the
machine stops and its memory stays in this browser; opening the page again, or Start, resumes it
where it was. Nothing is asked: nothing is lost. The worker pauses the VM, writes its snapshot
**without the disk's blocks** (`writeSnapshot`'s `suspend`: they are in the overlay already) to
the file `suspend` in the overlay's OPFS directory (`suspendWriter` in web/overlay.ts), closes the
VM without another step, and posts the state `suspended` (its message says the size; the actions
are Start and Boot instead). A failure before that leaves the machine running.
- **A start resumes.** The worker looks for a suspended machine beside the disk before it
  downloads a kernel (`suspended`), and starts from it as from a snapshot file, except that the
  overlay is kept (`readSnapshot`'s `resume`): `loading` ("[Resuming the suspended machine](ui:machine:worker.phase.resuming)"), then
  `running` with the note "[Resumed the suspended machine.](ui:machine:worker.resumed)" If it can't be resumed (another core
  version, a damaged file), it is dropped and the machine boots, with a note saying so.
- **It resumes only onto its disks as it left them:** the file pins each overlay's path and generation, and the
  worker compares them (`overlayMeta`) before resuming: a switched overlay, a reset, a merge or a boot since moved
  them on, and the copy is dropped with a note ("[Its disk has changed since it was suspended.](ui:machine:worker.diskChanged)"). The worker also still
  drops it (`dropSuspend`) right after a resume's `bootVm` and before a boot the page asked for (`start.resume`
  false: Boot instead). A ramdisk's blocks are in the file (they are nowhere else). A stored machine's copy is
  `machines/<id>/suspend`; a transient one's is beside its overlay.
- A suspended machine's file is not a snapshot to take elsewhere (it has no disk): `readSnapshot`
  refuses it without `resume`, and Save snapshot is what leaves the browser.
- A disk of one's own (Open disk…, a drop) is a stored machine's, so its suspended copy is the machine's and the page
  reopens it after a reload (the last machine): a file disk needs the user's click first ("[Allow and start](ui:disks:main.allowAndStart)", or
  "[Select and start](ui:disks:main.pickAndStart)" without a handle), then it resumes.

### The guest's clock

Without help, a snapshot is a pause the guest can hardly tell: the counter goes on from where it was saved, so the
guest's own clock is behind by the time the file sat (or the machine was suspended) until something sets it
(`hwclock -s`, timesyncd over a network); the RTC shows the host's time. Turning the catch-up off keeps that, for
those who pause a machine so that it doesn't notice.

**The clock catch-up** (Preferences' "[Suspend the guest before taking a snapshot](ui:machines:PreferencesPane.clockSync)": the behaviour that shows, the clock being why; `settings().clockSync`, **on by
default** since 2026-10-25, the user; `?clocksync=1` or `0` decides for the page, the last one if there are several:
`web/app/settings.ts` `clockSync`; the page tests' `PAGE_QUERY` turns it off, `tests/page-clock.test.ts` on) makes it notice as a laptop
does: Snapshot (both kinds) and Suspend first press the guest's **sleep key** (`KEY_SLEEP` on the virtio-input
keyboard, `Input.chord('Sleep')`; systemd-logind suspends on it by default), and the worker waits up to 10 s for the
guest to suspend itself (PSCI SYSTEM_SUSPEND: [platform.md](platform.md) "System suspend"; [Putting the guest to
sleep](ui:snapshots:worker.phase.sleep) in the state line) before it pauses the machine. A file taken while the guest slept says so (`slept: true` in
its header), and **loading it** (a snapshot, or a suspended machine resumed) moves the guest's clock on by the time
since the header's `created` (`vm_clock_skip`) and wakes it: its resume counts that as sleep, so its wall clock is
the browser's again and its monotonic clock hasn't jumped (nothing it times runs out). The running machine wakes once
its file is written, its clock moved on by the time the core held it for the write. A guest that doesn't suspend on
the key in time (no logind, or the key handled elsewhere) is saved as it is, and the message says its clock will lag;
with the catch-up off nothing is pressed and nothing moves. Measured on Debian in a cloud session
(`tests/page-clock.test.ts`): within 0.4 s of the host after its own save, after a resume 20 s on and after a load
minutes later, against −80 s for a load 80 s on with it off.

**A guest that suspends itself** (`systemctl suspend`, a desktop's idle suspend, the catch-up's key arriving late)
sleeps until a key or a click on its screen or terminal: the worker's status says `asleep` (`vm_suspended`), the page
says so once in the message bar, and the next input posts `wake` (`vm_wake`) before going to the guest. Keys typed
while it resumes (under a second on Debian) may be lost, as on a machine still waking.

**The clock device** (virtio-rtc, [devices.md](devices.md) "clock"): a device kind of its own (`clock`, after the
pointers and before the disks in `slots`), on transient machines unless `?clock=0`, on machines made from now on
(their Settings' "Clock device"), and off on machines made before it, whose shape is as it was. A guest with a driver
for it gets a PTP clock that reads the browser's time (chrony's `refclock PHC` keeps its clock there through
anything) and a read-only RTC. A snapshot or a suspended machine from before the device restores without it (it holds
no state: `fromHeader` takes the layout without `clock` when that's the file's).

**Limits.** No hash of the base image is written (nothing computes or caches it off the save path
yet), so `readSnapshot` requires the same disk identity: the machine's own disk, or the same file
(name, size, modification time) or URL. The network across a snapshot isn't handled: the guest
keeps its DHCP lease and its connections are gone with the Tailscale client's. The guest's clock
lags by the time the file sat around until something sets it (the RTC is current), unless the clock catch-up is on
(above). A snapshot is for the core versions that read its format (`snapshot_version_min` to `snapshot_version`).

## The screen

**The machine worker draws the screen**, not the page: the page hands its canvas over
(`transferControlToOffscreen`; a canvas can do that once, so each machine gets a fresh canvas
element) and `display.ts` runs on the worker's animation frames. Each frame compares the
framebuffer with the frame drawn last and puts only the rows that changed (`putImageData` with a
dirty rectangle); an unchanged frame costs a scan (~0.4 ms at 1024×768) and no drawing. The page's
main thread has no per-frame work: its cost of drawing the screen is zero.

Why (M8 loop 3, headless Chromium on the dev VM; bench/boot/REPORT.md "M8 loop 3"): with the
page's own animation-frame loop (a full copy per frame, or dirty rows only: the same), a key's echo
on the **serial terminal** took ~30 ms, of which ~20 went to the page: messages from the worker
waited and xterm.js's render landed a frame late whenever the page ran a `requestAnimationFrame`
loop. Without a loop on the page it took ~11 ms (Debian) and ~6 ms (Buildroot). A timer poll on
the page instead of the frame loop helped the terminal but cost the screen ~10 ms; drawing in the
worker kept both.

**Debian's screen is a virtio-gpu** (`MACHINES.debian.display = 'gpu'`; docs/devices.md "virtio-gpu"): the
guest sets its own mode and the firmware has a graphics output, so EDK2's logo, boot progress bar and screens
(the GOP is a console beside the serial port: docs/firmware.md "Our patches"), GRUB's menu
and "Loading Linux…" appear on the screen, then the console (fbcon on `virtio_gpu`, which loads from the
root filesystem a few seconds into the boot) takes it. **The device worker draws it**: the page's canvas
goes machine worker → device worker, whose backend puts each flush's damaged rectangle on it
(`web/gpu-present.ts`: no scan of guest memory, accumulated rectangles, drawn at once if the last draw was a frame
ago and otherwise on a 16 ms timer: Chromium gives a device worker no animation frames, "requestAnimationFrame not
supported in this Worker"). **Where the browser has WebGL2 on a GPU** the rectangle is the guest's bytes uploaded to
a texture and the scanout is drawn through the format's swizzle (the 3D machine's `Screen`, `web/virgl-screen.ts`; a
lost context is drawn again when it comes back); elsewhere, software WebGL included (SwiftShader: every present on
the CPU), it is an `ImageData` over the device's RGBA copy on a 2D context (bench/gpu/REPORT.md "A 2D machine on
WebGL2"). The console says which (`webpc: the 2D screen on WebGL2`); `?gpu=gl2d` and `?gpu=canvas2d` choose.
The page's main thread still has no per-frame work. The canvas takes the scanout's size, and the page
refits its box when the display port says `mode` (the boot card hides at the first one). GRUB's menu is on the screen only (`gfxterm` takes the firmware's graphics output); **the firmware's keys** come
from the built-in USB keyboard on a machine with the USB controller, and from the serial terminal on one without
(EDK2 has no virtio-input driver; "Input" below). `?display=simple` gives a gpu machine the simple framebuffer
instead (the firmware then keeps its serial menus: `tests/page-disk.test.ts` uses it).
Flush-to-draw latency (`bench/gpu/draw-latency.ts`, Debian, tty1 changing every 30 ms): median 16–17 ms idle
(the timer, for a flush within a frame of the last draw). With the guest reading its disk, virtio-blk's synchronous
reads share the device worker and a flush is served between them: since the device worker yields to its event loop
every ~2 ms of work, the worst case is 22–33 ms (bench/io/REPORT.md "Loop 5 judged"; it was 89–972 ms before, which
is why moving blk off that thread was considered, and dropped).

**A desktop on the screen:** a compositor's frames arrive as full-screen transfers at its own rate (a guest kernel
from 6.19 paces itself at 60 Hz; for older ones the device answers one flush per frame, docs/devices.md), and the page
draws at most one per frame. **sway should run with `WLR_RENDERER=pixman`** (other wlroots compositors likely too):
left alone on a display without 3D, Arch's picked Mesa's llvmpipe, which under the JIT costs about ten times the CPU
and draws on its own threads after the page flip, so the screen shows frames late and in pieces (graphics.md "Guests that composite with llvmpipe").
On a 3D machine (below) it should run with `WLR_RENDERER=gles2` instead: Mesa's virgl driver, drawn by the host.

**A 3D machine** ([graphics.md](graphics.md)) gives a virtio-gpu machine virgl, rendered on the host by WebGL2: the default
wherever the browser has WebGL2 (since G3). The Machine menu's **[Graphics](ui:toolbar:SizeMenu.size.gpu)** (3D or 2D, kept in the browser's
settings, applied by a restart) turns it off; the query is over the menu: `?gpu=2d` keeps the 2D path above,
`?gpu=virgl-null` G2's null renderer, `?gpu=virgl` 3D (the menu's choice is then greyed out, as it is without WebGL2).
A machine's Vulkan setting (the Machines page's Settings, beside 3D) or `?gpu=vulkan` (with 3D) also gives the machine Vulkan through Venus (devices.md "Venus"; its programs draw on the browser's WebGPU and their frames reach the screen through the virgl renderer; without WebGPU they draw nothing). The renderer's module (vk/build.sh) is fetched only by such a machine. Its translated shaders are kept across runs in IndexedDB `webpc-shaders` (the origin's, for every machine, deflated, under the Preferences' [Space for Vulkan's shaders](ui:machines:PreferencesPane.shaderBudget), 32 MiB by default, an entry of another renderer build dropped at the load; vk/README.md "The shader cache"); `?gpu=vkcache=off` keeps none, `?gpu=vkpipelines=sync` makes its pipelines at once, `?gpu=vkpremake=on` makes render pipelines at `vkCreateGraphicsPipelines` too (not only at draws; a loss, vk/README.md "Pipelines made asynchronously"), `?gpu=vkqueues=1` gives the device its graphics queue family alone (vk/README.md "The driver"), `?gpu=vkimport=rewrite` gives each image imported from a virgl resource a texture of its own (vk/README.md "Imports") and `?gpu=vkskip=<path>` leaves an emulated path's work out (wrong pixels: vk/README.md "What the emulated paths do"; all for A/B). `?gpu=capsno=<FORMAT>[+<FORMAT>…]` (a `+` or a space between names: the query's `+` is a space) takes virgl formats (their names in web/virgl-formats.ts, `Z24_UNORM_S8_UINT`…) out of every mask the 3D caps advertise, for an A/B of what the guest's Mesa and its programs choose (the console says what went; a snapshot taken without them may not load with them); `?gpu=capsyes=<BIT>[+<BIT>…]` offers capability bits vrend has and the renderer doesn't back (`COPY_IMAGE`, `TGSI_FBFETCH`, `INDIRECT_INPUT_ADDR`, `V2_BLEND_EQUATION`…: web/virgl-caps.ts `CAP_BITS`), the guest's paths for them, what needs them possibly drawn wrong.
A 3D machine also advertises the browser's video decoders (WebCodecs) to the guest's VA-API driver and decodes with
them ([graphics.md](graphics.md) "Video"): H.264 and VP9, in hardware where the browser
has them and in software elsewhere (`?gpu=swvideo` decodes in software even where there's hardware, for experiments);
`?gpu=novideo` turns that off.
The page starts a **GPU worker** (`web/gpu-worker.ts`, top-level, so it has animation frames) and hands it the
canvas instead of the machine worker. The GPU worker makes a WebGL2 context on it, builds the caps the guest will
see from that context (`web/virgl-caps.ts`: limits, extensions, renderable formats; never more than it backs) and
says `ready`. The machine then starts with those caps and a port to the GPU worker (the gpu spec's `renderer`,
`web/devices.ts`). The device worker keeps the virtqueues and forwards its 3D work (`web/virgl-host.ts`: contexts,
resources, backings, transfers, submits; the guest's RAM is shared) and every scanout to the GPU worker. That
includes 2D ones (the firmware, the console), whose pixels are in shared memory and whose damaged rectangles go up
to a texture. The GPU worker runs the renderer (`web/virgl-renderer.ts`) and draws the screen
(`web/virgl-screen.ts`) once per animation frame, however many scanout and damage calls a frame brought. Drawing
at each call committed up to three canvas frames per guest frame, which Chromium holds to the display's rate, and
capped sway at 39 frames a second. A fenced command's reply waits until the GPU worker has run everything before it.
Without WebGL2 (or if the context can't be made: `failed`) the machine starts again as 2D, and a lost context
crashes the machine with a message. Sway with `WLR_RENDERER=gles2` keeps 60 frames a second on a real GPU,
the same as with no renderer at all (graphics.md "Applications on 3D"). Snapshots of a 3D machine: graphics.md "Snapshots
with 3D in use".

The simple-framebuffer's canvas keeps the framebuffer's size; CSS scales it to an integer multiple **in device pixels**
when one fits the view (`image-rendering: pixelated`: crisp at any `devicePixelRatio`), and
scales it down smoothly when it doesn't fit at 1:1. A `ResizeObserver` and a `resolution` media
query refit it.

**The guest's size follows the page** on a virtio-gpu machine (Debian's page). The page measures the
screen's box (`wantedSize` in `main.ts`): CSS pixels by default, device pixels with the Screen menu's
**[HiDPI](ui:toolbar:ScreenMenu.screen.hidpi)** setting; the width is rounded down to a multiple of 8 (the guest's CVT modes are, and a
sliver would show), at least 640×480, at most 4088 (what the EDID's detailed timing can say). The
Screen menu's **[Size](ui:toolbar:ScreenMenu.screen.size)** picks a fixed size instead (1024×768, 1280×800, 1920×1080); both settings are
remembered per browser. The start message carries the size (`start.size`: the console and the
firmware are born at it, no event), and later changes go to the display port as `size`, debounced
300 ms (a window drag is a stream), once more when the machine is `running` (a restored one starts at
the size it was saved with). The canvas shows the scanout 1:1 in guest pixels, so with HiDPI off on a
screen of fractional density (1.25, 1.5) it is one guest pixel per CSS pixel and a little soft; an
integer density is crisp. A guest that doesn't take the size is letterboxed (the box centres the canvas).
**What the guest does with a new size** is measured in graphics.md "The console and the display size": fbcon can't grow its
buffer, so the console stays at its born size (a bigger window shows it letterboxed), and a smaller window is
never allowed to crop it (devices.md "Display size and events"); sway keeps the size it started with
(wlroots seems to read an output's modes when it connects, not at a display event); GNOME and KDE are expected to
follow and weren't measured. So today a new size mostly takes effect when the guest's display software
starts; following live is the agent's job ([plans/agent.md](plans/agent.md)).
`tests/page-debian.test.ts` covers it on Debian.

**The guest's cursor** (virtio-gpu machines) is the canvas's CSS cursor: the presenter sends the 64×64 image and its hotspot when
they change (`cursor`; its moves as `cursor-at`, which the page uses only under the mouse lock: the tablet is absolute, the host's pointer is the guest's), and the page draws it at the canvas's scale into
a blob (`image-set(url(…) <dpr>x) hotX hotY, none`; at most 128×128 device pixels, followed by the same cursor cut to its top-left 32 CSS pixels: Chromium skips a cursor over 32×32 where its image would reach past the page's edge, which made the guest's cursor vanish in the last 64 pixels), again whenever the scale changes. A cursor the guest
never set leaves the page's own pointer (EDK2's screens and a console with no mouse driver keep one); one it hid is
`none`; a virtio reset goes back to never set (`GpuHooks.cursorReset`), and so does the machine stopping (off, suspended,
crashed: the page's pointer is back over its last screen); a restored snapshot sends its cursor again.
The image is smoothed only when the scale isn't whole; Chromium normalizes `-webkit-image-set(...)` to `image-set(...)`.
A guest that warps its cursor (`MOVE_CURSOR` away from the pointer) isn't shown: none seen (backlog).

## Sound

Every page machine has a sound card, a virtio-snd ([devices.md](devices.md) "snd", [audio.md](audio.md)),
on by default ([audio.md](audio.md) "Decisions"). Each start makes a new **sound ring** and port (`PageAudio.attach` in
web/audio.ts), passed in the start message (`sound`) to the device worker's realtime sink. When the guest starts a
stream, the device says so on the port with the stream's rate; the page makes an `AudioContext` at that rate (so the
browser resamples to the output device; a new rate makes a new context; `latencyHint: 'interactive'`), loads the
worklet (`web/audio-worklet.ts`) on the ring, and puts a `GainNode` (the volume) before the output. The frames
never cross the main thread: the worklet reads them from the ring, the device worker writes them. Once a second the
page writes the context's output latency into the ring's header, and the guest gets it with each completion.

- **The browser's autoplay rule:** a context made before the page had a user gesture starts suspended. The page
  resumes it at once (that works after any earlier click) and at every click or key anywhere on the page; meanwhile
  the sink's own clock plays the ring, so the guest's sound keeps time and nothing stalls, and the menu's summary
  reads [Sound: click to hear](ui:sound:Sound.summary.waiting) (with an accent border).
- **The Sound menu:** Sound on (unchecked: muted, the gain at 0; the guest still plays in real time), Volume
  (0-100%: the gain is its cube, as PipeWire's and PulseAudio's sliders), Microphone and Raw microphone (below). Both apply live and are kept in this browser (`muted`, `volume` in `webpc.settings`); the summary reads
  [Sound (muted)](ui:sound:Sound.summary.muted) when off. Not in the Machine menu, whose choices apply by a restart.
- **The guest's mixer:** Volume and Sound on are the guest's `Master Playback Volume` and `Switch` (the sound
  device's controls, [devices.md](devices.md) "snd"), where its kernel has them (Linux 6.7 and later): a machine
  starts at the menu's, the guest's changes move the menu (WirePlumber puts a new output at 40%; shown, not kept
  in the browser), and the menu's changes reach the guest (`PageAudio.setVolume(…, true)`, the device notifies it).
- **The microphone** (audio S4: [audio.md](audio.md) "Decisions"): each start also makes a **microphone ring**. When the guest
  starts recording, the device says so on the port with the stream's rate; unless **[Microphone](ui:sound:Sound.mic)** is unchecked, the page
  asks for the microphone (`getUserMedia`: the browser's prompt the first time) with the browser's echo cancellation,
  noise suppression and gain control, or none with [Raw microphone](ui:sound:Sound.micRaw) (for music), makes a context at the stream's rate
  with a `MediaStreamAudioSourceNode` into the `webpc-mic` worklet, which writes the ring, and the summary reads
  [Sound · mic](ui:sound:Sound.summary.onMic). When recording stops the microphone and its context are closed (the browser's indicator goes off). Off,
  refused (the menu's hint says so) or until it's granted, the guest records silence in real time. Both choices apply
  live (the microphone is opened again) and are kept (`mic`, `micRaw`).
- **Restarts and stops:** the rings are dropped with the machine (`detach`, the microphone closed); the playback
  context stays (a new machine reuses it at the same rate, without needing another click).
- Not covered headless ([audio.md](audio.md) "Measurements"): the real autoplay prompt (headless Chromium runs contexts without a
  gesture; the test suspends the context instead) and a hidden tab.
- **Measurement hooks:** `?snd=` exposes the page's `PageAudio` as `window.__audio` (its ring's header, context,
  output node and an analyser tap, the microphone's state, ring header and track settings; `?snd=stats` adds the device's completion timing); `?avprobe` makes the screen
  (the device worker's 2D presenter, or the GPU worker's `Screen` on a 3D machine, which reads its centre pixel back
  after each present) post the time of every draw that turns the screen's centre from dark to bright, kept in
  `window.__flashes` (ms on the page's clock): A/V sync's picture end (`bench/audio/avsync.ts`).

## Input

- **Focus:** the screen takes the keyboard on a click (tabindex 0; the page focuses it on load
  and when the Screen or Both view is chosen, the terminal in the Terminal view). A focused
  screen has an accent ring; an unfocused one shows [Click to type](ui:common:App.screen.hint) over it. The terminal's frame
  takes the accent while xterm.js has the focus (its cursor is filled then, too). Tab moves
  between them.
- **Before the guest's keyboard driver** (the firmware, the boot loader, an initramfs: the worker's `keyboard
  {live}` is false), the screen's keys go to the built-in USB keyboard on a machine with the USB controller
  (every key, down and up, held modifiers; docs/usb.md "The keyboard"), else to the serial console as a terminal
  sends them (`terminalBytes`: keys with a terminal encoding only). Once the driver is live they are
  virtio-input's, and the USB keyboard is unplugged.
- **No stuck keys:** `attachInput` tracks what the guest believes is held and releases it (keys,
  then mouse buttons) when the screen loses the focus, the window loses it, or the page is
  hidden; a keyup for a key the guest doesn't hold is dropped. A pointer press captures the
  pointer, so a drag that leaves the screen still ends there.
- **Keys the browser keeps:** the Keys menu shows or hides the on-screen keyboard (below), and sends Esc, Ctrl+W,
  Ctrl+T, Ctrl+N, Ctrl+Q, Alt+F4, Alt+Tab, Super, Ctrl+Alt+Del and Ctrl+Alt+F1 to F12 (a grid of F-keys under
  "Ctrl+Alt+") to the screen's keyboard (`Input.chord`: pressed in order, released in reverse). **[Hold Esc](ui:toolbar:KeysMenu.keys.holdEsc)**
  holds Escape for 3 s (`page.holdKey`; the guest's kernel repeats it): a browser in the guest whose page locked the
  keyboard in full screen leaves it on a held Esc (Chromium's ~2 s). On Debian, Ctrl+Alt+Del reboots (systemd's `ctrl-alt-del.target`;
  the page then starts a new machine), and Ctrl+Alt+F2 to F6 switch to tty2–tty6, where logind
  starts a getty on demand (autovt, `NAutoVTs=6`); F7 to F12 switch to consoles with nothing on
  them. The smoke test checks the chord of F12 (the highest keycode of the set, 88).
- [Full screen](ui:toolbar:Toolbar.fullscreen) puts the views (`main`) in full screen and asks for the **Keyboard Lock**
  (`navigator.keyboard.lock()`, Chromium, effective only in full screen): Ctrl+W, Ctrl+T, Esc and
  the like go to the machine, and holding Esc leaves full screen (Chromium says so on entry).
  Without the lock (refused, or another browser) full screen still works and the browser keeps
  its shortcuts. Headless tests can't check the lock (Playwright's keys bypass the browser's
  shortcuts), only that full screen is entered with the focus on the screen.
- **Paste** into the serial terminal is xterm.js's: `onData` gets the text (`\n` as `\r`, which
  the tty turns back; bracketed when the program asked for it), and `vm.send` queues what the 4 KiB
  RX ring can't take yet. Paste into a program that reads (a paste typed ahead of a shell's
  prompt goes to its line editor as commands). The clipboard for the screen is clipboard sharing's ("The toolbar", Clipboard: the paste chord,
  Copy the screen).
- **The tablet** maps a pointer to 0–32767 across the canvas's box as laid out
  (`getBoundingClientRect`), so it follows the CSS scaling, integer or not. Its buttons come from the event's
  `buttons` mask (a second button pressed while one is held is a `pointermove`, not a `pointerdown`): left, right,
  middle, and a mouse's **back and forward** as `BTN_SIDE` and `BTN_EXTRA`, whose browser navigation is cancelled on
  the screen (Chromium navigates on an uncancelled `mouseup`; `tests/page-pointers.test.ts` sees it navigate without).
  A cancelled pointer (`pointercancel`: a pen leaving) releases what it held. The **wheels**, vertical
  (`deltaY`) and horizontal (`deltaX`), are each a plain and a high-resolution axis (`REL_WHEEL` and
  `REL_WHEEL_HI_RES`, `REL_HWHEEL` and `REL_HWHEEL_HI_RES`; up and right positive): lines and pages (Firefox's) are a
  notch each, pixels count 120 high-resolution units a notch of 50 (`NOTCH_PX`), a notch per event at most, so a
  mouse's notch is one and a touchpad's stream of small steps doesn't scroll many times as far. The fractions carry
  over, and the plain axis gets its notch in the report where the high-resolution sum reaches 120 (Linux's rule for a
  device with both): a reader of the high-resolution axes (libinput) can scroll a touchpad's motion smoothly, a
  reader of the plain ones alone (X's evdev driver, kernels before 5.0) gets the notches as before. Turning back starts a wheel's sum over.
- **[Mouse lock](ui:statusbar:statusbar.kind.pointer)** (the toolbar's menu, `webpc.settings` `mouseLock` and `mouseLockMode`): a click on the screen takes
  the mouse (Pointer Lock) and isn't the guest's; every button reaches the guest then, the back and forward ones too.
  Esc (the browser's) or the menu lets it go, and so does a change of mode (the next click takes it in the new one);
  the machine stopping (powered off from the page or by the guest, suspended, crashed) lets it go too, and a click on
  the stopped screen doesn't take it again.
  Two modes (`web/input.ts` `LockMode`):
  - **Pointer** (the default): the motion moves the tablet, from where the pointer was, by the browser's
    `movementX/Y` (CSS pixels, accelerated as the host's pointer is) across the canvas's box: the same speed as
    unlocked, whatever the guest's mouse settings; the cursor is kept in the screen.
  - **Raw**: the motion goes to the machine's relative **mouse** (a virtio-input of its own: `MachineRecord.mouse`,
    `?mouse=1` for a transient machine), unbounded by the screen, for games that turn with the mouse; the lock asks
    for `unadjustedMovement` (the mouse's own counts, without the host's acceleration: the guest's mouse settings set
    the speed) and takes a plain lock where the platform refuses it. The buttons and the wheel move to the mouse with
    the lock (held ones are released first). A machine without a mouse has Raw disabled.

  The browser hides the pointer, CSS cursor and all, so the page draws the guest's cursor over the screen
  (`#screen-cursor`) where the guest puts it (virtio-gpu's cursor position, `cursor-at`), as the CSS cursor is drawn
  (its scale, Chromium's 128-device-pixel cap, the hotspot at the guest's pointer) and clipped to the screen as a
  cursor is (`#screen-cursor-clip`: at an edge it would otherwise make the page overflow). Nothing drifts: the tablet is
  absolute, so after the lock the guest's pointer goes to the host's at its first move (where it was when the lock was
  taken; pointer lock can't place the host's pointer). Raw does nothing on the firmware's screens (no driver there for
  the mouse, nor for the tablet).
- **Touch** (`MachineRecord.touch`, `?touch=1`): a machine with a touchscreen (virtio-input, `INPUT_PROP_DIRECT`, 10
  multitouch slots, 0–32767) gets the screen's touches as touches: a slot per finger (`ABS_MT_SLOT`,
  `ABS_MT_TRACKING_ID`, positions), the oldest finger down also as `ABS_X/Y` (and when it lifts, the next oldest, at once: Linux's own
  pointer emulation's rule, which virtio_input doesn't ask for), `BTN_TOUCH` from the first finger down to
  the last up; fingers past ten are dropped. Without one the first finger moves the tablet and presses its left button,
  and the others are dropped (they would move the pointer to them and lift the button). The
  screen has `touch-action: none`, so the page doesn't pan or zoom under them.
- **Leaving the page** while the machine runs (booting, running, rebooting) stops it like pulling the plug, so the
  page asks the browser to ask first (`beforeunload`; the browser words the question itself, the page's text isn't
  shown). **[Preferences](ui:machines:MachinesNav.preferences)** on the Machines page turns it off (`webpc.settings` `leaveWarning`, on unless set). Under
  automation (`navigator.webdriver`) it doesn't ask unless `?leavewarning=1`: the tests leave running machines.
- Keys are mapped by `KeyboardEvent.code`: a key's position on a PC keyboard (the US one's keys, ISO's
  `IntlBackslash`, ABNT2's `IntlRo`, JIS's `IntlYen` and its conversion keys), whatever the host's layout prints on it.
  The guest's keymap says what the key types (a US one unless it is told otherwise: "The keyboard layout"). A
  synthesized key without its modifier events (Playwright's `type()` of `>` sends Period without Shift) reaches the
  guest unshifted. Past a PC's keys, `NumpadEqual`, `NumpadComma`, F13–F24 and the media and volume keys are mapped
  too (the keyboard advertises every code to `KEY_MICMUTE`). The browser's repeats of a held key aren't sent: the
  keyboard has `EV_REP`, so the guest's kernel repeats it (as QEMU's does; forwarded as value 2, a console repeated
  the key twice as fast). The built-in USB keyboard is a boot keyboard (usages up to 101): the keys past it reach only virtio-input.

### The on-screen keyboard

[Show the on-screen keyboard](ui:toolbar:KeysMenu.keys.osk) (the Keys menu) puts a PC keyboard over the machine, of 104
keys, and ISO's, ABNT2's or JIS's extra keys when the machine's layout has them ("Layouts" below) (`Osk.svelte`, in `main`, so it stays in full screen; hidden with the Machines page): every key reaches the
guest, those the browser and the host keep included, and it is the keyboard of a device without one. Its bar moves
it, the ↔ grip in the bar resizes it (the keys scale with its width; a grip in a corner sat on the keypad's Enter);
where it is and how wide is remembered (`settings().osk`), kept in the window, no wider than the window's width or
height allow. The toolbar's menus open over it.

- **The compact layout** (`osk.ts` `pages`, 10 keys across by 5 rows, as a phone's keyboard): a window narrower than
  600 px (`COMPACT_BELOW`: the full keyboard's keys are ~25 px there) gets it on its own. Its keys are on four pages,
  chosen by tabs in the bar: [abc](ui:osk:OskBar.page.main) (digits, letters, `;`, Shift, Backspace, and a bottom row of
  Esc, Tab, Ctrl, Super, Alt, Space, Enter), [#+=](ui:osk:OskBar.page.symbols) (the other punctuation keys, JIS's
  input-method keys, Caps Lock, the
  right-hand modifiers, Menu, the arrows), [Fn](ui:osk:OskBar.page.fn) (F1–F12, Print Screen, Scroll Lock, Pause, the
  navigation block, the arrows) and [Num](ui:osk:OskBar.page.keypad) (the keypad). Every key of the full layout is on one
  page at least; Shift, Ctrl, Alt, Esc, Tab, Backspace and the arrows on several. The pages share `OskKeys`, so a
  modifier latched on one is used by a key on the next, and a pointer lets its key go wherever it lifts (a document
  listener), its key gone with the page another finger changed. The bar's button between the tabs and the grip
  ([Switch to the full keyboard](ui:osk:OskBar.toFull), [Switch to the compact keyboard](ui:osk:OskBar.toCompact)) forces the
  other layout; the forced one is remembered (`settings().osk.layout`) until the window's width crosses the threshold
  to where the automatic choice is the same (a phone turned to landscape and back is compact again). Each layout keeps
  its own width (`w`, `wc`); the bar is a size container, and the title gives way to the tabs below 420 px. A
  layout's extra keys join the symbols' page (its two rows of punctuation share the width).
- **The letters' page per layout** (`osk.ts` `letterRows`): US's letter block (digits, Q–P, A–L with `;`, Z–M) and,
  in each row, the keys of the full keyboard's same row whose unshifted character is a letter with a capital on the
  machine's layout, in the full keyboard's order: German's Ü after P and Ö, Ä after L, Turkish's Ö and Ç after M,
  Hungarian's Ü and Ó after 0 and Í before Z; ISO's Backslash (Italian's ù, Hungarian's ű) on the home row, ANSI's on
  Q's. They leave the symbols' page. A row past ten keys narrows them to share the 10u; the bottom one narrows Shift
  and Backspace to 1.25u first. A letter without a capital of its own (ß, º, µ) stays a symbol.
- **Layouts:** the legends are the machine's [Keyboard layout](ui:machines:KeyboardField.keyboard)'s (the one a start
  gives the guest, `keys.layout`; none set: US, the guests' default), from `web/app/keymaps.ts`: each layout's four
  levels by `KeyboardEvent.code` (unshifted, Shift, AltGr, AltGr with Shift), generated by `tools/osk-keymaps.ts` from
  xkeyboard-config with `xkbcomp` (`pc+<layout>(<variant>)`, as the guest's XKB compiles it) and keysymdef.h's
  characters; a dead key's is its spacing accent. A letter key shows its capital alone, another its shifted character
  over the unshifted, and the AltGr character small at the bottom right. ISO's key (IntlBackslash) narrows the left
  Shift, ABNT2's and JIS's IntlRo the right Shift, JIS's IntlYen the Backspace (labelled
  [⌫](ui:osk:Osk.key.BackspaceShort) there; JIS's Hankaku/Zenkaku, [半/全](ui:osk:Osk.key.HankakuZenkaku), types
  nothing on the serial console), and JIS's input-method keys sit beside a narrower Space (`IME_KEYS`:
  [無変換](ui:osk:Osk.key.NonConvert) left of it, [変換](ui:osk:Osk.key.Convert) and
  [カタカナ ひらがな](ui:osk:Osk.key.KanaMode) right, the right Super and Menu 1u; `NonConvert`, `Convert`, `KanaMode`:
  KEY_MUHENKAN, KEY_HENKAN, KEY_KATAKANAHIRAGANA to the guest, nothing to the serial console or the built-in USB
  keyboard, whose boot report stops at usage 101). The keys the guest's keyboard gets are positions, so its keymap makes the characters;
  what the serial console gets is the layout's character (`osk.ts` `eventOf`), the right Alt as AltGr on a key with a
  third level (Alt elsewhere, and on US). Caps Lock doesn't change it. A guest whose keymap isn't the setting's (the
  setting off, the guest's changed) shows legends that don't match.
- **Keys** go through `Input.key` (web/input.ts), the path the screen's own key events take: to the keyboard, or before
  the guest has a driver on it, to the built-in USB keyboard or the serial console (with the `key` the layout types and
  the keyboard's modifiers). **In the terminal's view** (or both views, the terminal last clicked: whichever has the
  focus) they go to the serial console as the terminal's own typing does (`term.input`, `terminalBytes`), and the
  terminal keeps the focus; showing the keyboard there doesn't move it to the screen. A key goes up where it went
  down. A key typed on the physical keyboard into the terminal ends the latches too.
- **Repeat:** the last key pressed, but a modifier, repeats while held (`OskKeys`: after 500 ms, then every 33 ms, a
  PC's typematic defaults), sent as the browser's repeats are (`repeat`): the serial console types each, the guest's
  keyboard and the built-in USB one drop them (the guest's kernel repeats a held key).
- **Pointers** (`OskKeys`, web/app/osk.ts): each pointer (a finger, the mouse, a pen) holds the key it went down on
  until it lifts or the browser cancels it (captured: sliding off the key doesn't let it go), so keys go down and up
  in the order the touches do, and fingers chord. Two pointers on one key: down with the first, up with the last.
- **Modifiers** (Shift, Ctrl, Alt, Super): one held with another key, or alone for 500 ms, is released when let go. One
  tapped alone is **latched**: down until the next other key is released (Ctrl, Alt, F1 types Ctrl+Alt+F1), or with
  Preferences' "[Keep on-screen keyboard modifiers held until clicked again](ui:machines:PreferencesPane.oskToggle)"
  (`settings().oskModifiers` `toggle`), until it's tapped again. A latched modifier tapped again is released at once.
  Held keys are drawn pressed, latched ones tinted (`data-state` `held`, `latched`).
  A press elsewhere (a click or a touch on the screen) while a finger holds a modifier uses it as a key would
  (Shift-click: released when the finger lifts). A key typed on the physical keyboard ends the latches as a key here
  does (`Input.onTyped`, `keys.typed`).
- **Holders:** `attachInput` keeps who holds each key (`KeySource`: the screen's key events, the keyboard, the Keys
  menu, Hold Esc). A key goes down with its first holder and up with its last, so the physical Shift pressed and let
  go doesn't release a Shift latched here, a menu's Ctrl+W doesn't release a latched Ctrl, and a second Hold Esc ends
  the first.
- **Focus:** showing the keyboard gives the screen the focus; the keyboard never takes it (its `pointerdown` and
  `mousedown` are cancelled), so the screen keeps the physical keyboard. When the page releases the guest's keys (the
  screen or the window loses the focus, or the guest's keyboard driver comes or goes, which moves the keys between
  the virtio keyboard and the built-in USB one or the serial console), `Input`'s `onRelease` tells the keyboard
  (`keys.released`), which lets go of what it held and latched. Its keys, the menu's and Hold Esc wake a suspended
  guest, as the screen's do.
- **Without a touchscreen** a finger landing on the screen with no other finger on it is the tablet's (the screen's
  own fingers are counted, not the page's: a finger on the keyboard doesn't make the screen's touch a second one).
- **LEDs:** Num Lock, Caps Lock and Scroll Lock carry a light, as the guest set it on the keyboard it reads now: the
  virtio keyboard's status events (`EV_LED`, on the keyboard's port) once its driver is up, the built-in USB
  keyboard's output report (`usb-leds`, docs/usb.md) before (`keys.leds`, derived from `keys.ledBits` and `keys.live`). A guest that sets none
  (no driver, a firmware without LEDs) leaves them dark.

`tests/osk.test.ts` tests the layouts for every keymap (the compact pages covering the full one's keys, the legends, AltGr) and `OskKeys` (with the repeat); `tests/page-osk.test.ts` the keyboard and the Keys menu on the page,
with the keyboard's, tablet's and serial console's ports kept on the page (clicks, a held key, latched modifiers, two
fingers by CDP touches, the focus, a move and a resize remembered, the toggle mode, the holders beside the physical
keyboard, a finger on the keyboard and one on the screen, the driver's change, the serial console before the driver,
the LEDs from virtio-input's status events and their switch with the driver, Ctrl+W, Esc, Hold Esc; the compact layout at a
phone's width: its tabs, a latch and a held key across pages, the forced layout remembered and dropped as the width crosses;
the terminal's view to the serial console, a held key's repeats there and none to the keyboard; German's legends, ISO's key
and AltGr's characters; German's compact letters' page; JIS's input-method keys' keycodes);
`tests/usb-keyboard.test.ts` the built-in keyboard's `usb-leds`. The wake isn't tested on the page (a suspended guest's status is the worker's).

### The keyboard layout

A machine's **[Keyboard layout](ui:machines:KeyboardField.keyboard)** setting (`MachineRecord.keyboard`, in its definition, not its shape; `?keyboard=<id>`
on the page) has the guest set a layout at every boot. Its values: an id in `web/app/keyboard.ts`'s `KEYBOARD_LAYOUTS`;
`browser` (**[This browser's, at every boot](ui:machines:KeyboardField.keyboard.follow)**: `FOLLOW_BROWSER`, a new machine's default, so the guest types what the
user's keys say), the layout `navigator.keyboard.getLayoutMap()` reports, looked up at every start (Chromium only: a
few keys' characters against each layout's, `detectLayout`; where the browser doesn't say, nothing is set and the
guest keeps its last); or none (**Don't set it**: the guest's own, and what a machine made before the default or a
definition without the field has). **[Match this browser](ui:machines:KeyboardField.keyboard.match)** picks a fixed layout from the same lookup, for the user to
save. It takes effect at the next boot, without a restart. A transient machine the user opened (`?disk=`, a
file opened on the page) follows the browser as a new machine does (`keyboardSetting`); the tests' `?machine=` guests
set none; `?keyboard=` overrides both (`?keyboard=none`: none). The on-screen keyboard shows the layout a start gives the guest ("The on-screen keyboard", "Layouts"); a
layout added here gets its keymap by `node tools/osk-keymaps.ts`. The network's settings (MTU, search domain; "Take the
connection's settings") are on for every transient machine, `?netconfig=0` off.

What the guest gets: three systemd credentials (256+: `systemd.extra-unit.*`, `systemd.unit-dropin.*`) as SMBIOS
type 11 strings (base64, `io.systemd.credential.binary:`), which PID 1 imports in a VM with nothing loaded first. The
page passes them in fw_cfg's `opt/webpc/oem-strings` and the core moves them into type 11 (`core/src/smbios.rs`,
ABI 49): their names are too long for fw_cfg's 56-byte file names. They add `webpc-keyboard.service`, wanted by
`systemd-user-sessions.service` and ordered before it and the display manager (so every login sees what it set), which
runs the third, a POSIX sh script:

- **Debian and Ubuntu** (`/etc/default/keyboard` there, or Debian 13's read-only localed, whose D-Bus policy refuses
  `localectl set-x11-keymap` even to root): `XKBMODEL`, `XKBLAYOUT`, `XKBVARIANT` in `/etc/default/keyboard`, other
  lines kept, which Xorg, localed (so GNOME and KDE) and console-setup read; `setupcon -k` where console-setup is.
  Debian's cloud image has neither console-setup nor kbd: its consoles stay US, `localectl status` shows the X11 layout.
- **Elsewhere** (Arch): `localectl set-x11-keymap --no-convert` (Xorg's `00-keyboard.conf`) and `localectl
  set-keymap --no-convert` with the layout's own console keymap (`vc` in the table: `/etc/vconsole.conf`, and localed
  reloads the console, so the first boot's tty1 has it). Not localed's conversion: it takes the first match in
  systemd's kbd-model-map, which for `de` is kbd's 7-bit `de` map (`ö` types `[`; `de-latin1` is right), and has no
  plain match for `ch`, `cz`, Dvorak, Colemak or US international. Without that keymap on the guest, the conversion.
- **Wayland compositors** that read libxkbcommon's defaults (sway and the other wlroots ones): `XKB_DEFAULT_LAYOUT`,
  `_MODEL` and `_VARIANT` in `/etc/environment`, rewritten only when they differ. pam_env gives them to every login
  (Debian checked: a serial login and root's user manager have them); GNOME and KDE take the X11 layout above.

All of it stays on the guest's disk: turning the setting off leaves the last layout set, as the setting's note says.
Guests without systemd 256 ignore the strings. `tests/keyboard.test.ts` runs the script under dash on files of its own
(and a `localectl` that records its calls); `tests/page-debian.test.ts` boots with `?keyboard=gb`. On the desktop
guest (`images/arch/desktop.sh`, 2026-10-21) by hand: `?keyboard=de` on a fresh disk types `z` and `ö` for `KeyY` and
`Semicolon` on tty1 (read from `/dev/vcsu1`; `/dev/vcs1` holds font glyphs, not characters), in foot on sway (whose
environment has `XKB_DEFAULT_*`) and in Firefox's address bar; the next boot with `?keyboard=pt` types `y` and `ç`
everywhere, and one without the setting keeps Portuguese (the unit isn't there).

### What the page sets in the guest

Two machine settings have the guest change something at boot: **[Keyboard layout](ui:machines:KeyboardField.keyboard)** (above) and the Network tab's
**[Take the connection's settings in the guest](ui:machines:NetworkTab.netConfig)** (on unless the user turns it off: `MachineRecord.netConfig`). Both are
units the page adds (`web/app/guest-unit.ts` `guestUnit`): `systemd.extra-unit.webpc-<what>.service`, a oneshot that
runs a POSIX sh script given as a credential of its own (`webpc.<what>.sh`, `ImportCredential=`), and a
`systemd.unit-dropin.*` that has the unit it serves want it (the generator reads no `[Install]`), all as SMBIOS type 11
strings (systemd 256+; the keyboard's paragraph above says how they get there). Nothing is installed: a boot without
the setting has no unit. Guests without systemd 256 ignore them. Shared folders' **[Mount shared folders in the guest](ui:machines:FoldersTab.sharesMount)**
gives a `.mount` and an `.automount` the same way ([shares.md](shares.md) §5). A ramdisk's **swap** box on the Machines page gives an `fstab.extra`
credential the same way, no unit ([machines.md](machines.md) §4.3 "As swap").

- **The network's settings** (`web/app/guest-net.ts`): `webpc-network.service`, wanted by and ordered before
  `systemd-networkd.service` (no default dependencies; after `local-fs.target` and `systemd-network-generator.service`,
  which writes the card's `.network` credential), gives every `.network` file in networkd's directories a drop-in,
  `/run/systemd/network/<file>.network.d/50-webpc.conf`, with `UseMTU=yes` and `UseDomains=yes` under `[DHCPv4]` and
  `UseDomains=yes` under `[DHCPv6]`. So the guest takes each lease's MTU (a tailnet's 1280) and search domain
  (MagicDNS's) whichever file configures the adapter: the card's own `card.network` does only where no file of the
  guest's sorts before it, and Arch's `20-en*.network` and netplan's `10-netplan-all-en.network` (Debian's cloud
  image, Ubuntu) do. **It writes only to
  /run**: the guest's disk is untouched, and the next boot with the setting off has none of it. A drop-in of the
  guest's that sorts after `50-webpc.conf` wins. NetworkManager asks for the MTU by default (`interface_mtu` is in
  its DHCP request list, from its source) and applies it while the connection's MTU is automatic, as Debian's
  dhclient does: nothing is set for them. Without any of it the gateway's MSS clamp still keeps TCP working ("Network").
  `tests/guest-net.test.ts` runs the script under dash on directories of its own; `tests/page-debian.test.ts` checks
  that it ran and that networkd reads its drop-in for netplan's file. On the desktop guest (2026-10-23, by hand) networkd
  reads it for Arch's `/etc/systemd/network/20-en.network`; there the card's fw_cfg credential never arrives (no
  `card.network` in /run), while the SMBIOS ones do.
- **Clipboard sharing's agent** (`web/app/guest-agent.ts`, a machine with `clipboard`): `webpc-agent.service`, a
  long-running service (`guestUnit`'s `service` lines in place of `Type=oneshot`) wanted by `multi-user.target`,
  whose script copies the agent's binary out of fw_cfg (`opt/webpc/agent`, not a credential: too big for SMBIOS) into
  `/run/webpc` and runs it (docs/devices.md "The guest's agent"). Its description is
  [Clipboard sharing with the emulator](ui:guest:guest-words.agent). The setting is the Settings tab's
  **[Share the clipboard with the guest](ui:machines:DeviceSwitches.clipboard)** (off by default; a change of shape: the agent's device); ticking it is the click that asks
  for the browser's read permission ("The toolbar", Clipboard).
- **The keyboard layout** writes to the guest's disk instead (`/etc/default/keyboard`, localed's files,
  `/etc/environment`): Xorg's `xorg.conf.d`, localed, console-setup and pam_env read `/etc` only, so nothing in `/run`
  would reach them, and turning it off leaves the last layout set.

## Latency

Key to glyph, median of 40–100 keys, Chromium 153 headless on the dev VM, Debian on 4 vCPUs and
Buildroot on 2, the Both view (bench/boot/REPORT.md "M8 loop 3"):

| | Loop 2 | Loop 3 |
|---|---|---|
| Serial terminal, Debian (bash on ttyAMA0) | 30.4 ms | 10.5–11.4 ms |
| Serial terminal, Buildroot (ash) | 30.0 ms | 6.0–6.4 ms |
| Screen, Debian (bash on tty1, fbcon) | ~16 ms | ~14–17 ms |

On the terminal the rest is the guest (key to echo in the TX ring: ~3 ms on Buildroot, ~7 ms on
Debian) and the page (~2 ms to xterm.js's DOM). On the screen it's the guest's fbcon drawing plus
up to a frame until the next draw.

With Debian's screen on virtio-gpu (`node bench/gpu/page.ts`, 2026-10-02, another instrument for the screen: the page
reads the canvas back, so its numbers compare with each other only; bench/gpu/REPORT.md "G1 exit"): the terminal is
where it was (10.8 ms; 11.6 with `?display=simple`), the screen takes 52.8 ms against the simple framebuffer's 39.2.
The device isn't the difference (the guest's flush arrives 12 ms after the key and is drawn within 1 ms); what
happens to a canvas drawn in the device worker after that is the backlog's item. The first pixel is on the screen
7.5 s after the page's load (EDK2's graphics output) instead of 18.7 s (the kernel's console), and `running` comes
at the same ~52 s.

## The serial terminal

xterm.js 6 (`@xterm/xterm`, MIT; the only runtime dependency), 80×25: the PL011 has no size
negotiation, so a Linux guest assumes 80×24 unless `stty` says otherwise, and the firmware's
console is 80×25 (our EDK2 offers no other text mode: `images/build.sh edk2` patches the
terminal driver's mode table, because GRUB takes the largest mode and asks the terminal to resize
itself with `CSI 8;r;c t`, which xterm.js doesn't do; docs/backlog.md "EDK2's terminal modes"). `onData` sends what a
terminal would (`\r` for Enter, escape sequences) to the `serial` port. No addons. The dev server
**The firmware and GRUB through it** (`tests/page-disk.test.ts`, which drives them end to
end): arrows, Enter, Esc, F2, Ctrl-N/P/E/X, Home/End and typing all arrive. Two things about
EDK2's terminal driver: a lone Esc is delivered ~2 s late (it waits to tell it from the start of
a sequence), and PageUp/PageDown (`CSI 6~`) aren't decoded (GRUB's editor shows them as text), so
use Ctrl-N/Ctrl-P there. A long run of arrow keys sent fast can lose bytes (the PL011's FIFO
against a guest that polls): a person's typing is slower. The serial terminal, not the screen, is the way into the firmware's
setup (GRUB's "UEFI Firmware Settings" entry resets into it; the boot device menu's "EFI Firmware
Setup") and GRUB's editor and command line.

xterm.js and its stylesheet are imported as the package (`main.ts`: `@xterm/xterm`, `@xterm/xterm/css/xterm.css`).

## Views, settings and the disk

Screen (the default, decision 2; edge to edge between the toolbar and the status bar, no padding,
black around the canvas), Serial terminal, or Both (side by side; stacked below 1100 px).
The view chosen last is remembered per browser (`localStorage` `webpc.settings`, JSON; read and
written in try/catch, so a browser that refuses storage just doesn't remember); `?view=` overrides
it without being saved. A stored machine's size is its Settings tab (Save and restart while it runs; its **[JIT cache](ui:machines:SettingsTab.jit)**, beside the RAM, is
the code cache's budget: Default (320 MiB) or 64 to 512 MiB, `MachineRecord.jitMiB`, in its definition and carried by
its shape outside the hash, so changing it restarts the machine but orphans no snapshot); a transient
machine's (a test's `?machine=`) is the toolbar's **Machine** menu, which sets the vCPU count (1, 2, 3, 4, 6, 8) and the RAM
(512 MiB to 16 GiB; past 3071 MiB the note under it says how much becomes NUMA nodes) and
applies them with a confirmed restart; both are remembered per browser too (`ncpus`, `ramMiB`),
with `?ncpus=` and `?ram=` over them (and `?split=2560,1024`, a split set by hand, MiB, memory 0 first, its sum the RAM). Defaults: `min(4, cores − 2)` vCPUs and the machine's RAM
(1 GiB). The page's memory check (`hostMemoryGiB`) warns in the confirmation when the device
reports less than the choice needs (Chromium reports at most 8 GB, so past that it says the device may well have more). A suspended machine resumes with its own size.

Restart and Power off ask for a confirmation while the machine is booting or running (they're a power cut); after
a power off the button reads Start. One restart or disk reset at a time (`exclusively` in
main.ts): Restart, Power off and Reset disk are disabled from the click until the new machine's worker is
started, so a second click can't start a machine beside the one being started (the first would
keep the overlay, and the page would lose track of it). The disk overlay persists across reloads and restarts; OPFS
belongs to the browser profile, so Playwright's temporary profiles start empty and tests don't see
each other's disks.

**Reset disk** (M8 decision 4; a transient machine's, on the Machines page's Disks tab: a stored machine has New empty
instead, which keeps the old overlay) asks for a confirmation that
says what goes (the overlay's size, from `overlayBytes`), stops the machine (its device worker
releases the overlay's sync access handles), deletes the overlay (`removeOverlay` in
web/overlay.ts: under the overlay's Web Lock, `removeEntry(name, {recursive: true})` on the OPFS
root) and starts a new
machine, which boots from the image as published. If the removal fails (another tab holds the
files), the page says so and offers the reset again.

## Debian through UEFI

`?machine=debian` boots Debian's published image unmodified (M8 phase B loop 3; [firmware.md](firmware.md)):
the machine's `kernel` is `target/images/edk2/QEMU_EFI.fd` (with `LICENSES.txt` beside it, served
with it), `firmware: true`, no initrd and no command line; `web/app/worker.ts` passes
`BootOptions.firmware` (the flash bank and the fw_cfg files). What that changes for a user:
- **The boot takes ~20 s longer** (bench/boot/REPORT.md "M8 phase B loop 3": 53 s to the login
  prompt against 33 s): EDK2 to the kernel ~9 s, GRUB's 5 s menu timeout (any key stops the
  countdown), and ~5 s in userspace, because the page's old command line is gone: GRUB owns it
  (`apparmor=0`, the masked units and `console=tty0` no longer apply; AppArmor loads its profiles,
  timesyncd, resolved and networkd start). With the screen on a virtio-gpu it shows the firmware's logo and output and GRUB, then goes dark until `virtio_gpu`
  loads (udev, after the root mounts) and fbcon takes it; the serial terminal has the firmware's and the kernel's output.
- **A first boot asks its questions** on the serial terminal (above), as on a regular machine.
  The page offers no way yet to skip them; a disk that has been through its first boot comes
  with loops 4–6 (a disk in, a changes file or whole disk out).
- **The variable store** (the firmware's boot entries and settings, the flash bank, 1 MiB) is kept
  per disk in the overlay's OPFS directory (`webpc-debian/flash`, `loadFlash` and `saveFlash` in
  web/overlay.ts): saved when it changes (checked every 5 s), at power-off, reset and Restart; it
  goes with Reset disk. It is what lets GRUB's "UEFI Firmware Settings" reach EDK2's setup.
- **The network card's settings** (`machine.network.credentials`) go over fw_cfg as the
  credential `opt/io.systemd.credentials/network.network.card`, whenever the machine has a card
  (always, on this machine) and `?netconfig=0` doesn't turn them off; the unmasked networkd and resolved do the rest.
  The image's own netplan file, `10-netplan-all-en.network`, sorts first and configures the adapter: the network's unit
  gives it the lease's MTU and search domain ("What the page sets in the guest").

## Your own disk

A `firmware` machine (the page's own `uefi`, which has nothing else to boot, and `debian`) boots a disk of the user's own (M8 phase B loop 4): **[Open disk…](ui:machine:main.openDisk)** (the
message's button while no disk is open, and the Machines page's From a disk image…: the browser's file picker, whose handle the machine keeps, or a file input where there is none), a file dropped on the page, or `?disk=<url>` (served with HTTP
range support, like the machine's own, or a chunked image's `manifest.json`, which any static host can serve:
`node tools/chunk-image.ts <image> <dir> [MiB] [--name <name>]`, docs/devices.md "A chunked image"; `node tools/disk-trace.ts` adds a
boot's reads, which the page then fetches ahead; the manifest's `name` is what the page calls the machine and the disk,
not the manifest's file name: `?disk=…/desktop/prefetch.json` is "Desktop Demo"). The machine restarts on it (confirmed if it runs); raw or
qcow2 is told by the file's magic (an ISO is raw: EDK2 boots its El Torito or hybrid partition table's EFI entry; the user
booted an arch.bens.haus installer ISO, 2026-10-17) (a qcow2 with a backing file is a changes file: it is loaded, below, not booted).
- The `File` goes to the machine worker in `start.disk`, then, structured-cloned inside the
  device spec (`{type: 'blk', file}`), to the device worker, which reads slices with
  `FileReaderSync` (web/devices.ts `blobSource`); its capacity is the qcow2 header's virtual size or
  the file's size (web/vm.ts).
- **Its changes are its own:** the overlay is `webpc-disk-<hash>` (`diskOverlay`, machine.ts: a hash
  of the file's name, size and modification time, or of the URL's path), with the variable store
  (`flash`) beside it, and the overlay's `base` file records the same identity
  (`diskIdentity`, devices.ts), so a mismatch is `disk-mismatch`. Choosing the same file again,
  later or in another tab, finds its changes. The page doesn't remember the file itself (a `File`
  can't be kept; a `FileSystemFileHandle` in IndexedDB could, with a permission prompt each
  session: backlog). **Reset disk** resets the chosen disk's overlay.
- The disk is identified by name, size and modification time, not by content (a hash of a
  multi-GB file would block the boot): two different files with all three equal share an overlay.
- Saving the disk (loop 5): a disk's **Export** menu on the Machines page's Disks tab: *Changes
  only*, a qcow2 holding the blocks the machine wrote with the image as its backing file;
  *Whole disk* as qcow2 (zero clusters left out) or raw; the qcow2s are compressed unless the
  menu's [Compress the qcow2](ui:disks:ExportMenu.compress) is unticked (remembered in the page's settings). The file goes where the user picks
  (`showSaveFilePicker`, called first: it needs the click's activation; a worker streams into the
  handle's writable) or, without a picker, is downloaded (the worker posts 1 MiB chunks, the page
  collects a Blob). **Never over the running disk:** a save dialog empties the file it hands over
  (Chromium creates or truncates it when the user confirms, before the page writes anything), so
  the suggested name is never a chosen disk's own (`<disk>-saved.qcow2` then), and right after the
  dialog the page reads a byte of the chosen disk's `File`: if that fails, the dialog was given the
  disk itself, and the page says so and writes nothing (a user lost a disk that way, 2026-10-17).
  **The machine stops while it's written** (confirmed; the overlay's OPFS handles
  and Web Lock belong to the writer, `web/app/export-worker.ts`, which also does the base image's
  synchronous reads): like pulling the plug, so the menu says to `poweroff` first; a machine that
  was running starts again after. The page: `web/app/export.ts`; the format:
  `web/qcow2-write.ts` (4 KiB clusters = the overlay's blocks; data first, then the L2 tables, L1,
  refcount blocks and table, and the header written last with `sink(bytes, 0)`; qcow2 v3, 16-bit
  refcounts). **Compressed clusters** (`compress`): each 4 KiB cluster goes through
  `CompressionStream('deflate-raw')` and, when that shrinks it, is stored compressed, packed end to
  end with the others (the L2 entry has the byte offset and the sector count; a host cluster's
  refcount is the number of compressed clusters that touch it); one that doesn't shrink is stored
  as it is at the next cluster boundary. The data leaves in 1 MiB pieces. QEMU inflates with a
  4 KiB window whatever the cluster size and `CompressionStream` has no window setting, so
  compression is tied to 4 KiB clusters (a bigger cluster could reach further back than QEMU's
  window; zstd isn't in `CompressionStream`). The clusters are compressed
  **on other threads**: `writeQcow2` hands batches of 256 clusters to a `Packer` and stores them in
  the order they came, and the disk-out worker's is a pool of up to four workers
  (`web/app/deflate-pool.ts`, `deflate-worker.ts`; the machine has stopped, its cores are free); the
  file is byte for byte the one compressing in place writes (`compress: true`, the tests' and Node's).
  Measured in Chromium 153 on the dev VM, the untouched 3 GiB Debian disk (the page's: a compressed
  qcow2 over HTTP, 992 MiB of data) to a sink that drops the bytes: 5.9 s not compressed (995 MiB),
  7.9 s compressed by four workers (428 MiB; 9.2 s by two, 15.8 s by one, 20.8 s in place); written
  to a file through `FileSystemWritableFileStream` (OPFS), not compressed, 8.7 s. What it was
  before, and why: 22.9 s not compressed and 38 s compressed, of which **reading the disk was
  21.7 s** (one synchronous HTTP request and one inflate per 64 KiB cluster: `openDisk` now reads a
  request's clusters in a few merged host reads, [devices.md](devices.md) "blk": 5.6 s), and deflate
  on one thread the rest (49 MiB/s of data, close to native zlib's 91 at 4 KiB clusters: the cost is
  deflate, not the stream per cluster). Compressing 64 or 512 clusters at once *on one thread* was
  slower than one at a time (11.4 s and 12.3 s against 8.7 s for the first 512 MiB). zstd
  (`compression_type=zstd`, QEMU 5.1 on) is not written: it needs a compressor compiled to wasm (a
  dependency), and with deflate on four threads the export is within a third of not compressing. What the guest's filesystem has freed
  is still data to the export until the guest trims it (`fstrim -av`: the disk takes DISCARD,
  [devices.md](devices.md) "blk"; trimmed blocks are zero clusters in a changes file and left out of a whole disk). A changes file's header names the base by its file name (the backing file; the user
  keeps it beside the changes) and carries the base file's **hash** in an extension of ours
  (type `WPC2`, ASCII hex: QEMU ignores unknown extensions; qcow2 itself has no checksum of a backing
  file), `hashSource` in `web/changes.ts`: the SHA-256 of the SHA-256 digests, in order, of the
  file's 4 MiB slices, each from `crypto.subtle.digest`, four at once (Load changes checks it).
  Measured in Chromium 153 on the dev VM over a 2 GiB file: ~640 MiB/s, which is the synchronous
  file reads (slices of 4, 8 and 16 MiB hash at the same speed); `crypto.subtle` alone does
  ~2.5 GiB/s whatever the call's size. What lost: one SHA-256 of the whole file, which
  `crypto.subtle` can't do incrementally and a SHA-256 in JS did at 46 MiB/s in Chromium (233 MiB/s
  in Node: the number that hid it), minutes for a disk of GBs at every save and load; a hash of
  sampled blocks (0.14 s) misses a base that differs elsewhere. `WPC1` was that whole-file SHA-256:
  a file with only it is refused like any qcow2 that isn't ours. The whole
  disk is scanned through the overlay over the base (the cost is reading the base: a 3 GiB Debian
  disk is the long case). Names: `<disk>-changes.qcow2`, `<disk>.qcow2`, `<disk>.img`.
- **Loading changes** (loop 6): a disk's [Import changes…](ui:disks:Disks.importChanges) on the Disks tab (or a changes file chosen with Open
  disk or dropped: the first 64 KiB's header, `changesHeader` in web/qcow2.ts, tells it from a
  disk: a backing file) puts a changes file onto **the disk on the page** (the machine's own or the
  chosen one). `loadChanges` (web/changes.ts, in `web/app/import-worker.ts`, page side
  `web/app/import.ts`; the machine stops, as for the export): `readChanges` (web/qcow2.ts) parses
  the file (clusters of 4 KiB or more, zero clusters as zeros, compressed ones inflated), its virtual size
  and **hash** (the `WPC2` extension) are checked against the base's (`hashSource`, under a second
  for Debian's 400 MB), then the overlay and the variable store beside it are **deleted** (the
  changes are the whole of what the disk has written; EDK2 rebuilds its variables, Debian boots
  by the fallback path) and the blocks are written into a fresh overlay. Refused before anything
  is touched, with what the user can act on: not a changes file; a qcow2 over a backing file that
  isn't ours (no checksum to check); another size; another base (names the file it was made over and both
  hashes' first digits: open that disk first). The file name isn't compared (the base can be
  renamed), the bytes are. The confirm says what is replaced; afterwards the machine starts again.
  The fresh-profile round trip works: the page's Debian plus the changes file saved from a disk
  chosen under another name boots with the file written.
- Tests: `tests/changes.test.ts` (the import in memory: the saved disk comes back, the old overlay
  is replaced; refusals leave it untouched; a compressed changes file; changes files from qemu-img with 64 KiB clusters, a
  zero cluster, compressed clusters), in `tests/page-save.test.ts` (a file loads back, a non-changes file is refused) and
  `tests/page-disk.test.ts` (the fresh-profile round trip on Debian), and `tests/qcow2-write.test.ts` (the base's hash against node:crypto; the writers' output against
  `qemu-img check`/`compare`/`info`, small and over several L2 tables and refcount blocks, compressed and not, and compressed clusters among ones that don't shrink; planted:
  a block left out of the changes fails it), `tests/page-save.test.ts` (Buildroot: raw, qcow2 compressed and not, and
  changes from a running machine, which restarts), `tests/page-disk.test.ts` (`scripts/ci-debian.sh`; three Debian boots): a symlink named
  `mydisk.qcow2` to Debian's image through the picker, a file written, its overlay and flash in
  OPFS, `poweroff`, the changes saved by download and by a picker's handle (an OPFS file: the same
  bytes; `qemu-img check`, its backing file, the base's hash in the header, data clusters),
  then the same file chosen again after a reload has the file.

## Network

A machine has up to four **network adapters** (machines with a `network` entry in machine.ts; a stored machine's
are on its Network tab, above), and each adapter has a **connection** attached, or none (the cable out). A
connection is the browser's, not the machine's (docs/network-adapters.md): a tailnet (a Tailscale network,
docs/plans/networking.md; the backend is web/tailscale.ts, the client in its own worker), tailcat (below), **this
computer** (the local helper, below) or a **peer-to-peer room** (below), with its state (a tailnet's node, tailcat's served address, the helper's link, a room's link and key), kept in IndexedDB `webpc` `connections` (web/app/connections.ts)
unless it is **ephemeral**: then it lives in the page's memory and is gone when the page closes, and its adapter
comes back detached, saying so. Any machine can use a kept connection; one running machine has it at a time (its Web
Lock, `webpc-net:<id>`): another tab asking for it is told which machine has it and, after [Use it here](ui:network:main.useHere), takes it
(the other disconnects and says it was taken). Two connections to one tailnet are two nodes.

The toolbar's **Network** menu (`Network.svelte`) has a section per adapter of the page's machine (`NetAdapter.svelte`, headed "Adapter n" when there are
several; adapter 1's elements keep their ids, adapter n's end in `-<n-1>`): the status, the connection's name,
[Log in…](ui:network:NetAdapter.login), [Internet through](ui:network:NetAdapter.exitNode) (a tailnet's exit nodes), **Reach the subnets peers route** (when a tailnet's
peers route subnets), [This machine's tailcat address](ui:network:NetAdapter.served) (when it lets clients
in), [This machine's name in the room](ui:network:NetAdapter.room.name) (a room's, with Copy and [Copy room link](ui:network:NetAdapter.room.copyLink)), **[Connect](ui:network:NetAdapter.connect)** (the attached connection, when it isn't running), **[Retry](ui:network:NetAdapter.retry)** (a connection that failed: disconnect and
connect again), **[Disconnect](ui:network:NetAdapter.disconnect)**, [Log out](ui:network:NetAdapter.logout), and [Connect…](ui:network:NetAdapter.setup) or
[Change connection…](ui:network:NetAdapter.change), which opens the **Network wizard** (`NetWizard.svelte`, the shell: the session, the steps' navigation, Keep, the error and
the submit; a component per step with its own form, `NetPickStep`, `NetKindStep`, `NetTailnetStep`, `NetTailcatStep`,
`NetLocalStep`, `NetRoomPickStep`, `NetRoomStep` for a room's create, join and edit; `net-wizard.ts` the steps' API): first the browser's connections,
the most recently used free one chosen and those in use marked with their machine, after [New connection…](ui:network:NetPickStep.pick.new)
(without connections it starts at the next step); then the kind, [A tailnet](ui:network:NetKindStep.kind.pickTailnet), **tailcat**, [Your computer (webpc-net)](ui:network:NetKindStep.kind.pickLocal) or [A peer-to-peer room](ui:network:NetKindStep.kind.pickRoom), then that kind's
settings and [Keep this connection in this browser](ui:network:NetWizard.keep) (on; off makes it ephemeral), with Back, Cancel (or Esc) and
Connect. Form errors show in the wizard; Connect closes it (stopping the adapter's running client first) and opens
the menu, which then says how the connection goes. The same wizard attaches a connection to a machine that isn't on
the page (its Network tab: it connects at once if that machine runs in another tab, otherwise when it starts), makes one on its own and edits one (the Machines
page's **[Connections](ui:machines:ConnectionsPane.connections.heading)**: rename, Edit, New address, Log out for any node kept here, Delete, which logs a kept node out and names the machines that lose it). The live
side is `web/app/net-live.ts` (`PageNetwork`): a `Network` (web/app/network.ts) per adapter, the clients, the locks
and the guest's default way out (below).

- [Your computer](ui:network:connections.thisComputer) (the local helper, webpc-net: [local-helper.md](local-helper.md)): a
  program the user runs prints a pairing link, `https://vm.tny.im/#net=ws://127.0.0.1:<port>/<token>` (and one for each `--origin`). Opening it
  takes the fragment out of the address at once (it holds the token) and opens the wizard on [Your computer](ui:network:connections.thisComputer), the
  link filled in, attaching to the page's machine's first adapter (or making the connection, without one); pasting
  the link (or its `ws://` part) into that step does the same. A new connection's step is numbered steps that end at
  the link's field: run webpc-net, with the install lines for this browser's platform under it (`web/local-release.ts`:
  client hints, a choice of the six; the release's version and SHA-256s, v0.2.0's now); then paste the link; a short note after (the link is a secret, allow local network access). Editing shows the
  field alone. Connecting starts the client in a worker of its own (web/local-net-worker.ts),
  which puts the card on a frame port, the page's gateway bypassed (web/gateway.ts `FramePath`: the link flaps, so
  the guest asks the helper for a lease at once), and moves its frames to the helper's WebSocket, those before a
  timer's turn in one message. The helper's DHCP gives the lease, routes and resolvers, so the adapter is the guest's
  default way out first (`primaryOf`); two such adapters both give a default route, and the menu says so. The
  menu's line is "Connected through this computer (<address>)", the address read from the helper's DHCP
  acknowledgment. Errors are the helper's close codes as sentences (another version, an origin it doesn't accept, a
  wrong token), or, for a socket that never opened, the helper not running, or this site refused loopback
  (`permissions.query({name: 'loopback-network'})`: denied), with where the setting is. Disconnect leaves the card on
  frames to nothing, so connecting again to the same helper doesn't flap the link; another kind brings the gateway
  back (with a flap).
- **The card is always there** (`machine.network`): virtio-net on the Ethernet gateway from the
  boot, so connecting later never restarts the machine. The card costs no boot time (Debian to
  login, alternating runs, this container: 81.3 s median without it, 79.7 s with it, 3 runs each,
  noise), and the client isn't loaded until Connect. While the machine's [Take the connection's settings in the
  guest](ui:machines:NetworkTab.netConfig) is on (`?netconfig=0` turns it off on a transient one), a systemd credential
  (`network.network.card`, over fw_cfg since phase B loop 3; on the command line before) gives
  networkd a `.network` file (systemd-network-generator writes it as `/run/systemd/network/card.network`), and a unit
  has every `.network` file take the lease's MTU and search domain ("What the page sets in the guest", below) (Debian's own units are all enabled under UEFI), so the guest asks the gateway for DHCP by itself; the gateway offers nothing
  until a client has an address (the tailnet address, MagicDNS through systemd-resolved). Not
  `ip=dhcp`: Debian's initramfs reads it too and waits for a lease before booting (found by the
  page test: the boot sat at the root mount for minutes). **A lease that arrives after the boot is
  taken in ~20 s** by networkd's DHCP retries (`tests/net-guest.test.ts`, measured 19 to 27 s after the
  lease); nothing on the page speeds it up (a link flap would, but the device's link is always
  up). **IPv6 doesn't wait:** the gateway advertises itself the moment the lease has an IPv6 address,
  and the guest has its DHCPv6 address ~2 s later. The guest is dual-stack: the tailnet's `fd7a:` address
  as a /128, the default route from the advertisement. MagicDNS answers AAAA for peers only when the
  control server sends the `magicdns-aaaa` node attribute (headscale doesn't by default; Tailscale's
  admin console has the setting): reach peers' IPv6 addresses by address, or turn it on. The machine worker gets `nets`,
  each adapter's MAC and the gateway's end of its IP port, and adds a `{type: 'net', mac, gateway, adapter: {ip}}` per
  adapter (docs/devices.md "net"); the page keeps the other ends (web/app/network.ts) for as long as no client holds them.
- **The default way out** (docs/network-adapters.md §4): the first adapter that is connected and reaches the
  internet (a tailnet with an exit node in use, tailcat through a server), else the first connected
  (`primaryOf`). Its lease has the default route; the others' have only their network's routes (DHCP option 121, a
  router advertisement with lifetime 0 and Route Information options). A machine with several adapters has its
  lease renewed every 10 s, so IPv4's default follows the primary within that (8–9 s measured, 10 at most; 49 s with the two-minute lease before); IPv6's moves with
  the advertisement, at once.
- [A tailnet](ui:network:NetKindStep.kind.pickTailnet) takes a control server (empty: Tailscale's; a Headscale's `https://` URL, or
  `http://` for this computer), a hostname (default `webpc`) and an optional auth key (a password field with a [Show the auth key](ui:network:NetTailnetStep.authKey.show) checkbox).
- **Login:** without an auth key the client asks the control server for a login and the menu opens
  with a [Log in…](ui:network:NetAdapter.login) link (a new tab; only `http(s)` URLs are ever offered); the client comes up
  when the login completes. An admin-approval wait is shown as such. With an auth key (asked for only when the
  wizard connects the page's machine) there's no login; the key is never saved. A kept connection's node is kept
  either way; an ephemeral connection's node is an ephemeral node (the control server drops it once it's been away).
- **The client** is our tailnet client (`net/ts`, `web/tailnet-worker.ts`; docs/tailnet.md),
  the page's since 2026-10-16 (until then Tailscale's Go client built to wasm). It keeps the node in
  the Go client's store format, so a node kept by the Go client is still the same node.
- **The node is kept:** a kept connection's node (its keys, a secret) lives in this origin's IndexedDB
  (`webpc-tailscale`, a profile per connection, its id: `stateKey`; the node kept before connections stays under its
  control server's URL; in the Go client's own format: `web/tailscale-state.ts`), so a reload is the same node with the same
  address and no new login: **a connection connects at start** (`connectAtStart`, the Network tab's Connect at start)
  until Disconnect.
- **Disconnect** withdraws the lease and stops the client (the guest keeps its address until the
  lease runs out; the adapter and its connection stay); [Log out](ui:network:NetAdapter.logout) removes the node from the tailnet and deletes its
  keys. A machine restart (Restart, a guest
  reboot, Reset disk) hands the new machine's port to the running client (`attach`): it stays
  connected. A machine that stops with no start to follow (powered off, suspended, crashed) stops its clients and lets
  their connections go; they connect again at its next start ([network-adapters.md](network-adapters.md) §1).
- **tailcat** (docs/tailnet.md "tailcat") has two choices, either or both:
  - [Go online through a computer](ui:network:NetTailcatStep.tailcat.exit) (the default): numbered steps that end at
    the **tailcat address** (a password field; a secret, kept only in a kept connection): install tailcat on a computer
    of the user's, run `tailcat serve exit-node` there, paste the address it prints; then a short note on what the
    machine reaches and keeping the address secret. The Rust tailnet client (web/tailcat.ts, web/tailcat-worker.ts,
    net/ts) connects through the address's DERP relay; the status goes Loading the client,
    Connecting to the relay, Waiting for the tailcat server, Opening the tunnel, then **Connected
    through the tailcat server (192.0.0.2)**. The guest's lease: IPv4 `192.0.0.2` (translated to
    the tunnel's IPv6 by the client, NAT64 to the exit node), IPv6 the tunnel's own
    `fd7a:115c:a1e0:…` address, MTU 1280, resolvers 1.1.1.1 and 2606:4700:4700::1111 (reached
    through the exit node). What the guest reaches is TCP and UDP to wherever that computer
    reaches, its LAN included; no ping beyond it, no exit-node choice, no Log out. Connected, the menu shows
    [This machine's key](ui:network:NetAdapter.key) (`nodekey:…`, with Copy) and the command that lets only it use that
    computer (`tailcat serve --allow=<key> exit-node`): the connection's identity is its node, going online alone too,
    so a kept connection's key is the same at every connect (an ephemeral one's, until the page closes).
  - [Let tailcat clients in to this machine](ui:network:NetTailcatStep.tailcat.serve): the machine is a tailcat server. The menu
    shows **its own tailcat address** (a password field with Show and Copy) and how to use it:
    on another computer, `tailcat ssh <address>` logs in to the guest's sshd (tailcat runs `ssh`
    with `tailcat <address> 22` as its ProxyCommand) and `tailcat <address> <port>` reaches any
    port the guest listens on; `tailcat ping <address>` gets its pong over the relay. Clients reach the guest at its tunnel
    IPv6 address, untranslated, from their own (the client drops anything else); there's no filter beyond the guest's
    own.
    The address is **kept** with a kept connection: the node key and the address's pre-shared key live in this
    origin's IndexedDB (`webpc-tailcat`, `identity`, under the connection's `identityKey`, its id; `served` for the
    one kept before connections), so it's the same after a reload, and the machine **reconnects by itself** on load
    (`connectAtStart`); an ephemeral connection's is in the page's memory. **[Advanced](ui:network:NetTailcatStep.advanced)**: the **relay for clients** when not going online through a
    computer (that computer's relay serves otherwise): empty for tailcat's public relays, the
    region with the fastest `/derp/probe` (`nearestRegion`, as tailcat's own server picks; the
    map's first if none answers), or one's own derper's `host[:port]`; [Let in only these clients](ui:network:NetTailcatStep.allow):
    the clients' keys as `tailcat genkey --client` prints them, one per line (tailcat's own `--allow`; empty: anyone
    with the address; `parseAllow`, kept as the connection's `tailcat.allow`); and, editing a connection, [New address](ui:network:NetTailcatStep.newAddress), which
    forgets the kept identity (after a confirmation), so the old address stops working (the adapter that runs it
    connects again at once). Serving alone, the guest gets the same lease without resolvers: it reaches only
    the clients. The status says [Letting tailcat clients in](ui:network:network.servingOnly) (or adds it to the exit node's).
- [A peer-to-peer room](ui:network:NetKindStep.kind.pickRoom) (docs/tailnet.md "Rooms", plans/networking-p2p.md): machines in
  other browsers that join the same room reach each other by name, browser to browser over WebRTC when they can and
  through the room's DERP relays otherwise. The step asks [Create a room](ui:network:NetRoomPickStep.room.create) or [Join a
  room](ui:network:NetRoomPickStep.room.join). Create takes the [Room name](ui:network:NetRoomStep.room.name) and [Private
  room](ui:network:NetRoomStep.room.private) (on: the ID is the name, a hyphen and 128 random bits in base32, web/room.ts
  `privateRoomId`, the only form the page takes as private; off: the name is the ID, and anyone who knows it can join);
  its [Advanced](ui:network:NetTailcatStep.advanced) has the room's [Nostr relays](ui:network:NetRoomStep.room.nostr) (`ws://` or
  `wss://`, one per line; empty: the module's defaults) and [DERP relays](ui:network:NetRoomStep.room.derp) (a region's
  number in tailcat's public map, or one's own derper's `host[:port]`; empty: all of the map's regions), from which
  `roomLink` writes the link link.rs reads (`webpc-room:<id>?nostr=…&derp=…`, percent-encoded). Join takes a link (a
  password field: a private room's link is a secret) or a public room's name (a bare ID, the defaults); `parseRoomLink`
  checks it as link.rs would. Both have [Allow direct connections between members](ui:network:NetRoomStep.room.direct)
  (on by default; off is relay only, `relayOnly`: no WebRTC, everything through the room's DERP relays), its note
  saying who can learn one's IP address as the switch stands (with it: the members it connects to directly, the
  operators of the room's DERP and Nostr relays, and STUN servers; without: the relays' operators only, as no STUN
  server is asked), each term linked to what explains it, and under
  Advanced [Let members connect to this machine](ui:network:NetRoomStep.room.incoming) (on by default; off, only replies
  to the guest's own flows come in) and [The machine's key](ui:network:NetRoomStep.room.key): a new one, or another stored room connection's (the
  same key in another room: docs/network-adapters.md §2.1). The connection's default name is the room's (a private
  one's without its suffix); the Machines page says [a peer-to-peer room](ui:machines:connection-kind.room).
  Editing changes the two switches (the adapter running it connects again), and under Advanced [New
  name](ui:network:NetRoomStep.room.newName) gives the connection a new key after asking, so its old name stops working.
  The client is net/ts's `room.rs` in web/room-worker.ts, the page's WebRTC in web/room.ts (`startRoomNet`, the
  `Tailscale` handle the network controller drives, with a network map of `via: 'room'`); the node key is kept in
  `webpc-room` (an ephemeral connection's in memory). The status goes Loading the client, Connecting to the relay,
  then [Connected to the room](ui:network:network.room) with [1 active connection](ui:network:network.room.connections_one) under it (the members whose data decrypted and whose connection hasn't closed idle: the room may have many more, which no member can count). The
  menu then shows the machine's name in the room (`<key>.<tag>.p2p.internal`) to copy, the room's link to copy and, under
  them, that whoever has the name can reach any port the guest listens on (or that incoming connections are off).
  The guest's lease: its room address as a /128 (DHCPv6, the router advertisement), IPv4 `192.0.0.2` with no IPv4
  routes, the room's resolver (`<prefix>::53`) and `<tag>.p2p.internal` as its domain, so `ping <name>` works through
  systemd-resolved. A room never reaches the internet, so beside another adapter it is never the default way out and
  offers its /48 as a route: beside the local helper, say, the guest's defaults and other names stay the helper's
  while the room's members are reached by name on the second card (`tests/net-local.test.ts`).
- **Exit node:** when the tailnet has peers that advertise one (and an admin approved their
  `0.0.0.0/0` routes) the menu shows [Internet through](ui:network:NetAdapter.exitNode) with them and [No exit node](ui:network:NetAdapter.exitNode.none). Picking one
  calls the client's `setExitNode(id)` (the id is the peer's stable ID, `netmap.peers[].id`), the netmap reports the one in use (`netmap.exitNode`) and the
  status line says "internet through <name>". The choice is kept with the connection (`tailnet.exitNode`) and given
  to the client at the next Connect; using one makes the adapter the default way out (above). The guest's address, router and
  DHCP lease don't change: its default route is the gateway, which hands every packet to the client,
  and the client's routing decides between the tailnet and the exit node. **DNS follows the exit
  node**: MagicDNS (100.100.100.100, which the lease gives first) answers the tailnet's names and
  sends the rest as plain DNS through the exit node, to the tailnet's resolvers or 1.1.1.1
  (docs/tailnet.md "Tailscale"; the Go client used the exit node's DoH service instead).
- **Subnet routes:** when peers route subnets (subnet routers, their routes approved by an admin) the menu shows
  **Reach the subnets peers route** with the first of them, on by default as in Tailscale's own apps (the Linux CLI's
  `--accept-routes` is off by default). The choice is the client's `setAcceptRoutes(on)`, kept with the connection
  (`tailnet.acceptRoutes`, absent: on) and given to the client at the next Connect. The netmap lists each peer's
  `routes` and whether they're installed (`acceptRoutes`); an adapter that isn't the default way out leases them as
  routes besides the tailnet's own (web/tailscale.ts `subnetsOf`).
  **The guest must take the lease's search domain** (MagicDNS's, e.g. `tail1234.ts.net`): with
  systemd-networkd that's `UseDomains=yes` under `[DHCPv4]` and `[DHCPv6]`, which the page's
  credential, its unit's drop-ins and the Arch image set, with `UseMTU=yes` (the lease's 1280 on the link; IPv6 takes
  it from the router advertisement anyway). **The gateway clamps TCP's MSS** in SYNs both ways to
  what fits the lease's MTU (1240 over IPv4, 1220 over IPv6; `clampMss`, `web/gateway.ts`), so a
  guest left at 1500 still works: before, it asked servers for 1460-byte segments, and where a
  server ignored the exit node's "fragmentation needed", TLS handshakes to it hung over IPv4
  (Firefox and `curl -4` alike; IPv6 worked; the user's finding, 2026-10-17). networkd leaves it out by default, and without it resolved
  sends short names only to LLMNR and a `.local` MagicDNS domain only to mDNS ("Temporary failure in
  name resolution").
- **Before connections** the page kept one connection in `webpc.settings` `net`; the first load with connections makes
  it (and its kept node, and the served tailcat identity) into kept connections, attaches the one in use to the
  transient machine's adapter (`webpc.settings` `transientNet`) and every stored machine's first, and drops `net`
  (`migrateLegacy`, under the Web Lock `webpc-net-migrate`). The state dot (the default way out's, else adapter 1's;
  each section's heading has its own): grey off, amber connecting or waiting for the user, green connected, red
  an error (the client's, e.g. the control server didn't answer).
- **The client is built by the servers:** `npm run serve` and `npm start` call `tools/tailscale.ts`'s `prepareTailnetClient` first: it builds `net/ts` with `net/ts/build.sh` into `target/net/ts.wasm` when it's missing or a hash of `net/ts` and `Cargo.lock` (stamp `ts.wasm.inputs`) changed (cargo only, as the core). It never stops the server: if the build fails, it says so and the page runs; Connect then says the client isn't built (checked before the machine restarts). `scripts/ci-net.sh` runs `tools/tailscale.ts` as a step (it also builds the Go client, the hand-over test's fixture).
- **The control server must answer `GET /key` with CORS headers** (docs/plans/networking.md N4):
  Tailscale's does; a Headscale needs its reverse proxy to add `Access-Control-Allow-Origin`.
- Tests: tests/network.test.ts (the controller and its parsers with a fake client),
  tests/net-guest.test.ts (Debian with the card on the echo backend: it configures itself and
  pings, and takes a lease that arrives after the boot; no tailnet), tests/net-tailnet.test.ts (the same guest on a headscale tailnet, opt-in; its peer is an exit node: the guest reaches a server on the host only through it, and its DNS is answered by the exit node's resolver; then two adapters, the tailnet beside tailcat through a server, the guest reaching both at once), tests/page-network.test.ts (the wizard and the menu: both kinds' form errors, a tailcat server that never answers on an ephemeral connection, a served machine on the test relay reached by the tailcat CLI, its address kept over a reload, New address, an ephemeral connection gone after a reload), tests/net-live.test.ts (the adapters live with fake clients: connect at start, a restart, two tabs and a connection's lock, the default way out), tests/page-connections.test.ts (two stored machines on the firmware alone: a new machine connected in one wizard, another tab's machine taking the connection, Detach, an ephemeral one gone after a reload, Connections), tests/net-tailcat.test.ts (Debian through a tailcat exit node on this machine, serving at the same time: the CLI fetches a page from the guest), tests/page-room.test.ts (two Debian guests in one Chromium, two profiles: one creates a private room in the wizard on the tests' Nostr relay and the rig's derper, the other joins by its link, and they ping each other by name; the wizard's refusals), tests/room-link.test.ts (the link as link.rs writes it, a private room's ID, what a link may not be).
  Not tested: a real interactive login and the menu's login states in a browser (they need a
  control server that serves one; the docs/backlog.md "Network" entry says what's missing).

## The end-to-end test

`tests/page-debian.test.ts` (M8 loop 6; `scripts/ci-debian.sh`; with GRUB's key on the screen, the page's size and the
Debian snapshot on the same boots: [testing.md](testing.md) "Debian boots") does on the page what a user does, in a fresh
browser context (an empty OPFS), from this checkout's server (`tests/start.test.ts` covers the
fresh clone): Debian (through UEFI, with `tests/debian-unattended.ts`'s credentials) on 2 parallel vCPUs (`?ncpus=2&view=both`) to `running`; the firmware's variable store is saved beside the overlay within seconds; root logs in on the
serial terminal; from there `until grep -q 'login: ' /dev/vcs1` waits for tty1's getty; root logs
in on the screen and runs `echo from-$(tty)-$((6*7)) >/dev/ttyAMA0`, which the serial terminal
shows (`from-/dev/tty1-42`); `/dev/vcs1` read on the serial side shows the screen's prompt and
command; the canvas isn't black. Then a file written and `sync`ed survives a reload (no shutdown:
as a closed tab), and Reset disk (the dialog accepted) boots a disk without it. Three Debian boots:
~178 s alone (running at ~55 s, logged in on both at ~62 s, reloaded and running at ~112 s, reset
and running at ~172 s); `WEBPC_PAGE_RUNS=N` repeats it. It and the `npm start` test take turns (`tests/debian-lock.ts`, a lock
directory in the temp directory): two Debian page boots at once beside the rest of `npm test`
loaded the host enough to fail a realtime bare-metal test (docs/backlog.md). In CI it takes ~3 min
(the host is shared with the other test files); `npm test` went from ~253 to ~290 s.

How it types, and why:
- **Serial first, then the screen.** Both gettys start within 0.2 s of each other (loop 0), but
  the page's `running` is the serial prompt, and keys typed on tty1 before its getty is up can be
  flushed. The serial shell can see tty1's text (`/dev/vcs1`, the screen as characters: no OCR
  needed), so the test types on the screen only once tty1 shows `login: `.
- **Not typed ahead of a prompt:** after `root` + Enter the test waits for bash's prompt
  (`root@localhost:~# `) before the next line; typed ahead, the first key of the next line was
  lost while login handed the tty to the shell. On both consoles: on the screen it waits for the
  prompt in `/dev/vcs1` from the serial shell (without that wait, a CI run under load lost the
  screen's command, M8 loop 7).
- **Keys on the screen one at a time**, with Shift pressed for shifted characters (Playwright's
  `type()` sends `>` as Period alone; web/input.ts maps by `code`), 10 ms apart (virtio-input
  drops events past 1,024 queued).
- **The ready marker is matched anywhere in the output** (at a line's start: `(?:^|\n)\S+ login: `),
  not only at the end of a drain: a kernel line printed right after the prompt, in the same drain,
  would otherwise leave the page in `booting` for good. The first run of this test sat in
  `booting` for its whole 4-minute wait, one of the 44 boots of this loop; no line after the prompt was
  seen in the runs checked afterwards, so this is the likely cause rather than a proven one. The
  test now says the page's state, status line and terminal on such a timeout.

`tests/page-snapshot.test.ts` is the same for snapshots ("Snapshots"): on Buildroot (`?machine=buildroot&ncpus=2`, always, ~10 s) a
shell variable and a file in devtmpfs (the test kernel has no tmpfs) are RAM state; Save snapshot
by a download and by a picker's handle (a file in OPFS); the machine answers afterwards; the file
starts with `WEBPCSNP`, its header has the fields above and no hash; in a fresh profile Load
snapshot restores the terminal's tail, 2 vCPUs (the page asked for 1), the variable and the file,
with no terminal reply sent to the guest for the replayed output; refusals leave the machine running or the OPFS exactly as it was (a file that isn't a snapshot, a snapshot of
another machine, one on another disk, one whose machine had a `?disk2=`, a truncated file, which Start
then recovers from); a snapshot dropped on the page goes the same way. With `WEBPC_DISTROS=debian`, Debian: root logged in on the serial terminal, a
file written and `sync`ed, a variable; Save snapshot (~175 MB, the machine paused ~1.3 s); in a
fresh profile the page starts booting, Load snapshot replaces it, and the machine is running 2.1 s after the choice, still logged in with its variable, the
file read past the page cache (`drop_caches`), the firmware's flash copy written beside the new
overlay, a new file written and read back, and a reload boots the restored disk with both files. A
Buildroot snapshot on the Debian page is refused at once.

## Overlay hand-over

A new machine opens the overlay the old one had open, and OPFS sync access handles are exclusive:
the new one must open it only once the old one's handles are closed. `openOverlay`
(web/overlay.ts) first takes the Web Lock `webpc-overlay:<name>` (exclusive, per origin: every
tab and worker) and holds it until `close` has closed the handles; a context that ends (a
terminated worker, a closed tab) drops its locks with its handles. So the ordering doesn't rest
on timing: the old machine's device worker closes on `close` and answers `closed` (`vm.close()`
resolves then, or after a second without an answer: a sync XHR still waiting on a slow link), the
page terminates the old machine worker after `stopped` (or 3 s), and whichever way the old one
lets go, the new one's `openOverlay` waits for it. An opener that waits `OVERLAY_WAIT_MS` (10 s)
fails with "overlay <name> is in use" (`disk-in-use`: another tab runs the machine); a
`NoModificationAllowedError` after the lock would mean a browser released the lock before the
handles (not seen: below). Reset disk's `removeOverlay` takes the same lock.

M8 loop 8 (the user's report: a Restart once failed with "disk in use", and Retry fixed it):
reproduced only with **two restarts overlapping** (a second Restart click, or the guest's reboot,
while the first restart waits for `stopped`): the page's `stop` found no machine and started one
at once, then the first restart started another. Not reproduced otherwise without the lock, in
~150 restarts on Buildroot and Debian at random points (while booting, running, the guest writing
to its disk, restarts during the next machine's loading or booting, disk reads delayed 0.15–5 s by
a proxy so `close` timed out), nor in 400 terminations of a worker holding the overlay followed by
an immediate open: Chromium releases a terminated worker's handles before a new worker can open
them, and aborts a nested worker's sync XHR when its parent is terminated. Tests:
`tests/browser.test.ts` "the overlay's hand-over" (a second opener waits for the first's `close`,
20 holders terminated and the overlay opened at once, one held past the wait is in use; without
the lock the second opener fails at once) and "the page restarts over and over" (six restarts
while the guest rewrites its disk, during the next machine's loading and booting, one a double
click; the page as it was fails on the double click).

## The build

**Vite** (8, Rolldown inside) with `@sveltejs/vite-plugin-svelte`, configured in `vite.config.ts` (the user's call,
2026-10-24: packages used as packages, and the page served as a few bundled files instead of hundreds of modules).
Node never goes through it: tools, tests and `bench/` run `.ts` directly, as before.

- **`vite build`** (`npm run dist`, `npm start`; ~1 s) has `web/app/` as its root, so `web/app/index.html` is the
  copy's, and `base: './'`, so the copy works under any path. Workers are found in the form
  `new Worker(new URL('./x.ts', import.meta.url), { type: 'module' })` written out whole, with static options, and
  bundled each on their own (ES modules); `web/vm.ts` writes its two that way and gives Node's `worker_threads` the
  same files through a lookup the bundler leaves alone. The machine worker gets the page's query in its start message
  (`query`), not in its URL. The sound worklet is `import WORKLET from './audio-worklet.ts?worker&url'` (the bundler
  doesn't follow a URL given to `addModule`). A `new URL('<literal>', import.meta.url)` is an asset: the core, the
  tailnet client and the firmware are copied with hashed names; the tests' guest images are named by concatenation
  (`machine.ts` `images`), which the bundler leaves alone (a template literal would make it take in every file
  under `target/images/`). `node:` modules, which `web/` imports dynamically on its Node paths, are left external.
- **The dev server** (`tools/serve.ts` `startServer`, the repository as its root) serves the whole repository from
  source: TypeScript and Svelte compiled per request, so the test pages under `tests/browser/`, `bench/*/index.html`
  and modules a test imports in a page (`import('/web/app/store.ts')`) work as they are. `/` redirects to the page at
  `/web/app/` (with the query). `target/` is served by sirv ahead of Vite (range requests and HEAD for the disks and
  firmware; Vite would take an extensionless file, a kernel's `Image`, for a module). No dependency pre-bundling (the
  packages are ES modules, and parallel test processes would race on its cache). The tests and benchmarks run it in
  mode `test`: no file watching or hot reloading, Svelte's production code and the packages' production builds.
  `npm run serve` runs it in development mode, hot reloading. Both send COOP, COEP and `Cache-Control: no-store`.
  **A module's URL is its identity to Vite** (its query included: `?worker`, `?url`, `?raw` mean something), so
  settings never ride on a module's URL: the page gives the machine worker its query in the start message, and a
  harness page gives its worker the query as the worker's `name` (`self.name`: `tests/browser/boot.html`,
  `virgl-boot.html`, `bench/spike/page.ts`). A worker's URL is a literal (Vite can't analyse a template string).
- **The preview server** (`startServer` with a build's directory) serves a static copy with the same isolation
  headers and range requests: `npm start`, `npm run dist -- --serve`, `tests/dist.test.ts`.

Why the tests use the dev server and not the build: their harness pages and in-page imports would each have to be
a build entry; the build itself is tested end to end by `tests/dist.test.ts` (Buildroot boots from it). The Mac
benchmark scripts (`bench/run-mac.sh`, `bench/gpu/*-mac.sh`) install the packages there with `npm ci`
(`bench/mac-packages.sh`): Vite's native parts are per platform.

## `npm start`

One command from a fresh clone (M8 decision 5): `tools/start.js`, then `tools/start.ts`. In order,
each step skipped when its output is current:

1. **Node ≥ 26** (`package.json` `engines`): `start.js` is plain JavaScript so an older Node
   gets the message (where to get Node 26) instead of a loader error on `.ts`.
2. **rustup**, looked up on `PATH`, else in `$CARGO_HOME/bin` or `~/.cargo/bin` (installed, but the
   shell hasn't read `~/.cargo/env`: used from there). Missing: where to get it (rustup.rs and its
   one-line installer). Not run to check it: `rustup --version` asks the active toolchain for its
   version and may install it.
3. **npm packages:** `npm ci --no-fund --no-audit` when `node_modules` is missing or doesn't match
   `package-lock.json`, judged from npm's own record of what it installed
   (`node_modules/.package-lock.json`): every locked package installed at its version (optional
   ones for other platforms, TypeScript's native binaries, may be absent), none extra. Under
   `npm start` it runs the same npm (`npm_execpath`).
4. **The wasm core**, when the hash of what decides it (`Cargo.toml`, `Cargo.lock`,
   `rust-toolchain.toml`, `.cargo/config.toml`, `scripts/build-wasm.sh`, `core/Cargo.toml`,
   `core/build.rs`, `core/src/**`: contents, not mtimes) differs from the stamp next to the wasm
   (`webpc_core.wasm.inputs`, written after a build). Then: a C compiler (`cc --version`; Rust
   links build scripts, std's under `-Zbuild-std` and the core's decoder generator, with the host
   linker: Xcode's command line tools on macOS, gcc or clang on Linux), `rustup toolchain install`
   (reads `rust-toolchain.toml`: the pinned nightly with `rust-src` and the wasm target; a no-op
   in 10 ms when installed; needs rustup ≥ 1.28), then `scripts/build-wasm.sh`. A checkout that
   touches files without changing them rebuilds nothing, which cargo's mtime fingerprints alone
   wouldn't give (a real rebuild is LTO with one codegen unit: minutes).
5. **The tailnet client** (`tools/tailscale.ts` `prepareTailnetClient`: `net/ts/build.sh`, cargo only), when
   its stamp differs; never fatal (the Network menu then says it isn't built).
5b. **The UEFI firmware** (`images/build.sh edk2`: EDK2 in a rootless Podman container, ~1 min the
   first time, which also pulls the build image and clones EDK2; the user's answer "for now"):
   skipped when `images/build.sh --check edk2` says it's current. Without Podman the start
   stops *before* the long steps, saying how to install it. `tests/start.test.ts` covers the
   message and (with `WEBPC_START_COLD=1`) the build in the copy.
5c. **Clipboard sharing's guest agent** (`images/build.sh agent`: Rust in Podman, ~1 min the first time; without
   Podman the host's cargo, a build `npm run dist` refuses: docs/images.md "agent"), when `images/build.sh --check
   agent` says it isn't current.
5d. **Vulkan's renderer** (`target/vk/venus.wasm` and its licences, vk/README.md "On the page"), when the key of what
   decides it (`vk/build.sh --inputs`: `vk/` but its `.md` files, and `VENUS_ARENA` in `web/ram.ts`) differs from the
   stamp a build writes beside it (`venus.wasm.inputs`; `vk/build.sh` on the host writes it too, so a developer's
   build counts). Built by `images/build.sh venus` (`vk/build.sh` in Podman, docs/images.md "venus": ~3 min the first
   time on the dev VM, pulling Node's Debian image and cloning Mesa and virglrenderer; ~1 min after a change in
   `vk/`), which installs it in `target/vk/`; without Podman (a cloud session, its firmware fetched) `vk/build.sh` on
   the host.
6. **The page's build** (`vite build` into `target/dist/`, as `npm run dist` writes it, below, "A static copy"; ~1 s,
   run every time: its output carries the commit) and **the server**, Vite's preview server over it
   (`tools/serve.ts`), on `127.0.0.1:8080` (`PORT` or `--port`; `--host` for
   another interface, with a warning that a remote browser over plain HTTP gets no cross-origin
   isolation, so forwarding the port is the way), then the URL and the `ssh -L` line. A port in
   use stops it with a message rather than moving to another port: **OPFS is per origin, so the
   saved disks' changes belong to the port**. `--prepare-only` does steps 1–5d and exits.
   **No disk image:** the page waits for the user's (above, "The machines"); `npm start` downloaded
   Debian until 2026-10-17, when the page stopped starting it.

What stops it is said in one message with what to do, and it exits 1. Time on the dev VM (M8 loop
5, bench/boot/REPORT.md): nothing to do, ~0.1 s of checks (`--prepare-only`: 119 ms on 2026-10-24) and the page's
build (~1 s) to the URL; a fresh clone 6.4 s to the URL with the core copied in (`tests/start.test.ts`: npm ci, the
build), plus the core's build cold (10–11 s; the toolchain's install, 722 MB, 6 s on this network).

**Debian's preparation** (the tests' guest; `tools/debian.ts`, run by `images/build.sh debian`: it links
the disk and takes nothing out of it; the pin is `images/debian.json`): the qcow2 from the download cache (`WEBPC_DL`, default
`target/images/dl`), or downloaded there with progress (a line rewritten on a terminal, every 10%
otherwise) through a `.part` file, and checked against the pinned SHA512 either way (~1 s); the
disk is hard-linked from the cache (a copy, reflinked where it can be, if the cache is on another
filesystem). The output is byte for byte what `images/SHA256SUMS` lists (`images/build.sh debian`
checks it). The kernel and initrd aren't extracted (the page boots
Debian through UEFI).

## A static copy

`npm run dist` (`tools/dist.ts`) writes the page as plain files to `target/dist/` (`--out <dir>`), to copy to any
web server: no Node behind it. It first does `npm start --prepare-only`'s steps (`--no-prepare` skips them and
stops if a binary is missing, Vulkan's renderer among them), then builds the page with Vite (below, "The build") and adds the licenses:

- `index.html`, the page at the site's root (`https://vm.tny.im/?disk=<url>`), with a `<meta name="webpc-build">`
  holding the commit it was built from, its date and "with local changes" when tracked files differed
  (`tools/stamp.ts`, written by `vite.config.ts` into every load of the page, the dev server's too); the page logs it
  at load (`webpc: built from …`), so a user's console says which build they ran.
- `assets/`: the page's code bundled, minified, with source maps: the page (`index-<hash>.js`, its CSS), each worker
  (machine, vCPU, device, compile, GPU, sampler, timeline, tailnet, tailcat, disk jobs, import, export, inflate,
  deflate) and the sound worklet; and the binaries the page fetches, the core (`webpc_core.wasm`), the tailnet client
  (`ts.wasm`), EDK2 (`QEMU_EFI.fd`), clipboard sharing's guest agent (`webpc-agent`, fetched only by a machine with
  the setting) and Vulkan's renderer (`venus.wasm`, 12 MiB, fetched only by a machine with
  Vulkan on: vk/README.md "On the page"). Every name is hashed, so a host's caches never serve a stale file with a new
  page. 21.4 MiB in all, 45 files, half of it the source maps (2026-10-24). **No guest images**: the user opens a disk, or passes `?disk=<url>` (a server that answers
  range requests and, cross-origin, sends CORS and CORP headers). A relative `?disk=` URL is relative to where the
  page is.
- From `web/app/public/`, copied as they are: `_headers` (Netlify, Cloudflare Pages and Workers' static assets) and
  `.htaccess` (Apache) with the two headers, `.nojekyll`, and `web/app/index.html`, which redirects to the root with
  the query and fragment (the page was there until 2026-10-23).
- `THIRD-PARTY-LICENSES.md` (the bundled packages' licenses: Vite's `build.license`), `EDK2-LICENSES.txt` (the
  firmware's), `VENUS-LICENSES.txt` (Vulkan's renderer's: virglrenderer, Mesa, wasi-sdk's libraries; vk/build.sh
  writes it), `LICENSE`: the About pane links them (above, "About"; `BUNDLED` in `tools/third-party.ts` names the
  first two's sources), and a marker file (`.webpc-dist`, from `web/app/public/`, so a plain `vite build` has it
  too): the script only empties a directory that has it.

**The host must send `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`**
with every file (shared memory needs cross-origin isolation) and serve over HTTPS (or localhost). The page fetches
its own files whole (Cloudflare's static assets answer a range request with the whole file); range requests matter
for disks, which aren't in the copy. GitHub Pages can't set headers. `npm run dist -- --serve` previews the copy with Vite's preview server
(`tools/serve.ts` `startServer` with the copy as its root), which gives the headers and ranges. OPFS is per origin,
so a disk's saved changes stay with the site they were made on. `tests/dist.test.ts` builds a copy, checks it is the
bundle (a few hashed files, no source), serves it so and boots Buildroot from it (its images linked in at
`target/images/`, where the page's direct-boot machines look: `web/app/machine.ts`).

### Deployed at vm.tny.im

The user's public copy (since 2026-10-17): `https://vm.tny.im`, a **Worker with static assets only** (no script) named
`webpc` on the user's account (`wrangler.jsonc` at the repo's root; also at `webpc.gbl08ma.workers.dev`), uploaded from
the dev VM. **Deploying is outward-facing: only when the user asks.** Redeploy (the copy is rebuilt first; a deploy is
atomic and replaces the site):

```sh
set -a; . ~/.config/cloudflare/webpc.env; set +a
npm run dist && wrangler deploy --message "$(git log -1 --format=%s | head -c 100)"
```

then check it from Chromium (`bench/results/local/live-pages.ts <origin>` boots Debian from a local file on the
deployed page and screenshots it as `live.png` in `$CLAUDE_JOB_DIR/tmp`, else the system's tmp directory; untracked). How it was set up:

- **wrangler** (Cloudflare's CLI) in the dev VM, outside the repo (not a dependency): `npm i -g --prefix ~/.local
  wrangler@4.151.1` (in `~/.local/bin`; npm skips `workerd`'s postinstall, which only `wrangler dev` needs).
- **Credentials:** an account API token and the account ID in `~/.config/cloudflare/webpc.env`
  (`CLOUDFLARE_API_TOKEN=`, `CLOUDFLARE_ACCOUNT_ID=`; mode 600), written by the user on the VM. Source it; never print
  it. Its permissions (2026-10-23): Account → Workers Scripts, Workers KV Storage → Edit, Workers Tail and Account
  Settings → Read; Zone (`tny.im`) → DNS, Workers Routes → Edit. No Pages (the old project is deleted), R2, Cache
  Rules or WAF: R2 was tried for disk images and dropped ([remote-disks.md](remote-disks.md)
  "Hosting on Cloudflare"). The user edits it in the dashboard (its value stays). `wrangler login` doesn't suit the VM (its OAuth callback is on the VM's
  localhost), and `wrangler whoami` fails with this token (no user-level permission): verify it with
  `GET /client/v4/user/tokens/verify` instead.
- **The domain:** `routes` in `wrangler.jsonc` makes `vm.tny.im` the Worker's custom domain (Cloudflare adds its DNS
  record). **Every other record in the `tny.im` zone is the user's: leave them exactly as they are** (`tny.im` itself
  is a Pages project).
- **From Pages (2026-10-23):** the site was a classic Pages project `webpc` (`wrangler pages deploy`) until then;
  moved by Cloudflare's guide (workers/static-assets/migration-guides/migrate-from-pages): the Worker deployed and
  checked on workers.dev, every file of `target/dist` compared, then the Pages project's domain and its `vm CNAME
  webpc.pages.dev` deleted and the Worker deployed with the route (under a minute without the site); the user then
  deleted the Pages project. In the dashboard (Workers & Pages) the Workers `webpc` and `webpc-disks` showed only after
  a hard reload. One difference kept: an unknown path is a 404
  (`not_found_handling: none`), where Pages answered the root page (its single-page fallback, with no `404.html`).

**Disk images** are a second assets-only Worker, `webpc-disks` at `https://vmdisks.tny.im` (`deploy/disks/deploy.sh`,
the same credentials), never a bucket: [remote-disks.md](remote-disks.md).

What it gives: `_headers` applies (COOP, COEP on every file), `.wasm` is `application/wasm`, `.js`
`text/javascript`, a missing trailing slash and `index.html` redirect (307). 25 MiB a file, 20,000 files (the free
plan). Disks aren't hosted with the page (above). The dev VM's resolver may cache a
new name's absence for a while after a DNS change: Chromium's `--host-resolver-rules=MAP vm.tny.im <ip>` (the
script's `MAP=`) checks the real site meanwhile.
