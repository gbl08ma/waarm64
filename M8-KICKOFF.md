**Drafted 2026-09-28, after M7's exit; decisions confirmed by the user the same day** (section
"Decisions", below). Covers **phase A** of M8. Phases B–D get their own kickoffs. Ready to start at
loop 0.

Start milestone **M8** of webpc, phase A: **the interactive machine**. After seven milestones
nobody has typed a command into this emulator: every guest ran headless under a test that fed it a
script and read its console. Phase A ends when I can run one command on a fresh clone, open the
URL it prints, and use a Debian VM in Chromium with keyboard and mouse, seeing its screen live
(as in v86's demos). Read PLAN.md §3 "M8" and §4, then `docs/devices.md` (input, framebuffer,
overlay, the device worker), `docs/platform.md` (run loop, realtime mode, parallel SMP),
`docs/abi.md` ("Signal word and console"), `docs/images.md` (the Debian image), `docs/testing.md`
and `tools/serve.ts`, `web/vm.ts`, `web/display.ts`, `web/input.ts`, `tests/browser/boot.html`.
CLAUDE.md's conventions and working rules apply; `scripts/ci.sh` must pass at every commit. Work
as in M5–M7: short loops (one slice, one commit, a short report each), and continue unless
something needs my decision.

## What exists (2026-09-28)

- **No host-to-guest console path.** The core has a PL011 RX ring (`vm_console`: TX and RX, 4 KiB
  SPSC rings; `SIGNAL_RX` in the signal word; RX/RT interrupts follow the ring), but `web/vm.ts`
  never fills it, and virtio-console holds its receive buffers without ever completing them
  (backlog, "Platform and devices"). This is the first gap.
- **Display and input exist as test glue:** `web/display.ts` copies the whole `simple-framebuffer`
  (x8r8g8b8, fixed size) into an `ImageData` on every animation frame; `web/input.ts` maps DOM
  keyboard, pointer and wheel events to virtio-input (US PC layout, keys by
  `KeyboardEvent.code`, the tablet over 0–32767). The only page using them is
  `tests/browser/boot.html` (Buildroot, scripted input).
- **Debian 13** (`target/images/debian`: the official nocloud qcow2, 95% compressed clusters,
  served as is; the kernel 6.12.107 and initrd taken out of its `/boot` by `images/build.sh
  debian` with `qemu-img`, `sfdisk` and `debugfs`). Our tests boot it with `systemd.run=…` and
  power off. **Its kernel has `simplefb` and `fbcon` built in** (so a text console should appear
  on our framebuffer with no module); `virtio_input`, `virtio_gpu` and `virtio_snd` are modules on
  the root filesystem (not in the initrd), loaded by udev after the root mounts. The nocloud image
  has no cloud-init and lets root log in without a password; `systemd.firstboot=off` is needed (a
  writable first boot otherwise waits on the console).
- **Debian's boot time:** 29.6 s to its test script on 4 parallel vCPUs, 42.3 s on 1 (Chromium,
  JIT, this host). A full boot to a login prompt will be longer; nobody has measured it.
- **Writable disks:** the OPFS copy-on-write overlay (`web/overlay.ts`), opened by the device
  worker with synchronous access handles; no host API to reset or export it yet.
- `tools/serve.ts` serves the repo with COOP/COEP, strips `.ts` types and answers `Range`
  requests, and **refuses anything under `node_modules`**. `npm run serve` needs the wasm built
  and the images present; nothing checks either.
- Building from source needs the pinned nightly (`rust-toolchain.toml`: rustup installs it on
  first use) and `scripts/build-wasm.sh` (`-Zbuild-std`).

## Decisions (confirmed 2026-09-28; don't re-ask)

1. **One VM per page: Debian 13 (the nocloud image), hardcoded for now**, under the JIT, in
   realtime mode with parallel SMP. No image picker, extra disks or settings UI in phase A beyond
   what's listed here.
2. **The framebuffer is the default view**: Debian's fbcon on the canvas (a getty on `tty1`),
   keyboard and mouse through virtio-input. **A serial terminal on xterm.js** is the secondary
   view (fallback, debugging, "advanced users"): a getty on `ttyAMA0`, input through the PL011 RX
   path. Both are available at once; the page switches between them (or shows both), the screen
   first.
3. **`@xterm/xterm` is approved as a runtime dependency** (MIT), with xterm.js's official addons
   (`@xterm/addon-*`) if they earn their place. Serve it from `node_modules` through a narrow
   allow-list in `tools/serve.ts` (only the files the page imports), not by vendoring copies. Add
   its row to `THIRD_PARTY.md`. **Any other dependency still needs my OK.**
4. **The disk persists** across reloads in the OPFS overlay. The page has a "reset disk" action
   (with a confirmation). The overlay's backlog items that this needs (a host API to reset it) are
   done here; export and import wait for phase D.
