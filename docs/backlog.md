# Backlog

Open items no milestone owns yet, by area. Pick one up when a milestone touches the area or a
measurement says it matters, and move it into that milestone's plan when it's scheduled. **Add to
this list rather than leaving TODOs in code** (the code marks a few with `ponytail:`).

Vulkan's (Venus's) entries carry a tag, on the entry or on each of its items: **[A]** an easy win (S or less, the
approach clear), **[B]** M or more, an L/XL change or another architecture (or waiting on another project, said so),
**[C]** needs the user, their NVIDIA desktop or other hardware (the Mac's runs are the agents' own: those are A or B).
What WebGPU can't allow at an acceptable cost isn't here: graphics.md "Permanent limitations".

## CPU and ISA

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
  long workloads with it. **The user, 2026-11-10: keep our own MIDR for now.**
- **Hardware breakpoints and watchpoints at JIT speed:** a task with one armed runs in the debug
  interpreter while it's on the CPU ([cpu.md](cpu.md) "Self-hosted debug"); pages holding a
  breakpoint could stay uncompiled and watched pages out of the TLB instead, so their accesses take
  the slow path, which would check the comparators. Only if a debugged program's speed becomes a
  concern: unarmed code doesn't pay either way.
- **Spectre-BHB reporting:** Linux says `spectre_v2` "Mitigation: CSV2, but not BHB" (and installs no
  BHB mitigation: MIDR 0 has no loop count). Only `ID_AA64PFR0_EL1.CSV2` = 3 clears it, which needs
  `SCXTNUM_EL0`/`EL1` (plain registers, `SCTLR_EL1.TSCXT` trap, JIT sysreg path, snapshot state).
- **MMU:** no Device-memory alignment faults with the MMU off, where every access is Device (on the M4 an unaligned load and DC ZVA fault, QEMU's TCG only the
  load): the check would sit on the flat bus's fast path, which the MMU-off EL1 and user-mode guests run on, and
  correct firmware doesn't notice; DC ZVA to RAM mapped as Device with the MMU on zeroes it (the M4: an alignment
  fault).
- **Reserved AdvSIMD encodings with FPEN 0** take the FP trap (`interp.rs`: `fp_enabled` before the handler's field
  checks); on the M4 they're UNDEFINED. Harmless to a kernel that enables FP on the trap: the retry is UNDEFINED. The
  same order applies to scalar FP's `ftype` 3 without FEAT_FP16 (with it, allocated) and the by-element forms'
  reserved sizes, equally harmless; the AdvSIMD FP16 encodings without it are UNDEFINED ahead of the trap.
- **Exclusives and LSE on device memory:** an LDXR reads (through `Io`, with LDAR), its STXR and the LSE atomics take
  an external abort. What hardware does there is IMPLEMENTATION DEFINED; not compared with the M4.
- **Arm AARCHMRS JSON:** its in-package notice is unread (`THIRD_PARTY.json`); read it only to
  generate decoder tables or coverage checks from it.
- **Corpus depth:** thin FP flag paths (8 `fp_scalar` tests raise Divide-by-Zero); add biased forms
  when touching FP again. A biased fuzz against qemu-aarch64 (2026-11-03: 1.07M FP and AdvSIMD FP instructions, every
  FZ/DN/RMode, every cumulative flag) found no difference, so this is coverage, not a suspected bug; its generator
  (special values per lane size, random FPCR) wasn't kept and is what those forms would be.

## Interpreter

What the block interpreter's speed track (2026-10-21/22, `bench/interp/REPORT.md` "M8-INTERP loop 0" to "loop 11")
left open, most promising first. Re-profiled 2026-11-04 (`bench/boot/REPORT.md` "Where a busy vCPU's time goes in Firefox, again"): the block interpreter is 13% of a busy
vCPU's samples in Firefox's pages session (`hot` 9.5%), 14-16% while a page loads and 3-4% while it scrolls; 4.1% of
the steps, so an interpreted step costs ~3.5× a compiled one. The loads' new code (1.4-1.9 M instructions decoded a
20 s window, Firefox's own JIT's rewrites among it) runs interpreted until hot. **On the Mac host it weighs more**
(2026-11-09, `bench/boot/REPORT.md` "Where a busy vCPU's time goes on the Mac, and the compile threshold there"):
18.4% of the pages session's busy ticks (`hot` 14%) for 3.96% of the steps, ~5.5× a compiled step, 13-31% while
pages load; in Godot's editor start on Venus 6-7% for 0.85% of the steps (~8×), 21% in its first 20 s. A lower
compile threshold doesn't take it away there (500 tied, 250 lost: [jit.md](jit.md) "Compile policy"), so the
interpreter's speed is the lever for loads and starts. The items below are ranked by that; measure them on the Mac
(the VM's bounds checks distort `hot`'s stores), and screen them as `bench/interp/REPORT.md` "The block interpreter on
the Mac, loop 1" says (counts first; the block-interpreter guests; the pages session for cold-code changes).

