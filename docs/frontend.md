# The page

The interactive machine (M8 phase A): one VM per page, its screen on a canvas and its serial
console on xterm.js. `npm run serve` serves it at `http://127.0.0.1:8080/web/app/` (`/`
redirects there). Chromium only.

## Files

| File | What |
|---|---|
| `web/app/index.html` | the page: header (machine, power state, views, Restart), the screen, the terminal, the status line; styles inline; an import map for `@xterm/xterm` |
| `web/app/main.ts` | DOM code only: views, the canvas's scaling, xterm.js, power state, the status line; starts and stops machine workers |
| `web/app/worker.ts` | the machine worker: boots a machine with `bootVm` and drives it with `runAsync` |
| `web/app/protocol.ts` | the messages between the two (types only) |
| `web/app/machine.ts` | the machines, in one place: image URLs, command line, RAM, screen size, the `ready` marker, the default vCPU count |

Query parameters (development and tests; no settings UI yet): `?machine=debian|buildroot` (the
default is `debian`), `?ncpus=N`, `?view=screen|terminal|both`.

## The machines

- **`debian`**, the page's VM (M8 decision 1): the Debian 13 nocloud image, under the JIT,
  realtime, a worker per vCPU; 1 GiB; a 1024×768 framebuffer; rng, the disk (virtio-blk over HTTP
  ranges, writable through the OPFS overlay `webpc-debian`), keyboard, tablet. No virtio-console
  (it would only add an output-only `hvc0` getty) and no network (decision 8). Its command line is
  [images.md](images.md) "Debian for interaction". vCPUs: `min(4, cores − 2)` (the page and the
  device worker keep a core each). `ready` is the serial console's `login: ` prompt, ~30 s after
  the page loads (bench/boot/REPORT.md "M8 loop 0"). **Root logs in without a password:** the
  published image locks root (`root:!unprovisioned`) and has no other user; the credential
  `login.noauth` on the command line lets `login` accept root on every console without touching
  the image (the user accepted this; no other user is needed).
- **`buildroot`**, the test guest: `-- /bin/sh` on the serial console, 256 MiB, a 640×480
  framebuffer that stays black (its kernel has no fbcon), the overlay `webpc-buildroot` (mounted
  read-only; it's there so restarts hand an overlay over). Up in under a second.

URLs are relative to `machine.ts`, so nothing but the location of `target/` ties the page to the
dev server (decision 7).

## The worker protocol

The seed of phase D's embedding API; not frozen. One machine per worker: a restart stops the
worker and starts a new one (fresh memory, fresh ports).

Page → worker:
- `start {machine, ncpus, keyboard, tablet, serial, screen}`: three transferred `MessagePort`s
  and a transferred `OffscreenCanvas`. The keyboard's and the tablet's ports go to the device
  worker (web/input.ts's `attachInput` sends Linux input events to the other ends; LED changes
  come back on the keyboard's). `serial` is `BootOptions.serialIn`: strings or bytes for the
  PL011, handled on the machine worker's thread while `runAsync` awaits. `screen` is the page's
  canvas (`transferControlToOffscreen`, sized as the machine's framebuffer): the machine worker
  draws the framebuffer on it (web/display.ts) on its own animation frames.
- `stop`: stop the vCPUs and release the backends (the overlay's OPFS handles); answered by
  `stopped`. The page then terminates the worker (after 3 s without an answer, anyway).

Worker → page:
- `state {state, message?}`: `loading` (fetching the wasm, kernel, initrd), `booting` (the VM
  runs), `running` (the machine's `ready` marker appeared on the serial console), `off` (PSCI
  SYSTEM_OFF), `rebooting` (PSCI SYSTEM_RESET: the page starts a new machine), `crashed` (an
  emulator error, an unimplemented exit, or the guest's `Kernel panic - not syncing` line, with
  the message).
- `serial {data}`: the serial console's output, UTF-8 decoded. The worker drains the TX ring
  after every `runAsync`, which returns as soon as there's new output (the core notifies the TX
  ring's head, docs/abi.md "Signal word and console").
- `status {status}`: once a second: vCPUs, RAM, uptime, steps, JIT blocks and compile time,
  IRQs. The page shows MIPS and IRQ/s from the differences.
- `stopped`.

The machine runs without `idleLimitMs`: an idle guest may sleep as long as it likes.

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
- **Keys the browser keeps:** the Keys menu sends Ctrl+Alt+Del, Ctrl+Alt+F1 and Ctrl+Alt+F2 to the
  screen's keyboard (`Input.chord`: pressed in order, released in reverse). On Debian, Ctrl+Alt+Del
  reboots (systemd's `ctrl-alt-del.target`; the page then starts a new machine), and Ctrl+Alt+F2
  switches to tty2, where logind starts a getty on demand (autovt).
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

xterm.js 6 (`@xterm/xterm`, MIT; the only runtime dependency), 80×24: the PL011 has no size
negotiation, so the guest assumes 80×24 unless `stty` says otherwise. `onData` sends what a
terminal would (`\r` for Enter, escape sequences) to the `serial` port. No addons. The dev server
serves exactly two files from `node_modules`, `@xterm/xterm/lib/xterm.mjs` and
`@xterm/xterm/css/xterm.css` (`tools/serve.ts` `ALLOWED`); everything else there is refused.

## Views and state

Screen (the default, decision 2), Serial terminal, or Both (side by side; stacked below 1100 px).
Restart asks for a confirmation while the machine is booting or running (it's a power cut); after
a power off the button reads Start. The disk overlay persists across reloads and restarts; OPFS
belongs to the browser profile, so Playwright's temporary profiles start empty and tests don't see
each other's disks.

## Overlay hand-over

A new machine opens the overlay the old one had open; OPFS sync access handles are exclusive. The
old one's device worker releases them on `close` and answers `closed` (`vm.close()` resolves then,
or after a second), before the page terminates its worker. Tried and not needed (loop 2): a retry
in `openOverlay` while another context holds the handles. With it planted out, 6 reloads of a
running page and every restart in the smoke test still opened the overlay: a new machine fetches
the wasm and the kernel first, and the old worker tree is gone by then.
