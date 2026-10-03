# The JIT

Guest A64 → WebAssembly, as built (`core/src/jit/`: `mod.rs` the cache and dispatcher, `block.rs`
block and region formation, `emit.rs` + `emit/{float,simd,crypto}.rs` the emitters, `wasm.rs` our
own minimal wasm encoder). The host side is in [abi.md](abi.md) "JIT host interface"; what V8
makes of our code is in [v8.md](v8.md). Numbers are in `bench/interp/REPORT.md`.

**The invariant everything rests on: a deterministic run takes exactly the same steps, and prints
exactly the same console, with or without the JIT.** Every block call is equivalent to
`interp::steps` for the instructions it retires; anything the JIT doesn't do inline goes through
the interpreter's own code.

## Shape

- **Gadget style, as in v86:** inline wasm for what's worth it (ALU, branches, loads and stores
  through the inline TLB, FP on exact fast paths, NEON as SIMD128, crypto), and **helper calls**
  into the core for everything else. The generic helpers `jit_exec_flat`/`jit_exec_mmu(vcpu,
  insn, pc) -> status` run one instruction through the interpreter's `exec` on the block's bus
  (`interp::exec_at`, shared with the interpreter); narrower helpers exist for load/store slow
  paths and system instructions. Helpers return 0 (retired) or 1 (exit pending), and the code
  returns at once on 1.
- **Faults and exits:** a helper records the exception in the per-vCPU JIT state
  (`State::exit`) and the generated code stores the statically known PC (an offset from the
  entry PC) and returns; the run loop's `handle` completes it exactly as for the interpreter. No
  wasm exception handling. Exits mid-block (MMIO via `vm::Io` after a helper's `Fault(Bus)`,
  timer registers, WFI, HVC, TX full, `DEVICE`) need nothing special.
- **Functions:** `f(vcpu, acc, left) -> acc + retired`, where `vcpu` points at the `Vcpu` (the
  `Cpu` at 0, then the TLB, then `State`), `left` is the step budget. Core-internal: its shape can
  change without an ABI bump.
