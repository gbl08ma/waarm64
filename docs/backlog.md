# Backlog

Open items no milestone owns yet, by area. Pick one up when a milestone touches the area or a
measurement says it matters, and move it into that milestone's plan when it's scheduled. **Add to
this list rather than leaving TODOs in code** (the code marks a few with `ponytail:`).

## CPU and ISA

- **Unadvertised extensions the M4 has**, in case real workloads benefit: FP16 (scalar and
  AdvSIMD), RDM, FHM, FCMA, BF16, I8MM, LSE2, LRCPC2. Not MOPS (`CPYP`/`SETP` & co as a host `memory.copy`):
  copies run at 7-21 GB/s under the JIT and are under 2% of a browser's profile (`bench/boot/REPORT.md`
  "M8: the device round trip"). Each needs handlers, corpus groups (the generator
  already knows how to avoid them), the ID fields, a decoder-sweep update, a `VmConfig.features`
  bit, and the rule: advertised unless measured slower than what guests do without it (PLAN.md).
- **DotProd and JSCVT on x86-64:** measured on the M4 only (bench/boot/REPORT.md "FEAT_DotProd and FEAT_JSCVT,
  measured"). SDOT's order was picked there; `extmul_high` is several instructions on x86, so it may lose to
  widening with `i32x4.dot_i16x8_s`, by an estimate of 14 ops to 12, or to even and odd bytes at about 10. Run
  `bench/imgdecode/codecs.ts` on the user's desktop or a similar host before tuning. **FlagM's forms are helper calls**:
  inline them if a workload shows them.
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
  alignment faults (with the MMU off too, where every access is Device: on the M4 an unaligned load and DC ZVA fault,
  QEMU's TCG only the load; the flat bus exists to have no such test; correct firmware doesn't notice); no
  address-size fault for VAs past 40 bits with the MMU off (external abort); PRFM with a misaligned SP base faults.
- **A tagged PC** (found 2026-10-30, against the M4): with TBI, BR, BLR, RET and ERET to a tagged address keep the tag in
  the PC (`AArch64.BranchAddr` removes it: the top byte is bit 55's sign extension), so ADR, BL's X30 and ELR show it.
  Reached only by code that branches through tagged pointers; TBI0 is on for every Linux process. A check in every
  indirect branch would cost the JIT's hot path. Untried: a tagged PC always misses the transfer cache and the
  same-page chain, so canonicalize it on those slow paths and never fill an instruction TLB entry for a tagged VA.
- **Watchpoints** (found 2026-10-30, against the M4, `interp/debug.rs`): an atomic read-modify-write is checked as a store
  alone, so a load-only watchpoint misses LDADD and CAS, a failing CAS included; and the check comes before the
  translation, so a watchpoint on an unmapped address beats the translation fault (M4 and QEMU: translation fault).
  The first has to tell RMWs from STXR, which shares `cas`; the second needs a probe of the translation first.
- **Reserved AdvSIMD encodings with FPEN 0** take the FP trap (`interp.rs`: `fp_enabled` before the handler's field
  checks); on the M4 they're UNDEFINED. Harmless to a kernel that enables FP on the trap: the retry is UNDEFINED.
- **Exclusives and LSE on device memory:** an LDXR reads (through `Io`, with LDAR), its STXR and the LSE atomics take
  an external abort. What hardware does there is IMPLEMENTATION DEFINED; not compared with the M4.
- **Arm AARCHMRS JSON:** its in-package notice is unread (`THIRD_PARTY.md`); read it only to
  generate decoder tables or coverage checks from it.
- **A timing-bound GPU test flakes in the cloud** (2026-11-01): tests/gpu.test.ts "ring fences that fill the queue and
  stall…" waits 300 ms for `RING_STALL_MS` (250 ms); when the stall timer fires a little early against
  `performance.now()`, the check re-arms for another 250 ms and nothing has come back at 300 (`0 !== 25`). In a cloud
  session it failed 3 to 4 times in 8 alone, the same before and after the commit tested; not seen in the dev VM. Waiting
  for the entries (bounded) instead of a fixed 300 ms, or a stall check that tolerates an early timer, would settle it.
- **Corpus depth:** thin FP flag paths (8 `fp_scalar` tests raise Divide-by-Zero); add biased forms
  when touching FP again.

## Interpreter

What the block interpreter's speed track (2026-10-21/22, `bench/interp/REPORT.md` "M8-INTERP loop 0" to "loop 11")
left open, most promising first.

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
  ADRP+ADD as a pair (0.5% of the pairs); SUBS's flags in
  `hot` from its operands, as the JIT's (`x >= y` for `add_with_carry`'s two carries). Not tried, settled by a measurement: tail-call dispatch (`become`), since
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
    Re-emitting would shrink the code too: a jump-cache tail is 61 B and a probe for a successor in another page 116,
    against 22 for a direct call, 9.7% of Debian's code (the wasm size item below).
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
  zero-filled share from 40.2% to 39.7% (not kept for the zero-fill; its wasm was 0.6% smaller, which counts on its
  own with the wasm size items below: `no-base-local.patch` in `bench/boot/results/m8-liftoff/baseruns/`). The lever is getting functions to 12, which dropping scratch
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
  - **The single FMA's midpoint test** (the emulated arm only: the fused arm has none, so this now reaches only hosts
    without FMA3 or relaxed SIMD; not worth doing for them): folded into the result's mask and reduction, with the
    round-to-odd redo in the failure arm before the helper; saves a reduction (two lane ops), not the test.
  - **Vector FMUL's zero clause** in a branch on a zero result lane, as the scalar form's: about two lane ops a
    product (the FP guest has none to measure it on; llvmpipe's shaders do).
  - **`relaxed_trunc` for the FCVTZS/FCVTZU fast path**: only worth it if it measures on x86, where the deterministic
    saturating truncation costs extra ops (on arm64 `fcvtzs` already saturates, so it can't gain here). Unmeasured: the
    dev VM has no x86 Chromium. The FMA forms took relaxed SIMD's other useful op (jit.md "Floating point").
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

- **Groups of accesses' leftovers** (docs/jit.md "Loads and stores", `bench/boot/REPORT.md` "Groups of accesses,
  measured"). Probes left on Firefox's pages session, of those with no groups at all: 74% with today's rule. Untried: two
  or three probes in one `if` (accesses off another base inside a group: 72%, 71%; followers need a second `HOST`) and
  instructions with flags among a group's (SUBS, CSEL: 72.3% with any instruction, the bound). Register offsets (5.6% of
  accesses) have no static span. Across blocks, 46% of probes land on the page of one of the function's last two
  probes, which no group can reach: the region's next lever if probes ever matter, though no time difference has
  come from removing them yet.

- **Where the JIT's wasm bytes go, and what could shrink them** (2026-10-30, a static census of Debian's boot and a
  shell workload on the page: every module with each instruction's and each piece's byte ranges, 35.1 MB of function
  bodies; `bench/boot/results/wasm-size/` README, not weighted by execution, no timings; Firefox's pages session and
  Alpine weren't in that session, so check the shares there first). Block tails are 42% of the code, inline
  instructions 43% (TLB probes 10.3%, slow arms 7.5%), failure chains 9%, NZCV commits before branches 3.5%, prologues
  2%. Two costs cut across them: **materializing NZCV, 13.2%** (~67 B each, 86% of them SUBS's; SUBS's has since lost about 16 B of its 74 and 69, `bench/interp/REPORT.md` "SUBS's NZCV from its operands"), and **linking to the
  next block, 17.3%** (`block::chain` 13.9%: jump-cache tails 6.2%, transfer-cache probes for uncompiled successors in
  another page 3.5%, guarded direct calls with their probe 3.4% at 190 B each; BR/BLR/RET's probes 3.4%). Register
  write-backs are 15.6% (7.5 B each) and PC stores 3.2%, what exact state at exits needs. Untried, by size:
  - **NZCV in small functions of the module** (`nzcv_sub64(x, y)` and kin, the store at the site or in it: 8-11 B a
    site): in the failure chains alone (cold) ~3.5%, everywhere ~11%. V8 inlines direct wasm calls of up to 500 wire
    bytes by default, from Liftoff's call counts, but Liftoff's code pays a call, and TurboFan is sensitive to where
    NZCV is computed (`bench/interp/REPORT.md` "M5 step 6"): the hot sites need an A/B.
  - **`local.set N; local.get N` as `local.tee N`**: 294,000 pairs, 1.7%, mostly HOST and scratch read at once. A
    peephole in `wasm::Code::local_get` must not merge across a `mark` a `rewind` can return to (`Func::skip_addr`).
  - **A guarded chain's fallback as the miss function**: after the instruction-TLB check fails, tail-call the
    imported `xmiss` (which fills the transfer cache) instead of probing inline: ~1.8%, on a path that seldom runs.
    The same for an uncompiled successor in another page (~3%) puts a path that stays hot (regions aren't
    re-emitted) behind two probes and one shared indirect call site: measure.
  - **One budget counter on region edges**: `acc + left` is constant in a function, so an edge could update one
    of them (~1.2%), for one local more (Liftoff's zero-fill, the item above).
  - Below ~0.3% together: a 0 added (`const 0; add`, mostly an access's address at offset 0: 0.22%); UBFM as LSR or
    LSL (today a rotate and a mask, LSR's mask a 64-bit constant Liftoff builds), SXTB/SXTH/SXTW as `extendN_s`,
    CSET/CSETM as the condition itself, `ADD #0`: 0.1% in all. Register offsets past 128 take a 2-byte memarg (~1 B
    on half the write-backs). Folding MOVK chains was counted at ~0.2% before ([jit.md](jit.md) "Tried and not kept").
  - **Not worth trying again:** outlining the jump-cache tails or BR/BLR/RET's probes into a shared function (6.2% and
    3.4%) puts every site behind one `return_call_indirect`, losing per-site prediction: out-of-line jump-cache probes
    were slower ([jit.md](jit.md) "Tried and not kept"), and a browser's time stalls at those tails already (the
    indirect transfers item above).

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
- **A handle read back off the record:** in an off-the-record profile (Incognito; Playwright's `newContext`), Chromium 153
  dies reading a record that holds a `FileSystemHandle` from IndexedDB (storing it is fine; on a disk profile all is):
  a host folder there, and a disk kept as a file handle, take the browser down at the next read of their store. Nothing
  tells a page it is off the record. Found by tests/page-folders.test.ts, which runs on a disk profile; not yet tried on
  another Chromium build or filed upstream.
- **Shared folders, long names on a host folder:** past 248 bytes Linux's errno is wrong: a write to a file of 249 to 255
  bytes answers `EIO` (its session can't open), and creating a name past 255 `EIO` rather than `ENAMETOOLONG`
  (bench/shares/REPORT.md). Write permission can't be granted headless, so the tests' host backend writes OPFS directories
  and `bench/shares/index.html` is opened by hand.
- 9p: no HTTP-served tree, as v86's lazy filesystem. The memory tree's umask is the client's even under a default ACL
  (devices.md "9p"); shared folders have no xattrs (docs/shares.md §8).
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
- **virgl fuzzing's reach** (docs/testing.md "virgl fuzzing"): no seed trace uses stream output or Z32_FLOAT_S8X24
  uploads, and the fuzzer's decoders give no pictures, so those paths and the picture writes aren't fuzzed. A trace of
  dEQP-GLES3's transform_feedback and depth32f_stencil8 cases (`CAPTURE=`) and a decoder that outputs small pictures
  would add them.
- **Desktop GL 3.0 and 3.1 on WebGL2** (graphics.md "What isn't backed"): they need what WebGL2 lacks or has only as
  extensions: `gl_ClipDistance` (`WEBGL_clip_cull_distance`), depth clamp (`EXT_depth_clamp`), conditional
  rendering, the sRGB framebuffer switch, texture buffers, base vertex
  (`WEBGL_draw_instanced_base_vertex_base_instance`). Caps that follow each extension, where a workload needs one.
  Geometry and tessellation exist in neither WebGL2 nor WebGPU, so desktop GL above 3.1 isn't reachable on WebGL2
  (on WebGPU through compute, as Vulkan's renderer does: graphics.md "Vulkan through Venus"; only if a real workload needs it).
- **A WebGPU backend for virgl** (GLES 3.1: compute, storage buffers), only where `navigator.gpu` gives an adapter.
  It could share what Vulkan's renderer learned of WebGPU (graphics.md "Vulkan through Venus").
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
  `ffmpeg -hwaccel vaapi` reading frames back, as in transcoding; plans/video.md §7, §12): every frame right, 120 frames
  in 2.1 s on the Mac (23 s before the call queue's waits became per picture and per submit), a drain now and then
  where the decoder holds more pictures than the guest sends before it waits. Filler pictures (plans/video.md §12:
  measured, exact, then dropped) took it to 1.5 s; worth bringing back only if transcoding in the guest matters, with
  their hazards (OpenH264 under Chromium's FFmpeg wants nothing sent until a filler has left the queue).
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
  snapshot's RAM chunks don't cover yet) and the window itself: VK4's tier 4 (VK4-KICKOFF.md).
- **Venus's use-after-free fix has no test** (VK1 L8, vk/patches/vkr-wasm.patch): a device memory freed while its blob
  is mapped; covered only by the scene's probe (`bench/vulkan/guest.ts venus`). A unit test needs Venus commands
  encoded by hand (or a recorded stream replayed through `venus_submit`).
- **`npm start` doesn't build Vulkan's renderer** (VK2 L7, vk/README.md "On the page"): vk/build.sh clones and builds
  Mesa and virglrenderer natively first (minutes, meson and Mesa's build dependencies), so the preparation leaves it
  out and a user's copy has Vulkan only if they built it. A prebuilt module fetched by hash (as the firmware could be)
  would bring it to every `npm start`.
- **Pipelines' loose ends after VK3 L3** (REPORT.md "VK3 L3", vk/README.md "Pipelines made asynchronously", "The shader
  cache"): (1) render pipelines are made when a draw is recorded; made at vkCreateGraphicsPipelines from the pipeline's
  static state (the viewport's flip and dynamic state guessed), most would be ready before the first frame records,
  at the cost of some never used: unmeasured. (2) SwiftShader's compile isn't kept across a browser restart (Metal's
  and NVIDIA's are, through Dawn's cache in the profile and the driver's own: REPORT.md "VK3: the NVIDIA run after L2b"). (3) The
  store's entries are kept uncompressed (vkQuake's 3.5 MiB) and loaded whole at Vulkan's start; CompressionStream on
  the way to IndexedDB would hold ~3× more under the same budget. (4) The store isn't shown on the Machines page's
  storage line nor cleared from it, and its 32 MiB budget is fixed: the user wants it configurable (2026-10-26; the
  budget and the origin-wide scope are approved: entries are keyed by content, so one program on two machines shares
  them). (5) A pipeline made at once by a submit (`syncPipelines`) is counted, never seen.
- **What the device advertises, left for the translator** (VK2 L7, VK3 L5; vk/README.md "The shader path"): subgroups
  are WGSL's only where the adapter's have one size (Intel's and AMD's vary: there, subgroups of one invocation; a
  size the shader could ask for would need WebGPU's `subgroup-size-control`, which Chromium has as experimental), in
  compute and fragment shaders only, `gl_SubgroupID` assumes subgroups are runs of `local_invocation_index` (true on
  SwiftShader and Metal; unchecked on NVIDIA), and a subgroup-scoped barrier is dropped; 8- and 64-bit types,
  16-bit integer arithmetic (`shaderInt16`: the lowering to 32 bits exists, the advertising and its dEQP-VK groups
  don't) and 16-bit inputs and outputs (`storageInputOutput16`: varyings are vec4s of 32-bit types). **Subgroups on
  the Mac are held** (VK3 L5, bench/vulkan/REPORT.md "VK3 L5"): Chromium 153's Metal path hoists a ballot that is an
  `if`'s only subgroup operation out of the `if` (repro: `web/venus-gpu.ts` `subgroupsRight`'s kernel, 0xffffffff for
  an odd invocation where 0xaaaaaaaa is right); with the check off, 89 of 503 sampled subgroup cases failed there
  (`bench/vulkan/results/vk3/l5/mac-before-check.json`), arithmetic and f16 shuffles in graphics. To do: report it
  to Chromium (Tint's MSL or Apple's compiler: unknown), and try a translator workaround (another subgroup operation
  beside each ballot in an `if`), then lift the hold where the check passes. On the Mac with `shader-f16`, 226 of 233
  sampled `spirv_assembly.*.float16` cases pass: 6 fail on 16-bit infinities and NaNs (WGSL lets a backend assume
  none: values come back 0) and one graphics shuffle's WGSL nests ifs past Tint's 127 (an indexed f16 vector's `if`
  tree). The per-stage descriptor limits follow one count of what WebGPU takes since VK3 L7a ("Bindings past
  WebGPU's" below).
- **YCbCr's gaps** (VK3 L7.2; vk/README.md "YCbCr conversions"; on by default since L7.3, `?gpu=vkycbcr=off`): only the 8-bit multi-planar formats (2- and 3-plane 420, 422, 444): WebGPU's 16-bit normalized formats
  (tier1's) are unfilterable, so P010 and the 10-, 12- and 16-bit formats would need a nearest-only offer or filtering
  in the shader; no single-plane 422 formats (YUY2: WebGPU has none, they would be decoded from words); optimal tiling
  only (a linear image can't be sampled here anyway); no explicit chroma reconstruction nor a chroma filter apart from
  the sampler's (Mesa's implicit reconstruction, which dEQP-VK's conversion cases pass); planes aren't attachments or
  storage images. Failing (out of `tests/deqp/vk-ycbcr.txt`): **an image aliasing a
  plane's memory** (48 `plane_view.memory_alias`: images are textures of their own, never their memory's bytes). **No
  multi-planar image on external memory** (VK3 L7b, the review of L6b-L7.3's finding 4: refused by the image-format
  query, since its planes' textures were neither imported from an imported memory's resource nor registered as
  shared): an import would take each plane's region of the resource (`gpu_texture_import` at the plane's offset).
- **GTK4 on Vulkan: the bar met on the M4, the default not taken** (VK4 T13, bench/vulkan/REPORT.md "VK4 T13–T14"; GTK
  takes GL by default, so only `GSK_RENDERER=vulkan` meets Venus). Since the pump's ticker, iconscroll runs at 33 frames/s
  on the M4 against GL's 28–32, frames at GL's CPU a frame, fishbowl at 60. Left: (1) NVIDIA and SwiftShader not
  measured (Linux's `waitAsync` was never stretched: there the gain is the shorter period's alone); (2) GTK takes Vulkan
  by default only with a dma-buf modifier other than LINEAR (sway on virgl would have to import it): the decision that
  makes GTK4 Vulkan's, VK4's tier 4; (3) each fenced queue submit costs the guest two execbuffers (Mesa 26's fences are
  DRM syncobjs signalled through the virtqueue; no feedback path), 3 a GTK4 frame, and GSK's ~70 synchronous
  `vkAllocateDescriptorSets` a frame (Venus's pools go synchronous once sets of mixed layouts are freed) each a ring
  round trip: both the guest's Mesa's, which a guest patch could change; (4) the ticker's busy cost (~50 ms a second of
  the GPU worker at iconscroll) could drop if the ticker read the rings' tails itself and woke the pump only for work;
  a submit held for the guest's own signal keeps the pump turning at the ticker's pace as long as it's held.
- **A WSI image exported as a buffer isn't shared** (VK3 L1): Mesa's prime blit (a device Venus takes for another
  GPU's, or NVIDIA's) exports a linear buffer each frame is copied into; web/venus-share.ts shares only images
  (`venus_resource_texture`), so such a window is black, with a warning. Sharing a buffer would need the driver to name
  the memory's GPUBuffer, writes to buffers tracked like textures' and a buffer-to-texture copy with the import's
  stride. Not needed while no guest takes that path.
- **Venus at 1 fish on NVIDIA: 2.4–2.6 ms a frame against virgl's 1.5, parked by the user** (2026-10-26: 1 fish isn't
  representative; likely NVIDIA's driver latency or its GPU leaving low power slowly; Venus is ahead at 1,000 fish and
  the toolkit). The leads: Chromium notices a lone pass done ~2.2 ms late there (1.2 nudged, at once under load), the
  scene's pass ~0.9 ms of GPU (the M4's 0.41), a frame's `Queue::Submit` ~1.55 ms in the GPU process (REPORT.md "VK3:
  the NVIDIA run after L2b"; the 134 MB trace in `bench/results/local/vk3-nvidia-l2b/`), 2.5 ms at c8087cb0 (the
  same WebGPU calls: the next entry). The floor before it (~4.5 ms
  a frame: a ring poller on a clamped `setTimeout(0)`, Dawn's slow look at a done submit) was fixed in VK3 L2 and
  confirmed there (REPORT.md "VK3 L2", "VK3: the NVIDIA run after L2").
- **Venus's submits ~2 ms later on NVIDIA since 4fdc69fb** (VK3's final NVIDIA run; REPORT.md "VK3: the final NVIDIA
  run", "VK3 L9a", "VK3: the NVIDIA run for L9"): at c8087cb0 a scene submit is done 5.4 ms after it's made at 1 fish
  (3.3 at 4fdc69fb), 6.9 at the toolkit (4.9), mpv's 4.9 (3.9); a frame 5–40% dearer, still under virgl's at 1,000
  fish and the toolkit. The GPU's pass and the encoding unchanged, a frame's Dawn `Queue::Submit` 1.56 → 2.53 ms of the
  GPU process's CPU. Not on the M4 or SwiftShader (alternated A/B), the same WebGPU calls (counted on SwiftShader), and
  none of the suspects (`?gpu=vkl9=features|limits|bindgroups|pad|all`, 4fdc69fb's behaviour: `all` no cheaper).
  Next: a bisect on NVIDIA itself, a bundle carrying the page at several of the 34 commits between them (`git log
  4fdc69fb..c8087cb0 -- vk web`: the images shared, ~20 MB a page) run as alternated arms in one session; or Dawn's
  own trace categories (`dawn.validation`, per-command timings) at both commits, which would name the slower command.
- **Presentation's gaps** (VK2 L4, vk/README.md "Presentation"): a fullscreen Vulkan window isn't tried (wlroots may
  scan a client's dma-buf out directly: `SET_SCANOUT_BLOB` of a Venus blob, `ERR_UNSPEC` today, would need the
  screen to draw a WebGPU texture); images written only by compute (storage) aren't marked written, so they aren't
  copied again; WSI formats other than 8-bit RGBA, `rgb10a2unorm` and `rgba16float` aren't shared (a warning, a black
  window); a browser that renders with a GPU but whose WebGPU canvases fail would lose its GPU channel on the bitmap
  way (`shareMode` decides by the renderer's name: no such browser seen; `?gpu=vkreadback` is the way out); the
  readback way holds the compositor's submit for its wait (7–10 ms a frame at 1080p on SwiftShader).
- **Imports' gaps** (VK2 L6, vk/README.md "Imports"; mpv on Vulkan meets its bar regardless):
  - **Mesa's async present drops a present after a failed one** (VK3 L4e, REPORT.md "VK3 L4e"; vk/README.md "The
    guest's Mesa"): Venus's `vn_wsi_present_async` (Mesa 26.x, main as of 8598bb5c) returns the previous present's
    error for the next present, of any swapchain, and drops that one unsubmitted (frame never shown, present fence
    never signalled): a cold mpv's fullscreen window froze and it couldn't exit, also at a file's end. The desktop image
    works around it with `VN_PERF=no_async_present`. Left: report it upstream ("Upstream reports" below), and drop the
    workaround once Arch ships a fix;
    mpv on SIGTERM wasn't rechecked. **The hosted desktop disk needs replacing** with one built since L4e (the
    local one is) before a deploy of the page, which since L4e takes libplacebo's advanced path by default
    (`?gpu=vkformats=held`: off), so that an old disk's first cold mpv doesn't meet the freeze.
  - **Every frame's planes are written again** (libplacebo imports a surface each time it shows it): ~0.2 ms of the
    GPU worker and 0.6 MB a frame at 480p, ~3 MB at 1080p. A Venus texture per resource, kept while the resource lives
    and written only when a picture changes it, would make a bind free.
  - A resource with no picture written yet is read back once at its first import (WebGL's synchronous `readPixels`);
    what the guest renders into a virgl resource after it is imported (rather than a decoder's picture) never reaches
    Venus's copy. Nothing makes the guest wait for a picture before it samples the import (`vaSyncSurface` waits for
    nothing): a draw queued before the picture lands samples the texture's earlier bytes (vk/README.md "Imports").
- **Dawn in the guest's Chromium on Venus** (VK3 L7.1's remainder: bench/vulkan/REPORT.md "VK3 L7.1", "VK3 L7.1b").
  The device has what Dawn's backend needs (the indexed arrays, sample-rate shading), but Chromium's Dawn takes a
  system Vulkan device only with `--enable-features=Vulkan`, and then Chromium's own Vulkan device needs
  (1) `samplerYcbcrConversion` (`vulkan_device_queue.cc` refuses a device without it; backed since VK3 L7.2, by
  default since L7.3), (2) **opaque-fd semaphores**: it exports them though Venus offers
  only sync files (its properties for opaque fds say 0). The host refused to make them and the context died (fixed in
  L7.1b: the driver drops the export's other types); now the guest's Mesa (26.2.5, `vn_GetSemaphoreFdKHR`, asserts
  compiled out) hands back fd 0, then -1 (`bench/vulkan/semfd.ts`), and Chromium's GPU process dies on "FD ownership
  violation", likely of that fd 0 (no symbols; also with `--disable-gpu-compositing`; `--use-gl=disabled` gives no
  adapter at all). A way through would be on the guest's side: Chromium exporting what the device offers (sync files),
  or Venus backing opaque-fd semaphores (a Mesa change: VK3 L7.2 found the guest's Venus offers sync files only,
  hard-coded, and never passes the export or the fd request to the host, so neither vkr nor the driver can answer
  it; the patch would offer `OPAQUE_FD` where the renderer has external sync and export the semaphore's DRM syncobj
  as an opaque fd, `vn_renderer_sync_export_syncobj(…, false)`, in a patched Mesa in the guest images); an upstream report for the fd 0 at least (an error, not a
  descriptor it doesn't own). (3) A window: Chromium calls Wayland incompatible with Vulkan, and the desktop image has no Xwayland;
  `--headless=new` starts (its frames would come out through the page's log). `bench/vulkan/dawn-frames.ts guest` runs
  the samples (ARMS: the flags; CR_ENV: the environment; LOGBEFORE: the log up to a line) and compares them with the
  dev VM's; `CHROMIUM_ARGS="--enable-unsafe-webgpu --enable-features=Vulkan"` for the host's side.
- **ANGLE's row's gaps** (VK3 L7.4; vk/README.md "The shader path", "Commands"), each for when a program or dEQP-VK
  needs it:
  - **Transform feedback**: queries (`transformFeedbackQueries`: `VK_QUERY_TYPE_TRANSFORM_FEEDBACK_STREAM_EXT`, ES3's
    `TRANSFORM_FEEDBACK_PRIMITIVES_WRITTEN` through ANGLE; the advance dispatch knows the primitives written and
    needed, a query's two values would be its sums), `vkCmdDrawIndirectByteCountEXT` (`transformFeedbackDraw`),
    primitive restart in a captured draw (captured without restarts, warned), streams past 0,
    `transformFeedbackPreservesProvokingVertex` (the records in Vulkan's order whatever the provoking vertex:
    `rasterization.provoking_vertex.transform_feedback.*` not supported), 16-bit outputs, records past 512 bytes, a
    program of four bind groups (the capture's own takes one: push constants past the immediates or draw parameters in
    group 3 with sets 0 to 2 used; the capture refused at the pipeline's creation since VK3 L7a), and `gl_ClipDistance`'s capture (`transform_feedback.simple.xfb_clipdistance_*`: the 8th
    distance reads 0). Each captured draw is a compute pass of its own with a copy of its index and vertex ranges (VK3 L7a: one storage
    binding for them all), and a copy of each bound range in and out per capture: fine for dEQP's sizes, not measured
    on a real program. An indexed or indirect captured draw copies its vertex bindings whole from their offsets (an
    indirect one its index range too: the CPU knows neither the indices nor the count), so one past
    `maxStorageBufferBindingSize` (a big shared vertex buffer bound whole) is skipped with a warning (VK3 L8a, the
    track-end review's finding 2, which fixed a direct draw's index range); bounding them would take the indices'
    range from a compute pass first, or a capture that reads the vertex buffers through bindings of their own.
  - **The provoking vertex**: indirect draws whose last vertex provokes (drawn as they are, warned; a pass would write
    their indices and arguments), adjacency topologies (not supported), and a compute pass and a scratch range per such
    draw (ANGLE draws with flat varyings only where a shader has them: not measured).
  - **ANGLE with Chromium's own Vulkan device too** (`--use-angle=vulkan --enable-features=Vulkan` in the desktop
    guest; bench/vulkan/angle/es3.html through `PAGE=… bench/vulkan/dawn-frames.ts guest`, results/vk3/l74/): its 24
    uniform blocks' sum draws 205, not 156 as with `--use-angle=vulkan` alone and on GL (the flat varying and the
    capture right in all three). Not the uniform buffers (VK3 L7a, bench/vulkan/REPORT.md "VK3 L7a"): 205 is 156
    sRGB-encoded exactly. There Chromium gives WebGL an `R8G8B8A8_SRGB` mutable image (format list SRGB, UNORM), and
    ANGLE's only attachment view of it is the SRGB one, which the multisampled UNORM target is resolved into
    (`results/vk3/l7a/angle-es3-vulkan-views.log`, a debug build's). Next: why ANGLE renders the resolve through the
    sRGB view there (Chromium's SharedImage format with Vulkan, ANGLE's sRGB write control), against ANGLE on lavapipe
    through Venus's advertised set (bench/vulkan/profiles/run.sh).
  - **Uniform buffers**: 13 a stage (WebGPU's 12, less the push buffer's, and 2 of the storage buffers); a layout's
    texel buffers take uniform bindings too (their parameters), which can push more uniform buffers into storage than
    the 2 the storage count gives up (refused at the pipeline's creation since VK3 L7a, saying why).
- **vkd3d on Venus** (VK3 L7.5; bench/vulkan/vkd3d.ts, bench/vulkan/REPORT.md "VK3 L7.5"). With draw parameters, Arch's
  vkd3d 1.19 makes a Direct3D 12 device at feature level 11_0 in the desktop guest (without them it stops at
  `VK_KHR_shader_draw_parameters`); 11_1 and up are refused. What vkd3d says 11_0 lacks (it makes the device anyway):
  `maxPushConstantsSize` (D3D's 256 bytes of root constants; Vulkan's 128 here), `viewportBoundsRange`,
  `viewportSubPixelBits`, `maxPerStageDescriptorUniformBuffers` (14 wanted, 13 here), dual-source blending (SwiftShader's
  adapter only), geometry and tessellation shaders, `multiDrawIndirect`, `multiViewport`, `occlusionQueryPrecise`,
  pipeline statistics queries, cull distances, `shaderImageGatherExtended`, `shaderStorageImageWriteWithoutFormat`
  (vkd3d's UAV-clear pipelines then don't translate: "a storage image of format PIPE_FORMAT_NONE", 10 at device creation),
  vertex attribute divisors, sampler min/max reduction. vkd3d's own tests (tests/d3d12, built by
  `target/vkd3d/build-tests.sh`: `TESTS=` in vkd3d.ts): test_draw_instanced, test_draw_indexed_instanced and
  test_root_constants pass; test_vertex_id fails 39 of 89 (as at L7.5 after VK3 L7b captured indirect draws, so not those alone: VK3 L8's check; and a
  capture of a program of four bind groups, which a vertex stage reading draw parameters makes likelier, since they
  bring the push buffer's group 3), test_instance_id 24 of 372 (instance step rates of 0 and 2: divisors; its 1-byte
  vertex stride pulled since VK4 T5), test_clear_render_target_view 16 of 280 (views of another format and 3D/array views:
  "The Vulkan driver's gaps"). The next steps by promise: a run of the whole
  d3d12 suite for a ranked list, multi-draw indirect (the driver already loops over a draw count, each draw with its
  own parameters' place), and a real program (vkd3d's demos need an X window: none in the guests). The draw
  parameters' cost (a push-buffer place and a bind of group 3 a draw whose bases change) isn't measured on a program.
- **The Vulkan driver's gaps** (VK2 L2, L5; vk/README.md "The driver"), each for when a program or dEQP-VK needs it;
  dEQP-VK's failures by cause. VK4 T1's census (bench/vulkan/REPORT.md "VK4 T1": every 100th case of the direct set's
  groups, 16,489; on SwiftShader 2,448 pass, 498 fail, 2 crash, the rest unsupported, the M4 alike) counts every cause
  in its table (`bench/vulkan/census.ts`); the counts below without a date are L5's samples
  (`bench/vulkan/results/vk2/l5/deqp/`). The cases that fail stay out of `tests/deqp/vk.txt`:
  - **Not advertised, by what dEQP-VK asks** (VK4 T1's reasons, bench/vulkan/REPORT.md "VK4 T1"): a queue family
    with compute and without graphics is the commonest (18% of the census's not-supported cases: `pipeline`'s compute
    variants want one; a second queue family, compute-only, over the same WebGPU queue would serve them), then
    `VK_KHR_maintenance*`, protected memory, cooperative matrices, formats, multi-draw, pipeline statistics queries.
  - **`api.info.image_format_properties2.*` of the YCbCr formats time out** (VK4 T1's "crash" of `r12x4_unorm_pack16`,
    VK4 T2): with `DISJOINT` in its create flags the case makes ~340,000 synchronous queries, ~0.1 ms each through
    Venus's ring, so it passes in 34 s (`WATCHDOG=disable`) but past dEQP's 30 s watchdog; out of the list. A guest's
    synchronous calls' latency is T13's.
  - **External memory's leftovers** (VK4 T2, R6): the guest's export imported again aliases its memory while the
    memory or an import of it lives, on its own device; otherwise (every one freed before a new import, another
    device) the import is a memory of its own whose bytes aren't shared (vkr's patch, `wg_AllocateMemory`; not met by
    dEQP-VK). An import that wants device addresses of a memory that hasn't any and already has a buffer is refused
    (`VK_ERROR_INVALID_EXTERNAL_HANDLE`: the buffer's GPUBuffer is in use). Images on external
    memory (`api.external.memory.*.image.*`) aren't offered: an image is a texture of its own, which an import can't
    share.
  - **Compressed images that aren't whole blocks' leftovers** (VK4 T18; vk/README.md "Samplers in the shader"): each
    size of such an image a program samples is a variant of its program (the size is in the key; a texture's real size
    can't tell it, a uniform would cost a binding); a padded cube's gather is refused; anisotropy is lost on them; the
    shader's filter's cost on a program is unmeasured (none replayed has such an image). A corner of the cube's seam
    takes one face's texel, not Vulkan's three. `texture-compression-unaligned`, if Chromium ships it, replaces all of
    it (`padded` false).
  - **Copies WebGPU refuses**, what VK4 T10 left: a multisampled copy between formats of a block's size goes through a shader that
    carries the bits (VK4 R4, `bitsBetween` in web/venus-gpu.ts), for 8-, 16- and 32-bit channels of unorm, uint, sint and
    float; others (`rgb10a2`, packed layouts whose fields differ) are skipped with a warning. A float16's signalling NaN
    doesn't survive it. A linear blit from a padded compressed image filters into the padding at its last texels. GFXReconstruct's trimmed captures restore their depth images through the worker's
    paths (vkQuake's first replayed frame).
  - **Views in another format's leftovers** (VK4 T4; vk/README.md "Views in another format"): every failure left in
    `image.mutable` is multisampled: view formats WebGPU can't multisample
    (`r32_sint`, `r32_uint`, the `rg32` ones: such an image's alias can't be made), in 2D and in arrays, and 3 sRGB-twin resolves, each in both,
    (`b8g8r8a8_srgb_b8g8r8a8_unorm_draw_copy_resolve_mutable_color_att` and two more: colours off by ~0.26 in green and
    blue, no WebGPU error, on SwiftShader; not run on the M4). Also not backed: a multisampled copy between
    formats (bit patterns can't cross a draw; an attachment that keeps its contents meets it), a shared or linear
    image's view in another format (what others read is its own texture), views of another block size (uncompressed of
    compressed: `BLOCK_TEXEL_VIEW_COMPATIBLE`), and, in one render pass, a write through one format read through
    another (no copies in a pass). `image.mutable`'s `store` and `load` cases are NotSupported here (dEQP asks for
    multisampled storage): checked once by reporting samples for storage in a throwaway build, 113 of 371 passing, none
    failing, the rest not supported (`results/vk4/t4/store-probe/`). The copies' cost on a program isn't measured
    (ffmpeg's and libplacebo's filters are the ones to measure: whole subresources, per switch of format).
  - **Multisampled arrays' leftovers** (VK4 T12; vk/README.md "Multisampled arrays"): a shader sampling a whole
    `sampler2DMSArray` reads the first layer (it needs a binding per layer and a switch on the layer in the translator). The
    48 of `multiview.*multisample*` ask for `r32g32b32a32_sfloat` and the `image.mutable` r32 ones for views WebGPU can't
    multisample, without a format list saying so: no texture can back those.
  - **Packed 16-bit formats' leftovers** (VK4 T12; vk/README.md "Packed 16-bit formats"): the two 1.3 orders
    `A4R4G4B4`, `A4B4G4R4` and `A1B5G5R5` aren't offered; the same path would take them. A view of another format of the
    16-bit class isn't offered.
  - **Pulled vertices' leftovers** (VK4 T5; vk/README.md "Pulled vertices"): a program with four groups of resources
    has none to pull from, and its pipeline stays refused (group 3 could take the bindings); more pulled bindings than
    the vertex stage's storage buffers left; a pulled range past `maxStorageBufferBindingSize` is cut there. What pulling
    could back next, each a few lines of the fetch: vertex attribute divisors (`iid / rate`: vkd3d's other 24 of
    test_instance_id, tier 4), and formats WebGPU's vertex buffers lack (three-component 8- and 16-bit, scaled:
    816 and 120 of `vertex_input`'s 10,825 cases not supported by their names; 4,080 are `legacy_vertex_attributes`,
    an extension not advertised; the other reasons not looked into). Its cost isn't measured: nothing we run meets it but dEQP-VK
    and vkd3d's tests (a bind group per change of the ranges, and a shader's bytes decoded per vertex).
  - **Formats**: (ASTC's failures on SwiftShader were the padded blocks above, on Metal too); D24 depth tests fail by one unit (depth24plus's precision);
    3-component formats in images (`glsl.440.linkage` makes RGB32 attachments: `VK_ERROR_FORMAT_NOT_SUPPORTED`).
  - **Samplers' leftovers** (VK4 T8, T9; vk/README.md "Samplers in the shader"): a border on a view of several levels, a
    shadow sample past level 0 and a mirror-once with an offset pick their levels in the shader, so those samples lose
    anisotropy; a texture of one level sampled at a LOD past 0 through a sampler whose mag and min filters differ reads the
    mag filter (WGSL's compare is at level 0); `textureQueryLod` ignores anisotropy; a shadow cube's filter past a corner
    of three faces takes the two nearest; a depth texture sampled without a comparison in a stage that doesn't compare it
    picks the nearest level at an explicit LOD (a linear mip filter's blend is lost, WebGPU filtering no depth); a gather of a shadow cube bound as its faces
    is refused; an integer cube both sampled and gathered is refused (its
    one binding can't be both; none seen); each base of `vkCmdDispatchBase` is a compute pipeline, never evicted (a
    tiler's cost, not its results: `wg_compute_based`, the review's C7); a browser without `texture-component-swizzle` ignores mappings, said once
    (a fallback needs `texelFetch` keyed too, and every Chromium backend has the feature); the variants' compile on a
    program's first draw with such a sampler is unmeasured (no replayed program meets one).
  - **SwiftShader's fetch from a view with a base level** (VK4 T8): `textureLoad` at a view's level 0 reads the level
    after it (a 16×16 image's view from level 2 reads level 3's texels, zeros past its size; level 1 reads right), where
    sampling is right and the M4 is too, so
    `image_view.*.subresource_range.lod_base_mip_level*` of integer and (VK4 T18, fetched too) padded compressed formats
    fail there only and stay out of `tests/deqp/vk.txt`, which SwiftShader runs. Lavapipe couldn't be put under Chromium
    to tell SwiftShader from Dawn's Vulkan backend: `bench/vulkan/nvidia.sh` `VK2_STEPS=t18` asks NVIDIA, in the next
    batch of the user's runs. Not looked for in SwiftShader's sources.
  - **Shaders**: texture offsets that really aren't constants (`*_pcoffset`, 2,760 cases, need `maintenance8`, not
    advertised); derivatives in non-uniform control flow
    (`glsl.derivate.*dynamic_if`); `umulExtended`. From the out-of-context review of the translator (VK3 L4f left them):
    signed and unsigned atomic min or max on one array (refused: WGSL's atomics have one
    type; shared memory is one array); flat
    varyings of 32-bit ints and floats that `nir_opt_varyings` packs into one location travel as the location's last
    load's type (bit-exact unless a backend canonicalizes NaNs or flushes denormals in varyings: not seen, untested).
  - **Multisampled image clears** (VK4 T12, R4): 60 to 63 of 184 run of `clear_color_image.2d.optimal.{multiple_layers,
    remaining_array_layers}.*_sample_count_4` read 0 where a colour is expected, or the reverse or a colour of neither,
    which cases hanging on what ran before them, so likely a read of memory nothing wrote (3 of 26,337 failed in one full run, some of which pass in the list's order and fail run as a group): every
    `r8g8b8a8_unorm`, `b8g8r8a8_unorm` and packed format (RGBA8 underneath) fails; `r8`, `rg8`, sRGB, integer and float
    formats pass. Not the review's X4 (a copy of several layers) and not reproduced by `misc: a multisampled copy of two
    layers`, which resolves a second layer rightly. Every case of those formats is out of the list (VK4 R4: some had been in it, passing by their order). Also 4
    `resolve_image.diff_image_size.dst_256_256_11_4_bit*`.
  - **Queries** (occlusion queries count on the GPU since VK3 L6a: vk/README.md "The driver"): two queries active at once (Vulkan allows it across pools), one past slot 4,096, or
    one begun in a pass and cut by a WebGPU pass's end inside Vulkan's is reported as passing, warned once;
    `occlusionQueryPrecise` isn't advertised (WebGPU promises nonzero, not a count); the host's
    `vkGetQueryPoolResults` can't wait (`WAIT_BIT` answers `VK_NOT_READY` until the submit completes; Venus's guest
    reads its feedback buffers instead); `vkCmdCopyQueryPoolResults` makes a copy and a write a query (a compute pass
    would be one dispatch, for programs that copy thousands); timestamps are the CPU's at replay (`timestamp-query`): a
    program's "GPU time" under Venus, VK0's scene's included, is the replay's span, not the GPU's (VK3 L2b; the worker's
    `?gpu=vkgputime` measures the GPU's).
  - **Rendering**: 2D views of 3D images are attachments only (`VK_EXT_image_2d_view_of_3d` isn't offered: dEQP-VK's
    `image_2d_view_3d_image` not supported; sampling one needs a slice in the shader). Stencil state per face is a draw split by face (VK3 L6a), so the order between one draw's front
    and back primitives is lost where they overlap (not seen in dEQP-VK); with depth clipping off, WebGPU's clamp to the viewport's
    range stays, so a float depth past it isn't kept; `gl_Layer` isn't offered (layered passes reach their
    later layers by load ops and clears alone), depth and stencil blits, 34 of
    `renderpasses.*.load_store_op_none`'s 149 supported cases (VK3 L6a, after DONT_CARE stores over a partial render
    area were made stores: WebGPU's discard is the whole attachment's): those of its 34 whose cause was a depth output
    without a depth aspect or an integer resolve are fixed since VK4 T10 (not re-counted), 5 `*_alphablend` and
    4 `color_load_op_load_store_op_none`/`color_load_op_none_store_op_dontcare` not looked into (none fail in VK4 T12's run of
    the group), early fragment tests (`fragment_operations.early_fragment`: `samplemask_early_fragment_tests_depth_samples_4`
    passed only while depth resolves were dropped, and is out of the list since L4f); a draw whose colour blends with both `CONSTANT_COLOR` and
    `CONSTANT_ALPHA` (WebGPU has one constant: the colour's taken, warned; 4 of the Mac's 49 supported
    `pipeline.*.blend.dual_source` samples, and the same states in `blend.format`); a storage buffer the fragment
    stage writes and the vertex stage reads (refused: no writable storage in WebGPU's vertex stage); non-indexed fans
    past 65,536 vertices not drawn (said once), indirect ones cut there, indexed indirect ones too (their list is sized
    by a fan: VK4 R4); an indirect draw with the last vertex
    provoking drawn as it is. Depth and stencil resolves: SAMPLE_ZERO only (VK3 L4f; a sixth of
    dEQP-VK's SAMPLE_ZERO `depth_stencil_resolve` cases in the list since L7.1, stencil8's above); MIN, MAX and AVERAGE
    aren't advertised.
  - **Usage scopes' leftovers** (VK4 T3, R2: vk/README.md "Usage scopes"): a pass or dispatch that writes storage of a
    memory it reads otherwise reads copies taken at its start. Left: writable bindings of one range, one an array of
    atomics and one not, or together past `maxStorageBufferBindingSize` (said once, refused by WebGPU); a descriptor
    beside a pointers' binding, and overlapping descriptors there, don't see each other's bytes in the scope, and its
    shadow's copy back overwrites what pointers wrote anywhere in its range (the review of R1 to R4's W2: going through the
    pointers' binding at the descriptor's distance, as `aliased_text` does, would serve); a variant per distinct
    offset between overlapping dynamic bindings, and a crop per size of a view, are kept until their program or view goes; a barrier
    of a secondary command buffer doesn't end the scope; a range past `maxBufferSize` isn't copied (warned, the
    scope dropped as before). Not met by anything measured (dEQP-VK's likeliest groups of the direct set, vkd3d's
    suite: bench/vulkan/REPORT.md "VK4 T3"), so the copies' cost is unmeasured on a program: DXVK or a VMA-based
    program whose shaders write storage would show it (vkQuake met the dispatch's shape in VK3 L6c).
  - **Sample counts Vulkan wants but WebGPU lacks** (the review of L4f's finding 3): `framebufferColorSampleCounts` is
    1|4 (Vulkan's minimum) though `R32G32B32A32_SFLOAT` and `R32G32_SFLOAT` colour attachments have 1 sample (WebGPU
    multisamples neither): `api.info.image_format_properties.2d.optimal.r32g32_sfloat` and `.r32g32b32a32_sfloat` fail,
    the last of that group (VK4 R7), out of `tests/deqp/vk.txt`; an emulation (a 4-layer texture
    resolved by a draw) or nothing. An image made for sampling only reports 1 sample, which falls short of
    `sampledImageColorSampleCounts` (1|4) for formats WebGPU multisamples (its textures are multisampled only as render
    attachments: the driver would add that usage). A multisampled image of more than one layer is accepted but invalid
    in WebGPU (no multisampled arrays; Vulkan's format query can't say so: `maxArrayLayers` is per format). The integer
    limits (`framebufferIntegerColorSampleCounts`, `sampledImageIntegerSampleCounts`) are 1 since L5b, as the 32-bit
    integer formats allow.
  - **A trap in the module's completion on NVIDIA** (VK3 L9b, seen once): `RuntimeError: table index is out of bounds`
    from `wg_complete`. VK4 T2 found a sync freed while a submit naming it is pending or held makes the completion call
    the freed sync's type (`function signature mismatch` in Node) and fixed that (`wg_sync_finish`); whether it was
    NVIDIA's trap shows only in the user's next runs there (a completion that throws is still warned: `a submit's
    completion failed`).
  - **`memory.binding.*.buffer_1048577` fails on NVIDIA** (VK3's final run and L9's, `results/vk3/nvidia-l9b/`): every
    binding mode (regular suballocated, dedicated, overallocated; aliasing suballocated) at 1 MiB + 1 byte, without
    the trap above; every other size passes there, and every one on SwiftShader and the M4. dEQP's message wasn't
    kept (DETAIL's 20 lines went to other cases): the next run there gets it (`nvidia.sh VK2_STEPS=l9b`, now with
    `DETAIL_MATCH=memory` and the guest kernel's log). A size not a
    multiple of 4 against WebGPU's copy and map alignment is the first suspect. Kept in the pass list (an
    adapter-only failure is filed, not removed).
  - **Synchronization**: a submit waiting on a timeline value nothing has signalled is held until the value is met
    (VK3 L6a: `tests/venus-driver.test.ts` "waitBeforeSignal"); dEQP-VK's `synchronization*.timeline_semaphore.
    wait_before_signal.*` can't check it here: every case is NotSupported for want of `vertexPipelineStoresAndAtomics`
    (WebGPU's vertex stage has no writable storage; were it offered, a draw split by face for its stencil state, whose
    vertex stage runs twice, would double its stores: vk/README.md "Commands"). A submit of signals alone behind held
    ones is held too. With the control queue full and no ring fence retired and nothing sent for 250 ms, a fence gives its queue entry back
    and is signalled by the next one of its ring with an entry (VK4 R1, docs/devices.md "Venus"): **a guest waiting for such
    a fence alone, while the ring's newest waits for what it does next, waits for ever** (the review of R1 to R4's C2;
    none seen, and a stall of a full queue would have hung it anyway).
    A larger queue isn't the way out: that queue being full is what paces a compositor (docs/devices.md, "Flush replies
    are paced"), and 256 of them would put 4 s of replies ahead of each fence.
  - **Device addresses' leftovers** (VK4 T7; vk/README.md "Device addresses"): all address memory is one storage binding
    away, so an allocation with the flag past `maxStorageBufferBindingSize` fails though the heap has room: DXVK puts every
    allocation there (no shader of it reads through pointers, so it needs none of this but the place). Every use of a
    GPUBuffer shared by all address memory counts as that buffer's, so a scope that writes storage of any address memory
    copies its reads of all of it: unmeasured on a program. `shaderInt64` (`OpConvertUToPtr`, 504 of
    `buffer_device_address`) and capture and replay (`bufferDeviceAddressCaptureReplay`) aren't offered; the 64 KiB past each
    memory bounds a uniform block widened past its range there.
  - **API 1.3's required features** (the user, 2026-10-28: 1.3 stays advertised; the rest of VK3 and VK4 fill them as
    they go): `timestampComputeAndGraphics` with timestamps that are the CPU's (above). A program that relies on 1.3's
    guarantees without checking them fails at pipeline or descriptor creation.
  - **The M4's own failures** (out of `tests/deqp/vk.txt` until they're understood; none is what VK4 T12 fixed there,
    `generate_mipmaps.from_previous_level`): `fragment_operations.early_fragment.discard_no_early_fragment_tests_depth` (an
    occlusion count of 496 where 1,024 is right), `texture.mipmap.3d.projected.nearest_linear_mirror`,
    `texture.mipmap.cubemap.projected.nearest_linear_linear_repeat`; 11 copies to or from `e5b9g9r9_ufloat_pack32`, compared
    bitwise (Metal looks to canonicalize the format's bits on upload: unconfirmed; a texture of `r32uint` would keep them,
    and no program depends on non-canonical bits); 4 `depth_stencil_resolve.*_stencil_samplemask` (the stencil reads 255
    where 1 is right); 2 of 3 `binding_model.descriptorset_random.sets4` cases (a fragment stage's output reads zeros: the
    third passed in T12's run).
  - **SwiftShader compiles zero-initialized workgroup memory slowly** (VK4 T2): Dawn zeroes it through Vulkan's
    `VK_KHR_zero_initialize_workgroup_memory`, which costs SwiftShader ~17 s per pipeline with a 16 KiB array (19 ms
    with Tint's loop: `--disable-dawn-features=use_vulkan_zero_initialize_workgroup_memory_extension`, which the
    dEQP-VK runs pass). Only Chromium's SwiftShader WebGPU (`--enable-unsafe-webgpu`) meets it; a guest compute program
    with much workgroup memory waits that long for its pipeline there. Worth an upstream report (SwiftShader).
  - **What R7's limits leave** (VK4 R7, its review's B4, B8, D4): 16 vertex bindings need a free bind group and room in the
    vertex stage's storage buffers, or the draw is refused, said once (four groups in use, or a vertex stage's own storage
    buffers); 8 dynamic uniform buffers with push constants past the immediates or draw parameters put the push buffer on
    a dynamic storage binding, which a layout with all 4 of those, or a stage full of storage buffers, doesn't have (the
    pipeline is refused, said once; a push binding without a dynamic offset, a bind group per draw, would serve); a
    uniform block declared past its range and the 64 KiB pad at a memory's end loses its submit. A set with inline blocks
    has a GPUBuffer of 64 KiB more than them, for what its shaders may declare.
  - **Memory**: `memory.binding.aliasing.suballocated.image_*` fail (9 sampled by VK4 R6, 2 others pass): each image is a
    texture of its own, so two images bound to one range don't share texels. An allocation past the device-local heap, the largest
    GPUBuffer or the arena, which Venus's guest doesn't wait for, is an empty memory (`memory_refused`): a blob's map gives
    zeros that go nowhere and a buffer past its bytes loses its submit, where a program learns less than from
    `VK_ERROR_OUT_OF_DEVICE_MEMORY`. Host-visible memory the arena has is had past its heap. Only
    the guest's `VN_PERF=no_async_mem_alloc` would give the error back; a program within its budget doesn't meet it
    (VK_EXT_memory_budget is advertised).
- **Nodes 2 and up in one memory64 behind a second JIT arm** (bench/spike/memory/REPORT.md §6, VK4 T19). Memory 1 stays
  wasm32 (node 1, and on a Vulkan machine the renderer and window, behind today's arm). Nodes 2 and up, which an access
  reaches today only through the interpreter (2–17× node 0's time), would share one memory64 of up to 16 GiB, reached
  by a second arm. That access pays memory64's check and V8's base reload: M0.5's M4 kernels put that layout (D) at
  +26–32% per access on macOS, where memory 1's accesses carry no check. Each load and store on such a machine would
  also carry another copy of its body (one arm: +15% wasm bytes). Only a machine with more active pages than memory
  0 and node 1 hold meets node 2: past ~7 GiB, ~5.5 GiB with Vulkan. Memory 0 as one memory64 was measured and set
  aside: ~+15–20% on the userspace benchmark on macOS (`--wasm-enforce-bounds-checks` as the stand-in), since V8 checks
  each memory64 access.
  - **Texel buffers** (VK3 L6b, vk/README.md "The shader path": a storage buffer of the view's words, its format
    decoded in WGSL): each takes one of WebGPU's storage buffers a stage (10 on SwiftShader) and a uniform buffer,
    which Vulkan counts with sampled or storage images, so a stage with many storage buffers and texel buffers is
    refused at its pipeline's creation (VK3 L7a, vk/README.md "Bindings past WebGPU's"; 2
    `binding_model.descriptor_copy` cases: 13 storage buffers in the compute stage); their parameters as one uniform
    buffer a group (written with the set) would give the uniform buffers back, their words would still be storage; a texel buffer whose range overlaps another writable binding of its memory in a dispatch (bound writable
    then, or else a usage-scope conflict) was refused by WebGPU's binding aliasing (16 of `descriptor_copy.compute`'s texel buffer
    cases: "Writable storage buffer binding aliasing", the dispatch dropped; since VK4 T3 a read-only one is copied
    instead: "Usage scopes' leftovers" above);
    `shaderStorageImageReadWithoutFormat`/`WriteWithoutFormat` aren't advertised though texel buffers don't need a
    format (images do: 122 `api.buffer_view.access.uniform_storage_texel_buffer` cases NotSupported; advertising them
    for images needs the image's format at the bind); storage texel buffers of formats under a word (r8, rg8, r16) and
    texel buffer atomics (R32's, mandatory in 1.3) aren't offered; sRGB and 64-bit formats aren't either.
  - **Storage images as words' leftovers** (VK4 T11; vk/README.md "Storage images as words"): a view past
    `maxStorageBufferBindingSize` makes an invalid bind group, its submit dropped (WebGPU's minimum is 128 MiB: a 4096x4096
    `rgba16float` level, loaded and stored); a stage of many such images meets the storage and uniform buffers a stage has
    (refused, saying why, where it doesn't fit: `wg_bindings_fit`); two views of one image bound writable in one scope
    (WebGPU's writable aliasing, as "Usage scopes' leftovers"); a vertex stage reading a storage image the fragment stage
    writes stays refused (a second binding of the same image would take it); planes of multi-planar images aren't words; a
    shared image's flush has no test of its own; the words' and copies' cost on a real program is unmeasured (`rw.hook` shows
    it working, nothing in the images leans on it). With words, the formats Vulkan's storage doesn't need (sRGB, packed
    16-bit) and `shaderStorageImageReadWithoutFormat`/`WriteWithoutFormat` for images become possible: a word binding needs
    the view's format at the bind, or a variant per format.
  - **`mismatched_formats`** (VK4 T11): a shader whose format isn't its view's (Vulkan leaves the values undefined): the bind
    group is invalid (WebGPU wants the layout's format) and its submit dropped, where dEQP-VK only asks that nothing crashes:
    not in the list, though they pass. A variant by the view's format, or words, would keep the rest of the submit.
  - **Storage images' cases failing before T11** (VK4 T11: the same on a build without it, 27 of a sample): `robustness.image_robustness`'s
    out-of-bounds accesses (`sampled_image` of `1d_array` and `3d`, `storage_image` of `r32f`), and `memory_model.message_passing.ext`'s
    `atomicwrite` with an image as the guard (invocations seeing the guard but not the payload). Neither group is in the list.
  - **Transfers**: VK3 L4c-F's dEQP-VK samples (`bench/vulkan/results/vk3/l4c/f-deqp/`) left, not looked into: a 4-sample
    `b10g11r11` clear, a 3D `a2b10g10r10_uint` clear (its 10-bit channels clamped to 255),
    `push_constant.graphics_pipeline.overwrite`.
  - **Bindings past WebGPU's** (VK3 L7a, vk/README.md "Bindings past WebGPU's"): what can't be advertised apart from
    what Vulkan counts with it is refused when a pipeline is made, saying why: a fragment stage's input attachments
    beside 16 sampled images (Vulkan counts them apart, WebGPU as textures; the device keeps Vulkan's 16 and 4: ANGLE's
    ES3 wants 16 texture units), texel buffers beside a full count of storage buffers (above), more folded uniform
    buffers than the advertised two (folding goes by the layout: a stage that sees another's folded buffers),
    binding numbers past WebGPU's 1,000 or on the push buffer's 998 (sets 3 and up share group 3: out of reach within
    the advertised limits, a guard). `maxDescriptorSetUniformBuffersDynamic` is 7 where WebGPU has 8 (under Vulkan's
    minimum of 8, like the descriptor-set limits that are a stage's: the push buffer is a dynamic uniform buffer of its
    own); a push buffer made a dynamic storage buffer where the layout has 8 would give it back. A captured vertex
    stage with four groups (the push buffer's, as with draw parameters, or sets 3 and up) loses its capture (refused
    at creation): the capture's three bindings in one of the program's groups would do it. Not covered by a test of
    its own: a draw of more than 64 resources (variants' masks were 64 bits: the masks are 128 now, a render harness
    with that many bindings would check it) and the split sampler in a render pipeline (`wg_variant_modules`; the
    compute path is `tests/venus-driver.test.ts` "sharedSampler").
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
- **Machines as the unit, loose ends** ([machines.md](machines.md)):
  - **The exit's numbers weren't taken** (the user's call, 2026-10-18: low relevance for now, and they'd go stale
    beside unrelated optimizations). In Chromium 153, `bench/boot/REPORT.md` with JSON: a restore whose pins match
    (RAM and state only) against one that forks; a stored disk's import (Debian; the cloud: ~94–140 s, 1,043 MB); a
    merge; a kept snapshot's size and save time against a downloaded one's; the ramdisk's fio against one buffer
    (the chunks' map lookup per request: kept if within noise). The cloud's boots written in place (221 s) and on a merged disk (290 s)
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
  - A full quota stops an import or a kept snapshot with "is it full?" and no numbers (a guest's write says so with
    them: machines.md "Storage"); those messages could carry `estimate()`'s too. `Storage.overrideQuotaForOrigin`
    (tests/page-quota.test.ts) makes the case cheap to test; `estimate()` doesn't report the override.
  - A stored disk's SHA-256 isn't computed in the background (once would do: it never changes; machines.md §3.1), and a definition carries a file's hash only
    where the record has one: a definition's file is checked by name, size and date unless something hashed it.
  - **Chromium 153 crashes reading a file handle back from IndexedDB in an off-the-record context** (the whole
    browser, SIGTRAP: a CHECK; an on-disk profile is fine; Chromium 141 was fine). The store keeps file disks'
    handles, so in an Incognito window the page's `store.all('disks')` would take the browser down once a file disk
    exists. tests/page-definitions.test.ts uses on-disk profiles for it. Repro: in a fresh `browser.newContext()`,
    put `{ h: await (await navigator.storage.getDirectory()).getFileHandle('d', { create: true }) }` into an object
    store, then get it. Check
    Chrome stable; if it reproduces there, report it upstream and keep handles out of IndexedDB off the record.
  - Several file disks re-granted at a start ask once each (`requestPermission` per handle).
  - **Exporting a whole machine** isn't built: a bundle with the definition, its overlays (as changes files), its kept
    snapshots and, optionally, its stored disks (machines.md §10). Only the definition goes in and out.
  - **Kept snapshots don't share blocks:** each carries its overlays' blocks whole, so many snapshots of a machine with
    a big overlay cost that overlay each time. Copy-on-write between a machine's snapshots, if the sizes measured ask
    for it.
  - `?display=simple` runs (the tests') are another shape than the same machine on the page, so their snapshots show
    as orphaned there (a 3D machine on a browser without WebGL2 is another shape too: decided, machines.md §1).
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

## Snapshots (M8 phase C, snapshots lane; [platform.md](platform.md) "Snapshots", [machines.md](machines.md) §5)
- **A restored machine's lost interrupt** (audio, [audio.md](audio.md) "Linux driver behavior"): under ten busy-looping
  processes beside the page's snd snapshot test, once in eight runs (before the last bound change; none in 51 runs
  since, 25 of them with the core instrumented), the restored guest never took the sound device's SPI again: CPU 0 took
  its timer interrupts, the core matched the completions and raised the line, the guest acknowledged twice, and
  `/proc/interrupts` stayed at 105. Not reproduced natively or in Node. If it comes back, the snd guest's EIO output
  has the status and interrupt counts; the next step is the GIC's view of SPI 51 when the line is high (the
  instrumentation that hid it: `Gicv3::dbg` into the device's spare config bytes).

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
  first-time visitor) need this, or a rebuild at each format change. **Live migration** (a running machine moved to
  another tab or browser without stopping it) isn't built either: today it is Save snapshot, then Load snapshot.
- **Parallel round trips beyond the tests' guests:** save and restore work in parallel SMP
  (testing.md's "Snapshots: the core's state" row); not yet run through a snapshot on 4 vCPUs:
  Buildroot, the litmus and the stress guests, in Node and Chromium.
- **A held chain the guest overwrote** (it changed a buffer it had given a device) makes the
  machine unsaveable until that queue is reset (`vm_snapshot_size` = `u64::MAX`): only a broken
  guest does it; the page would say so and offer nothing.

## Network (M8 phase C, networking lane; [plans/networking.md](plans/networking.md), [tailnet.md](tailnet.md), [frontend.md](frontend.md) "Network")

- Loose ends: the menu's login-URL and approval states are `viewOf` unit tests only (no Chromium test against headscale); the page's Buildroot machine has no `network` entry (its kernel has virtio-net, but nothing brings the interface up); IPv6 to the internet through an exit node, and a real Tailscale exit node with its own nameservers, are untested; router advertisements repeat every 60 s only on a port backend; the network tests ran in cloud sessions (Chromium 141) as well as here (153), so recheck with `scripts/ci-net.sh` in the dev VM after a change.
- The Debian tests (`net-guest`, `page-network`, `net-tailnet`) take ~4 min: they run in `scripts/ci-net.sh`, not `scripts/ci.sh`.
- **Several adapters' loose ends** ([network-adapters.md](network-adapters.md)): two tailnets both route
  fd7a:115c:a1e0::/48, so over IPv6 only the earlier adapter's peers are reached (per-peer routes as tailcat's would fix
  it, but a tailnet can have far more peers than a router advertisement carries in one piece, and each joining peer
  would be an advertisement); routes of a client or connection that went aren't withdrawn (they lapse in 30 minutes,
  through a gateway that no longer answers).
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

- **`tests/page-local.test.ts`'s pairing-link test fails now and then under `scripts/ci.sh`'s load** (2026-11-02, once
  in two runs; alone it passed twice): its `waitForFunction` reads `#net-wizard`'s `open` before the page has made the
  dialog (`TypeError: Cannot read properties of null (reading 'open')`, tests/page-local.test.ts:105). Waiting for the
  element (`?.open`) would fix the test; whether the page's start should open it sooner wasn't looked at.
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
- **A pause pending as the VM closes can stay pending** (parallel, backends on the VM's thread): a `close` that lands
  after `pause()` passed its parked check and rang the doorbell for its quiesce (`ringAsync`) ends `Devices.serve`
  before it answers, and `ringAsync` polls the served word for good (unref'd waits: in Node it doesn't hold the process,
  but the promise never resolves false as `pause()` promises). Found reading the code for `tests/pause.test.ts`'s hangs
  ([testing.md](testing.md) "A test file that never ends"), not seen in a run; a stop condition for `ringAsync` (the
  host's close) would end it.
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
- **Guest images built with Docker where Podman is missing** (the user, 2026-11-01): a cloud session (docs/cloud.md)
  has Docker (`dockerd &` as root pulls from Docker Hub) and no Podman, so `images/build.sh` and `images/deqp/build.sh`
  can't run there, and with them dEQP-VK's disk and guest (`scripts/ci-deqp-vk.sh`), dEQP's, Alpine, Buildroot and the
  kernels. The idea: the scripts call one container command, `podman` where it exists and `docker` otherwise (the
  `podman` shim `tests/net/tailnet.sh` takes in the cloud already does this by hand). What has to be settled first:
  CLAUDE.md and docs/images.md say "never Docker" (rootless Podman is the binding rule: the user's OK changes it, the
  exception scoped to machines without Podman); Docker runs as root, so the `:Z` mounts, file ownership in `target/`
  (`--userns`/`-u`) and `podman`-only flags (`--userns=keep-id`, `-q` on build) each need a translation; and most
  images build in arm64 containers, which on the cloud's x86_64 would run under qemu-user (binfmt isn't registered
  there: `qemu-user-static` and `docker run --privileged tonistiigi/binfmt` or the like) at hours a build. So Docker
  alone doesn't make them practical: worth it for the multi-arch ones (`buildroot`, `ltp`) and for images fetched
  prebuilt; for dEQP-VK (VK-GL-CTS ~20 min natively on arm64) a prebuilt `deqp-vk.ext4` and `guest-vk.qcow2` from the
  dev VM, put where the cloud's egress allows (GitHub release downloads are refused), may be the cheaper way.

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
- **Mesa, Venus's async present drops a present after a failed one** ([vk/README.md](../vk/README.md) "The guest's
  Mesa"; bench/vulkan/REPORT.md "VK3 L4e"): with no implicit fencing (virtio-gpu's case), `vn_wsi_present_async`
  (`src/virtio/vulkan/vn_wsi.c`, since MR 39283) returns the previous present's result; when that is an error it
  returns it for the next present, of any swapchain, and drops that present without handing it to the present thread,
  so its wait semaphores aren't waited, its image never reaches the compositor and its present fence never signals.
  A swapchain retired while its last present waits for slow GPU work gives the error (`VK_ERROR_OUT_OF_DATE_KHR`), so
  the new swapchain's first present is lost: mpv's window stays on its pre-fullscreen frame and `vo` waits forever in
  `drmSyncobjTimelineWait` under `pl_swapchain_destroy`. Seen with Mesa 26.2.5 (Arch's `vulkan-virtio`), unfixed on
  main as of 8598bb5c (2026-10-23); gdb stacks in `bench/vulkan/results/vk3/l4e/swiftshader-frozen-stacks.txt`.
  Repro: mpv 0.41 `--vo=gpu-next --gpu-api=vulkan` going fullscreen while its first pipelines compile (every first
  session on SwiftShader; on a warm host with webpc's `?gpu=vkpipedelay=1500`). Fix: always hand the present to the
  thread, and report a deferred error only for the swapchain it came from. Our workaround: `VN_PERF=no_async_present`
  in the desktop image (images/arch/desktop-setup.sh), which goes away with the fix.

- **Mesa, Venus hands back fd 0 for an opaque-fd semaphore export** (bench/vulkan/REPORT.md "VK3 L7.1b", "VK3 L7.2";
  backlog "Dawn in the guest's Chromium on Venus"): Venus's guest driver (`src/virtio/vulkan/vn_physical_device.c`)
  offers external semaphores as sync files only, but `vkGetSemaphoreFdKHR` with
  `VK_EXTERNAL_SEMAPHORE_HANDLE_TYPE_OPAQUE_FD_BIT` on a semaphore made with that export returns `VK_SUCCESS` and fd 0
  (`vn_GetSemaphoreFdKHR` assumes a sync file, its assert compiled out, and returns the payload's union), then -1: a
  descriptor the caller doesn't own. Chromium's own Vulkan device (`--enable-features=Vulkan`) exports such semaphores
  and its GPU process dies on "FD ownership violation". Seen with Mesa 26.2.5 (Arch's `vulkan-virtio`); repro:
  `bench/vulkan/semfd.ts` (ctypes in the guest, `semfd.py`). Fix: refuse the export at creation
  (`VK_ERROR_INVALID_EXTERNAL_HANDLE`) as the properties say, or back it with the DRM syncobj
  (`vn_renderer_sync_export_syncobj(…, false)`).
- **Chromium (Tint's Metal path or Apple's compiler) hoists a lone subgroup ballot out of an `if`** (bench/vulkan/REPORT.md
  "VK3 L5"): a compute shader whose `if (odd invocation)` holds a `subgroupBallot` as its only subgroup operation gets
  every invocation's bits (0xffffffff where 0xaaaaaaaa is right) on the M4 with Chrome for Testing 153.0.8010.12
  (macOS 26.6.2); with any other subgroup operation beside it in the `if`, the result is right. Repro: the kernel of
  `web/venus-gpu.ts` `subgroupsRight` in a page with `subgroups` requested. Which layer is at fault (Tint's MSL, Metal's
  compiler) is unknown: compare Tint's MSL output with the hand-written MSL. Our workaround: the page holds subgroups
  where the check fails.
