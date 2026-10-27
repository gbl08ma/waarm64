# Backlog

Open items no milestone owns yet, by area. Pick one up when a milestone touches the area or a
measurement says it matters, and move it into that milestone's plan when it's scheduled. **Add to
this list rather than leaving TODOs in code** (the code marks a few with `ponytail:`).

## CPU and ISA

- **Unadvertised extensions the M4 has**, in case real workloads benefit: FP16 (scalar and
  AdvSIMD), DotProd, RDM, FHM, FCMA, JSCVT (JS engines use `FJCVTZS`), FRINTTS, BF16, I8MM, LSE2,
  RCpc, FlagM, SB, DIT. Not MOPS (`CPYP`/`SETP` & co as a host `memory.copy`):
  copies run at 7-21 GB/s under the JIT and are under 2% of a browser's profile (`bench/boot/REPORT.md`
  "M8: the device round trip"). Each needs handlers, corpus groups (the generator
  already knows how to avoid them), the ID fields, a decoder-sweep update, a `VmConfig.features`
  bit, and the rule: advertise only if faster than what guests do without it.
- **OpenSSL's MIDR-gated paths:** OpenSSL 3.5 uses its EOR3/RAX1/XAR/BCAX Keccak only on Apple M1/M2 MIDRs and
  its EOR3 AES-GCM only on Neoverse V1/V2/N2, Cobalt 100 and Ampere (`crypto/armcap.c`); our MIDR (implementer 0)
  gets neither. Forced on through `OPENSSL_armcap`, they're **+83% on SHA3-256 and +9-10% on AES-GCM** at 16 KiB
  (`bench/boot/REPORT.md` "M9: FEAT_SHA512 and FEAT_SHA3"); GCM is TLS's. Reporting another CPU's MIDR is
  guest-visible beyond OpenSSL: Linux applies that CPU's errata workarounds and Spectre lists, glibc picks string
  functions by MIDR, and only Apple's unlock the Keccak. Needs the user's call on the identity, then an A/B of the
  long workloads with it.
- **Hardware breakpoints and watchpoints at JIT speed:** a task with one armed runs in the debug
  interpreter while it's on the CPU ([cpu.md](cpu.md) "Self-hosted debug"); pages holding a
  breakpoint could stay uncompiled and watched pages out of the TLB instead, so their accesses take
  the slow path, which would check the comparators. Only if a debugged program's speed becomes a
  concern: unarmed code doesn't pay either way.
- **Self-hosted debug's loose ends:** watchpoints on device (MMIO) accesses aren't checked (the
  MMIO path runs the instruction again on the `Io` bus, without the `Watch` wrapper).
- **Spectre-BHB reporting:** Linux says `spectre_v2` "Mitigation: CSV2, but not BHB" (and installs no
  BHB mitigation: MIDR 0 has no loop count). Only `ID_AA64PFR0_EL1.CSV2` = 3 clears it, which needs
  `SCXTNUM_EL0`/`EL1` (plain registers, `SCTLR_EL1.TSCXT` trap, JIT sysreg path, snapshot state).
- **MMU:** per-ASID stashes of nG entries (the previous ASID's are dropped at a switch; Alpine's
  boot refills ~0.3M); ~0.3M of Alpine's misses are direct-mapped conflicts; no Device-memory
  alignment faults; no address-size fault for VAs past 40 bits with the MMU off (external abort);
  PRFM with a misaligned SP base faults; cache maintenance by VA to a device PA faults.
- **Arm AARCHMRS JSON:** its in-package notice is unread (`THIRD_PARTY.md`); read it only to
  generate decoder tables or coverage checks from it.
- **Corpus depth:** thin FP flag paths (8 `fp_scalar` tests raise Divide-by-Zero); add biased forms
  when touching FP again.

## Interpreter

What the block interpreter's speed track (2026-10-21/22, `bench/interp/REPORT.md` "M8-INTERP loop 0" to "loop 11")
left open, most promising first.

