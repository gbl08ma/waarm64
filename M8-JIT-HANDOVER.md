# M8 JIT: a browser's code in the JIT, handover (2026-10-16, later)

A side track of M8, asked for by the user: make general and "complex app" work (a browser in the
guest) faster and smoother. Not a milestone phase; no kickoff. How things work is in docs/jit.md
("Compile policy", "Sharing", "Memory"), docs/abi.md ("JIT") and docs/v8.md; the measurements are at the
ends of `bench/boot/REPORT.md`, `bench/apps/REPORT.md` and `bench/interp/REPORT.md`; what's open is in
docs/backlog.md "Interpreter" and "JIT". The previous handovers of this track (the block interpreter and
arenas, 2026-10-09; V8's GC stalls, 2026-10-15; where a busy vCPU's time goes, 2026-10-15) are in git history;
their lessons are below.

**Done last (2026-10-16): the `Vcpu`'s fixed offsets within V8's reach** (queue item 1; `bench/boot/REPORT.md`
"M8: the `Vcpu`'s fixed offsets within V8's reach", data in `bench/boot/results/m8-tlbc/`; docs/jit.md "Functions",
"Loads and stores"). The TLB arrays are interleaved by index (`Tlb::e[index].0[array]`, a 128-byte line), `jit::State`
and the TLB's scalars sit before the arrays, and the transfer cache's index has 0x80000 ORed in: every fixed offset JIT
code loads is under 0x800 (asserted), where V8 had built 0x10540-0xa0db0 with `mov`+`movk` (2.4% of the hottest
Firefox functions' instructions). Gates −0.4 to −0.9% (under the noise, same sign everywhere), Firefox even, the core
62 KB smaller. The audit the user asked for (other state at inconvenient offsets) found only these: the rest of the
32-bit constants in hot code are `jc + constant` for keys known at compile time (inherent), and RAM's base appears only
with the MMU off.

**Before that:** warm members (`jit::Config::warm`, 16; Firefox busy MIPS 119 → 141), after finding that 26% of a busy
vCPU stalls on a guest function's first instruction, 83% of it after a `return_call_indirect`.

**The user's view (2026-10-16):** browsing in the desktop guest feels 1.5-2× faster since warm members, the compile
worker and the vCPU workers' return to their event loop, more than busy MIPS and the page loads showed. The session's
numbers understate interactive gains (they don't measure latency to input or frame pacing while a page is busy):
don't drop a lever only because its busy-MIPS gain is small, and consider a responsiveness measure (input-to-frame
latency during a page load) if a lever's case rests on it.

**The task: the user's queue (2026-10-15), in order.**

1. **Fewer, larger modules for a browser** (backlog): ~14,500 modules of ~35 blocks a session. First split them by
   what emitted them and by size; then the step budget and a module minimum.
2. Later (backlog "Indirect transfers into a browser's code"): returns through the host's own call/return, re-emitting
   hot regions whose jump-cache targets got compiled, smaller slow arms, per-module eviction, Liftoff's zero-fill.

## How to measure (`tools/`: `bench/boot/results/m8-warm/tools/`)

- **The session:** `PHASES=pages TIMELINE_ALL=1 node bench/gpu/firefox-load.ts virgl target/archarm/desktop.qcow2
  <outdir>` (~380 s of pages, ~750 s in all with the boot and Firefox's start: background, `timeout 900`, under `systemd-run --user --scope -p
  MemoryMax=10G -p MemorySwapMax=0`; nothing else Chromium-heavy beside it); busy MIPS from `node bench/gpu/stalls.ts
  <outdir>/pages-all.timeline.json`; `results.json`'s `jit` has the wasm bytes, modules, flushes. A/B: core builds
  swapped (`tools/abw.sh`, `cmp` before each run), two sessions each at least, alternating.
- **Gates:** `tools/tpw.sh` (`smp_alpine_jit`, `smp_user_jit_4`, alternating, three rounds).
- **Where inside guest code:** `tools/run-jd.sh` (`--perf-prof`: a 10.8 GB jitdump; `perf record -k mono`), then
  `perf script -F tid,time,ip,dso --ns` and `jd` (samples resolved by time); `run-regs.sh` and `jdr` add x16/x17/LR at
  entries. The `--perf-prof` sessions leave V8's isolate logs in the working directory, and busy MIPS fall ~10%.
- Counters per phase without new ABI: `Table::helper_report` lines (below, "Learned").

## Learned (this track)

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
- **A shell `rm` of `$VAR/*` is refused by the harness's safety check:** write `"${VAR:?}"/…` or a
  literal path.
