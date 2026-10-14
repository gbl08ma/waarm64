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
| `web/app/index.html`'s Save snapshot and Load snapshot…, `main.ts`'s `saveSnapshot` and `loadSnapshot`, `worker.ts`'s `saveSnapshot` and its start from a snapshot | snapshots on the page (below, "Snapshots") |
| `web/app/machine.ts` | the machines, in one place: image URLs (the firmware, for UEFI machines), command line, the credentials a card adds, RAM, screen size, the `ready` marker, the default vCPU count |
| `web/audio.ts`, `web/audio-worklet.ts`, `web/audio-ring.ts` | the page's sound: the AudioContext, the worklet that plays the device worker's sound ring, the volume (below, "Sound") |
| `web/app/network.ts` | the Network menu's logic, DOM-free: settings parsers, the view of the client's state, the machine's IP port across restarts and disconnects (below, "Network") |
| `tools/start.js`, `tools/start.ts` | `npm start` (below) |
| `tools/tailscale.ts` | builds the Tailscale client when missing or stale, for `npm run serve`, `npm start` and `scripts/ci-net.sh` ("Network") |
| `tools/debian.ts` | Debian's download and preparation, for `npm start` and `images/build.sh debian` |
| `web/bootfs.ts`, `web/ext4.ts` | partition tables, a read-only ext2/3/4 reader, a distribution's kernel and initrd (below, "The disk reader") |