- **The guest accesses' atomics on x86_64: measured, a decision left** (2026-10-26, `bench/interp/REPORT.md` "What
  the guest accesses' atomics cost on x86_64"; a cloud session, `bench/interp/paired.ts`): plain accesses make the
  block interpreter ~3-4% faster in Chromium (3.5-8% in Node) on the small guests, nearly all of it from the stores
  (`xchg` where a plain store is a `mov`); plain loads alone ~1%. So plain loads with atomic stores buy nothing worth
  their UB; the one remedy that pays is plain stores (and loads) with one vCPU or round-robin, atomics only in parallel
  SMP (the user's decision; a second copy of the access paths, or a const generic on `hot`). Not measured: what it
  is on a real workload, where the interpreter runs only cold code and slow paths under the JIT: Alpine's boot under
  `jit` 4 and under the JIT on x86_64 (the user's desktop, or the dev VM's Buildroot and Alpine images in a session
  that has them), with measuring builds from `bench/interp/results/m8-atomics-x86/plain.patch`. Worth doing only if
  that shows past ~1% on the boot under the JIT.
- **More handlers, by workload** (`bench/interp/REPORT.md` "M8-INTERP loop 13" counted Alpine's boot's slow path).
  Left on the boots: CASP (a 128-bit atomic), STTR/LDTR (the EL0 TLB array from EL1: a second context in `Fast`),
  MSRs that change the regime and DAIFClr; ISB and DSB leave with `Exit::Resync` under parallel SMP anyway. A
  browser's (loop 10, before loop 13): scalar FP and NEON over dozens of classes, whose handlers cost `hot` 1-2% on
  integer code; since loop 13 a run of them leaves `hot` once (`Run::stretch`) and the FP core's FMA and lane
  accesses are 3× faster, so the case for handlers is weaker. Untried: those handlers in a second copy of `hot` (a
  const generic), entered for blocks with FP, so integer code's `hot` stays as it is. Weigh any handler against the
  small guests (loop 13's cost them 0.6-0.9%).
- **`hot`'s cost per micro-op** (profiled 2026-10-21 and 22, `bench/interp/REPORT.md` "M8-INTERP loop 8" and "loop
  12"): the dispatch is V8's interrupt check at the loop head, the micro-op's field loads, the jump table's bounds
  check and the handler's first instruction (the indirect branch's redirect). Every store to wasm memory carries an
  explicit bounds check on arm64 (V8 reloads the memory's size: shared memory can grow; loads use the trap
  handler), so a register write costs four more instructions; x86_64 wasn't looked at. Untried: register caching;
  ADRP+ADD as a pair (0.5% of the pairs). Not tried, settled by a measurement: tail-call dispatch (`become`), since
  V8's `return_call_indirect` costs ~15 ns an entry even among 16 functions (`bench/boot/REPORT.md` "M8: where a busy
  vCPU's time goes in Firefox"), several times a whole micro-op now. Lost before: a sentinel instead of the `u ==
  end` test, LdO/StO runs in a loop (docs/cpu.md "Tried and not kept"). Any code in `hot` moves V8's register
  allocation for all of it, and a guest branch must stay a host branch (loop 12: a `select` there cost 30%): measure
  on the small guests too.
- The reference interpreter (`interp::steps`, `VmConfig.jit` 0) still fetches and decodes each
  instruction; the MMU copy runs 35% slower than the flat one. It only runs the interpreter-only
  tests and benchmarks now.

## JIT

- **Indirect transfers into a browser's code** (2026-10-16; `bench/boot/REPORT.md` "M8: where a busy vCPU's time goes
  in Firefox"). In Firefox's pages session 26% of a busy vCPU's time stalls at a guest function's first instruction,
  83% of it after a `return_call_indirect` (the code footprint defeats the branch predictor; direct and imported tail
  calls don't stall). Warm members took the jump-cache tails into warm code away (+18% busy MIPS). What remains:
  - **Returns as host returns: tried, not kept** (2026-10-16, `bench/boot/REPORT.md` "M8: guest calls as host
    calls"): returns' entry stalls fell from 42.5% of the kernel's to 17.5%, but the time reappeared at the
    continuation's code (guest code 61.3% → 59.6% of samples) and the code grew 12-32%, a third flush in Firefox.
    The stall is mostly fetching cold code, not predicting the branch.
  - **Tails into code that was cold when its predecessor was compiled** (warm members only take what had run 16
    times): re-emitting a hot region once its jump-cache targets are compiled. Likely to move the stall as host
    returns did (above): first measure whether a direct tail call into code evicted from the caches stalls as much as
    an indirect one (`chain.mjs` with the targets evicted). A per-site slot in a module-local
    table, filled on install, measured no cheaper than the jump cache (`chain.mjs` `local`, 35 against 37 ns).
  - The dispatcher's entries (13% of the stalls) and the signature check's table load (5.3% of the time).
- **Fewer, larger modules for a browser, what's left** after tier-ups wait for the batch ([jit.md](jit.md) "Compile
  policy"; `bench/boot/REPORT.md` "M8: tier-ups folded into the batches"): Firefox's pages session makes ~2,800
  modules (75 regions each, 11% with 1-8), the churn screen ~23,000 (22 each, 35% with 1-8: batches made due by
  `BATCH_STEPS` while the guest writes new code all the time). Not tried: larger batches while the cache is warm
  (Alpine paid +20% for 16M-step batches), and rebuilding the live regions into 512-region modules while the guest
  is idle (from recipes, in the compile worker, swapped in at the dispatcher: most of the machinery was 1e628b8's
  replay). Either is worth it only past what the fold gave: the pages session's V8 code fell 6% for 59% fewer
  modules.
- **Liftoff zero-fills its locals at every entry**, 4 bytes at a time (`str wzr, [x16], #4` in a loop): ~5% of
  Liftoff's samples in Firefox sit in prologues. Measured 2026-10-20 (`bench/boot/REPORT.md` "M8: what Liftoff runs
  that a static change could cut"): V8 zero-fills when a function has **more than 12 locals** besides its
  parameters (half Liftoff's cache registers) or any that isn't i32/i64, and then fills every local's 8-byte slot
  (16 for a v128) in that loop; with 12 or fewer integer locals it fills nothing (they start as constants). i32 or
  i64 doesn't matter. In Firefox's pages session 40% of the functions compiled zero-fill (13 locals or more; Alpine's
  userspace benchmark 42%), 36 loop turns each, and 18.6% have 13-16 integer locals. Trimming a local only shortens
  the loop (2 turns a local) unless it crosses 12: keeping a load's base in BASE only when needed moved Firefox's
  zero-filled share from 40.2% to 39.7% (not kept). The lever is getting functions to 12, which dropping scratch
  locals can't (one load or store takes ADDR, HOST and TLBE): it would take sharing one local between guest
  registers whose live ranges don't overlap, a register allocator over the block's locals. Bounded by the
  prologues' ~5% of Liftoff's samples in Firefox.
- **A Firefox session whose first page times out**: Firefox never reports its first page; the guest's kernel and
  shell are alive; the other pages then load normally. Three times in ~35 sessions on 2026-10-16, on three builds
  (WARM=32; the default before the foldable offsets; the posted modules): always the first page (wiki). Rerun such
  a session under JIT-check, and look at what Firefox waits for (the guest's `ps`, its console) when it hangs.
- **The wasm code GC stops every vCPU** (what remains of "What V8's GC stops a vCPU for", closed 2026-10-15 by
  returning the vCPU workers to their event loop: docs/v8.md "Threads that never return to their event loop"). The
  isolate that frees the dead code spends 43-69 ms of CPU in `FreeDeadCode` while the others wait in
  `ReportLiveCodeForGC`: 50-75 ms on all vCPUs at once, a few times a session; the longest stalls left with Firefox
  (54 ms). What dies is Liftoff code TurboFan replaced and flushed modules' code; fewer, larger modules or less
  tier-up churn would shrink it, neither measured. Also open from that item: which Blink object a vCPU thread's
  `new WebAssembly.Module` allocates in Oilpan (`CppGC.SweepOnAllocation` inside `wasm.SyncCompile`).
- **llvmpipe under the JIT** ([graphics.md](graphics.md) "Guests that composite with llvmpipe"): sway compositing
  through Mesa's software GL kept four vCPUs at ~54% for ~3 frames a second at 1376×762 (pixman:
  4–8%). Profiled 2026-10-08 with a compositor-like GLES load (`images/alpine/gl`): ~95% of the
  rasterizer's time was helper calls for NEON the JIT didn't inline (ZIP/UZP, LD1 of a lane, half
  precision FCVTL/FCVTN, FP compares, FRINTI, FMLA/FADD with zero lanes); with those inline the
  frame is 15.6× faster in Chromium on 1 vCPU (6,936 → 445 ms) and 18.6× on 4 (1,859 → 100 ms:
  10 frames a second), ~17× and ~14× native (`gl_llvmpipe_jit`, `bench/boot/REPORT.md` "M8:
  llvmpipe"); with the V registers in locals 323 and 71 ms. Left: the FP checks (below), and sway
  itself on the page again (the user's manual check). Not on graphics' path any more: 3D goes through
  virgl (graphics.md "Decisions"); llvmpipe stays what guests without 3D fall back to.
- **A browser session past the 320 MiB budget** (`bench/boot/REPORT.md` "M8: the carry timed, and a larger code
  cache", "M8: a machine's JIT budget and the page's memory signal"): Firefox's pages session compiles ~260 MiB and
  doesn't flush; a longer one will, and each flush doubles the threshold's floor (the long stutters at later flushes
  were the doubled floor). The churn page flushes at 320 MiB (twice in ~140 s with `hot=1500`); not measured: a real
  session long enough to flush there. Carrying the hot set across the flush and an adaptive budget didn't pay (jit.md
  "Tried and not kept"); a machine can set its own budget (the JIT cache setting).
- **Transfers that still leave a function** (the userspace benchmark's remaining lever:
  `bench/boot/REPORT.md` from "M8: where the userspace benchmark's time goes"; re-profile with
  `bench/boot/userprof.ts` before and after). Per 1000 instructions in Lua and SQLite: 27 to 37
  direct transfers within a page and 10 to 14 to a successor compiled later (both into a block that
  heads another function), 15 to another page by its VA, 10 to 15 returns, 12 to 24 other indirect
  branches. They leave because the target was compiled in **another batch**: a shared callee is hot
  long before its callers. Tried: copies of compiled callees in callers (lost), a region entered at
  more than one block (measured, ~1% at most): [jit.md](jit.md) "Tried and not kept". Not levers in
  that profile: TLB misses (~1% of a phase), the remaining helpers, the core's compiler (under 1%
  outside the boot).
- **The FP fast paths' lane ops** (2026-10-18: `bench/interp/REPORT.md` "M8: the FP fast paths' SIMD ops"). On
  the M4 the paths are bound by the SIMD pipes, not by their branches or reductions ([jit.md](jit.md) "What the
  checks cost"; one check for a run of instructions saved nothing: "Tried and not kept"). With every check forced
  true (wrong) the FP guest ran 33% faster in Node, and llvmpipe 8% faster a frame without its FZ operand tests.
  By gain against work:
  - **Scalar FP in f64 and f32 locals** (a scalar shadow per V register): a scalar FADD is still five lane ops for
    one (two lane extracts, the result's move to a general register for its check, `movi` and `ins` to write it
    back zero-extended); n-body and Horner (~40% of the FP guest) could keep their values in float locals and
    build the v128 only for a vector reader, the flush being stores (no lane op). Needs locals past 128: two-byte
    indices (the TLB memo's patch has them, [jit.md](jit.md) "Tried and not kept"). Counted 2026-10-20: inline
    scalar FP is 0.5% of the instructions compiled in Firefox's pages session (14,500 of 2.9 M) and none to speak of
    in Alpine's userspace benchmark (30), so it's for the FP guest and FP-heavy guests, not the ranking workloads.
  - **FZ's operand tests** (llvmpipe's 8%): about five lane ops an operand (the `movi`s included); for singles, an
    unsigned min of every operand's `(x << 1) - 1` before one compare saves about a third.
  - **The single FMA's midpoint test** (8% of the FP guest with everything it computes): folded into the result's
    mask and reduction, with the round-to-odd redo in the failure arm before the helper; saves a reduction (two
    lane ops), not the test.
  - **Vector FMUL's zero clause** in a branch on a zero result lane, as the scalar form's: about two lane ops a
    product (the FP guest has none to measure it on; llvmpipe's shaders do).
  - **Double FMA through a host fused op**: only relaxed-simd's `f64x2.relaxed_madd`, which may not fuse on every
    host and tier; it needs a probe and a guarantee that Liftoff and TurboFan agree. The FP guest spent ~10% on the
    double emulation in a cloud measurement; leave it unless a double-heavy workload needs it.
  The same shader's guest loads spend ~11% on the TLB's tag load (a translation memo in locals lost: [jit.md](jit.md)
  "Tried and not kept").
- **Cold, kernel-heavy phases** (boot, process churn, shutdown: 10 of the userspace run's 22 s) are a
  third Liftoff code and 11 to 18% V8's compiles on the vCPU's thread (measured before the compile
  worker). With a worker per vCPU, V8 compiles off the vCPU's thread: the JIT's compile worker
  ([jit.md](jit.md) "Sharing"), built for the install stalls a GUI guest showed; the vCPU still
  instantiates each module. Without the worker (round-robin, Node's runs, `?jit=nocw`) it compiles too.
- **The transfer cache's costs in kernel-heavy phases** ([jit.md](jit.md) "Linking"): a miss costs
  a call to the shared miss function, a TLBI by VA a 16 KiB scan (the boot ~1% slower with it).
- **The core's heap, after the bound** ([jit.md](jit.md) "The core's heap"; `bench/boot/REPORT.md` "M8: the core's
  heap bounded"):
  - **The decoded blocks** were ~350-365 MiB on 4 vCPUs; since 8-byte micro-ops, a smaller block map entry and a
    page index of one key a page (`bench/interp/REPORT.md` "M8-INTERP loop 12") the pages session's were 233 MB. A
    budget that follows the heap's room would give back more where the arenas never fill. Test with `MEMLOG=5`
    sessions and `m8-heap/long/tools/heapsum.ts`, and the block interpreter's yardstick for its speed.
  - **The page index without lists** ([jit.md](jit.md) "The core's heap": since 2026-10-22 2 bytes a key, a list's
    smallest allocation 8 bytes where it was 32): what's left of it is the table of pages (33 B a bucket) and a list
    header (24 B) a page, which matter where pages hold a key or two. Firefox's pages session: the block map and index 55 MiB at 1.45 M
    keys (exact), the heap 11 MiB smaller than with whole keys (bench/boot/REPORT.md "M8: the core with exact memory
    limits"). Dropping the index
    (an IC scanning the map) costs a scan of ~1.5 M entries per IC on a page with code, and a guest issues ~1 M ICs
    in the churn screen: not without a cheap test of whether the page has keys.
  - **Not tuned:** `KEEP_HITS` (16), `RECENT_TICKS` (the last 262,144 keys), `WARM_TICKS`, the prune's target (half
    of `MAP_KEYS`) and `MAX_KEYS` were set from the heap's budget and one A/B (keeping only the warm keys cost the
    pages session's bbc load ~0.8 s; with the recent ones nothing measured: `bench/boot/REPORT.md` "M8: the core's
    heap bounded"). A smaller bound (say 2^20 buckets) would save ~25 MiB more and prune twice as often: try it with
    the pages session and the run-once churn if the heap gets tight. A prune takes 6-11 ms natively (release, 1.5 M keys,
    under the cache's lock), 19 ms in wasm (Node, tests/heap.test.ts's guest; counter word 120, `pruneNs`) and ~35 ms
    in Firefox's pages session on 4 vCPUs, all of it under the cache's lock, which other vCPUs' catch-ups and tier-ups
    wait that long for. That session prunes once (in the bbc load, no slower for it), with the churn screen after it
    twice: splitting a prune isn't worth it at that rate.
  - **The user's own session wasn't replayed:** no Chromium in the desktop image and no real sites offline; the
    run-once churn screen (`CHURN='rate=300&calls=120&n=2'`) grew an unbounded map to 3.2 M keys in 12 minutes without a
    flush (heap 630 MiB, mark 725), the crash's path. Check with `TAILCAT=rig PHASES=sites` over 15 minutes and
    Chromium in the guest (in `images/arch/desktop.sh` since 2026-10-22).
- **The shared cache's leftovers** ([jit.md](jit.md) "Sharing"):
  - one vCPU pays 1–2% (Alpine's boot +1.8%, userspace +1.2%): partly each module's bytes copied
    for the catch-up even when the table is the only one (a lone table could take them instead);
  - a worker installs every module of the epoch, those its vCPU never runs too (an instance and
    table entries each: small, not measured);
  - a vCPU that slept through more than `HELD_MAX` (64 MiB) of modules flushes the whole cache when it next runs
    ([jit.md](jit.md) "Sharing"; `lagFlushes`, none in the sessions measured, the held bytes peaked at 4-10 MiB). A
    lagging table could instead recompile only what it runs, or take the compile worker's compiled modules, which
    need no bytes (`env.jit_install` with a number), if the host kept them for the epoch. Worth it only if
    `lagFlushes` shows up in real sessions. The held-bytes count in `Cache::install` has no native test (the native
    cache never logs a module without a JIT host; a planted bug there went unseen): a test hook that logs a module
    would cover it;
  - **the cache's lock** ([jit.md](jit.md) "Sharing" "What the lock costs"): since a miss no longer waits for it and
    a guest issues 2 ICs a page (2 KiB lines), the waiting is ~1.8 s over Firefox's pages session (0.7% of the
    acquisitions found it held), ~2.9 s on the churn screen and ~0.4 s in 300 s of the `go build` loop
    (`bench/boot/REPORT.md` "M8: a miss doesn't wait for the JIT cache's lock, and 2 KiB instruction cache lines").
    What still waits is catch-ups, tier-ups, flushes and ICs. Not worth a loop alone. Unscreened, by evidence:
    - **Firefox's own ICs:** in the pages and churn sessions a Firefox started before the change keeps 64-byte steps
      (it reads CTR_EL0 once), so those sessions' ICs fell by only a third (1.07 M → 0.71 M on the churn). Make the
      warm snapshots again (`bench/gpu/warm-snapshots.sh firefox debian`, ~6 min) so later A/Bs start from a guest that
      read 2 KiB; then count `ics` on the churn screen again (expect a few times fewer).
    - **Coalescing ICs per page** until the next context synchronization (not guest-visible): only for a guest that
      steps by its own line regardless of CTR_EL0; none seen.
    - **Allocations under the lock** (dlmalloc behind std's global spin lock): count them before doing anything.
- **V8's per-function overhead** ([jit.md](jit.md) "Memory"): ~8.5 KB per synthetic function of
  ~600 wasm bytes, a third each in PartitionAlloc, code and V8's heap (the instance's exports,
  which every function needs for the table; writing the table from an active element segment
  instead still makes V8's ~170 B of objects per table entry and saves ~10% of the V8 heap:
  `bench/boot/REPORT.md` "M8: V8's GC on the vCPU threads"). Left to check: whether superseded or invalidated
  blocks' modules stay alive through sibling functions (a module's code is freed only with all of
  its functions' instances), which larger modules make likelier.
- **Unexplained ~10 GB samples** in the Go-load runs with the flush and the GC nudge (2 of 4 runs,
  one sample each near the end; `go-cap-nudge*` in `bench/mem/results/summary.json`): the wasm code
  mapping jumps by ~6 GB in under 20 s while compile volume is unchanged. Not seen with 8 s
  sampling. Measure with V8's own counters before trusting the median.
- Helpers still on real paths: unmasking MSRs, ISB, LSE min/max. None worth a
  loop alone. (The NEON ones, structures and CRC32 are inline since 2026-10-18: the item at this section's top.)
- MSR left as helpers that end a block: DAIFClr, the regime, FP-control, SPSel and NZCV writes
  (Alpine: 0.66M MSR (register) and 0.15M MSR (immediate) helper calls). The differential test
  can't see an unmasking write done inline (no IRQs in its harness): only a distro boot's steps
  catch it.
- **CoreMark's gap to TCG (~70%)**: the same transfers between blocks (above) and the store bounds
  checks V8 keeps on Linux arm64. Don't fit the design to it.
- kvm-unit-tests `timer` runs slower under the JIT than interpreted (short blocks around timer
  polls).
- Buildroot's warm boot under the JIT has a 10× wider IQR than the interpreter's (V8 tiering
  hundreds of modules at different points, presumably).
- Blocks are formed twice: decoded for the block interpreter on first sight (which gives the cache
  their length) and again at compile time.

## The core with `simd128`

Off since the pinned nightly miscompiled the JIT's register-mask code three times; nothing needs
it (the JIT's SIMD comes from our encoder; the interpreter is as fast without it: 138.1 vs
138.5–138.8 MIPS). What's known (work files in `bench/results/local/m55`):
- *Case 1, reduced:* a `[u8; 32]` compared lane-wise into a `u32` mask gives `0x24929249` instead
  of `0x92492492` with `+simd128`; in IR, `icmp eq <32 x i8>` + `bitcast <32 x i1> to i32` under
  `llc -mattr=+simd128` puts lanes 0–15 in bits 31:16. Root cause: the WebAssembly backend's
  `performBitcastCombine` combines 16-lane chunks in reverse order (LLVM's own `simd-bitmask.ll`
  expects the swapped code; `llc` 22.1.8 and 23 miscompile). LLVM 23's middle end (the nightly of
  2026-08-06, rust-lang/rust#158734) started vectorizing our Rust into the pattern. **Reported as
  llvm/llvm-project#226741.** `emit::Func::plain` now uses bit masks instead.
- *Cases 2 and 3* (region register states lost a write-back / back-edge loads): probably the same
  pattern, unconfirmed.
- **To turn it on** (a measured need, or a toolchain that carries the fix): rebuild the M5 step
  8.1/8.2 revisions with `+simd128` and check for the pattern (`bitcast <32|64 x i1>` in
  `--emit=llvm-ir`; two `i8x16.bitmask` + a 16-bit shift in `--emit=asm`); add a CI scan for the
  pattern until the fix is in the pinned toolchain; then pass the corpus, `jit-diff`, lockstep and
  the Node boots with it and compare the interpreter's MIPS. Until then any toolchain bump leaves
  `simd128` off.

## Platform and devices

- **virgl's occlusion-query poll waits 4 ms a turn** (web/gpu-worker.ts `poll`, `setTimeout(poll, 4)`; what's left of
  "The host's pollers and their timers", VK3 L2): a GL program waiting on a query's result waits up to ~4.5 ms for the
  next look. Venus's ring poller, the one that cost a frame (REPORT.md "VK3 L2"), is now web/venus-host.ts's pump
  (`Atomics.waitAsync`'s 0.25 ms timeout, no nested timer); the same sleep would serve here. Measure a program that
  waits on queries (KDE's, "A KDE desktop's session on 3D") before changing it. The others were inspected and need
  nothing: the GPU worker's 20 ms stall check and 4 ms snapshot wait, `Vm.wait` (on `Atomics.waitAsync`), the sound
  pump (`setInterval` at 5 ms, above the clamp), the screens' frame pacing (a frame's wait), gpu-present's 4 ms lag
  probes (meant to tick), web/profiler.ts (a dev tool). In a Chromium 153 worker a nested `setTimeout(f, 0)` turn is
  4.4 ms on Linux and 6.0 ms on the Mac; a timer set from a message's task isn't clamped; `Atomics.waitAsync`'s timeout
  of 0.25 ms is a 0.49 ms turn on Linux and 1.55 ms on the Mac (`bench/vulkan/fence.ts`).

- **The firmware configuration** (loop 2): fw_cfg has no DMA interface (nothing needs it: the firmware's
  screen is the virtio-gpu's, and ramfb would leave a stale framebuffer beside `virtio_gpu` on virtio-mmio,
  firmware.md "Our patches"), no standard items beside SMBIOS (platform.md); the
  flash bank's array-mode reads go through `vm::Io` one instruction at a time (fine for a store
  read a few times a boot: measure if a guest reads it in a loop); no lock state (every block
  unlocked). Between EDK2's boot manager and GRUB's menu Debian retires 5.4G steps in ~3 s in
  Node (Alpine: 0.2G): **not a busy wait** (loop 3): PC samples sit in one LZMA range decoder, most
  likely Debian's GRUB unpacking its compressed core image (bench/boot/REPORT.md "M8 phase B
  loop 3"); nothing to make idle.
- **The screen is dark from the EFI stub until `virtio_gpu` loads** (~20 s of the page's Debian boot, after the
  root mounts; the serial terminal has the kernel's output). The firmware's GOP is `Blt`-only, so Linux has no
  `efifb`, and ramfb would stay beside `virtio_gpu` on virtio-mmio (firmware.md "Our patches").
  Ways out, none tried: virtio-gpu on a PCI transport (the driver then removes the firmware's framebuffer; ACPI's
  item below wants virtio-pci too), the page drawing the serial terminal's tail on the canvas while no scanout is
  set, or a guest whose initramfs carries `virtio_gpu` (the guest's choice, not ours).
- **EDK2's terminal modes** (loop 3): `images/build.sh edk2` patches TerminalDxe to offer only the
  80×25 text mode, because GRUB takes the largest (240×56) and asks the terminal to resize with
  `CSI 8;r;c t`, which xterm.js doesn't do: the menu was lost on the page's 80-column terminal.
  A virtio-gpu machine's GOP is a console too (in ConOut beside the serial port, firmware.md "Our
  patches"), and its GRUB draws on the screen (`gfxterm`), so the patch matters only where the
  firmware has no display: `?display=simple` and the simple-framebuffer machines, whose GRUB menu is still on the
  serial terminal. **Remove it when no machine boots through UEFI without a virtio-gpu** (not re-checked: what
  ConSplitter offers the serial terminal next to a GOP without the patch).
- **ACPI** (only if an ACPI-only guest comes into scope: Windows, an enterprise distro that won't
  boot from a DT). The DT stays the machine's description (firmware.md "DT or ACPI"); the path
  that keeps AML out of the core is EDK2's DynamicTablesPkg building the tables from our DT, plus
  AML for the virtio-mmio transports (its parser doesn't cover them) or a move to virtio-pci; the
  screen then needs a firmware GOP.
- The timer, GIC and PL011 tests have no hardware oracle; a GICv3-free subset of `timer.c`
  (ISTATUS, TVAL, CNTKCTL traps) could run on hvf.
- virtio-console has no host input path (its receive buffers are held forever), so a guest's
  `hvc0` getty is output only. Console input goes to the PL011 (M8); a `MessagePort` in the
  console's spec, as virtio-input has, is the shape if `hvc0` is ever wanted (it would skip the
  PL011's trap per byte).
- virtio: the host can change config space under a running driver since ABI 31
  (`Devices.changeConfig`, docs/abi.md), but only virtio-gpu's display events use it: console resize,
  capacity change and net link state don't yet.
- **Remote disks' loose ends** ([remote-disks.md](remote-disks.md), bench/remote-disk/REPORT.md; a remote first boot
  takes a local file's time with a boot trace), by promise:
  - **A boot trace without the bench:** `tools/disk-trace.ts` takes a `bench/remote-disk/boot.ts` run's trace. A page
    switch that records this boot's reads and offers the manifest with them (or the Machines page doing it for a URL
    disk) would let whoever hosts an image make one.
  - **Plain image URLs have no prefetch:** only a chunked image's manifest carries the list; a sidecar
    (`<image>.prefetch.json`) would give a whole-file host the same 96 → 65 s.
  - **Pieces aren't checked against their SHA-256:** the synchronous reads can't use `crypto.subtle`; the realtime
    path (`readAsync`) could check whole-piece fetches (a host without ranges) and the prefetch's, not ranges.
  - **The paced prefetch's 1.5 s** (R6): R5's, which fetched the whole trace at once, did its fetching during the boot
    menu's idle seconds; the paced one fetches beside the guest. Running eagerly (R5's way) once the guest is past its
    boot menu (its place in the list past the loader's blocks, or a mark in the manifest) would win it back without
    fetching anything at the menu.
  - **The prefetch without the OPFS store** (another tab has the image, no room) runs within memory's window and
    refetches what it pushed out (83 against 65 s, 715 MB against 544): a larger memory budget while it runs, or
    stopping it, would do better.
  - **A hosted image's first boot** runs its update jobs (`ldconfig.service`: `ConditionNeedsUpdate`): ~2–5 s of the
    guest's time, no more bytes (measured: 565 against 567 MB). Building with `/etc/.updated` and `/var/.updated`
    newer than `/usr` would skip it.
- **A public demo that resumes instead of booting** (the user's, 2026-10-17; with remote disks above and PLAN.md
  phase D's preloaded image and snapshot): the deployed page opens a hosted image by resuming a snapshot taken just
  before a first-boot script, which then gives this copy its own identity and per-machine setup. Every visitor resumes
  the same memory, so what must differ per visitor: SSH host keys, `/etc/machine-id` (and what derives from it: DHCP
  DUID/IAID, journal), systemd's random seed, the hostname if it has one, the network card's MAC (a page-side choice),
  any tailnet node key (the page's, host-side). **The kernel's RNG is the subtle one:** a resumed CRNG is the same in
  every copy until reseeded; Linux reseeds on a VM generation ID change (`microsoft,vmgenid`, a device-tree binding
  the kernel supports), so the snapshot's restore should give a new generation ID, and virtio-rng should feed fresh
  entropy at once. The trigger: the script waits in the snapshot (on the serial console, a fw_cfg credential, or the
  guest agent of [plans/agent.md](plans/agent.md), which also covers the clock's jump after a resume) and runs when the
  page signals the resume. The snapshot pins its disk's identity (a URL's path today), so the image's URL must not
  change under it (a chunked image's `id`, [remote-disks.md](remote-disks.md), makes that check exact; a whole file's
  URL doesn't). **How a visitor gets there** (the user's decision, 2026-10-23): an interstitial page first says what
  the project is, that it needs a host with enough memory and CPU, and that hundreds of MB will be downloaded; one
  click then starts the machine, downloads the snapshot (chunked like a disk image, fetched whole before the resume:
  no prefetch logic) and drops into the demo's workload. Nothing is fetched before that click. Two consequences of
  the remote disk's reader: the snapshot's pieces belong in the same expiring Storage Bucket as the disk's blocks
  (`web/diskcache.ts`'s `cacheRoot`: not persisted, a week after its last use, 2 GiB shared), and a disk's boot trace
  (`prefetch` in its manifest) doesn't fit a resumed guest, so the demo's manifest carries a trace recorded from the
  resume instead (or none: the paced prefetch then costs nothing).
- Overlay: no quota handling (OPFS errors come back as `IOERR`), the base identified by path and
  size only.
- blk DISCARD/WRITE_ZEROES ([devices.md](devices.md)) is the page's only: offering it to the
  tests' guests moves every writable guest's step count (the driver reads the longer config) and
  needs the native twin (`core/tests/common` `Overlay`) to take the requests. One segment per
  request (`max_discard_seg` 1); a compaction copies synchronously in the device worker (at most
  the blocks freed, so a trim of GBs can hold the guest's I/O for seconds). The page's Debian
  doesn't mount with `discard`: the user runs `fstrim`, or waits for `fstrim.timer`.
- 9p: an in-memory tree only (OPFS or an HTTP-served tree, as v86's lazy filesystem, are the
  candidates); no xattrs/ACLs; `qid.version` 0 (only `cache=none` coherent); readdir offsets are
  entry indices; whole-second timestamps.
- Input: the keyboard layout reaches only guests with systemd 256+ (the firmware, GRUB and older guests type a US
  layout; Latin layouts only: frontend.md "The keyboard layout"); no horizontal wheel (the tablet and the mouse have
  `REL_WHEEL` only: `REL_HWHEEL`, or the high-resolution wheels, would be guest-visible); the touchscreen's
  single-touch `ABS_X/Y` follow the browser's primary finger only (they stay where it lifted while others remain:
  multitouch readers don't care); events injected in deterministic mode land when they land. Past 1024 queued events the oldest are dropped, so
  anything that types a long string (a test agent, a paste into the screen) must pace itself.
- **The firmware's keyboard on machines without the USB controller:** a machine with the controller has one since 2026-10-18 (the built-in USB keyboard on EDK2's USB stack, docs/usb.md "The keyboard"). One without it still gets the screen's keys on the serial console as a terminal sends them (`terminalBytes`: no key-up, no modifiers by themselves) until its virtio keyboard is live. A virtio-input DXE driver for the mmio transport (none to port from OvmfPkg) would cover those too; worth it only if machines without the controller stay common (new ones have it). The other way out removes the serial path instead: every page machine gets the controller (older ones at their next start, which orphans their snapshots once, so ask first) and the tests' transient guests take it by default (guest-visible: the user's OK); then `terminalBytes` and `attachInput`'s serial `text` path can go. Kept for now (2026-10-18) so machines from before USB don't lose their firmware keyboard.
- **Guests that composite with llvmpipe show stale frames on virtio-gpu** (graphics.md "Guests that composite with llvmpipe"; devices.md): the
  rasterizer threads draw after the transfer. `WLR_RENDERER=pixman` in the guest avoids it. A display mode that
  samples the scanout's memory at each refresh and holds a flipped buffer until it is stable would hide it for
  unmodified guests: not built (a full compare per refresh; build it if GL compositors become fast enough to use).
- **Chromium in the guest still steps back one frame now and then** (graphics.md "The call queue"): after the queue's fix,
  `bench/gpu/chromium-flicker.ts` saw one frame one step back in two of four runs (~1,000 frames each), none on
  `?gpu=2d`. Not traced: a remaining order between contexts (the decoder's context passes held ones), or the screen's
  scanout.
- **GTK4's graphics offload kills a GtkGLArea on virgl** (graphics.md "The guest's 3D: Mesa's virgl"): GTK hands sway the GL area's
  texture as a dmabuf, and Mesa's virgl backs a texture that isn't shared with a 1-byte staging BO (the host copies
  transfers both ways), so the dmabuf is smaller than stride × height and the compositor disconnects the client. A
  guest-side bug (QEMU with virgl has it too); `GDK_DISABLE=offload` avoids it. Ways out: Mesa reallocating a
  staging-backed texture when it is exported (upstream), or caps without `COPY_TRANSFER_BOTH_DIRECTIONS` (every
  texture then has a guest backing and read-backs go through it: measure Firefox and GTK before choosing).
- **dEQP on more platforms** (graphics.md "Testing"): the whole GLES2 and GLES3 lists have run on SwiftShader (the
  dev VM, CI) and on ANGLE on Metal (the Mac's M4). Each WebGL2 stack behaves differently within the spec (precision,
  optional extensions, limits, undefined behavior, ANGLE's workarounds), and whatever differs is what users hit.
  Metal found four bugs of ours that SwiftShader hid, all where our GLSL leaned on what the spec leaves open: two
  programs where GL has one, an invariance mark dropped, NaN-pattern integer constants folded, `x != x` for isnan;
  the rest was the GPU's (the filter switch near level 0, one invariance loop, line rasterization). Worth a run, in
  order:
  1. **Windows, ANGLE on D3D11**: most users.
  2. **Linux with an NVIDIA GPU** (ANGLE on GL or Vulkan): the user's desktop, run by the user when convenient, never
     by us.
  3. **An Android or ChromeOS phone** (Mali or Adreno): the strictest precision and limits.
  4. **Intel or AMD integrated GPUs.**
  The cheap way (proposed, not scheduled): a dEQP runner page (`?deqp` on the page, or on vm.tny.im) that anyone opens
  in their own browser: it boots the dEQP guest, runs the lists and downloads a results file with the renderer string
  and the limits; and a tool that compares result files across platforms (as G5 compared Metal with SwiftShader).
  Until then, `bench/gpu/sway-mac.sh`'s route (`SCRIPT=deqp-run.ts`) is the way for a host we can reach.
- **A KDE desktop's session on 3D** (graphics.md "Queries", "Feedback loops"): a user's KDE Plasma session (2026-10-24)
  found occlusion queries holding every fence and draws refused as feedback loops, both fixed. Run KDE Plasma on the
  desktop guest to see what else it asks for, and measure what the feedback copies cost there (a copy at every such
  draw, no write tracking to skip one whose source hasn't changed). KWin, Mutter and Xorg sessions on 3D are
  unmeasured too (graphics.md "Applications on 3D").
- **Fuzz virgl's stream decoder**: the renderer parses untrusted guest data (WebGL validates only what it is given).
  Fuzz the stream's decoder as the device's commands and the virtqueue parser are (`core/fuzz`), on the recording
  WebGL2 of `tests/virgl-mock-gl.ts`.
- **Desktop GL 3.0 and 3.1 on WebGL2** (graphics.md "What isn't backed"): they need what WebGL2 lacks or has only as
  extensions: `gl_ClipDistance` (`WEBGL_clip_cull_distance`), depth clamp (`EXT_depth_clamp`), conditional
  rendering, the sRGB framebuffer switch, texture buffers, base vertex
  (`WEBGL_draw_instanced_base_vertex_base_instance`). Caps that follow each extension, where a workload needs one.
  Geometry and tessellation exist in neither WebGL2 nor WebGPU, so desktop GL above 3.1 isn't reachable on WebGL2
  (on WebGPU through compute, as plans/graphics.md does for Vulkan, only if a real workload needs it).
- **A WebGPU backend for virgl** (GLES 3.1: compute, storage buffers), only where `navigator.gpu` gives an adapter.
  It would share the WebGPU layer the Vulkan plan builds (plans/graphics.md), so it waits for that plan's VK0.
- **virgl has no native twin** (devices.md "virgl"): `core/tests/common/gpu.rs` is 2D only, so a virgl guest can't run in
  the native runners. The null renderer is G2's measuring device and is tested in Node; extend the twin only if a
  native, exact-step virgl guest is wanted (the WebGL2 renderer of G3 can't run natively anyway).
- **The sound tests' timing under load** (`tests/audio-browser.test.ts`, now `scripts/ci-audio.sh`'s, alone): beside
  `npm test`'s other files they failed in two `ci.sh` runs of three on 2026-10-14 and passed alone. The failures: the
  restored snapshot's stream took 10,237 ms for 10,152 ms of sound and counted gaps (85 ms past the 40 ms tolerance:
  time missing that no gap counted, about one 85 ms buffer), the saved machine not finishing its tone in time, and
  the microphone's recording out of its time. Worth a look if sound ever stutters for users under load: the
  uncounted buffer may be a real gap in what the ring counts (a vCPU starved through the restore), not just the test's.
- **virtio-gpu's flush pacing slows a guest that waits for every flush** to 60 flushes a second. Our EDK2 no
  longer is one (it coalesces its flushes a frame at a time: firmware.md "Our patches"), so
  another firmware or OS driver would be the case. The host can't tell such a guest from one that floods:
  fences don't (EDK2 fences none of its flushes, Linux none on our device: it fences a primary plane's flush
  only for blob resources, which we don't offer).
- **A key's glyph is ~13 ms later on the virtio-gpu screen than on the simple framebuffer** (53 against 39 ms in
  headless Chromium on the dev VM; bench/gpu/REPORT.md "G1 exit"). Not the device: the flush arrives 12 ms after
  the key and is drawn within 1 ms; the time goes between `putImageData` in the device worker and the page seeing
  the canvas. The device worker is nested in the machine worker and Chromium gives a nested worker no
  `requestAnimationFrame`, so it draws outside animation frames (the simple framebuffer is drawn inside the machine
  worker's): the suspect, not proven (a standalone page shows no penalty). Next: the same measurement on a real GPU
  (the Mac host; the dev VM composites in software), then a device worker the page creates (a top-level worker has
  animation frames; moving blk off that thread and G3's GPU worker want the same change) or drawing from the
  machine worker out of shared memory.
- **virtio-gpu, not built or not measured in G1:** GNOME, KDE and Xorg sessions (sway is: graphics.md "The console and the display size"); a page test
  of the pointer through a letterboxed screen (checked by hand with sway); an overlay for a guest that warps its
  cursor (`MOVE_CURSOR` away from the pointer: none seen); sizes beyond 4088 pixels a side (a DisplayID block in the
  EDID); a display event at a fixed step beyond the test hook (`GpuOptions.resize`).
- Framebuffer (the simple-framebuffer machines that remain: Buildroot's page, the test guests, `?display=simple`): a
  scan of the whole buffer per animation frame to find the changed rows (~0.4 ms at 1024×768, on the machine
  worker), x8r8g8b8 only, fixed size. Guests with the driver use virtio-gpu ([devices.md](devices.md)); nothing
  is planned for the rest.
- The TS backends are tested through boots; a Node test with a bare-metal virtio guest would be
  cheaper when they grow (blk).

- **HEVC on the host** (dropped with the video track's end, 2026-10-15, the user: H.264, VP9 and AV1 cover what the
  web serves; Chromium on Linux has no HEVC decoder of its own, so only hosts with hardware HEVC would offer it; HEVC
  files still play, decoded in the guest). What it would need ([plans/video.md](plans/video.md) §11): VPS, SPS and PPS
  written from `virgl_h265_picture_desc` (offsets from a C program against Mesa's `virgl_video_hw.h`), and every slice
  header rewritten, since VA's parameters lose the SPS's short-term reference picture sets (only their count): an
  explicit set built from the picture's DPB list (`ref[]`, `PicOrderCntVal[]`, the RefPicSetSt*/Lt indices; the rest
  is foll), and the header parsed through to its end (prediction weights, entry points) to re-align the slice data;
  long-term pictures from the SPS can't be rebuilt (their POCs aren't sent). Testable only where the browser has
  HEVC (the Mac's hardware), and offline with FFmpeg in Podman.
- **A VA-API consumer that waits on each picture, where the browser decodes H.264 in software** (the guest's
  `ffmpeg -hwaccel vaapi` reading frames back, as in transcoding; plans/video.md §7): every frame right, but ~5 a
  second (120 frames in 23 s on the Mac: each picture waits for the 200 ms drain). The decoder holds more pictures than
  the guest sends before it waits (Chrome's FFmpeg 3 beyond the SPS's depth, its frame threads; OpenH264 up to 6,
  ignoring the SPS), and no SPS can say less than 0. Firefox and mpv decode ahead and aren't affected. Ideas, none
  tried: a filler picture (a non-reference all-skip P slice under a CAVLC PPS of ours) to push held pictures out; a
  shorter drain for a codec drained again and again (each drain decodes its IDR period again, so the cost grows with
  the period). Worth it only if transcoding in the guest matters.
- **H.264 that jumps to a picture that isn't an IDR** (plans/video.md §9: the guest's FFmpeg seeking in an MPEG-TS,
  which has no index, lands mid-GOP; a stream whose key pictures are recovery-point I pictures): the guest's own
  decoder conceals the missing references, the browser's decoders (VideoToolbox, Chrome's FFmpeg, OpenH264) report a
  decoding error, and the host drops the codec's pictures until its next IDR (the guest sees a still picture, up to a
  GOP: ~10 s for x264's defaults). Idea, not tried: after an error, restart the decoder at the next picture whose
  slices are all I by rewriting it as an IDR (NAL type 5, an `idr_pic_id`, `dec_ref_pic_marking` without MMCO; the
  slice header re-encoded). Worth it only if TS playback or such streams matter (MP4 and WebM seek to key pictures).
- **mpv on virgl's GL with VA-API pauses on another frame** (VK2 L6, bench/vulkan/REPORT.md "VK2 L6",
  `bench/vulkan/mpv-frames.ts`): paused at 20 s in Sintel's trailer, `--vo=gpu --gpu-api=opengl --hwdec=vaapi` shows a
  picture a frame or two away from the one mpv shows decoding in software, or on Vulkan with VA-API (those three agree
  to the byte on the M4), on the Mac and SwiftShader alike. Playback looks right; not looked into (a stale plane
  sampled through the picture texture, `Res.picture`, or mpv's own GL interop at a seek are the candidates).

- **Snapshots while Vulkan (Venus) is in use** (VK1, docs/devices.md "Venus"): refused while a Venus context exists.
  Needs the renderer's objects as data (as virgl's), the blobs' bytes (mapped ones are in the window, which a
  snapshot's RAM chunks don't cover yet) and the window itself: plan §6's VK4.
- **Venus's contexts outlive a virtio reset** (seen in the code by VK3 L4c-C, not run): the device's `reset` clears its
  `venusContexts` and sends the GPU worker `reset`, which resets the virgl renderer and the import's maps only; Venus's
  renderer keeps its contexts, rings, blobs and imports (web/venus-host.ts). After a guest reboot a context id may be
  made again (vkr likely refuses an id it has; not checked), and an old ring may still be polled over memory the new
  guest reuses. The fix: destroy every Venus context at `reset` (and clear `owner`/`imported`).
- **Venus's submit path costs the guest** (VK1's gate, REPORT.md "VK1: the gate"): GTK4's frames +11% on Venus (9
  execbuffers a frame against virgl's 4, ~0.17 ms of the emulated kernel each). Ideas, unmeasured: a cheaper virtqueue
  notify (the MMIO write's exit), profiling the guest kernel's execbuffer and syncobj paths under our emulator.
- **Venus's use-after-free fix has no test** (VK1 L8, vk/patches/vkr-wasm.patch): a device memory freed while its blob
  is mapped; covered only by the scene's probe (`bench/vulkan/guest.ts venus`). A unit test needs Venus commands
  encoded by hand (or a recorded stream replayed through `venus_submit`).
- **VK2's gate on NVIDIA** (bench/vulkan/REPORT.md "VK2 L7"): the user's run of `bench/vulkan/nvidia.sh page` (the
  programs' frames, the scene against virgl, mpv's gate) is outstanding; its results go into REPORT.md beside the M4's.
- **`npm start` doesn't build Vulkan's renderer** (VK2 L7, vk/README.md "On the page"): vk/build.sh clones and builds
  Mesa and virglrenderer natively first (minutes, meson and Mesa's build dependencies), so the preparation leaves it
  out and a user's copy has Vulkan only if they built it. A prebuilt module fetched by hash (as the firmware could be)
  would bring it to every `npm start`.
- **Pipelines' loose ends after VK3 L3** (REPORT.md "VK3 L3", vk/README.md "Pipelines made asynchronously", "The shader
  cache"): (1) render pipelines are made when a draw is recorded; made at vkCreateGraphicsPipelines from the pipeline's
  static state (the viewport's flip and dynamic state guessed), most would be ready before the first frame records,
  at the cost of some never used: unmeasured. (2) SwiftShader's compile isn't kept across a browser restart (Metal's
  is, through Dawn's cache and Metal's own); NVIDIA's is the next run's question (nvidia.sh `pipelines`). (3) The
  store's entries are kept uncompressed (vkQuake's 3.5 MiB) and loaded whole at Vulkan's start; CompressionStream on
  the way to IndexedDB would hold ~3× more under the same budget. (4) The store isn't shown on the Machines page's
  storage line nor cleared from it, and its 32 MiB budget is fixed: the user wants it configurable (2026-10-26; the
  budget and the origin-wide scope are approved: entries are keyed by content, so one program on two machines shares
  them). (5) A pipeline made at once by a submit (`syncPipelines`) is counted, never seen.
- **What the device advertises, left for the translator** (VK2 L7, vk/README.md "The driver"): subgroups are of one
  invocation with the basic operations (both adapters have WebGPU's `subgroups`: subgroup sizes and operations in
  WGSL), `shaderFloat16` (the Mac's `shader-f16`), YCbCr conversions (GTK4's Vulkan renderer: VK3's row; GTK4 forced
  onto Vulkan aborts on its own assertion without them), read-write storage for 8- and 16-bit formats where the adapter
  has `texture-formats-tier2` (the translator prints `read_write` already; the format features don't say which formats
  allow it). The per-stage descriptor limits are WebGPU's whole, though the push buffer takes a dynamic uniform
  buffer of group 3 when push constants pass the immediates: a pipeline at the limit would fail.
- **GTK4 on Venus drew black or near-empty frames** (VK2 L7, with YCbCr advertised: `bench/gpu/gtk4-load.ts`
  `RENDERERS=vulkan`, frames' window black, fishbowl one icon at 6 frames/s): not looked into; VK3's YCbCr row starts
  there.
- **Venus's frames on the user's NVIDIA desktop: the fix awaits the user's run** (VK3 L1, bench/vulkan/REPORT.md "VK3
  L1"): the black came from the device reporting NVIDIA's vendor ID, for which Venus's guest driver (Mesa 26) takes
  Mesa's prime-blit path: the shared blob is a buffer, not the image, and nothing was copied (`shareRefreshes` 0 in
  VK2's run; reproduced on SwiftShader with `?gpu=vkvendor=nvidia`). NVIDIA is reported as an unknown maker now, and a
  GPU way is checked at its first copies with a fallback to readback. `bench/vulkan/nvidia.sh page`'s `present` step
  confirms it, way by way; whether the bitmap way itself copies right through ANGLE's GL on NVIDIA is the other thing
  it answers. Close this once it does.
- **A WSI image exported as a buffer isn't shared** (VK3 L1): Mesa's prime blit (a device Venus takes for another
  GPU's, or NVIDIA's) exports a linear buffer each frame is copied into; web/venus-share.ts shares only images
  (`venus_resource_texture`), so such a window is black, with a warning. Sharing a buffer would need the driver to name
  the memory's GPUBuffer, writes to buffers tracked like textures' and a buffer-to-texture copy with the import's
  stride. Not needed while no guest takes that path.
- **Venus at 1 fish on NVIDIA: 2.4–2.6 ms a frame against virgl's 1.5, parked by the user** (2026-10-26: 1 fish isn't
  representative; likely NVIDIA's driver latency or its GPU leaving low power slowly; Venus is ahead at 1,000 fish and
  the toolkit). The leads: Chromium notices a lone pass done ~2.2 ms late there (1.2 nudged, at once under load), the
  scene's pass ~0.9 ms of GPU (the M4's 0.41), a frame's `Queue::Submit` ~1.55 ms in the GPU process (REPORT.md "VK3:
  the NVIDIA run after L2b"; the 134 MB trace in `bench/results/local/vk3-nvidia-l2b/`). History below.
- **Bind groups remade every frame** (VK3 L2c, unmeasured): a descriptor set keeps bind groups for 4 pipeline layouts
  only, and every pipeline has layouts of its own, so the scene remakes ~14 a frame. A cache keyed by the layout's
  shape (or layouts shared across pipelines with equal sets) would keep them; worth it where draws switch pipelines.
- **Venus's ~4.5 ms fence floor on NVIDIA: the poller's part fixed** (VK3 L2, bench/vulkan/REPORT.md "VK3 L2"):
  found on the M4 and SwiftShader as two waits, both gone. The guest fences each frame through the virtqueue, and a
  fence retired only at the ring poller's next turn, a nested `setTimeout(0)` clamped to ~4.5 ms (the M4's scene at 1
  fish: 3.0 ms a frame, fences 4.3 ms; now 0.86 and 1.05, virgl's 0.87–0.96). And Dawn on Vulkan (SwiftShader, and so
  likely NVIDIA's) says a submit is done only at Chromium's slow look at the device, ~3 ms after its work: an empty
  submit every ~1 ms while one is in flight brings it back in ~1 ms (a submit's fence 3.1–3.2 → 1.0 ms). The prime
  blit explains none of it (the scene draws offscreen; `vkvendor=nvidia` changes nothing). `nvidia.sh page`'s `fence`
  and `scene` steps (the pump against `vkpoll=timeout`, each run's breakdown in `renderer.venus`) confirm it. Close
  this once they do. The run of 5b9654ac did (the pump ~1.1 ms off every size), but left 1 fish at 2.5 ms against
  virgl's 1.5 with a frame submit's done at 3.4–3.9 ms; VK3 L2b scripted what the next run must say of it (REPORT.md
  "VK3 L2b": the GPU's real ms with `?gpu=vkgputime`, frame-shaped submits, `vknudge`, a trace).
- **The guest fences each frame through the virtqueue** (VK3 L2): in VK2 L5 the scene's guest sent ~1 fenced
  `SUBMIT_3D` a second, now one every two frames (269 a second at 1 fish on the M4; 109–208 in VK2's NVIDIA run), likely
  since L6/L7 advertised sync-file semaphores and external fences to Venus's guest driver. Each costs the guest an
  execbuffer and the host a held reply. Not looked into: which Vulkan call makes them, and whether its feedback path
  could serve instead.
- **Presentation's gaps** (VK2 L4, vk/README.md "Presentation"): a fullscreen Vulkan window isn't tried (wlroots may
  scan a client's dma-buf out directly: `SET_SCANOUT_BLOB` of a Venus blob, `ERR_UNSPEC` today, would need the
  screen to draw a WebGPU texture); images written only by compute (storage) aren't marked written, so they aren't
  copied again; WSI formats other than 8-bit RGBA, `rgb10a2unorm` and `rgba16float` aren't shared (a warning, a black
  window); a browser that renders with a GPU but whose WebGPU canvases fail would lose its GPU channel on the bitmap
  way (`shareMode` decides by the renderer's name: no such browser seen; `?gpu=vkreadback` is the way out); the
  readback way holds the compositor's submit for its wait (7–10 ms a frame at 1080p on SwiftShader).
- **Imports' gaps** (VK2 L6, vk/README.md "Imports"; mpv on Vulkan meets its bar regardless):
  - **libplacebo renders without FBOs on Venus** ("Failed creating FBO texture! Disabling advanced rendering"), since
    the device holds back `float32-blendable` and tier1's storage formats by default (web/venus-gpu.ts `HELD_FEATURES`;
    `?gpu=vkformats=all` takes them: then mpv gets its FBOs, scalers and debanding). With them, **mpv's VA-API chroma
    read as zeros on the M4 in about a third of fresh sessions**: found and fixed in VK3 L4c-A (a window page taken by
    one Venus device's submit was lost to the others' memories; bench/vulkan/REPORT.md "VK3 L4b–L4c"), 0 green in 32
    bare sessions since. Left: turn the advanced path on by default, after mpv's frames and bar with it on are checked
    again at today's code (VK3 L4c-F changed storage access) and the user's NVIDIA run's mpv questions.
  - **mpv on Vulkan doesn't exit** (SwiftShader, at the end of a file or on SIGTERM): its `vo` thread waits on a DRM
    syncobj (`drm_syncobj_array_wait_timeout`) while sway still shows its window, and no Venus fence is pending on the
    host (`venus: fence … unretired` never fires). Likely Mesa's Wayland WSI waiting for an image's release at the
    swapchain's destruction; not looked into. avsync.ts and mpv-frames.ts kill it.
  - **Every frame's planes are written again** (libplacebo imports a surface each time it shows it): ~0.2 ms of the
    GPU worker and 0.6 MB a frame at 480p, ~3 MB at 1080p. A Venus texture per resource, kept while the resource lives
    and written only when a picture changes it, would make a bind free.
  - A resource with no picture written yet is read back once at its first import (WebGL's synchronous `readPixels`);
    what the guest renders into a virgl resource after it is imported (rather than a decoder's picture) never reaches
    Venus's copy. Nothing makes the guest wait for a picture before it samples the import (`vaSyncSurface` waits for
    nothing): a draw queued before the picture lands samples the texture's earlier bytes (vk/README.md "Imports").
- **The Vulkan driver's gaps** (VK2 L2, L5; vk/README.md "The driver"), each for when a program or dEQP-VK needs it;
  dEQP-VK's failures by cause (L5's samples of the direct set's groups: ~20,000 cases, 4,278 passed, 665 failed, 5
  crashed, the rest unsupported; `bench/vulkan/results/vk2/l5/deqp/`; the cases that fail stay out of
  `tests/deqp/vk.txt`; the counts below are of the samples):
  - **Copies WebGPU refuses**, skipped with a warning (the worker's `depthStencilCopy`): uploads into depth24plus's or
    depth32float's depth (a draw writing `frag_depth` from the buffer would do it), any copy of depth24plus's depth
    (D24 formats as depth32float, with a conversion of their buffer layout, or not advertised), copies of part of a
    depth or stencil image, of multisampled images; copies between formats (Vulkan's size-compatible copies:
    compressed ↔ uncompressed, a 32-bit format into another: a compute copy), integer resolves (a draw of sample 0).
    GFXReconstruct's trimmed captures restore their depth images this way (vkQuake's first replayed frame).
  - **Formats**: ASTC and ETC2 on SwiftShader fail sampling and copy tests in numbers (`texture.compressed`,
    `texture.filtering.3d`, `.2d_array`: not looked into; the Mac's results are the ones to read first); 3D images
    sampled through 2D views (`2D_ARRAY_COMPATIBLE`); D24 depth tests fail by one unit (depth24plus's precision);
    3-component formats in images (`glsl.440.linkage` makes RGB32 attachments: `VK_ERROR_FORMAT_NOT_SUPPORTED`);
    vertex strides that aren't multiples of 4 (WebGPU's); copy regions past a level's end (a few `copy_and_blit`).
  - **Samplers**: border colours and mirror-once (the nearest WebGPU address mode), component swizzles
    (`texture-component-swizzle` where the browser has it), unnormalized coordinates, integer textures sampled with
    a sampler (fetched at clamp-to-edge whatever the sampler's address mode: the address modes as a program variant
    would do the rest), LOD bias and min/max LOD clamps against WebGPU's.
  - **Shaders**: texture offsets that aren't constants after optimization (46 stages: `glsl.texture_functions.*offset`,
    WGSL wants a const-expression: the printer's vars defeat it, so print constant offsets as literals), texel buffers
    (43 stages; vkQuake's palettization: storage buffers and the format's decode, a variant per bound format),
    fragment inputs past the varyings (`gl_ClipDistance` read in a fragment shader, slots 17 and 18: 18 stages),
    subgroup invocation ids (12, `subgroups`), `textureQueryLod` (9), dynamically indexed buffers and storage images,
    16-bit values (`shader-f16`), image atomics, interpolation at an offset; derivatives in non-uniform control flow
    (`glsl.derivate.*dynamic_if`); `umulExtended`; a shader with 12 uniform blocks and push constants past the
    immediates (the push buffer is a 13th).
  - **Queries**: occlusion queries are reported as passing (WebGPU's occlusion query sets need the pass's set at its
    start: the pass's op patched when a query begins in it), timestamps are the CPU's at replay (`timestamp-query`): a program's "GPU time" under Venus, VK0's scene's
    included, is the replay's span, not the GPU's (VK3 L2b; the worker's `?gpu=vkgputime` measures the GPU's).
  - **Rendering**: stencil state per face (WebGPU has one reference and one pair of masks: about a third of
    `pipeline.monolithic.stencil` fails), indexed triangle fans (non-indexed ones draw through the device's fan
    indices), depth clipping with clamping on (WebGPU's `unclippedDepth` does both or neither), layered rendering and
    multi-view, depth and stencil blits, attachment-less passes (`Render pass has no attachments`), 34 of
    `renderpasses.*.load_store_op_none`'s 91 supported cases (VK3 L4c-D: stencil8 attachments, depth or stencil
    NONE/DONT_CARE, an integer resolve, `alphablend`; not looked into further), vertex buffer offsets that aren't
    multiples of 4, early fragment tests (`fragment_operations.early_fragment`), indexed indirect strips
    (`draw.renderpass.indirect_draw.indexed*triangle_strip`, not looked into).
  - **vkQuake's frames** (`images/vkframes/`) differ from lavapipe's systematically: 78% of their bytes by a little, 1.7%
    by more than 24, the same counts on SwiftShader and on the M4's Metal (so not the GPU's rasterization), its text
    and grid edges the largest; to the eye the same, no bias. The tolerance is 3% meanwhile. Next: diff its passes
    one at a time (GFXReconstruct's `--screenshots` of an earlier draw), suspects its screen effects' dithering and a
    conversion's rounding.
  - **Memory**: some `memory.binding` cases (aliasing and odd sizes) and two `memory` crashes (vkr's
    `vkFreeMemory resulted in CS error`), not looked into. `memory.allocation.random.*` and
    `memory.mapping.suballocation.random.*` pass alone but crash deqp-vk after enough earlier cases (VK3 L4c-F: with
    its 179 cases added to the pass list, on the renderer of before as on the new one): something the renderer keeps
    across cases (its arena's use or fragmentation?); they're out of `tests/deqp/vk.txt` until it's found.
  - **Storage images WebGPU gives one way** (VK3 L4c-F refuses them): a shader that loads and stores an image of a
    format WebGPU allows only read-only or write-only (every format but r32's without `texture-formats-tier2`, and
    rg8/rg16/rg32, the snorm and 16-bit unorm formats, `rgb10a2*`, `rg11b10ufloat` even with it) fails its stage, and
    a read-only `bgra8unorm` too; so does a pipeline whose stages access one storage image differently (no test of its
    own: the refusal is the translation failures' path). The formats stay advertised as `STORAGE_IMAGE`, since their
    write-only and read-only uses are right; a full fix would bind such an image as a storage buffer of its texels
    (the format's encode and decode in the shader, a copy in and out around the pass), or advertise per-use what can't
    be advertised per-format. L5 takes `tier2` itself (its read-write formats are translated now).
  - **Transfers**: a resolve into a 3D image is skipped with a warning (WebGPU resolves into 2D views only). VK3
    L4c-F's dEQP-VK samples (`bench/vulkan/results/vk3/l4c/f-deqp/`) left 13 failing, all failing before too, not
    looked into: linear 3D blits of `r32_sfloat`/`r32g32_sfloat` (unfilterable without `float32-filterable`), a
    4-sample `b10g11r11` clear, a 3D `a2b10g10r10_uint` clear (its 10-bit channels clamped to 255), storage images of
    cube views through descriptors (7), `push_constant.graphics_pipeline.overwrite`.
  - **Elsewhere**: the push buffer grows before a submit to 256 bytes a draw and dispatch, up to 256 MiB (a submit past
    ~1M draws with push constants past the immediates still wraps, with a warning).

## Parallel SMP (M7; measurements in `bench/boot/REPORT.md` "M7 loop 8")

- **The remaining DSB waits** (~3K per userspace run on 4 vCPUs, 20–60 µs each: same-ASID
  targets, and all-ASID or kernel-range TLBIs) wait for the target's chunk boundary. A 4096-step
  chunk in parallel mode cut the average from 100 to 65 µs and polling before sleeping to 55 µs,
  before the ASID filter made both moot; ending a target's chunk from outside would need a memory
  check in the JIT's hot path. In 300 s of the `go build` loop on 4 vCPUs they're 4.4–4.9 s, about the JIT lock's
  waiting before the no-wait miss: `bench/boot/results/m8-devlat/kick/kick.patch` (a run ends early, between two
  dispatches, when an interrupt or another vCPU's request is due) was never measured on them. It predates the
  dispatcher's current shape and needs porting; test it as `run.sh go` in `bench/boot/results/m8-lock2/tools/` (two
  sessions per arm, `dsbMs` and the MIPS, whose spread there is wide) and the gates.
- **An exit's remaining cost** (~240 ns in the desktop guest after the fast completions and the throttled timer
  check and counters, [jit.md](jit.md) "What an exit to the run loop costs"): what's left is unmeasured part by
  part: the run loop's per-iteration atomics (the signal and wake words, `pending`, the IRQ line, the ASID's SeqCst
  fence) and `jit::steps`' re-entry (`key`'s translation of the PC, `Cache::enter`'s lookup, `fresh`). Profile it
  with perf and V8's `--perf-prof` on a loop of an always-exiting instruction (`mrs cntfrq_el0`) before changing
  any of it. The exits that remain frequent in a browser are syscalls (SVC), faults and IRQs.
- **WFE sleeping:** WFE yields (120K per vCPU in 7 s of churn on 4 vCPUs, ~0.1 s); sleep on the
  event word only if a workload shows yields costing.
- **Parallel `make`** as a scaling workload (the image has no toolchain yet).
- **A default vCPU count for users:** the page uses `min(4, cores − 2)` (web/app/machine.ts);
  `bootVm`'s `ncpus` still defaults to 1. Telling the user that a host's efficiency cores make N
  above its performance-core count scale poorly (this host: 4 P + 6 E) belongs with M8 phase D's
  settings and embedding API.
- **The page's memory check and signal** ([jit.md](jit.md) "The page's memory signal"): the check before a start is a
  rule of thumb (`hostMemoryGiB`, the JIT budget counted since 2026-10-20) and the live estimate is calibrated on one
  host (headless Chromium 153 on the dev VM, a 2.5 GiB desktop guest on 4 vCPUs); both are compared with
  `navigator.deviceMemory`, which Chromium caps at 8 GB and rounds down, and neither sees what else the host runs. Open:
  the estimate counts guest RAM whole (12-19% over the renderer's median from a snapshot) and misses a flush's
  garbage at its spikes (one 10 s sample 1.8 GB over, with the flushed epoch counted for 30 s); a calibration with 1 vCPU, a 2D machine and a longer session;
  what a user's crash mark says once one is seen.
- **Hours-long whole-platform stress** (repeated parallel boots and workloads for hours): deferred
  by the user (2026-09-28) to a later milestone, once more virtio devices and integration features
  exist, when such a run is likelier to catch non-obvious platform-wide issues.

## The page (M8 phase A; [frontend.md](frontend.md))

- **Firefox** (not a target; 2026-10-15): Debian boots on the page in Firefox 157 (headless, the dev VM)
  once qcow2's compressed clusters stopped relying on Chromium's DecompressionStream handing over
  its output before the junk error (`web/qcow2.ts` `inflate`) and SpiderMonkey runs without the
  compile worker (`web/app/worker.ts`). Open: SpiderMonkey's process holds the code of ~16,350 live wasm modules
  (64 KiB each, it seems; then `new WebAssembly.Module` throws "out of memory"), every vCPU worker compiles its
  own copy of each module, and the code cache has no module cap: a long or code-heavy run (the user's Arch
  desktop, at login, with the compile worker on) dies in `jit_install`. The fix would be a
  `VmConfig` cap on modules per cache epoch (an ABI change) the host sets on SpiderMonkey only.
  Private windows have no OPFS (`getDirectory` throws SecurityError): no overlay, so no machine.
  Unmeasured: SpiderMonkey's speed. Driving it: Playwright's `firefox.launch({ channel:
  'moz-firefox', executablePath: '/usr/bin/firefox' })` (WebDriver BiDi, zypper's Firefox) with
  `firefoxUserPrefs: { 'memory.phc.enabled': false }` (PHC's stack walks hit the VM's
  SME-without-SVE in libgcc's unwinder: SIGILL) and `env: chromiumEnv()`.
- **Page tests on the build** (2026-10-24, bench/boot/REPORT.md "The page under Vite"): the page tests that only drive
  `/web/app/` could run on `vite build` behind Vite's preview server (built once per run, ~1 s), the shipped bundle,
  and ~150 ms sooner a machine start (529 vs 704 ms for Buildroot's); the harness pages (`tests/browser/`, `bench/`)
  and in-page imports (`import('/web/app/store.ts')`) stay on the dev server. Two servers in a suite; unmeasured on a
  whole CI run. `npm start` also rebuilds the page every time (~1 s: its output carries the commit); skipping it on
  unchanged inputs would need the stamp in the key.
- **The status bar's loose ends** (2026-10-24, frontend.md "The status bar"): no frame rate on `?display=simple`
  (`showFramebuffer` in the machine worker would need a count and a message); USB devices (mass storage included) count
  in no disk or adapter element (attached while running: the counters are per start); video decode's "hardware" is
  what a decoder asked for (WebCodecs doesn't say what it got; Chromium's `prefer-hardware` fails rather than fall back,
  so a decoding stream asked for it is in practice hardware); per-vCPU bars scale to the run's peak, not a fixed scale.
  The editor is mouse- and keyboard-driven (drag, Alt+←/→, Delete); touch drag isn't handled (HTML5 drag and drop).
- **A ramdisk as swap, set up for the user** (the user's idea, 2026-10-18): an option on a ramdisk in the Machines
  screen's disks menu that formats it as swap and turns it on in the guest, with nothing to do inside. The host can
  write the swap header itself (`mkswap`'s format: a fixed page with `SWAPSPACE2`, a label and the size) and hand the
  guest an `fstab.extra` systemd credential through SMBIOS type 11 (`LABEL=<label> none swap sw,nofail 0 0`, read
  by `systemd-fstab-generator`, systemd 254+: Debian 13, not 12), the same pipe as NUMA balancing's sysctl (spill-memories.md).
  The ramdisk is lazily backed, so swap costs host memory only as the guest fills it, and `swapon --discard` (in the
  fstab line's options) gives it back. Not a replacement for spill memories (swap runs guest code for every page;
  [spill-memories.md](spill-memories.md)), but useful where a user wants the kernel's LRU to decide.
- **Machines as the unit, loose ends** (docs/plans/machines.md §11):
  - **The exit's numbers weren't taken** (the user's call, 2026-10-18: low relevance for now, and they'd go stale
    beside unrelated optimizations). In Chromium 153, `bench/boot/REPORT.md` with JSON: a restore whose pins match
    (RAM and state only) against one that forks; a stored disk's import (Debian; the cloud: ~94–140 s, 1,043 MB); a
    merge; a kept snapshot's size and save time against a downloaded one's; the ramdisk's fio against one buffer
    (machines.md §4.3: kept if within noise). The cloud's boots written in place (221 s) and on a merged disk (290 s)
    were slower than its overlay boots (115–156 s), one run each on shared hardware; the user's boots of stored and
    merged disks by hand showed nothing like it. If anyone relies on in-place disks for speed, time those boots too.
  - **Off the record, the remote disks' block cache crowds out snapshots** (VK3 L3b): an off-the-record profile keeps
    OPFS in memory, where Chromium's sync handles come back short at ~0.8 GB in all while `estimate()` reports ~3.2 GB;
    the cache (web/diskcache.ts) sizes its budget from that estimate (a quarter of the free quota), so with a URL disk
    it takes the room a kept snapshot, a Restore's fork or a Suspend then finds full ("is it full?", "the browser's
    storage is full"). That was tests/page-snapshots.test.ts's failure from the cache's arrival (2026-10-23) to L3b; the
    test now runs on an on-disk profile, as a user's, where the estimate holds. A user in an Incognito window can still
    meet it: the snapshot and suspend writers could give the cache's stores up on a short write and try once more, as
    a guest's disk write does (`releaseStores`), or the cache could stay small off the record.
  - A full quota still reaches the guest as `IOERR` (and an import or a kept snapshot fails with "is it full?"): the
    page should say so where it happens, with the storage view's numbers.
  - A stored disk's SHA-256 isn't computed in the background (§3.1), and a definition carries a file's hash only
    where the record has one: a definition's file is checked by name, size and date unless something hashed it.
  - **Chromium 153 crashes reading a file handle back from IndexedDB in an off-the-record context** (the whole
    browser, SIGTRAP: a CHECK; an on-disk profile is fine; Chromium 141 was fine). The store keeps file disks'
    handles, so in an Incognito window the page's `store.all('disks')` would take the browser down once a file disk
    exists. tests/page-definitions.test.ts uses on-disk profiles for it. Repro: in a fresh `browser.newContext()`,
    put `{ h: await (await navigator.storage.getDirectory()).getFileHandle('d', { create: true }) }` into an object
    store, then get it. Check
    Chrome stable; if it reproduces there, report it upstream and keep handles out of IndexedDB off the record.
  - **Open disk… keeps no handle:** the first-run message's button and the Machines page's From a disk image… are a
    plain `<input type=file>` (main.ts `openDiskInput`), so the machine they make has a file disk without a handle,
    and after a reload its suspended copy resumes only once the file is picked again ("Pick and start", checked by
    name, size and date). A drop and the Add disk wizard (`showOpenFilePicker`) keep one, and a reload resumes after
    one click ("Allow and start"); both buttons could use the picker too.
  - **A second tab of a running machine** (the page opens the last machine by default) starts a worker, waits out the
    overlay's lock (10 s, `OVERLAY_WAIT_MS`) and fails with `disk-in-use`, naming the disk. Checking the machine's
    lock first (`isRunning`) would say at once that it runs in another tab, without a worker.
  - Several file disks re-granted at a start ask once each (`requestPermission` per handle).
  - `?display=simple` runs (the tests') are another shape than the same machine on the page, so their snapshots show
    as orphaned there (a 3D machine on a browser without WebGL2 is another shape too: decided, §11).
- **Clipboard for the screen:** paste into tty1 (typed through virtio-input, paced: its queue
  drops past 1024 events) and copy from fbcon; only the serial terminal has both (xterm.js).
  Phase C, host integration.
- **Keyboard layouts' loose ends** (the setting: [frontend.md](frontend.md) "The keyboard layout"): GNOME and
  KDE untested; the console keymaps (`vc`) other than `de-latin1` and `pt-latin1` were picked from kbd's files and
  kbd-model-map, not typed on; non-Latin layouts (a
  second, toggled layout and its `XKBOPTIONS`) not offered; `detectLayout`'s signatures are from the layouts' charts,
  checked against Chromium on one (US) keyboard only; a Mac's ISO keyboard swaps `Backquote` and `IntlBackslash` in
  Chromium's codes, which the guest then sees swapped.
- **Restart's "disk in use"** (the user's pass after phase A, 2026-09-29; loop 8 made restarts
  not overlap and ordered the overlay's hand-over with a Web Lock: [frontend.md](frontend.md)
  "Overlay hand-over"): whether the user's failure was that overlap or a browser releasing a lock
  before the handles is open (a `NoModificationAllowedError` in the message would say the latter;
  then a short bounded retry after the lock is the fix). The in-use message comes after a 10 s
  wait, with the page in Loading meanwhile: a "waiting for the disk" line would say why.
- **The ready marker is a per-machine regexp** over the serial output (Debian: agetty's
  `login: ` at a line's start). A guest that prints after its prompt, logs in automatically or
  has no serial getty would need its own; a guest-side signal (a byte on a port the page owns, a
  systemd unit writing to a device) would be exact. Revisit with image selection (phase D).
- **After phase B (the page's UEFI path):** a lone Esc takes ~2 s on the serial terminal and PageUp/PageDown aren't decoded by
  EDK2's terminal driver, and a fast run of arrow keys can lose bytes (the PL011's FIFO against a guest that polls;
  frontend.md "The serial terminal"); Debian's GRUB waits 5 s on every
  boot; loading a changes file also resets the variable store (the file doesn't carry it).
- **The Keyboard Lock** in full screen is checked by hand only: headless Playwright's keys
  bypass the browser's shortcuts, so no test sees Ctrl+W reach the guest.
- **Sound by hand only** ([audio.md](audio.md) "Tests"): the user confirmed playback and recording work (2026-10-12);
  no test can see the rest, because headless Chromium runs an `AudioContext` without a gesture (even with
  `--autoplay-policy=user-gesture-required`), never hides a page and grants its fake microphone without a prompt. Still
  to check in a headed Chromium: the real autoplay path ("Sound: click to hear", then a click); a hidden tab's wake (the
  worklet's notify, the sink's 5 ms timeout; if a hidden tab throttles the device worker, the wait's timeout is the one
  to look at, the notify comes from the audio thread); the microphone's prompt at the guest's first recording, the
  browser's indicator going off when it stops and a refusal's hint (e.g. on the desktop guest `pw-record /tmp/a.wav`,
  `pw-play /tmp/a.wav`, with and without Raw microphone); a video in Firefox on the desktop guest
  (`avsync.html?v=sintel.webm`) in sync by ear (the measurement is -17 to +20 ms after Firefox's first 4 s; decoded on
  the host since video V2, -10 to -13 ms median: plans/video.md §6).
- **Audio, not built** ([audio.md](audio.md)): capture controls (the controls are the output's Master volume and
  switch; the microphone has the browser's gain only), controls in the native twin and the snd guest (the page's
  machines have them, the test guests not: QEMU's device has none; Debian's ALSA is checked by the page test, the
  desktop guest's PipeWire by hand, `bench/audio/mixer-desktop.ts`), jacks and channel maps (none: Linux needs neither) and the stream events (xrun, period elapsed: none
  are sent); one output and one input stream (the guest's own sound server mixes), 1 or 2 channels (no surround), S16,
  S32 and FLOAT only; latency is the ring plus the guest's buffer plus the browser's (~100 ms is fine for video, an
  interactive use such as music software would want a shorter ring and measurement); Alpine's playback is unexercised
  (no `alsa-utils` in its image; Debian and Arch cover it); a tab in the background hasn't been measured (above).
- **A guest kernel (and distribution) built for the emulator** (2026-10-16, the user): the desktop guest's kernel was
  Arch Linux ARM's, configured for real hardware and debugging, and under the JIT that costs more than it would natively
  (kernel code is half of a busy vCPU's guest code in Firefox's pages session, and its short functions stall at every
  entry: `bench/boot/REPORT.md` "M8: where a busy vCPU's time goes in Firefox", `results/m8-warm/profile/kbucket.txt`).
  Of the kernel's samples there: `CONFIG_DEBUG_PREEMPT`'s checks (`debug_smp_processor_id`,
  `check_preemption_disabled`, `__this_cpu_preempt_check`, preempt count tracking) 3.8%, stack traces (debug) 1.5%,
  PSI 1.7%, and HZ=1000's tick and timekeeping 13.8%. **First step taken (2026-10-16):** the Arch images moved to
  arch.bens.haus's aarch64 port (Arch's own packages for ARMv8.0-A; [images.md](images.md) "Arch Linux"), whose
  `linux` is Arch's x86_64 configuration: no `DEBUG_PREEMPT`, `SND_VIRTIO=m` (no DKMS module of ours any more), still
  HZ=1000, `NO_HZ_FULL` (idle dynticks unless `nohz_full=` is given) and PSI on (`psi=0` on the command line turns it
  off without a kernel of our own). Next: the same Firefox session's profile on it (the ALARM numbers above are the
  baseline), then decide whether a kernel package of our own (lower HZ, PSI off) is worth maintaining; any such guest
  tuning stays optional, the emulator distro-agnostic.

- **The mouse lock's and touch's loose ends** (frontend.md "Input"; 2026-10-22): Esc always lets the mouse go (the
  browser's), so a guest under the lock never gets a held Esc; in full screen with the Keyboard Lock asked for Esc
  (`navigator.keyboard.lock(['Escape'])`) Chromium would deliver it and let go on a long press: untried. Raw sends
  to the relative mouse even before the guest has its driver (the firmware has none for it nor for the tablet,
  so nothing is lost there today); the worker's `deviceStatus` (as the keyboard's `live`) could make the lock fall back
  to the tablet then. Raw asks for `unadjustedMovement`, which isn't on every platform (then the host's acceleration and
  the guest's add up); unmeasured which. No wheel's horizontal axis (`REL_HWHEEL`) or high-resolution wheel on any pointer. The
  touchscreen's contacts have no size or pressure (`ABS_MT_TOUCH_MAJOR`, `ABS_MT_PRESSURE`), and a pen is the tablet.
  Checked on headless Chromium's synthetic events and on Debian's evdev, not on a real touchscreen or a desktop's
  compositor (GTK and Firefox on the Arch desktop guest).

## Snapshots (M8 phase C, snapshots lane; [plans/snapshots.md](plans/snapshots.md), [platform.md](platform.md) "Snapshots")
- **A restored machine's lost interrupt** (audio, [audio.md](audio.md) "Linux driver behavior"): under ten busy-looping
  processes beside the page's snd snapshot test, once in eight runs (before the last bound change; none in 51 runs
  since, 25 of them with the core instrumented), the restored guest never took the sound device's SPI again: CPU 0 took
  its timer interrupts, the core matched the completions and raised the line, the guest acknowledged twice, and
  `/proc/interrupts` stayed at 105. Not reproduced natively or in Node. If it comes back, the snd guest's EIO output
  has the status and interrupt counts; the next step is the GIC's view of SPI 51 when the line is high (the
  instrumentation that hid it: `Gicv3::dbg` into the device's spare config bytes).

- **9p's state isn't saved** (the server's tree and its fids): a VM with a 9p device refuses a
  snapshot. The page's machines have none; the device test and Alpine's test image do, so their
  host round trips run without it (`tests/snapshot.test.ts`). It needs the tree serialized with
  node identities (fids and unlinked-but-open files point into it).
- **The base image's hash is never written by the page**, so a snapshot only loads on a disk of
  the same identity (a URL's path and size, or a chosen file's name, size and modification time): a
  copy of the same image with another date is refused. `readSnapshot` already accepts a matching
  hash when the file has one (`SnapshotDisk.sha256`); what's missing is computing it off the save
  path (`hashSource`, web/changes.ts: ~640 MiB/s; cache it beside the overlay) and hashing the base at a restore
  whose identity differs.
- **The network across a snapshot:** the guest keeps its lease and its connections' state; the
  restored machine's card is on whatever the page connects it to now. A link down/up at restore
  would make the guest ask for a lease again; open connections are lost either way.
- **The guest's clock after a restore**: the catch-up is done (on by default) (docs/frontend.md "The guest's clock": the guest
  suspends itself for the file, PSCI SYSTEM_SUSPEND, and wakes with its clock moved on; why moving a running guest's
  counter can't: platform.md "System suspend"), and the virtio-rtc device. What's left:
  - **virtio-rtc against a running driver.** Checked against the driver's message formats only: Debian's kernels (up
    to 6.17 in trixie-backports) leave `CONFIG_VIRTIO_RTC` out. In the dev VM: our kernel (`images/linux`) with it
    on, the guest's `/sys/class/rtc/rtc*/since_epoch` and its PTP clock (`phc_ctl`, chrony's `refclock PHC`) against
    the host; the Arch desktop guest's kernel, if it has it.
  - **virtio-rtc's cross-timestamps** (READ_CROSS with the ARM virtual counter: the reading and CNTVCT at one instant,
    which the device worker would need the core's clock for) and **alarms** (an RTC alarm that wakes a suspended
    guest: `rtcwake`).
  - **Guests that don't sleep on the key** (no systemd-logind: Alpine with OpenRC; a desktop that takes the key and
    asks first) are saved as before; an agent (`guest-set-time`, [plans/agent.md](plans/agent.md) step 2) or a link
    flap for timesyncd (a virtio-net `VIRTIO_NET_F_STATUS` down and up on restore: Debian's networkd and timesyncd
    re-sync at once on it; networked guests only) would cover them.
  - **The host's own sleep** (a laptop's lid): `performance.now()` may not count it, so the guest's counter doesn't
    either and its clock falls behind as after a snapshot. The page could notice `Date.now()` moving away from it and
    run the catch-up (sleep key, skip, wake) by itself.
- **One worker compresses RAM** (the core's LZ): 0.44 s for 304 MB of pages. Four would take it
  to 0.15 s (`bench/boot/REPORT.md` "M8 phase C loop 4"); chunks must then be dealt out
  interleaved, not as ranges. And the file's blocks are copied through the codec's own instance
  (a second copy each way): compressing in place in the VM's memory would save it.
- **A restore empties the TLBs**, which Linux can tell by its step count (not its behaviour): a
  test that wants an unbroken run's steps through a snapshot needs a guest that doesn't lean on
  stale entries, or the count of a run with TLB flushes at the same points
  (`alpine-user-snapshots`). Saving TLB contents would need entries re-validated against the
  page tables at restore (they hold host addresses), which is most of a walk.
- **A tracked benchmark case for the page** (`page_debian`: page load to `running` with a fresh
  profile, measured today only by ad-hoc drivers and the end-to-end test; a snapshot
  load to `running`, a suspend and its resume, the file's size and the pause): the lane's numbers
  are the page tests' own timings, two or three runs each (`bench/boot/REPORT.md` "M8 phase C
  exit").
- **Save snapshot's pause is the file's write** (1.4 s for Debian's 175 MB through the picked
  file's stream; dropped, 2026-10-18, the user): holding the compressed file in memory and writing
  it after the resume would cut the pause to the compression's ~0.5 s, but the file is the guest's
  used RAM plus the disk's changes, so the page would briefly need up to a second copy of the
  guest's RAM, enough to crash it with a big guest on a small host.
- **Snapshots between core versions:** a state of another `snapshot::VERSION` is refused; a
  migration path (or a reader per old version) would keep users' files alive across a format
  change. Prebuilt snapshots shipped with the repository (a Debian that resumes in seconds for a
  first-time visitor) need this, or a rebuild at each format change.
- **Parallel round trips beyond the tests' guests:** save and restore work in parallel SMP
  ([plans/snapshots.md](plans/snapshots.md) step 5); not yet run through a snapshot on 4 vCPUs:
  Buildroot, the litmus and the stress guests, in Node and Chromium.
- **A held chain the guest overwrote** (it changed a buffer it had given a device) makes the
  machine unsaveable until that queue is reset (`vm_snapshot_size` = `u64::MAX`): only a broken
  guest does it; the page would say so and offer nothing.

## Network (M8 phase C, networking lane; [plans/networking.md](plans/networking.md), [tailnet.md](tailnet.md), [frontend.md](frontend.md) "Network")

- Loose ends: the menu's login-URL and approval states are `viewOf` unit tests only (no Chromium test against headscale); the page's Buildroot machine has no `network` entry (its kernel has virtio-net, but nothing brings the interface up); IPv6 to the internet through an exit node, and a real Tailscale exit node with its own nameservers, are untested; router advertisements repeat every 60 s only on a port backend; the network tests ran in cloud sessions (Chromium 141) as well as here (153), so recheck with `scripts/ci-net.sh` in the dev VM after a change.
- The Debian tests (`net-guest`, `page-network`, `net-tailnet`) take ~4 min: they run in `scripts/ci-net.sh`, not `scripts/ci.sh`.
- **Several adapters' loose ends** ([network-adapters.md](network-adapters.md)): a tailnet and tailcat
  both route fd7a:115c:a1e0::/48 (tailcat's tunnel addresses, its clients' too, are in it), so a machine serving
  tailcat beside a tailnet would answer tailcat clients over IPv6 through the tailnet's adapter (by reading,
  unchecked; the fix: per-peer routes instead of the /48); adapters can't be reordered (remove and add); a connection attached on the Machines page to a machine
  running in another tab connects at that machine's next start, not at once; a machine powered off with a client
  running keeps its connection (and its lock) until Disconnect, as the one card did; Log out is offered only where the
  connection runs on this page, and deleting a kept tailnet connection forgets the node without logging it out (it
  stays on the tailnet until it expires or an admin removes it).
- **IPv6 out's loose ends** ([network-adapters.md](network-adapters.md) §4 "IPv6 out", web/reach6.ts):
  - **A primary per family**: with tailcat as the primary and its IPv6 out, a second adapter whose IPv6 reaches out
    (a tailnet's exit node) could carry IPv6's default; `primaryOf` picks one adapter for both.
  - The real probe targets answering is checked by hand only (an exit node on the Mac, testing.md): the dev VM has
    no IPv6, so the tests' up case runs against `tests/net/resolver.ts` on a temporary address, and a Tailscale exit
    node reaching IPv6 out isn't tested at all (the Podman peer has none).
  - tailcat's lease names Cloudflare's resolvers only (1.1.1.1, 1.0.0.1, 2606:4700:4700::1111): where Cloudflare is
    blocked the guest has no DNS, though the probe now asks three operators. A second operator's in the lease would do.
  - The Network menu doesn't say a connection is IPv4-only.
  - `bench/gpu/firefox-load.ts`'s tailcat mode still drops the guest's IPv6 default and pins resolv.conf and
    gai.conf by hand; no longer needed, drop it at its next run.
- **tailcat serving loose ends**: no `--allow` list (any key with the address gets in, as with tailcat's own
  default; the module would check the meowing key); clients are never dropped (64 WireGuard peers at most, until
  Disconnect); disco pings aren't answered, so `tailcat ping` gets no pong (the data path works); the public-relay
  path (`nearestRegion`, the short-form address) is checked by unit tests and by hand against tailcat.dev's map
  and probes (they answer with CORS), never by a client through the public relays (opt-in by hand: serve with an
  empty relay, `tailcat ssh` from a machine with the internet); `tailcat ssh` itself wasn't run (the port path it
  uses is, with a web server in the guest); keeping the client's key when going online through a server (so a
  server can `--allow` it) isn't offered: serving uses the kept key, going online alone a fresh one.
- **tailcat loose ends**: an address that names only a region (tailcat's public relays) fetches
  `https://tailcat.dev/derpmap.json`, run against the real map once by hand (2026-10-23: `tailcat serve exit-node`
  with no `--key` on the Mac, region 303 Frankfurt, the page's Debian through it), never in a test; the relay's loss while running is
  covered natively (`relay_loss_while_running`, a server's restart) and in Node against the rig (a path cut off while
  its WebSocket stays open: tests/ts-tailcat.test.ts), not in a browser; a guest spraying UDP flows
  (a port per packet) slows a tailcat exit node to nothing (bench/net/REPORT.md "T1"), and ICMP isn't forwarded (no
  `ping` beyond the exit node): say so in frontend.md if users hit them; DF-clear IPv4 over 1,260 bytes is dropped,
  not fragmented (`nat46.rs`), unchecked with `tcpdump`.
- **The Rust Tailscale client's loose ends** ([tailnet.md](tailnet.md) "Tailscale"):
  - Subnet routes (on by default, a menu toggle; 2026-10-24): checked by unit tests and `viewOf`'s only, no subnet
    router in the Podman tailnet; an adapter that isn't the default way out learns a new IPv4 subnet route only at
    the guest's next DHCP renewal (option 121; IPv6's router advertisement is at once).
  - A tailnet with IPv6 addresses only gets no lease (the gateway's DHCP needs an IPv4 address: `leaseFrom`).
  - An exit node that goes offline or stops offering itself stays selected and the guest's internet traffic is
    dropped, as Go fails closed; the menu shows it "(offline)", but the status line still says "internet through" it.
  - IPv6 extension headers aren't followed by the filter (such a packet is judged by its first next-header).
  - MagicDNS answers A and AAAA only (no PTR for tailnet addresses, no SRV/TXT from extra records; other types
    forward); a query that no resolver answers within 10 s gets no answer (the guest's resolver times out and
    retries; Go answers SERVFAIL); its TCP side (`dns_tcp.rs`) and DNS-over-HTTPS fallback (Cloudflare, Google or
    Quad9 by `fetch`) are unit-tested only (the cloud has no DNS out; no guest test asks a name whose answer is
    over 512 bytes); a truncated answer over TCP from a resolver that isn't well-known goes back truncated (no TCP
    client in the module to ask it again).
  - The exit node's DNS goes as UDP to the tailnet's resolvers or 1.1.1.1, not to the exit node's peerapi DoH as Go's
    does (it would need a TCP client in the module): check against an exit node that blocks plain DNS.
  - Disco answers pings only (no CallMeMaybe, no pings of our own: a browser has no direct path to offer); Tailnet
    Lock is refused, not supported.
  - Headscale answers the first map ~2 s after registration for both clients, and a peer takes our new node
    0.6–0.7 s after our first handshake (docs/tailnet.md "Findings"; not ours to fix). Tailscale's own servers
    unmeasured: an auth key's ephemeral node there is where to look.
  - The module in the device worker instead of its own (one worker and one hop less): only if its cost there is
    small; the worker spends 3.1 core-ms per Mbit/s (bench/net/REPORT.md "T6"), unmeasured inside the device worker.
  - Go is left only for test fixtures: the Go client (`net/tailscale`) for `tests/ts-tailnet.test.ts`'s hand-over of
    a node it kept, and the tailcat rig's `derper` and `tailcat`. Dropping the hand-over test and building those two
    in a container image would remove Go from development and CI; the user kept Go (2026-10-17), so not before the
    Go client's store format stops mattering.

## USB ([usb.md](usb.md))

- **WebHID devices whose drivers patch the original descriptor** by its bytes or size (`report_fixup`) see
  our encoding instead. A table of known original descriptors keyed by vendor and product could serve
  them their real bytes when its parse matches WebHID's. No such device has been tried yet.
- **WebUSB's halts are emulated:** SET_FEATURE(ENDPOINT_HALT) never reaches the device (Chromium refuses
  it), so a device-side function that tests its own halt (rare outside usbtest) sees none. Only the
  guest's view is a halted endpoint (docs/usb.md "The WebUSB passthrough").
- **WebHID `receiveFeatureReport`'s framing** (the ID byte first with IDs) was recorded on Linux. Check it
  on macOS and Windows when a WebHID device is at hand there.
- **WebUSB reset** re-claims what it can after `device.reset()`. On hosts where the reset re-enumerates,
  WebUSB loses the device and the backend reports it gone. On Linux the interfaces are released before the
  reset and claimed again after (a reset with them claimed leaves Chromium's claims stale: docs/usb.md);
  which hosts re-enumerate on a reset isn't measured.
- **Most WebUSB fixtures are still transcribed** (`tests/usb/webusb-fixtures.ts`): the FT232R, the NESDR and
  a wired Xbox controller are recorded from real devices; the CP2102, the Pico, the Android composite,
  DAPLink, FX3 and USBasp are written from documentation. Replace each when such a device is at hand.
- **Device types untried on real hardware** (the real-device check, 2026-10-18, had an RTL-SDR, an FT232R and a
  wired Xbox controller, usb.md "Findings"): an Android phone (adb, fastboot after a reboot, the
  re-enumeration's new permission), a CDC-ACM board with the host's driver unbound, `dfu-util`, a sigrok
  analyser's firmware upload, and through WebHID a DualSense or DualShock 4 (USB and Bluetooth), a Switch
  Pro controller, a Stream Deck, a keyboard's VIA configuration and a UPS. Only the in-VM rigs cover the
  WebHID path end to end so far.
- **The controller's IMOD doesn't moderate:** the register is kept and interrupts aren't delayed. The
  completion latency (`xhci::LATENCY_NS`) does what the guest needed (docs/usb.md "Latency"); real
  moderation would need a deadline in the run loops.
- **Stop Endpoint's window in realtime mode:** a backend that gathers a TD's OUT data, or scatters its IN
  data, just after the guest stopped the endpoint touches a buffer the guest may have back. The glue drops
  a TD whose cancel is in the same batch, and deterministic mode can't hit it.
- **Isochronous transfers aren't implemented** (left out, the user, 2026-10-18): the controller parses isochronous TDs
  and posts them one packet per TD, but no device takes them. Building them means scheduling by frame, per-packet
  results in the completion, WebUSB's `isochronousTransferIn/Out`, and an isochronous alternate setting on Gadget
  Zero to test with (dummy_hcd has none). Few devices would gain: WebUSB protects audio and video, so it is
  vendor-class devices only (a wired Xbox controller's headset jack, some cameras).
- **Game pads that aren't HID and that the host holds** (a wired Xbox controller where the host's driver keeps it):
  the Gamepad API could feed an emulated USB HID game pad with a fixed descriptor of ours (its standard mapping,
  rumble through `vibrationActuator`), on the same controller. Not built; where WebUSB gets the device, `xpad`
  already works (docs/usb.md "Findings").
- **Serial adapters the host's driver holds** (Linux's `ftdi_sio`, `cp210x`, `cdc_acm` without a udev rule): WebSerial
  could feed a virtio-console port instead of the passthrough (the multiport console, plans/agent.md). Not built.
- **A WebHID device across Suspend:** Snapshot and Suspend unplug every device first. The emulated HID device's
  state is small (idle rate, last reports), so it could be saved and its `HIDDevice` opened again at resume, keeping
  a game pad plugged in as far as the guest knows.
- **Carry-over and sequence numbers:** a cancelled IN's data goes to the next read on that endpoint, which a
  protocol that cancels, then expects only fresh data with sequence numbers, would notice. None seen yet.

## Tests and tools

- **Out-of-context reviews of Venus's other areas** (testing.md "Out-of-context reviews"; the user, 2026-10-27: after
  VK3's fix loops for the green's review): (1) the translator, NIR → WGSL (vk/compiler/), and the caps and features the
  device advertises against what WebGPU allows; (2) the driver outside the import path: descriptors and bind groups,
  pipelines and the shader store, queries, command recording and replay (vk/driver/, web/venus-gpu.ts). Each a cloud
  session with a neutral brief, as the green's (`origin/review/venus-green`).

- **Screening an A/B** (docs/benchmarking.md; `bench/boot/REPORT.md` "M8: benchmarks started from a snapshot"), what
  wasn't measured: the churn page's functions run once and die, so it doesn't test how a cache policy keeps a reused
  hot set (a `hot=<n>` query that keeps calling the last n functions would); the real sites at 320 MiB in a run long
  enough to flush (six at 20 s didn't: more cycles or longer dwells), and whether their flushes look like the
  churn's; the churn screen ran one round (main, 160 MiB, the A/A), so its noise band is from one pair; a pages
  session cut to its first pages (`PAGES=wiki,mdn`) as a screen was read off full sessions' counts, never run.
  The real sites mode drops the guest's IPv6 by hand, which the client's IPv6 probe has made unnecessary ("IPv6
  out's loose ends", above).

- **`linux-gpu`'s build number isn't pinned** (audio's finding, [audio.md](audio.md) "Linux driver behavior"): the `#N` in a kernel's version
  string grows with each rebuild in the same tree and moves its guest's step count (469 steps for `linux-snd` from `#2`
  to `#1`); `linux-snd` pins `KBUILD_BUILD_VERSION=1`, `linux-gpu` (at `#2`) doesn't, so a rebuild would move `gpu`'s
  steps. Pin it in the commit that next rebuilds it (with the step change and the user's OK).
- **Firefox and Safari compatibility pass** (moved out of M8 by the user, 2026-09-28; Chromium
  stays the target): the user checks Firefox by hand (never automated here); WebKit could run
  through Playwright. Matters most once the page is publicly hosted. **Found so far (the user's
  check, 2026-09-29):** in Firefox the core runs and the kernel boots, but Debian doesn't find its
  root filesystem and drops to the initramfs emergency shell, so /dev/vda (virtio-blk) doesn't
  work there. Unverified suspects: the virtio-blk backend's disk path in the device worker
  (range reads by synchronous XHR in a worker with `responseType = 'arraybuffer'`; qcow2's
  compressed clusters through `DecompressionStream`), the overlay's OPFS sync access handles in
  a nested worker (and now its Web Lock), or the device worker's doorbell (`Atomics.waitAsync`
  on shared memory). The serial log (Save serial log) from Firefox would show whether virtio-blk
  probed at all and what the first failing request was.
- LTP: only the syscalls subset; the loop-device tests (`getdents01`, `rename01`) and other areas
  need `mkfs` tools, a scratch disk and more RAM. kselftests: not `fp` (minutes of stress) nor the
  generic suites.
- **`tests/pause.test.ts` hung twice under `scripts/ci.sh`** (2026-10-18, its file cancelled after 1,337 and 1,351 s: "Promise
  resolution is still pending but the event loop has already resolved", so a pause or an end that nothing will
  resolve, with no timer left), passed alone and 9 times in 3 copies at once. Which of its tests is unknown (a
  cancelled file prints none); its tests have a 2-minute deadline since. **A third time 2026-10-24**, after the
  deadlines: 20 min at ~1% CPU, nothing printed. Its diagnostic report (`kill -USR2`: the runner starts files with
  `--report-signal=SIGUSR2`) had no timer, no worker and no socket, only the pipes to the runner: no test's deadline
  timer was armed, so it waits outside a test (a top-level await or a hook, where per-test timeouts don't apply).
  Next: a deadline on the file's own setup, or the same report taken earlier with the JS stack of each pending await.
- **`clockOffset`'s test** (`tests/threads.test.ts`) failed once under `scripts/ci.sh`'s load (2026-10-18: off by
  0.23 ms against its 0.2 ms bound; its delays are spin loops), passed alone 5 times: a margin to widen if it recurs.
- `coremark_vm_jit`: pass a fixed iteration count through init's arguments so a run can't fall
  under CoreMark's 10 s rule.
- The PC-sampling profiler samples once per chunk (32K steps).
- `performance.mark`/`measure` around compile, instantiate, device I/O and boot phases.
- `core/fuzz`: `Mismatch::key` is dead code in the libFuzzer target build (a warning, not in CI).
- Guest images: `images/build.sh alpine` can't run on the arm64 VM ([images.md](images.md)).
- **Alpine's package pins drift:** the container is pinned by digest but `apk` reads the live repository,
  so a pinned version that leaves it breaks the build (2026-10-02: `openssl-dev=3.5.8-r0` had gone, 3.5.9
  needs the newer libcrypto; `KERNEL_TOOLS` is bumped, `USERLAND_PKGS`' `openssl=3.5.8-r0` for
  `alpine-user` has the same problem when that image is next built). A mirror of the pinned packages
  (or `apk` against a dated snapshot) would end it.
- `images/Containerfile` and `images/alpine/user/webpc-user.start` still cite PLAN.md sections
  from before the docs moved; they're image inputs (editing them makes the images stale), so fix
  the comments with their next rebuild.
- **`kvm-unit-tests` still builds under qemu-user** in the x86_64 `images/Containerfile`, the last
  image there (`buildroot` and `ltp` moved to the multi-arch `images/buildroot/Containerfile`
  on 2026-10-23). Moving it (Debian arm64's own gcc answers to `aarch64-linux-gnu-`; an x86_64 host
  keeps `gcc-aarch64-linux-gnu`) means editing that file, which `inputs()` hashes into every
  image's key: do it with a change that rebuilds them anyway, and hash it only into the images
  built in it. Also: `buildroot` and `ltp` each build the same toolchain (~8 min of each build);
  a shared one (Buildroot's `make sdk` as an external toolchain, keyed by its own inputs) would
  save that on the second.

- **No consumer left:** `web/bootfs.ts` and `web/ext4.ts` (the ext4 reader that took Debian's
  kernel and initrd out of its disk; only `tests/ext4.test.ts` uses them: remove them or keep them
  for a later feature); `images/stress/` and `bench/stress`/`bench/mem`'s `GO` path route Debian's
  initrd, which the page's UEFI boot ignores (docs/images.md: put the binaries on a second disk
  to revive them).

## Upstream reports (to file at the project's end)

Bugs found in other projects, kept here until the user's round-up of upstream reports; each with what's needed to
report it. Nothing has been filed.

- **Mesa, virgl's VA-API driver offers I420 and YV12 decode surfaces** ([plans/video.md](plans/video.md) §1, §4):
  `virgl_is_video_format_supported` is `vl_video_buffer_is_format_supported`, which only checks that the planes'
  formats sample and render, so `vaQuerySurfaceAttributes` lists NV12, YV12 and I420; FFmpeg's
  `vaapi_decode_find_best_format` then takes I420 for H.264 and VP9 (yuv420p), and Firefox's VA-API path (NV12, YV12,
  P010, P016 only) falls back to software ("Unsupported VA-API surface format"). Real drivers offer NV12 (and P010/P016)
  alone for decoding. Fix: virgl answers decode entrypoints with NV12/P010/P016 only. Seen with Mesa 26.2.4, libva
  2.24.1, FFmpeg 9.0.2, Firefox 157. Our workaround: the `webpc-va` package (`images/arch/webpc-va/`), which goes
  away with the fix.
- **Mesa and virglrenderer disagree on virgl's video profile numbers** ([plans/video.md](plans/video.md) §4,
  [graphics.md](graphics.md) "Video"): the wire carries Mesa's `enum pipe_video_profile`, and Mesa 26.2's has dropped
  `MPEG4_SIMPLE`/`MPEG4_ADVANCED_SIMPLE` (and added HEVC 4:2:2/4:4:4 profiles) that virglrenderer's copy (`c8e3fc3b`)
  still has, so every later value (H.264, HEVC, VP9, AV1) means a different profile to each. The protocol needs its
  own fixed numbering.
- **Mesa's virgl AV1 decode loses three things** ([plans/video.md](plans/video.md) §10; Mesa 26.2.4,
  `src/gallium/frontends/va/picture_av1.c`, `picture.c`, `src/gallium/drivers/virgl/virgl_video.c`): the VA frontend
  writes `refresh_frame_flags = 1` whatever the frame refreshes (a stateful host decoder needs it; webpc keeps its own
  slots instead); it sets `film_grain_target` in `vlVaEndPicture`, after `vaRenderPicture` has sent the frame's desc
  (virgl's `decode_bitstream`), so a host never learns the surface a grained frame is shown from (virglrenderer's
  host VA-API path writes the target, the guest shows the other surface; webpc-va 2 works around it); virgl's
  `fill_av1_picture_desc` doesn't copy `lr_unit_size` (the shifts are copied). Repro: the guest's `ffmpeg -hwaccel
  vaapi` on an SVT-AV1 clip with `-svtav1-params film-grain=8` against its software decode.
- **Chromium (libyuv's SME kernels) SIGILLs on CPUs with SME but no SVE** (Apple M4 under Linux, e.g. a Lima VM;
  plans/video.md §4): reading a decoded `VideoFrame` (`copyTo`, a WebGL upload, `createImageBitmap`) faults at `cntd`
  in the prologue of a locally streaming function compiled with SVE (LLVM saves the vector length with an SVE
  instruction there). Seen with openSUSE's Chromium 153.0.8010.52 on aarch64; libyuv picks SME from
  `getauxval(AT_HWCAP2)`. Our workaround: `tools/nosme` as `LD_PRELOAD` for the tests' Chromium.