- **What makes `hot` return in a browser** (counted 2026-11-09, `bench/interp/REPORT.md` "The block interpreter on the
  Mac, loop 1"; Firefox's pages session, 678 M block runs, `hot` entered 266 M times). One cause is the
  interpreter's own:
  - **Decoding** (`Cache::miss` and its closure 1.64% of busy ticks, loop 3; 19% faster natively since loop 4, no
    allocation a block): what's left is compute, the decoder, `pack_into` and `uop_op`'s matches.

- The reference interpreter (`interp::steps`, `VmConfig.jit` 0) still fetches and decodes each
  instruction; the MMU copy runs 35% slower than the flat one. It only runs the interpreter-only
  tests and benchmarks now.

## JIT

- **Indirect transfers into a browser's code** (2026-10-16; `bench/boot/REPORT.md` "M8: where a busy vCPU's time goes
  in Firefox"). In Firefox's pages session 26% of a busy vCPU's time stalls at a guest function's first instruction,
  83% of it after a `return_call_indirect` (the code footprint defeats the branch predictor; direct and imported tail
  calls don't stall). Warm members took the jump-cache tails into warm code away (+18% busy MIPS). Re-profiled
  2026-11-04 (`bench/boot/REPORT.md` "Where a busy vCPU's time goes in Firefox, again"): entries 22.0% of the samples (27-29% while pages scroll), 80% of them after a
  `return_call_indirect`, 15% from the dispatcher; the signature check 3.0%. On the Mac host (2026-11-09, `bench/boot/REPORT.md` "Where a
  busy vCPU's time goes on the Mac, and the compile threshold there") entries are 14.1% of the pages session's busy
  ticks and 13-14% of Godot's editor start: smaller than in the VM, still the largest single cost after the bodies. Returns, 49% of those entries, are host returns now ([jit.md](jit.md) "Calls"); the tails into code
  compiled later (22%) lost both ways tried, re-emitted and rebound ([jit.md](jit.md) "Tried and not kept"). What
  remains:
  - The dispatcher's entries (15% of the entry stalls on 2026-11-04 for 4.7% of the indirect entries: about three
    times the average stall each) and the signature check's table load (3.0% of the time; a typed table didn't make
    the transfer cheaper in `chain.mjs`).
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
  prologues' ~5% of Liftoff's samples in Firefox; Liftoff's bodies were 12.9% of a busy vCPU's samples then and 6.3%
  on 2026-11-04 (`bench/boot/REPORT.md` "Where a busy vCPU's time goes in Firefox, again"), so ~0.3% now.
- **A Firefox session whose first page times out**: Firefox never reports its first page; the guest's kernel and
  shell are alive; the other pages then load normally. Three times in ~35 sessions on 2026-10-16, on three builds
  (WARM=32; the default before the foldable offsets; the posted modules): always the first page (wiki). Rerun such
  a session under JIT-check, and look at what Firefox waits for (the guest's `ps`, its console) when it hangs. First
  rerun such sessions on a build from 2026-11-03 on: until then a fast-completed ISB under the parallel JIT could run
  code another vCPU had just rewritten ([platform.md](platform.md) "Broadcast maintenance"), a candidate cause. Since
  (2026-11-04/05, builds from `6abf0919` on, from `pages.waarm64snap`): 13 whole sessions in the dev VM and 6 on the Mac
  host, none timing out at its first page. If none does in the next ~20, drop the item.
- **A VM session that lost Firefox's process** (2026-11-05, with the first core of host calls: `bench/boot/REPORT.md`
  "Guest calls as host calls, again"): gone in both page windows, the guest's kernel and sway alive, the pages timed
  out. 1 of 10 VM sessions with host calls, none of the later 9 nor the Mac's 2. `bench/gpu/firefox-load.ts` logs
  Firefox's output, its processes and the kernel's messages when a page never gets ready (`not ready:` in a session's
  log): if it recurs, read that, then a core with `MAX_DEPTH` 0 (the entries without host calls) narrows it.
  A candidate cause was fixed on 2026-11-05: a missed predicted return that ran its continuation's code at the real
  target ([jit.md](jit.md) "Compile policy", calls and returns). It crashed the litmus guest's kernel at EL1 in
  about 1 of 40 boots on 4 vCPUs, killing the process it ran for. If no session loses Firefox in the next ~20, drop
  the item.
- **Which Blink object a vCPU thread's `new WebAssembly.Module` allocates in Oilpan** (`CppGC.SweepOnAllocation`
  inside `wasm.SyncCompile`; `bench/boot/REPORT.md` "M8: V8's GC on the vCPU threads"): left open when the vCPU
  workers began returning to their event loop. The wasm code GC that item also named no longer stops the vCPUs
  (`bench/boot/REPORT.md` "The wasm code GC today, and larger batches in a browser", 2026-11-03).
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
  doesn't flush (from the snapshot, 2026-11-04: 132 MB, no flush); a longer one will, and each flush doubles the threshold's floor (the long stutters at later flushes
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
  true (wrong) the FP guest ran 33% faster in Node, and llvmpipe 8% faster a frame without its FZ operand tests
  (since cut to two ops an operand, which left its frames even: `bench/interp/REPORT.md` "FZ's operand tests and
  vector FMUL's zero clause"; `jit_fz_mips` is a shader-like kernel under FZ).
  By gain against work:
  - **Scalar FP in f64 and f32 locals** (a scalar shadow per V register): a scalar FADD is still five lane ops for
    one (two lane extracts, the result's move to a general register for its check, `movi` and `ins` to write it
    back zero-extended); n-body and Horner (~40% of the FP guest) could keep their values in float locals and
    build the v128 only for a vector reader, the flush being stores (no lane op). Needs locals past 128: two-byte
    indices (the TLB memo's patch has them, [jit.md](jit.md) "Tried and not kept"). Counted 2026-10-20: inline
    scalar FP is 0.5% of the instructions compiled in Firefox's pages session (14,500 of 2.9 M) and none to speak of
    in Alpine's userspace benchmark (30), so it's for the FP guest and FP-heavy guests, not the ranking workloads.
    FEAT_FP16's scalar forms (ftype 3, `emit/half.rs`) run a whole vector's widening and narrowing for one half (a
    `_Float16` Horner 2.1× slower than its single code, PERF loop 10): in scalar f32 ops they'd be about a third, if
    FP16 is ever advertised.
  - **The single FMA's midpoint test** (the emulated arm only: the fused arm has none, so this now reaches only hosts
    without FMA3 or relaxed SIMD; not worth doing for them): folded into the result's mask and reduction, with the
    round-to-odd redo in the failure arm before the helper; saves a reduction (two lane ops), not the test.
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
- **Counter reads in the deterministic runs exit to the run loop** (PERF loop 8's counts: Alpine's userspace benchmark
  0.37-0.52M `MRS CNTVCT` a phase, its boot 0.35M, each a full exit; the gates run deterministic, users don't). Inline
  they'd need the step clock in the block (the steps retired so far in the chunk, which the block's budget counter
  knows). Only the gates gain.
- **The gates' timer IRQ rate**: Alpine's userspace benchmark reprograms the virtual timer once per ~63K steps
  (51K CNTV_CVAL writes in the Lua phase's 3.2 G steps), each with ~10 ISBs and counter reads around it. Check that
  against the guest's HZ through the step clock (`ticks_per_insn`) before tuning the IRQ path for the gates.
- **CoreMark's gap to TCG (~70%)**: the same transfers between blocks (above) and the store bounds
  checks V8 keeps on Linux arm64. Don't fit the design to it.
- kvm-unit-tests `timer` runs slower under the JIT than interpreted (short blocks around timer
  polls).
- Buildroot's warm boot under the JIT has a 10× wider IQR than the interpreter's (V8 tiering
  hundreds of modules at different points, presumably).

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

- **dEQP-GLES's "not supported" that WebGL2 can't back as it is** (bench/gpu/REPORT.md "dEQP-GLES's census",
  2026-11-09): separate depth and stencil attachments (GLES2's 91 `fbo.render.*depth_component16_stencil_index8`, GLES3's 12 `fbo.blit.depth_stencil`; WebGL
  allows only one depth-stencil attachment: one `DEPTH24_STENCIL8` behind both would do) and sRGB R8 and RG8 textures
  (GLES3's 64 `EXT_texture_sRGB_R8`/`RG8` cases: an `SRGB8_ALPHA8` texture with the channels expanded on upload). No
  known program uses either; only if one does. The rest is beyond WebGL2 (wide lines, 8 samples, advanced blending,
  `EXT_multisampled_render_to_texture`, 4 separate transform feedback components where GLES3's 108
  `transform_feedback.array_element.separate` cases want more) or the run's configuration (`rgba8888d24s8ms0`: no
  multisample default framebuffer, 32 cases).
- **virtio-gpu errors in Firefox's pages session on the Mac's GPU** (2026-11-05, `bench/boot/REPORT.md` "What a function's
  size costs, in the VM and on the Mac"): with `VIRGL_GPU=virgl` on the Mac host (Chrome for Testing 157, the M4's
  GPU) the guest's kernel logs `virtio_gpu_dequeue_ctrl_func` errors while pages load: `ERR_UNSPEC` (0x1200) to a
  `CTX_CREATE` (0x200), then `ERR_INVALID_CONTEXT_ID` (0x1204) to `CTX_ATTACH_RESOURCE` (0x202) and `SUBMIT_3D` (0x207):
  a 3D context the host failed to create, whose commands then fail. Not seen in the dev VM's sessions (SwiftShader);
  the pages render and the session runs on. Find why the context's creation fails there (the GPU worker's log for it).

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
  the same memory. **Built (BETTERAGENT):** a snapshot flagged as a template (`tools/snapshot-template.ts`) has the
  guest agent renew the kernel's entropy (and force the CRNG's reseed), `/etc/machine-id`, systemd's random seed and
  the SSH host keys at its restore (devices.md "A template's identity"); the hostname stays (the user's choice). Left:
  what derives from the machine id in programs already running (systemd-networkd's DHCP DUID/IAID, journald's file
  names: until they restart; the network job, BETTERAGENT job 3, reconfigures the link), the network card's MAC (a
  page-side choice), any tailnet node key (the page's, host-side), and a VM generation ID (`microsoft,vmgenid`, which
  the kernel reseeds on by itself: the agent's forced reseed stands in for it, and userspace generators that key on
  the generation, the vDSO's `getrandom`, follow the reseed). The demo's per-machine setup script, if one is wanted,
  can wait on the renewal (the agent's journal line `renew: done`). The snapshot pins its disk's identity (a URL's path today), so the image's URL must not
  change under it (a chunked image's `id`, [remote-disks.md](remote-disks.md), makes that check exact; a whole file's
  URL doesn't). **How a visitor gets there** (the user's decision, 2026-10-23): an interstitial page first says what
  the project is, that it needs a host with enough memory and CPU, and that hundreds of MB will be downloaded; one
  click then starts the machine, downloads the snapshot (chunked like a disk image, fetched whole before the resume:
  no prefetch logic) and drops into the demo's workload. Nothing is fetched before that click. Two consequences of
  the remote disk's reader: the snapshot's pieces belong in the same expiring Storage Bucket as the disk's blocks
  (`web/diskcache.ts`'s `cacheRoot`: not persisted, a week after its last use, 2 GiB shared), and a disk's boot trace
  (`prefetch` in its manifest) doesn't fit a resumed guest, so the demo's manifest carries a trace recorded from the
  resume instead (or none: the paced prefetch then costs nothing).
- Overlay: the base identified by path and size only. (A full storage: machines.md "Storage".)
- blk DISCARD/WRITE_ZEROES ([devices.md](devices.md)) is the page's only: offering it to the
  tests' guests moves every writable guest's step count (the driver reads the longer config) and
  needs the native twin (`core/tests/common` `Overlay`) to take the requests. One segment per
  request (`max_discard_seg` 1); a compaction copies synchronously in the device worker (at most
  the blocks freed, so a trim of GBs can hold the guest's I/O for seconds; the full one after the agent's trim too).
  The page's Debian doesn't mount with `discard`: without the guest agent the user runs `fstrim`, or waits for
  `fstrim.timer` (with it: devices.md "Disk space handed back").
- **A handle read back off the record:** in an off-the-record profile (Incognito; Playwright's `newContext`), Chromium 153
  dies reading a record that holds a `FileSystemHandle` from IndexedDB (storing it is fine; on a disk profile all is):
  a host folder there, and a disk kept as a file handle, take the browser down at the next read of their store. Nothing
  tells a page it is off the record. Found by tests/page-folders.test.ts, which runs on a disk profile; not yet tried on
  another Chromium build or filed upstream.
- **The agent's tests as root** (docs/cloud.md): in a cloud session (root) `x11::tests::only_roots_or_the_users_display_socket_gets_the_cookie` and `serve_test::follows_the_session_and_passes_the_child_its_frames` fail, which stops `scripts/ci.sh` there. Either the tests take a non-root uid where they need one, or the agent's root rules are what fails: not yet looked at.
- 9p: no HTTP-served tree, as v86's lazy filesystem. The memory tree's umask is the client's even under a default ACL
  (devices.md "9p"); shared folders have no xattrs (docs/shares.md §8).
- **The firmware's keyboard on machines without the USB controller:** a machine with the controller has one since 2026-10-18 (the built-in USB keyboard on EDK2's USB stack, docs/usb.md "The keyboard"). One without it still gets the screen's keys on the serial console as a terminal sends them (`terminalBytes`: no key-up, no modifiers by themselves) until its virtio keyboard is live. A virtio-input DXE driver for the mmio transport (none to port from OvmfPkg) would cover those too; worth it only if machines without the controller stay common (new ones have it). The other way out removes the serial path instead: every page machine gets the controller (older ones at their next start, which orphans their snapshots once, so ask first) and the tests' transient guests take it by default (guest-visible: the user's OK); then `terminalBytes` and `attachInput`'s serial `text` path can go. Kept for now (2026-10-18) so machines from before USB don't lose their firmware keyboard.
- **Guests that composite with llvmpipe show stale frames on virtio-gpu** (graphics.md "Guests that composite with llvmpipe"; devices.md): the
  rasterizer threads draw after the transfer. `WLR_RENDERER=pixman` in the guest avoids it. A display mode that
  samples the scanout's memory at each refresh and holds a flipped buffer until it is stable would hide it for
  unmodified guests: not built (a full compare per refresh; build it if GL compositors become fast enough to use).
- **Steam's client UI (CEF, native aarch64, Arch guest, 3D) shows black areas and a shifted copy of its header**
  (2026-11-06, the user's capture: `bench/results/local/steam.vglt`, 342 MB, local only, a `GLITCH VISIBLE` note at
  submit 12,405). Gone with `-cef-disable-gpu-compositing` (the menus' brief black flash while fading in stays: a
  second fault, untraced) and `-cef-disable-gpu`; the store pages never show it. Found so far, on SwiftShader (so not
  the user's NVIDIA): the damage is already in the GPU process's composition of the page (resource 508 of the trace,
  copied on through 506 → 692 → 758/901/736 whole); the band under the 66-row header is the header layer's tile (805),
  which Skia clears to opaque black by a draw whose vertex colours say (0,0,0,255), with only a search box drawn over
  it by the sidebar's tile (843: two draws; no copy, upload or clear names it). Every texture in that frame is
  GPU-rastered, the read-backs are cursors only, no GL error on any call, the renderer logs nothing: the replay draws
  what the commands say, so the cause may be upstream (what the guest's Mesa or CEF decides from our caps or answers).
  **The reference draws them too**: the trace through the oracle's libvirglrenderer (vrend on llvmpipe's desktop GL;
  `bench/results/local/steam/oracle/replay.c`, checked on glcomp's fixture: mean 1.1 a byte off llvmpipe's) gives the
  same black block and the same faint copy of the header at the note, so the commands themselves draw them: the cause
  is upstream, in what CEF or the guest's Mesa decides, likely from what our host answers differently from vrend's. One
  such difference found: our caps offer `Z24_UNORM_S8_UINT` (19), which vrend has no format for (Skia's clip stencil,
  resource 855; the replayer maps it to 20). **Our caps against vrend's** (capset 2 on llvmpipe, desktop GL and GLES;
  `bench/results/local/steam/oracle/diffcaps.ts`): no capability bit vrend lacks (we lack COPY_IMAGE, TGSI_FBFETCH,
  SRGB_WRITE_CONTROL, 3D_ASTC, INDIRECT_INPUT_ADDR, CLIP_HALFZ (offered since with `EXT_clip_control`), V2_BLEND_EQUATION, V2_TEXTURE_SHADOW_LOD,
  V2_MIRROR_CLAMP_TO_EDGE: without framebuffer fetch and advanced blends Skia copies the destination for some blends,
  a path real hosts never take); formats only we offer: `Z24_UNORM_S8_UINT` (sampled, depth, multisampled),
  `X8B8G8R8_UNORM`, `I8_UNORM`, `L8A8_UNORM` (sampled and rendered). `?gpu=capsno=` takes formats out for the A/B in
  Steam and `?gpu=capsyes=` offers the missing bits (unbacked: a diagnosis, not a fix). With the four formats taken
  out (the console saying so) the glitches are the same (the user's run; a first run had taken nothing out: a `+`
  in the query is a space, fixed). With `capsyes=CLIP_HALFZ` alone, and `COPY_IMAGE` alone,
  the same; all four bits at once crash Steam at its start (a bus error); `TGSI_FBFETCH` and `V2_BLEND_EQUATION` alone
  untried. **Parked (2026-11-07, the user's call)**: Steam's CEF is old and recent Chromium in the guest shows nothing
  like it; look again after Valve updates it (a new capture, the reference replay first). The ad-hoc replayer is worth
  keeping as a tool (`tools/virgl-oracle/`) if a trace needs a reference again. No context's rasterizer sets `clip_halfz`.
  (The replayer also needs: contexts' skip flags per incarnation, an iovec array per resource, kept: the library keeps
  the pointer. Sway's and Xwayland's contexts die on llvmpipe at a GL_INVALID_OPERATION; Steam's run clean.)
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
- **virtio-gpu, not built or not measured in G1:** GNOME and Xorg sessions (KDE follows the size by itself, a user's session; sway is: graphics.md "The console and the display size", and the agent resizes it); sway on DRM resized by the agent on the page (the page test's sway is headless; the request is the one `swaymsg … mode --custom` makes, measured on DRM in G1); a page test
  of the pointer through a letterboxed screen (checked by hand with sway); an overlay for a guest that warps its
  cursor (`MOVE_CURSOR` away from the pointer: none seen); sizes beyond 4088 pixels a side (a DisplayID block in the
  EDID); a display event at a fixed step beyond the test hook (`GpuOptions.resize`).
- Framebuffer (the simple-framebuffer machines that remain: Buildroot's page, the test guests, `?display=simple`): a
  scan of the whole buffer per animation frame to find the changed rows (~0.4 ms at 1024×768, on the machine
  worker), x8r8g8b8 only, fixed size. Guests with the driver use virtio-gpu ([devices.md](devices.md)); nothing
  is planned for the rest.
- **The gateway's parsers and hostile frames:** the bare-metal net guest ([testing.md](testing.md) "Bare-metal device
  tests") sends its frames to the loopback adapter; on the page they reach `web/gateway.ts` (ARP, IPv4/6, ICMP,
  DHCP, DNS, TCP and UDP to the backends), whose malformed-input tests are few (`tests/gateway.test.ts`: IPv6's
  spoofed, multicast, hop-by-hop and truncated packets). A table of truncated and inconsistent frames (lengths past
  the frame, header lengths under the minimum, options past the end, DHCP and DNS fields past their packet) fed to
  the gateway in Node, each answered or dropped, never a throw.

- **HEVC on the host** (dropped with the video track's end, 2026-10-15, the user: H.264, VP9 and AV1 cover what the
  web serves; Chromium on Linux has no HEVC decoder of its own, so only hosts with hardware HEVC would offer it; HEVC
  files still play, decoded in the guest). What it would need ([graphics.md](graphics.md) "Video's design"): VPS, SPS and PPS
  written from `virgl_h265_picture_desc` (offsets from a C program against Mesa's `virgl_video_hw.h`), and every slice
  header rewritten, since VA's parameters lose the SPS's short-term reference picture sets (only their count): an
  explicit set built from the picture's DPB list (`ref[]`, `PicOrderCntVal[]`, the RefPicSetSt*/Lt indices; the rest
  is foll), and the header parsed through to its end (prediction weights, entry points) to re-align the slice data;
  long-term pictures from the SPS can't be rebuilt (their POCs aren't sent). Testable only where the browser has
  HEVC (the Mac's hardware), and offline with FFmpeg in Podman.
- **A VA-API consumer that waits on each picture, where the browser decodes H.264 in software** (the guest's
  `ffmpeg -hwaccel vaapi` reading frames back, as in transcoding; graphics.md "Video's findings"): every frame right, 120 frames
  in 2.1 s on the Mac (23 s before the call queue's waits became per picture and per submit), a drain now and then
  where the decoder holds more pictures than the guest sends before it waits. Filler pictures (graphics.md "Video's findings":
  measured, exact, then dropped) took it to 1.5 s; worth bringing back only if transcoding in the guest matters, with
  their hazards (OpenH264 under Chromium's FFmpeg wants nothing sent until a filler has left the queue).
- **H.264 that jumps to a picture that isn't an IDR** (graphics.md "Video's findings": the guest's FFmpeg seeking in an MPEG-TS,
  which has no index, lands mid-GOP; a stream whose key pictures are recovery-point I pictures): the guest's own
  decoder conceals the missing references, the browser's decoders (VideoToolbox, Chrome's FFmpeg, OpenH264) report a
  decoding error, and the host drops the codec's pictures until its next IDR (the guest sees a still picture, up to a
  GOP: ~10 s for x264's defaults). Idea, not tried: after an error, restart the decoder at the next picture whose
  slices are all I by rewriting it as an IDR (NAL type 5, an `idr_pic_id`, `dec_ref_pic_marking` without MMCO; the
  slice header re-encoded). Worth it only if TS playback or such streams matter (MP4 and WebM seek to key pictures).
- **Video streams no test has exercised** (graphics.md "Video's measurements"): AV1's superres (libaom through FFmpeg
  won't take the option: `-aom-params` keys only, `superres-mode` isn't one), non-uniform tiles, translation and affine
  global motion, intra block copy, switch frames, and a hidden key frame the guest shows later (not output by the host;
  none of the encoders tried made one); VP9's size change without a key frame (reference scaling, libvpx's real-time
  resizing). Each needs a clip in images/arch/media.sh and a `v1.ts` run against the guest's software decode.
- **10-bit video isn't offered** (graphics.md "Video's design"): VP9 profile 2 and AV1 10-bit, which the browsers
  decode, would need P010 video buffers (16-bit planes in virgl, a WebCodecs frame's 16-bit `copyTo`) and Mesa's
  profile entries; none of the web's common streams need it yet.
- **mpv on virgl's GL with VA-API pauses on another frame** (VK2 L6, bench/vulkan/REPORT.md "VK2 L6",
  `bench/vulkan/mpv-frames.ts`): paused at 20 s in Sintel's trailer, `--vo=gpu --gpu-api=opengl --hwdec=vaapi` shows a
  picture a frame or two away from the one mpv shows decoding in software, or on Vulkan with VA-API (those three agree
  to the byte on the M4), on the Mac and SwiftShader alike. Playback looks right; not looked into (a stale plane
  sampled through the picture texture, `Res.picture`, or mpv's own GL interop at a seek are the candidates).

- [B] **Snapshots while Vulkan (Venus) is in use** (VK1, docs/devices.md "Venus"): refused while a Venus context exists.
  Needs the renderer's objects as data (as virgl's), the blobs' bytes (mapped ones are in the window, which a
  snapshot's RAM chunks don't cover yet) and the window itself: VK4's tier 4 (VK4-KICKOFF.md).
- [B] **Pipelines' loose ends** (REPORT.md "VK3 L3", "VK4 T17", "VK4 T49"; vk/README.md "Pipelines made asynchronously",
  "The shader cache"): (1) render pipelines made at vkCreateGraphicsPipelines (`?gpu=vkpremake=on`, VK4 T17) lose for
  both programs measured. vkQuake's capture makes 100 so and draws with 8 (cold, 269 → 26 frames/s on the M4). Godot's
  editor (VK4 T49) makes 51 so and draws with 24: with Metal's cache emptied its submits wait half as long for
  pipelines (13.9 → 8.3 s held, medians of 3) but its start ends no sooner (the last held submit at 44.8 s → 47.6 s,
  rounds overlapping), the guest's own work (Godot importing and compiling its shaders under emulation) being the
  start's length; with Metal's cache warm, 44.7 → 42.7 s, overlapping. So a count kept per program in the store, to
  premake only for one that draws most of what it makes, would pay neither. Left: of vkQuake's 18 drawn pipelines, 10
  have keys the creation's guesses miss (not looked into: the sampler variant, a dynamic state's default, a read-only
  depth layout), which matters only if premaking ever wins. (2) A pipeline made at once by a submit (`syncPipelines`)
  is counted, never seen in a program. (SwiftShader's compiles not kept across a restart: graphics.md "Permanent
  limitations".)
- [B] **The printer's WGSL, what Tint still pays for** (GD G2, VK4 T49; vk/README.md "The shader path",
  bench/vulkan/REPORT.md "GD G2", "VK4 T49"): since T49 (values read once inlined, float vectors, uniform words by
  literal or aligned indices) Godot's 210 stages take 323 ms of `createShaderModule` on the M4 (475 before), the largest
  41 ms, their WGSL 4.4 MB (7.05). [B] Left, smaller: ~1,200 `bitcast<f32>(t.x)` in the largest stage, of vectors that also
  feed something other than float ALU ops (texture coordinates, stores; those could take the bitcast at that use
  instead); 8- and 16-bit values aren't inlined; a value read twice stays a let. Tint was read, not profiled (building
  Dawn wasn't allowed in G2's session): a native Tint (Dawn's CMake, `tint` with the WGSL reader) on these stages would
  say what the rest is. A program's start barely moves with it now: Godot's editor's is the guest's own work
  (REPORT.md "VK4 T49"). (A `var` declared in a loop without an initializer keeps the last iteration's value on
  SwiftShader's path, which the printer doesn't rely on: "Upstream reports" below.)
- [B, C] **Godot on Venus, GD's leftovers** (GD, ended 2026-11-04 for dEQP-VK's next tasks; bench/vulkan/REPORT.md "GD G4",
  "GD G7–G8"). Godot 4.7.2's editor, its Forward+ and SDFGI scenes and the Global Illumination demo run on the M4 and
  the user's NVIDIA desktop (the demo at 60 frames/s there), X11 and Wayland. Left, ranked:
  - [C] **Freezes and black windows on NVIDIA** (the user, 2026-11-04): the GI demo in SDFGI mode freezes the guest's
    display at times (back when the mode is left), and Godot's window is sometimes black instead of the scene, under
    Wayland too; no WebGPU error since the last two fixes. All Venus contexts and the compositor share one GPU
    process, so one program's long frames hold every window. VK4 T23 measured the emulated paths in that mode on the
    M4 (no freeze there; SDFGI's view copies the one cost: REPORT.md "VK4 T23"); nvidia.sh's `t23` step measures them
    on NVIDIA with the seconds frozen.
  - [B] **The device's address buffer** (seen on SwiftShader, `results/gd/g8/gi-editor-swiftshader.json`): it grows by copy
    (old and new at once), and the demo's editor grew it to 512 MiB, which SwiftShader's Vulkan refused (the editor
    black). Since VK4 T41 a memory is placed there at its first buffer's bind (images' blocks left out) and the editor
    draws (`results/vk4/t41/gi-editor-swiftshader.json`), but the buffer still grows to 512 MiB, now taken: Godot's
    buffers' blocks are most of it, so a larger scene can meet the refusal again. Regions of a fixed size, a
    GPUBuffer each without growing by copy, would need pipelines remade per region count ("Device addresses' leftovers").
  - [B] **Godot as a standing workload** (G7's rest): a GFXReconstruct capture of Godot's scene on the dev VM's lavapipe
    (images/vkframes/build.sh, as vkQuake's; under the Venus profile it takes Mobile: SwiftShader's 16 textures)
    replayed in tests/page-venus.test.ts. The editor's start cold and warm on the M4 is measured since VK4 T49
    (bench/vulkan/godot.ts: two runs of one RUNS line in a session; `lastHeldS`, the start's end by the renderer's
    account): ~44 s cold, ~24 s warm, both the guest's own work (Godot importing its project and compiling its
    shaders under emulation), the submits held for pipelines ~12 s of it cold with Metal's cache emptied, overlapped
    (REPORT.md "VK4 T49"). Faster starts are the JIT's and the guest's, not the renderer's.
  - [C] **nvidia.sh's `godot` step, not yet run by the user** (`nvidia-bundle.sh --godot`, then `VK2_STEPS=godot
    bench/vulkan/nvidia.sh page <bundle>`, ~20 min): the bar's NVIDIA half by the harness (the user's hand runs meet it).
- [B, C] **What the device advertises, left for the translator** (VK2 L7, VK3 L5; vk/README.md "The shader path";
  what WGSL's subgroups, floats and atomics can't give: graphics.md "Permanent limitations"). [C] `gl_SubgroupID`
  assumes subgroups are runs of `local_invocation_index` (true on SwiftShader and Metal; unchecked on NVIDIA). [B] No 8-
  or 16-bit atomics (a compare-exchange on the word would give them; no program asks). Failing on SwiftShader only (the
  M4 passes them; out of the list, which takes what passes on both), each [B] (not looked into, SwiftShader's at
  first sight): a 16-bit NaN through a vertex input (`16bit_storage.input_output_float_16_to_32.vector6_vert`, 69696
  for NaN), 9 compute cube gathers (`glsl.texture_gather.compute.basic.cube.*`; their graphics twins pass; still
  failing 2026-11-09), 2 dynamic-offset gathers of a view with a base level ("SwiftShader's fetch from a view with a
  base level"), and `ssbo.layout.random.8bit.all_per_block_buffers.5`, which passes in 56 s there (1 s on the M4; past
  dEQP's 30 s watchdog, still 2026-11-09): an 8-bit store is two atomics on its word, and 16-bit random layouts take
  SwiftShader up to 11 s alike; a word written whole where a stage's stores cover it (`nir_opt_load_store_vectorize`)
  might bring it under. [B] **Float subgroup arithmetic on the Mac** (VK4's backlog easy wins; vk/README.md "The shader path": since then the
  M4's subgroups are anchored, not held): of the 2,081 subgroup and non-uniform derivative cases SwiftShader passes,
  the M4 (Chrome for Testing 157) passes 1,955, NotSupported 32 (`ballot_broadcast`'s required size 4), and fails the 94
  float `subgroups.arithmetic` cases, compute and graphics (add, mul, min, max and their scans, float to vec4; "1 / 7
  values passed": all but one of dEQP's workgroup sizes; `results/vk4/easy2/m4-subgroups-linkage.json`), 39 of them in
  `tests/deqp/vk.txt` (kept: SwiftShader passes them). The integer twins pass, and a hand kernel's float add, min and
  max of small values, whole and in an `if`, are right on the M4: dEQP's data (infinities, NaNs or denormals under
  Metal's fast math, as `float16`'s 16-bit infinities come back 0) is the first suspect; dEQP's shader and data
  (`QPA=1` keeps no shader source: the CTS source's `vktSubgroupsArithmeticTests.cpp`) would say. [B] On the Mac with `shader-f16`, one graphics shuffle's WGSL
  nests ifs past Tint's 127 (an indexed f16 vector's `if` tree). VK4 T42 ran 7 `float16.opvectorshuffle` cases on the
  M4 (`results/vk4/t42/m4-f16-shuffle.json`): all fail, every stage refused by Tint ("statement nesting depth /
  chaining length exceeds limit of 127", a `let` at 64 levels of `if`), compute and graphics alike. Not reproduced off
  the Mac: a GLSL switch of 140 cases prints flat (NIR's switch is a run of ifs, not a chain), and the cases' SPIR-V is
  dEQP's own, built at run time (no CTS source here); the next step is the stage's WGSL whole (the worker's warning
  keeps 400 lines, the run's log a line of them) or its SPIR-V from the guest, then a flat print of what nests (the
  tree's leaves as a `switch`). The per-stage descriptor limits follow one count of what WebGPU takes since VK3 L7a
  ("Bindings past WebGPU's" below).
- [B] **YCbCr's gaps** (VK3 L7.2; vk/README.md "YCbCr conversions"; on by default since L7.3, `?gpu=vkycbcr=off`):
  only the 8-bit multi-planar formats (2- and 3-plane 420, 422, 444): WebGPU's 16-bit normalized formats (tier1's) are
  unfilterable, so P010 and the 10-, 12- and 16-bit formats would need a nearest-only offer or filtering in the shader;
  no single-plane 422 formats (YUY2: WebGPU has none, they would be decoded from words); optimal tiling only (a linear
  image can't be sampled here anyway); no explicit chroma reconstruction nor a chroma filter apart from the sampler's
  (Mesa's implicit reconstruction, which dEQP-VK's conversion cases pass); planes aren't attachments or storage images.
  (An image aliasing a plane's memory: graphics.md "Permanent limitations".) **A multi-planar image on external memory
  only disjoint, a resource a plane** (VK4 T48: each plane's texture its resource's; vk/README.md "Imports"): not
  exported (the virgl renderer imports one plane an image), not one memory of several planes (a resource is one
  texture: each plane's region of one resource would need its bytes from an offset, `VenusImport` fills a texture from
  a resource's start), and not with a DRM modifier (ffmpeg's `hwmap` from VA-API to Vulkan makes a disjoint image with
  the planes' explicit layouts: the modifier list leaves the multi-planar formats out).
- [B, C] **GTK4 on Vulkan: the bar met on the M4, the default not taken** (VK4 T13, bench/vulkan/REPORT.md "VK4 T13–T14"; GTK
  takes GL by default, so only `GSK_RENDERER=vulkan` meets Venus). Since the pump's ticker, iconscroll runs at 33 frames/s
  on the M4 against GL's 28–32, frames at GL's CPU a frame, fishbowl at 60. Left: (1) [C] NVIDIA not measured (SwiftShader, VK4's backlog easy wins: iconscroll at 18.2–18.5 frames/s with
  the ticker, 14.4–16.0 with the pump, GL's 7.7–8.0: REPORT.md "VK4 backlog easy wins"); (2) [B] GTK takes Vulkan
  by default only with a dma-buf modifier other than LINEAR (sway on virgl would have to import it): the decision that
  makes GTK4 Vulkan's, VK4's tier 4; (3) [B] each fenced queue submit costs the guest two execbuffers (Mesa 26's fences are
  DRM syncobjs signalled through the virtqueue; no feedback path), 3 a GTK4 frame, and GSK's ~70 synchronous
  `vkAllocateDescriptorSets` a frame (Venus's pools go synchronous once sets of mixed layouts are freed) each a ring
  round trip: both the guest's Mesa's, which a guest patch could change; (4) [B] the ticker's busy cost (~50 ms a second of
  the GPU worker at iconscroll) could drop if the ticker read the rings' tails itself and woke the pump only for work;
  a submit held for the guest's own signal keeps the pump turning at the ticker's pace as long as it's held.
- [C] **Venus at 1 fish on NVIDIA: 2.4–2.6 ms a frame against virgl's 1.5, parked by the user** (2026-10-26: 1 fish isn't
  representative; likely NVIDIA's driver latency or its GPU leaving low power slowly; Venus is ahead at 1,000 fish and
  the toolkit). The leads: Chromium notices a lone pass done ~2.2 ms late there (1.2 nudged, at once under load), the
  scene's pass ~0.9 ms of GPU (the M4's 0.41), a frame's `Queue::Submit` ~1.55 ms in the GPU process (REPORT.md "VK3:
  the NVIDIA run after L2b"; the 134 MB trace in `bench/results/local/vk3-nvidia-l2b/`), 2.5 ms at c8087cb0 (the
  same WebGPU calls: the next entry). The floor before it (~4.5 ms
  a frame: a ring poller on a clamped `setTimeout(0)`, Dawn's slow look at a done submit) was fixed in VK3 L2 and
  confirmed there (REPORT.md "VK3 L2", "VK3: the NVIDIA run after L2").
- [C] **Venus's submits ~2 ms later on NVIDIA since 4fdc69fb** (VK3's final NVIDIA run; REPORT.md "VK3: the final NVIDIA
  run", "VK3 L9a", "VK3: the NVIDIA run for L9"): at c8087cb0 a scene submit is done 5.4 ms after it's made at 1 fish
  (3.3 at 4fdc69fb), 6.9 at the toolkit (4.9), mpv's 4.9 (3.9); a frame 5–40% dearer, still under virgl's at 1,000
  fish and the toolkit. The GPU's pass and the encoding unchanged, a frame's Dawn `Queue::Submit` 1.56 → 2.53 ms of the
  GPU process's CPU. Not on the M4 or SwiftShader (alternated A/B), the same WebGPU calls (counted on SwiftShader), and
  none of the suspects (`?gpu=vkl9=features|limits|bindgroups|pad|all`, 4fdc69fb's behaviour: `all` no cheaper).
  Next: a bisect on NVIDIA itself, a bundle carrying the page at several of the 34 commits between them (`git log
  4fdc69fb..c8087cb0 -- vk web`: the images shared, ~20 MB a page) run as alternated arms in one session; or Dawn's
  own trace categories (`dawn.validation`, per-command timings) at both commits, which would name the slower command.
- [B, C] **Presentation's gaps** (VK2 L4, VK4 T48; vk/README.md "Presentation"): [B] a fullscreen Vulkan window isn't tried (wlroots may
  scan a client's dma-buf out directly: `SET_SCANOUT_BLOB` of a Venus blob, `ERR_UNSPEC` today, would need the
  screen to draw a WebGPU texture); a WSI format the guest's sway doesn't offer today isn't shared (the 4444 and 5551
  formats, R16G16B16A16_UNORM: a warning, a black window), nor a prime blit's buffer of R5G6B5 (X11's WSI; `bufferFormat`
  has no 16-bit texture of its bytes); [C] a browser that renders with a GPU but whose WebGPU canvases fail would lose its GPU channel on the bitmap
  way (`shareMode` decides by the renderer's name: no such browser seen; `?gpu=vkreadback` is the way out); [B] the
  readback way holds the compositor's submit for its wait (7–10 ms a frame at 1080p on SwiftShader).
- [B, C] **Imports' gaps** (VK2 L6, vk/README.md "Imports"; mpv on Vulkan meets its bar regardless):
  - [B, C] **Mesa's async present drops a present after a failed one** (VK3 L4e, REPORT.md "VK3 L4e"; vk/README.md "The
    guest's Mesa"): Venus's `vn_wsi_present_async` (Mesa 26.x, main as of 8598bb5c) returns the previous present's
    error for the next present, of any swapchain, and drops that one unsubmitted (frame never shown, present fence
    never signalled): a cold mpv's fullscreen window froze and it couldn't exit, also at a file's end. The desktop image
    works around it with `VN_PERF=no_async_present`. Left: [B] drop the workaround once Arch ships a fix (filed in
    "Upstream reports" below; Arch has 26.2.6 on 2026-11-09) (mpv on Vulkan exits on SIGTERM with it: REPORT.md "VK4 backlog
    easy wins"). [C] **The hosted desktop disk needs replacing** with one built since L4e (the
    local one is) before a deploy of the page, which since L4e takes libplacebo's advanced path by default
    (`?gpu=vkformats=held`: off), so that an old disk's first cold mpv doesn't meet the freeze.
  - [B] **Each picture is still written into Venus's texture** (VK4 T16 gave each resource a texture of its own, so an
    import writes nothing; bench/vulkan/REPORT.md "VK4 T16"): 0.6 MB and ~0.18 ms of the GPU worker a frame at 480p
    (~3 MB at 1080p), the bytes the host decoded anyway, copied by `queue.writeTexture`. Fewer would need the picture
    on the GPU (WebCodecs' frame into WebGPU: `importExternalTexture` gives RGB, not the planes, so a plane would be a
    compute pass's output from it). (An imported image no longer makes a texture of its own: VK4 T48.) A disjoint
    multi-planar image's planes on imported memories still make theirs at `vkCreateImage` (no program meets it).
  - [B] A resource with no picture written yet is read back once at its first import (WebGL's synchronous `readPixels`);
    what the guest renders into a virgl resource after it is imported (rather than a decoder's picture) never reaches
    Venus's copy. Nothing makes the guest wait for a picture before it samples the import (`vaSyncSurface` waits for
    nothing): a draw queued before the picture lands samples the texture's earlier bytes (vk/README.md "Imports").
- [B] **Dawn in the guest's Chromium on Venus** (VK3 L7.1's remainder: bench/vulkan/REPORT.md "VK3 L7.1", "VK3 L7.1b").
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
  as an opaque fd, `vn_renderer_sync_export_syncobj(…, false)`, in a patched Mesa in the guest images); the fd 0 is filed in "Upstream reports" below. (3) A window: Chromium calls Wayland incompatible with Vulkan; the desktop image has
  Xwayland since GD G7 (`xorg-xwayland`: Godot's X11 windows), untried with `--ozone-platform=x11` here;
  `--headless=new` starts (its frames would come out through the page's log). `bench/vulkan/dawn-frames.ts guest` runs
  the samples (ARMS: the flags; CR_ENV: the environment; LOGBEFORE: the log up to a line) and compares them with the
  dev VM's; `CHROMIUM_ARGS="--enable-unsafe-webgpu --enable-features=Vulkan"` for the host's side.
- [B] **ANGLE's row's gaps** (VK3 L7.4; vk/README.md "The shader path", "Commands"), each for when a program or dEQP-VK
  needs it:
  - [B] **Transform feedback** (queries, draws by a byte count, restarts, the provoking vertex's order and gl_PointSize's
    capture since VK4 T45; vk/README.md "Commands"): streams past 0 (and so `geometryStreams`; dEQP's query cases all
    need geometry shaders, so the queries are proven by the driver's tests and ANGLE's ES3 page only), 16-bit outputs,
    records past 512 bytes (`maxTransformFeedbackBufferDataSize`: NIR's offsets reach 1 KiB, `wgsl_info.xfb_words`
    holds 512 bytes; unreachable but through padded strides, as 64 output components fill 256 bytes, so not raised),
    `VK_EXT_primitives_generated_query` (107,866 dEQP cases, most needing geometry shaders: it counts every draw's
    primitives, captured or not, which the captures' counts don't cover: each draw would need its count, the CPU's
    or an indirect one's on the GPU). A captured indexed draw with primitive restart runs in one invocation (`wgx_serial`):
    fine for dEQP's few vertices, slow for a large one (unmeasured; no program met). Each captured draw is a compute
    pass of its own with a copy of its index and vertex ranges (VK3 L7a: one storage
    binding for them all), and a copy of each bound range in and out per capture: fine for dEQP's sizes, not measured
    on a real program. An indexed or indirect captured draw copies its vertex bindings whole from their offsets (an
    indirect one its index range too: the CPU knows neither the indices nor the count), so one past
    `maxStorageBufferBindingSize` (a big shared vertex buffer bound whole) is skipped with a warning (VK3 L8a, the
    track-end review's finding 2, which fixed a direct draw's index range); bounding them would take the indices'
    range from a compute pass first, or a capture that reads the vertex buffers through bindings of their own (left by
    VK4 T45: no program met it, and either way is a pass of its own per draw). A draw-indirect-count under transform
    feedback is captured a record at a time (each capture reading the count: `maxDrawCount` compute passes), and a
    triangle fan drawn by a byte count isn't drawn (said once; neither met by a program).
  - [B] **The provoking vertex**: indirect draws whose last vertex provokes, and draws by a byte count (drawn as they are,
    warned; a pass would write their indices and arguments from the GPU's count: `provoke` sizes its list on the CPU;
    left by VK4 T45, no program met one: ANGLE draws flat varyings directly), adjacency topologies (not supported), and a compute pass and a scratch range per such
    draw (ANGLE draws with flat varyings only where a shader has them: not measured).
  - [B] **ANGLE with Chromium's own Vulkan device too** (`--use-angle=vulkan --enable-features=Vulkan` in the desktop
    guest; bench/vulkan/angle/es3.html through `PAGE=… bench/vulkan/dawn-frames.ts guest`, results/vk3/l74/): its 24
    uniform blocks' sum draws 205, not 156 as with `--use-angle=vulkan` alone and on GL (the flat varying and the
    capture right in all three). Not the uniform buffers (VK3 L7a, bench/vulkan/REPORT.md "VK3 L7a"): 205 is 156
    sRGB-encoded exactly. There Chromium gives WebGL an `R8G8B8A8_SRGB` mutable image (format list SRGB, UNORM), and
    ANGLE's only attachment view of it is the SRGB one, which the multisampled UNORM target is resolved into
    (`results/vk3/l7a/angle-es3-vulkan-views.log`, a debug build's). Next: why ANGLE renders the resolve through the
    sRGB view there (Chromium's SharedImage format with Vulkan, ANGLE's sRGB write control), against ANGLE on lavapipe
    through Venus's advertised set (bench/vulkan/profiles/run.sh).
  - [B] **Uniform buffers**: 13 a stage (WebGPU's 12, less the push buffer's, and 2 of the storage buffers; 14 where
    the adapter has 11 storage buffers or more, VK4 T40); a layout's
    texel buffers take uniform bindings too (their parameters), which can push more uniform buffers into storage than
    the 2 the storage count gives up (refused at the pipeline's creation since VK3 L7a, saying why).
- [B] **vkd3d on Venus** (VK3 L7.5, VK4 T47; bench/vulkan/vkd3d.ts, bench/vulkan/REPORT.md "VK4 T47"): Arch's vkd3d
  1.19 makes a Direct3D 12 device at feature level 11_0 in the desktop guest. [B] 11_1 and up are refused, since vkd3d
  grants 11_1 only with every 11_0 feature: geometry and tessellation shaders (tier 4's compute pre-passes),
  `multiViewport` (a draw per viewport, as `gl_Layer`'s per layer), cull distances, and 64 storage buffers and images a
  stage (WebGPU has 8 to 10: only through one binding of many, as the address buffer's regions), each a whole emulation;
  `occlusionQueryPrecise` and pipeline statistics never (graphics.md "Permanent limitations"). Warnings that block no
  level: the viewport's bounds and subpixel bits (graphics.md "Permanent limitations"; SwiftShader rounds a viewport's
  origin to 1/16), 13 uniform buffers a stage on SwiftShader's and the M4's 10 storage buffers, and dual-source blending
  on SwiftShader (the adapters'). Its d3d12 suite (`TESTS=all`, 73 s; `FAILED=<n>` for each test's first failures): 136
  of 174 pass, 35 fail, 3 crash (T48 clamped integer outputs to their attachments' range: test_output_merger_logic_op's
  354 checks pass). test_fractional_viewports's 5,120 of 20,594 are SwiftShader's (the texcoords of an origin rounded
  to 1/16): the M4 passes all 20,594 (2026-11-09). The failures by cause, the larger first:
  - [B] test_gather_c (42 checks): GatherCmp on an R32_FLOAT view. WebGPU compares only depth textures, so the bind
    group is refused. Vulkan wants the format's depth-comparison feature, which the device doesn't report, and vkd3d
    uses it anyway. A compare done in the stage (a variant keyed by the view's format not being depth) would back it
    (M; the same as "Colour formats aren't compared" below).
  - [B] The three crashes (test_clear_unordered_access_view_image, test_depth_load, test_typed_uav_store) are vkd3d's
    tests dereferencing textures that failed to be made: R16_UNORM and R16G16_UNORM storage images, which only
    `texture-formats-tier1` has as textures at all (SwiftShader's adapter lacks it). Direct3D 12 wants their typed UAV
    stores at 11_0. [B] Without tier1, such an image would need a texture of another format behind it, as packed
    formats have (M). The M4 (tier1) passes all three: 40,677, 103 and 83 checks (2026-11-09, `results/vk4/easy2/m4-vkd3d.txt`).
  - [B] test_vertex_id (52 of 127): its indirect draws' values in stream output, base vertices 3, 8 and 9 (VK4 T40's).
  - [B] test_register_space (10): a compute stage of 16 texel buffers' words, past WebGPU's 10 storage buffers.
  - [B] test_multisample_array_texture (9 of 147): a multisampled array's other layers ("Multisampled arrays'
    leftovers").
  - [B] test_shader_instructions (5): `ne` with a NaN operand and log of 0 giving -127 where -inf is wanted are WGSL's
    (graphics.md "Permanent limitations"); the rest not looked into. One each in test_clear_render_target_view (a view
    of another format), test_primitive_restart, test_early_depth_stencil_tests, test_64kb_texture_alignment and
    test_sample_instructions; two in test_clear_unordered_access_view_buffer and test_shader_eval_attribute (an
    attribute at a snapped offset).
  - [B] Not advertised: geometry and tessellation (test_clip_distance's PSOs with those stages, and 12 tessellation and
    hull tests), cull distances (12), conditional rendering (5: draws gated by a buffer's word, as a count's records
    are), descriptor indexing's arrays (test_resource_arrays), and textures the CPU writes (test_read_write_subresource,
    vkd3d's E_NOTIMPL); pipeline statistics (6), calibrated timestamps (2) and 8 samples (1) never.
  [B] A real program is still unrun: vkd3d's demos need an X window, which the desktop image has had since GD G7
  (Xwayland), but Arch's package may not carry them (M: a program built or packaged in the image). The draw parameters'
  cost (a push-buffer place, and group 3 bound again for each draw whose bases change) hasn't been measured on a
  program.
- [B, C] **The Vulkan driver's gaps** (VK2 L2, L5; vk/README.md "The driver"; VK4-KICKOFF.md's T36–T50 took what
  WebGPU can back, each naming the entries it started from), each for when a program or dEQP-VK needs it;
  dEQP-VK's failures by cause. VK4 T1's census (bench/vulkan/REPORT.md "VK4 T1": every 100th case of the direct set's
  groups, 16,489; on SwiftShader 2,448 pass, 498 fail, 2 crash, the rest unsupported, the M4 alike) counts every cause
  in its table (`bench/vulkan/census.ts`); the counts below without a date are L5's samples
  (`bench/vulkan/results/vk2/l5/deqp/`). The cases that fail stay out of `tests/deqp/vk.txt`:
  - [B] **Not advertised, by what dEQP-VK asks** (the census of 2026-11-05, bench/vulkan/REPORT.md "VK4: the census
    again": 75% of the sample not supported on either host, against 0.2% of the M4's supported cases failing; its
    reasons by `census.ts --reasons`; what the census's and the backlog's tasks T22–T49 took is advertised since; what
    WebGPU stops, protected memory to pipeline statistics, is graphics.md "Permanent limitations"). Left: mesh shaders
    (a compute pre-pass, as geometry's would be: tier 4's shape); 3D ASTC (T35, parked: "3D ASTC" below);
    `VK_EXT_primitive_restart_index` (16: the tests' guest's Venus, Mesa 26.2, doesn't pass it on, and WebGPU restarts
    only at the format's largest index, so every indexed draw with another would need its indices rewritten before its
    pass); the third extended dynamic state's rest (rasterization samples, polygon and line modes, conservative
    rasterization: none WebGPU has, 2 of the 23 asked only for them, the rest for other extensions too). Polygon modes:
    "Polygon modes" below.
  - [B] **`api.info.image_format_properties2.*` of the YCbCr formats time out** (VK4 T1's "crash" of `r12x4_unorm_pack16`,
    VK4 T2): with `DISJOINT` in its create flags the case makes ~340,000 synchronous queries, ~0.1 ms each through
    Venus's ring, so it passes in 34 s (`WATCHDOG=disable`) but past dEQP's 30 s watchdog; out of the list. A guest's
    synchronous calls' latency is T13's. `2d.optimal.r12x4_unorm_pack16` came back into the list with VK4 T38 (13 s
    alone, before and after T41) and crossed the watchdog under `ci-deqp-vk.sh`'s two machines (VK4 T41's runs, seed
    1434936936 twice): out again.
  - [B] **External memory's leftovers** (VK4 T2, R6): the guest's export imported again aliases its memory while the
    memory or an import of it lives, on its own device; otherwise (every one freed before a new import, another
    device) the import is a memory of its own whose bytes aren't shared (vkr's patch, `wg_AllocateMemory`; not met by
    dEQP-VK). An import that wants device addresses of a memory that hasn't any and already has a buffer is refused
    (`VK_ERROR_INVALID_EXTERNAL_HANDLE`: the buffer's GPUBuffer is in use). (Images on external memory: graphics.md
    "Permanent limitations".)
  - [B] **Compressed images that aren't whole blocks' leftovers** (VK4 T18; vk/README.md "Samplers in the shader"): each
    size of such an image a program samples is a variant of its program (the size is in the key; a texture's real size
    can't tell it, a uniform would cost a binding); anisotropy is lost on them; the
    shader's filter's cost on a program is unmeasured (none replayed has such an image). `texture-compression-unaligned`, if Chromium ships it, replaces all of
    it (`padded` false).
  - [B] **Copies WebGPU refuses**, what VK4 T10 left: a multisampled copy between formats of a block's size goes
    through a shader that carries the bits (VK4 R4, T39: `bitsBetween` in web/venus-gpu.ts), for 8-, 16- and 32-bit
    channels of unorm, uint, sint and float, `rgb10a2` and packed layouts; SNORM layouts (`texelFields` leaves them out:
    VK4 T38's 10-bit orders mark their most negative code) and a multisampled copy between a depth or stencil aspect
    and a colour format are skipped with a warning. A float16's signalling NaN
    doesn't survive it. A linear blit from a padded compressed image filters into the padding at its last texels. GFXReconstruct's trimmed captures restore their depth images through the worker's
    paths (vkQuake's first replayed frame).
  - [B, C] **Views in another format's leftovers** (VK4 T4; vk/README.md "Views in another format"): every failure left in
    `image.mutable` is multisampled: [B] view formats WebGPU can't multisample
    (`r32_sint`, `r32_uint`, the `rg32` ones: such an image's alias can't be made, and its invalid texture loses the
    submit: 124 of VK4 T39's run; channels split into `r32float` textures, "Sample counts Vulkan wants" below, is the
    shape), in 2D and in arrays. [B] Also not backed: a multisampled copy between SNORM layouts (VK4 T39 carries the others'
    bits, `bitsBetween`), a shared or linear
    image's view in another format (what others read is its own texture), views of another block size (uncompressed of
    compressed: `BLOCK_TEXEL_VIEW_COMPATIBLE`), and, in one render pass, a write through one format read through
    another (no copies in a pass). `image.mutable`'s `store` and `load` cases are NotSupported here (dEQP asks for
    multisampled storage): checked once by reporting samples for storage in a throwaway build, 113 of 371 passing, none
    failing, the rest not supported (`results/vk4/t4/store-probe/`). **The copies' cost** (VK4 T23, REPORT.md "VK4
    T23"): Godot's SDFGI writes `r32uint` storage images and samples them through `rgb9e5ufloat` views, which
    copied ~34 MB a frame: fixed by decoding the words in the shader (vk/README.md "Views in another format"). What's
    left copying: the GI demo's one `r16uint` volume read as `rgba8unorm` (once, at the start), and any other pair of
    formats WebGPU can't view one as the other; ffmpeg's and libplacebo's filters are not measured. [C] **For the next
    NVIDIA run** (the user's call, 2026-11-05): `VK2_STEPS=t23` in it, whose `t23-copies` part puts the old copies
    back, gives the decode's gain there (the `views` arm's ceiling was +12% frames/s, REPORT.md "VK4 T23").
  - [B] **Reading the attachments' leftovers** (VK4 T32; vk/README.md "Reading the attachments", "Colour attachment
    locations"; one draw's overlapping primitives, unrestricted depth ranges and 16 attachments: graphics.md "Permanent
    limitations"): a draw recorded in a secondary command buffer whose pass the primary began reads nothing (the pass's
    views aren't known there: drawn without the test, the op or the blend), nor does an attachment drawn in a crop or a
    3D image's slice. Not supported in its samples beside those: 64-bit formats, mesh shaders. Local read: the input attachment index map
    isn't read (input attachments go by their descriptors), dual-source outputs aren't moved by the location map (their
    draw refused; WebGPU's dual-source blending takes one colour target, so a pass with more can't draw them at all); of its
    sample `VK_EXT_dynamic_rendering_unused_attachments` (48), sample counts and `customResolve` are the commonest
    reasons left.
  - [B] **Feedback loops' leftovers** (VK4 T32; vk/README.md "Feedback loops"): `VK_KHR_unified_image_layouts` (the
    `general` layout's 1,190 of `attachment_feedback_loop_layout`) needs only advertising, once the guest's Venus carries
    it (Mesa 26.2's doesn't: waiting on Mesa); stencil read-write (300) needs stencil export (graphics.md "Permanent
    limitations"). A sampled view's copy
    is its whole range at each renewal, however little the draw reads; a draw in a secondary command buffer whose pass
    the primary began doesn't know the pass's attachments (as input attachments there).
  - [B] **Multisampled rendering to single-sampled attachments' leftovers** (VK4 T32; vk/README.md "Multisampled
    rendering to single-sampled attachments"): 4 samples only (WebGPU's); one layer, no 3D slice (other passes render single-sampled
    as before); an attachment of a format WebGPU can't multisample is left out of the pass, its clear made outside it
    only where the render area covers it. 70 of `multisampled_render_to_single_sampled` draw R32G32B32A32_UINT at 4
    samples past the query (dEQP-VK checks the counts of every format only when the first float attachment is
    single-sampled): they fail, out of the list.
  - [B] **Multisampled arrays' leftovers** (VK4 T12; vk/README.md "Multisampled arrays"): a shader sampling a whole
    `sampler2DMSArray` reads the first layer, whatever the layer asked, and its size says one layer (VK4 T47: vkd3d's
    test_multisample_array_texture 9 of 147 checks fail, its other layers'; it needs a binding per layer and a switch on the layer in the translator,
    and the layer count is the bound view's: a variant keyed by it, its bindings past a stage's 16 textures for more
    than a few; VK4 T39 left it, an L task: 18 of dEQP-VK's sources declare one, in pipeline, render pass, resolve and
    fragment shading rate tests, not counted). The
    48 of `multiview.*multisample*` ask for `r32g32b32a32_sfloat` and the `image.mutable` r32 ones for views WebGPU can't
    multisample, without a format list saying so: no texture can back those (only the channels split, "Sample counts
    Vulkan wants but WebGPU lacks").
  - [B] **Packed formats' leftovers** (VK4 T12, T30; vk/README.md "Packed formats"): [B] a 16-bit format holds 8 bits a
    channel, so what's rendered is sampled unrounded and blends run at 8 bits; a multisampled copy between a packed
    SNORM order (the 10-bit ones) and another layout is skipped with a warning (VK4 T39 carries the others' bits). The 10-bit SNORM orders (VK4 T38) are `rgba16float`: what's rendered there stays unclamped and
    unquantized until copied out (sampled as rendered; Vulkan clamps and rounds at the write), and the most negative
    code (-512, alpha's -2) is -1 − 2⁻¹⁰ there so that copies keep it (a shader's reads of it clamped, `WGSL_SNORM_KEY`;
    WebGPU's linear filter weighs the unclamped code, a 2⁻¹⁰ · weight off at most); [B]
    `blit_image.*.astc_8x8_unorm_block.a2b10g10r10_snorm_pack32.general_general_linear` fails on both hosts (still
    2026-11-09), its other ASTC blocks pass on the M4 (not looked into: SwiftShader fails 6 more of them). [B] Not offered: linear tiling of any packed format (~180 of VK4 T31's sample on the M4: a
    linear image's copies to and from its memory would go through the pass); sampling scaled formats (VK4 T31: the spec
    samples them as floats, dEQP-VK through integer samplers, and clears them with integers, which our clears follow:
    offering either way fails the other; no program met samples one). sRGB vertex formats aren't offered (no driver has
    them: 14 of T31's vertex sample).
    `D16_UNORM_S8_UINT` keeps depth24plus's 24 bits (Metal's depth32float) until copied out, so a depth test between
    two values one D16 unit apart can differ from real D16; its depth bias's ×256 is exact only for a 24-bit unorm.
  - [B] **Colour formats aren't compared** (VK4 T38): depth formats report `SAMPLED_IMAGE_DEPTH_COMPARISON` in
    `VkFormatProperties3` since VK4 T38, colour ones don't (WebGPU compares depth textures only), so `texture.shadow.*`'s
    `r32_sfloat` and `r16_unorm` cases (672 each) stay not supported. A comparison of a colour texture would be the
    shader's, from fetches (as a shadow sample past level 0 is: "Samplers' leftovers"), keyed by the bound view's format
    (M; vkd3d's test_gather_c too).
  - [B] **Pulled vertices' leftovers** (VK4 T5, T44; vk/README.md "Pulled vertices"): [B] more pulled bindings than the
    vertex stage's storage buffers left; a pulled range past `maxStorageBufferBindingSize` is cut there (several
    bindings of one range would take it, a storage buffer each; the adapters we run offer 1 GiB or more, the device
    asks for the adapter's, so only a 128 MiB adapter and a vertex range past it would); a four-group program whose
    group 3 bindings reach 976 has no room to pull in it (refused); a vertex stage whose uniform buffers leave no room
    for the pull's parameters takes them as read-only storage (VK4's backlog easy wins), refused only where its storage
    buffers have no room for them either. [B] A pull with a divisor makes a bind group per change
    of the first instance or the indirect record (unmeasured: vkd3d's instanced tests and dEQP-VK only). Formats WebGPU's vertex buffers lack are pulled since VK4 T31. A direct draw that reads past a vertex buffer's end
    (Vulkan's robust buffer access reads in range or zeros; WebGPU refused it) pulls that binding, zeros past it, since
    VK4 T37; an indirect one isn't checked by WebGPU (its reads clamped in range). The cost of pulling isn't measured:
    nothing we run meets it but dEQP-VK and vkd3d's tests (a bind group per change of the ranges, and a shader's bytes
    decoded per vertex).
  - [B] **Formats**: D24 depth tests fail by one unit (depth24plus's precision: a fragment depth quantized to 24
    bits would cost the early depth test).
  - [B] **Samplers' leftovers** (VK4 T8, T9; vk/README.md "Samplers in the shader"): a border on a view of several levels, a
    shadow sample past level 0 and a mirror-once with an offset pick their levels in the shader, so those samples lose
    anisotropy; a texture of one level sampled at a LOD past 0 through a sampler whose mag and min filters differ reads the
    mag filter (WGSL's compare is at level 0); `textureQueryLod` ignores anisotropy; a comparison through a
    non-seamless sampler with a nearest filter is seamless (`texture.shadow.cube*.non_seamless*` aren't supported for other reasons);
    a cube sampled with nearest filters, a nearest or linear mipmap and U at clamp-to-border fails on SwiftShader,
    seamless or not (50 of VK4 T28's `filtering.cube.combinations` non-seamless cases and their seamless twins: WebGPU's
    own sample, not the fetches); each base of `vkCmdDispatchBase` is a compute pipeline, never evicted (a
    tiler's cost, not its results: `wg_compute_based`, the review's C7); a browser without `texture-component-swizzle`
    ignores mappings, said once (a fallback needs `texelFetch` keyed too, and every Chromium backend has the feature);
    the variants' compile on a
    program's first draw with such a sampler is unmeasured (no replayed program meets one).
  - [B] **Multi-draw's leftovers** (VK4 T26; vk/README.md "Commands"): a draw-indirect-count of a triangle fan isn't
    drawn, said once (the fan's pre-pass reads each record as it is; not met; under transform feedback it is since VK4
    T45); an indirect op's draws are replayed one by one (a draw, and with draw parameters a 256-byte place of the push
    buffer, each: `maxDrawIndirectCount` is Vulkan's least with the feature, 65,536), and a count's records go through a
    compute pass before the render pass, so a program drawing thousands a frame (vkd3d's ExecuteIndirect) pays per
    record: unmeasured, no replayed program has one.
  - [B] **Min/max reductions' leftovers** (VK4 T25; vk/README.md "Samplers in the shader"): a reduced sample comes from
    fetches, so it loses anisotropy and costs ~3.5× WebGPU's sample on the M4 (no replayed program has one; vkd3d's 12_0
    asks for the feature); the M4's 16-bit normalized formats are unfilterable there (the adapter's), which keeps 2 of
    the census's linear-filtering cases out on it. The census's 195 `filterMinmaxImageComponentMapping` cases are dEQP's
    own refusal (nothing to do): it throws
    NotSupported for any reduction whose R mapping isn't identity, whatever the property says.
  - [C] **SwiftShader's fetch from a view with a base level** (VK4 T8; still failing 2026-11-09): `textureLoad` at a view's level 0 reads the level
    after it (a 16×16 image's view from level 2 reads level 3's texels, zeros past its size; level 1 reads right), where
    sampling is right and the M4 is too, so
    `image_view.*.subresource_range.lod_base_mip_level*` of integer and (VK4 T18, fetched too) padded compressed formats
    fail there only and stay out of `tests/deqp/vk.txt`, which SwiftShader runs. Lavapipe couldn't be put under Chromium
    to tell SwiftShader from Dawn's Vulkan backend: `bench/vulkan/nvidia.sh` `VK2_STEPS=t18` asks NVIDIA, in the next
    batch of the user's runs. Not looked for in SwiftShader's sources.
  - [B] **SwiftShader's compressed formats sampled in a compute stage** (VK4 T22; ETC2's still failing 2026-11-09; `results/vk4/t22/`): with the compute queue
    family, `pipeline.monolithic.image` and `image_view`'s `*_compute` cases ran: on SwiftShader every one of a
    compressed format fails (123 of the sample: ASTC, ETC2 and EAC, whole blocks or not; "Image mismatch"), where
    their fragment twins pass there and the M4 passes them all. Not looked into (the translator prints the same sampling
    for both stages but the compute stage's explicit LOD). Also SwiftShader's alone: the `count_8` compute cases bind 8
    storage images (refused at their pipeline's creation, past the 4 advertised there, Vulkan's minimum; dEQP doesn't
    check the limit; the M4 has 8). And `pipeline.monolithic.sampler.view_type.cube*` linear and average-reduced
    samples of `r8g8b8a8_snorm`, `r8g8b8a8_srgb` and their VK4 T31 twins (`b8g8r8_snorm`, `r8g8_srgb`) in a compute
    stage (4 of T31's sample and their 4 twins: "Image mismatch"; the M4 passes them), and `a8_unorm`'s `cube`
    `mag_filter.linear_compute` and `mag_reduce.comp_r_g_b_a.average_compute` (not in the list: 5 of 5 runs fail on
    their own, VK4's full run; they passed once, in the A8 blends' "before" run: a rare pass, not a flaky failure).
  - [B] **Queries** (occlusion queries count on the GPU since VK3 L6a, in the device's set since VK4 T46: vk/README.md
    "The driver"; precise counts, calibrated timestamps and Chromium's quantization: graphics.md "Permanent
    limitations"): past 4,096 counts in one render pass (a query and each of its cuts by a clear, a part of the pass or
    a layer take one each) a query is reported as passing, warned once (a pass would be cut and its slots resolved
    there); the host's `vkGetQueryPoolResults` can't wait (`WAIT_BIT` answers `VK_NOT_READY` until the submit
    completes; Venus's guest driver reads its feedback buffers instead, so no guest meets it). Timestamps are the GPU's
    where the adapter has `timestamp-query` (VK4 T46), else the CPU's at replay, and the CPU's on Apple's GPUs: with
    them on the GPU the M4 (Chrome for Testing 157) lost its WebGPU device ("Insufficient Memory", Metal's command
    buffer) in 3 of 6 runs of T46's query cases (`bench/vulkan/results/vk4/t46/m4-lost.json`), always at the first
    timestamp case after the same 740 others (alone, those timestamp cases passed; the renderer before T46 passed 2 of
    2; one timestamp set for the module instead of a device's didn't help): a counter sample buffer made late, or Dawn's
    Metal timestamps over many devices, untried (S–M, the Mac, no clear lead). Two occlusion queries active at once
    aren't valid Vulkan (VUID-vkCmdBeginQuery-queryPool-01922): reported as passing, nothing to do.
  - [B] **Rendering** (one draw's front and back primitives' order, float depths past the viewport's range, early
    fragment tests and storage the fragment stage writes for the vertex stage: graphics.md "Permanent limitations"): a
    2D view of a 3D image sampled or stored (`VK_EXT_image_2d_view_of_3d`, VK4 T38) is the level's 3D view and a
    variant keyed by the slice: a pipeline a slice bound (a program walking a volume's slices makes one each; a slice in
    the group's parameter table, as texel buffers' are, would make one for all). `gl_Layer` from the vertex stage (VK4
    T43) is drawn a layer at a time, so a draw writing it is drawn once a layer (its vertex stage run as many times), a
    primitive whose vertices disagree on the layer is clipped by the vertices of other layers (Vulkan takes the
    provoking vertex's), and in a layered pass's later layers neither an indirect draw that needs what the first layer's
    pass prepares (a count, a fan, draw parameters: said once) nor one whose vertex stage stores (T33's pre-pass, which
    ignores gl_Layer) is drawn; a pipeline writing gl_Layer gets its layers' pipelines when its first draw in a layered
    pass is recorded, not at its creation (`wg_pipeline_premake` knows no layer count, so a submit soon after may wait
    on them). Depth and stencil blits aren't drawn (wg_cmd.c `wg_CmdBlitImage2` returns; depth formats report
    `BLIT_SRC` only, Vulkan's minimum, and no `BLIT_DST`, so no valid blit meets it). A draw whose colour blends with both
    `CONSTANT_COLOR` and `CONSTANT_ALPHA` (WebGPU has one constant: the colour's taken, warned; 4 of the Mac's 49
    supported `pipeline.*.blend.dual_source` samples, and the same states in `blend.format`): a blend in the fragment
    stage on VK4 T32's attachment copy would take it. Non-indexed fans past 65,536 vertices not drawn (said once),
    indirect ones cut there, indexed indirect ones too (their list is sized by a fan: VK4 R4); an indirect draw with the
    last vertex provoking drawn as it is ("The provoking vertex" above). Alpha to coverage without a colour target at
    location 0, with a fragment stage that writes `sample_mask` or with alpha to one is the stage's own `sample_mask`
    (VK4 T43), the first `round(alpha · samples)` samples where WebGPU's hardware may dither; not where the attachments'
    locations are remapped (`VK_KHR_dynamic_rendering_local_read`'s map: WebGPU's, or none without a target). A depth
    bias the fragment stage moves the depth for (VK4 T43: every one on D24, other representations, fractions,
    `depthBiasExact`) costs its draws the early depth test and, without a fragment stage, a stage of its own; unmeasured
    on a program (a shadow pass on D24 is the likeliest: DXVK's and vkd3d's depth formats are D24S8 or D32), and per
    pixel, not per sample, at several samples; a float format's r from the fragment's own depth (Vulkan's is the
    primitive's largest exponent).
  - [B] **Polygon modes** (`fillModeNonSolid`, `extendedDynamicState3PolygonMode`; VK4 T43 looked into it, not advertised):
    ~200 dEQP-VK cases (`rasterization.culling.*_line`/`_point`, `draw.*non_line_with_params`, `rasterization.primitive_size`,
    `polygon_as_large_points`, `extended_dynamic_state.*polygon_mode_*`, `draw.*.depth_bias_triangle_list_line`); DXVK
    requires the feature (with geometry shaders, which keep it out anyway), vkd3d and ANGLE use it for wireframe. The
    kickoff's shape, a triangle draw's edges or corners as an index list a compute pass writes before the render pass
    (as the provoking pass's lists are), is right only without culling: Vulkan culls a polygon by its facing before
    drawing its edges, and its facing needs its vertices' positions, so the vertex stage has to run first. The shape
    that does both is VK4 T33's pre-pass (`vsPrepass`: the stage as compute, its outputs records, a pass-through stage
    drawing them) followed by a compute pass reading the records' positions, taking each triangle's facing with the
    viewport (its flip) and front face, and writing a line list (each kept triangle's three edges) or a point list (its
    corners) of the records' places for the pass-through draw (line-list or point-list topology), culled ones none: an
    L task on T33's machinery (the pre-pass for every such draw, not only storing stages; indirect draws need their
    counts, as T33's do). Also: flat varyings from the triangle's provoking vertex (a line's own first vertex
    otherwise), and the depth bias of polygons drawn as lines (WebGPU refuses a bias on lines: the fragment stage's,
    `post_text`).
  - [B] **Usage scopes' leftovers** (VK4 T3, R2: vk/README.md "Usage scopes"): a pass or dispatch that writes storage of a
    memory it reads otherwise reads copies taken at its start. Left: writable bindings of one range, one an array of
    atomics and one not (or of signed and unsigned ones), or together past `maxStorageBufferBindingSize`, refuse their
    draw or dispatch, said once (VK4 T37: WebGPU refused it, the submit lost); the plain one printed again from its NIR
    with its array atomic (a stage that writes storage keeping its NIR) would let them be one binding; a storage
    buffer of address memory beside its region's pointers' binding goes through that binding since T41's follow-up (the
    review of R1 to R4's W2), but not a dynamic one (its place would need the table made per offset), one whose atomics
    differ from the pointers', one beside pointers a vertex stage sees read-only (the binding can't be made writable), nor
    one in another draw of the pass than the pointers: those still go to a shadow, don't see what pointers write in the
    scope, and its copy back undoes it (across draws a writable descriptor needs no shadow beside writable pointers, which
    WebGPU takes as one usage: only beside read-only ones; unmet by anything measured); a variant per distinct
    offset between overlapping dynamic bindings, and a crop per size of a view, are kept until their program or view goes; a barrier
    of a secondary command buffer doesn't end the scope; a range past `maxBufferSize` isn't copied (warned, the
    scope dropped as before). Not met by anything measured (dEQP-VK's likeliest groups of the direct set, vkd3d's
    suite: bench/vulkan/REPORT.md "VK4 T3"), so the copies' cost is unmeasured on a program: DXVK or a VMA-based
    program whose shaders write storage would show it (vkQuake met the dispatch's shape in VK3 L6c).
  - [B] **Sample counts Vulkan wants but WebGPU lacks** (the review of L4f's finding 3): `framebufferColorSampleCounts` is
    1|4 (Vulkan's minimum) though `R32G32B32A32_SFLOAT` and `R32G32_SFLOAT` colour attachments have 1 sample (WebGPU
    multisamples neither): `api.info.image_format_properties.2d.optimal.r32g32_sfloat` and `.r32g32b32a32_sfloat` fail,
    the last of that group (VK4 R7), out of `tests/deqp/vk.txt`. **Left (VK4 T39's decision)**: an emulation would back
    such an image by textures WebGPU multisamples, and every path would take them apart: a 4-layer texture (a layer a
    sample) needs each draw replayed per sample with that sample's coverage and position by hand; the better shape is
    channels split into `r32float` attachments, which WebGPU multisamples (two for RG32, four for RGBA32: the
    translator's outputs, the pipeline's targets and blends, a stage's fetches of the image put back together, clears,
    copies and the drawn resolves per texture, as "Multisampled arrays" does per layer), an L task for a format no
    program met multisampled (DXVK, vkd3d, Godot and ANGLE render RGBA16F where they multisample). `R32G32B32_SFLOAT` (VK4 T31's rgba32float texture) met the same check, and as no
    program needs it rendered (Vulkan doesn't require it; most GPUs' drivers lack it) it is no colour attachment
    (`WG_FMT_NO_ATTACHMENT`: its blend and logic-op cases, 10 of the list, report not supported). A multisampled image of more than one layer is accepted but invalid
    in WebGPU (no multisampled arrays; Vulkan's format query can't say so: `maxArrayLayers` is per format):
    `api.copy_and_blit.*.use_after_copy.*x2*_img2img_msaa` (24 of VK4 T43's run) fill a 4-sample `R32G32B32A32_SFLOAT`
    image, invalid in WebGPU, and fail. The integer
    limits (`framebufferIntegerColorSampleCounts`, `sampledImageIntegerSampleCounts`) are 1 since L5b, as the 32-bit
    integer formats allow.
  - [C] **A trap in the module's completion on NVIDIA** (VK3 L9b, seen once): `RuntimeError: table index is out of bounds`
    from `wg_complete`. VK4 T2 found a sync freed while a submit naming it is pending or held makes the completion call
    the freed sync's type (`function signature mismatch` in Node) and fixed that (`wg_sync_finish`); whether it was
    NVIDIA's trap shows only in the user's next runs there (a completion that throws is still warned: `a submit's
    completion failed`).
  - [C] **`memory.binding.*.buffer_1048577` fails on NVIDIA** (VK3's final run and L9's, `results/vk3/nvidia-l9b/`): every
    binding mode (regular suballocated, dedicated, overallocated; aliasing suballocated) at 1 MiB + 1 byte, without
    the trap above; every other size passes there, and every one on SwiftShader and the M4. dEQP's message wasn't
    kept (DETAIL's 20 lines went to other cases): the next run there gets it (`nvidia.sh VK2_STEPS=l9b`, now with
    `DETAIL_MATCH=memory` and the guest kernel's log). A size not a
    multiple of 4 against WebGPU's copy and map alignment is the first suspect. Kept in the pass list (an
    adapter-only failure is filed, not removed).
  - [B] **Synchronization**: a submit waiting on a timeline value nothing has signalled is held until the value is met
    (VK3 L6a: `tests/venus-driver.test.ts` "waitBeforeSignal"); of dEQP-VK's `synchronization*.timeline_semaphore.
    wait_before_signal.*` (928 without geometry and tessellation in their names) 26 run since VK4 T33 offered
    `vertexPipelineStoresAndAtomics`, and pass (in the list); the rest ask for tessellation whatever their stages
    (tier 4). A submit of signals alone behind held
    ones is held too. With the control queue full and no ring fence retired and nothing sent for 250 ms, a fence gives its queue entry back
    and, once retired, is signalled by the next reply without a fence of its own, or a display event's (VK4 R1 and T36,
    docs/devices.md "Venus").
    A larger queue isn't the way out: that queue being full is what paces a compositor (docs/devices.md, "Flush replies
    are paced"), and 256 of them would put 4 s of replies ahead of each fence.
  - [B] **3D ASTC** (VK4 T35, parked 2026-11-07: the census's 187, 18,908 cases of the mustpass list name a 3D ASTC format,
    6,260 of them SFLOAT): no guest can see `VK_EXT_texture_compression_astc_3d`, whatever the device advertises:
    Mesa's Venus (main, 2026-11-07) doesn't list it, venus-protocol 1.1.3 doesn't encode
    `VkPhysicalDeviceTextureCompressionASTC3DFeaturesEXT`, and vkr's extension allowlist (`vkr_common.c`) doesn't name
    it; nor does any of the user's adapters offer it. When Venus carries it (or worth patching all three, as T24's
    `images/deqp/venus-icd.sh` did for a newer guest Venus): the image's own texture holds the blocks (`rgba32uint`,
    a block a texel, a level-0 extent large enough for every level's blocks), which every transfer moves as an
    `R32G32B32A32_UINT` image's; its views sample an alias (wg_device.c `image_alias`) of decoded texels
    (`rgba16float` for UNORM, as the specification decodes it, and SFLOAT; `rgba8unorm-srgb` for SRGB), which
    `image_use` refreshes by a decode pass of the worker's (a `gpu_blit` op: an invocation a block into a temporary
    buffer, copied in) where a copy would go; blits sample the alias. The decoder, a WGSL port of VK-GL-CTS's
    `tcuAstcUtil.cpp` (Apache-2.0: a THIRD_PARTY.json derived-code row with it), is on the branch
    `park/t35-astc-decoder` (`web/astc.ts`, naga-validated, never run). The same decoder could back ASTC LDR on
    adapters without `texture-compression-astc` (NVIDIA's) and `VK_EXT_texture_compression_astc_hdr`, which Venus
    carries; the user's call (2026-11-07): not a priority while real adapters don't offer them.
  - [B] **Mutable descriptors' leftovers** (VK4 T34; vk/README.md "Descriptors"): of the 10,500 `mutable_descriptor`
    cases without ray tracing stages 3,561 pass; [B] the rest ask for update after bind (4,557: commands are translated
    at submit, so bind groups made then would see later updates), acceleration structures
    and ray tracing (1,140), geometry and tessellation (810), variable descriptor counts (144), or aliasing (108:
    several types declared on one binding, which needs `descriptorBindingPartiallyBound`: an unwritten descriptor has
    no WebGPU binding to stand for it, so a dummy of the declared kind would be; and two kinds on one slot would need
    a variant keyed by each slot's written type, the other declarations' accesses left out). Of the rest, 105 are
    layouts the support query says no to (up to 6 mutable descriptors that may be storage images, or texel buffers
    as storage beside storage buffers: past a stage's WebGPU bindings) and [B] 75 ask for
    `shaderUniformTexelBufferArrayDynamicIndexing` (and its storage twin) and, before it, VK_EXT_descriptor_indexing:
    dEQP's `isDeviceFunctionalitySupported` takes that from Vulkan 1.2's `descriptorIndexing`, which needs update after
    bind, partially bound descriptors and runtime arrays besides (the spec's list), so advertising the two bits alone
    left all 75 not supported (VK4's backlog easy wins, 2026-11-09: run with them advertised, the reason
    `vktBindingMutableTests.cpp:2979`'s; not kept: nothing else we run asks). The query counts a mutable
    descriptor in every kind its list names and a set alone: a pipeline whose sets together pass a stage's bindings is
    still refused at its creation, said why. (vkd3d-proton's bindless heaps: graphics.md "Permanent limitations".)
  - [B] **Vertex stages that store's leftovers** (VK4 T33; vk/README.md "Vertex stages that store"): such a draw cuts its
    render pass and runs the stage as compute before it (`vs_prepass`), so each costs a pass's store and load (bench/
    vulkan/REPORT.md "VK4 T33": fine for dEQP-VK's and a program's few, not for thousands a frame). Not drawn: an
    indirect draw of such a stage (said once; its counts are on the GPU, and `vsPrepass` sizes its records on the CPU:
    a pre-pass taking the most the binding allows and the GPU's count would do; left by VK4 T45, no program met one). A transform feedback
    capture of such a stage is dropped (said: the capture's pass would run it again). Refused: outputs past WebGPU's
    16 vertex attributes (four words an attribute), a fragment stage reading storage the vertex stage writes (one
    layout entry, two accesses: two bindings of it would take it), and stages past WebGPU's bindings with the pre-pass's one (its parameters, inputs and
    records in one storage buffer since VK4 T40, which passed T33's 55 such failures of `descriptorset_random.sets4`
    and `sets8`). Geometry and tessellation, the same pre-pass's way, are tier 4's.
  - [B] **Device addresses' leftovers** (VK4 T7, T41; vk/README.md "Device addresses"): a memory is placed in the address
    buffer at its GPUBuffer's making and can't move there later, so one whose GPUBuffer a linear image made first, or
    that has no room left, has buffers whose address is 0 (said once). Regions reach 1 GiB together (an adapter whose
    binding reaches 1 GiB has one, so address memory past it fails there as before): with more than one, every access
    through a pointer is an `if` tree on the high word, a storage binding a region in each pointer-reading stage (those
    past the first out of `maxPerStageDescriptorStorageBuffers`; the first isn't, so a stage of every advertised storage
    buffer, the folded uniform buffers' bindings and a pointer is one binding past WebGPU's and refused), and at
    three SwiftShader's compiles of `buffer_device_address`'s depth3 stages ran past dEQP's 30 s watchdog. Programs'
    pipelines made for the regions in use, made again when another is first used, would let it reach the heaps. Capture and replay doesn't keep replays apart from other allocations (they'd be placed at a
    region's top, the region grown whole), so a replay's places can be taken by allocations that come in another order.
    Every use of a region's GPUBuffer counts as that buffer's, so a scope that writes storage of any address memory
    copies its reads of all of that region's: unmeasured on a program. Descriptors the pointers' binding can't take in
    ("Usage scopes' leftovers"). The 64 KiB past each memory bounds a uniform block widened past its range there. `buffer_device_address`'s `set15`
    and `set31` (1,344 cases) need `maxBoundDescriptorSets` past the 8 sets the translator has (`WGSL_MAX_SETS`).
  - [B] **API 1.3's required features** (the user, 2026-10-28: 1.3 stays advertised; the rest of VK3 and VK4 fill them
    as they go): `timestampComputeAndGraphics` with timestamps that are the CPU's on Apple's GPUs and adapters without
    `timestamp-query` ("Queries" above). A program that relies on 1.3's
    guarantees without checking them fails at pipeline or descriptor creation.
  - [B] **The M4's own failures** (VK4-KICKOFF.md T50; M, on the Mac; out of `tests/deqp/vk.txt` until they're understood; none is what VK4 T12 fixed there,
    `generate_mipmaps.from_previous_level`): the 16 `shader_draw_parameters.draw_index.*` (VK4 T26: one
    vkCmdDraw*Indirect of three draws whose colour is `gl_DrawIndex`'s; SwiftShader passes them): the quads are where they
    should be, but all three read draw index 0 (`results/vk4/t26/m4-draw-index-*.png`); a plain WebGPU page doing what the
    replay does (a copy into each 256-byte place of a uniform buffer before the pass, three drawIndirects of one buffer
    with the group's dynamic offset set before each) is right on the M4 (Chrome for Testing 157), so the difference is
    between the driver's calls and the worker's: next, a log of the worker's setBindGroup offsets and the push buffer's
    words at the draw, on both hosts; `fragment_operations.early_fragment.discard_no_early_fragment_tests_depth` (an
    occlusion count of 496 where 1,024 is right), `texture.mipmap.3d.projected.nearest_linear_mirror`,
    `texture.mipmap.cubemap.projected.nearest_linear_linear_repeat`, `texture.mipmap.cubemap.basic.nearest_nearest_linear_clamp_compute`
    (VK4 T22's, the compute queue's: its fragment twin passes); 11 copies to or from `e5b9g9r9_ufloat_pack32`, compared
    bitwise (Metal looks to canonicalize the format's bits on upload: unconfirmed; a texture of `r32uint` would keep them,
    and no program depends on non-canonical bits); every `depth_stencil_resolve.*_testing_stencil_samplemask` of
    D24S8 and D32S8 (the stencil reads 255 where 1 is right; 40 of VK4 T27's samples_4 run, SAMPLE_ZERO's and MIN's
    alike, so the stencil's draws, not the mode); 3 `robustness.image_robustness` storage-image cube cases (two
    `rgba32f`/`rgba32ui` `cube_array.comp_compute`, one `rgba32i` `cube.vert`; VK4 T42's sample, the same with the renderer
    before T42: `results/vk4/t42/m4-robustness-*.json`), out of the list since. (`descriptorset_random.sets4`'s were bindings past WebGPU's, on SwiftShader too: "Texel buffers"
    below; the multisampled 16-bit normalized passes, which WebGPU doesn't resolve, are drawn resolves since VK4 T21.)
  - [B] **SwiftShader compiles zero-initialized workgroup memory slowly** (VK4 T2; SwiftShader's: an upstream report, nothing left here): Dawn zeroes it through Vulkan's
    `VK_KHR_zero_initialize_workgroup_memory`, which costs SwiftShader ~17 s per pipeline with a 16 KiB array (19 ms
    with Tint's loop: `--disable-dawn-features=use_vulkan_zero_initialize_workgroup_memory_extension`, which the
    dEQP-VK runs pass). Only Chromium's SwiftShader WebGPU (`--enable-unsafe-webgpu`) meets it; a guest compute program
    with much workgroup memory waits that long for its pipeline there. Worth an upstream report (SwiftShader). Also slow
    there: `ssbo.corner_case.long_shader_bitwise_and` passes the M4 in 3 s and runs past dEQP's 30 s watchdog on
    SwiftShader (40 s without it), all but 0.1 s of it the pipeline's compile (VK4 T21; `results/vk4/t21/`): its 589
    `ivec4` loads through a device address are 2,356 `u32` loads of the address buffer, and SwiftShader's compile grows
    faster than they do (the same WGSL with one load a vec4: 3.1 s; with none: 0.1 s; Dawn's robustness off: no change).
    T21 printed NIR's boolean `iand`/`ior` as `&`/`|` (they were `&&`/`||`, a branch each in Tint's SPIR-V: 31.6 → 26.4 s).
    A vec4 view of the address buffer for loads NIR says are 16-aligned (T41's follow-up, measured by hand-edited WGSL,
    `results/vk4/t41/vec4-view-compile.json`) loses: the pointers' binding as `array<vec4<u32>>` takes 24.5–25.0 s against
    26.1–26.6 s, a second binding of the region as the view 25.5 s, the index a base plus a constant 27.1 s, robustness
    off too 21.3 s: SwiftShader compiles a vec4 load from storage as four, so the case stays past the watchdog, and it
    wasn't landed. What T21's 3.1 s had was a quarter of the loads; what's left is SwiftShader's (an upstream report).
  - [B] **What R7's limits leave** (VK4 R7, its review's B4, B8, D4): 16 vertex bindings need a free bind group and room in the
    vertex stage's storage buffers, or the draw is refused, said once (a four-group program pulls in its group 3 since
    VK4 T44, from binding 976: one whose group 3 reaches there, or a vertex stage's own storage buffers); 8 dynamic uniform buffers with push constants past the immediates or draw parameters
    put the push buffer on a dynamic storage binding, and a layout with all 4 of those too has its last one a plain
    binding at the offset bound (VK4 T40, `wg_bake_dynamic`: a bind group per offset, its cost unmeasured; a stage full
    of storage buffers is still refused); a
    uniform block declared past its range and what its memory's GPUBuffer has past it (64 KiB, less near
    `maxBufferSize`) reads a shadow of the block's size since VK4 T37, so its scope pays a copy (`has_big_uniform`
    scans a dispatch for it). A set with inline blocks has a GPUBuffer of 64 KiB more than them, for what its shaders may
    declare.
  - [B] **maintenance8's cases wait for the guest's Mesa 26.3** (VK4 T24; waiting on Arch, 26.2.6 on 2026-11-09): the device advertises `maintenance8` (offsets
    that aren't constants from fetches, depth and stencil copied with colour images, blits between layers and slices),
    but Mesa 26.2's Venus, the tests' guest's (Arch's 26.2.5; 26.2.6 the port's newest on 2026-11-05), leaves it out,
    so its cases are NotSupported in CI. Through 26.3.0-rc3's Venus (`images/deqp/venus-icd.sh`, `DISK2`, `GUEST_ENV`)
    they pass: `tests/deqp/vk-maintenance8.txt`, run by hand. Once the port has 26.3, rebuild the guest
    (`images/deqp/build.sh vk`) and move that list into `tests/deqp/vk.txt`. A sample with such an offset costs the
    fetches' filter (eight `textureLoad`s a trilinear sample) where WGSL's own would do: unmeasured, no program here
    has one (vkd3d's D3D12 layering is what asks).
  - [B] **maintenance5's and 6's leftovers** (VK4 T24, `results/vk4/t24/`): A8_UNORM is offered since VK4 T38 (an
    `r8unorm` texture, vk/README.md "Formats a texture holds otherwise"; blended since VK4's backlog easy wins) without
    blits (the worker's blit draws know no swizzle) or storage, and only with `texture-component-swizzle`; a pipeline
    blending A8 by the constant's alpha beside another attachment blending by the constant's red reads its alpha there; an index buffer bound null wants robustness2's
    `nullDescriptor`. (maintenance6's aliased images: graphics.md "Permanent limitations".)
  - [B] **Memory** (images bound to one range, `memory.binding.aliasing.suballocated.image_*`: graphics.md "Permanent
    limitations"): an allocation past the device-local heap, the largest
    GPUBuffer or the arena, which Venus's guest doesn't wait for, is an empty memory (`memory_refused`): a blob's map gives
    zeros that go nowhere and a buffer past its bytes loses its submit, where a program learns less than from
    `VK_ERROR_OUT_OF_DEVICE_MEMORY`. Host-visible memory the arena has is had past its heap. Only
    the guest's `VN_PERF=no_async_mem_alloc` would give the error back; a program within its budget doesn't meet it
    (VK_EXT_memory_budget is advertised).
  - [B] **A render pass's JSON garbled** (seen in VK4 T38's SwiftShader runs, before and after its change, three times in
    16,024 cases; the case not identified): `gpu_render_pass threw: SyntaxError` on fragments such as `}` and `eight"`,
    so the pass's description reached the worker cut or overwritten (wg_cmd.c's `gpu_render_pass(json, strlen(json))`
    at a pass's replay, or its JSON buffer reused). That pass is lost; nothing failed that names it. Next: run the
    sample with `VIRGL_GPU=virgl,vulkan,debug` and find the case from the trace.
  - [B] **Texel buffers** (VK3 L6b, vk/README.md "The shader path": a storage buffer of the view's words, its format
    decoded in WGSL; storage of texels under a word by atomics since VK4 T38, of 3- and 6-byte ones not offered): each
    takes one of WebGPU's storage buffers a stage (10 on SwiftShader and the M4, 8 by default), which Vulkan counts with
    sampled or storage images (16 and 4). Since VK4 T40 a program whose stages fit only so has the words a stage only
    reads of one memory, texel buffers' and folded uniform buffers', read through one binding of it ("Shared words";
    bench/vulkan/REPORT.md "VK4 T40": all 250 of `descriptorset_random.sets4`'s and `sets8`'s failures pass, and
    `descriptor_copy`'s). Left: written storage texel buffers take a binding each (sharing one would need the run's
    readback and one atomic type); a stage whose words of several memories still don't fit refuses its draws (said
    once); the variants are one per who-shares-with-whom (dEQP's few; a program that rebinds its views among many
    memories would make many, unmeasured); a whole memory bound read-only beside a write of it in one scope is copied
    whole into a shadow (its cost unmeasured: only programs past the limits share). Not done, not needed by what was
    measured: uniform texel buffers as r32uint textures (with sampled images, a copy whenever the buffer changes) and a
    set's inline blocks as one uniform binding (they fold and share instead). A texel buffer whose range overlaps
    another writable binding of its memory in a dispatch (bound writable then, or else a usage-scope conflict) was
    refused by WebGPU's binding aliasing (16 of `descriptor_copy.compute`'s texel buffer cases: "Writable storage
    buffer binding aliasing", the dispatch dropped; since VK4 T3 a read-only one is copied instead: "Usage scopes'
    leftovers" above); 122 `api.buffer_view.access.uniform_storage_texel_buffer` cases are NotSupported for
    `VK_KHR_extended_flags` (they ask `VK_KHR_maintenance5` too, offered since VK4 T24; not the without-format
    features, as this said before GD G5 offered them); sRGB and 64-bit formats aren't offered (64-bit ones as pairs of
    words, without their atomics).
  - [B] **Storage images read as textures' leftovers** (GD G4; vk/README.md "Storage images a stage only reads"; the
    out-of-context review of 2026-11-04; VK4 T37 took its invalid commands): a subresource read as a texture and written
    through a storage binding in one scope reads a copy of the image taken at the scope's start (`scope_reads`), but not
    through a view of another format than the image's (an alias texture) or of a plane: said once, left to WebGPU, which
    drops the submit; nor does such a read see what the scope wrote before a barrier inside a dispatch (a pass is cut at
    them). An array's packed copies go a layer at a time through two temporary buffers.
  - [B] **Storage images as words' leftovers** (VK4 T11; vk/README.md "Storage images as words"): a view past
    `maxStorageBufferBindingSize` (WebGPU's minimum is 128 MiB: a 4096x4096 `rgba16float` level, loaded and stored) refuses
    its draws and dispatches, said once (VK4 T37: the submit was dropped); a binding a part would draw them. A stage of
    many such images meets the storage and uniform buffers a stage has
    (refused, saying why, where it doesn't fit: `wg_bindings_fit`); two views of one image bound writable in one scope
    (WebGPU's writable aliasing, as "Usage scopes' leftovers"); a vertex stage reading a storage image the fragment stage
    writes stays refused (a second binding of the same image would take it); planes of multi-planar images aren't words; a
    shared image's flush has no test of its own; the words' and copies' cost on a real program is unmeasured (`rw.hook` shows
    it working, nothing in the images leans on it). With words, the formats Vulkan's storage doesn't need (sRGB, packed
    16-bit) become possible (`shaderStorageImage*WithoutFormat` are offered since GD G5: a variant per bound format).
  - [B] **Storage images' cases failing before T11** (VK4 T11: the same on a build without it, 27 of a sample): `robustness.image_robustness`'s
    out-of-bounds accesses (`sampled_image` of `1d_array` and `3d`, `storage_image` of `r32f`), and `memory_model.message_passing.ext`'s
    `atomicwrite` with an image as the guard (invocations seeing the guard but not the payload). Neither group is in the
    list, nor in `vk-main.txt`'s direct set (run them by name).
  - [B] **Bindings past WebGPU's** (VK3 L7a, vk/README.md "Bindings past WebGPU's"): what can't be advertised apart from
    what Vulkan counts with it is refused when a pipeline is made, saying why: a fragment stage's input attachments
    beside 16 sampled images (Vulkan counts them apart, WebGPU as textures; the device keeps Vulkan's 16 and 4: ANGLE's
    ES3 wants 16 texture units), texel buffers beside a full count of storage buffers that don't share a binding (above),
    more folded uniform buffers than the advertised (folding goes by the layout: a stage that sees another's folded
    buffers), binding numbers past WebGPU's 1,000 or on the driver's from the parameter table's 994 on (sets 3 and up
    share group 3: out of reach within the advertised limits, a guard). A program of four groups (sets 3 and up, the
    push buffer or device addresses in group 3) has a capture's and a storing vertex stage's pre-pass's bindings in a
    copy of group 3 at its free 995, 997 and 999 (VK4 T33, T40), and pulled vertices' bindings from 976 (VK4 T44), but
    [B] no room there for an attachment read's textures (T32's `wg_dst`, up to 9: the draw is refused, said once): those
    would need binding numbers group 3's slots and the pull's leave. maxPerStageDescriptorUniformBuffers is 14 (vkd3d's) only where 8 storage
    buffers are left beside the three folded ones, an adapter of 11 or more (VK4 T40): SwiftShader's and the M4's 10 keep
    13, D3D's 8 UAVs at 11_0 taking the eighth storage buffer.
  - [B] **Elsewhere**: the push buffer grows before a submit to 256 bytes a draw and dispatch, up to 256 MiB (a submit past
    ~1M draws with push constants past the immediates still wraps, with a warning).
- **Nodes 2 and up in one memory64 behind a second JIT arm** (bench/spike/memory/REPORT.md §6, VK4 T19). Memory 1 stays
  wasm32 (node 1, and on a Vulkan machine the renderer and window, behind today's arm). Nodes 2 and up, which an access
  reaches today only through the interpreter (2–17× node 0's time), would share one memory64 of up to 16 GiB, reached
  by a second arm. That access pays memory64's check and V8's base reload: M0.5's M4 kernels put that layout (D) at
  +26–32% per access on macOS, where memory 1's accesses carry no check. Each load and store on such a machine would
  also carry another copy of its body (one arm: +15% wasm bytes). Only a machine with more active pages than memory
  0 and node 1 hold meets node 2: past ~7 GiB, ~5.5 GiB with Vulkan. Memory 0 as one memory64 was measured and set
  aside: ~+15–20% on the userspace benchmark on macOS (`--wasm-enforce-bounds-checks` as the stand-in), since V8 checks
  each memory64 access.
  **Measured to matter on Vulkan** (2026-11-09, `bench/boot/REPORT.md` "Where a busy vCPU's time goes on the Mac, and
  the compile threshold there"): Godot's GI demo in the editor with 6144 MiB of RAM reaches memory 2, and ~16% of its
  busy ticks go to the helper chain (`jit_exec_mmu`, `ldst::exec`, `Mmu::miss`, `spill_load`); at 4608 MiB it took
  14% fewer busy ticks for the same start. So a Vulkan machine given more than ~4.5 GiB pays it with an ordinary program; the
  page's default is 2048 MiB, and 6144 was only `bench/vulkan/godot.ts`'s and `t23.ts`'s default, so it's a cost for
  those who choose that much RAM, not a default one.
  Options short of memory64: `INLINE_SPILL` 2 on Vulkan machines only (another copy of each access's body: ~+15%
  wasm), a layout with node 1's RAM in memory 1 and the arena and window in a later memory (the window's accesses would
  then take the helper; how many a Venus program makes is unmeasured), or capping a Vulkan machine's RAM or warning past
  ~4.5 GiB on the page. The user's call.

## Parallel SMP (M7; measurements in `bench/boot/REPORT.md` "M7 loop 8")

- **Parallel `make`** as a scaling workload: `images/debian-tools` has gcc and make now, but no harness boots it at
  N vCPUs with a source tree and times `make -jN`; the 4-vCPU `go build` loop from `debian-go.waarm64snap` is the
  compile workload in use meanwhile.
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

## The page (M8 phase A; [frontend.md](frontend.md))

- **What the i18n checks can't see** (tools/i18n-check.ts, [i18n.md](i18n.md) "Checks"; 2026-11-02, when the
  headline-and-line errors were split and the AST rules added). Each needs data flow across functions or modules, which
  the checker doesn't have (it reads one file's syntax, no types):
  - **Errors that are only a cause.** A `MsgError` whose words are a sentence ([The machine is off. Start it first.](ui:network:net-live.off)) is
    a cause; it needs a headline where it reaches the user unwrapped. About 80 such keys are thrown (`folders-page.*`,
    `disks.*`, `usb-live.*`, `local-net.*`, …); most are wrapped by their callers (`new MsgError('…couldn't …', …, {
    cause: e })`), and only the network's four were audited and given one (`net-live.notConnected`,
    `net-nodes.notLoggedOut`). Telling which reach the page bare means following each throw to where it's shown.
  - **Parameters of a key that comes from elsewhere**: a function's parameter or a field (`t(d.name)`,
    `msg(m.key, m.params)`, the worker's `failure(problem, m)`), or another module's constant. The calls whose key the
    file names (a literal, a conditional, a map or constant of the file, by scope) are all checked.
  - **A `.message` shown at a distance**: the rule follows a caught error's `.message` to a call, a parameter, the DOM or
    a component's state in the same expression; one stored in a field or posted across a worker (`web/usb.ts`'s
    `usb-state` `message`) and shown later isn't followed.
  - **Copy in lower case without a sentence's end** isn't flagged: the code's lower-case phrases without one are
    developers' (15 of them in the renderers, 2026-11-02), and copy ends with a period.
