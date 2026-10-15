# M8 JIT: why a busy vCPU runs at ~115 MIPS on a desktop, handover (2026-10-15)

A side track of M8, asked for by the user: make general and "complex app" work (a browser in the
guest) faster and smoother. Not a milestone phase; no kickoff. How things work is in docs/jit.md
("Compile policy", "Sharing", "Memory"), docs/abi.md ("JIT") and docs/v8.md; the measurements are at the
ends of `bench/boot/REPORT.md`, `bench/apps/REPORT.md` and `bench/interp/REPORT.md`; what's open is in
docs/backlog.md "Interpreter" and "JIT". The previous handovers of this track (the block interpreter and
arenas, 2026-10-09; V8's GC stalls, 2026-10-15) are in git history; their lessons are below.

**Done last (2026-10-15):** the vCPU stalls of 100-800 ms with Firefox were Oilpan's sweep, forced on a
vCPU thread by V8's next major GC because a vCPU worker never returned to its event loop. Each worker now
returns every 100 ms (`web/vcpu-worker.ts` `yieldMs`, `?vyield=0` off): no stall of 100 ms or more in
two pages sessions, the longest 54 ms, throughput within noise (`bench/boot/REPORT.md` "M8: V8's GC on
the vCPU threads"). What remains there is the wasm code GC (backlog "The wasm code GC stops every vCPU").

**The task:** the backlog's first JIT item, "Why a busy vCPU on a desktop runs at ~115 MIPS". The user
sees 300-400 MIPS in desktop use against 1000+ in benchmarks. The timelines say half of that is idle
time and half is real: inside `vm_run_cpu` a vCPU retires 106-127 MIPS, against 600-800 for the
userspace benchmark's phases on one vCPU. DSB and lock waits are 0.5%, compiles 2%. Find where a busy
vCPU's time goes in Firefox's pages session, rank the levers, and build the best one.

## Suspects

- **Hot code still in Liftoff.** V8 tiers a function up once its own budget runs out; a browser
  spreads its time over hundreds of thousands of regions (14,079 modules, 503,158 blocks in a
  session). Pages can't set tiering flags. Indirect levers: fewer, larger modules (the batch
  thresholds, `BATCH_STEPS`; docs/jit.md "Compile policy"), loop regions (a back-edge spends the
  budget faster), TurboFan code surviving flushes (V8's cache keeps a module's tiered code while a
  module with the same bytes lives).
- **The block interpreter.** 2.2% of the steps but ~17× slower than JIT code (the RAM-load loop
  26.5 vs 1.5 ns): up to a quarter of the time. "95% in the JIT" on the status bar counts steps.
- **What a desktop does that benchmarks don't:** ~2,400 syscalls and ~1,300 IRQs a second a vCPU,
  TLB refills after context switches, transfers that leave a function (returns, indirect branches,
  a callee in another batch), helpers.

## How to measure

1. **A host `perf` profile of the session's vCPU threads, split by tier and category**:
   `bench/apps/perf.ts` (Liftoff, TurboFan, the core's interpreter and helpers, V8's builtins and
   compiles); `bench/apps/chromium.ts --perf N` shows how it was taken for Chromium in Debian.
   `perf_event_paranoid` is 2: profile your own processes; V8 needs `--perf-prof` through
   `--js-flags` (`CHROMIUM_ARGS`). Keep `perf record` data in `bench/results/local/` (`/tmp` is a 6.9 GB tmpfs).
2. The timelines give a busy vCPU's MIPS: `node bench/gpu/stalls.ts <outdir>/pages-all.timeline.json`
   (steps over the time inside `vm_run_cpu`; 112-119 in the four sessions of the last A/B).
3. Counters per phase without new ABI: `Table::helper_report` lines (below, "Learned").

The session: `PHASES=pages TIMELINE_ALL=1 node bench/gpu/firefox-load.ts virgl target/archarm/desktop.qcow2 <outdir>`
(~400 s plus ~70 s of boot: background, `timeout 900`, under `systemd-run --user --scope -p MemoryMax=10G
-p MemorySwapMax=0`; nothing else Chromium-heavy beside it). A/B as before: two sessions each at least,
alternating; a host-side switch through `QUERY=` (the page's query), a core through swapped
`webpc_core.wasm` files (`cmp` before each run). Throughput gates, alternating: `--only smp_alpine_jit`,
`--only smp_user_jit_4` (`bench/run.ts --page bench/boot/index.html`, `--query=` for switches;
`bench/results/local/gc/tp.sh` is a ready loop); for a browser's warm code `bench/apps/chromium.ts`.

**Done when:** the busy vCPU's time is attributed (shares that sum to ~100%), the largest lever is built
or measured and kept in "Tried and not kept", and the pages session's busy MIPS moved with the gates
within noise.

## Learned (this track)

- **A vCPU worker that never returns to its event loop starves Blink's tasks**: Oilpan's sweep then
  lands on the vCPU at V8's next major GC (100-800 ms). Anything else posted to those threads
  (V8's foreground tasks) waited the same way; the yield (`yieldMs`) runs them now.
- **Tracing a page session:** `--trace-startup` writes protobuf unless `--trace-startup-format=json`;
  Oilpan needs `cppgc,disabled-by-default-cppgc`; `tdur` (thread CPU) tells work from waiting. Each
  worker's `performance.timeOrigin + now()` differs by up to ~400 ms: join threads through a shared
  event (`bench/results/local/gc/join.mjs` with `SHIFT`, ad hoc).
- **Steps are published per 32,768-step chunk**: a timeline "stall" is a chunk that took that long,
  and every counter in it (DSB, lock, compile ns) shows only at the chunk's end.
- **A microbenchmark that doesn't reproduce the stall can still clear suspects** (the never-yielding
  worker cleared `performance.now()`, Atomics and dying modules in minutes); then build the fix
  behind a switch and A/B the real session rather than chase the last object type.
- **`../webpc-base/target` is a symlink to this checkout's `target`:** a build there overwrites
  this checkout's `webpc_core.wasm` (hard-linked). Rebuild here after building there.
- **`scripts/build-wasm.sh` is incremental and fast (~4 s for a small change):** check the file's
  time or `cmp` it against your saved copies rather than trusting the build's duration.
- **A Node gain may not reach Chromium** (scalar `UQSUB` inline: compress −9.5% in Node, nothing
  measurable in Chromium). Confirm in Chromium before claiming; Node boot profiles also vary by a
  few percent between identical runs.
- **Four concurrent guests slow down by themselves on this host** (4 P-cores + 6 E-cores): four
  independent 1-vCPU VMs ran Lua 3–6%, SQLite 11–15%, compress 22% slower than one alone. Compare
  N-vCPU runs with N-vCPU runs.
- **A synthetic latency win can be nothing on the real workload**: the early chunk end took 17% off
  a busy vCPU's ping and nothing off Firefox (2026-10-15). Judge by the Firefox session.
- **In round-robin SMP one JIT cache serves every vCPU**, each with its own TLB: state derived from
  the cache but kept per vCPU must notice the cache's changes per vCPU (`Cache::drops` against
  `Tlb::xdrops`; a one-shot flag was consumed by whichever vCPU ran next).
- **Code read twice can differ on parallel vCPUs**: read guest code once per decision. A repeated
  boot loop (500 boots in ~5 min) is what finds such races; CI only sometimes.
- **Debugging a bad table index** (a "function signature mismatch" in a worker): dump every index
  the vCPU's JIT state can call (jump cache, hot-word redirects, transfer cache) at the trap and
  test each against the worker's table.
- **Diagnostic counters without new ABI:** append `<letter>:<n> <count>` lines to
  `Table::helper_report` (patches in `bench/boot/results/m8-userprof/`, `m8-entries/`, and
  `m8-devlat/generic-count.patch`); `bench/boot/userprof.ts` prints them per phase.
- **A test that waits for a shell should never match the console's end** (`trim.test.ts` failed 1
  in 40 under load until it counted prompt lines).
