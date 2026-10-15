# M8 JIT: V8's GC stalls on the vCPU threads, handover (2026-10-15)

A side track of M8, asked for by the user: make general and "complex app" work (a browser in the
guest) faster and smoother. Not a milestone phase; no kickoff. How things work is in docs/jit.md
("Compile policy", "Sharing", "Memory") and docs/abi.md ("JIT"); the measurements are at the ends of
`bench/boot/REPORT.md`, `bench/apps/REPORT.md` and `bench/interp/REPORT.md`; what's open is in
docs/backlog.md "Interpreter" and "JIT". The previous handover of this track (2026-10-09: the
block interpreter, the pressure threshold, the arenas) is in git history; its lessons are below.

**The task:** the backlog's first JIT item, "What V8's GC still stops a vCPU for". With Firefox
loading pages on the desktop guest, a vCPU still freezes for 100-230 ms a few times a session, and
the cause is V8's garbage collection running on the vCPU's own thread. The user feels these freezes
as jank. Find what feeds it, cut it, and show it on the same Firefox session without losing
throughput.

## Why this item (2026-10-15, after the device round-trip work)

- Copies, MMIO and the device worker were measured and aren't levers (`bench/boot/REPORT.md` "M8:
  the device round trip, MMIO and copies"). Ending a busy vCPU's chunk early for its interrupts
  was tried and not kept (docs/jit.md "Tried and not kept").
- What Firefox drops in video is the guest's CPU (plans/video.md §6), and the cold-code pipeline
  is the other big cost. That needs a fresh profile before choosing a lever (below, "After this").
- The GC stalls are measured, attributed and have concrete levers. They are tail latency, not
  throughput: the stalled time is already small (0.4-0.7 ms a second a vCPU) but single stalls
  reach 182-224 ms.

## What is known (`bench/boot/REPORT.md` "M8: the JIT's compile worker")

Baseline, the committed core (`eefaad8`), with the compile worker on (`results/m8-compile-worker/firefox/`,
`cw-*.json`, `stalls.json`). Firefox's pages session is ~400 s with 4 vCPUs; the second figure in
each cell is the second session:

| | MIPS | vCPU stalls ≥ 20 / 50 / 100 / 250 ms | longest | stalled ms a second a vCPU | all-vCPU stalls |
|---|---|---|---|---|---|
| session 1, 2 | 271, 263 | 8/3/3/0, 13/6/3/0 | 182, 224 ms | 0.39, 0.70 | none |

The session's JIT counters (`cw-1.json` `jit`): **14,079 modules, 503,158 blocks (~36 a module),
434 MB of wasm (~31 KB a module), 2 flushes, 55,818 installs from the worker** (each module goes
into each of the 4 tables), 2.2% of steps interpreted. `slow` (installs of 20 ms or more, the
`webpc-slow` lines) shows the stalls landing in **instantiation**, not compiling:
`instantiate 22.7 / 61.5 / 51.2 ms` for modules of 8, 56 and 48 functions. The exceptions are
cache misses (`compile 130.1 ms` for 229 functions, 248 KB).

The trace from before the compile worker (Chromium `--trace-startup`, categories `v8.wasm`,
`disabled-by-default-v8.wasm.detailed`, `v8`, `disabled-by-default-v8.gc`; the table is in that
report section) attributes the long ones:
- **a major GC starting at an allocation** ("allocation limit") that first waits for the last
  sweep (`GC_HEAP_ENSURE_SWEEPING_COMPLETED`): up to 986 ms then, 100-230 ms now, on whichever vCPU
  allocated (a module object, an instance);
- **the second pass of a GC's weak callbacks**: 488 ms;
- **the wasm code GC** (`ReportLiveCodeForGC`, `FreeDeadCode`): 33-58 ms, 17-38 times a thread,
  every isolate reporting its live code; dead code is Liftoff code that TurboFan replaced, and
  modules the flushes released.

## Where the garbage comes from (`web/vm.ts` `jitHost.install`, on the vCPU's thread)

Per install, ~14,000 per vCPU a session:
- `new WebAssembly.Module(bytes)`: a module object (a hit in V8's process-wide cache, since the
  compile worker compiled the same bytes; the bytes are first copied out of the shared memory into
  a reused scratch buffer);
- `WebAssembly.Module.imports(module)`: an array of descriptor objects, one per import, only to
  find the `t` imports (links to already-compiled blocks, named by table index);
- `t`, an object with a `table.get` of each link. Those calls materialize a JS function wrapper
  for every linked target;
- `{ ...imports, t }` and **`new WebAssembly.Instance`**: the instance, and its `exports` object
  with one exported function per region (`f0`…`f<n-1>`);
- `Object.keys(f)`, `` `f${k}` `` strings, and `table.set` of each export into the table.

The core's side (`core/src/jit/wasm.rs`): a module imports `env.memory`, `env.table`, core exports
by name and module `t`, and exports its functions as `f0`, `f1`, …. The table is
`core.exports.__indirect_function_table`, and slots are `base + slot`.

## Levers, in order

1. **Measure the remaining stalls first, on the current core.** Take a trace of one pages session
   with the categories above (`CHROMIUM_ARGS='--trace-startup=v8.wasm,disabled-by-default-v8.wasm.detailed,v8,disabled-by-default-v8.gc
   --trace-startup-file=<path> --trace-startup-duration=500'`; the earlier trace was taken this way,
   ~485 s, large JSON: write it under `bench/results/local/`). Join it with the timeline's stalls
   (`TIMELINE_ALL=1` rows). What share of the ≥50 ms stalls is the GC at an instantiation, the
   weak callbacks, the code GC, or nothing traced? That ranks levers 2-4, and may show one this
   list doesn't have.
