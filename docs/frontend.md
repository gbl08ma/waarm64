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
- `start {machine, ncpus, keyboard, tablet, serial}`: three transferred `MessagePort`s. The
  keyboard's and the tablet's go to the device worker (web/input.ts's `attachInput` sends Linux
  input events to the other ends; LED changes come back on the keyboard's). `serial` is
  `BootOptions.serialIn`: strings or bytes for the PL011, handled on the machine worker's thread
  while `runAsync` awaits.
- `stop`: stop the vCPUs and release the backends (the overlay's OPFS handles); answered by
  `stopped`. The page then terminates the worker (after 3 s without an answer, anyway).

Worker → page:
- `state {state, message?}`: `loading` (fetching the wasm, kernel, initrd), `booting` (the VM
  runs), `running` (the machine's `ready` marker appeared on the serial console), `off` (PSCI
  SYSTEM_OFF), `rebooting` (PSCI SYSTEM_RESET: the page starts a new machine), `crashed` (an
  emulator error, an unimplemented exit, or the guest's `Kernel panic - not syncing` line, with
  the message).
- `screen {memory, framebuffer}`: the shared memory and where the framebuffer is in it, once
  before the VM runs; web/display.ts draws it on every animation frame.
- `serial {data}`: the serial console's output, UTF-8 decoded. The worker drains the TX ring
  after every `runAsync`, which returns within 10 ms of new output.
- `status {status}`: once a second: vCPUs, RAM, uptime, steps, JIT blocks and compile time,
  IRQs. The page shows MIPS and IRQ/s from the differences.
- `stopped`.

The machine runs without `idleLimitMs`: an idle guest may sleep as long as it likes.

## The screen

`display.ts` copies the whole framebuffer into an `ImageData` on each animation frame. The canvas
keeps the framebuffer's size; CSS scales it to an integer multiple **in device pixels** when one
fits the view (`image-rendering: pixelated`: crisp at any `devicePixelRatio`), and scales it down
smoothly when it doesn't fit at 1:1. A `ResizeObserver` and a `resolution` media query refit it.
Input: `attachInput` on the canvas (it takes the focus on a click; tabindex 0). The tablet's
coordinates are relative to the canvas's scaled box, so they follow the scaling.

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
