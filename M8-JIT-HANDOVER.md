# M8 JIT: a browser's code in the JIT, handover (2026-10-19)

A side track of M8, asked for by the user: make general and "complex app" work (a browser in the guest) faster and
smoother. Not a milestone phase; no kickoff. How things work is in docs/jit.md, docs/abi.md ("JIT host interface")
and docs/v8.md; how to measure in docs/benchmarking.md ("Firefox's pages session, the JIT's real workload", with the
lessons of this track); the measurements at the ends of `bench/boot/REPORT.md`, `bench/apps/REPORT.md` and
`bench/interp/REPORT.md`; what's open in docs/backlog.md "JIT".

**Where it stands: budget flushes.** The user finds them the main cause of stutters with heavy guest software (a
browser's video, music and WebGL stutter at each, sometimes two in a row) and wants them gone at minimal
steady-state cost, a bigger budget only as a last resort. Per-module eviction couldn't free a full cache (docs/jit.md
"Tried and not kept"). So the cache now **carries its hot set across a flush** (`?jit=replay`, `VmConfig.jit` 5,
ABI 41; docs/jit.md "Replay after a flush"): the regions in use keep running from their slots while the next epoch
takes the other half and a paced replay compiles them again, then the old half is released (`env.jit_release`).
Measured on the dev VM (`bench/boot/REPORT.md` "M8: carrying the hot set across a flush"): at a flush in steady
WebGL it removes the interpreted slow phase (worst second 18 frames against 8); in Firefox's page loads it compiles
25% more wasm and brought a third flush; the gates are even except `smp_user_jit_4` +2%. **Off by default**: not a
clear win in both workloads.

**The round after (the user's choice, 2026-10-19), built in a cloud session and counted there**
(`claude/jit-hot-set-relocation-lsq6jq`; docs/jit.md "Replay after a flush" and "Counted in the cloud"). All of it
is still behind `?jit=replay`, ABI 42:
1. **Replay less:** the queue is only the marked regions; the closure stays carried, not compiled again.
2. **Emit outside the cache's lock:** `Cache::take` (slots, a held place in the log, the module number, the epoch,
   the pinned `ival_log` position, the imports looked up), `Job::make` without the lock, `Cache::commit`
   discarding the whole module when the epoch moved, an IC named one of its pages, or an import moved. Tables
   install up to the first held place, so in slot order.
3. **The replay's emission in the compile worker:** `Emitter` (`vm_jit_emit`, `vm_jit_active`), a core instance
   in the worker, 512-region modules, one at a time once everything handed over is compiled, compiled with
   `WebAssembly.compile`. Without a worker the vCPUs emit (`?jit=nocw`, round-robin, Node); `?emitter=0` keeps the
   worker but has the vCPUs emit (the old pacing, outside the lock now), for the A/B.
4. **The mark only while a probe runs** (the probe also starts at 7/8 of the epoch's slots).
- Counters 111-123 (marked, kept, futile, released modules and bytes, locks, replay locks, emits inline and in the
  worker, discards by rule, wasted slots); `bench/boot/results/m8-replay/counts.ts` and `cloud/` (Debian at a
  24 MiB budget: the default, main's carry, this carry with the worker and with the vCPUs emitting).
- **What the counts found and fixed:** the replay's module numbers must follow the log (the host drops a worker's
  module once a later number is installed: tables waited out every replay module, 150-1,600 overdue a session);
  a link to a region of the same module isn't an import (every replay module was discarded); a table's overdue
  clock restarts when it installs something (a stream of modules isn't overdue). After them: overdue 0, parks as
  the default's, 0 discards, ~20 worker modules a carry, 29-47 modules alive once the carried slots go.

**Next, on the dev VM (time only, and the workloads the cloud can't run):**
- The steady WebGL run with `diag.patch` and Firefox's pages session: the default against the carry, two each,
  alternating; and once the carry with `?emitter=0` (the vCPUs emitting outside the lock) to split steps 2 and 3.
  Read the slow phase, the frames, MIPS, stalls ≥ 20 ms, and the new counters (results.json's `jit`;
  `flushes.ts` prints them). **`diag.patch` needs updating first:** it patched `emit_if_due` and calls `carry`
  directly, but marks now exist only during a probe, so a forced carry without one is a classic flush: start a
  probe (`self.probe()`) a few seconds before each forced flush.
- The gates (`tools/tpw.sh`), for step 4: `smp_user_jit_4` was +2% with the mark at every dispatch.
- The 4-vCPU `go build` loop; `scripts/ci-debian.sh`; the JIT-replay Buildroot tests and `scripts/tsan.sh` with
  images (the cloud ran the lib's emitter test only).
- Knobs to try if the worker's modules show as stalls: `REPLAY_MODULE` (512); the worker emits one module at a
  time, so a smaller module bounds how long a vCPU's own module waits behind it.
- Then the default-on decision (step 5): the gates and Firefox's busy MIPS within noise.

Older items of the user's queue stay in the backlog: "Indirect transfers into a browser's code" and "Fewer, larger
modules for a browser" (first: the renderer's RSS through the pages session).

## How to measure the flush (this round's tools, `bench/boot/results/m8-replay/`)

- **The steady case** (what the user hears): `diag.patch` (apply on the source, build, **restore and rebuild**
  after) forces a flush for room every 30 s from the dispatcher (carrying with `?jit=replay`, the threshold's floor
  kept without, so each is a first flush), and has each table log per second the steps interpreted in blocks the
  epoch before had compiled and in others, dispatches of blocks compiled but not installed, and the ms emitting and
  installing (`webpc-evict` lines → `<outdir>/evict.txt`). Run Firefox's WebGL page for 150 s:
  `QUERY=jit=replay WEBPC_GUEST_USER=alarm PHASES=webgl PHASE_S=150 TIMELINE=1 node bench/gpu/firefox-load.ts virgl
  target/archarm/desktop.qcow2 <outdir>` (as the pages session: background, `timeout 900`, capped), then
  `node bench/boot/results/m8-replay/steady.ts <outdir> webgl [--summary]`: per second around each flush, frames
  and longest gap, MIPS, compiled share and those counts.
- **The pages session** as in docs/benchmarking.md, then `node bench/boot/results/m8-replay/flushes.ts <outdir>...`:
  per flush the slow phase, the interpreted steps over 10 and 60 s, and the frames of the 10 s after (each page's
  `fpsAll`, lined up by `readyAt`); `results.json`'s `jit` (`replays`, `replayed`, `replayedBytes`, `overdue`).
- Its base session's first page sometimes times out (docs/backlog.md "A Firefox session whose first page times
  out"): such a session is ~650 s and doesn't count.

## Learned (this round; older lessons are in docs/benchmarking.md, docs/testing.md and docs/v8.md)

- **Don't build or run tests while a benchmark runs, even in another terminal**: a `go build` A/B ran while the
  carry was being built and tested, and its numbers were thrown away (and its script copied its last core over the
  new build at the end).
- **A session's frames come back through the serial terminal**: `run()` returns a screenful; a long `grep` must go
  through `runLines` (the WebGL phase's 150 seconds were cut to the last 72).
- **A forced flush must come from the dispatcher**: from `alloc` it also fired inside `jit_hot` (JIT code on the
  stack) and the page never booted.
