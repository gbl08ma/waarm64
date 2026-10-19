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

**Next (for the user to choose; the backlog's "Carrying the hot set across a flush, by default"):**
1. **Replay less** (only what was marked, not the closure up to half the budget): the pages session's extra bytes
   and flush. Measure: the pages session (flushes, wasm, the 60 s after each flush) and the steady WebGL run with
   `diag.patch` (below), carry against the default, two each, alternating.
2. **Emit outside the cache's lock**: the carry's remaining ~5 s dip is the replay's emitting on the vCPUs while
   the others wait at their misses; it would also let the replay make 512-region modules ("Fewer, larger modules").
3. **The mark's cost**: mark only while a probe runs.
4. Then default on, if the gates and Firefox's busy MIPS stay within noise.
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