5. **One command from a fresh clone: `npm start`**, on Linux and macOS. Node (≥ 26, as
   `package.json` says) and rustup are the only prerequisites; it checks them and says exactly
   what's missing and how to get it. Then it installs npm dependencies if `node_modules` is
   missing or stale, builds the wasm core if its sources changed, downloads Debian if absent
   (checked against the pinned SHA512), extracts the kernel and initrd, serves on
   `127.0.0.1` and prints the URL. **The extraction moves into Node** (partition table + a
   read-only ext4 reader in TypeScript, over the existing qcow2 reader), so `qemu-img`, `sfdisk`
   and `debugfs` aren't needed; `images/build.sh debian` uses the same code, and the output must
   match `images/SHA256SUMS` byte for byte. Write the ext4 reader so it can also run in the
   browser: a later step may read `/boot` at start time instead of preparing files (backlog,
   "Booting conventional arm64 disk images unmodified"). The other images keep their Podman
   builds; `npm start` needs only Debian.
6. **Frontend stack:** start with plain TypeScript and the DOM, erasable syntax, no bundler (the
   page is served like the rest of `web/`). **Svelte is pre-approved** (my preference if a
   framework is used) if it makes a specific part clearly easier, e.g. once the page's state and
   controls grow; not before there's a reason. It needs compiling: do it on the fly in
   `tools/serve.ts`, as type stripping is done, so there's still no separate build step, and
   say in the loop's report why it was worth it. No other framework without my OK. Chromium
   only; the page may say so when it detects something else, but nothing is done for other
   browsers (their pass is in the backlog).
7. **Localhost only, no public hosting in M8.** Don't design for static hosting, but don't tie the
   page to the dev server where it costs nothing (for example, image URLs come from one config
   object).
8. **No guest network in phase A.** No net device on the page's VM (a guest with a link but no
   route is worse than none).
9. **Guest-visible changes to the tests' machines need my OK** as always (step counts). The page's
   VM is a new configuration (its own command line, a framebuffer size, input devices), not a
   change to the tests' guests: choose it freely and write it down.

## Goal (PLAN.md §3 M8, phase A)
`npm start` on a fresh clone serves a page where Debian boots with its console on the screen; I log
in as root with the keyboard, run commands, see the output live, use the serial terminal as an
alternative, and find my files again after a reload.

## Loops (order is a suggestion; the numbers decide)
0. **Baseline.** Boot Debian for interaction in a throwaway Chromium page (Playwright,
   headless): no `systemd.run`, `console=ttyAMA0 console=tty0` (check which gets `/dev/console`
   and which getty units start), `systemd.firstboot=off`, the framebuffer on (try 1024×768 and
   1280×800), `keyboard` and `tablet` devices, the overlay on, parallel SMP at 1, 2 and 4 vCPUs,
   1 and 2 GiB of RAM. Record: time to the login prompt on each console, whether fbcon draws on
   `simplefb` (screenshots), whether `virtio_input` loads and the keyboard reaches `tty1`,
   memory used, and anything slow or noisy in the boot log (units that time out without a
   network, and so on). This sets the page's defaults and says how urgently phase B's snapshots
   are needed.