Query parameters (development and tests; no settings UI yet): `?machine=debian|buildroot|snd` (the
default is `debian`), `?ncpus=N`, `?ram=MiB` (both over the Machine menu's choice), `?view=screen|terminal|both` (over the remembered view),
`?params=…` (extra kernel parameters for a direct-boot machine, placed before a `--`: e.g.
`init=/nonexistent` to make Buildroot panic, as a test does; Debian's bootloader owns its command
line: edit it in GRUB), `?credential=name:value` (repeatable: a systemd credential over fw_cfg for a
firmware machine; tests pass `tests/debian-unattended.ts`'s to boot Debian unattended, the page
passes none), `?disk2=<url>` (a second,
read-only virtio-blk over HTTP ranges, `/dev/vdb` in the guest, no overlay; for tests: the stress
test's `--disk2` gives it the Go toolchain image, docs/images.md "Stress workloads"), `?snd=stats[,timer]`
(the sound device's completion timing once a second in `window.__audio.stats`, and the timer instead of the
worklet's notify; any `?snd=` also exposes `window.__audio`, the serial log and the status, for tests and
`bench/audio/snd-page.ts`).

## The machines

- **`debian`**, the page's VM (M8 decision 1): Debian's published nocloud qcow2, **unmodified,
  booted through UEFI** (M8 phase B: EDK2's `QEMU_EFI.fd` as the machine's `firmware`, then shim
  and GRUB from the disk: docs/plans/uefi.md; below, "Debian through UEFI"), under the JIT,
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
  where the questions are ("Show it" opens the serial view). Tests pass them over fw_cfg
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
- `phase {text}`: what a machine `loading` from a snapshot is doing (it has no download to report).
- `snapshot-progress {phase, fraction}`, `snapshot-chunk {data}` (transferred; without a handle),
  `snapshot-done {bytes, pausedMs}` (the file is complete; the ms from the pause request to the
  resume) and `snapshot-error {message}` (the machine runs on).
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
| `snapshot` | a snapshot was refused (`SnapshotError`: another machine, another disk, damaged or truncated, devices this page can't make; below, "Snapshots") | Start, Load snapshot… |
| `emulator` | anything else (an exception, an unimplemented exit) | the same three |

Retry and Restart start a new machine worker. The failed states (`failed`) make the header's
button read Retry. **The serial log** is kept by the page (the last 1–2 MB of the serial console's
output, beyond xterm.js's 5,000 lines of scrollback) for Copy (the clipboard) and Save (a
`webpc-<machine>-serial-<time>.log` download); Show serial log switches the Screen view to Both.

## Snapshots

The running machine, RAM and the disk's changes and all, in a file; and back (the format and the
machinery: [platform.md](platform.md) "Snapshots", [plans/snapshots.md](plans/snapshots.md)).

**Save snapshot** (the header, enabled while the state is `running` or `booting`): the picker first
(`showSaveFilePicker`, which needs the click's user activation; suggested name
`<machine>-<yyyy-mm-dd-hhmm>.webpcsnap`), else a Blob download, as Save disk does. No confirmation:
the machine isn't stopped. The worker pauses it (`vm.pause()`), writes the file with
`writeSnapshot` and resumes, also on an error. The state line shows the phase and a fraction
("Writing the snapshot 40%"); afterwards a note under the header says the file, its size and how
long the machine was paused (the numbers are also in `#message`'s `data-snapshot`, JSON, for
tools), and the machine runs as before. Only the writing is between pause and resume: the picked
file's stream is opened before and closed (flushed) after, and nothing is hashed. One save at a
time: while it runs Restart, Reset disk and Save snapshot are disabled, and Save disk, Open disk,
Load changes and Load snapshot say to wait. The run loop is not disturbed by the pause
(`runAsync` keeps returning `BUDGET`), the status timer and the flash keeper only read.

**Load snapshot…** (a button with a file input), and a snapshot file chosen with Open disk… or
dropped on the page, told from a disk image by its first 8 bytes (`WEBPCSNP`). The page reads the
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
(with `phase` messages: "Checking the snapshot", "Restoring the machine"; there is no byte
progress) straight to `running`: the machine is where it was, there is no marker to wait for. The
saved serial tail is written to the terminal first (`serial` with `replay`: xterm.js answers a
cursor-position query in it while parsing, and the page doesn't send those answers to the guest, which
isn't asking now: bash printed them as `;1R;80R`).

**The header's fields** (beside `web/snapshot-file.ts`'s own: `format`, `coreVersion`, `abi`,
`created`, `ramSize`, `disks`):

| Field | What |
|---|---|
| `machine` | the `MachineName` (`debian`, `buildroot`) |
| `label` | the machine's label, for messages |
| `ncpus` | vCPUs the machine ran with |
| `disk` | the display name of the disk it was on when that was a chosen disk (file name, or a URL's last segment); `null` for the machine's own |
| `devices` | the device kinds in slot order: `rng`, `blk`, `blk-ro` (the `?disk2=` disk), `keyboard`, `tablet`, `net`; a restore makes the same list, and refuses (naming what to open the page with) one it can't: a `blk-ro` without `?disk2=`, a `net` without the machine's IP port |
| `cpu` | the vCPUs' optional features, of `rng` and `e0pd` (docs/cpu.md); a restore gives the machine the same, and a snapshot without the field (before ABI 35) none |
| `serial` | the last ~4 KiB of serial output the worker posted, cut at a line start |

**Errors.** `SnapshotError` (`web/snapshot-file.ts`) becomes the `snapshot` problem, whose actions are
Start (a normal boot) and Load snapshot… again. The message says what was refused and, from
`readSnapshot`, that nothing was touched ("the machine isn't running and its disk is as it was");
past that point (`bootVm` has the file) it says the disk may hold part of the snapshot's changes
and offers Reset disk.

**Suspend** (the header, for a machine with an overlay; enabled while `running` or `booting`): the
machine stops and its memory stays in this browser; opening the page again, or Start, resumes it
where it was. Nothing is asked: nothing is lost. The worker pauses the VM, writes its snapshot
**without the disk's blocks** (`writeSnapshot`'s `suspend`: they are in the overlay already) to
the file `suspend` in the overlay's OPFS directory (`suspendWriter` in web/overlay.ts), closes the
VM without another step, and posts the state `suspended` (its message says the size; the actions
are Start and Boot instead). A failure before that leaves the machine running.
- **A start resumes.** The worker looks for a suspended machine beside the disk before it
  downloads a kernel (`suspended`), and starts from it as from a snapshot file, except that the
  overlay is kept (`readSnapshot`'s `resume`): `loading` ("Resuming the suspended machine"), then
  `running` with the note "Resumed the suspended machine." If it can't be resumed (another core
  version, a damaged file), it is dropped and the machine boots, with a note saying so.
- **What keeps it safe is an invariant, not a check:** the suspended copy exists only while no
  machine has written the disk since. The worker drops it (`dropSuspend`) before any machine runs
  on the overlay: right after a resume's `bootVm`, before the first step; and before a boot the
  page asked for (`start.resume` false: Boot instead, which confirms that the suspended memory is
  lost). Reset disk, Load changes and Load snapshot delete it with the overlay (`removeOverlay`).
  A copy that outlived a write to its disk would resume a guest whose page cache and filesystem
  state no longer match the disk; a generation counter compared at resume was the plan's first
  idea, and needs every writer to bump it, which is the same discipline with one more file.
- A suspended machine's file is not a snapshot to take elsewhere (it has no disk): `readSnapshot`
  refuses it without `resume`, and Save snapshot is what leaves the browser.
- With a disk of one's own (Open disk…), the suspended copy is beside that disk's overlay: it
  resumes when that disk is opened again (the page doesn't remember a chosen file over a reload).

**Limits.** No hash of the base image is written (nothing computes or caches it off the save path
yet), so `readSnapshot` requires the same disk identity: the machine's own disk, or the same file
(name, size, modification time) or URL. The network across a snapshot isn't handled: the guest
keeps its DHCP lease and its connections are gone with the Tailscale client's. The guest's clock
lags by the time the file sat around until something sets it (the RTC is current). A snapshot is
for the core version that made it.

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
(the GOP is a console beside the serial port: docs/plans/uefi.md "Graphics in the firmware"), GRUB's menu
and "Loading Linux…" appear on the screen, then the console (fbcon on `virtio_gpu`, which loads from the
root filesystem a few seconds into the boot) takes it. **The device worker draws it**: the page's canvas
goes machine worker → device worker, whose backend puts each flush's damaged rectangle on it
(`web/gpu-present.ts`: an `ImageData` over the guest's resource, no copy and no scan of guest memory,
accumulated rectangles, drawn at once if the last draw was a frame ago and otherwise on a 16 ms timer: Chromium
gives a device worker no animation frames, "requestAnimationFrame not supported in this Worker").
The page's main thread still has no per-frame work. The canvas takes the scanout's size, and the page
refits its box when the display port says `mode` (the boot card hides at the first one). **Keys for the
firmware's menus still go through the serial terminal** (EDK2 has no virtio-input driver), which is why GRUB's
menu is on the screen only; `?display=simple` gives a gpu machine the simple framebuffer instead (the firmware
then keeps its serial menus: `tests/page-disk.test.ts` uses it).
Flush-to-draw latency (`bench/gpu/draw-latency.ts`, Debian, tty1 changing every 30 ms): median 16–17 ms idle
(the timer, for a flush within a frame of the last draw), and with the guest reading its disk (virtio-blk's
synchronous XHRs block the device worker, and a flush is only served between them) a median of 17 to 66 ms and
a worst case of 89 to 972 ms over two runs (`bench/gpu/results/draw-latency-*.json`): the drawing thread isn't
the cause, the device worker's serving is, so moving the draw elsewhere wouldn't help; blk would have to leave that
thread (asynchronous reads: backlog).

**A desktop on the screen:** a compositor's frames arrive as full-screen transfers at its own rate (a guest kernel
from 6.19 paces itself at 60 Hz; for older ones the device answers one flush per frame, docs/devices.md), and the page
draws at most one per frame. **sway should run with `WLR_RENDERER=pixman`** (other wlroots compositors likely too):
left alone on a display without 3D, Arch's picked Mesa's llvmpipe, which under the JIT costs about ten times the CPU
and draws on its own threads after the page flip, so the screen shows frames late and in pieces (graphics.md §16).
On a 3D machine (below) it should run with `WLR_RENDERER=gles2` instead: Mesa's virgl driver, drawn by the host.

**A 3D machine** (graphics.md §20) gives a virtio-gpu machine virgl, rendered on the host by WebGL2: the default
wherever the browser has WebGL2 (since G3). The Machine menu's **Graphics** (3D or 2D, kept in the browser's
settings, applied by a restart) turns it off; the query is over the menu: `?gpu=2d` keeps the 2D path above,
`?gpu=virgl-null` G2's null renderer, `?gpu=virgl` 3D (the menu's choice is then greyed out, as it is without WebGL2).
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
the same as with no renderer at all (graphics.md §20 loop 4). Snapshots of a 3D machine: docs/devices.md "virgl".

