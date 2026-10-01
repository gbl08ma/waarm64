# The page

The interactive machine (M8 phase A): one VM per page, its screen on a canvas and its serial
console on xterm.js. `npm start` prepares everything and serves it at
`http://127.0.0.1:8080/web/app/` (`/` redirects there; below, "`npm start`"); `npm run serve` only
serves (and builds the Tailscale client, below, "Network"). Chromium only.

## Files

| File | What |
|---|---|
| `web/app/index.html` | the page: header (machine, power state, views, Restart), the screen, the terminal, the status line; styles inline; an import map for `@xterm/xterm` |
| `web/app/main.ts` | DOM code only: views, the canvas's scaling, xterm.js, power state, the status line; starts and stops machine workers |
| `web/app/worker.ts` | the machine worker: boots a machine with `bootVm` and drives it with `runAsync` |
| `web/app/protocol.ts` | the messages between the two (types only) |
| `web/app/machine.ts` | the machines, in one place: image URLs (the firmware, for UEFI machines), command line, the credentials a card adds, RAM, screen size, the `ready` marker, the default vCPU count |
| `web/app/network.ts` | the Network menu's logic, DOM-free: settings parsers, the view of the client's state, the machine's IP port across restarts and disconnects (below, "Network") |
| `tools/start.js`, `tools/start.ts` | `npm start` (below) |
| `tools/tailscale.ts` | builds the Tailscale client when missing or stale, for `npm run serve`, `npm start` and `scripts/ci-net.sh` ("Network") |
| `tools/debian.ts` | Debian's download and preparation, for `npm start` and `images/build.sh debian` |
| `web/bootfs.ts`, `web/ext4.ts` | partition tables, a read-only ext2/3/4 reader, a distribution's kernel and initrd (below, "The disk reader") |