- **LLVM deletes an `alloc`/`dealloc` pair nothing uses:** pass the pointer through
  `core::hint::black_box`.
- **`/tmp` is a 6.9 GB tmpfs:** keep `perf record` data and traces in `bench/results/local/`.
  `bench/run.ts --out /dev/null` writes `dev/null` in the repo.
- **`tsc` checks `bench/results/local/` too:** keep ad-hoc `.ts` in the scratchpad while CI runs.
  `scripts/ci.sh` runs native tests from the working tree: don't edit `core/` while it runs.
- **The Mac host shares its cores with the VM:** run nothing there during CI or a VM benchmark; a
  failed page leaves `bench/run.ts` and Chrome for Testing idle there (`ssh macmini.lan 'ps -axo
  pid,command | grep -E "bench/run.ts|ms-playwright"'`).
- **Read CI's result before committing or pushing** (`aee50b9` went out with a failed run). A test
  that fails only under CI's load isn't reproduced by running it alone; re-run CI and compare with
  the build before (`../webpc-base`).
- **Input timed by steps is wrong in parallel mode**: the vCPUs' summed steps say nothing about
  how far the boot is; wait for the prompt.
- **Copying rounds of A/B JSON into one directory:** prefix each round, or the second's file
  overwrites the first's.
- **The block interpreter's counts decide the JIT's regions:** forward regions take only the
  pending batch's blocks, so anything that changes *when* a block joins the batch changes the
  regions (lever 4 does). Reporting dispatches 16 at a time scattered a path's blocks over batches:
  30% more, smaller regions, Alpine 8% slower. Check `blocks` against `regionBlocks` in a run's
  counters whenever the batching changes.
- **Decoded blocks must not follow the JIT's dropped keys:** they're dropped by page from
  `Cache::ival_log`, which every IC feeds and flushes don't touch (65,536 entries; Chromium's V8 in
  the guest issues ~3,000 ICs a second).
- **The block interpreter natively:** with `jit` ≠ 0 the native dispatcher runs everything in it
  (no wasm engine), so `WEBPC_NATIVE_JIT=1 cargo test --release --test <t> -- --ignored` checks it
  on every native guest with exact steps in seconds.
- **Browser workloads drift within a session and ~10% between sessions:** always run the baseline
  in the same session, alternate (≥4 pairs for `bench/apps`), and report the pairs.
- **A boot and a hot phase want different thresholds without any cache pressure:** a low one
  compiles the boot's run-once code (V8's compile not paid back), a high one leaves a phase's new
  code interpreted for hundreds of dispatches.
- **The core's heap is 1 GiB** (`HEAP_RESERVE`): per-table structures must be budgeted per VM.
- **A Python edit that replaces `s[s.index(a):s.index(b)]` with an end marker that occurs earlier
  replaces the empty string**, i.e. inserts between every character: assert the slice is non-empty
  (it wrecked `jit/mod.rs` once; restored from git).
- **A shell `rm` of `$VAR/*` is refused by the harness's safety check:** write `"${VAR:?}"/…` or a
  literal path.