2. **Install without exports: an active element segment.** The module would write its functions
   into the imported `env.table` itself, at an offset given by an imported immutable i32 global
   (`env.base`, say; the bytes stay slot-independent, so the compile worker's cache hits still
   hold). Then there is no exports object, no exported function wrappers, no `Object.keys`, no
   per-function `table.set` loop. The host passes one `WebAssembly.Global` per install, grows the
   table **before** instantiating (an active segment is bounds-checked at instantiation), and
   keeps the restart's nulling of old slots. The emitter changes (`wasm.rs`: an elem section
   instead of exports, plus a global import), so this changes the JIT ABI: bump `ABI_VERSION` (36
   now; `tests/browser.test.ts` pins it), document it in docs/abi.md "JIT", and keep the name section.
   Check in a microbenchmark first (an install loop over captured modules, as the compile-worker
   work did with `bench/mem/modules.ts`'s capture) that V8 really allocates less on that path,
   then measure the session.
3. **Less garbage for the links:** pass the `t` imports without `Module.imports()` descriptors (the
   core knows the link indexes: it could hand the host the list), and see whether the `table.get`
   wrappers matter (they're cached per function; the trace or a heap profile says). Changing how
   links are called (`call_indirect` through the table at a constant index, or typed function
   references) changes code speed and needs the full A/B; only if 1 says links are a real share.
4. **Fewer, larger modules for cold code.** Firefox's modules average ~36 blocks, against the
   512-block cap: the batch is emitted once its blocks ran 50,000 steps in the interpreter
   (`BATCH_STEPS`) or 64M steps after its first entry (`BATCH_TIMEOUT`; docs/jit.md "Compile
   policy"). Larger batches mean fewer instances and module objects (and ~16 KB of V8 metadata
   less each: docs/jit.md "Memory"), but blocks wait longer in the block interpreter. Sweep
   `BATCH_STEPS` (e.g. 2× and 4×) with stalls, MIPS and the interpreted share; the boots and the
   userspace benchmark must not lose. Earlier sweeps of batch size and timeout were before the
   block interpreter (docs/jit.md "Tried and not kept"), so they don't decide this.
5. Not in our hands: V8's tiering (Liftoff code replaced by TurboFan feeds the code GC) and GC
   flags can't be set from a page (`--wasm-tiering-budget` and the like); don't build on them.

## How to measure

The session (dev VM; the desktop image and the pages disk exist: `target/archarm/desktop.qcow2`
from `images/archarm/desktop.sh`, `target/ffpages/pages.ext4` from `bench/gpu/firefox-pages.sh`):

```sh
PHASES=pages TIMELINE_ALL=1 node bench/gpu/firefox-load.ts virgl target/archarm/desktop.qcow2 <outdir>
node bench/gpu/stalls.ts [--json] <outdir>/pages-all.timeline.json     # stalls by length, all-vCPU stalls
```

- A session is ~400 s plus ~70 s of boot, more than the Bash tool's ~600 s cap with margin. Run it
  in the background (`timeout 900`, under `systemd-run --user --scope -p MemoryMax=10G
  -p MemorySwapMax=0`) and wait for the completion notification. Nothing else Chromium-heavy may
  run beside it.
- A/B by swapping `target/wasm32-unknown-unknown/release/webpc_core.wasm` between sessions (keep
  each build's copy aside, `cmp` before each run), **alternating, two sessions each at least**.
  Firefox sessions vary (stall counts 8 vs 13 between two identical ones). A host-side change
  (`web/vm.ts`) needs no core swap: alternate the checkouts' `web/` or put it behind a page query.
  `QUERY=jit=nocw` was the compile worker's switch.
- Throughput gates, alternating in one session: `--only smp_user_jit_4`, `--only smp_alpine_jit`,
  `--only boot_alpine_jit` (`bench/run.ts --page bench/boot/index.html`; ~2 min each);
  `bench/results/local/devlat/ab.sh <round> <bench> <variants…>` is a ready A/B loop over
  `core-<variant>.wasm` files (git-ignored; copy it and change its last line, which restores this
  session's `core-kick.wasm`). For a browser's warm code,
  `bench/apps/chromium.ts` (three Chromium renders in Debian, `--wasm <file>`, ~5 min).
- An emitter change also needs the JIT's tests: `node --test tests/jit-diff.test.ts`, the lockstep
  (`tests/jit-lockstep.test.ts`), the exact-step boots (CI). Plant a bug in the new install path
  (a wrong offset) and check something fails. Then `scripts/ci.sh`, alone, in the background.
- Record it as `bench/boot/REPORT.md` "M8: …" with the JSON under `bench/boot/results/m8-<name>/`.
  Update docs/jit.md ("Sharing" or "Memory"), docs/abi.md if the ABI moved, and the backlog item:
  close it, or leave what's left. Then this handover: rewrite it for what's next, or delete it.

**Done when:** no vCPU stall of 100 ms or more in two pages sessions (the baseline has 3 each),
the longest well under the baseline's 182-224 ms, the stalled time no higher, and the throughput
gates within noise. If a lever doesn't move the stalls, keep the measurement and say why it lost
(docs/jit.md "Tried and not kept").

## After this

The next candidate is the cold-code cost in browsers: Chromium's first render in Debian is ~46 s
against ~27 s warm. Its pieces are in the backlog (transfers that leave a function, Liftoff code,
the block interpreter's generic ops, per-module eviction). The only browser profile predates the
shared cache, the pressure threshold, the arenas and the compile worker: take a host `perf`
profile of a Firefox session's vCPU threads first (`bench/apps/perf.ts` splits it by tier and
category; `bench/apps/chromium.ts --perf N` shows how it was taken for Chromium).

## Learned (this track)

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