Query parameters (development and tests; no settings UI yet): `?machine=debian|buildroot` (the
default is `debian`), `?ncpus=N`, `?view=screen|terminal|both` (over the remembered view),
`?params=…` (extra kernel parameters for a direct-boot machine, placed before a `--`: e.g.
`init=/nonexistent` to make Buildroot panic, as a test does; Debian's bootloader owns its command
line: edit it in GRUB), `?credential=name:value` (repeatable: a systemd credential over fw_cfg for a
firmware machine; tests pass `tests/debian-unattended.ts`'s to boot Debian unattended, the page
passes none), `?disk2=<url>` (a second,
read-only virtio-blk over HTTP ranges, `/dev/vdb` in the guest, no overlay; for tests: the stress
test's `--disk2` gives it the Go toolchain image, docs/images.md "Stress workloads").

## The machines

- **`debian`**, the page's VM (M8 decision 1): Debian's published nocloud qcow2, **unmodified,
  booted through UEFI** (M8 phase B: EDK2's `QEMU_EFI.fd` as the machine's `firmware`, then shim
  and GRUB from the disk: docs/plans/uefi.md; below, "Debian through UEFI"), under the JIT,
  realtime, a worker per vCPU; 1 GiB; a 1024×768 framebuffer; rng, the disk (virtio-blk over HTTP
  ranges, writable through the OPFS overlay `webpc-debian`), keyboard, tablet. No virtio-console
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
  where the questions are ("Show it" opens the serial view). Tests pass them over fw_cfg
  (`tests/debian-unattended.ts`: `login.noauth`, `firstboot.*`, an empty root password).
- **`buildroot`**, the test guest: `-- /bin/sh` on the serial console, 256 MiB, a 640×480
  framebuffer that stays black (its kernel has no fbcon), the overlay `webpc-buildroot` (mounted
  read-only; it's there so restarts hand an overlay over). Up in under a second.

URLs are relative to `machine.ts`, so nothing but the location of `target/` ties the page to the
dev server (decision 7).

## The worker protocol

The seed of phase D's embedding API; not frozen. One machine per worker: a restart stops the
worker and starts a new one (fresh memory, fresh ports).

Page → worker:
- `start {machine, ncpus, keyboard, tablet, serial, screen, params?, credentials?}`: three transferred `MessagePort`s
  and a transferred `OffscreenCanvas`. The keyboard's and the tablet's ports go to the device
  worker (web/input.ts's `attachInput` sends Linux input events to the other ends; LED changes
  come back on the keyboard's). `serial` is `BootOptions.serialIn`: strings or bytes for the
  PL011, handled on the machine worker's thread while `runAsync` awaits. `screen` is the page's
  canvas (`transferControlToOffscreen`, sized as the machine's framebuffer): the machine worker
  draws the framebuffer on it (web/display.ts) on its own animation frames. `params`: extra kernel
  parameters (direct-boot machines). `credentials`: systemd credentials over fw_cfg for a firmware
  machine, beside the machine's own (the network card's). `disk2`: a URL for the second disk.
  `disk`: `{url?, file?, overlay}`, the root disk to boot instead of the machine's (below, "Your own disk").
- `stop`: stop the vCPUs and release the backends (the overlay's OPFS handles); answered by
  `stopped`. A machine still booting (`bootVm` not returned: its device worker may already have
  the overlay) is closed once it's there. The page then terminates the worker (after 3 s without
  an answer, anyway).

Worker → page:
- `state {state, message?, problem?}`: `loading` (fetching the wasm, kernel, initrd), `booting`
  (the VM runs), `running` (the machine's `ready` marker appeared on the serial console:
  `readyWatcher` in machine.ts, over the output so far, across drains), `off`
  (PSCI SYSTEM_OFF), `rebooting` (PSCI SYSTEM_RESET: the page starts a new machine), `crashed`
  (the guest's `Kernel panic - not syncing` line, an emulator error, an unimplemented exit),
  `failed` (the machine couldn't start). `crashed` and `failed` carry a message for the user and a
  `problem` (below, "Errors"), from which the page picks the actions it offers. After a panic the
  state stays `crashed` even if the guest resets (`panic=N`), so the message stays on show.
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
  the last status as JSON in the status line's `data-status` (for `bench/stress`).
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
says so, with a "Show it" button for the serial view. On this host (M8 loop 4): the downloads (77.6 MB:
Debian's kernel, its initrd and the core; the 403 MB disk is read by ranges as the guest needs it)
take ~0.15 s from localhost, fbcon takes the screen ~2.4 s after the VM starts, and the login
prompt comes at ~29 s (page load to `running`: 28.6, 29.1, 28.9, 29.0 s; loop 3: 28.6–29.0).

## Errors

What stops a machine is said in a bar under the header: what happened, why, and what to do, with
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
  GiB on 1 vCPU, 3.1 on 4, with 1 GiB of guest RAM). Below it the page doesn't start the machine
  (state `idle`, "Not started") and offers **Start anyway**, naming a vCPU count that fits if one
  does. A device that reports 4 GB or more runs Debian's default on up to 4 vCPUs.
- Another browser than Chromium (no `Chromium` brand in `navigator.userAgentData`): a standing
  note that webpc is developed and tested in Chromium; nothing else changes.

From the machine worker, as `problem`:

| `problem` | When | Actions |
|---|---|---|
| `missing-core` | the wasm answers 404 (or the server doesn't answer) | Retry (the message says `npm start` builds it) |
| `missing-image` | the kernel, initrd or disk (a `HEAD`) answers 404 | Retry (the message names the file and the machine's `prepare` command) |
| `disk-in-use` | the overlay's files are locked (`NoModificationAllowedError`): another tab runs the machine | Retry, once that tab is closed |
| `disk-mismatch` | the overlay's `base` names another image | Reset disk… |
| `memory` | reserving the guest's RAM throws a `RangeError` | Retry |
| `panic` | the guest's `Kernel panic - not syncing` line | Show serial log, Copy serial log, Save serial log |
| `emulator` | anything else (an exception, an unimplemented exit) | the same three |

Retry and Restart start a new machine worker. The failed states (`failed`) make the header's
button read Retry. **The serial log** is kept by the page (the last 1–2 MB of the serial console's
output, beyond xterm.js's 5,000 lines of scrollback) for Copy (the clipboard) and Save (a
`webpc-<machine>-serial-<time>.log` download); Show serial log switches the Screen view to Both.

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

The canvas keeps the framebuffer's size; CSS scales it to an integer multiple **in device pixels**
when one fits the view (`image-rendering: pixelated`: crisp at any `devicePixelRatio`), and
scales it down smoothly when it doesn't fit at 1:1. A `ResizeObserver` and a `resolution` media
query refit it.

## Input

- **Focus:** the screen takes the keyboard on a click (tabindex 0; the page focuses it on load
  and when the Screen or Both view is chosen, the terminal in the Terminal view). A focused
  screen has an accent ring; an unfocused one shows "Click to type" over it. The terminal's frame
  takes the accent while xterm.js has the focus (its cursor is filled then, too). Tab moves
  between them.
- **No stuck keys:** `attachInput` tracks what the guest believes is held and releases it (keys,
  then mouse buttons) when the screen loses the focus, the window loses it, or the page is
  hidden; a keyup for a key the guest doesn't hold is dropped. A pointer press captures the
  pointer, so a drag that leaves the screen still ends there.
- **Keys the browser keeps:** the Keys menu sends Ctrl+Alt+Del and Ctrl+Alt+F1 to F12 (a grid of
  F-keys under "Ctrl+Alt+", built by main.ts) to the screen's keyboard (`Input.chord`: pressed in
  order, released in reverse). On Debian, Ctrl+Alt+Del reboots (systemd's `ctrl-alt-del.target`;
  the page then starts a new machine), and Ctrl+Alt+F2 to F6 switch to tty2–tty6, where logind
  starts a getty on demand (autovt, `NAutoVTs=6`); F7 to F12 switch to consoles with nothing on
  them. The smoke test checks the chord of F12 (the highest keycode of the set, 88).
- **Full screen** puts the views (`main`) in full screen and asks for the **Keyboard Lock**
  (`navigator.keyboard.lock()`, Chromium, effective only in full screen): Ctrl+W, Ctrl+T, Esc and
  the like go to the machine, and holding Esc leaves full screen (Chromium says so on entry).
  Without the lock (refused, or another browser) full screen still works and the browser keeps
  its shortcuts. Headless tests can't check the lock (Playwright's keys bypass the browser's
  shortcuts), only that full screen is entered with the focus on the screen.
- **Paste** into the serial terminal is xterm.js's: `onData` gets the text (`\n` as `\r`, which
  the tty turns back; bracketed when the program asked for it), and `vm.send` queues what the 4 KiB
  RX ring can't take yet. Paste into a program that reads (a paste typed ahead of a shell's
  prompt goes to its line editor as commands). No clipboard for the screen yet (phase C, host
  integration).
- **The tablet** maps a pointer to 0–32767 across the canvas's box as laid out
  (`getBoundingClientRect`), so it follows the CSS scaling, integer or not.
- Keys are mapped by `KeyboardEvent.code` (a US PC keyboard, as the guest's default keymap); a
  synthesized key without its modifier events (Playwright's `type()` of `>` sends Period without
  Shift) reaches the guest unshifted.

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

## The serial terminal

xterm.js 6 (`@xterm/xterm`, MIT; the only runtime dependency), 80×25: the PL011 has no size
negotiation, so a Linux guest assumes 80×24 unless `stty` says otherwise, and the firmware's
console is 80×25 (our EDK2 offers no other text mode: `images/build.sh edk2` patches the
terminal driver's mode table, because GRUB takes the largest mode and asks the terminal to resize
itself with `CSI 8;r;c t`, which xterm.js doesn't do; docs/backlog.md "EDK2's terminal modes"). `onData` sends what a
terminal would (`\r` for Enter, escape sequences) to the `serial` port. No addons. The dev server
**The firmware and GRUB through it** (`tests/page-uefi-keys.test.ts`, which drives them end to
end): arrows, Enter, Esc, F2, Ctrl-N/P/E/X, Home/End and typing all arrive. Two things about
EDK2's terminal driver: a lone Esc is delivered ~2 s late (it waits to tell it from the start of
a sequence), and PageUp/PageDown (`CSI 6~`) aren't decoded (GRUB's editor shows them as text), so
use Ctrl-N/Ctrl-P there. A long run of arrow keys sent fast can lose bytes (the PL011's FIFO
against a guest that polls): a person's typing is slower. The serial terminal, not the screen, is the way into the firmware's
setup (GRUB's "UEFI Firmware Settings" entry resets into it; the boot device menu's "EFI Firmware
Setup") and GRUB's editor and command line.

The dev server serves exactly two files from `node_modules`, `@xterm/xterm/lib/xterm.mjs` and
`@xterm/xterm/css/xterm.css` (`tools/serve.ts` `ALLOWED`); everything else there is refused.

## Views, settings and the disk

Screen (the default, decision 2), Serial terminal, or Both (side by side; stacked below 1100 px).
The view chosen last is remembered per browser (`localStorage` `webpc.settings`, JSON; read and
written in try/catch, so a browser that refuses storage just doesn't remember); `?view=` overrides
it without being saved. It's the only setting so far; vCPUs and RAM stay defaults (`min(4, cores −
2)`, 1 GiB) until phase D's settings.

Restart asks for a confirmation while the machine is booting or running (it's a power cut); after
a power off the button reads Start. One restart or disk reset at a time (`exclusively` in
main.ts): Restart and Reset disk are disabled from the click until the new machine's worker is
started, so a second click can't start a machine beside the one being started (the first would
keep the overlay, and the page would lose track of it). The disk overlay persists across reloads and restarts; OPFS
belongs to the browser profile, so Playwright's temporary profiles start empty and tests don't see
each other's disks.

**Reset disk** (M8 decision 4; shown for machines with an overlay) asks for a confirmation that
says what goes (the overlay's size, from `overlayBytes`), stops the machine (its device worker
releases the overlay's sync access handles), deletes the overlay (`removeOverlay` in
web/overlay.ts: under the overlay's Web Lock, `removeEntry(name, {recursive: true})` on the OPFS
root) and starts a new
machine, which boots from the image as published. If the removal fails (another tab holds the
files), the page says so and offers the reset again.

## Debian through UEFI

The page boots Debian's published image unmodified (M8 phase B loop 3; [plans/uefi.md](plans/uefi.md)):
the machine's `kernel` is `target/images/edk2/QEMU_EFI.fd` (with `LICENSES.txt` beside it, served
with it), `firmware: true`, no initrd and no command line; `web/app/worker.ts` passes
`BootOptions.firmware` (the flash bank and the fw_cfg files). What that changes for a user:
- **The boot takes ~20 s longer** (bench/boot/REPORT.md "M8 phase B loop 3": 53 s to the login
  prompt against 33 s): EDK2 to the kernel ~9 s, GRUB's 5 s menu timeout (any key stops the
  countdown), and ~5 s in userspace, because the page's old command line is gone: GRUB owns it
  (`apparmor=0`, the masked units and `console=tty0` no longer apply; AppArmor loads its profiles,
  timesyncd, resolved and networkd start). The screen shows nothing until a getty (no fbcon boot
  log); the serial terminal has the firmware's and the kernel's output.
- **A first boot asks its questions** on the serial terminal (above), as on a regular machine.
  The page offers no way yet to skip them; a disk that has been through its first boot comes
  with loops 4–6 (a disk in, a changes file or whole disk out).
- **The variable store** (the firmware's boot entries and settings, the flash bank, 1 MiB) is kept
  per disk in the overlay's OPFS directory (`webpc-debian/flash`, `loadFlash` and `saveFlash` in
  web/overlay.ts): saved when it changes (checked every 5 s), at power-off, reset and Restart; it
  goes with Reset disk. It is what lets GRUB's "UEFI Firmware Settings" reach EDK2's setup.
- **The network card's settings** (`machine.network.credentials`) go over fw_cfg as the
  credential `opt/io.systemd.credentials/network.network.card`, whenever the machine has a card
  (always, on this machine); the unmasked networkd and resolved do the rest.

## Your own disk

A `firmware` machine (Debian) boots a disk of the user's own (M8 phase B loop 4): the header's
**Open disk…** (a file picker), a file dropped on the page, or `?disk=<url>` (served with HTTP
range support, like the machine's own). The machine restarts on it (confirmed if it runs); raw or
qcow2 is told by the file's magic (a qcow2 with a backing file is refused until loop 6).
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
- Tests: `tests/page-disk.test.ts` (WEBPC_DISTROS=debian; two Debian boots): a symlink named
  `mydisk.qcow2` to Debian's image through the picker, a file written, its overlay and flash in
  OPFS, then the same file chosen again after a reload has the file.

## Network

The header's **Network** menu (machines with a `network` entry in machine.ts: Debian) connects the
machine's network card to a Tailscale network (docs/plans/networking.md; the backend is
web/tailscale.ts, the client in its own worker).

- **The card is always there** (`machine.network`): virtio-net on the Ethernet gateway from the
  boot, so connecting later never restarts the machine. The card costs no boot time (Debian to
  login, alternating runs, this container: 81.3 s median without it, 79.7 s with it, 3 runs each,
  noise), and the client isn't loaded until Connect. A systemd credential
  (`network.network.card`, over fw_cfg since phase B loop 3; on the command line before) gives
  networkd a `.network` file (Debian's own units are all enabled under UEFI), so the guest asks the gateway for DHCP by itself; the gateway offers nothing
  until a client has an address (the tailnet address, MagicDNS through systemd-resolved). Not
  `ip=dhcp`: Debian's initramfs reads it too and waits for a lease before booting (found by the
  page test: the boot sat at the root mount for minutes). **A lease that arrives after the boot is
  taken in ~20 s** by networkd's DHCP retries (`tests/net-guest.test.ts`, measured 19 s after the
  lease); nothing on the page speeds it up (a link flap would, but the device's link is always
  up). The machine worker gets `ip`, the gateway's end of an IP port, and adds
  `{type: 'net', adapter: {ip}}` (docs/devices.md "net"); the page keeps the other end
  (web/app/network.ts) for as long as no client holds it.
- **Connect** takes a control server (empty: Tailscale's; a Headscale's `https://` URL, or
  `http://` for this computer), a hostname (default `webpc`) and an optional auth key.
- **Login:** without an auth key the client asks the control server for a login and the menu opens
  with a **Log in…** link (a new tab; only `http(s)` URLs are ever offered); the client comes up
  when the login completes. An admin-approval wait is shown as such. With an auth key there's no
  login; the key is never saved and its node is ephemeral (the control server drops it once it's
  been away).
- **The node is kept:** a login's node (its keys, a secret) lives in this origin's IndexedDB
  (`webpc-tailscale`, one profile per control server), so a reload is the same node with the same
  address and no new login: **Connect on load is automatic** (`autoconnect`) until Disconnect. An
  auth key's node isn't kept: the menu says to enter it again.
- **Disconnect** withdraws the lease and stops the client (the guest keeps its address until the
  lease runs out; the card stays); **Log out** removes the node from the tailnet and deletes its
  keys. A machine restart (Restart, a guest
  reboot, Reset disk) hands the new machine's port to the running client (`attach`): it stays
  connected.
- **Exit node:** when the tailnet has peers that advertise one (and an admin approved their
  `0.0.0.0/0` routes) the menu shows **Internet through** with them and "Nothing: directly". Picking one
  calls the client's `setExitNode(id)` (`ipn.Prefs.ExitNodeID` through `lb.EditPrefs`; the id is the
  peer's stable ID, `netmap.peers[].id`), the netmap reports the one in use (`netmap.exitNode`) and the
  status line says "internet through <name>". The choice is remembered (`exitNode`) and given to the
  client at the next Connect (`Start`'s prefs would otherwise reset it). The guest's address, router and
  DHCP lease don't change: its default route is the gateway, which hands every packet to the client,
  and the client's routing decides between the tailnet and the exit node. **DNS follows the exit
  node**: MagicDNS (100.100.100.100, which the lease gives first) asks the exit node's DoH service
  (its peerapi) for names it doesn't know, and the tailnet's own nameservers are reached through
  the exit node. That needed three things in the Go client, each found by the test: the client's
  prefs start from `ipn.NewPrefs()` (a bare `Prefs` has `CorpDNS` off, so the tailnet's DNS
  settings were ignored), the `peerapiclient` feature is built in (without it the DoH request is
  refused), and the client's own connections are dialed in its netstack
  (`dialer.NetstackDialTCP/UDP`, a browser has no OS network) with
  `CheckLocalTransportEndpoints`, so the replies to them, addressed to the node's IP, which is the
  guest's too, go to the netstack and everything else to the guest.
- Settings (`webpc.settings` `net`): `controlURL`, `hostname`, `autoconnect`,
  `keyed`, `exitNode`. The state dot: grey off, amber connecting or waiting for the user, green connected, red
  an error (the client's, e.g. the control server didn't answer).
- **The client is built by the servers:** `npm run serve` and `npm start` run `tools/tailscale.ts` first: it builds `net/tailscale` with `net/tailscale/build.sh` into `target/net/tailscale.wasm` (and `wasm_exec.js`) when they're missing or a hash of `net/tailscale`'s files (stamp `tailscale.wasm.inputs`) changed, ~30 s to ~1 min the first time (Go downloads its toolchain and modules). It never stops the server: without Go, or if the build fails, it says so and the page runs; Connect then says the client isn't built (checked before the machine restarts). `WEBPC_TAILSCALE=0` skips it. `scripts/ci-net.sh` runs it as a step so the Network menu's and the tailnet's tests find the client.
- **The control server must answer `GET /key` with CORS headers** (docs/plans/networking.md N4):
  Tailscale's does; a Headscale needs its reverse proxy to add `Access-Control-Allow-Origin`.
- Tests: tests/network.test.ts (the controller and its parsers with a fake client),
  tests/net-guest.test.ts (Debian with the card on the echo backend: it configures itself and
  pings, and takes a lease that arrives after the boot; no tailnet), tests/net-tailnet.test.ts (the same guest on a headscale tailnet, opt-in; its peer is an exit node: the guest reaches a server on the host only through it, and its DNS is answered by the exit node's resolver).
  Not tested: the menu's DOM and a real interactive login (they need a control server that serves
  one; the docs/backlog.md "Network" entry says what's missing).

## The end-to-end test

`tests/page-debian.test.ts` (M8 loop 6; in `npm test` when `WEBPC_DISTROS` has debian, as
`scripts/ci.sh` sets it when the image is current) does on the page what a user does, in a fresh
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
5. **Debian** (`tools/debian.ts`, below): skipped when `target/images/debian/.prepared` names the
   pinned image and the disk exists (the page boots it unmodified: no kernel or initrd is taken
   out, and an older pair is deleted).
5b. **The UEFI firmware** (`images/build.sh edk2`: EDK2 in a rootless Podman container, ~1 min the
   first time, which also pulls the build image and clones EDK2; the user's answer "for now"):
   skipped when `images/build.sh --check edk2` says it's current. Without Podman the start
   stops *before* the long steps, saying how to install it. `tests/start.test.ts` covers the
   message and (with `WEBPC_START_COLD=1`) the build in the copy.
6. **The server** (`tools/serve.ts`) on `127.0.0.1:8080` (`PORT` or `--port`; `--host` for
   another interface, with a warning that a remote browser over plain HTTP gets no cross-origin
   isolation, so forwarding the port is the way), then the URL and the `ssh -L` line. A port in
   use stops it with a message rather than moving to another port: **OPFS is per origin, so the
   saved disk belongs to the port** (another port boots a fresh disk). `--prepare-only` does
   steps 1–5b and exits.

What stops it is said in one message with what to do, and it exits 1. Time on the dev VM (M8 loop
5, bench/boot/REPORT.md): nothing to do, ~0.1 s to the URL (0.2 s through npm); a fresh clone
with the download cached, 1.2 s plus the core's build (10–11 s cold; the toolchain's install,
722 MB, 6 s on this network); the download itself, 7.8 s.

**Debian's preparation** (`tools/debian.ts`; `npm start` links the disk only, `images/build.sh
debian` also extracts the kernel and initrd for the tests and benchmarks' direct boots; the pin is
`images/debian.json`): the qcow2 from the download cache (`WEBPC_DL`, default
`target/images/dl`), or downloaded there with progress (a line rewritten on a terminal, every 10%
otherwise) through a `.part` file, and checked against the pinned SHA512 either way (~1 s); with
`images/build.sh debian`, then the kernel and initrd out of its `/boot` with `web/bootfs.ts` and `web/ext4.ts` over
`web/qcow2.ts` (~0.4 s: 74 MB read through ~1,200 compressed clusters), the kernel checked for the
arm64 Image magic, and the disk hard-linked from the cache (a copy, reflinked where it can be, if
the cache is on another filesystem). The outputs are byte for byte what `images/SHA256SUMS`
lists (`images/build.sh debian` checks it).

## The disk reader

`web/bootfs.ts` and `web/ext4.ts`: no Node APIs, all I/O through `read(off, len)` (a qcow2
`Disk`'s), so the page can later read `/boot` at start time instead of a preparation step
([backlog.md](backlog.md) "Booting conventional arm64 disk images unmodified").

- **Partitions:** GPT (512-byte sectors; the protective MBR's `0xEE` entry leads to it) or MBR
  primaries; a disk with neither is a bare filesystem. `findBootFiles` takes the first partition
  with an ext2/3/4 filesystem whose `/boot` has `vmlinuz-<version>` (the highest version when
  there are several), and `initrd.img-<version>`. Debian's nocloud image: partition 1 is the
  root (partition 15 is the ESP, first on the disk).
- **ext2/3/4, read-only:** superblock, group descriptors (32- and 64-bit, `meta_bg`), inodes,
  extent trees of any depth (uninitialized extents and holes read as zeros), ext2/3 block maps
  (to triple indirect), directories read linearly (htree index blocks look like empty entries;
  checksum tails have inode 0), fast and slow symlinks (followed, 40 at most). Ignored: checksums,
  the journal (read as on disk). Refused: compression, a journal device, dirdata (at open), inline
  data and encrypted files (when read).
- **Tests** (`tests/ext4.test.ts`): `tests/ext4/make.sh` builds one tree (deterministic content,
  its `manifest.json`) into an ext4 on GPT (1 KiB blocks, 32 groups in 2 meta groups, 64-bit,
  metadata_csum, a 400-extent file with a depth-2 tree, a 300-entry htree directory) and an ext2
  on MBR (block maps to double indirect), both as compressed qcow2 (~360 KB each), with the
  host's e2fsprogs, sfdisk and qemu-img (fixtures made once, like `tests/qcow2/make.sh`); the test
  reads every file, link and directory against the manifest. The real image is checked by
  `images/build.sh debian` against `images/SHA256SUMS`.