1. **Console input.** A host API to send bytes to the PL011 (`vm.ts`: a method and a
   `MessagePort` for pages that run the VM in a worker; bytes wait while the RX ring is full, and
   `SIGNAL_RX` wakes an idle vCPU in every mode, parallel included). Decide whether
   virtio-console RX joins now (it would give an `hvc0` getty; only if it's cheap). Tests at the
   cheapest layer: a core unit test if the core changes; the Buildroot guest reading a line from
   its console and echoing it, natively, in Node and in Chromium, with the bytes injected at a
   fixed step in deterministic mode (a new row in `tests/steps.txt` only if the new test guest
   needs one). If the ABI changes, write the design note in `docs/abi.md` first, then implement
   and report (pre-approved).
2. **The page.** `web/app/` (or similar: an `index.html` at the path `npm start` prints) running
   the VM in a worker: the screen canvas scaled to fit (integer scaling when it fits, crisp,
   HiDPI-aware), the xterm.js view wired to the PL011 in both directions, power state (booting,
   running, powered off, crashed) with a restart, a status line (vCPUs, RAM, uptime, JIT and
   device activity if cheap). Keep the VM logic out of the DOM code: the page talks to the worker
   through a small message protocol, which is the seed of phase D's embedding API (write it down
   as you go, but don't freeze it).
3. **Input that feels right.** Click to focus and a visible focused state; keys released on blur
   (no stuck modifiers); a fullscreen mode with the Keyboard Lock API (Chromium) so browser
   shortcuts (Ctrl+W, Ctrl+T) and Escape reach the guest; a menu or buttons for combinations the
   browser won't pass (Ctrl+Alt+Del, Ctrl+Alt+F1/F2 to switch VTs); paste into the serial terminal;
   the tablet mapped through the canvas's scaling. Measure key-to-glyph latency on the screen and
   on the terminal (a Playwright test can time it with `performance.now` stamps and pixel
   polling); if the full-frame copy per animation frame shows in a profile, add dirty tracking.
4. **Loading and errors a user can act on.** Progress for the kernel and initrd downloads and for
   the boot (boot log lines until the screen takes over, or the serial view by default until the
   login prompt: judge by loop 0's numbers); clear messages for a missing cross-origin isolation,
   missing wasm or images (pointing at `npm start`), too little host memory for the guest's RAM,
   a guest panic or an emulator error (with a way to see the serial log and copy it). The disk
   reset. Defaults: vCPUs from `navigator.hardwareConcurrency` (at most 4, and at most the cores
   minus two); RAM from loop 0. Remember the view and settings per browser (`localStorage`).
5. **`npm start`.** The prerequisite checks, the npm install, the wasm staleness check (fast when
   nothing changed), the Debian download with progress and its SHA512, the Node extractor
   (decision 5; unit-tested on a small ext4 image made in a test, plus the byte-for-byte check
   against `SHA256SUMS`), the server with the xterm.js allow-list, and a printed URL. Test it
   the way I'll use it: `git clone` the repo into the job's tmp directory and run `npm start`
   there with a pre-filled download cache (an env var pointing at `target/images/dl`, so the test
   doesn't download 400 MB), then load the URL in Playwright. Document it in a short README
   section (there's no top-level README yet: add one, short, with what the project is and how to
   start).
6. **End-to-end test in CI.** A Chromium test of the page itself: Debian boots under the JIT on
   2 parallel vCPUs, the test logs in as root **on the screen** through virtio-input, runs a
   command that writes a marker to `/dev/ttyAMA0`, reads it back through the serial side, then
   logs in on the serial terminal and runs a command there; then persistence (write a file,
   reload, find it; reset the disk, it's gone). Realtime runs are nondeterministic: repeat the
   test several times before trusting it. It joins `scripts/ci.sh` where the Debian image is
   current, alongside Debian's existing Chromium boot, and must stay within a few minutes (loop
   0's numbers).
7. **Exit.** I use the machine myself and report what's rough; fix what's small, and list the
   rest. Docs: a new `docs/frontend.md` (the page, the worker protocol, `npm start`, the
   extractor), `docs/devices.md` (console input, overlay reset), `docs/images.md` (Debian's
   extraction without host tools), `docs/README.md`'s index; PLAN.md's M8 entry updated with
   phase A's outcome; new backlog entries; a proposed outline for phase B's kickoff (snapshots)
   and the parallel tracks' first steps.

## Check with me before
- Any dependency beyond `@xterm/xterm`, its official addons and Svelte (decision 6).
- Changes to the tests' guests or their step counts (decision 9); changes to the Debian image's
  bytes (we boot it as published; configuration goes on the command line, never into the image).
- Anything that makes the headless boots or benchmarks slower beyond noise.
- Starting phase B or any C track: phase A ends at its exit report.

## Validation per loop
Tests at the cheapest layer (core unit tests, Node tests of the extractor and the worker protocol,
the Buildroot console-input test in every runner); the page's end-to-end Chromium test from loop
6 on, repeated; the fresh-clone check of `npm start`; screenshots of the page at each loop's end
(committed only if small and useful, otherwise in `bench/results/local/`); planted bugs where a
rule is new (bytes dropped when the RX ring is full, a key left down after blur, the extractor
reading the wrong extent).

## Numbers
Not a performance phase, but measure what a user feels: time from page load to the login
prompt (median of several runs, Chromium, this host, JSON in `bench/results/local/` or a new
bench case if it's worth tracking), key-to-glyph latency on both views, and the page's main-thread
cost of drawing the screen. The existing boot benchmarks must not regress beyond noise.

## Practicalities
- Chromium only, headless through Playwright; never touch Firefox; never run `/usr/bin/chromium`
  (except `--version`); never `pkill -f` a pattern that matches your own shell; wrap every run in
  `timeout` under the tool's 600 s cap and bound every wait (realtime Debian boots can hang: set
  `idleLimitMs` in tests and a wall-clock limit on every run).
- I'll open the page myself from the x86_64 desktop or the Mac: the dev server listens on
  `127.0.0.1` inside the VM, so tell me the forwarding command (`ssh -L …` through `macmini.lan`)
  when a loop has something to look at. Don't make the server listen on other interfaces by
  default (a flag for it is fine).
- The Debian overlay in OPFS belongs to the browser profile: Playwright's temporary profiles start
  empty, so tests are isolated; say so in the docs.
- Temporary files in the job's tmp directory; ad-hoc tools and results in `bench/results/local/`.

## Report at the end of each loop, then continue
What changed; validation (tests added, planted bugs, repeated runs); numbers where relevant; a
screenshot or the forwarding command when there's something to look at; choices I may want to
overrule; next loop.