- **Firefox** (not a target; 2026-10-15): Debian boots on the page in Firefox 157 (headless, the dev VM)
  once qcow2's compressed clusters stopped relying on Chromium's DecompressionStream handing over
  its output before the junk error (`web/qcow2.ts` `inflate`) and SpiderMonkey runs without the
  compile worker (`web/app/worker.ts`). Open: SpiderMonkey's process holds the code of ~16,350 live wasm modules
  (64 KiB each, it seems; then `new WebAssembly.Module` throws "out of memory"), every vCPU worker compiles its
  own copy of each module, and the code cache has no module cap: a long or code-heavy run (the user's Arch
  desktop, at login, with the compile worker on) dies in `jit_install`. The fix would be a
  `VmConfig` cap on modules per cache epoch (an ABI change) the host sets on SpiderMonkey only.
  Private windows have no OPFS (`getDirectory` throws SecurityError): the page runs with its store and overlays in
  memory (machines.md "Without OPFS"; Debian opened through Open disk… boots, 2026-11-03); what reads OPFS from the page
  directly (kept snapshots, the overlays' sizes, folders in the browser) still throws there.
  Unmeasured: SpiderMonkey's speed. Driving it: Playwright's `firefox.launch({ channel:
  'moz-firefox', executablePath: '/usr/bin/firefox' })` (WebDriver BiDi, zypper's Firefox; in a cloud session
  `npx playwright-core install firefox`, Playwright's own Firefox, plain `firefox.launch({ executablePath })`, a
  private window through the pref `browser.privatebrowsing.autostart`) with
  `firefoxUserPrefs: { 'memory.phc.enabled': false }` (PHC's stack walks hit the VM's
  SME-without-SVE in libgcc's unwinder: SIGILL) and `env: chromiumEnv()`.
- **Page tests on the build** (2026-10-24, bench/boot/REPORT.md "The page under Vite"): the page tests that only drive
  `/web/app/` could run on `vite build` behind Vite's preview server (built once per run, ~1 s), the shipped bundle,
  and ~150 ms sooner a machine start (529 vs 704 ms for Buildroot's); the harness pages (`tests/browser/`, `bench/`)
  and in-page imports (`import('/web/app/store.ts')`) stay on the dev server. Two servers in a suite; unmeasured on a
  whole CI run. `npm start` also rebuilds the page every time (~1 s: its output carries the commit); skipping it on
  unchanged inputs would need the stamp in the key.
- **Machines as the unit, loose ends** ([machines.md](machines.md)):
  - **The exit's numbers weren't taken** (the user's call, 2026-10-18: low relevance for now, and they'd go stale
    beside unrelated optimizations). In Chromium 153, `bench/boot/REPORT.md` with JSON: a restore whose pins match
    (RAM and state only) against one that forks; a stored disk's import (Debian; the cloud: ~94–140 s, 1,043 MB); a
    merge; a kept snapshot's size and save time against a downloaded one's; the ramdisk's fio against one buffer
    (the chunks' map lookup per request: kept if within noise). The cloud's boots written in place (221 s) and on a merged disk (290 s)
    were slower than its overlay boots (115–156 s), one run each on shared hardware; the user's boots of stored and
    merged disks by hand showed nothing like it. If anyone relies on in-place disks for speed, time those boots too.
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
- **Keyboard layouts' loose ends** (the setting: [frontend.md](frontend.md) "The keyboard layout"): GNOME and
  KDE untested; the console keymaps (`vc`) other than `de-latin1` and `pt-latin1` were picked from kbd's files and
  kbd-model-map, not typed on; non-Latin layouts (a
  second, toggled layout and its `XKBOPTIONS`) not offered; `detectLayout`'s signatures are from the layouts' charts,
  checked against Chromium on one (US) keyboard only; a Mac's ISO keyboard swaps `Backquote` and `IntlBackslash` in
  Chromium's codes, which the guest then sees swapped.
- **The ready marker is a per-machine regexp** over the serial output (Debian: agetty's
  `login: ` at a line's start). A guest that prints after its prompt, logs in automatically or
  has no serial getty would need its own. systemd 254+ guests on firmware machines say READY=1 on the notify socket
  (devices.md "vsock"), and the guest agent's HELLO is a sign too (on by default, systemd 256+); a guest with neither
  (no systemd, an older one) still depends on the marker. The agent's DESKTOP (devices.md "The desktop's state")
  says when a compositor or an X server is up, but only to the tests (`body[data-desktop]`): the user chose not to show
  it, and the boot card and the state line don't use it. Not built: a compositor's first cursor or 3D context on the virtio-gpu.
- **After phase B (the page's UEFI path):** a lone Esc takes ~2 s on the serial terminal and PageUp/PageDown aren't decoded by
  EDK2's terminal driver, and a fast run of arrow keys can lose bytes (the PL011's FIFO against a guest that polls;
  frontend.md "The serial terminal"); Debian's GRUB waits 5 s on every
  boot; loading a changes file also resets the variable store (the file doesn't carry it).
- **The Keyboard Lock** in full screen is checked by hand only: headless Playwright's keys
  bypass the browser's shortcuts, so no test sees Ctrl+W reach the guest.
- **Sound by hand only** ([audio.md](audio.md) "Tests"): the user confirmed playback and recording work (2026-10-12);
  no test can see the rest, because headless Chromium runs an `AudioContext` without a gesture (even with
  `--autoplay-policy=user-gesture-required`), never hides a page and grants its fake microphone without a prompt. Still
  to check in a headed Chromium: the real autoplay path ([Sound: click to hear](ui:sound:Sound.summary.waiting), then a click); a hidden tab's wake (the
  worklet's notify, the sink's 5 ms timeout; if a hidden tab throttles the device worker, the wait's timeout is the one
  to look at, the notify comes from the audio thread); the microphone's prompt at the guest's first recording, the
  browser's indicator going off when it stops and a refusal's hint (e.g. on the desktop guest `pw-record /tmp/a.wav`,
  `pw-play /tmp/a.wav`, with and without Raw microphone); a video in Firefox on the desktop guest
  (`avsync.html?v=sintel.webm`) in sync by ear (the measurement is -17 to +20 ms after Firefox's first 4 s; decoded on
  the host since video V2, -10 to -13 ms median: graphics.md "Video's measurements").
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
  the guest's add up); unmeasured which. The horizontal and high-resolution wheels are unchecked in a compositor: that
  sway and Firefox on the Arch desktop guest scroll a touchpad smoothly and sideways (`libinput debug-events` shows
  `POINTER_SCROLL_WHEEL` with `v120` values off 120). The touchscreen's contacts have no size or pressure (`ABS_MT_TOUCH_MAJOR`, `ABS_MT_PRESSURE`), and a pen is the tablet.
  Checked on headless Chromium's synthetic events and on Debian's evdev, not on a real touchscreen or a desktop's
  compositor (GTK and Firefox on the Arch desktop guest).
- **The page's lint suppressions left** (tools/lint/eslint-suppressions.json, 4 on 2026-11-11 after the frontend
  refactor's phases 7 and 8 took it from 130; [frontend-code.md](frontend-code.md) §7): the 4 `vm!` of the machine
  worker's status and keyboard timers and its JIT limit (worker.ts, `no-non-null-assertion`), kept: the module's `vm`
  is set before they start and they stop with the run, beside the run loop (hot), where a check that can't fail is a
  branch for nothing. Passing the booted `vm` to them instead is the fix, if the run's code is ever reworked. Settled
  with a disable that says why: environment probes (`navigator`, `location`, `document`, Web Locks: absent in Node's
  tests), flags that change across an `await` or in a callback, the effects' tracking reads, and the data tables
  (keymaps.ts, keyboard.ts's layouts, osk-layout.ts's builders).
- **The screen's cursor styles** (areas/screen-view.ts): the CSS cursor (`showCursor`) and the lock cursor's box
  (`placeCursor`) are still set on the elements, as they follow the guest's cursor messages; through state they would
  render a frame later. Worth it only measured (a cursor message's cost, a lock cursor's lag).

## Snapshots (M8 phase C, snapshots lane; [platform.md](platform.md) "Snapshots", [machines.md](machines.md) §5)
- **A suspend Linux aborts after its devices' suspend** (a wakeup event before SYSTEM_SUSPEND; `systemctl suspend`, a
  desktop's idle suspend) resets every virtio device in its resume without a SYSTEM_SUSPEND, so the reset isn't
  carried ([devices.md](devices.md) "Across a suspend") and virtio-gpu stops as before. Not seen yet; only a guest's own
  suspend can hit it since snapshots no longer put the guest to sleep (2026-11-13).

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
- **The network after a restore, not run end to end** (devices.md "The network after a restore"): the guest agent's
  renewal (busctl's RenewLink to networkd from inside the unit's sandbox) is run on Debian, the page's waiting and the
  flap with fakes; no test restores a snapshot with a live connection (a tailnet, the local helper) and watches the
  guest take the new lease: the network tests drive the guest through `tests/browser/netguest.html`, which has no
  snapshots or agent. NetworkManager's `nmcli device connect` is tested with a fake nmcli only.
- **The guest's clock after a restore**: the guest agent sets it (docs/frontend.md "The guest's clock": TIME at its
  HELLO, after a save's pause, at the host's own sleep; the AGENT track, 2026-11-13), and the virtio-rtc device. What's
  left:
  - **virtio-rtc against a running driver.** Checked against the driver's message formats only: Debian's kernels (up
    to 6.17 in trixie-backports) leave `CONFIG_VIRTIO_RTC` out. In the dev VM: our kernel (`images/linux`) with it
    on, the guest's `/sys/class/rtc/rtc*/since_epoch` and its PTP clock (`phc_ctl`, chrony's `refclock PHC`) against
    the host; the Arch desktop guest's kernel, if it has it.
  - **virtio-rtc's cross-timestamps** (READ_CROSS with the ARM virtual counter: the reading and CNTVCT at one instant,
    which the device worker would need the core's clock for) and **alarms** (an RTC alarm that wakes a suspended
    guest: `rtcwake`).
  - **Guests without the agent** (no firmware: the direct-boot machines; no systemd 256: Alpine with OpenRC; the agent
    turned off) lag as before. A link flap for timesyncd (a virtio-net `VIRTIO_NET_F_STATUS` down and up on restore:
    Debian's networkd and timesyncd re-sync at once on it; networked guests only) or the agent from a tools disk
    (plans/agent.md) would cover them.
  - **A step, not a slew:** the agent sets CLOCK_REALTIME at once (past 50 ms off). A guest with chrony or timesyncd
    sees a step it didn't make; none was seen to mind on Debian (`tests/page-clock.test.ts`), but a long-running
    guest whose NTP client disciplines the clock may log it.
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
- **fflate elsewhere in the emulator** (the user's idea, 2026-11-09; fflate came in for Vulkan's shader store, VK4 T49
  follow-up: bench/vulkan/REPORT.md, vk/README.md "The shader cache"): where the emulator compresses through the
  platform's streams, a synchronous codec, another level or a better ratio might help. Candidates: the snapshot file's
  codec 1 (`web/snapshot-file.ts`, CompressionStream's deflate-raw, asynchronous; codec 2, the core's LZ, won the
  default by speed: bench/boot/REPORT.md "M8 phase C loop 4", so a level of fflate's would be a size option, not the
  default); qcow2's compressed clusters, read through DecompressionStream (`web/qcow2.ts` `inflate`, the only
  asynchronous part of virtio-blk's path, with web/inflate-pool.ts's workers: docs/devices.md) and written through
  CompressionStream (`web/qcow2-write.ts` `deflate`: CompressionStream has no window setting and QEMU inflates with a 4 KiB window, its
  comment says; whether a codec with one changes what a cluster can be, to check); the guest agent's gzip
  (`web/app/guest-agent.ts`).
  To measure, each place: the ratio, the speed against CompressionStream/DecompressionStream in Chromium (on its
  thread and with its stream overhead: per-call cost on small inputs like a 64 KiB cluster may matter more than
  throughput), and whether being synchronous matters there (a sync inflate in virtio-blk's request path would drop the
  async step and maybe the pool; elsewhere it may not). Nothing implemented.

## Network (M8 phase C, networking lane; [plans/networking.md](plans/networking.md), [networking/tailnet.md](networking/tailnet.md), [frontend.md](frontend.md) "Network")

- Loose ends: the menu's login-URL and approval states are `viewOf` unit tests only (no Chromium test against headscale); the page's Buildroot machine has no `network` entry (its kernel has virtio-net, but nothing brings the interface up); IPv6 to the internet through an exit node, and a real Tailscale exit node with its own nameservers, are untested; router advertisements repeat every 60 s only on a port backend; the network tests ran in cloud sessions (Chromium 141) as well as here (153), so recheck with `scripts/ci-net.sh` in the dev VM after a change.
- The Debian tests (`net-guest`, `page-network`, `net-tailnet`) take ~4 min: they run in `scripts/ci-net.sh`, not `scripts/ci.sh`.
- **A room without direct paths, the rest** ([networking/rooms.md](networking/rooms.md): the cause of the user's tries of
  2026-11-11 was ungoogled-chromium using no UDP for WebRTC, which the status line now says): a blocked browser still
  makes a connection for each offer, and its peers keep offering, every 30 s doubling to 5 min (it could go relay only
  and say so in its `hello`, so the others stop too); the menu could say how many active connections are direct (the
  peers' `path` is there), for the cases gathering does work but ICE doesn't (a router that doesn't hairpin, mDNS
  dropped between two machines of one LAN).
- **Rooms' loose ends** ([networking/rooms.md](networking/rooms.md); from the out-of-context review of R2–R3, 2026-11-10):
  `peer_of_rtc` scans every peer for each data-channel message, and `tick` counts the open channels for each peer
  (~1,000 lookups a packet at the 1,024-peer cap with 64 channels; unmeasured: a map from rtc to peer would end it). A
  failed offer's backoff is skipped when the peer goes idle (the next packet offers at once). A public room's name
  typed by hand is matched by its bytes (an NFC and an NFD "Café", or another case, are other rooms, silently; the page
  could NFC-normalize what it writes into a link). `isPrivateRoom` labels any ID ending in a hyphen and 26 base32
  letters as private, a public name typed that way too (cosmetic). The tests' Nostr relay waits forever on a frame
  whose declared length never comes, and keeps every event with `keep` on (fine for its tests).
  From the review of 2026-11-12: an outsider who sees lookups to a node (a subscription to kind 26354 with no tag
  filter, on the link's public relays) can flood its tag through **every** relay of the link with distinct junk past
  each relay's 128-a-second budget, and keep members' lookups to it out for the rest of that hour (copies and a flood
  through some relays are handled). A cheap check before the X25519 would end it: a MAC under the room's lookup key
  over the content (a change of the lookup's form), or NIP-13 proof of work on lookups; relays' own rate limits help
  meanwhile.
  The unasked handshakes' trial budget (16 a second) is open to anyone with a node's name, not only members: an
  IKpsk2 initiation needs only the responder's public key (the pre-shared key enters at the response), so fresh keys'
  valid initiations are answered, charged and kept on trial 20 s each, and members' unasked handshakes (a member
  that still has a session after we forgot it, a peer reloading with packets in flight) are refused while that goes
  on. Mitigations: charge the budget only once a trial confirms (its data decrypts, which takes the pre-shared key),
  and cap the trial peers not yet confirmed apart, dropping the oldest first.
  Another tab's ephemeral room connections are invisible to this one (they live in that page's memory): Delete or New
  name of a stored connection whose `waarm64-room` entry another tab's ephemeral connection shares (made with "another
  connection's key") forgets the entry, as `sharesKey` can't see that one, and its next start makes a new key under
  the orphaned entry, which nothing deletes later (the key changes without the user asking); and a key pasted in one
  tab from another tab's ephemeral connection isn't found as that one's (`holderOf`), so it gets an entry of its own
  (the key's lock still holds between them, named by the key). A shared registry of ephemeral connections' entries
  (a BroadcastChannel census, or the entries' users counted in `waarm64-room`) would close both.
- **Several adapters' loose ends** ([networking/adapters.md](networking/adapters.md)): two tailnets both route
  fd7a:115c:a1e0::/48, so over IPv6 only the earlier adapter's peers are reached (per-peer routes as tailcat's would fix
  it, but a tailnet can have far more peers than a router advertisement carries in one piece, and each joining peer
  would be an advertisement); routes of a client or connection that went aren't withdrawn (they lapse in 30 minutes,
  through a gateway that no longer answers).
- **IPv6 out's loose ends** ([networking/adapters.md](networking/adapters.md) §4 "IPv6 out", web/reach6.ts):
  - The real probe targets answering is checked by hand only (an exit node on the Mac, testing.md): the dev VM has
    no IPv6, so the tests' up case runs against `tests/net/resolver.ts` on a temporary address, and a Tailscale exit
    node reaching IPv6 out isn't tested at all (the Podman peer has none).
  - tailcat's lease names Cloudflare's resolvers only (1.1.1.1, 1.0.0.1, 2606:4700:4700::1111): where Cloudflare is
    blocked the guest has no DNS, though the probe now asks three operators. A second operator's in the lease would do.
  - The Network menu doesn't say a connection is IPv4-only.
  - `bench/gpu/firefox-load.ts`'s tailcat mode still drops the guest's IPv6 default and pins resolv.conf and
    gai.conf by hand; no longer needed, drop it at its next run.
- **The local helper's loose ends** ([networking/local-helper.md](networking/local-helper.md), waarm64-net's own repository):
  - **Never run on Windows** (nor its install lines in PowerShell): whether gvisor-tap-vsock's DNS forwarder follows the
    host's resolvers there (it asks Go's `net.Resolver` and forwards other types to `/etc/resolv.conf`'s servers,
    which Windows hasn't), and what Defender and SmartScreen make of an unsigned binary fetched by `Invoke-WebRequest`.
  - The install lines haven't run against a real release: the repository is private until L4. The Linux line ran
    against a `file://` copy.
  - `go install` waits on #745 landing in a gvisor-tap-vsock release (the `replace` goes then). If #745 stalls, a fork of
    ours with the module path renamed would bring it back.
  - The guest can't ping the internet over IPv6 (#745's ICMP forwarder is IPv4's only).
  - Two `local` adapters both offer a default route: the menu says so, nothing picks one.
  - **Machines with the same MAC share an address on one helper** (its network knows a guest by its MAC, and the
    switch's table flips between their links): new machines have MACs of their own since 2026-11-03, but machines made
    before all have `52:54:00:12:34:56`, a copy keeps its machine's MACs, and an imported definition without MACs gets
    the default. A way to give a machine new MACs (the Machines page's Network tab), or new ones on a copy, would cover
    them (guest-visible: the guest's leases follow the MAC).
  - Firefox's and Safari's handling of `ws://127.0.0.1` from an https page is unchecked (never a blocker).
  - (Low priority, the user's idea, 2026-11-03) One `local` connection on several machines at once over one WebSocket,
    rather than a socket per adapter. It needs connections modeled as exclusive or shared (a Web Lock holds each now,
    docs/networking/adapters.md §2.3) and a UX that stays clear. The helper already puts every socket on one switch, so
    several machines can already share its LAN, each with a connection of its own.
- **The Rust Tailscale client's loose ends** ([networking/tailnet.md](networking/tailnet.md) "Tailscale"):
  - Subnet routes: an adapter that isn't the default way out learns a new IPv4 subnet route only at the guest's next
    DHCP renewal (option 121; IPv6's router advertisement is at once).
  - A tailnet with IPv6 addresses only gets no lease (the gateway's DHCP needs an IPv4 address: `leaseFrom`).
  - IPv6 extension headers aren't followed by the filter (such a packet is judged by its first next-header).
  - MagicDNS answers A and AAAA only (no PTR for tailnet addresses, no SRV/TXT from extra records; other types
    forward); its TCP side (`dns_tcp.rs`) and DNS-over-HTTPS fallback (Cloudflare, Google or
    Quad9 by `fetch`) are unit-tested only (the cloud has no DNS out; no guest test asks a name whose answer is
    over 512 bytes); a truncated answer over TCP from a resolver that isn't well-known goes back truncated (no TCP
    client in the module to ask it again).
  - The exit node's DNS goes as UDP to the tailnet's resolvers or 1.1.1.1, not to the exit node's peerapi DoH as Go's
    does (it would need a TCP client in the module): check against an exit node that blocks plain DNS.
  - Tailnet Lock is refused, not supported: a large feature, worth a track only if someone needs it.
  - Timings against Tailscale's own servers are unmeasured (Headscale's are in docs/networking/tailnet.md
    "Findings"): an auth key's ephemeral node there is where to look.
  - The module in the device worker instead of its own (one worker and one hop less): only if its cost there is
    small; the worker spends 3.1 core-ms per Mbit/s (bench/net/REPORT.md "T6"), unmeasured inside the device worker.

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
- **The game pad on real hardware:** works on the user's own pad and host, read by Chromium in the guest, rumble
  included (2026-11-07). Still to try: a DualSense and a pad without the standard mapping; check that Chromium updates
  a pad's state at the feed's 8 ms, and that a game in the guest (SDL) and Firefox in the guest map it as a game pad.
- **The game pad isn't remembered:** a machine doesn't keep its pads, so each start attaches them again from the
  menu. A `Gamepad` has no identity past its `id` string and its index, and the browser lists it only after a button
  press, so an *attach at start* entry would wait for that press.
- **Serial adapters the host's driver holds** (Linux's `ftdi_sio`, `cp210x`, `cdc_acm` without a udev rule): WebSerial
  could feed a virtio-console port instead of the passthrough (a multiport console: the agent's was, until it moved to
  vsock, plans/clipboard.md §2). Not built.
- **A WebHID device across Suspend:** Snapshot and Suspend unplug every device first. The emulated HID device's
  state is small (idle rate, last reports), so it could be saved and its `HIDDevice` opened again at resume, keeping
  a game pad plugged in as far as the guest knows.
- **Carry-over and sequence numbers:** a cancelled IN's data goes to the next read on that endpoint, which a
  protocol that cancels, then expects only fresh data with sequence numbers, would notice. None seen yet.

## Clipboard sharing ([clipboard.md](clipboard.md))

- **The agent's channel over vsock, not measured** (the AGENT track moved it there, 2026-11-13): its rate (4 KiB
  packets, a completion each, as the console's buffers were; ~0.8 MB/s then) and `systemd-analyze security` without
  `PrivateNetwork` and with `CAP_SYS_TIME` (3.8 on the console). And what vsock would allow and wasn't taken: a
  connection per transfer (vsock's credit in place of the frames' CREDIT/MORE), and ports for plans/agent.md's other
  jobs.
- **The agent's size past `no_std`:** 168,320 bytes (132,696 before the screen's size, BETTERAGENT), ~82 KB gzipped then (clipboard.md "What it costs"). What's left is
  mostly its own code (~65 KiB, `session.rs` with X11's client inlined into it), musl's `malloc` and startup (~10 KiB),
  and `core`'s formatting (~12 KiB), which `core`'s own panics (bounds checks, `str` slicing) keep linked whatever the
  agent's own `format!`s do: only `-Zbuild-std` with `panic_immediate_abort` (a nightly, or `RUSTC_BOOTSTRAP` on the
  stable toolchain) would drop it. Rewriting the agent's ~20 `format!`s saves ~2–3 KiB alone; not done.
- **Restarts read the binary again:** each of the unit's restarts (at most 5 in 10 minutes) gunzips it out of fw_cfg
  anew. Keeping it across restarts (outside the unit's own tmpfs, or a unit that outlives the agent) would save that.
- **Two compositors for one user** (sway on two VTs): the session child takes the first `wayland-<n>` that accepts.
  Which socket is the active session's isn't known without reading the session's processes' environment
  (`WAYLAND_DISPLAY`), as X11's display already is.
- **A paste cut by a restore:** the new connection's HELLO (a restore mid-paste) ends the guest program's pipe, so it gets what
  had crossed, truncated; a pipe has no way to say "failed". An X11 requestor under INCR is the same.
- **No `splice`:** the child reads and writes the connection's bytes in 64 KiB chunks between it and the Wayland or
  X11 pipes (they cross the parent anyway). And a page→guest answer that the guest's reader dropped is a MORE 0 the
  page honours, but what the page already sent (at most the credit, 4 chunks) still crosses.
- **sway restarted at boot, seen twice** in the Debian sway image's page test: the boot's first sway ended within
  seconds and getty logged the user in again (the agent followed). Not seen since the image's profile logs how sway
  ends (`/tmp/sway.log`, `== sway ended: N`): if it comes back, that line says why.
- **The plan's optional step 6** (plans/clipboard.md §6; each needs the user's OK): spice-vdagent's port
  (`com.redhat.spice.0`, a second port on the same device, for Xorg and GNOME guests that have it), GNOME on Wayland
  through the portal's Clipboard interface (a RemoteDesktop session the user consents to), and other agent jobs in the
  same binary and connection (a ready signal: plans/agent.md; the BETTERAGENT track's).
- **A template saved or suspended before its agent renewed it** (the BETTERAGENT review's finding 4): its snapshot or
  suspended copy isn't flagged, so the renewal owed is lost; the page's save could carry `template: true` while the
  run's link still owes RENEW (`web/app/worker-snapshot.ts`'s header).
- **The screen's size on Xorg's modesetting over virtio-gpu, not measured** (devices.md "The guest's agent", "Under
  X11"): the agent's RandR is tested on Xorg's dummy driver only; the Debian test image has Xvfb, whose RandR can't set
  a mode. A user-made mode on KMS (virtio-gpu takes any size up to its maximum) and the probe after the display event
  are the parts to see on a guest with Xorg. GNOME on Wayland unmeasured (expected to follow the display event itself, as a user's KDE session does). Under X11 a
  desktop's own daemon (KDE's kscreen) may set the mode too: the agent asks for the same size, so they agree.

## Tests and tools

- [B] **dEQP-VK's four processes a machine** (VK4 T36, bench/vulkan/REPORT.md "VK4 T36"): since T36 `JOBS=4` hangs no
  case and runs the 2,032-case slice in 143 s against 162–163 at 2 (−12%, one machine of 1,536 MiB). `tests/page-deqp-vk.test.ts`
  takes 2: at 4 the browser peaked at 6.1–6.3 GiB a machine (5.6–5.7 at 2), and `scripts/ci-deqp-vk.sh` runs two
  machines under 14 GiB. Worth it once a `--full` run at 4 is seen under the cap (its peak measured), or
  with the cap raised.
- **`tests/page-copy-edit.test.ts` failed twice in `scripts/ci.sh`** (2026-11-06, VK4 T32's run; 2026-11-08, VK4
  T40's, one of four; passed alone at once, three times the second): "words changed where they are shown…" got an unexpected list of highlighted elements
  (`BUTTON[title]`, `SUMMARY[aria-label]`…) where it expected fewer. Not traced: likely an element still rendering when
  the test reads them, under the full run's load.
- **`scripts/ci.sh`'s JS step runs close to its cap** (2026-11-04, GD G4's and the core review's #5 runs; the cap was
  10 GiB then, 11 GiB since, CLAUDE.md): three
  runs of nine were OOM-killed in `npm test` (one on a healthy host, two while the Mac's GPU was wedged), the others
  passed. Peaks seen by a watcher: `tests/boot-node-litmus.test.ts` 3.1 GiB, a native test binary under `target/`
  2.6 GiB, the TSan `litmus_parallel` run 1.7 GiB, Chrome renderers up to 2 GiB; they overlap by chance. Either lower
  the peak (what boot-node-litmus holds: its guests' memories at once?), keep the heavy native runs out of `npm test`'s
  concurrency; the cap was raised to 11 GiB on 2026-11-04, so watch for OOM kills there again.

- **`baremetal_parallel_through_snapshots` failed once under `scripts/ci.sh`'s load** (2026-11-03, VK4 T16–T17's run;
  no core change): `smp: exit 5 (0x0) on vCPU 0 after 2016 steps`, the test past 60 s where alone it takes 2.4 s; it
  passed alone 5 times and in the next full run. Again 2026-11-12 (a page-only change; `after 2740 steps`, while an
  `npm start` built in the same checkout). A timing assumption in the test or the SMP snapshot path, unknown.
- **`tests/page-clipboard-ui.test.ts`'s toolbar test times out under `scripts/ci.sh`'s load** (2026-11-08, VK4
  T49's run; again 2026-11-10, PERF loop 4's; no page change either time): `page.waitForFunction` past 30 s in
  `guestReads` (line 51: the terminal never showed the guest's read). It passed alone each time (27.6 s the second: at
  the edge of its 30 s) and in the next full run. A wait that assumes the guest's pace, likely.

- **THIRD_PARTY.md from THIRD_PARTY.json** ([third-party.md](third-party.md)): a CI job or GitHub workflow that writes
  the Markdown (`node tools/third-party.ts --markdown`) whenever the JSON changes, if a readable page is wanted again.
- **The About pane's crates are the ones THIRD_PARTY.md named**: the tailnet client's direct dependencies and a few of
  theirs (`rust-net-ts`), and Rust's standard library as one row. `cargo metadata` for `net/ts` on wasm32 resolves 165
  crates (proc macros and build-only ones among them, so fewer are linked); the core has none. A generated listing of
  every crate linked into `ts.wasm` and `waarm64_core.wasm`, with each one's license text (as `VENUS-LICENSES.txt` and
  Vite's `THIRD-PARTY-LICENSES.md` do for theirs), would make the attribution complete.

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
- `coremark_vm_jit`: pass a fixed iteration count through init's arguments so a run can't fall
  under CoreMark's 10 s rule.
- The PC-sampling profiler samples once per chunk (32K steps).
- `performance.mark`/`measure` around compile, instantiate, device I/O and boot phases.
- `core/fuzz`: `Mismatch::key` is dead code in the libFuzzer target build (a warning, not in CI).
- Guest images: `images/build.sh alpine` can't run on the arm64 VM ([images.md](images.md)).
- **Alpine's package pins drift:** the container is pinned by digest but `apk` reads the live repository, which keeps
  only each package's latest build, so a pinned version that leaves it breaks the build (2026-10-02 `openssl-dev`;
  2026-11-13 `perl=5.42.2-r1` in `KERNEL_TOOLS`, bumped to 5.42.3-r0; the user: "we often have to update alpine
  pins"). What still reads the live repositories: alpine-user's `xz`, `lua5.4`, `sqlite` and the build tools of
  `linux*`, `litmus`, `alpine-gl`, `alpine-virgl` (docs/images.md "Gotchas"). Ways out, cheapest first: build those
  tools in Debian's container on snapshot.debian.org as `edk2` and `buildroot` already do (dated, so pins never
  vanish; the guest content stays Alpine's); or keep the pinned `.apk`s, checked by hash, in a store we host. A check
  of every pin against the live index (`apk policy` in `alpine:3.24`) finds the next breakage before a build does.
- `images/Containerfile` and `images/alpine/user/waarm64-user.start` still cite PLAN.md sections
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
report it. Nothing has been filed. (Vulkan's are [C]: they wait for the user.)

- **Mesa, virgl's VA-API driver offers I420 and YV12 decode surfaces** ([graphics.md](graphics.md) "Video's design"):
  `virgl_is_video_format_supported` is `vl_video_buffer_is_format_supported`, which only checks that the planes'
  formats sample and render, so `vaQuerySurfaceAttributes` lists NV12, YV12 and I420; FFmpeg's
  `vaapi_decode_find_best_format` then takes I420 for H.264 and VP9 (yuv420p), and Firefox's VA-API path (NV12, YV12,
  P010, P016 only) falls back to software ("Unsupported VA-API surface format"). Real drivers offer NV12 (and P010/P016)
  alone for decoding. Fix: virgl answers decode entrypoints with NV12/P010/P016 only. Seen with Mesa 26.2.4, libva
  2.24.1, FFmpeg 9.0.2, Firefox 157. Our workaround: the `waarm64-va` package (`images/arch/waarm64-va/`), which goes
  away with the fix.
- **Mesa and virglrenderer disagree on virgl's video profile numbers** ([graphics.md](graphics.md) "Video"): the wire carries Mesa's `enum pipe_video_profile`, and Mesa 26.2's has dropped
  `MPEG4_SIMPLE`/`MPEG4_ADVANCED_SIMPLE` (and added HEVC 4:2:2/4:4:4 profiles) that virglrenderer's copy (`c8e3fc3b`)
  still has, so every later value (H.264, HEVC, VP9, AV1) means a different profile to each. The protocol needs its
  own fixed numbering.
- **Mesa's virgl AV1 decode loses three things** ([graphics.md](graphics.md) "Video's findings"; Mesa 26.2.4,
  `src/gallium/frontends/va/picture_av1.c`, `picture.c`, `src/gallium/drivers/virgl/virgl_video.c`): the VA frontend
  writes `refresh_frame_flags = 1` whatever the frame refreshes (a stateful host decoder needs it; waarm64 keeps its own
  slots instead); it sets `film_grain_target` in `vlVaEndPicture`, after `vaRenderPicture` has sent the frame's desc
  (virgl's `decode_bitstream`), so a host never learns the surface a grained frame is shown from (virglrenderer's
  host VA-API path writes the target, the guest shows the other surface; waarm64-va 2 works around it); virgl's
  `fill_av1_picture_desc` doesn't copy `lr_unit_size` (the shifts are copied). Repro: the guest's `ffmpeg -hwaccel
  vaapi` on an SVT-AV1 clip with `-svtav1-params film-grain=8` against its software decode.
- **Chromium (libyuv's SME kernels) SIGILLs on CPUs with SME but no SVE** (Apple M4 under Linux, e.g. a Lima VM;
  graphics.md "Video's findings"): reading a decoded `VideoFrame` (`copyTo`, a WebGL upload, `createImageBitmap`) faults at `cntd`
  in the prologue of a locally streaming function compiled with SVE (LLVM saves the vector length with an SVE
  instruction there). Seen with openSUSE's Chromium 153.0.8010.52 on aarch64; libyuv picks SME from
  `getauxval(AT_HWCAP2)`. Our workaround: `tools/nosme` as `LD_PRELOAD` for the tests' Chromium.
- [C] **Mesa, Venus's async present drops a present after a failed one** ([vk/README.md](../vk/README.md) "The guest's
  Mesa"; bench/vulkan/REPORT.md "VK3 L4e"): with no implicit fencing (virtio-gpu's case), `vn_wsi_present_async`
  (`src/virtio/vulkan/vn_wsi.c`, since MR 39283) returns the previous present's result; when that is an error it
  returns it for the next present, of any swapchain, and drops that present without handing it to the present thread,
  so its wait semaphores aren't waited, its image never reaches the compositor and its present fence never signals.
  A swapchain retired while its last present waits for slow GPU work gives the error (`VK_ERROR_OUT_OF_DATE_KHR`), so
  the new swapchain's first present is lost: mpv's window stays on its pre-fullscreen frame and `vo` waits forever in
  `drmSyncobjTimelineWait` under `pl_swapchain_destroy`. Seen with Mesa 26.2.5 (Arch's `vulkan-virtio`), unfixed on
  main as of 8598bb5c (2026-10-23); gdb stacks in `bench/vulkan/results/vk3/l4e/swiftshader-frozen-stacks.txt`.
  Repro: mpv 0.41 `--vo=gpu-next --gpu-api=vulkan` going fullscreen while its first pipelines compile (every first
  session on SwiftShader; on a warm host with waarm64's `?gpu=vkpipedelay=1500`). Fix: always hand the present to the
  thread, and report a deferred error only for the swapchain it came from. Our workaround: `VN_PERF=no_async_present`
  in the desktop image (images/arch/desktop-setup.sh), which goes away with the fix.

- [C] **Mesa, Venus hands back fd 0 for an opaque-fd semaphore export** (bench/vulkan/REPORT.md "VK3 L7.1b", "VK3 L7.2";
  backlog "Dawn in the guest's Chromium on Venus"): Venus's guest driver (`src/virtio/vulkan/vn_physical_device.c`)
  offers external semaphores as sync files only, but `vkGetSemaphoreFdKHR` with
  `VK_EXTERNAL_SEMAPHORE_HANDLE_TYPE_OPAQUE_FD_BIT` on a semaphore made with that export returns `VK_SUCCESS` and fd 0
  (`vn_GetSemaphoreFdKHR` assumes a sync file, its assert compiled out, and returns the payload's union), then -1: a
  descriptor the caller doesn't own. Chromium's own Vulkan device (`--enable-features=Vulkan`) exports such semaphores
  and its GPU process dies on "FD ownership violation". Seen with Mesa 26.2.5 (Arch's `vulkan-virtio`); repro:
  `bench/vulkan/semfd.ts` (ctypes in the guest, `semfd.py`). Fix: refuse the export at creation
  (`VK_ERROR_INVALID_EXTERNAL_HANDLE`) as the properties say, or back it with the DRM syncobj
  (`vn_renderer_sync_export_syncobj(…, false)`).
- [C] **Chromium (Tint's Metal path or Apple's compiler) hoists a lone subgroup ballot out of an `if`** (bench/vulkan/REPORT.md
  "VK3 L5", "VK4 backlog easy wins"): on the M4 (Chrome for Testing 153.0.8010.12 to 157.0.8103.38, macOS 26.6.2), a
  `subgroupBallot`, `subgroupElect` or `subgroupBroadcastFirst` that is the only subgroup operation in an `if (odd
  invocation)`, its value stored to a `var` used past the `if`, is computed with every invocation (a ballot 0xffffffff
  where 0xaaaaaaaa is right, the first invocation 0 where 1 is): if-converted as if it had no side effects. A store
  inside the `if` or a `subgroupAdd` beside it whose value is stored is right; an add whose value is unused or folded
  (`>> 31u`) isn't. Separately, `subgroupShuffleUp`/`Down` with a delta that varies across the subgroup are wrong
  there (WGSL asks the delta uniform, so that one is a WGSL rule, not a bug: Vulkan doesn't). Repro: `web/venus-gpu.ts`
  `subgroupsKernel(device, false)` in a page with `subgroups` requested. Which layer is at fault (Tint's MSL, Metal's
  compiler) is unknown: compare Tint's MSL output with hand-written MSL. Our workaround: the translator's anchor
  (`WGSL_SUBGROUP_ANCHOR`: the add in the three's operands, the shuffles by index) where the page's check finds it
  needed.
- [C] **Chromium's SwiftShader path keeps a loop's uninitialized `var` across iterations** (VK4 T49, checked in VK4's
  backlog easy wins): WGSL's § 7.3 "var Declarations" says a function-scope variable's lifetime "starts when control
  enters the variable's declaration" and that, created without an initializer, its initial value is "the zero value
  of the store type" (the uniformity analysis's table agrees: `var x;` is `V(0)`), so a `var` declared in a loop body
  is zero at each iteration. On the dev VM's SwiftShader (Chromium 155.0.8059.84) it keeps the previous iteration's
  value; the M4's Metal (Chrome for Testing 157.0.8103.38) is right. Repro (one invocation, binding 0 a storage buffer
  of 4 words): `for (var i = 0u; i < 4u; i++) { var v: u32; o[i] = v; v = i + 1u; }` writes 0,1,2,3, not 0,0,0,0
  (also with `var v: array<u32, 4>` indexed dynamically, and with `v` written under an `if` first). Which layer drops
  the zeroing (Tint's SPIR-V writer hoisting the `OpVariable` without a store at the declaration, or SwiftShader) is
  not told apart: Tint's SPIR-V for the repro (`tint --format spvasm`) would say. Report to Dawn (Tint) first. The
  printer relies on neither behaviour since VK4 T49.
- [C] **Chromium and macOS: one endless compute dispatch from a web page wedges the M4's GPU for good** (GD
  G4; `bench/results/local/godot-mac-g4b`): a dispatch whose loop never ends (Godot's SDFGI light loop, `i < light_count`
  read as 0xffffffff on Chrome for Testing 153.0.8010.12, whose indirect dispatches read clobbered immediates: fixed by
  153's release) kept the GPU at 100% with nothing to stop it. Neither Dawn (no device loss, no watchdog) nor macOS
  (Metal's command buffer timeout) ended the work; the browser's GPU processes stayed in state `E` (exiting), `kill -9`
  couldn't end them, the Mac throttled (the dev VM's CI with it), and only a restart freed the GPU. Seen on macOS 26.6.2
  (M4 Mac mini). Repro still to write: a page whose compute shader loops on a bound it reads as huge from a buffer
  (`bench/vulkan/imm-probe.ts` is the shape, its cap removed); run it only with the user there to
  restart the Mac. Two reports: Chromium (a page shouldn't be able to hang the GPU past a watchdog: Dawn's device loss
  on a timeout) and Apple (processes stuck exiting with their GPU work, and no recovery from it).
  Tools for a run that may do so (GD G4; not committed, `bench/results/local/godot-tools/`): `loop-cap.py` (the
  printer: every loop breaks after N iterations of its own; `vk/build.sh` after it, `git checkout
  vk/compiler/wgsl_print.c` and a rebuild to undo), `stall-guard-worker.diff` (`git apply`: each pass its own command
  buffer submitted in turn at the submit, its time to done logged, submits halted once one is 3 s late),
  `gpu-sampler.sh` (the Mac's GPU, load and Chrome's processes every 2 s); never `stall-debug.py` (it submitted passes
  before their submit's writes). Rules: nothing suspect on the M4 without the cap and the user there; after every Mac
  run, `bench/gpu/mac-leftovers.sh`; a Mac-only GPU failure is checked on the current Stable and Canary Chrome for
  Testing before it's taken for ours.
- [C] **Mesa: X11's same-GPU check fails for a DRM device that isn't on PCI** (vk/README.md "Presentation", the prime
  blit's buffers, shared since GD G7 at the cost of a copy a frame): `wsi_device_matches_drm_fd` (src/vulkan/wsi/wsi_common_drm.c) compares PCI bus info only, so
  on a virtio-mmio virtio-gpu (DRM_BUS_PLATFORM) Venus's device never matches the X server's DRI3 device and every X11
  swapchain takes the prime blit. Seen with Mesa 26.2.5 (Arch's `vulkan-virtio`) in our desktop guest. Fix: compare the
  DRM render node's major and minor (`VK_EXT_physical_device_drm`, which Venus fills from the virtgpu device) when the
  device isn't on PCI.