The simple-framebuffer's canvas keeps the framebuffer's size; CSS scales it to an integer multiple **in device pixels**
when one fits the view (`image-rendering: pixelated`: crisp at any `devicePixelRatio`), and
scales it down smoothly when it doesn't fit at 1:1. A `ResizeObserver` and a `resolution` media
query refit it.

**The guest's size follows the page** on a virtio-gpu machine (Debian's page). The page measures the
screen's box (`wantedSize` in `main.ts`): CSS pixels by default, device pixels with the Screen menu's
**HiDPI** setting; the width is rounded down to a multiple of 8 (the guest's CVT modes are, and a
sliver would show), at least 640×480, at most 4088 (what the EDID's detailed timing can say). The
Screen menu's **Size** picks a fixed size instead (1024×768, 1280×800, 1920×1080); both settings are
remembered per browser. The start message carries the size (`start.size`: the console and the
firmware are born at it, no event), and later changes go to the display port as `size`, debounced
300 ms (a window drag is a stream), once more when the machine is `running` (a restored one starts at
the size it was saved with). The canvas shows the scanout 1:1 in guest pixels, so with HiDPI off on a
screen of fractional density (1.25, 1.5) it is one guest pixel per CSS pixel and a little soft; an
integer density is crisp. A guest that doesn't take the size is letterboxed (the box centres the canvas).
**What the guest does with a new size** is measured in graphics.md §13 and §17: fbcon can't grow its
buffer, so the console stays at its born size (a bigger window shows it letterboxed), and a smaller window is
never allowed to crop it (devices.md "Display size and events"); sway keeps the size it started with
(wlroots seems to read an output's modes when it connects, not at a display event); GNOME and KDE are expected to
follow and weren't measured. So today a new size mostly takes effect when the guest's display software
starts; following live is the agent's job ([plans/agent.md](plans/agent.md)).
`tests/page-debian.test.ts` covers it on Debian.

**The guest's cursor** (virtio-gpu machines) is the canvas's CSS cursor: the presenter sends the 64×64 image and its hotspot when
they change (not on moves: the tablet is absolute, the host's pointer is the guest's), and the page draws it at the canvas's scale into
a blob (`image-set(url(…) <dpr>x) hotX hotY, none`; at most 128×128 device pixels), again whenever the scale changes. A cursor the guest
never set leaves the page's own pointer; one it hid is `none`. docs/plans/graphics.md §14.

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
  reads **Sound: click to hear** (with an accent border).
- **The Sound menu:** Sound on (unchecked: muted, the gain at 0; the guest still plays in real time), Volume
  (0-100%), Microphone and Raw microphone (below). Both apply live and are kept in this browser (`muted`, `volume` in `webpc.settings`); the summary reads
  "Sound (muted)" when off. Not in the Machine menu, whose choices apply by a restart.
- **The microphone** (audio S4: [audio.md](audio.md) "Decisions"): each start also makes a **microphone ring**. When the guest
  starts recording, the device says so on the port with the stream's rate; unless **Microphone** is unchecked, the page
  asks for the microphone (`getUserMedia`: the browser's prompt the first time) with the browser's echo cancellation,
  noise suppression and gain control, or none with **Raw microphone** (for music), makes a context at the stream's rate
  with a `MediaStreamAudioSourceNode` into the `webpc-mic` worklet, which writes the ring, and the summary reads
  "Sound · mic". When recording stops the microphone and its context are closed (the browser's indicator goes off). Off,
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

The dev server serves exactly two files from `node_modules`, `@xterm/xterm/lib/xterm.mjs` and
`@xterm/xterm/css/xterm.css` (`tools/serve.ts` `ALLOWED`); everything else there is refused.

## Views, settings and the disk

Screen (the default, decision 2), Serial terminal, or Both (side by side; stacked below 1100 px).
The view chosen last is remembered per browser (`localStorage` `webpc.settings`, JSON; read and
written in try/catch, so a browser that refuses storage just doesn't remember); `?view=` overrides
it without being saved. The **Machine** menu sets the vCPU count (1, 2, 3, 4, 6, 8) and the RAM
(512 MiB to 2.5 GiB: the wasm memory is the RAM plus the 1 GiB heap reserve and must fit 4 GiB) and
applies them with a confirmed restart; both are remembered per browser too (`ncpus`, `ramMiB`),
with `?ncpus=` and `?ram=` over them. Defaults: `min(4, cores − 2)` vCPUs and the machine's RAM
(1 GiB). The page's memory check (`hostMemoryGiB`) warns in the confirmation when the device
reports less than the choice needs. A suspended machine resumes with its own size.

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
  (always, on this machine); the unmasked networkd and resolved do the rest.

## Your own disk

A `firmware` machine (Debian) boots a disk of the user's own (M8 phase B loop 4): the header's
**Open disk…** (a file picker), a file dropped on the page, or `?disk=<url>` (served with HTTP
range support, like the machine's own). The machine restarts on it (confirmed if it runs); raw or
qcow2 is told by the file's magic (a qcow2 with a backing file is a changes file: it is loaded, below, not booted).
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
- **Saving the disk** (loop 5): the header's **Save disk** menu (machines with an overlay): *Changes
  only*, a qcow2 holding the blocks the machine wrote with the image as its backing file;
  *Whole disk* as qcow2 (zero clusters left out) or raw; the qcow2s are compressed unless the
  menu's **Compress the qcow2** is unticked (remembered in the page's settings). The file goes where the user picks
  (`showSaveFilePicker`, called first: it needs the click's activation; a worker streams into the
  handle's writable) or, without a picker, is downloaded (the worker posts 1 MiB chunks, the page
  collects a Blob). **The machine stops while it's written** (confirmed; the overlay's OPFS handles
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
- **Loading changes** (loop 6): the header's **Load changes…** (or a changes file chosen with Open
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
  taken in ~20 s** by networkd's DHCP retries (`tests/net-guest.test.ts`, measured 19 to 27 s after the
  lease); nothing on the page speeds it up (a link flap would, but the device's link is always
  up). **IPv6 doesn't wait:** the gateway advertises itself the moment the lease has an IPv6 address,
  and the guest has its DHCPv6 address ~2 s later. The guest is dual-stack: the tailnet's `fd7a:` address
  as a /128, the default route from the advertisement. MagicDNS answers AAAA for peers only when the
  control server sends the `magicdns-aaaa` node attribute (headscale doesn't by default; Tailscale's
  admin console has the setting): reach peers' IPv6 addresses by address, or turn it on. The machine worker gets `ip`, the gateway's end of an IP port, and adds
  `{type: 'net', adapter: {ip}}` (docs/devices.md "net"); the page keeps the other end
  (web/app/network.ts) for as long as no client holds it.
- **Connect** takes a control server (empty: Tailscale's; a Headscale's `https://` URL, or
  `http://` for this computer), a hostname (default `webpc`) and an optional auth key (a password field with a "Show the auth key" checkbox).
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

**Debian's preparation** (`tools/debian.ts`, run by `npm start` and `images/build.sh debian`: it links
the disk and takes nothing out of it; the pin is `images/debian.json`): the qcow2 from the download cache (`WEBPC_DL`, default
`target/images/dl`), or downloaded there with progress (a line rewritten on a terminal, every 10%
otherwise) through a `.part` file, and checked against the pinned SHA512 either way (~1 s); the
disk is hard-linked from the cache (a copy, reflinked where it can be, if the cache is on another
filesystem). The output is byte for byte what `images/SHA256SUMS` lists (`images/build.sh debian`
checks it). The kernel and initrd aren't extracted any more (the direct boot was dropped); the
disk reader below (`web/bootfs.ts`, `web/ext4.ts`) has no consumer but its tests.

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
