# M8 JIT: a browser's code in the JIT, handover (2026-10-16, evening)

A side track of M8, asked for by the user: make general and "complex app" work (a browser in the
guest) faster and smoother. Not a milestone phase; no kickoff. How things work is in docs/jit.md
("Compile policy", "Sharing", "Memory"), docs/abi.md ("JIT") and docs/v8.md; the measurements are at the
ends of `bench/boot/REPORT.md`, `bench/apps/REPORT.md` and `bench/interp/REPORT.md`; what's open is in
docs/backlog.md "Interpreter" and "JIT". The previous handovers of this track (the block interpreter and
arenas, 2026-10-09; V8's GC stalls, 2026-10-15; where a busy vCPU's time goes, 2026-10-15) are in git history;
their lessons are below.

**Next (2026-10-19, the user's call): replay the hot set after a flush, built in a cloud session; the dev VM
measures it.** The user finds budget flushes the main cause of stutters with heavy guest software (a browser's
video, music and WebGL stutter at each, sometimes two flushes in a row) and wants them gone at minimal
steady-state cost, a bigger budget only as a last resort. Per-module eviction couldn't do it (docs/backlog.md
"Per-module eviction"; branch `evict-generations`, not merged; `bench/boot/results/m8-evict/` README "Rechecked"):
about half the regions are idle at Firefox's flushes, but nearly every module holds one in use and V8 frees a
module only whole. So the cache now relocates regions instead, first at the flush itself: with `?jit=replay`
(`VmConfig.jit` 5, ABI 41) a flush for room compiles the regions that were in use before it again at once
(docs/jit.md "Replay after a flush"). The signal is the evict branch's mark per dispatch (which the user judged
cheap enough to keep: the branch's sessions were even on busy MIPS) and its probe at 7/8 (jump and transfer
caches cleared, so code reached through them comes back to the dispatcher); each region keeps a recipe (its
blocks' key and VA, how it was formed, its direct links) that forms it again from the code as it is now; the hot
set is the regions marked since the probe plus what they link to directly, in slot order (links become imports
again), capped at half the budget, compiled a module at a time while the compile worker has at most 4 left to
compile (a table waiting a second for it compiles itself). Off by default until measured.
- **What the cloud checked** (counts, no timings): `scripts/ci.sh` (below), JIT-replay (a 16 KiB cache with the
  checker) on the bare-metal tests, round-robin and parallel; the unit tests, with three planted bugs caught (the
  marks not carried across `drop_all`, a forward and a loop recipe swapped, the closure over links dropped).
  Buildroot's JIT-replay tests (1, 2, 4 vCPUs and parallel on 4) were added but need the images: **run them first**
  (`node --test --test-name-pattern=JIT-replay tests/boot-node-linux.test.ts tests/boot-node-parallel.test.ts`).
  Debian on the page with the budget cut to 24 MiB (a local edit, not committed; 4 vCPUs, to the login prompt):
  both builds flushed twice in the boot; with replay each flush compiled ~9,200 regions (~12.3 MiB, the cap: the
  boot's hot set is larger than half the budget) in ~18 modules of 512, `overdue` 0, 2,164 modules in all against
  2,453, the interpreted steps the same (0.40G: a boot's code mostly runs once, not the case replay is for).
- **The dev VM's measurement, the user's question being the stutter:** Firefox's pages session (the "How to
  measure" below) with `QUERY=jit=replay` against the default, two each, alternating (`QUERY`, which
  `bench/gpu/firefox-load.ts` adds to the page's query). Read
  per flush: how long the slow phase lasts and what it costs in frames (the per-second `fps`, `maxms` around each
  flush), busy MIPS over the session, flushes per session (replayed code fills part of the new epoch: does the next
  flush come sooner?), `results.json`'s `jit` (`replays`, `replayed`, `replayedBytes` are new; the modules too, for the backlog's "Fewer, larger
  modules": replay emits 512 regions a module and its loop regions with no tier-up module), vCPU stalls ≥ 20 ms
  (the replay's compile burst goes to the worker: `overdue` must stay 0). Then the gates (`tools/tpw.sh`) only to
  confirm nothing moved (they never flush). The 4-vCPU `go build` loop of `bench/stress` is the second workload.
- **Knobs if it helps but not enough:** `REPLAY_MAX` (4 eighths; at Debian's boot flushes the hot set filled it),
  `PROBE_AT` (7), the window (since the probe, 16-50 s in Firefox: a sweep every few seconds with the jump caches
  cleared again would make "in use" more recent, at the cost of more dispatcher trips), the flush's doubling of
  the threshold's floor (`Cache::flush`; replay may make it unnecessary), `REPLAY_AHEAD`.
- **If it doesn't help enough, the next step is compacting before the flush**, which this is built to grow into:
  at the probe's end, compile the hot set from the recipes into a second slot range while the old epoch keeps
  running, and let each table switch to it at its dispatcher (the flush becomes a switch: no interpreted phase,
  no V8 compile on the critical path). What it needs beyond replay: slots for two epochs (capacity, the hot words,
  the marks), tables installing the next epoch's modules before switching, the log and `Seen` per epoch, and the
  host's `env.jit_release` (the evict branch's) to null the old epoch's slots once every table has switched.

**Before that (2026-10-18, a cloud session): the integer NEON, structures and CRC32 compiled** (docs/jit.md "NEON →
SIMD128", "NEON lane by lane", "Structures"; branch `claude/project-thread-fcaq73`). A profile of image decoding in
the guest's Firefox and Chromium (counts only, no timings in the cloud) had decoders' NEON as helper calls, 9% of
Firefox's guest instructions on a JPEG page (SMLAL by element in Skia's downscaler above all). Now the allocated
integer NEON is inline except SUQADD/USQADD on 64-bit lanes, URECPE/URSQRTE and the unadvertised dot products and
RDM. Measured on the dev VM (`bench/boot/REPORT.md` "M8: the integer NEON inline", data in
`bench/boot/results/m8-neon/`): `scripts/ci.sh` passed with all images; the guest's browsers decode images 1.4-4.3×
faster (2.48× geometric mean over Chromium and Firefox, JPEG, PNG, WebP, AVIF; `bench/imgdecode/`), helper calls
1-12% → 0.1-0.4% of their instructions; the gates even (boot within 0.7%, userspace −2.0%). What still runs through
helpers there is load/store slow paths, YIELD and system instructions (docs/jit.md "What still runs through helpers").

**Before that (2026-10-16): guest calls as host calls, measured and not kept** (`bench/boot/REPORT.md` "M8: guest
calls as host calls", data and the patch in `bench/boot/results/m8-calls/`; docs/jit.md "Tried and not kept"). The
user moved "Indirect transfers into a browser's code" ahead of "fewer, larger modules" (module installs are cheap
now). A profile at HEAD put returns at 42.5% of the kernel's entry stalls; BL/BLR as wasm `call`, `ret` as wasm
`return`, with the continuation an entry of the caller's region, was even on the gates (churn −11%) but in Firefox
moved the stall into the callers' bodies (guest code 61.3 → 59.6% of samples) for 23% more wasm and a third flush.
The stall is fetching cold code, not mispredicting: test that theory before re-emitting regions with direct links.

**Before that: the compile worker's modules, posted** (ABI 37; `bench/boot/REPORT.md` "M8: the compile
worker's modules, posted", data in `bench/boot/results/m8-posted/`; docs/jit.md "Sharing", docs/abi.md
`env.jit_install`). Starting queue item 2, a session with every install timed showed that four fifths of a vCPU's
install time was `new WebAssembly.Module(bytes)`, a cache hit that still decodes and validates every function. Now the
worker posts each compiled `Module` to every vCPU's host, `jit_install` takes the module's `seq` and instantiates
it, and returns −2 when it hasn't arrived yet: the table parks (`Table::parked`), the run ends early with `BUDGET`
short of the budget, and `web/vcpu-worker.ts` goes through its event loop at once. vCPU install time −76 to −82%;
gates: Alpine boot −1.3 to −1.6%, Alpine userspace −3.3% (compress, SQLite −4.6%); Firefox busy MIPS even, vCPU
stalls ≥20 ms 5-9 a session → 0-3.

**Before that: the `Vcpu`'s fixed offsets within V8's reach** (queue item 1; `bench/boot/REPORT.md`, data in
`bench/boot/results/m8-tlbc/`): the TLB arrays interleaved by index, `jit::State` and the TLB's scalars before the
arrays, the transfer cache's index ORed with 0x80000; every fixed offset JIT code loads is under 0x800 (asserted).
Gates −0.4 to −0.9%, Firefox even, the core 62 KB smaller. The audit the user asked for (other state at inconvenient
offsets) found only those; the other 32-bit constants in hot code are `jc + constant` for keys known at compile time.

**Before those:** warm members (`jit::Config::warm`, 16; Firefox busy MIPS 119 → 141), after finding that 26% of a busy
vCPU stalls on a guest function's first instruction, 83% of it after a `return_call_indirect`.

**The user's view (2026-10-16):** browsing in the desktop guest feels 1.5-2× faster since warm members, the compile
worker and the vCPU workers' return to their event loop, more than busy MIPS and the page loads showed. The session's
numbers understate interactive gains (they don't measure latency to input or frame pacing while a page is busy):
don't drop a lever only because its busy-MIPS gain is small, and consider a responsiveness measure (input-to-frame
latency during a page load) if a lever's case rests on it.

**The task: the user's queue (2026-10-15; reordered 2026-10-16), in order.**

1. **Indirect transfers into a browser's code** (backlog): returns as host returns tried and not kept (above). Left:
   whether a direct tail call into cold code stalls as an indirect one does (`chain.mjs` with the targets' code
   evicted from the caches); only if direct links are clearly cheaper there, re-emitting hot regions whose
   jump-cache targets got compiled. Smaller slow arms and Liftoff's zero-fill (less code) are the other items.
2. **Fewer, larger modules for a browser** (backlog, rescoped): 82% of the ~14,500 modules are tier-ups; an install
   now costs a vCPU ~0.06 ms, so measure what the module count costs in RSS and in the wasm code GC's stops first,
   and only then try tier-ups that wait for company. The pages session records no host memory yet (`results.json`'s
   `info` is the guest's `free`): first sample the renderer's `VmRSS` (`/proc/<pid>/status`, the Chromium process
   with `--type=renderer`) through the session, next to `jit.modules`.
3. Per-module eviction: now first, above ("Next").

## How to measure (`tools/`: `bench/boot/results/m8-warm/tools/`)

- **The session:** `PHASES=pages TIMELINE_ALL=1 node bench/gpu/firefox-load.ts virgl target/archarm/desktop.qcow2
  <outdir>` (that disk is Arch Linux ARM's, every number so far is on it: keep it for A/B. The Arch images moved to
  arch.bens.haus's port on 2026-10-16, `images/arch/desktop.sh` → `target/arch/desktop.qcow2`, whose kernel lacks
  `DEBUG_PREEMPT` and whose user is `arch`, not `alarm`: run the session on the old disk with `WEBPC_GUEST_USER=alarm`;
  re-baseline on the new disk before comparing across it) (~380 s of pages, ~750 s in all with the boot and Firefox's start: background, `timeout 900`, under `systemd-run --user --scope -p
  MemoryMax=10G -p MemorySwapMax=0`; nothing else Chromium-heavy beside it); busy MIPS from `node bench/gpu/stalls.ts
  <outdir>/pages-all.timeline.json`; `results.json`'s `jit` has the wasm bytes, modules, flushes. A/B: core builds
  swapped (`tools/abw.sh`, `cmp` before each run), two sessions each at least, alternating.
- **Gates:** `tools/tpw.sh` (`smp_alpine_jit`, `smp_user_jit_4`, alternating, three rounds).
- **Where inside guest code:** `tools/run-jd.sh` (`--perf-prof`: a 10.8 GB jitdump; `perf record -k mono`), then
  `perf script -F tid,time,ip,dso --ns` and `jd` (samples resolved by time); `run-regs.sh` and `jdr` add x16/x17/LR at
  entries. The `--perf-prof` sessions leave V8's isolate logs in the working directory, and busy MIPS fall ~10%.
- Counters per phase without new ABI: `Table::helper_report` lines (below, "Learned").

## Learned (this track)

- **Per-table fields in `Seen` vanish at every flush and `IC IALLU`**: `Cache::drop_all` rebuilds each `Seen` from
  `Seen::default()` keeping only `ival`. A field added there (a pointer to the table's marks, say) must be carried over
  explicitly, or everything after the boot's first IALLU reads nothing; check a diagnostic against a case whose answer
  you know before trusting it (step 1's "90% cold" was install age).
- **`vm::Counters` are summed over the tables by the host**: a diagnostic value written into one table's `Stats`
  comes back as the sum over the tables that wrote one. Log lines (`helper_report`'s extra text, as
  `devvm/recheck/recheck.patch` does) say which table and when.
- **A module's coldness isn't a region's**: half of Firefox's regions sat idle at a flush, but almost every module had
  one in use. Measure at the granularity that frees memory (V8 frees a module only whole).

- **Where a sample lands inside JIT code says what stalls**: a timer sample blames the oldest instruction not
  retired, so a function's first instruction collects the frontend's waits for its code (compare with the core's own
  functions as a control: 0.2-1% at entry). V8's registers at the entry tell how it was reached (x16 = the signature
  after a `call_indirect`, x17 = the target of a tail call).
- **Indirect tail calls cost what direct ones don't in a large footprint** (`chain.mjs`: 37 against 18-22 ns at
  32,000 functions); a module-local table didn't help (35 ns). Imports of another module's functions are as cheap as
  direct calls.
- **A JS `&` is signed**: `(w & 0xfc000000) === 0x94000000` is never true; `>>> 0` first.
- **The guest kernel's symbols for the desktop image**: `System.map` from `/usr/lib/modules/*/build` (the headers are
  installed) and `Image` from the ESP (`mcopy -i <raw>@@1048576 ::/image`); the kernel isn't randomized there.

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
- **An arm64 `ldr` folds offsets up to 32,760 (8 bytes), 65,520 (`q`), 4,095 (a byte):** past that V8 builds the
  constant with `mov`+`movk` at every use. Count such pairs in a hot function's disassembly (`ann.sh`) by the value
  they build; a timer profile won't show them (they retire at once).
- **A Firefox session lasts ~750 s with its boot here:** an outer `timeout` under that kills the A/B loop and leaves
  the session running; run `abw.sh` in the background without one (its own `timeout 900` bounds each session).
- **The A/B loops leave the last build they copied in `target/`, newer than the sources:** cargo won't rebuild it.
  Copy the build you mean back (and `cmp`) before CI.
- **`new WebAssembly.Module(bytes)` validates the whole module even on a cache hit** (~6 µs a KB on the M4): pass
  compiled `Module` objects between workers (postMessage shares the code) rather than bytes for a second compile.
- **A host change that both builds of an A/B share needs a baseline built against it:** a core of the old ABI under
  the new host fails (the gates' first run did). Build the baseline from the new source with the mechanism switched
  off (`d0`: the table always passing seq 0).
- **The page's paths aren't the only ones:** round-robin, Node's deterministic runs and user-mode vCPUs have no
  compile worker (every module's `seq` 0). A "parked on seq" check without excluding 0 parked them all for good; the
  gates and Firefox (always with a worker) couldn't see it, CI's lockstep and bare-metal tests did. Run
  `tests/jit-lockstep.test.ts` and `tests/jit.test.ts` on any change to installs before measuring.
- **The Firefox sessions' `slow` lines are a cheap per-install probe:** `SLOW_INSTALL_MS = 0` in `web/vm.ts` logs
  every install (57,000 a session, 8.8 MB of `results.json`) without perturbing busy MIPS.
- **A shell `rm` of `$VAR/*` is refused by the harness's safety check:** write `"${VAR:?}"/…` or a
  literal path.
- **A `--perf-prof` session changes block signatures' ids in V8** (x16 at an entry is the canonical signature id): a core
  whose block type changed (here a fourth parameter: `0x8000004` for `0x8000003`) needs the tools' constant changed
  (`ktarget`, `land`), or every entry looks "direct".
- **A stall that a profile moves isn't a stall removed**: compare the guest code's total share, not only the entry
  share (host returns took 4 points off the entries and put them in the bodies).
- **The A/B loops leave their last build in `target/`**: a profiled run that `cmp`s its build first refuses to start
  rather than measuring the wrong core.