- **Where it runs:** in the vCPU worker (Chromium) and in Node, the same code (`jitHost` in
  `web/vm.ts`). Natively there's no wasm engine: `cargo test` covers the translator's structure
  (block formation, liveness, the encoder's bytes), and the JIT's behavior is tested on the wasm
  core in Node and Chromium.

## Dispatch (`jit::steps`)

- The run loop calls `jit::steps` for each chunk. It translates the PC through the instruction
  TLB (a hit costs what the interpreter's fetch does), looks the key up in the **jump cache** (a
  `#[repr(C)]` direct-mapped array of 65,536 {key u64, table index u32, length u32} at a fixed
  address; compiled blocks only) in front of a `HashMap` with a multiply-shift hasher, and calls
  a compiled block if its length fits the steps left; otherwise it interprets the would-be
  block's length (so lookups stay at block starts).
- **Exact step accounting:** a block knows its instruction count *n* and is entered only if the
  chunk has ≥ *n* steps left; chained successors and region edges are taken only when `left`
  covers them. So the JIT never outruns a chunk, IRQs, the signal word and deadlines are checked
  between chunks as for the interpreter, and lockstep comparison works at every chunk boundary.
- Blocks never run with `SCTLR_EL1.A` set (the dispatcher interprets then; Linux never sets it),
  so inline accesses need no alignment check.

## Blocks and keys (`block.rs`)

- A block starts at a PA and ends after branches and after system instructions that can change
  the regime, before exception-generating and unallocated words, at the page end, and at **32
  instructions** (`block::CAP`). Hints that are NOPs here (PAC, BTI, CSDB, …) don't end one.
  MRS, DMB/DSB, DC ZVA and the MSRs that can't change what a block assumes
  (`interp::sys::msr_continues`: DAIFSet, DAIF, SP_EL0, SPSR/ELR_EL1, the TPIDRs) don't end a block
  either: they're inline, or a helper call that returns from the block mid-way when it doesn't
  retire. ISB, CLREX, YIELD/SEV and DC (other than ZVA) end a block but chain on.
- **Keyed by the guest PA** of the first instruction plus the regime bits that change what the
  code means (EL; `SCTLR_EL1.M`/`.A`, which pick the flat or MMU bus). Chosen over VA + ASID
  because it's what the architecture's PIPT instruction cache promises: the guest's own `IC IVAU`
  (which Linux issues when it maps an executable page) is exactly what invalidates blocks,
  remapping or `TLBI` needs nothing, and processes that share a physical page (BusyBox, libc, the
  kernel's linear map) share its translations. One block runs at every VA mapping its page, so
  the PC it stores is relative to its entry PC.
- JIT functions are named `<va>_pa<pa>` in the name section (profiles, `tools/v8code.ts`).

## Compile policy

- A key is counted per dispatch; at the **threshold (50)** it joins a pending batch, emitted as
  one module at **512 blocks** or **1M dispatched steps** after the batch's first entry
  (`BATCH_TIMEOUT`), so a lone hot block doesn't wait forever. Fewer, larger modules run faster
  (chains stay within a module) and cost V8 less per module: Alpine makes ~2,000 modules.
- **Regions** (the compile unit, one function each) are of two kinds, both within one guest page
  and of up to 16 blocks (`block::REGION`), in reverse postorder:
  - **Forward regions** (`block::forward`, formed when a batch is compiled: `Cache::plan`): a
    block of the batch and the batch's other blocks that static edges reach from it, so each block
    of a batch is compiled **once**, as a head or as a member. The edges between members keep
    registers and lazy flags in locals instead of leaving one function for the next (a frame, the
    write-backs, NZCV and the PC, a tail call). A loop head isn't taken. **A member has no
    function of its own:** entered from elsewhere (a branch from outside, a return into it, the
    dispatcher after its region ran out of steps) it is a block not compiled yet, counted from zero
    again and compiled as a head (with what it reaches in *that* batch) at the threshold. So only
    blocks with several hot entries are compiled more than once.
    - **Across pages:** a successor in another page is the batch's block that was seen at that VA
      (with the MMU off, the block at that PA). Members' positions are their VAs relative to the
      head's, and an edge into a member checks that the member's VA still maps to its page
      (the instruction TLB, as a chained successor's does: `Region::checked`), unless the member
      is where its predecessor's page or the head's has it; if the check fails the edge isn't
      taken and the successor is found by its VA. A region is filed under every page it has a
      block in, so `IC IVAU` on any of them drops it. A loop that spans two pages is such a
      region with an edge back to its head.
    - **Calls and returns:** a call's target is taken like any successor, and a `ret` (of X30) in
      what the call reaches is predicted to return after that call: the block there is taken
      too, and the `ret` is an edge to it when X30 holds that address, an indirect branch
      otherwise (`Region::returns`). Only for callees compiled in the same batch: one already
      compiled keeps its own function.
    - Alpine's boot: 47,200 functions of 49,400 blocks became 26,000 of 56,000, in 29.6 MB of
      wasm instead of 23.6. JIT-stress compiles a block at a time, so it makes none; JIT-check
      and the tests' forced mode take any block in reach in the head's page (any page with the
      MMU off), as their loop regions do.
  - **Loop regions** (`block::region`): a hot block and the blocks that lead back to it by static
    edges (its loop; seen by the dispatcher). Without a loop the region is the head alone.
- **Tier-up:** a loop head is first compiled **alone** with a hot word (one u32 per code-cache
  slot) counting entries down from `region_after` (**1000**); the entry that reaches 0 calls
  `jit_hot(vcpu, key, pc)`, which compiles the loop region in its own module (never with a flush,
  since JIT code is on the stack) and stores `1 << 31 | index` in the word; from then on the head's
  prologue tail-calls the region, so blocks linked to the head reach it too.
- **The code cache holds 262,144 regions** (4 bytes per slot up front) **and a byte budget**
  (`Config::max_bytes`: 160 MiB of wasm for a VM, divided among the caches of a parallel SMP VM, at
  least 32 MiB each: 40 MiB per vCPU on 4). When either is reached, everything is flushed (slots
  freed, the host's table lets go of the old functions, [Memory](#memory)). Alpine's boot compiles
  ~26 MiB and Debian's compiled ~73 MiB on one vCPU (~31 MiB per vCPU on 4) before forward regions
  (which added 15% to Alpine's bytes; Debian's weren't measured again), so neither flushes. Per-module
  eviction is backlog: coldest first. FIFO was tried, and it collapsed a Go build.
- **Modes** (`jit::Config`; `VmConfig.jit`): 1 = the default above; 2 = **JIT-stress**: threshold
  0, batch 1, a 4-region cache, `region_after` 1 and the stale-code checker; 3 = **JIT-check**:
  the same with the full-size cache and `region_after` 0 (the 4-region cache evicts most blocks
  before they're entered again, so JIT-stress's checker misses stale code that lives longer, e.g.
  code another vCPU rewrote without an IC). Tests also use a
  forced mode (threshold 0, batch 1, a big cache, `region_after` 0: regions at once). The
  user-mode `jit_new` takes all five knobs.
- The sweeps of threshold (2–200), batch size, timeout and `region_after` after M6's chunk change
  were flat on Alpine: the defaults stand.

## Linking

- **Chaining:** a block whose successor is static (a direct branch, both sides of a conditional
  one, the fall-through after a cap, page end or a chaining system instruction) and compiled
  **tail-calls** it (`return_call`) with `acc + len` and `left − len` when `left` covers both.
  Successors in the same batch are direct calls; already-compiled ones are imports of module `t`
  by table index.
- **A successor in another page (MMU on) is wherever its VA maps.** The block's PA plus the branch
  offset is its key only if the two pages are contiguous physically too: the kernel's image is, a
  process's file pages aren't. So a block compiled at that key is tail-called directly behind a
  check that the successor's VA hits the instruction TLB of the block's EL and maps to that
  block's host address, and otherwise (nothing compiled there, or the check fails) the successor
  is found as an indirect branch's target is, by its VA in the transfer cache (below;
  `block::chain`). Before M8 only the first half existed, and every
  call, branch and fall-through to another page of a process returned to the dispatcher: 97% of
  the userspace benchmark's dispatches, 10 to 18% of its compute phases' time
  (`bench/boot/REPORT.md` "M8: where the userspace benchmark's time goes").
- **Through the jump cache:** a successor not compiled yet when its predecessor is (the common
  case: blocks compile in hotness order), and with the MMU off every BR/BLR/RET target (its PC is
  its key), is probed in the jump cache from wasm and tail-called with `return_call_indirect` on a
  hit that fits `left`. The jump cache only holds compiled blocks and is cleared by invalidation
  and flushes, so these links need no bookkeeping.
- **Indirect transfers** (MMU on: BR, BLR, RET and the by-VA links, 25 to 55 per 1000
  instructions in user space) probe the vCPU's **transfer cache** (`mmu::Tlb::xc`, QEMU's
  `tb_jmp_cache`): 16,384 direct-mapped entries by VA bits 15:2 of {VA | regime bits, table index
  | length << 32 | generation << 48}, one probe where the instruction TLB and then the jump cache
  were two (`emit::indirect`). The dispatcher fills an entry when it enters a block. A miss
  tail-calls the cache's **miss function** for the EL (`emit::xmiss`, with the block retired),
  which does the old lookup (instruction TLB, jump cache), fills the entry and tail-calls the
  target, or returns to the dispatcher. The two miss functions are one module per cache in table
  slots 0 and 1, installed with the first module and kept by flushes, which every module imports:
  a copy in each module stayed in Liftoff.
  - **It holds no translation of its own, only what one implied**, so it drops entries whenever
    the TLB could have changed or blocks were dropped. An entry carries its EL's generation
    (`Tlb::xgen`, 1 to 0xffff; a zeroed entry never matches): flushing everything and dropping
    blocks (`Cache::drops`, which `jit::steps` compares with the vCPU's `Tlb::xdrops` before any
    block runs: in round-robin SMP one cache serves every vCPU) bump both; dropping
    the nG entries bumps an EL's only if its instruction TLB may hold nG ones (`Tlb::xng`), so
    Linux's kernel entries (global) survive context switches; a flush by VA (85 to 99% of Linux's
    flushes: user pages it unmaps) clears that page's entries (its VAs fill 1024 consecutive
    slots). Each of these mattered: dropping everything on every flush made boot 6% and process
    churn 7% slower (bench/boot/REPORT.md "M8: a VA-keyed cache for indirect transfers").
  - The stale-code checker, which needs the key, is called with `u64::MAX` on a hit
    (`jit_check` then computes the key from the PC).
- **Inside a region:** members are nested wasm `block`s; an edge to a later member is a `br`
  taken when `left` covers it; back-edges to the head branch to a wasm `loop` under the same
  budget check (the budget alone: no atomic load, since `left` never exceeds the chunk). Other
  edges leave through the tails above.
- Dropping a block drops the blocks chained to it, transitively (the cache records who chains to
  whom).

## Memory

What a compiled region costs the host, measured in headless Chromium 153 on the dev VM (Debian, 1 GiB
guest, 4 vCPUs; `bench/mem/`: `memsample.ts` samples the renderer's smaps by mapping, summaries in `results/summary.json`): **V8 spends ~10× a module's wasm bytes**,
~5× in C++ metadata (PartitionAlloc: NativeModule, wire bytes, code tables) and ~4.7× in code
(~4.7 KB per region at ~480 wasm bytes), and JS objects (Instances, exports) are small (the four
workers' JS heaps total ~200 MB). **Each vCPU worker compiles its own copy** of the guest's code
(its own cache, table and instances), so the total is ×ncpus. A 4-vCPU tab under a mixed load grew
from 2.3 GB at login to 5 GB in 8 minutes with nothing flushed (615K regions, 294 MB of wasm) and
was headed for the cache's 262,144 regions per vCPU: ~4.9 GB of V8 memory, the 6 GB tab. The
guest's invalidations (~700) and the tier-up's superseded heads (~1% of regions) are not what grows.
- **The byte budget** bounds it: ~10 × 160 MiB + the guest and the core's heap (~1.3 GB) + the browser
  (~0.2 GB) = ~3.2 GB for the 4-vCPU page, flat (the uncapped run kept climbing).
- **Why a whole-cache flush, not aging or LRU:** compiled code has no per-block use counts (a block
  runs inside V8 without telling the core), so aging would need a counter update per block entry, the
  cost the design avoids everywhere; and links between blocks (`linkers`, direct calls by table index)
  make dropping a subset need the unlink walk that invalidation does. FIFO by module is the cheaper
  precise option (backlog); until then a flush is one clear of the maps, and the guest's hot set is
  recompiled in ~1–2 s of one vCPU's time.
- **What 40 MiB per vCPU is sized against:** the live set of a Debian boot on 4 vCPUs (~31 MiB
  per vCPU), so booting doesn't flush; a mixed load then flushes about every 3–4 minutes per vCPU,
  and a Go build (a compiler's working set is larger than the budget) about every 30 s, which cost ~6% of CPU in
  compiling (113 s of 4 × 480 s; the mixed load: 1.6%, uncapped 0.8%) and showed no guest slowdown
  (steps per second matched the uncapped runs within the load's variation).
- **A flush must free something on the host:** the host's table keeps the functions (so their
  instances and code) alive until the slots are overwritten, so `web/vm.ts` nulls the slots a flush
  leaves unused. V8 frees the dead code only when its JS GC collects the instances, and a worker's JS
  heap stays small, so that GC can lag by minutes: with the flush alone a Go build's tab peaked at
  9.6 GB (median 4.8 GB). After each flush the host allocates (and drops) a 256 MiB ArrayBuffer, whose
  external-memory pressure makes V8 collect: median 3.3 GB, p90 4.0–4.9 GB. Two of four runs still had one
  ~10 GB sample near their end that the sampler could not explain (not reproduced with 8 s sampling).
- **Measured** (mixed load, 450 s; `bench/mem/results/summary.json`, made by `bench/mem/summarize.mjs` from raw samples kept in bench/results/local): without the budget
  the renderer is 4.3 / 3.9 GB (median of two runs) and climbing, at 615K regions: 1486 MB
  PartitionAlloc, 1391 MB wasm code, 1283 MB linear memory (guest 1024 + the core's heap ~150), 221 MB
  JS heaps. With 40 MiB per vCPU: 3.2 GB median, 3.5 max, 8 flushes, 1.6% of CPU compiling (0.8%
  without). A/B at 3 alternating pairs (`bench/mem/results/`, `bench/run.ts` defaults): Alpine
  (no flush; 22 MB) `alpine_jit_total` 10977 (IQR 361, n=15) vs 10952 (IQR 1015): no measurable
  difference at n=15; Debian on one vCPU with a 40 MiB budget (one flush) `debian_jit_total_cold`
  47473 (IQR 1504, n=3) vs 45185 (IQR 3999): 5% slower, not separable from noise at n=3. So a
  single-cache VM gets the whole 160 MiB (`Config::for_vcpus`; Debian's 73 MB boot never flushes) and
  only the 4-vCPU page runs at 40 MiB per cache. After a guest panic and `page.reload()` the renderer
  went from 3.55 GB to 1.2 GB at once (`mem-run6-crash` in the summary).
- **The page's memory estimate** (`hostMemoryGiB`, `web/app/machine.ts`: RAM + 1 + 0.3 per vCPU,
  3.2 GiB for the default) matches the capped median; the peaks above it are the GC's lag.

## Invalidation and the stale-code checker

- `CTR_EL0.DIC = 0`, so guests issue `IC IVAU`/`IC IALLU(IS)`. Those leave the interpreter with
  `Exit::Invalidate(pa)` (`u64::MAX` for IALLU), and the run loop drops the blocks of that
  physical page (a map from page to the keys filed under it, so IVAU on a page without code costs
  one lookup) or all of them. Invalidation is per 4 KiB page; a forward region with blocks in
  several pages is filed under each.
- **The stale-code checker** (`jit::Config::check`, on in JIT-stress) hashes each block's words
  when it's compiled and again at every entry (chained entries and back-edges call
  `jit_check(vcpu, key)`), and panics (trapping the wasm run) on a mismatch. In parallel SMP each
  vCPU has its own cache, and another vCPU may legally rewrite code before its IC reaches this one:
  those caches are **tolerant** (`Cache::tolerant`), counting a stale block (`Stats::stale`) and
  dropping it at the run loop's entry instead ([platform.md](platform.md) "Broadcast
  maintenance").
- **Parallel SMP** also compiles DSB as a helper call (the interpreter's DSB ends the chunk under
  `cpu::FEATURE_PARALLEL`, where the run loop completes this vCPU's TLBI IS broadcasts); ISB and
  ERET were helper calls already and end the chunk the same way.

## Emission (`emit.rs`)

- **Registers in locals:** each guest register a block's inline code touches lives in an i64
  local, loaded on first use and written back before helper calls and returns; after a helper
  every local is dropped. The load/store slow path writes back before its helper and reloads the
  instruction's destinations after it, so both arms merge. Only the locals a function uses are
  declared (`wasm::Code::compact_locals`: Liftoff zero-initializes each one per call); registers
  read once and never written stay plain loads. In regions, each member starts in a fixed
  register state (the merge of its incoming edges, found by a first emission) and every edge
  conforms to it; the head's state is loaded once before the loop.
  Locals map: i64 scratch 2..=5, i32 6..=9, VT 119–122, FPOK 123, VTMP 124, TAKEN 125.
- **Lazy NZCV:** ADDS/SUBS, ADCS/SBCS, ANDS/BICS keep their operands (or result) in flag locals
  and record their kind; a setter replaced by the next one emits no flag code. Conditions (B.cond,
  CSEL & co, CCMP, ADC's carry) come straight from the operands where the kind allows (SUBS: EQ,
  CS, HI, GE, GT and inverses; ADDS: EQ, CS, MI; logical: all), else from NZCV computed in
  registers. NZCV is stored before helpers, on a load/store's failure return, and **before** the
  block's branch (after it, TurboFan ran the integer guest 35% slower). In regions, a member
  starts with lazy flags when every edge into it carries the same setter, else in memory or dead;
  an edge stores NZCV only into a member that needs it in memory, and exits store it; a region
  whose edges disagree is emitted again with flags in memory.
- **The PC on the way out:** a block whose successors are all members doesn't store the next PC
  (`Func::defer_pc`; a conditional branch keeps its outcome in `TAKEN`); only the exit paths do.
- **Integer:** MOVZ/N/K, ADR/ADRP, ADD/SUB (all forms, S or not), ADC/SBC(S), logical, bitfield
  moves and aliases, EXTR, variable shifts, CSEL & co, CCMP/CCMN, MADD/MSUB and the long
  multiplies, SMULH/UMULH (from 32-bit halves: wasm has no wide multiply), UDIV/SDIV (with `if`s
  where wasm traps), REV*/RBIT/CLZ/CLS, all branches, the NOP hints. 32-bit forms run on i32 and
  zero-extend. An instruction is inline only if its handler can't fail, decided from the word.
- **Loads and stores (the TLB fast path):** through the TLB array of the block's EL (static:
  EL is in the key), tag = `(va + len − 1) | 0xfff`, host = `va + addend`, entry offset
  `(va >> 8) & 0xfff0`; with the MMU off a bounds check against RAM, whose layout the block embeds.
  Every addressing form of LDR/STR, LDP/STP/LDPSW/LDNP/STNP, LDR literal, PRFM, SIMD&FP single and
  pair, LD1/ST1 multiple, LDTR/STTR (through EL0's TLB arrays). Anything else (a miss, a fault,
  MMIO, a page-crossing access, a misaligned SP base) calls a helper that re-executes the whole
  instruction: the fast path changes nothing before its check, so fault state is exact by
  construction. Every guest RAM access in generated code goes through one lowering function
  (layout A's single point of change).
- **Atomics:** LDAR/STLR as aligned wasm atomics, single exclusives and the LSE atomics
  (add/clr/eor/set/swp as `atomic.rmw`, CAS as `cmpxchg`) inline; DC ZVA as a 64-byte zero.
  Barriers: with vCPUs sharing a thread (one vCPU, or round-robin SMP) they order nothing and
  emit nothing; in parallel SMP every DMB (and SSBB/PSSBB) is an `atomic.fence`, which V8 lowers
  to `dmb ish` on arm64 in both tiers (checked with `--print-wasm-code`), and DSB is the helper's
  (it ends the chunk: [platform.md](platform.md) "Broadcast maintenance"). Plain guest loads and
  stores are plain wasm ones, which V8 keeps in program order around the fence and lowers to
  plain `ldr`/`str`: the host's reordering is then the guest's own (litmus MP shows it).
  **Address dependencies** order a guest's loads only while the host's addresses depend on the
  loaded value, and V8's optimizing tier folds `x ^ x` and `x − x` to 0 (checked with
  `--print-wasm-code`: the second load's address became a constant). So in parallel SMP, EOR and
  SUB (shifted register, no shift) of a register with itself are `x & zero`, `zero` being a
  mutable i64 global each parallel module defines (`Module::zero_global`, never written; V8 can't
  fold it): the value is 0 and the host address still depends on `x`. That's the litmus idiom
  (`MP+dmb.sy+addr`: 95 forbidden outcomes in 1.2M before, none after, M8 loop 7) and Linux's
  `arch_counter_enforce_ordering`. Other always-zero forms (`and x, x, xzr`, a multiply by
  zero) aren't covered: no code we know builds dependencies with them.
- **System:** MRS of plain registers inline (checked against the interpreter's read; SP_EL0 and
  TPIDR_EL1 were 91% of Alpine's MRS calls); the MSRs above inline; an MSR or ERET that unmasks
  IRQs leaves through its helper's `Exit::Resync`. SIMD&FP instructions check `CPACR_EL1.FPEN`
  once per block.
- **NEON → SIMD128** (`emit/simd.rs`): handler by handler after the interpreter's: three-same,
  shifts, moves and immediates, widening/narrowing, reductions, TBL/TBX (as `i8x16.swizzle`,
  never `relaxed_swizzle`, whose out-of-range lanes aren't deterministic). Our encoder emits the
  SIMD128; the core itself is built without `simd128` ([backlog.md](backlog.md)).
- **Crypto** (`emit/crypto.rs`): AESE+AESMC and AESD+AESIMC on the same register fused into one
  round; SubBytes by **nested inversion** over GF(2⁴) (Hamburg's formulas, our implementation;
  tables from `crypto::nested` at compile time; 30% faster than the S-box as 16 slice swizzles);
  `PMULL.1Q` as Karatsuba over three 32×32 `i64.mul`s with holes (4.5% faster than four
  products); SHA1C/P/M and SHA256H/H2 as scalar rounds on renamed i32 locals, the schedule
  updates as SIMD128, and `mov S, A; sha256h A, E, W; sha256h2 E, S, W` computed once. The 8-bit
  PMULL/PMUL stay helpers (no guest measured uses them).
- **Vector constants** live in `Vcpu::consts` and are loaded from fixed offsets (V8 materialized
  each `v128.const` from 16 bytes of immediates at every use).
- **Branch hints** (`wasm::Code::hint`, the `metadata.code.branch_hint` section): every `if`/
  `br_if` around a helper call or a fast-path check is hinted (likely for fast paths and budget
  checks, unlikely for helper exits and traps), so TurboFan puts spills in deferred code;
  data-dependent branches (`TAKEN`, guest conditions) stay unhinted. See [v8.md](v8.md).

### Floating point (`emit/float.rs`)

Scalar and vector FP are inline only where the result and the flags are exactly the
interpreter's; the helper runs the instruction otherwise.
- **Block guard `FPOK`:** before a block's first inline FP arithmetic (after the FPEN check), one
  test: FPCR.RMode is round-to-nearest-even **and FPSR.IXC is already set**. Both hold for the rest
  of the block (FPCR/FPSR change only through MSR, which ends a block, and helpers only OR flags
  in). If it fails, the block's FP arithmetic runs through helpers, which set IXC on the first
  inexact result, so the next run is fast.
- **Why IXC set is enough:** with normal inputs and a result that's normal and above the smallest
  normal binade, the only exception add, subtract, multiply, divide, square root (of a positive),
  conversion or FMA can raise is Inexact; so FPSR doesn't change when IXC is set, and the fast path
  needn't know whether the result was exact. FZ and DN only act on denormals and NaNs, which it
  never meets; AHP only concerns half precision, which it doesn't do.
- **Per instruction:** integer tests on the exponent fields decide normality; the host's IEEE
  operation in RNE gives the ARM result; the result's exponent is checked (above 1, below all
  ones), and a failure sends the instruction to the helper with the operands untouched. Vector
  forms test every lane.
- **FMA:** single precision computes the exact product in double, t = RN64(p + c), and RN32(t)
  is correct unless t is exactly halfway between two singles (low 29 fraction bits 1 then zeros),
  which goes to the helper. **Double FMA stays a helper by design** (no deterministic wasm FMA;
  relaxed-simd's `madd` isn't one).
- **Conversions:** SCVTF/UCVTF inline (RNE, can't overflow), including the forms with the integer
  in a SIMD&FP register and the vector forms; FCVTZS/FCVTZU inline for in-range non-NaN operands;
  FCVT single↔double with normal operands and a fast result.
- FABS, FNEG, FMOV, FCSEL are bit operations without flags: inline without the guard.

## What still runs through helpers

On Alpine's paths (~2.5M helper-retired steps a boot): unmasking MSRs (DAIFClr, an MSR DAIF that
unmasks), the regime, FP-control, SPSel and NZCV MSRs, ISB, CASP, exclusive pairs, LSE min/max,
LD2–LD4/ST2–ST4, the load/store fallbacks (TLB misses, MMIO), CRC32, f64 FMA, the 8-bit PMULL;
in OpenSSL's GCM path scalar `SHL` and `LD1`/`ST1` single structure. `jit_helper_report` has the
live histogram. None was worth a loop by itself at M6.5's end.

## Tried and not kept

Findings worth not re-discovering (numbers in `bench/interp/REPORT.md`):
- **TLB entry layouts:** an i32 addend, and split tag/addend arrays (12 bytes an entry): neither
  paid on Alpine's boot trace (the split's index arithmetic costs more than its density saves).
  The 16-byte entry stays.
- **Relinking** (recompiling a block once a successor it returned through is compiled): doubled
  the blocks compiled and the flushes on Alpine for 9% fewer dispatches.
- **Regions of every seen successor** (M5, loops; forward regions since M8 hold each block of a
  batch once, which is what this lacked) duplicated each block into ~5 regions and cost Buildroot
  25–40%; **regions at the first threshold** (no tier-up) cost the boots 10–14% (~930 lukewarm
  loops compiled in Buildroot); **regions from any block in reach** under JIT-stress made it 42×
  slower. Hence: loops only, from seen blocks, after 1000 entries.
- **An atomic load of the signal word on back-edges** (as first planned): adds nothing the run
  loop would act on sooner, since `left` bounds a region to the chunk.
- **Out-of-line jump-cache probes:** slower. The probes cost nothing measurable at steady state now
  that hot loops are regions.
- **A lower compile threshold** (2–50): both boots got slower. 50 stays.
- **The `Cpu` at a constant address** (to save V8's bounds checks at block exits): mixed, −10% to
  +7% by guest and placement ([v8.md](v8.md)).
- **A compile worker** (compiling off the vCPU thread): measured, not built. Installs take
  ≤ 1.3 ms each; guest progress pauses above 16 ms about once per Alpine boot; the synchronous
  install is ~0.3 s of Alpine's boot and V8's native work ~1.8 s (lazy Liftoff compiles included).
  Revisit with a GUI guest (latency, not total time, is its value). A design sketch: a second core
  instance on the shared memory forms, emits and eagerly compiles, and posts the
  `WebAssembly.Module` to the vCPU worker, which only instantiates it; costs a host ABI, a queue
  and invalidation of in-flight compiles.
- **Forward regions behind a tier-up** (M8, before the batch-time ones): every block with a
  same-page successor compiled alone with a hot word, its forward region compiled after 1,000
  (or 10,000, or 50,000) entries. Lua got 10 to 18% faster, but the boot and process churn 13 to
  20% slower at every threshold: the counting prologue in nearly every block is 16% more wasm,
  and it runs in the cold code that is most of a boot (guest code +17 to 20% in both V8 tiers).
  Forming the regions when the batch is compiled needs no prologue, no second compile and no
  redirect, and was faster everywhere (`bench/boot/REPORT.md` "M8: forward regions"). Tried with
  them and flat within noise: 8 or 32 blocks a region instead of 16.
- **Copies of compiled callees in their callers' regions** (M8, with calls followed): a callee
  that is already compiled (the usual case: a shared function is hot long before a given caller)
  copied into the caller's region so the call and its predicted return stay inside. Limited to
  small leaf functions (every path returns within 4 or 10 blocks, no calls), it changed nothing:
  few calls qualify. Unlimited, it made 80% more wasm (Alpine's boot 30% slower, churn 20%)
  and no phase faster. The patch is in `bench/boot/results/m8-xpage/`.
- **Vector registers in locals** wasn't built: no profile asked for it (the boots and CoreMark use
  little NEON). It's the lever for AES-CBC (latency-bound on the V registers' store and reload
  between instructions) and NEON-heavy code generally.

## Validation

The golden corpus through the JIT (forced and stress), the JIT-vs-interpreter differential test on
random words and sequences (`tests/jit-diff.test.ts`), lockstep (`tests/jit-lockstep.test.ts`),
every boot's exact steps under the JIT, and planted bugs for every new rule. Details in
[testing.md](testing.md).
