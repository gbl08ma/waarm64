**Handover, 2026-09-29: M8 phase A is done (loops 0–7), the user has made their pass over the
machine, and loop 8 fixed the rough edges they found (`4eb7cc4`). Next: phase B (snapshots) and
the phase C tracks, each waiting for a kickoff the user confirms.** (Updated 2026-09-30: the
networking lane of phase C has started, a stability detour is over (next section), and **phase B
is now "your own disk"** (booting unmodified images, disk in and out); snapshots moved to a phase C
lane, `docs/plans/snapshots.md`. The draft outline for the new phase B is at the end.)

## Since then (2026-09-29 to 09-30): networking, then a stability detour
- **Networking (phase C) started** in cloud sessions: N1–N5 of docs/plans/networking.md. The Ethernet
  gateway, the Tailscale wasm client and the page's Network menu with exit nodes are done.
  Its state and what's left are in `M8-PHASEC-NETWORKING-HANDOVER.md`. Its Debian tests run in
  `scripts/ci-net.sh` (248 s), not `scripts/ci.sh`: run it when a change touches the network.
- **CI time** (2026-09-30): `scripts/ci.sh` took 646 s with the network tests in; now 315–335 s.
  - The network tests moved to `scripts/ci-net.sh` (248 s).
  - The heaviest multi-vCPU runs moved to `scripts/ci-long.sh` (85 s; the user's option 1): the
    JIT-check litmus, the JIT litmus at `-r 50` (`ci.sh` runs `-r 10`), and Node's parallel Alpine.
    Run it for JIT, SMP or memory-model changes and at milestone ends.
  - The Node boots are split across four files, and the native image tests run beside `npm test`.
  - The host's cores are saturated during CI (tests run 3–5× slower than alone), so the rest is
    total CPU work. The Debian page pair, chained by its lock, is ~180 s of it.
- **The detour: the VM hung or crashed in the user's long sessions** (4 vCPUs, Go builds, SSH over
  the tailnet): a DSB-wait panic, the guest's lockup reports, a frozen page with a live guest, a tab
  past 6 GB. Two days of theories (the network, the platform lock, unbounded JIT loops) came to
  nothing. What fixed it, confirmed by the user on 2026-09-30:
  - **The JIT had no memory bound.** Each vCPU worker compiled its own copy of the guest's code,
    and V8 spends ~10× a module's bytes. A byte budget now flushes the cache (5145861;
    docs/jit.md "Memory"). Per-module eviction is backlog: FIFO was tried and collapsed a Go build.
  - **The screen's row scan could loop forever** when the guest rewrote a row mid-scan. It froze
    the machine worker, so the display and status stopped while the guest ran on (20c497d).
  - The DSB wait now counts only waiting, not its own worker's stalls (900127e).
  - What's left and worth keeping: the core's panic message reaches the page (ABI 27), the
    per-vCPU liveness in the status, the host-stall test, and the long stress test `bench/stress`
    (docs/testing.md).
  - **No JIT slowdown came with the budget:** `smp_debian_jit` at 9e0209b vs HEAD, 27.9 vs 28.4 s
    on 4 vCPUs (noise; `bench/results/local/perf-ab/`). A boot doesn't reach the budget; under a Go
    build it flushes about every 30 s per vCPU, at ~6% of CPU spent compiling.
  - The status line's JIT block count is a total since boot: flushes don't reset it. It now
    shows the flush count beside it.
- On the side: a PL031 RTC in realtime mode (ABI 28), so the guest's clock is right and TLS works
  without `date -s`.

This file is for whoever drafts or starts the next work. The kickoff (M8-KICKOFF.md, "Check with
me before") says phase A ends at its exit report, and **phase B or any C track starts only from a
kickoff the user has confirmed.** Loop 8 was the phase A follow-up the user asked for; nothing
of it is left to do. Below: the user's answers, loop 8 and its outcome, where things stand,
what the exit found, the numbers, gotchas, the questions still open, and the outline for phase
B's kickoff (refined with the user's answers) and the C tracks' first steps.

