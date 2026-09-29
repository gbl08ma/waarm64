**Handover, 2026-09-29: M8 phase A is done (loops 0–7) and the user has made their pass over
the machine. Next: one loop of the user's rough edges (below), then phase B (snapshots) and the
phase C tracks, each waiting for a kickoff the user confirms.**

This file is for whoever drafts or starts the next work. The kickoff (M8-KICKOFF.md, "Check with
me before") says phase A ends at its exit report, and **phase B or any C track starts only from a
kickoff the user has confirmed.** The rough-edges loop is phase A follow-up the user asked for and
can start from this file. Below: the user's answers, the rough-edges loop, where things stand,
what the exit found, the numbers, gotchas, the questions still open, and the outline for phase
B's kickoff (refined with the user's answers) and the C tracks' first steps.

## The user's answers (2026-09-29, after their pass over the machine)
- **Overall:** "I like what I see."
- **`timer.bin` may be hardened** (the change to a test guest's bytes is approved; see the loop
  below).
- **The fresh-copy `npm start` test stopping at the kernel is OK** (loop 7's change stands).
- **Phase B: snapshots are files the user downloads and uploads.** The page offers a snapshot for
  download and accepts one uploaded to the page. The same would go for the disk image (the
  user's modified filesystem), but that is **best rethought once the emulator boots generic disk
  images through UEFI** instead of relying on kernel extraction as now: not in phase B (see the
  outline below for what that means for the overlay).
- **Dynamic guest screen resolution** (the screen following the page's size) is expected from
  the graphics track (phase C, virtio-gpu); it is already in that track's first step below.
- Not answered yet: which C track goes first, networking's backend order, the snapshot ABI's
  shape (the phase B design note proposes it; the user reviews it with the kickoff).

## Loop 8 (the rough edges): done — see "Loop 8's outcome" right below the item list
The items as briefed (kept for the record):
From the user's pass. One loop, one commit, `scripts/ci.sh` green, the usual report; list what's
left in docs/backlog.md "The page" (which says "none reported yet": replace that with this).
1. **Keys menu: Ctrl+Alt+F1 through F12**, not just F1 and F2 (the menu is in `web/app/main.ts`,
   chords through `attachInput`'s `chord`). Extend the smoke test's check to a high F-key.
2. **Restart raced: "disk in use".** A hard Restart of the running machine once failed as the new
   machine booted: the red bar, the "disk in use by another tab" problem (loop 4's message for the
   overlay's OPFS handles held elsewhere); Retry fixed it. So the old machine's device worker
   hadn't released the overlay's handles when the new one opened them. Loop 2 tried a retry in
   `openOverlay` and removed it because nothing reproduced (docs/frontend.md "Overlay hand-over");
   the Restart path (stop → `stopped` round trip, 3 s at most, then terminate; `vm.close()`
   resolving on the device worker's `closed`) is where to look: a stop that times out and
   terminates anyway, or a `closed` sent before the handles are really closed. **Reproduce first**
   (Restart in a loop on Debian with the disk busy, e.g. a write in progress, and on Buildroot),
   fix the ordering (the new machine must not open the overlay before the old one's handles are
   closed), and keep a bounded retry only if the ordering can't be made airtight. Test it: repeated
   Restarts while the guest writes, no `failed`. Plant the old ordering back and check it fails.
3. **Harden `timer.bin`** (approved): `tests/baremetal/timer.c`'s 1 ms window failed under host
   load in parallel mode (loop 6). Make it robust to a descheduled vCPU (a longer window or a
   retry; docs/backlog.md "Parallel SMP"), rebuild with `tests/baremetal/build.sh`, re-run it on
   the QEMU oracle (`tests/baremetal/oracle.sh`), and move its step counts in `tests/steps.txt`
   once, in this commit. Check it now survives the load that broke it (both Debian page tests plus
   the rest of `npm test` at once, i.e. `tests/debian-lock.ts` bypassed for the experiment).
4. **Record, don't fix: Firefox.** In the user's quick check, the core ran but Debian didn't find
   its root filesystem and dropped to the initramfs emergency shell. Add it to docs/backlog.md's
   browser-compatibility entry (PLAN.md: the Firefox and Safari pass is a later, separate item).
   Likely suspects to note there, unverified: the virtio-blk backend's OPFS access (sync access
   handles in a worker) or the device worker's I/O path under Firefox. Never launch or automate
   Firefox (CLAUDE.md): the user checks it by hand.

### Loop 8's outcome (`4eb7cc4`; docs/frontend.md, docs/testing.md, REPORT "M8 loop 8")
- **Keys menu:** Ctrl+Alt+Del and Ctrl+Alt+F1–F12 (a grid built by main.ts); the smoke test
  checks F12's chord. On Debian F2–F6 get a getty on demand; F7–F12 are empty consoles.
- **Restart race:** reproduced only with **two restarts overlapping** (a second Restart click, or
  the guest rebooting, while the first restart waits for `stopped`). Not reproduced otherwise in
  ~150 restarts at random points nor 400 terminate-then-open cycles: Chromium releases a
  terminated worker's OPFS handles before a new worker can open them. Fix: `openOverlay` takes an
  exclusive Web Lock `webpc-overlay:<name>` and holds it until `close` (so the ordering doesn't
  rest on timing; a waiter gives up after 10 s with "disk in use"), and the page runs one restart
  or disk reset at a time (buttons disabled until the new machine's worker has started). Tests:
  browser.test.ts "the overlay's hand-over" and "the page restarts over and over". **Open:** if the
  user sees "disk in use" again, a `NoModificationAllowedError` in the message would mean a
  browser released the lock before the handles (then: a short bounded retry after the lock).
- **`timer.bin`:** retries its 1 ms TVAL check (up to 100 times) and bounds CVAL by counter reads
  before and after. Under the load that broke it, 0 TVAL failures in 450 runs (old: 3 in 451).
  Bare-metal tests have no `tests/steps.txt` entries: nothing moved there.
- **Firefox:** recorded in docs/backlog.md with suspects (virtio-blk's sync XHR range reads,
  `DecompressionStream`, OPFS handles and the Web Lock in a nested worker, `Atomics.waitAsync`).
- **A memory leak, found the hard way:** twice (13:35 and 13:48) a Node test process grew to 6.2
  and 6.9 GB; the VM's OOM kill took the whole Claude Code session and the user's tmux window
  down (systemd stops the scope an OOM-killed process was in). Cause: in Node's parallel mode the
  device backends' `Atomics.waitAsync` doorbell loop never ended on `Devices.close`, keeping every
  closed VM's memory alive (~10 MB a bare-metal boot, GBs per test file). Fixed (`close` ends
  `serve`); boot-node.test.ts "parallel: a closed VM is garbage-collected" checks it. The page
  wasn't affected (a worker per machine). **Rule now in CLAUDE.md:** heavy runs go under
  `systemd-run --user --scope -q -p MemoryMax=10G -p MemorySwapMax=0 -- timeout N <cmd>`.
- **Relevant to phase B:** the Web Lock is the overlay's ownership; a snapshot restore that
  replaces the overlay (an uploaded snapshot carrying its overlay) must take the same lock, as
  Reset disk's `removeOverlay` does.

**Read, in order:** CLAUDE.md (conventions and working rules: they apply in full), PLAN.md §3
"M8" (phases A–D; phase A's outcome), `M8-KICKOFF.md` (phase A's brief: its confirmed decisions
still bind the page), then `docs/frontend.md` (the page), `docs/platform.md` (run loop, parallel
SMP, broadcast maintenance), `docs/devices.md` (the device worker, the overlay), `docs/abi.md`
(the host ABI; a snapshot is an ABI change: design note first), `docs/backlog.md` ("The page",
"Snapshots in parallel SMP", "Parallel SMP"), `docs/testing.md`, `bench/boot/REPORT.md` "M8
loop 0"–"M8 loop 7". Kickoff and handover files in the repo root are tracked
(CLAUDE.md "Where things are written down"): commit the next handover with its work and delete
this one then.

## Where things stand (all on `origin/main`)
| Loop | Commit | What landed |
|---|---|---|
| 0 | `34701eb` | Baseline of Debian for interaction; the page VM's command line (docs/images.md); fix: >2 GiB of wasm memory |
| 1 | `dd809fe` | Console input: `vm.send`, `BootOptions.serialIn` (a `MessagePort`), `runToPowerOff(…, input)`, native `Boot.input`, bare-metal `rx.bin`, the Buildroot console-input test everywhere |
| 2 | `0c36e6e` | The page `web/app/` (index.html, main.ts, worker.ts, protocol.ts, machine.ts), xterm.js 6 through a two-file allow-list, the screen canvas, views, power states, status line |
| 3 | `0a6de61` | Input that feels right: focus, keys released on blur, Keys menu, Full screen with the Keyboard Lock; the machine worker draws the screen (OffscreenCanvas, dirty rows); terminal echo ~30 → ~11 ms |
| 4 | `920babd` | Loading and errors a user can act on: download progress, boot card, `failed`/`crashed` with a `problem` and actions, checks before any worker, Reset disk, the serial log, `?params=` |
| 5 | `dfc7b95` | `npm start` (`tools/start.js` → `tools/start.ts`, `tools/debian.ts`), the disk reader `web/bootfs.ts` + `web/ext4.ts`, top-level README; `tests/ext4.test.ts`, `tests/start.test.ts` |
| 6 | `b8efa00` | The end-to-end test `tests/page-debian.test.ts` (logins on the serial terminal and the screen, a marker across them, persistence over a reload, Reset disk); the ready-marker fix; `tests/debian-lock.ts` |
| 8 | `4eb7cc4` | The user's rough edges: Keys menu F1–F12, the overlay's Web Lock and serialized restarts, `timer.bin` hardened, a Node parallel-mode memory leak fixed, Firefox recorded; CLAUDE.md's memory-cap rule |
| 7 | `bdb35e4` | The exit: **a JIT memory-ordering fix** (below), the e2e test's screen race fixed, the fresh-copy test shortened (Debian overlap review), docs and PLAN.md closed for phase A, backlog "The page" |
| 8 | `LOOP8` | The user's rough edges: Ctrl+Alt+F1–F12 in the Keys menu; the overlay's hand-over under a Web Lock and restarts that can't overlap (the "disk in use" Restart); `timer.bin` hardened; Firefox's missing root recorded (below) |

## Loop 7 (the exit)
- **The memory-ordering bug is real, and fixed.** The parallel JIT litmus flake of loops 4 and 6
  (MP+dmb.sy+addr's forbidden outcome, 1 in 20,000 in CI, twice) was V8: TurboFan folds `x ^ x`
  (the litmus idiom `eor wN, wM, wM`, feeding the next load's offset) to 0, so the dependent
  load's host address no longer depended on the first load and the M4 reordered them. Checked
  with `node --no-liftoff --print-wasm-code` on a hand-made module (the second `ldr` used a
  constant offset; with `x & <mutable global>` it kept `and w3, w3, w4` feeding the address).
  **Fix:** in parallel SMP, EOR and SUB (shifted register, no shift) of a register with itself
  emit `x & zero`, `zero` a mutable i64 global every parallel module now defines
  (`Module::zero_global`, `emit::ZERO_GLOBAL`); single-thread modules are unchanged. Measured
  (Node, 4 vCPUs, `-s 1000 -r 200`, 3 runs): **95 forbidden outcomes in 1.2M before, 0 after**.
  Unit test `opaque_self_zero_in_parallel`; the Node parallel JIT litmus now runs `-r 50` (the
  unfixed build failed 5 of 5 such runs; 1 of 3 at the old `-r 10`: short runs are mostly Liftoff
  code, which doesn't fold). Cost: `smp_user_jit_4` A/B, 31,191 → 31,131 ms (noise). Linux's own
  `arch_counter_enforce_ordering` uses the same idiom (eor + add + ldr). Not covered: other
  always-zero forms (`and x, x, xzr`, a multiply by zero) that nothing we know uses for
  dependencies. docs/jit.md "Atomics", docs/testing.md "Litmus tests", REPORT "M8 loop 7".
- **Redundant tests (the user's request this loop):** reviewed every Debian boot in CI against the
  page's end-to-end test. **Kept:** `browser.test.ts`'s deterministic Debian boot (the only CI run
  of Debian in deterministic mode and of the fence-free one-vCPU JIT on Debian's code, with a
  systemd power-off). Measured: leaving it out saved no wall time (`npm test` 303 → 299 s: it runs
  beside boot-node.test.ts, the long pole), so it was reverted. All
  Alpine, Buildroot, native and Node tests stay (exact steps, interpreter, JIT-check). **Changed:**
  `start.test.ts`'s fresh copy no longer boots Debian to a login: it now checks that the copy's
  kernel and initrd are this checkout's byte for byte (which the e2e boots to a login three
  times) and stops once the guest's console takes the page's screen: ~3 s after the URL instead
  of ~40 s (a Debian boot less of load). Still covered there: the copy's `npm ci`, the core stamp,
  Debian's preparation from the cache, the served module graph and images, the page starting the
  machine. CI time: `npm test` 303 s before these changes, 297 s after (full `scripts/ci.sh` 446 s, warm); the wall time is `tests/boot-node.test.ts`'s (its tests run in sequence, ~295 s), not the Debian pair's, which now ends at ~186 s instead of ~222–230 s. Splitting boot-node.test.ts is the lever if CI time matters (not done: more concurrent boots means more load, and `timer.bin` is load-sensitive). docs/testing.md "Overlap between the Debian tests".
- **The e2e test raced under load and is fixed:** in the first CI run of this loop, the command
  typed on the screen right after `root` + Enter never ran (the marker never reached the serial
  side): under load, keys typed while login hands tty1 to bash are lost, as loop 6 found on the
  serial side. The test now waits (from the serial shell) for bash's prompt in `/dev/vcs1` before
  typing on the screen. Test-only; passed alone and in the next CI runs.
- **The user's pass over the machine** happened after the exit (answers and the rough-edges loop
  at the top). docs/backlog.md "The page" has the known edges (clipboard for the screen,
  keyboard layouts, the Keyboard Lock tested by hand only, no settings UI, the ready marker as a
  per-machine regexp, no boot-to-login bench case, boot time) and an entry for the user's report,
  still "none reported yet" until the rough-edges loop fills it in.
- **`timer.bin` under load (loop 6)**: untouched at the exit; the user has since approved
  hardening it (rough-edges loop, item 3).
- **An unexplained slow `npm test`**: the first full `npm test` of this loop (TAP reporter, all
  distros, idle host) didn't finish in 580 s and was killed; nothing was left running and no
  lock was left behind, and the TAP output (ordered by file) only showed boot-node.test.ts done.
  The next run took 303 s, and the two full CI runs that followed took 494 and 446 s (below). If `npm test` ever runs past
  ~8 min, look at which file is still running (the spec reporter prints per file at its end;
  `ps` for Chromium and the Debian lock `$TMPDIR/webpc-debian-page.lock`) before killing it.
- Docs checked against the code: frontend.md (files, protocol, loading, errors, screen, input,
  latency, terminal, views, the e2e test, overlay hand-over, `npm start`, the disk reader),
  devices.md (console input to the PL011, `removeOverlay`), images.md (Debian's extraction in
  Node), README.md and the docs index; PLAN.md's phase A entry has the outcome; CLAUDE.md's status
  says phase A is done.

## Numbers (the M4 VM, Chromium 153.0.8010.52, Node 26.7.0)
- Page load to the serial login prompt: **~29 s on 4 vCPUs** (loop 4), **31.5 s median on 2**
  (30.8–32.5, 12 fresh boots, loop 6); under CI's load ~60 s.
- Key to glyph: ~11 ms on the serial terminal, ~15 ms on the screen (loop 3).
- `npm start`: ~0.1 s with nothing to do, the URL ~1–2 s after start in a fresh copy with the core
  prebuilt; cold (the core built) ~12 s on the M4 plus Debian's 400 MB download.
- The e2e test alone 110 s (running 32 s, logged in 38 s, reloaded 68 s, reset 105 s); in CI
  ~180 s.
- `npm test`: 290 s (loop 6), 303 s (this loop before the test changes; the Node litmus at
  `-r 50` adds ~20 s under load, on boot-node.test.ts, the long pole), 297 s after. Full
  `scripts/ci.sh`: 446 s with warm caches (the green run at `bdb35e4`'s tree).
- Litmus and A/B raw: `bench/boot/results/m8-loop7/` (`litmus.json`, `smp-user-*.json`).

## Findings and gotchas (don't re-discover)
- **V8 folds more than you'd think in parallel code:** a guest's ordering guarantee that rests on
  a data dependency survives only if the wasm value really depends on the loaded value after
  TurboFan's reducer. `x ^ x`, `x - x`, `x & 0`, `x * 0` all fold. The zero global is the pattern
  for keeping one opaque; check with `--print-wasm-code` and `--no-liftoff` (a hand-made module in
  `bench/results/local/m8-loop7/xorfold.mjs`).
- **Rare parallel failures hide in Liftoff code:** a CI-sized litmus run is mostly Liftoff; to
  hunt a 1-in-10⁴ outcome, run the litmus image longer (`webpc.litmus=-s,1000,-r,200`, ~1 min
  in Node: `bench/results/local/m8-loop7/litmus.ts <runs> <opts>`).
- The Debian page tests take turns (`tests/debian-lock.ts`); `npm start`'s test may wait for the e2e
  (the pair ends at ~186 s in CI). `npm test`'s long pole is `tests/boot-node.test.ts` (~295 s of
  tests in sequence). Load from other files slows both (the page
  reaches `running` at ~60 s in CI vs ~32 s alone).
- The dev VM has no `diff` or `cmp`; `rustup --version` may install the toolchain; `/tmp` is a
  6.9 GB tmpfs; npm's hidden lockfile omits other platforms' optional packages;
  `bench/run.ts --out` is joined to the checkout's root (so a run from `../webpc-base` writes
  there).
- `../webpc-base` is at `b8efa00` (loop 6, wasm built: the pre-fix JIT) for A/B runs.
- From earlier loops (loop 6's handover has the full list): Playwright's `keyboard.type()` doesn't
  press Shift; `page.route` can strip COOP/COEP from worker fetches; xterm.js's DOM renderer shows
  only visible rows; virtio-input drops past 1024 queued events (pace typing); never type ahead
  of a prompt on Debian's consoles; a `requestAnimationFrame` loop on the page delays worker
  messages ~20 ms.
- **Looking at the page from the desktop**: `ssh -t -L 8080:127.0.0.1:8080 macmini.lan "ssh -t -F
  ~/.lima/dev/ssh.config -L 8080:127.0.0.1:8080 lima-dev 'cd ~/Development/webpc && npm start'"`,
  then open `http://127.0.0.1:8080/`.
- Never a `pgrep -f`/`pkill -f` wait loop; wait on `run_in_background` notifications. The Bash
  tool refuses `sleep N; cmd`: use `timeout N bash -c 'until <cond>; do sleep 5; done'`.

## Questions still open for the user
(Answered: the rough-edges pass, `timer.bin`, the fresh-copy test, and snapshots as downloads and
uploads; see the top.)
1. **Phase B's kickoff** (outline below, refined with the user's answers): confirm it, in
   particular whether the page also keeps a snapshot in OPFS for automatic resume on reload
   (proposed: yes, as a cache beside the download/upload), that a snapshot file carries the disk
   overlay (proposed: yes, see below), and the ABI shape (from the design note).
2. **Which C track first**, and networking's backend order (a relay to a user-mode NAT in the dev
   server vs Tailscale first; PLAN.md §3 phase C).

## Proposed outline for phase B's kickoff (snapshots; refined with the user's answers, for the user to confirm)
**Goal:** the page resumes a booted Debian in a few seconds instead of a ~30 s boot, and **the
user owns their snapshots as files**: the page offers the running machine's snapshot for
download, and a snapshot file uploaded to the page (a file picker and drag and drop onto the
screen) resumes that machine. Proposed on top: the page also keeps the latest snapshot in OPFS
and resumes from it on reload (to confirm with the user).
- **What a snapshot holds:** every vCPU's `Cpu` (1,072 bytes each, `core/src/cpu.rs`: registers,
  system registers, timers' state) and its pending state; the platform in the core (GICv3
  distributor and redistributors, the PL011 and its rings, PSCI power states, virtio-mmio
  transports and their queue addresses and indices, reset epochs); guest RAM, **compressed**
  (1 GiB, mostly zero pages early on: page-level zero elision plus a fast compressor via
  `CompressionStream`; measure deflate vs doing it in wasm); the device worker's backend state
  (the overlay's map is on OPFS already; blk requests in flight must be drained first; input and
  rng hold nothing that matters); the DTB and command line it was booted with. **Not** the JIT's
  code caches, TLBs or jump caches: rebuilt on demand (invalidate everything on restore).
- **Quiescing:** round-robin needs nothing new. Parallel SMP stops every vCPU worker at a chunk
  boundary (STOP, every `OUT`), with each maintenance queue drained and no CPU_ON pending
  (backlog "Snapshots in parallel SMP"); the device worker finishes in-flight requests and holds
  new ones. Time: realtime counters are rebased on restore so the guest sees continuous time
  (CNTVCT offset), and timers due in the gap fire at once.
- **The overlay pins the snapshot, so a snapshot file carries the overlay.** A snapshot is valid
  only with the disk state it was taken with, and an uploaded file may land in a browser with a
  different overlay or none. Proposed: the file holds the overlay's contents (the blocks written
  over the base image, compressed) plus the base image's identity (its SHA-256, as pinned in
  `images/debian.json`); restoring an upload replaces the local overlay after a confirmation (it
  would discard the local disk's changes, like Reset disk: say how much). The base image itself is
  never in the file (it's 400 MB and every copy has it). Locally, taking a snapshot freezes the
  overlay at that point (a generation number in both, or a copy-on-write layer); Reset disk drops
  the local snapshot; a mismatch refuses to restore and says why.
- **Not in phase B: a standalone disk export/import** (the user's filesystem as its own file,
  without a machine state). The user wants it rethought once the emulator boots generic arm64
  disk images through UEFI (PLAN.md's Boot row; docs/backlog.md), when "the disk" becomes a
  whole, ordinary image instead of an overlay over a pinned distro image with its kernel pulled
  out. Add it to the backlog's UEFI entry.
- **The snapshot file is a user-facing format**, so: a header with a magic, a format version and
  the core build it needs (the wasm input hash `npm start` computes is a candidate), the machine
  config (machine name, vCPUs, RAM, command line, base image hash), a checksum per section, and
  sections for CPU state, platform, devices, overlay and RAM, each compressed. An upload from
  another core build, another base image or a newer format is refused with a message a user can
  act on (loop 4's problem/actions style), never restored half-way. Streams both ways, because
  RAM is up to GiBs: download through the File System Access API's `showSaveFilePicker` (Chromium)
  with a Blob download as the fallback, upload read as a stream from the `File`, decompressed as
  it's read; measure save time, file size and restore time for Debian after login.
- **ABI:** export/import of core state (`vm_snapshot_size`, `vm_snapshot_save(ptr)`,
  `vm_snapshot_restore(ptr)` or a layout in docs/abi.md), a version in the header that refuses a
  snapshot from another core build (the wasm's input hash `npm start` already computes is a
  candidate). Design note in docs/abi.md first (pre-approved in phase A's style).
- **Where it lives:** with the user, as downloaded files (above); the local copy for resume on
  reload in OPFS next to the overlay (`webpc-debian.snap`), per origin and profile, if the user
  confirms it. Prebuilt snapshots shipped with the repo are a later question (they'd tie the page
  to one core build).
- **The page:** a Snapshot action (download) and an upload (button plus drop on the screen); a
  `resumed` power state; the worker protocol grows `snapshot` / `restore` messages (and a
  streamed transfer of the file between the page and the machine worker).
- **Tests:** a core unit test (save, restore into a fresh VM, run both in deterministic mode:
  identical console and **identical steps from the restore point**, the strongest check we have);
  Buildroot and Alpine round-trips in Node and Chromium (deterministic, exact steps); a parallel
  round-trip (litmus and stress continuing after a restore); the page: boot, write a file, download
  the snapshot, then in a **fresh browser profile** upload it and find the machine resumed, logged
  in and the file there within N seconds; an upload from another core build or base image and a
  corrupted file refused with their messages. Planted bugs: a register not saved, a queue index
  not restored, the counter not rebased, the overlay left out of the file.
- **Numbers:** time to `running` from a snapshot (target: a few seconds), snapshot size and save
  time; add the `page_debian` bench case then (backlog "The page").
- **Out of scope:** migrating snapshots between core builds, live migration, snapshots of the
  test guests' step counts (a restore must not change them).

## Proposed first steps of the C tracks (one agent each, after phase B's kickoff or alongside)
- **Networking** (docs/plans/networking.md): first the Ethernet gateway (frames ↔ IP, DHCP, ARP,
  DNS forwarding: our own code) behind the existing frames-on-a-`MessagePort` adapter; then the
  first backend. For a page served by our dev server, a relay in `tools/serve.ts` to a user-mode
  NAT (no account needed) is the candidate to weigh against the plan's Tailscale-first order
  (which targets static hosting). The page's VM gets a net device only once a backend gives it a
  route (phase A decision 8).
- **Graphics** (docs/plans/graphics.md §3, §7): virtio-gpu 2D first: the screen follows the page's
  size (dynamic guest resolution: the user expects it from this track), damage rectangles instead of the full-frame scan, a hardware cursor; Debian's kernel has
  `virtio_gpu` as a module (loaded by udev). Then the software baseline and the 3D decision gate.
- **Audio:** write `docs/plans/audio.md` first (virtio-snd to an AudioWorklet over a shared ring;
  latency and clock drift under realtime mode; Debian's `virtio_snd` module).
- **Host integration:** clipboard for the screen (paste paced through virtio-input, or a guest
  agent), dropping files into the guest (9p, which exists: an OPFS or in-memory tree), pointer
  lock (relative mouse), keyboard layouts (the guest's keymap to match: `vconsole.keymap=`).

## Notes for the next phase
- Keep the page's VM config (machine.ts) separate from the tests' guests: a new device on the
  page isn't a guest-visible change to the tests; a change to a test guest is (the user's OK).
- The worker protocol (docs/frontend.md) is still the seed of phase D's embedding API, not frozen:
  snapshots add messages (`snapshot`, `restore`, a `resumed` state) there.
- Every Chromium run: headless Playwright only, never Firefox, never `/usr/bin/chromium` except
  `--version`; every run under `timeout`, every wait bounded.
