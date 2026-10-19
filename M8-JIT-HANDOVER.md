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

**Next (the user's choice, 2026-10-19, in this order; the backlog's "Carrying the hot set across a flush, by
default"):** build and unit-test in a cloud session, measure on the dev VM (a cloud session can't time anything:
hand the measurements back here, as below).

**Why emitting blocks the vCPUs today** (read at 9058822): the compile worker (`web/jit-compile-worker.ts`) only runs
V8's `new WebAssembly.Module(bytes)` and posts the module; it has no core instance. Everything before that runs on
the vCPU that missed, under the cache's one `Mutex` (`Jit::miss`, core/src/jit/mod.rs ~1901): `emit_if_due` →
`replay()`/`rebuild()` or `plan()` forms the regions from guest code, and `Cache::install` allocates slots, writes the
tier words, resolves imports against `map`, runs the codegen (`block::module`) and calls `env.jit_compile`. Every
vCPU takes that lock at each jump-cache miss, `sync` and tier-up, so while one emits the others queue. A replayed
region costs ~20 µs to emit (the unpaced replay: ~58,000 regions in ~1.2 s, `bench/boot/REPORT.md`), so a paced
64-region module holds the lock ~1.3 ms of every 4 ms (`REPLAY_BATCH`, `REPLAY_GAP_NS`): the carry's remaining ~5 s
dip and the pages session's 20-57 ms stalls. Nothing makes this fundamental: emission needs only guest memory
(`Mem`), a snapshot of `map`, `cfg`/`features`/`xmiss` and the slots; it reads no TLB or other per-vCPU state (the
`&mut Table` in `install` is used for stats and the one-time `miss_functions`). It sits at the miss because it did in
M5; the compile worker (ABI 36) came later, for V8's GC stalls only.

1. **Replay less**: only what was marked, not the closure up to half the budget. It's cheap, independent, and the
   only one of these that answers the pages session's extra 25% of wasm and its third flush.
2. **Emit outside the cache's lock** (snapshot and commit). Under the lock: take the batch, allocate its slots,
   record `epoch`, the `ival_log` position and the imports chosen. Unlocked: form the regions and emit. Relock and
   commit: discard the module if `epoch` moved (a flush, `IC IALLU`); drop regions whose pages are in `ival_log`
   since the snapshot (self-modifying code) or whose imported keys no longer map to the same index. Wasted slots are
   harmless. The other vCPUs then stop queuing behind an emit. With the lock no longer the limit, the replay can make
   512-region modules ("Fewer, larger modules").
3. **Move the replay's emission to the compile worker**: give the worker a core instance on the shared memory, the
   vCPU workers' pattern (`web/vm.ts` `threadAlloc`, `instantiateThread`; plus `spill` and a counters slot), and a
   new core export for its emit loop (an ABI bump, docs/abi.md first). It runs steps 2's snapshot and commit from the
   worker. Then it can also compile its own bytes, without `jit_compile`'s copy. This takes the emitting vCPU's
   remaining ~0.3 s a second (~7% of 4 vCPUs) off the vCPUs. The estimate, not yet measured: the steady WebGL run's
   worst second near the 31-34 frame baseline, against the carry's 18 today.
   - **Determinism:** with no emitter (round-robin, Node's deterministic runs, `?jit=nocw`), emission stays inline,
     as `jit_compile` returning 0 does today. So `tests/steps.txt` and the exact-step boots don't move.
   - **Tests:** test the asynchronous path natively with a Rust thread under the parallel runner and
     `scripts/tsan.sh`. Plant bugs for the commit's three discard rules: epoch moved, page invalidated, import
     remapped.
   - **Normal (non-replay) compiles** move to the worker only if the pages session then shows their emitting in
     stalls. The diag build put them at ~80 ms of emitting a second right after a first flush, much less in steady
     state. The protocol would be the same.
4. **The mark's cost**: mark only while a probe runs (the 2% on `smp_user_jit_4`).
5. Then default on, if the gates and Firefox's busy MIPS stay within noise.

**What the dev VM measures after the cloud's work** (the cloud hands this back here):
- The steady WebGL run with `diag.patch`, and the pages session (below): the default against the carry, two each,
  alternating, after steps 1, 3 and 5.
- `flushes.ts`: the slow phase, the frames, wasm bytes, flushes per session.
- vCPU stalls ≥ 20 ms, `overdue`.
- The gates (`tools/tpw.sh`), and the 4-vCPU `go build` loop.
- `scripts/ci.sh` and `scripts/ci-debian.sh`.

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