## The user's answers (2026-09-29, after their pass over the machine)
- **Overall:** "I like what I see."
- **`timer.bin` may be hardened** (the change to a test guest's bytes is approved; see the loop
  below).
- **The fresh-copy `npm start` test stopping at the kernel is OK** (loop 7's change stands).
- **Snapshots (then phase B, now a phase C lane) are files the user downloads and uploads.** The page offers a snapshot for
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
(the host ABI: a change needs a design note first), `docs/backlog.md` ("The page",
"Platform and devices": booting unmodified images), `docs/testing.md`, `bench/boot/REPORT.md` "M8
loop 0"–"M8 loop 8". Kickoff and handover files in the repo root are tracked
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
| 7 | `bdb35e4` | The exit: **a JIT memory-ordering fix** (below), the e2e test's screen race fixed, the fresh-copy test shortened (Debian overlap review), docs and PLAN.md closed for phase A, backlog "The page" |
| 8 | `4eb7cc4` | The user's rough edges: Keys menu F1–F12, the overlay's Web Lock and serialized restarts, `timer.bin` hardened, a Node parallel-mode memory leak fixed, Firefox recorded; CLAUDE.md's memory-cap rule |

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
- **The user's pass over the machine** happened after the exit (answers and loop 8 at the top).
  docs/backlog.md "The page" has the known edges (clipboard for the screen, keyboard layouts, the
  Keyboard Lock tested by hand only, no settings UI, the ready marker as a per-machine regexp, no
  boot-to-login bench case, boot time) and, since loop 8, the user's report and what's left of it.
- **`timer.bin` under load (loop 6)**: untouched at the exit; hardened in loop 8 (item 3).
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
- `npm test`: 290 s (loop 6), 303 s (loop 7 before its test changes; the Node litmus at
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
- `../webpc-base` is at `9e0209b` (before the JIT budget, wasm built) for A/B runs.
- From earlier loops: Playwright's `keyboard.type()` doesn't
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
1. **Phase B's kickoff** (the draft outline below): confirm it, and say which images besides
   Debian matter (Ubuntu, Fedora, Alpine, openSUSE: loop 0 tries them on QEMU). UEFI is decided. (The snapshot questions moved with the lane to
   docs/plans/snapshots.md.)
2. **Which C track next.** Networking went first, Tailscale first
   (M8-PHASEC-NETWORKING-HANDOVER.md).

## Proposed outline for phase B's kickoff (your own disk; a draft for the user to confirm)
**Why before snapshots** (the user, 2026-09-30): the basic loop has to be right first: load a disk
into the VM, boot it, work, shut down, take the modified disk away. For that the VM should boot
unmodified disk images, not a kernel and initrd extracted ahead of time. PLAN.md §3 phase B has the
scope.

**Done when:** on the page, the user picks an image (a URL, or a local qcow2 or raw file by picker or
drop), and it boots through UEFI and its own bootloader, with no preparation step. They work and shut down, then download either **just
their changes** (a qcow2 over the base image as its backing file) or **the whole disk**. In a fresh
browser profile, the same base plus the uploaded changes boots with their files there.

**Decided (the user, 2026-09-30): UEFI, not a loader in the page.** A loader that reads `/boot`
and guesses the boot entry isn't standardized, would break with distro layouts, and takes the
bootloader away from the user. The image boots through EDK2 and its own GRUB, as on real hardware.

Loops (a suggestion):
0. **The oracle first:** EDK2's ArmVirtQemu on `qemu-system-aarch64` in the dev VM, set up the way
   our machine is: virtio-mmio disks (`-device virtio-blk-device`), no PCI devices, the PL011,
   the PL031, the flash pair. It should boot Debian 13's unmodified qcow2, and then the images the
   user picks (Ubuntu, Fedora, openSUSE, Alpine's UEFI image; 16K/64K kernels aren't supported,
   PLAN.md "Deferred"). Settle there, where it's cheap to see:
   - whether ArmVirtQemu needs `fw_cfg`: it probes the DT for it, and without it there are no
     ACPI tables, so Linux gets our DT, which is what we want;
   - what it expects of the flash and the DTB handover (the DT at RAM's base);
   - where its console goes;
   - which EFI services Linux calls at runtime;
   - how long each stage takes.
   This is also where to find whether our `simple-framebuffer` node reaches Linux through EDK2's
   DT configuration table.
1. **The firmware as a guest workload:** `images/build.sh edk2` in Podman (pinned tag, reproducible,
   `images/SHA256SUMS`), and a THIRD_PARTY.md row (a binary we build and run, not code we copy).
2. **The platform:** a CFI flash (QEMU `virt`'s two 64 MiB banks at 0: code read-only; variables
   written with the CFI command set, kept in OPFS per disk), a reset to the flash with the DTB at
   RAM's base (a new VM configuration: the tests' guests keep direct boot and their step counts),
   whatever loop 0 found missing. The core's flash is an ABI change: design note in docs/abi.md
   first. Tests: a bare-metal flash test, and EDK2's boot to its shell in Node, deterministic
   (a new `tests/steps.txt` entry).
3. **Debian unmodified, end to end:** the page boots Debian's published qcow2 through EDK2 and
   GRUB, with no extraction (tools/debian.ts only downloads; the page's machine drops its
   `kernel`/`initrd`). Measure the boot against today's direct boot. The kernel's command line is
   now GRUB's: the page's console settings (serial vs screen) move to what GRUB passes, or to EFI
   variables. Say what changes for the user.
4. **Disk in:** a local `File` as a blk backend (the device worker reads slices synchronously;
   `FileReaderSync` works in workers), next to the HTTP range backend; qcow2 or raw by magic. The
   OPFS overlay (and the EFI variables) are keyed by the base image's identity.
5. **Disk out:**
   - Just the changes: a qcow2 writer (4 KiB clusters, the overlay's block size) with a
     backing-file name and the base's SHA-256 in a header extension.
   - The whole disk: the base merged with the overlay, streamed as qcow2 (zero clusters left out)
     or raw.
   - Both are written through `showSaveFilePicker`, with a Blob download as the fallback.
     `qemu-img check` and `qemu-img compare` are the oracle.
6. **Changes in:** our qcow2 reader learns backing files. An uploaded changes file is checked
   against the base's SHA-256 (a mismatch is refused with a message a user can act on) and becomes
   the overlay, under the overlay's Web Lock.

**Tests:** EDK2 to its shell and a small UEFI-bootable disk image from `images/` (Podman) through
GRUB to a power-off, in Node and Chromium (exact steps in deterministic mode); the flash's command
set against QEMU's behavior;
the qcow2 writer's output checked by `qemu-img` (check, compare against the merged raw); a changes
file round-trip (write, export, reset, import, the file is back); a mismatched base refused. The
page: pick a file, boot, write, export the changes, then in a fresh profile the same base plus the
upload has the file. Planted bugs: a block left out of the export, a wrong backing hash accepted,
a flash write that doesn't stick.

**Check with the user first:** any dependency; changes to the tests' guests (a new test disk image
and the EDK2 build are new, not changes); the page's Debian switching to UEFI (what the user sees
changes: firmware and GRUB before the kernel).

**Out of scope:** a catalog of hosted images and settings (phase D), snapshots (phase C lane),
16K/64K kernels, Secure Boot, ACPI.

## Proposed first steps of the C tracks (one agent each, after phase B's kickoff or alongside)
- **Snapshots:** after phase B (docs/plans/snapshots.md), since a snapshot pins the disk.
- **Networking:** under way (M8-PHASEC-NETWORKING-HANDOVER.md).
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
  phase B adds the disk (a URL or a `File`) to `start`, and export and import messages.
- Every Chromium run: headless Playwright only, never Firefox, never `/usr/bin/chromium` except
  `--version`; every run under `timeout`, every wait bounded.
