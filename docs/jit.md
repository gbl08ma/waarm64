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
  timer registers, WFI, HVC, TX full, `DEVICE`) need nothing special. Counter reads are compiled inline where the
  exit would only read the counter: from the host clock in parallel SMP's realtime mode, from the step clock in
  deterministic round-robin (below, "System"); realtime round-robin keeps the exit. Deterministic round-robin also
  reads and writes the timers' CTL, CVAL and TVAL inline at EL1 while a write fires nothing before the chunk's end
  ("Timer registers from the step clock" below).
- **Functions:** `f(vcpu, acc, left, depth) -> acc + retired`, where `vcpu` points at the `Vcpu` (the
  `Cpu` at 0, the crypto constants, `State`, the TLB's scalars, then its arrays and the transfer
  cache), `left` is the step budget (counted code; parallel SMP's polled code passes 0 and reads none: [Preemption](#preemption-parallel-smps-polled-code)), `depth` the host calls under it with an entry number above (below,
  "Calls"). Whatever JIT code loads at a fixed offset sits within the
  first 0x800 bytes, where V8 folds the offset into the load (past ~32 KiB it builds it with a
  `mov`+`movk` every time): the TLB arrays are interleaved (below, "Loads and stores"), and the
  transfer cache (at 0x80000 plus a small offset) is reached by ORing 0x80000 into its index.
  Core-internal: its shape can change without an ABI bump.
- **Where it runs:** in the vCPU worker (Chromium) and in Node, the same code (`jitHost` in
  `web/jit-host.ts`). Natively there's no wasm engine: `cargo test` covers the translator's structure
  (block formation, liveness, the encoder's bytes), and the JIT's behavior is tested on the wasm
  core in Node and Chromium.

## Dispatch (`jit::steps`)

- The run loop calls `jit::steps` for each chunk. It translates the PC through the instruction
  TLB (a hit costs what the interpreter's fetch does), looks the key up in the **jump cache** (a
  `#[repr(C)]` direct-mapped array of 65,536 {key u64, table index u32, length u32}, one per
  function table, which blocks reach through the vCPU's `jit::State::jc`; compiled blocks only)
  in front of the shared cache's `HashMap` (multiply-shift hasher, behind a lock: [Sharing](#sharing)), and calls
  a compiled block if its length fits the steps left; otherwise it runs the block in the **block
  interpreter** ([cpu.md](cpu.md) "The block interpreter": decoded once, kept per table, chained
  to the blocks after it), as much of it as fits, so lookups stay at block starts. A decoded block
  counts its dispatches itself and reports them to the shared cache every 16, so the lock is
  taken once per 16 dispatches of a block that isn't compiled, not at every one; a jump-cache
  miss for a block the table already has compiled, or for a key with no instructions, takes it
  not at all ([Sharing](#sharing) "What the lock costs").
- **Exact step accounting** (counted code: round-robin, deterministic or realtime, and user mode): a block knows its
  instruction count *n* and is entered only if the chunk has ≥ *n* steps left; chained successors and region edges
  are taken only when `left` covers them. So the JIT never outruns a chunk, IRQs, the signal word and deadlines are
  checked between chunks as for the interpreter, and lockstep comparison works at every chunk boundary. **Parallel
  SMP's polled code** has no `left`: it runs on to its next poll past the chunk's steps, and stops early when the
  vCPU's stop word says so ([Preemption](#preemption-parallel-smps-polled-code)).
- Blocks never run with `SCTLR_EL1.A` set (the dispatcher interprets then; Linux never sets it),
  so inline accesses need no alignment check.

## Blocks and keys (`block.rs`)

- A block starts at a PA and ends after branches and after system instructions that can change
  the regime, before exception-generating and unallocated words, at the page end, and at **32
  instructions** (`block::CAP`). Hints that are NOPs here (PAC, BTI, CSDB, …) don't end one. A longer cap would buy
  little: blocks the cap ends are 0.03-1% of compiled block entries (Alpine's boot 0.54%, compress 0.97%), and their
  successor is mostly a member of the same region, an edge that keeps registers in locals (`bench/boot/REPORT.md`
  "Regions of 64 blocks").
  MRS, DMB/DSB, DC ZVA and the MSRs that can't change what a block assumes
  (`interp::sys::msr_continues`: DAIFSet, DAIFClr, DAIF, DIT, SP_EL0, SPSR/ELR_EL1, the TPIDRs) don't end a
  block either: they're inline, or a helper call that returns from the block mid-way when it doesn't
  retire. ISB, CLREX, YIELD/SEV and DC (other than ZVA) end a block but chain on (ISB is inline outside
  parallel SMP, where the interpreter's does nothing; the block's PC is then set as after any
  non-branch).
- **Keyed by the guest PA** of the first instruction plus the regime bits that change what the
  code means (EL; `SCTLR_EL1.M`/`.A`, which pick the flat or MMU bus). Chosen over VA + ASID
  because it's what the architecture's PIPT instruction cache promises: the guest's own `IC IVAU`
  (which Linux issues when it maps an executable page) is exactly what invalidates blocks,
  remapping or `TLBI` needs nothing, and processes that share a physical page (BusyBox, libc, the
  kernel's linear map) share its translations. One block runs at every VA mapping its page, so
  the PC it stores is relative to its entry PC.
- JIT functions are named `<va>_pa<pa>` in the name section (profiles, `tools/v8code.ts`).
- **A compile forms its blocks again** from memory (`block::form` in `block::region` and `block::forward`, often more
  than once per block: `Cache::plan` asks a candidate member whether it heads a loop), though the table's decoded
  blocks formed them first (`interp::block::Cache`). That stays: it is part of forming batches (`plan_ns`, counter
  word 113), which took 1.0 s of ~1,450 vCPU-seconds in Firefox's pages session and 2.1 s of ~800 on the churn screen
  (0.07% and 0.26%, all under the cache's lock), and taking 3.6-7.7 s of emission out from under that lock moved
  nothing a user would see (`bench/boot/REPORT.md` "M8: emitting outside the JIT cache's lock"). Reusing the first
  decode would also cost: micro-ops don't keep their words (4 bytes more per instruction in every table's arena), a
  batch is formed in the shared cache from blocks other tables decoded, and what a compile reads now is what the
  stale-code checker hashes.

## Compile policy

- A key is counted per dispatch; past the **threshold** it joins a pending batch, emitted as
  one module at **512 blocks**, once the pending blocks have run **50,000 steps** in the
  interpreter since they joined it (`BATCH_STEPS`: each dispatch of a queued block adds its
  length), or **64M steps** after the batch's first entry (`BATCH_TIMEOUT`, for lukewarm blocks).
  So a block that keeps running is compiled soon, and blocks that rarely run wait for company.
- **The threshold follows the code cache's pressure** (`Cache::retune`, set where modules are
  installed and at flushes, so a dispatch only compares): the mechanism doubles a floor at each eighth
  of the byte budget past two (80 MiB) up to `threshold_max`: the floor is **1000** and the maximum **2000**, so
  cold code (a boot compiles ~60 MiB) meets 1000 and a browser's working set 2000 once the cache holds 3/8 of it (120 MiB)
  (`Config::threshold`, `threshold_max`, `PRESSURE_KNEE`), and each flush doubles the floor it
  starts from. Code that fits is compiled early; a working set that doesn't fills the rest of the
  budget with the code that runs most. One threshold for every block: one by the block's length, mix or rate was
  measured and won nothing ([Tried and not kept](#tried-and-not-kept)). JIT-stress, JIT-check, the dispatcher-only mode and the
  user-mode `jit_new` keep a fixed threshold.
  Fewer, larger modules run faster (chains stay within a module) and cost V8 ~16 KB less each
  ([Memory](#memory)): Alpine's userspace benchmark makes 970 modules (3,860 with the 1M-step
  timeout alone, which emitted half of them with one function).
- **Regions** (the compile unit, one function each) are of two kinds, of up to **64** blocks (`block::REGION`;
  against 16 on the Mac, Alpine's boot ~5% faster, its userspace ~4%, the parallel boots 2-3%, Firefox's pages session
  the same, no more memory: `bench/boot/REPORT.md` "Regions of 64 blocks"), in
  reverse postorder: loop regions within one guest page, forward regions across pages ("Across pages" below):
  - **Forward regions** (`block::forward`, formed when a batch is compiled: `Cache::plan`): a
    block of the batch and the batch's other blocks that static edges reach from it, so each block
    of a batch is compiled **once**, as a head or as a member. The edges between members keep
    registers and lazy flags in locals instead of leaving one function for the next (a frame, the
    write-backs, NZCV and the PC, a tail call). A loop head isn't taken. **A member has no
    function of its own:** entered from elsewhere (a branch from outside, a return into it, the
    dispatcher after its region ran out of steps) it is a block not compiled yet, counted from zero
    again and compiled as a head (with what it reaches in *that* batch) at the threshold. So only
    blocks with several hot entries are compiled more than once.
    - **Warm members** (`Config::warm`, **16**; 0 in JIT-stress, JIT-check and `jit_new`): a
      region also takes a successor in reach that has run that many dispatches but isn't compiled
      or in the batch (not a loop head). Without it, a successor that gets hot after its
      predecessor was compiled is reached through the jump cache forever (regions aren't
      re-emitted): a `return_call_indirect`, which in a browser's code footprint costs a stall at
      the target's first instruction (a quarter of a busy vCPU's time in Firefox). With 16,
      Firefox's busy vCPUs ran 18% faster for 16% more wasm; 1 and 4 cost 41% and 33% more wasm
      and a flush (`bench/boot/REPORT.md` "M8: where a busy vCPU's time goes in Firefox").
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
      too, and the `ret` is an edge to it when X30 holds that address (`Region::returns`); otherwise, and when the
      edge's budget or page check fails, it is the `ret` it would be alone: at depth > 0 a host return
      (`emit::ret_up`), at depth 0 an indirect branch. A call is followed (a branch to its callee) only through the
      call that took the callee (`Region::follows`); a call to a block taken already (the head: recursion; a callee
      another call took, whose `ret` predicts that call's return) is a host call, and so is one whose callee could
      leave the region ("Calls" below). Only for callees compiled in the same batch: one already
      compiled keeps its own function, and is called as a host call ("Calls" below). The indirect
      branch takes the target from `ADDR`, where the `ret` left it, unless a checked edge's page
      check wrote its own VA there first; then it loads the PC again. Before that was handled
      (2026-11-05), the branch probed the predicted block's VA, and when a function for that block
      was in the transfer cache it ran there at the real target. Linux on 4 parallel vCPUs then
      ran `__switch_to`'s epilogue at a new task's `ret_from_fork` and crashed at EL1 on a user PC,
      about once in 40 litmus boots. That needed the continuation entries of host calls, which give
      such blocks functions (`tests/jit.test.ts` "a predicted return that misses…").
    - Alpine's boot: 47,200 functions of 49,400 blocks became 26,000 of 56,000, in 29.6 MB of
      wasm instead of 23.6. JIT-stress compiles a block at a time, so it makes none; JIT-check
      and the tests' forced mode take any block in reach in the head's page (any page with the
      MMU off), as their loop regions do.
  - **Loop regions** (`block::region`): a hot block and the blocks that lead back to it by static
    edges (its loop; seen by the dispatcher). Without a loop the region is the head alone. A call (BL) is no edge
    there: its target is a host call's, so recursion is no loop (before PERF loop 37 a self-recursive function's
    entry headed one, its `bl` the back-edge, and every return of the recursion was a host return one frame early),
    and the block after it isn't taken either, so a loop through a call (`for (…) f(x);`) isn't a loop region.
- **Tier-up:** a loop head is first compiled **alone** with a hot word (one u32 per slot of each
  function table, which blocks reach through `jit::State::hot`) counting entries down from `region_after` (**1000**); the entry that reaches 0 calls
  `jit_hot(vcpu, key, pc)`, which queues the loop region for the **next batch** (`Cache::tierq`); once that is
  emitted, `1 << 31 | index` goes in the word, and from then on the head's prologue tail-calls the region, so
  blocks linked to the head reach it too. A head that gets hot in another table finds the region compiled
  (`Cache::tiers`) and redirects its own word.
  - **Waiting for the batch:** a queued head adds `TIER_STEPS` (**1,562**) to the batch's steps
    (`BATCH_STEPS`) and its word counts 64 entries again (`REARM`), in every table that sees it hot; each time it
    gets hot again it adds again, so a loop that keeps running makes the batch due after 32 of them (~2,000 more
    entries alone) and lukewarm loops go with whatever is pending. `jit_hot` emits the batch it made due when it
    fits without a flush (JIT code is on the stack), else the dispatcher's next miss does. A queued head whose loop an
    earlier region of the same batch runs (it got hot while it waited: its loop's other blocks are heads alone too)
    goes quiet (`Info::covered`) instead of compiling the same loop again. JIT-stress, JIT-check and the forced mode
    (batch 1) tier up at once, in a module of their own.
  - **Why:** tier-ups made most modules, each with its region alone or with a small batch: in Firefox's pages session
    5,600 of 6,750 modules (1,580 of them one region), in the churn screen 17,700 of 33,000 (7,900 alone), and V8 spends
    ~16 KB a module besides its functions ([Memory](#memory)). Waiting: the pages session's modules 6,731/6,767 → 2,778,
    V8's wasm code 927/921 → 870 MB (median), the renderer 4,987/5,006 → 4,947 MB, busy MIPS 152/155 → 158, the heavy
    pages' loads 17.8/17.7 → 16.8 s; the churn's 32,900 → 23,000 (wasm −3%: fewer loops compiled twice); the 4-vCPU
    `go build` loop 1,110 → 1,141 MIPS, the renderer 3,229 → 2,876 MiB (`bench/boot/REPORT.md` "M8: tier-ups
    folded into the batches"). Without the quieting the churn compiled 11% more wasm; a quarter of the wait
    (`TIER_STEPS` 6,250: 8 times hot) left 25,400 modules there.
- **The code cache holds 262,144 regions** (4 bytes per slot up front) **and a byte budget**
  (`Config::max_bytes`: **320 MiB** of wasm for a VM by default, whose vCPUs share it: [Sharing](#sharing); a machine
  sets its own with `VmConfig.jit_bytes`, the page's `?jitmb=` and a stored machine's JIT cache setting). When
  either is reached, everything is flushed (slots freed, the host's table lets go of the old
  functions, [Memory](#memory)). Alpine's boot compiles ~30 MiB and Debian's ~73 MiB, so neither
  flushes; nor do a 4-vCPU `go build` loop (once in its first 3 minutes at 160 MiB) and Firefox's pages session
  (~330 MB of wasm; 2 flushes and ~505 MB at 160 MiB, which the next epoch compiled again). At Firefox's ~1.3 KB a
  region 320 MiB is about what the slots hold. Per-module eviction, FIFO, keeping the flushed hot set warm and
  carrying it across a flush, and a budget that adapts to the code in use, were tried ([Tried and not kept](#tried-and-not-kept)).
- **Modes** (`jit::Config`; `VmConfig.jit`): 1 = the default above; 2 = **JIT-stress**: threshold
  0, batch 1, a 4-region cache, `region_after` 1 and the stale-code checker; 3 = **JIT-check**:
  the same with the full-size cache and `region_after` 0 (the 4-region cache evicts most blocks
  before they're entered again, so JIT-stress's checker misses stale code that lives longer, e.g.
  code another vCPU rewrote without an IC). Tests also use a
  forced mode (threshold 0, batch 1, a big cache, `region_after` 0: regions at once). The
  user-mode `jit_new` takes all five knobs.
- The sweeps of threshold (2–200), batch size, timeout and `region_after` after M6's chunk change
  were flat on Alpine. With the block interpreter (2026-10-09), fixed thresholds 50 / 200 / 500 /
  1000 on Chromium in Debian (4 vCPUs, three renders): 50 compiled ~150 MiB a render and flushed,
  200 flushed by the third, 500 compiled 67 MiB once (warm renders 28–30 s against 41); on Alpine
  500 made the hot phases (Lua, SQLite, compress, churn) 1.5–6% slower than 50 and the boot 6–9%
  faster. The pressure-driven threshold has 50's hot phases and is 4–5% faster than 500 on every
  Chromium render, 5–8% on a 4-vCPU `go build` loop, without flushes; the Alpine boot keeps 50's
  cost (+7% against 500: its code runs 50–500 times and not again, so compiling it at 50 doesn't
  pay back V8's compile; the Debian boot on the page didn't move). Floors of 100 and 200 traded the
  phases and Chromium for the boot; counts that decay with time and a ×10 threshold for EL1 blocks
  didn't help the boot (`bench/boot/REPORT.md` "M8: a compile threshold that follows the code
  cache's pressure").
- **The floor is 500 since the block interpreter got faster** (M8-INTERP loop 6, 2026-10-21;
  `bench/interp/REPORT.md` "M8-INTERP loop 6"): interpreting runs at 1.3-1.9× its old speed, so
  compiling later pays. Against a floor of 50: Firefox's pages session from the snapshot compiles
  19% less wasm (V8's code 33% less, the renderer's RSS 13% less) at +2.5% busy MIPS, the wiki
  page's load 7% faster, the BBC's even; the churn page 32% less wasm, its first flush 99 s in instead of 58; Chromium in Debian's
  cold render 37% less wasm and 9-24% faster renders; Alpine's boot +8%, its userspace benchmark
  4% faster; the 4-vCPU `go build` loop 4-6% slower (two sessions each, within its session spread).
  A floor of 200 sat between (the `go build` loop −10% in its one session).
- **The floor is 1000** (the second round, `bench/interp/REPORT.md` "M8-INTERP round 2": 250, 500, 1000, 2000):
  against 500, churn 9% less wasm, pages 3% less (V8's code −8%) at +9% busy MIPS in one session, Alpine's boot
  +0.7%, its userspace −0.8%, `smp_user_jit_4` −1.9%; 2000 compiled least (pages −22%) but lost on Alpine's
  userspace (+2.3%) and boot (−1.9%). The `go build` loop's sessions spread too much (1,094-1,489 MIPS at one
  floor) to tell 50, 500 and 1000 apart.
- **The maximum is 2000** (`bench/interp/REPORT.md` "M8-INTERP loop 11": floors 1000 and 1500 with maxima 1000 to
  4000): the floor of 1000 with a maximum of 2000 compiled as little as a floor of 1500 on the churn page (−22%, no
  flush) and in Firefox's pages session 13% less wasm, V8's code −10%, the tab's RSS −100 MB, busy MIPS +6%;
  Alpine's boot and userspace and `smp_user_jit_4` unchanged (cold code stays under the knee). A maximum of 4000
  compiled no less in the pages session (pressure never takes the threshold past 2000 there).
- **Checked on the Mac** (2026-11-09, `bench/boot/REPORT.md` "Where a busy vCPU's time goes on the Mac, and the compile
  threshold there"): the rounds above ran in the dev VM, whose bounds checks make compiled code dearer against the
  interpreter, so 1000/2000 was raced against 500/1000 and 250/500 on the Mac host. 250/500 lost everywhere (pages
  +3.6%, Alpine's userspace +1.4%, its boot +2.9%); 500/1000 tied (within the rounds) at 21% more wasm. Halving the
  threshold takes only a fifth of the interpreted steps away (3.9 → 3.1% in the pages session).
- **A block reports every 16 dispatches until it has run `warm`, then once at the threshold** (at most 255 at a
  time, a slot's quota; queued blocks every 16 for `BATCH_STEPS`): what a forward region's members need is the
  count up to `warm`, and the batch the crossing. At the floor of 500 it halves the cache's lock acquisitions,
  and Firefox's pages session compiled 20% less wasm at +6% busy MIPS, `smp_user_jit_4` −4.5%
  (`bench/interp/REPORT.md` "Loop 6 continued").

## Linking

- **Chaining:** a block whose successor is static (a direct branch, both sides of a conditional
  one, the fall-through after a cap, page end or a chaining system instruction) and compiled
  **tail-calls** it (`return_call`) with `acc + len` and `left − len` when `left` covers both (polled code: with
  `acc + len` and 0, a chain backward when its poll passes, forward always: [Preemption](#preemption-parallel-smps-polled-code)).
  Successors in the same batch are direct calls; already-compiled ones are imports of module `t`
  by table index.
- **A successor in another page (MMU on) is wherever its VA maps.** The block's PA plus the branch
  offset is its key only if the two pages are contiguous physically too: the kernel's image is, a
  process's file pages aren't. So a block compiled at that key is tail-called directly behind a
  check that the successor's VA hits the instruction TLB of the block's EL and maps to that
  block's host address. Nothing compiled there: the successor is found as an indirect branch's
  target is, by its VA in the transfer cache (below; `block::chain`). The check failed (seldom:
  the VA maps elsewhere now): the miss function, which looks it up without a transfer cache probe
  of the site's own, transferred to as the chain is (a call's a host call: [Calls](#calls); PERF loop 20,
  +0.7% wasm over a tail call) (~3% less wasm; going there for an uncompiled
  successor too lost: [Tried and not kept](#tried-and-not-kept)). Before M8 only the first half existed, and every
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
  were two (`emit::indirect`; a BR's, BLR's or RET's target comes from the branch's local, not a load of
  the PC it stored: V8 doesn't forward the store). The dispatcher fills an entry when it enters a block. A miss
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
  - **A flush by VA scans those 1024 slots (16 KiB) only for a page that instruction fetches
    translated** (`Tlb::xpages`, PERF loop 28): eight 4096-bit maps (by EL, global or nG, VA half) of
    the pages `Mmu::miss` translated for a fetch, cached or not, a page number folded to 12 bits (distinct within an
    aligned 16 MiB; a collision costs a scan).
    Every entry is filled for a fetch the instruction TLB translated (the dispatcher's key, the miss
    function's TLB probe), and a TLB entry came from such a miss, so the maps hold every page the
    live entries are for. The nG maps of an EL are cleared with its nG entries when its transfer
    cache's go too (`flush_ng`, the EL's `xng`), every map by a flush of everything; a bump alone
    (blocks dropped, a flush by VA in a half with block entries) clears none, as the TLB's entries
    stay and fill the cache again without a walk.
  - **Pages of blocks:** a flush by VA of one page of a block drops the TLB's entries for all of its pages
    (docs/cpu.md "Blocks"), and so must drop the transfer cache's for them, which the page's 1024 slots don't
    hold: it bumps the EL's generation when the EL's cache may hold entries for pages of blocks in that half
    (`Tlb::xblk`). That is the case while the EL's instruction TLB holds entries from blocks there (counted,
    `Tlb::xblkn`), and stays so after a bump that left some (the cache refills from them without a walk, and an
    entry outlives the TLB entry it came from), until a bump finds none. Linux's kernel text is in 2 MiB blocks,
    so every flush by VA in the kernel's half bumps EL1's; before PERF loop 29 a bump cleared the flag outright,
    and a refill from a hit after it left a block's entries live through the block's TLBI (`tests/baremetal/xblock.c`). Of the 60,054 flushes by VA in Alpine's boot and
    userspace benchmark 99.95% cleared nothing (they're for data pages); with the maps 1.8% scan
    (a scan ~0.4 µs in Node: ~10 ms of the boot's 3.6 s, 0.27%, and ~0.5% of the churn and shutdown
    phases before; under the gates' floor on the Mac: bench/boot/REPORT.md "PERF loop 28"). 4 KiB a vCPU.
  - **What reaches the miss function** (PERF loop 28, a diagnostic core, Alpine's userspace run in Node): a probe
    misses 23% of the time in the boot, 25% in the churn phase, 13% at shutdown and 1.5-8% in the compute phases; of
    the boot's 3.2M misses through a probe 2.1M find a zeroed entry (a target not entered yet), 0.95M another VA's
    and 0.13M an older generation. Until PERF loop 36 most calls in the compute phases (compress 2.0M of 2.3M, Lua
    1.8M of 2.0M) came instead from host returns that landed elsewhere than the call's continuation, a region's
    followed callee returning one host frame early ([Calls](#calls)): compress's calls are 0.31M now, Lua's 0.23M;
    a by-VA link whose check failed is rare (5,700 in the boot).
  - The stale-code checker, which needs the key, is called with `u64::MAX` on a hit
    (`jit_check` then computes the key from the PC).
- **Inside a region:** members are nested wasm `block`s; an edge to a later member is a `br`
  taken when `left` covers it; back-edges to the head branch to a wasm `loop` under the same
  budget check (the budget alone: no atomic load, since `left` never exceeds the chunk). Other
  edges leave through the tails above. An edge updates only `left`: a region with edges keeps
  `acc + left` at its entry in an i32 local (`emit::SUM`; edges and host calls keep the sum) and
  pushes `acc` as `SUM − left` where it leaves (`Func::acc`). Its exits grow by more than its
  edges shrink (+0.7% wasm), but a loop's lap has one add less: Alpine's Lua phase 1.7% faster
  on the Mac (`bench/boot/REPORT.md` "PERF loop 13"). Polled code has no `SUM`: an edge adds its block's length to
  `acc`, and only an edge to a member at or before its block's VA (the loop's back-edge) polls.
- **A tagged PC** (TBI: BR, BLR, RET or ERET through a pointer whose top byte isn't bit 55's
  sign extension): `AArch64.BranchAddr` drops the tag, so ADR, BL's X30 and ELR never see it.
  Compiled BR/BLR/RET and the block interpreter's don't strip it, which keeps their hot paths
  as they were: a tagged VA never fills the instruction TLB (`Mmu::miss`), so it misses the
  transfer cache, its miss function and the block interpreter's next-block probe (`ikey`), whose
  slow lookups (`Regime::key`) hand it to the dispatcher, which strips it (`Cpu::branch_addr`,
  one compare per dispatch) before it finds the block. The plain interpreter's BR/BLR/RET and
  ERET strip it themselves (`tests/jit.test.ts` "a branch through a tagged pointer").
- Dropping a block drops the blocks chained to it, transitively (the cache records who chains to
  whom).

## Calls

A guest call whose callee isn't taken into the region (`BL`, `BLR`) is a **wasm `call`**, and the callee's `ret` a
**wasm `return`**, so the host's own return predicts the guest's (`block::call`, `emit::transfer`). In Firefox's
pages session that's +10% busy MIPS on the Mac host and +11% in the dev VM, every page faster, for ~4% more wasm and
no more memory (`bench/boot/REPORT.md` "Guest calls as host calls, again"); the returns were 49% of the indirect
entries, whose first-instruction stall was 22% of a busy vCPU's time.
- **The depth:** every function takes a fourth parameter, how many host calls deep it runs (`emit::DEPTH`, 0 from
  the dispatcher). A call below `MAX_DEPTH` (**64**) passes the depth + 1; at the limit the call is a tail call as
  before, so a guest's deep recursion doesn't grow the host's stack past 64 frames. A `ret` at a depth above 0
  returns the retired count with `RETURNED` (bit 31) set and the target in the `Cpu`'s PC (`emit::ret_up`; polled
  code polls first, and a failed poll returns without `RETURNED`: [Preemption](#preemption-parallel-smps-polled-code)); at
  depth 0 it's an indirect transfer as before. The dispatcher asserts (release builds too) that a block it called
  returned without `RETURNED`: a depth that reached 0 with entry bits still set would count ~2³¹ steps.
- **After the call** (`emit::returned`): a result without `RETURNED` means the callee stopped (an exit, the budget,
  a block not compiled), and every caller returns it in turn, unwinding to the dispatcher. A returned one moves
  `acc`/`left` as if the callee's steps were the caller's, and if the PC is the call's continuation (the instruction
  after the BL/BLR) the region runs on there; if it isn't (a longjmp, a coroutine switch), the PC's block is found
  through the transfer cache's miss function (with the MMU off, the block returns). That is rare now: 5-31K a phase of
  Alpine's userspace run, 74K in its boot, under 0.3% of the host returns (PERF loop 36; the rule below).
- **A region follows a call only if the callee can't leave it** but by its predicted return (`block::forward`,
  `Region::open_call`): a followed call (`Region::follows`: the walk took the callee through that call) is a `br`, not
  a host call, so the frame it would have pushed is owed for as long as the callee runs. Every other call is a host
  call, even when its target is a member: the emitter decides by `follows`, not by the target's place in the region.
  Where each followed call's code runs is a fixpoint over the region's edges (a callee's branch to a block the walk
  took outside it runs that block inside the call too; a predicted return that matches its call runs on where that
  call's block does). A member that can run inside a followed call and branches to a block not taken, branches
  indirectly, takes an edge that checks its target's mapping (it may fail, then the edge is a chain), or ends on a
  `ret` not predicted to return after that call makes the innermost call a host call, and the region is walked again
  (until none is left open; each walk ≤ `REGION` blocks, `member` asked once per VA a walk reaches, and whether a block
  outside the batch heads a loop once per batch). The walks aren't bounded: 84-98% of Alpine's regions take one,
  ~0.5% five or more; a bound of 8 walks and a cache of the blocks a plan forms cut planning 4-7% but not the gates'
  times (`bench/boot/REPORT.md` "Regions of 64 blocks"). Before PERF loop 37 the emitter made any call to a later member or
  the head a `br`, and the rule saw only where the walk first took each member, so a second call to a callee taken
  (a helper called on both arms of an `if`, the machine outliner's `OUTLINED_FUNCTION`s), a callee that tail-called
  through a block taken outside it, a call back to the head and a checked edge inside a callee each still left with
  a frame owed (bench/boot/REPORT.md "PERF loop 37"). Before PERF loop 36 such a callee's exit
  was a tail call out of the region's function, and its `ret` a host return (`ret_up`) one frame early, to the region's
  caller, whose continuation it wasn't; that caller went to the miss function, and so did every frame above it in turn,
  each one frame off, up to the dispatcher. That was 10-16% of the host returns of Alpine's userspace phases and most of
  the miss function's calls there (compress 1.82M, Lua 1.61M, SQLite 1.03M a phase, the boot 1.57M; nearly every
  followed call could leave: of Lua's 8.6M, 3.1M did). With the rule: 5K, 15K, 11K and 74K; host calls +23-28%,
  followed calls −93 to −97%; wasm −3 to −4%; on the Mac Alpine's boot −2.7% and the userspace benchmark −2.5% (bench/boot/REPORT.md
  "PERF loop 36"). **Not kept: callees that complete inside but could leave** (PERF loop 50): following them would need
  every exit from inside a followed call to be a host call expecting the pending continuation, nested per pending
  call. Counted, they'd take 5-11% of the host calls away (Lua 4.2M of 38M a phase, SQLite 3.1M, the boot 2.4M), but a
  host call and its return cost only ~2 ns more than a `br` and a predicted return on the Mac (a leaf microbenchmark),
  so 0.2-0.3% of the userspace gate at most, against +4.6% wasm in the boot with every callee followed, before the
  nested exits' code: dropped (bench/boot/REPORT.md "PERF loop 50").
- **Continuations are entries:** the block after a call is a member of the caller's region and an **entry** of its
  function (`Region::entries`; none in a region with a `loop`, whose members sit inside it: a loop region, and a
  forward region with an edge back to its head, which is what a loop through a call is, `for (…) f(x);`: after anything
  that unwound inside `f` its continuation runs interpreted until compiled again as a head. **Not changed** (PERF loop
  51): counted, those continuations and the members after them run 0.01-0.07% of the steps interpreted (Alpine's
  boots and userspace, deterministic and parallel; Firefox's pages session 0.023%), 150-300K dispatches a gate run,
  under 0.5% of the boot's time at most; an entry inside a wasm `loop` needs a dispatch on every lap or the members
  emitted again outside it: bench/boot/REPORT.md "PERF loop 51"), because a return also
  reaches it from outside, at depth 0 after anything that unwound the host frames. Only a member where the head's
  page has it is an entry (the head's PA page, at its PA offset from the head): entered by its own VA, the function
  then has the head's mapping too, which the edges `Region::checked` leaves unchecked rely on. A continuation reached
  through another VA page that maps the same PA page isn't one. A region with entries takes no hot word (asserted):
  `emit::tier_up` runs before the entries' prologue. A block's word in the jump and
  transfer caches holds its function's table index in the low 24 bits (`IDX_MASK`, asserted) and its entry number
  above (`ENTRY_SHIFT`); a transfer passes the entry number above `ENTRY_BIT` (16) of the depth parameter, and the
  prologue clears it and branches to that member. Without the entry, a continuation ran interpreted until compiled
  again as a head (54% more dispatches in Firefox).
- **The stale-code checker** covers both new ways in: an entry at a member hashes the whole region (the members
  after it run too), and a host return into its caller is checked as an entry before the members run on (the
  callee may have rewritten them without an IC).
- **Locals:** the depth is local 128 as emitted (the encoder's placeholder indices go up to 255 and compact under
  128); a region that uses more than 127 locals besides the four parameters writes every index as two bytes
  (padded LEB128).
- **The host stack:** a dedicated worker's V8 stack leaves ~425 KB under the dispatcher in Chromium 155 (arm64). A
  host-call frame took ~270 B under Liftoff and about half under TurboFan for a block using all 32 V registers
  (~17 KB at depth 64, ~4%); a function with every local spilled would be ~1.6 KB, ~100 KB at 64, a quarter. A
  tier-up compiled at that depth added nothing measurable (`bench/boot/REPORT.md` "The host stack that host calls
  take").

## Preemption (parallel SMP's polled code)

In parallel SMP (what the page runs) compiled code carries **no step budget** (PERF loops 30-35; the user's decision,
[decisions.md](decisions.md) "JIT"): `Config::polled` (set for a VM with `VmConfig.smp` = 1) emits no
`left` checks, no `left -= len`, no `SUM`; a transfer passes `left` as 0. Round-robin (deterministic and realtime) and
user mode keep the counted code above, byte for byte (Alpine's boot dumped by both cores: the same 319 modules, two
differing only in the address of a core table they embed, the CRC tables).
- **`acc` stays** (steps and MIPS still count) and is a plain local: an edge adds its block's length to it.
- **The poll** (`emit::poll`): `acc < stop`, `stop` the vCPU's stop word (`jit::State::stop`, at a fixed `Vcpu`
  offset: `emit::STOP`), ANDed into the transfer's condition (hinted likely, as the budget check was), so a failed poll
  falls to the path a failed budget check took: the block returns to the dispatcher with its PC stored. No register is
  live across it. **A plain `i32.load`, but an `i32.atomic.load` on a looped region's edges** (PERF loop 34): an atomic
  load costs an alignment check (a test and a branch to a trap), an address add and an LDAR on arm64, ~7 instructions
  a poll more than a plain load folded into its offset; per function arm64 −1.4% instructions, x64 −2.1% (the same
  dumped set rewritten, `bench/boot/results/perf34/`). A plain load isn't guaranteed fresh: the memory model lets a compiler merge racy reads, and
  TurboFan (V8 14.6) does: in a stand-alone wasm `loop` of a load and a compare it loads the word once before the loop,
  and in a JIT region's loop it loads it once per four unrolled laps (the loop's stack check, a call on its slow path,
  makes it read memory again at the loop's head). So every poll on a looped region's edges (one of them is on every
  lap) is atomic; the other polls leave the function's invocation when they pass, and V8 reads the word again in each
  invocation and after every call (it inlines a few levels of a direct tail call into itself, merging their loads,
  then makes the real call). A read that did go stale is the chunk's steps or 0, so the chunk's bound holds whatever V8
  merges; only a setter's promptness could suffer. No test fails with plain loads on the loops too (today's V8 reads
  again often enough): `spin.c`'s `pure` shape, a loop of a register add, is there for a V8 that hoists further.
- **Where:** what can close a cycle, or repeat code with no transfer backward. A static transfer whose target is
  fixed (a region's edge, a chain to a compiled block, one through the jump cache) polls when its target's VA is at or
  before its block's start (the loop's back-edge, mostly), and a region's edge also when its target's key (its PA)
  isn't above its block's: a chain's key is its block's plus the offset, so it moves with the VA, but a region's
  member in another page was taken by the VA it was seen at (`block::forward`), whatever PA that VA mapped, and one
  physical page at successive VAs then makes a cycle of keys whose every transfer goes forward in VA (PERF loop 35, the
  final review: `spin.c`'s `xpage`). So along unpolled transfers to fixed targets the key only grows, and every cycle
  of them has a polled one. A **by-VA link** (a chain to another page that wasn't compiled with its
  block, found by its VA in the transfer cache) polls forward too: its target is whatever that VA maps now, so a run
  forward through VAs that alias pages already run reaches the same compiled blocks again with no backward transfer
  (PERF loop 33, the review of loop 31: a cycle of PCs has a backward step, a cycle of compiled blocks needn't).
  Indirect transfers poll always: BR, BLR and RET at depth 0 in the transfer cache's probe (with the MMU off, the jump
  cache's), and the miss function. A **host call's return** (`emit::ret_up`, a RET at depth above 0) polls too: it
  lands back in the caller with no transfer, so forward calls from a run of call sites to one callee, nested, would
  run steps multiplying with the depth (16 sites × 16 × a 16-step callee in `spin.c`; four levels of 256 would pass
  2^31 steps, where `acc` reads as `RETURNED`); a failed poll there returns the count without `RETURNED`, the stop
  every caller passes up. Unpolled, then, are only transfers to fixed targets at higher keys, which reach each key at most
  once: a run with no poll is bounded by the compiled code. Interpreted code doesn't poll: the dispatcher
  interprets at most `jit::POLLED_RUN` (32,768, a default chunk) steps before it reads the word again (the block
  interpreter, the debug interpreter of an EL armed for debug, one instruction at a time). A forward edge or chain to a
  fixed target checks nothing: in loop 30's counts those were 55-63% of the budget checks.
- **The word:** the parallel run loop stores the chunk's steps (`n`) there at the top of each pass, before it looks
  for work; the dispatcher passes the steps done as `acc` (so a block's polls compare the chunk's count) and stops
  when the word is at or under them. Whatever has news for the vCPU stores 0 after making it (platform.md "Parallel
  SMP"): the chunk then ends at the next poll instead of its steps. A chunk ends about where it did otherwise (at the
  first poll past `n`: 25 steps past it on average in Alpine's boot), so what has no event of its own (the vCPU's
  timer deadline, the worker's event-loop visit, the periodic publications, the PC sampler) keeps its bounds without
  a ticker thread, and `acc` stays far from `RETURNED`. `vm_set_chunk` may set chunks of up to 2^30 steps here (the
  spin tests'), past which only the setters end one.
- **No ticker** (PERF loop 32, bench/boot/REPORT.md): a chunk end costs ~0.2 µs of run loop (Node on the dev VM), at
  most ~0.5% of the gates' vCPU time, and 4× as many (8,192-step chunks) didn't move the Mac's gates. Longer chunks
  lose instead: 2^20 steps with nothing to end them slowed Alpine's boots 3.5-4.1%, because a chunk end is also where
  the vCPU sees its own timer and where the dispatcher installs the modules the compile worker finished (`Jit::fresh`:
  until then the block interpreter runs, +15M steps in the boot). A ticker in the run loop (chunks paced to the
  vCPU's next deadline by its measured rate, up to 2^20 steps, the compile worker storing 0 when `ready` moved) cut
  the chunk ends by steps 52-71% and kept the timer as prompt, and still didn't beat the steps bound on the Mac
  (every gate within ±0.7%, overlapping); a ticker thread can save no more chunk ends than that, so none was built.
- **What `acc` costs** (PERF loop 34, bench/boot/REPORT.md): a parameter live through every function and across its
  helper calls, so V8 spills it at each definition (the edges' bumps) and fills it at the polls and exits. A
  measurement core without it (`acc` a constant 0, polls `0 < word`; chunks then end only at exits and setters) has per
  function arm64 −2 to −3% instructions and **−9% frame memory operands**, x64 −3% and −10 to −11%; on the Mac (the
  compile worker storing 0 when modules were ready, so installs stayed prompt) Alpine's boots −1.0 to −2.0% to the
  script (n1 and n4 past the rounds' spread) and the userspace phases −2.5% (overlapping). So `acc` costs ~1-2% (all the polls,
  for comparison: arm64 −3.5% instructions, x64 −5.4%, with no spills of their own). It stays: it is the chunk's bound (the timer and the installs, PERF loop 32) and the step count
  the MIPS readout, the run loop's step clocks and the sampler use. **Re-measured on PERF loop 53's code** (bench/boot/REPORT.md "PERF loop 53"):
  the same bound on the gates (boots −0.8 to −2.3%, n4 −1.6% past the rounds' spread; userspace −0.8%), and **−3.6%
  on Firefox's pages session** in two sessions of runs (the noacc arm's fewer modules, its batch clock counting only
  interpreted steps, aren't the gain: that alone ran even). The setter its chunk bound needs for the vCPU's own timer
  exists: a ticker worker whose `Atomics.wait` takes half the time left, again, and spins the last 40 µs is 4-9 µs
  late on the Mac on average (p99 under 45 µs), where the chunk's steps give 31-80 µs today; a plain wait to the
  deadline is 158-561 µs late (macOS's timer leeway grows with the timeout), `Atomics.waitAsync` ~630 µs, `setTimeout`
  ~4.8 ms.
- **Tried and lost: polled code without `acc`** (PERF loops 53-57, bench/boot/REPORT.md "PERF loop 55" to "PERF loop
  57"): built as a second mode of polled code (`acc` the constant 0), with a ticker worker ending the chunks (the
  vCPUs' timer deadlines, the xHCI's due time, a 1 ms periodic tick), the compile worker and the window's write-watch
  storing 0 in the stop words, the step clocks by time, and the page counting only while its status bar showed MIPS or
  JIT share. The code was 4-5% smaller (per function arm64 −3.9% instructions, x64 −4.7%) with 11-13% fewer frame
  memory operands, but after its side costs were fixed (the batch clock by the run loop's time, the xHCI's and the
  ticker's synchronized stops spread out, PERF loop 56) it measured no faster on the Mac's pages session (73.1-74.5 s
  against the base's 72.3-76.2) and within ~1% on the parallel gates, all overlapping. Reverted in loop 57 (ABI 74):
  the conditional paths cost more to test and review than they gained.
- **No poll point is redundant** (PERF loop 34): each closes cycles no other one does. Polls only on a region's
  back-edge (not on its other edges to a lower VA) drop the polls 19% and hang a spin test: a cycle through other
  functions (the 20-block chain, out of its region and back through chains forward) has its one backward step on such
  an edge, a forward `br`. The miss function polls again after the probe that sent it there (1-4% of the polls, when
  the probe's tag missed): its poll is also the only one of a guarded chain whose guard failed, and the probe's failed
  poll falls to it, which would then run on. The form `word == 0` (no `acc`) saves nothing by itself (static ±0.1%:
  V8 compares with a register either way) and loses the chunk's bound.
- **Counted** (the diagnostic core's `poll` tally, `bench/boot/preempt-counts.ts`, PERF loop 35): 69 / 68 / 78 polls
  per 1000 steps (Alpine's parallel boot on 1 and 4 vCPUs, the userspace phases on 4); chunks ended early by the word
  0.3-0.9%. A parallel boot's modules against the counted code's, per function: arm64 −6.3% instructions and −5.7%
  frame memory operands, x64 −9.8% and −13.8% (PERF loop 31; loops 33-35 moved them under ±0.5%, loop 34 −1.4% /
  −2.1% instructions). On the Mac the gates moved ~1-2%; Firefox's pages session's starts and loads −4.7%, busy MIPS
  +3.4% (bench/boot/REPORT.md "PERF loop 35"; platform.md "Parallel SMP").

## Sharing

A VM's vCPUs share **one code cache** (`jit::Cache`, behind a lock: the block map, the page index,
the links, the pending batch, the slot allocator, the byte budget). Each function table is a
`jit::Table` (a vCPU worker's in parallel SMP, round-robin's one): the modules it has installed,
its jump cache and hot words, its helper counts and its counters.

- **One compile, one copy of the code:** a module's bytes don't depend on the table. Blocks reach
  the jump cache and the hot words through the vCPU (`emit::JC_PTR`, `emit::HOT_PTR`: one more
  load than the constant address they had), and a slot is the same table index in every table
  (every worker's core instance starts its table at the same length). So every table installs the
  same bytes at the same slots, and V8's process-wide native-module cache, keyed by the bytes,
  compiles a module once and shares its machine code between the workers. In Chromium 153 a
  second worker's first calls of an identical 5 MB module took 3.6 ms against 22.8 ms; different
  bytes paid in full again (`bench/boot/REPORT.md` "M8: one code cache for all vCPUs").
- **The log:** the cache keeps the modules compiled since the last flush, in order
  (`Cache::log`). A table catches up (`Table::sync`, under the lock) by copying the ones it lacks,
  and installs them in order once the lock is released (a module may import any before it): on a
  jump-cache miss that takes the lock (below), when the cache's `drops` moved (an atomic read
  before each block, without the lock), and in `jit_hot`, always before a block runs that could
  use them. Bytes every table has
  taken are freed (a table's copy to install shares them: `Arc<[u8]>`), and at most `HELD_MAX` (64 MiB) are held
  for tables that haven't taken them: past it the oldest go, and a table that lacked one (its vCPU offline, or
  asleep in WFI while the others compiled) can't install it or anything after it, so it interprets what's past its
  `limit` until its dispatcher next catches up and flushes the cache (`Table::catch_up`, counted as `lagFlushes`).
  Before, such a vCPU held the epoch's every module, up to the whole byte budget, in the core's heap. **No V8 compile runs under the lock** (only a table's two miss functions, once):
  a worker stalled in `jit_install` holding it kept the other vCPUs from even reaching their DSB
  (`tests/hoststall.test.ts`), and in a browser one worker's compile would hold up every vCPU's
  misses.
  - **What the lock costs** (counter words 108–113, `ab-summary`'s `locks`, `contended`, `waitMs`, `lockedMs`), and
    what takes it: a jump-cache miss for a block the cache hasn't given this table compiled (a new block, a decoded
    block's report every 16 dispatches, one queued in the pending batch, one compiled but not installed here yet),
    a catch-up, a tier-up, an IC, a flush. Three misses don't, since they need nothing from the cache:
    - **a compiled block the table has installed** (`Table::known`: every key a miss was answered with a compiled
      block for, this epoch, dropped with the jump cache's entries at a catch-up, cleared with it at a new epoch;
      at most a key per region slot, a few MB a table), when the jump cache lost it to another key; its decoded
      block then counts nothing, so its next jump-cache miss comes back here instead of running interpreted for
      16 dispatches;
    - **a decoded block put back in its slot** (262,144 direct-mapped, [cpu.md](cpu.md) "The block interpreter"):
      it keeps the quota it had left as well as its count, instead of reporting at once;
    - **a key with no instructions** (an SVC, say, at a block's start): the table's decoded blocks remember it
      (length 0, dropped with its page) and the cache was told the first time.

    Counted per caller (a diagnostic build, `bench/boot/results/m8-lock/screen.patch`), the pages session's 86 M
    acquisitions were 48% reports, 33% compiled blocks out of the jump cache, 16% new blocks; 62% were blocks put
    back in their decoded slot with no quota. Without the three: the pages session 85/86 M → 22 M acquisitions,
    5% → 2.4% contended, 22/24 s → 9.7 s waiting, busy MIPS 158/157 → 169; the churn screen 65 M → 39 M,
    37/39 s → 15.5 s, busy MIPS 190/192 → 220 (`bench/boot/REPORT.md` "M8: fewer acquisitions of the JIT cache's
    lock"). What takes it now is mostly real reports (38% on the churn), queued blocks' reports (27%) and
    compiled blocks not installed yet (15%). Emitting the modules is 3.5 s and 7.2 s of the held time, forming the
    batches 1 s and 2 s: emitting outside the lock and longer reports far from the threshold were tried
    ([Tried and not kept](#tried-and-not-kept)).
  - **A miss doesn't wait for it** (parallel SMP): with the short acquisitions gone, a wait that remained was 3 to 8
    times longer than before (18.5 µs on the pages session, 30–35 µs on the churn screen, 50 µs in the `go build`
    loop, against 5–6 µs), since it sat behind a table emitting a module (~1.25 ms each on the pages session). Nothing
    at a jump-cache miss needs the cache's answer at once, so a miss that finds the lock held (`try_lock`) runs its
    block interpreted, its decoded block keeping what it counted, and the next dispatch asks again (counter word 119,
    `ab-summary`'s `skipped`). Catch-ups, tier-ups, ICs and flushes still wait. With one table (round-robin, Node's
    deterministic runs) the miss takes the lock as before, so those runs are unchanged. On the dev VM the waiting fell
    by about 70% (the pages session 7.0 · 6.9 s → 2.2 s, the churn screen 10.1 · 9.9 s → 3.4 s, the `go build` loop
    4.1 · 4.2 s → 0.5 · 0.6 s), with 1.8–3.2 M misses run interpreted instead, and busy MIPS, `doneS`, the pages'
    loads and the stalls stayed within the A/A (`bench/boot/REPORT.md` "M8: a miss doesn't wait for the JIT cache's
    lock, and 2 KiB instruction cache lines").
- **The compile worker** (parallel SMP; `web/jit-compile-worker.ts`, `env.jit_compile` in
  [abi.md](abi.md)): the vCPU that emits a module hands a copy to one worker of the VM's (number
  `seq`, under the lock), which compiles it (`new WebAssembly.Module`: V8's process-wide module
  cache, keyed by the bytes, then holds it) and publishes the number up to which every module is
  compiled (`Cache::ready`, an atomic word in the core's memory). Before it publishes a module it
  posts the compiled `WebAssembly.Module` to every vCPU's host, which keeps it by number. A table
  installs a logged module only once `ready` has reached it, in order, and checks for that before
  each block (`Jit::fresh`) and at misses. The install instantiates the posted module
  (`env.jit_install` with its `seq`, ABI 37): `new WebAssembly.Module` from the bytes, even a cache
  hit, decodes and validates every function again before V8 finds the module in its cache, four
  fifths of an install's ~0.3 ms (`bench/boot/REPORT.md` "M8: the compile worker's modules,
  posted"). The posted module arrives through the vCPU worker's event loop, which a vCPU visits
  only now and then (`yieldMs`): if it isn't there yet the host says so, the table parks on it
  (`Table::parked`: not asked again until the vCPU has been out of the core) and the run ends at
  the chunk's end with `BUDGET` short of the budget, on which the vCPU worker goes through its
  event loop at once. Until then its blocks run in the block interpreter:
  a table dispatches only to indexes below its `limit` (the end of what it has installed), and
  fills its jump cache only with those; a tier-up's redirect (hot word and jump-cache entry) waits
  for its region in that table (`Table::redirect`). So no vCPU waits on V8 to compile, and none
  waits on another's compile of the same bytes (each used to install them together, all four
  stopped for the one compile). The worker keeps a module until its epoch ends or for 30 s (V8's
  cache holds one only while something does); a table that comes later compiles it itself, and one
  that has waited a second for the worker (it died, say) does too (`OVERDUE_NS`, counted). Without
  a worker (`jit_compile` returns 0: round-robin, Node's deterministic runs, `?jit=nocw` on the
  page) a module is ready at once and a table installs it as before.
  - **Why:** what stopped vCPUs at installs wasn't V8 compiling our few KB (0.35 ms on average)
    but its housekeeping: the wasm code GC holding up `NewNativeModule` (25-58 ms, every vCPU
    waiting on the one compile of the same bytes) and the JS heap's GC at an allocation (up to a
    second). With Firefox loading pages on 4 vCPUs, the worker took the stalls of 250 ms and more
    from 5-8 a session to none (the longest 1054 ms to 224) and the stalled time to a third; the
    boots and the userspace benchmark moved +0.3 to +2%, within noise (`bench/boot/REPORT.md`
    "M8: the JIT's compile worker"). V8's GC still stops a vCPU at an instantiation now and then.
- **Epochs:** a flush or `IC IALLU` starts the slots over. A table moves to the new epoch (jump
  cache cleared, slots overwritten) only from the dispatcher, never with JIT code on its stack;
  `jit_hot` in a table an epoch behind leaves the head alone. Its vCPUs' transfer caches drop
  their entries when the table's `drops` differs from theirs (`Tlb::xdrops`).
- **Invalidation:** `IC IVAU` drops the page's blocks from the cache at once (on the issuing
  vCPU), and logs the page for the tables' decoded blocks (`Cache::ival_log`, every IC, since a
  flush leaves decoded blocks the cache has no keys for); each table drops them from its jump
  cache and its decoded blocks when it catches up (`Cache::tables`: the keys
  dropped since, or all of it past 4,096). The keys an IC drops (the page's and their linkers') go to the
  tables and out of the pending batch once, not once a key. The broadcast drains don't touch the JIT any more. Until
  its table catches up a vCPU may run a dropped block, the window the tolerant cache allowed already.
- **Tier-up across tables:** a head redirects in each table on its own, when it gets hot there
  (`Cache::tiers`); a member's hot word that a region quiets keeps its redirect if it has one
  (another table may replay the enclosing tier-up after its member tiered up: `REDIRECT | 0` sent
  it to slot 0, a core function; found by `maint.bin` in parallel).
- **Counters** are per table: each vCPU publishes what it ran and what it compiled, flushed or
  invalidated, and the host sums them.
- **Measured** (Debian on 4 vCPUs in Chromium, a cold `go build` loop for 300 s,
  `bench/stress` with `--guest-cmd`): four caches of 40 MiB: 143–150 s a build, 296 MIPS median,
  ~76 flushes, 2–6% of the steps interpreted, the renderer at 3.1–3.7 GB; one shared cache of
  160 MiB: 48–81 s, 755 MIPS, 1 flush, ~0.1%, 3.2–3.5 GB. The benchmarks: `smp_user_jit_4`
  25% faster than with a cache per vCPU, every phase (Lua 7.5%, SQLite 10%, churn 43%; rechecked
  after the step-weighted batches, which turned the first measurement's 4–5% loss on Lua and SQLite
  into a gain: `bench/boot/REPORT.md` "M8: the shared cache's single-threaded phases,
  rechecked"), one vCPU 1–2% slower then; by PERF loop 14 (2026-11-10) what one table still pays for the sharing
  measured under 1%: the jump cache and hot words through the vCPU ≤0.4% of a gate's total, catch-ups with nothing to
  take (98% of a one-table run's 581K) nothing ([Tried and not kept](#tried-and-not-kept)). On one vCPU the same load
  compiled 227 MiB; four private caches compiled ~2.9× that.
- **What's left, counted** (PERF loop 14, `bench/boot/REPORT.md` "PERF loop 14: the shared cache's leftovers"): every
  table installs every module, those its vCPU never runs too: 0.7% of the churn screen's vCPU time is installs
  (83,424 of 20,856 modules, 2.84 s), ~0.6% of the pages session's busy vCPU time (0.60 s of ~100 s), so installing
  only what a table runs could save three quarters of that at best (≤0.5%). A lagging table's flush (`lagFlushes`) has never shown in a session; were it to, a lagging table
  could recompile only what it runs, or take the compile worker's modules if the host kept them for the epoch.
  Nearly every allocation of a run is under the cache's lock (all but ~2,000 of the userspace benchmark's 2.79 M,
  60% emitting modules), so they don't contend for the allocator's lock; they only lengthen holds, mostly the
  emitting. The ICs left on the churn screen (638K in 97 s, with 2 KiB lines) are a page each over code the guest
  wrote; coalescing them is for a guest that ignores CTR_EL0, none seen.

## Memory

What a compiled region costs the host, measured in headless Chromium 153 on the dev VM (Debian, 1 GiB
guest, 4 vCPUs; `bench/mem/`: `memsample.ts` samples the renderer's smaps by mapping, summaries in `results/summary.json`): **V8 spends ~10× a module's wasm bytes**,
~5× in C++ metadata (PartitionAlloc: NativeModule, wire bytes, code tables) and ~4.7× in code
(~4.7 KB per region at ~480 wasm bytes), and JS objects (Instances, exports) are small (the four
workers' JS heaps total ~200 MB). Until [Sharing](#sharing), **each vCPU worker compiled its own
copy** of the guest's code (its own cache, table and instances), so the total was ×ncpus. A 4-vCPU tab under a mixed load grew
from 2.3 GB at login to 5 GB in 8 minutes with nothing flushed (615K regions, 294 MB of wasm) and
was headed for the cache's 262,144 regions per vCPU: ~4.9 GB of V8 memory, the 6 GB tab. The
guest's invalidations (~700) and the tier-up's superseded heads (~1% of regions) are not what grows.
- **A module costs ~16 KB besides its functions** (Chromium 153: ~8 KB of PartitionAlloc, ~8 KB of
  V8's code space, its jump tables; Node ~10 KB): synthetic modules of 1 to 512 functions, the same
  30,720 functions in all, cost 24.7 KB per function in modules of one and 8.6 KB in modules of 64
  or more. Importing other modules' functions (`t`) adds ~0.1 KB per import. With the 1M-step
  timeout alone half of Alpine's userspace modules had one function; the step-weighted batch
  ([Compile policy](#compile-policy)) cut them 3,860 → 970 and V8's metadata for the same 34 MB
  of wasm 160 → 126 MB (the modules installed without running, so without code), the
  benchmark's peak renderer memory 1,113 → 1,082 MB (`bench/boot/REPORT.md` "M8: fewer, larger
  modules").
- **The byte budget** bounds it (320 MiB since 2026-10-20, 160 before): V8's share of a full cache is ~6-10× its
  bytes, flat (the uncapped run kept climbing). Firefox's pages session (2.5 GiB of guest RAM, 4 vCPUs; `bench/boot/REPORT.md`
  "M8: the carry timed, and a larger code cache") fills ~310 MiB at 320 without a flush: the renderer 5.1-5.4 GiB
  median against 4.6-4.7 at 160 (which flushed twice and compiled the same pages' code again), at most 5.7-5.8 GiB
  against 5.4-5.8 (at 160 MiB the peaks are the flushes' garbage), V8's wasm code ~1.2 GiB. The `go build`
  loop's renderer 3.4-3.8 GiB against 2.4-3.2. **Why 320:** the pages session no longer flushes (busy MIPS +16%,
  its heavy pages load a third faster), the gates and the `go build` loop are even, and it is about what the slots
  hold at Firefox's ~1.3 KB a region; the price is ~0.5 GiB of renderer memory while the cache is full.
- **Why a whole-cache flush, not aging or LRU:** compiled code has no per-block use counts (a block
  runs inside V8 without telling the core), so aging would need a counter update per block entry, the
  cost the design avoids everywhere; and links between blocks (`linkers`, direct calls by table index)
  make dropping a subset need the unlink walk that invalidation does. FIFO by module is the cheaper
  precise option (backlog); until then a flush is one clear of the maps, and the guest's hot set is
  recompiled in ~1–2 s of one vCPU's time.
- **What the budget was sized against** (before [Sharing](#sharing), 40 MiB per vCPU on 4): the
  live set of a Debian boot on 4 vCPUs (~31 MiB per vCPU), so booting didn't flush; a mixed load
  then flushed about every 3–4 minutes per vCPU, and a Go build about every 30 s (~6% of CPU in
  compiling). Steps per second looked unchanged then, but a `go build` loop timed by the guest
  (2026-10-03) took twice as long as with room for its ~200 MiB working set: after each flush hot
  code runs in the interpreter and in Liftoff again, which costs far more than the compiling.
- **A flush must free something on the host:** the host's table keeps the functions (so their
  instances and code) alive until the slots are overwritten, so `web/jit-host.ts` nulls the slots a flush
  leaves unused. V8 frees the dead code only when its JS GC collects the instances, and a worker's JS
  heap stays small, so that GC can lag by minutes: with the flush alone a Go build's tab peaked at
  9.6 GB (median 4.8 GB). After each flush the host allocates (and drops) a 256 MiB ArrayBuffer, whose
  external-memory pressure makes V8 collect: median 3.3 GB, p90 4.0–4.9 GB. Two of four runs still had one
  ~10 GB sample near their end that the sampler could not explain (not reproduced with 8 s sampling).
- **What an epoch keeps alive:** within an epoch the slots are bump-allocated (`Cache::alloc`) and never reused, and
  the host's table holds every function installed until a flush starts the slots over, so every module of the epoch
  lives until then, whatever its siblings. Little of it is dead (PERF loop 46, `bench/boot/REPORT.md` "PERF loop 46",
  a diagnostic core): of the functions the block map no longer names, 94% (Firefox's pages session, 3,665 of 3,907
  of 55,208) to all (Alpine's userspace) are loop heads compiled alone that tiered up, which stay live as the
  trampoline into their region for the blocks linked to them; the invalidated code is 0.5% of the pages session's
  109 MiB of wasm (0.1-3% in Alpine's runs), and modules with every function dead ≤ 0.05 MiB. So neither nulling dead
  slots on the host nor smaller modules would free anything worth their cost (a module costs ~16 KB besides its
  functions, above); writing the table from an active element segment (no exports object) bounds at ~19 MB of the
  pages session's renderer (~1.7 KB an instance, 2,768 modules on 4 tables), and wasn't built.
- **Measured** (mixed load, 450 s; `bench/mem/results/summary.json`, made by `bench/mem/summarize.mjs` from raw samples kept in bench/results/local): without the budget
  the renderer is 4.3 / 3.9 GB (median of two runs) and climbing, at 615K regions: 1486 MB
  PartitionAlloc, 1391 MB wasm code, 1283 MB linear memory (guest 1024 + the core's heap ~150), 221 MB
  JS heaps. With 40 MiB per vCPU: 3.2 GB median, 3.5 max, 8 flushes, 1.6% of CPU compiling (0.8%
  without). A/B at 3 alternating pairs (`bench/mem/results/`, `bench/run.ts` defaults): Alpine
  (no flush; 22 MB) `alpine_jit_total` 10977 (IQR 361, n=15) vs 10952 (IQR 1015): no measurable
  difference at n=15; Debian on one vCPU with a 40 MiB budget (one flush) `debian_jit_total_cold`
  47473 (IQR 1504, n=3) vs 45185 (IQR 3999): 5% slower, not separable from noise at n=3. So a
  single-cache VM gets the whole budget (then 160 MiB) (`Config::for_vcpus`; Debian's 73 MB boot never flushes) and
  only the 4-vCPU page runs at 40 MiB per cache. After a guest panic and `page.reload()` the renderer
  went from 3.55 GB to 1.2 GB at once (`mem-run6-crash` in the summary).
- **The page's memory check before a start** (`hostMemoryGiB`, `web/app/machine.ts`: RAM + 1 + 0.3 per vCPU, plus
  four times the machine's JIT budget past 160 MiB, `jitHostGiB`) matches the capped median of that mixed load and
  Firefox's pages session at 160 and 320 MiB (4.6-4.7 and 5.1-5.4 GiB with 2.5 GiB of RAM on 4 vCPUs, the rule's
  4.7 and 5.3); the peaks above it are the GC's lag.

### The core's heap

The core's heap is a fixed reserve (1 GiB, `HEAP_RESERVE` in web/vm.ts; [abi.md](abi.md) "A fixed-size memory"), and
running it out traps the machine. Everything the JIT keeps there is bounded:
- **The block map** (`Cache::map`: every block key a vCPU dispatched, compiled or not, with its count; `Info` is 16
  bytes, 25 a bucket) and its page index. At `MAP_KEYS` (900,000 keys), or when its full table would double past the
  2^20 buckets that hold them (`MAP_BUCKETS`), a **prune** (`Cache::prune`) keeps what the cache needs (compiled,
  queued, tiering or covered blocks), the keys reported in the last 262,144 keys added (`RECENT_TICKS` of the map's
  clock, `Cache::tick`: the code running now) and those counted `KEEP_HITS` (16) times reported in the last 2 M (on
  their way to the threshold), with their counts; it drops the rest from the page index and the links too, whose
  tables it keeps, as it keeps the map's: **a prune allocates nothing** (it runs with the heap near its mark, where a
  failed allocation traps; until PERF loop 43 it shrank the page index's tables and the links' to fit, which allocates
  them again, infallibly: 0.5 MiB in the unit test's prune of 900,000 keys, `a_prune_takes_no_memory`; the lists
  still shrink, which a reallocation down does in place in dlmalloc). **When the
  table would double:** the keys an IC removed leave tombstones that take its room (`HashMap::capacity` is the keys
  plus the room left, so it drops with each tombstone: counting the removals instead missed resizes), and with no room
  left hashbrown rehashes in place while the keys are at most half the table's (`reserve_rehash`: 458,752 at 2^20
  buckets) and doubles it past that. So the prune comes with no room, at least that half, and the table at 2^20
  buckets (it has held more than half of them, `map_full`; a smaller table full at that count grows to 2^20). One
  past the half, as it was until PERF loop 43, let the table double to 2^21 at exactly 458,752 keys (the review after
  loop 42). The table keeps its buckets, and since it was full the dropped keys leave tombstones, so the prune
  rehashes it in place (a reserve of the room past them, while that's at most half the table's). **When that can't
  be done:** a prune whose retains left the table more room than half of it (an erased slot becomes a tombstone only
  where the run of full and erased slots around it spans a group of the table's SIMD width, else empty: 8 on wasm32
  and aarch64, 16 with x86_64's SSE2, so the same erases leave far fewer tombstones there; the unit tests that need
  tombstones steer by the room left or take keys homed in one stretch of the table, and hold under either width)
  can't make hashbrown rehash (std's `HashMap` has no call for it; a reserve past the room doubles it), so its tombstones stay and the next prune can come after as little as the room past
  the kept keys (~9,000 keys added at worst). Not seen: the pages session prunes every ~0.8 M keys added, the churn
  every ~2 M. **The clock** is a u16 (it wraps at 2^30 keys added), and a prune brings the ages it keeps to at most
  `WARM_TICKS` old: under IC churn the table can go on rehashing in place without a prune for any number of keys, and
  with the u8 it had until PERF loop 43 a key last reported 256 ticks before a prune read as recent. **Why it stays** (bench/boot/REPORT.md "PERF loop 40"): rebuilt to fit, the keys
  growing back doubled it again after every prune, the old table and the new one living together with the heap near
  its maximum (with the bound at 2^21 buckets: the run-once churn's mark 333 MiB against a live maximum of 311, then
  313). Kept without the rehash, the tombstones (1.5 M) lengthened every probe and left no room: 7 prunes instead of 5,
  42 ms each instead of 36, and rehashes on demand. If that leaves more than half of `MAP_KEYS`, the needed and the recent keys stay; then only the needed;
  if even those are too many, the cache flushes. **Why recent ones too:** with only the warm ones kept, the prune
  (which lands in the pages session's bbc load, 210-240 s in) made that load 0.5-1 s slower: its code, reported a
  few times, counted from zero again, and each key coming back is formed again under the lock (that was at 2^21
  buckets, 2026-10, with a core at less than half today's speed). A prune that flushes (the needed keys past half
  of `MAP_KEYS`) and a rescue double the compile threshold's floor as every flush does ([Compile
  policy](#compile-policy)): both mean more code compiled than the map or the heap hold, which compiling less answers
  too. **Why 2^20 buckets** (bench/boot/REPORT.md "PERF
  loop 41"): the table holds what a prune keeps, not what makes code fast, and the keys a browser runs a few times are
  most of it. At 1.5 M keys (2^21 buckets, 50 MiB) Firefox's pages session never pruned and the table set the
  heap's mark when it doubled; at 900,000 the heap's mark is 27 MiB lower in the pages session (315 → 288 MiB) and in
  the run-once churn (312 → 284), at the same speed (`pagesS`, busy MIPS and the gates' rounds overlapping). The
  pages session then prunes 7-8 times, 22-24 ms each; the churn 13-15 times instead of 5, 21 ms each instead of 36.
  **What the keep rules decide there** (a diagnostic's counts): the recent keys alone are ~440,000 a prune in the
  pages session (they're those reported, not those added, in the last 262,144 keys added), more than half of
  `MAP_KEYS`, so its prunes keep only the needed keys (~67,000); the churn's keep the needed and the recent ones.
  ~3.5 M dropped keys come back in the pages session (of 6.2 M added, against 1.65 M added without a prune), ~55,000
  of them to be compiled, and 12% more of its steps run interpreted (3.55 G against 3.16 G): no slower for it. A
  prune that kept the warm keys before the recent ones (the needed and the warm fit in half) left 15% fewer keys to
  come back and 7% fewer steps interpreted, also no faster; and 450,000 keys (2^19 buckets) 16 MiB less again in
  the pages session (22 prunes) and 15 in the churn (51), no slower either, but its half (225,000) is near what a
  busy cache needs kept (a flush past it). So `KEEP_HITS`, `RECENT_TICKS`, `WARM_TICKS` and the half are set by
  nothing measured: what they change costs less than the noise. A key filed outside a miss, a member a module's
  install enters a region at that the map doesn't hold (`Cache::entry`), goes in only where the table has room
  without doubling past its bound by `room`'s rule, and the heap room for it (`try_reserve`), and is otherwise left
  out: its block runs interpreted until it's compiled as a head (an install can't prune or flush: a tier-up runs it
  from inside JIT code). Without that, a table at 2^20 buckets whose tombstones left room for one key let a miss's key
  take it, and the install that came due right after it doubled the table to 2^21 (50 MiB beside the 25 being copied,
  infallibly; the review after PERF loop 47). So the table never passes 2^20 buckets (25 MiB). A
  pruned key that runs again counts from what a table's decoded block counted since it last reported it (at most a
  report's quota, 255 once it had run `warm` times), not from zero. **Why:** the map held every key since the last flush, and with the 320 MiB budget
  flushes are rare: the desktop guest (4 vCPUs, Firefox's sites, then Chromium's) ran the heap out after 15 minutes
  and one flush when the table doubled from 2^22 buckets (`rust_oom` in `Jit::miss`, 2026-10-21). JavaScript
  engines' code that runs a few times, at addresses later reused, is most of those keys.
  **That session, replayed** (bench/boot/REPORT.md "PERF loop 44"): the desktop guest booted, 4 vCPUs, the 320 MiB
  budget, 15 minutes of six real sites (YouTube, three news sites, Excalidraw, Google Maps) in the guest's Chromium and
  then, in a session of its own, its Firefox: the block map stops at its 900,000 keys and prunes every ~16 s, the
  heap's live bytes stay at 281-284 MiB (Chromium) and 280-293 (Firefox, one flush at 845 s), its mark within 2.5 MiB
  of them, no rescue, nothing slower by the end. Of the live bytes 198 MiB are the decoded blocks (below), 29 the
  block map, 8.5-17 the known blocks, 48 the rest.
- **A table's decoded blocks** (`interp::block::Cache`): the arena of micro-ops (`BUDGET`: 16M micro-ops of 8 bytes,
  128 MiB, shared out among the tables, at most 64 MiB one: its capacity doubles up to its share and stops there,
  `Cache::grow`; grown as `Vec` grows, from its first block's length, it ended anywhere up to twice its share, 56
  MiB of a 32 MiB share for a first block of 7 micro-ops, PERF loop 48), and its map and page index, which also start over at
  `MAX_KEYS` (900,000: 2^20 buckets, 17 MiB) or a key per `KEY_UOPS` (4) micro-ops of its share, or when its full
  table would double past the one that holds them (no room, half that table's keys, the table at that size: the block
  map's rule) (a block of one micro-op, or none, filled the map long before the arena). On 4 vCPUs a table is ~50 MiB full: its arena 32 MiB,
  its map 17. **The budget is fixed, not the heap's room**, and the measurements say neither way pays:
  - **More room buys nothing measured.** In Firefox's pages session every table fills its arena three times (~0.75 M
    blocks a fill, ~5.5 micro-ops each; 11.2 M decodes). Twice the budget (8M a table, its map's 900,000 keys then
    what starts it over) cut the decodes to 8.5 M (−24%) and the JIT cache's lock acquisitions by 15%, for 96 MiB more
    heap (mark 315-329 → 411 MiB), and changed nothing else: Firefox's starts and the pages' loads 74.4 s either way,
    busy MIPS 450 and 449, three rounds overlapping (bench/boot/REPORT.md "PERF loop 38"). The half (2M a table, 16
    MiB with 8-byte micro-ops then) was −3.5% on Chromium's renders in the guest (bench/apps/REPORT.md "M8: the
    decoded blocks' arenas", 2026-10).
  - **Less use gives nothing back.** An arena that never fills (Alpine on 1 vCPU: ~1M micro-ops of its 8M) holds only
    what it decoded, and the heap is a fixed reserve whose allocator keeps what it frees: what the tab pays is the
    heap's mark, so a budget that followed the heap's room could only raise it.
- **A table's known blocks** (`Table::known`): at most the keys this epoch compiled that the table has run (a
  region's head, and its members entered at an entry, each a key of its own in one slot).
- **Module bytes** held for tables that haven't taken them: at most `HELD_MAX` ([Sharing](#sharing)).
- **The safety net:** before the block map, its page index (a new key's page and its place in the page's list), a
  table's decoded blocks or its known blocks grow, `try_reserve`; if the heap has no room the cache flushes (or the
  table's decoded blocks start over) and the maps are freed whole (a clear keeps their tables), counted as `rescues`
  (counter word 115), the block map's alone also as `mapRescues` (word 121, ABI 72). `tests/heap.test.ts` runs a
  guest of 4M `b .+4` in a 48 MiB heap through it (12 of the block map's rescues and 12 of the decoded blocks'; in
  64 the block map finds room since its bound is 2^20 buckets); the unit tests run a heap made full
  (`crate::test_heap`, the allocator's test hook) through the page index's. **Not covered, by
  measurement:** what a module's install files besides its members (`Cache::install`: the links, the heads filed under
  a region's other pages, the module log; the tiers its callers file; the checker's spans only in JIT-check and
  JIT-stress) grows those maps and lists without a `try_reserve`, also from a tier-up inside JIT code, which can't
  flush. It is small and bounded (bench/boot/REPORT.md "PERF loop 59"): in Firefox's pages session 94% of installs
  allocate, nearly all of it a links list's doubling, 5.7 MB in all over 200 s, the largest install 1.6 MB (a tier-up's
  0.8), the largest one allocation the links' table at 2^16 buckets (1.6 MiB; the run-once churn's: 3.7 MB, 0.8 MiB).
  By construction the links' keys are compiled keys, at most the block map's (a table of 2^20 buckets at most, 25
  MiB), and the tiers' and the log's at most an epoch's 262,144 slots (16.5 and 8 MiB); the sessions held 3-5% and 1-3%
  of those. Against the ~730 MiB the 1 GiB reserve leaves past the heaviest sessions' 275-293 MiB, a reserve on every
  install (it would have to sit between the emit and the module's log: a link can't be left out as a member can, since
  an IC must find every block that chains to the code it drops, so a failure would discard the module) isn't built.
  The links are bounded: a target's list of the blocks that link to it, about to grow, first
  drops the keys no longer compiled and the repeats (`Cache::link`; an IC drops the list of each key it drops, not
  the key from the lists it's in, and a block compiled again files itself again, so a long-lived target's list grew
  by a key at every IC and recompile of a block that links to it until the next flush, PERF loop 48). An allocation that still fails records its size and the heap's live bytes and mark for the
  host (the allocation error hook, `diag`: `handle_alloc_error` skips the panic hook, so the crash above came with
  no message); `tests/heap.test.ts` runs one out through `heap_probe` (ABI 50) on the exact core and the growable one.
- **The block map's page index** (`PageIndex`, for `IC IVAU`): a page's own keys by their low 12 bits (offset and
  regime bits; the page is the rest; a key is filed once, though an IC of another page that dropped it as a linker
  leaves it in its list), 2 bytes a key, and the regions filed under a page other than their head's by
  the head's whole key. Its byte count is exact (the lists' capacities, the tables whole with their tombstones, 8 bytes
  of allocator a list). It
  held whole keys before (8 bytes a key, a list's smallest allocation 32 bytes): tests/heap.test.ts's guest, 1024 keys
  a page, 0.9 M keys: the heap's live bytes 86 → 81 MiB, its mark 111 → 106 MiB; Firefox's pages session, 1.45 M
  keys: 294 → 283 MiB live, the mark 313 → 307, its speed the same (bench/boot/REPORT.md "M8: the core with exact
  memory limits"). **What it takes now, and why its lists stay** (bench/boot/REPORT.md "PERF loop 39"; in wasm a
  `Vec` header is 12 bytes and a bucket of the table of pages 25): in Firefox's pages session 5.1 MiB at 1.48 M keys
  (the lists 4.0 at 2.9 bytes a key, the table of pages 0.8, the allocator's words 0.2, the regions' heads 0.1), in
  the run-once churn 5.6 MiB at 1.40 M keys. Pages hold 59 and 47 keys on average; 2% and 3% hold one, so the table
  and the headers aren't what it costs. Lists threaded through `Info` (a 2-byte next key, the decoded blocks' way,
  room made by packing its flags) would leave ~0.5 MiB: at most ~4.5 MiB of a heap whose mark is 315-333 MiB
  (1-1.4%), for an `IC IVAU` path that must unlink a linker from the middle of another page's chain. Not built.
- **A prune** over 1.5 M keys (the bound before PERF loop 41) takes 6-11 ms natively, ~28 ms in wasm (Node, tests/heap.test.ts's guest, which keeps
  almost nothing: the rehash in place costs ~7 ms more there than rebuilding a small table did; counter word 120,
  `pruneNs`) and ~35 ms in the run-once churn on 4 vCPUs; over 900,000 keys 21-24 ms in the churn and the pages
  session, all of it under the cache's lock; in Node over tests/heap.test.ts's 900,000, 16-18 ms (keeping the page
  index's tables and the links' changed nothing there or in the sessions: bench/boot/REPORT.md "PERF loop 43").
- **What the page sees:** `vm_jit_gauge` (ABI 47) has the block map's keys (updated at each new key and each IC) and
  bytes (table and page index) and the held bytes, and each table's counters what its decoded and known blocks take
  (`decBytes`, `knownBytes`); the page's status carries them (`Vm.hostUse`, `stats().jit`). Every table is counted
  whole, from the most it has held with its room since it was allocated, as `capacity` leaves its tombstones out
  (until PERF loop 43 only the block map's was: the decoded blocks', the known blocks' and the page index's dropped
  with each IC, by up to half a table).

**What fills it** (4 vCPUs, 2.5 GiB, from the warm `pages` snapshot; MiB at the sample where the heap's live bytes
were highest). Firefox's pages session on the Mac (`bench/boot/results/perf38/`, three sessions, all alike):

| | live | decoded blocks | block map | known | held modules | the rest | mark | keys at most |
|---|---|---|---|---|---|---|---|---|
| the pages session (2026-11-21) | 315 | 206 | 55 | 9 | 0 | 45 | 315-329 | 1.48 M (no prune) |
| with the block map at 2^20 buckets (PERF loop 41) | 288 | | 28 | | | | 288-289 | 0.90 M (7-8 prunes) |

The decoded blocks are two thirds of it, at their bound (four tables of ~50 MiB, the first's map larger). **What sets
the mark:** the heap's live maximum. With the bound at 2^21 buckets, in the pages session the block map's table
doubled to them early, at 0.92 M keys, while the heap was ~285 MiB. In the run-once churn (`CHURN='rate=300&calls=120&n=2'`, 10 minutes: 5 prunes,
0.3 M `IC IVAU`s) the same doubling, before its first prune: 313 MiB against a live maximum of 311, with the table
kept across the prunes (rebuilt to fit, its doubling after each prune set the mark at 333: bench/boot/REPORT.md "PERF
loop 39", "PERF loop 40"). Where that first doubling lands in the heap's free space moves the mark by up to ~15 MiB
from session to session (315-329 in either). Before
8-byte micro-ops (the micro-op 16 bytes; `bench/boot/results/m8-heap/`), the same session then 10 minutes of the churn
screen:

| | live | decoded blocks | block map | known | held modules | the rest | mark | keys at most |
|---|---|---|---|---|---|---|---|---|
| bounded | 485 | 363 | 62 | 9 | 0 | 51 | 507 | 1.49 M (2 prunes) |
| unbounded (the same core, the bounds off) | 523 | 349 | 116 | 9 | 0 | 50 | 568 | 1.93 M |

There the decoded blocks were the arenas' 256 MiB and their maps ~100 MiB. The block map
of the unbounded core had doubled to 2^22 buckets (105 MiB) at 1.6 M keys; the session flushed every ~2 minutes in the
churn, so it never got further. The rest is the devices' buffers, the jump caches and hot words (~1 MiB each a
table), the threads' stacks. The held bytes peaked at 4-10 MiB (a vCPU that slept through modules).

### The page's memory signal

What the machine costs its tab, accounted from what the emulator knows (`web/app/memory.ts`), and a mark that tells a
crash afterwards. Measured in headless Chromium 153 against the renderer's smaps (`bench/mem/probe.ts`,
`bench/mem/calibrate.ts`; `bench/boot/REPORT.md` "M8: a machine's JIT budget and the page's memory signal"). **Wasm
bytes emitted aren't browser memory:** every factor here is the renderer's, measured.
- **`performance.measureUserAgentSpecificMemory()` can't be it.** It charges the shared `WebAssembly.Memory` (guest
  RAM, the core's heap reserve) at its whole reserved length **once per realm that holds it**: the machine worker,
  each vCPU worker, the compile, device and GPU workers (8 realms on 4 vCPUs: 28.9 GB reported for a 2.5 GiB guest
  whose memory 0 reserves 3.5 GiB, while the renderer used 3.0-4.7 GB; the main window holds none, 8 MB). Beside that
  it counts only JS heaps: across ~700 MB of V8 wasm code and ~400-800 MB of its metadata compiled, and across two
  flushes, its per-realm totals moved by 60-190 MB. Its types are all `JavaScript`. And it answers after 50-60 s
  (`ForceEagerMeasureMemory` didn't change that).
- **The estimate** (`estimate`): guest RAM whole (memory 0's and the spill memories'), the core's heap at its
  high-water mark (`heap_stats`, ABI 45: the global allocator counts its live bytes; dlmalloc keeps what it frees), the
  JIT's live wasm bytes (`vm_jit_gauge`: the modules since the last flush) × 5.7 (V8's code **4.0×**, smaps'
  executable anonymous mappings, 3.9-4.1 in every session; its C++ metadata ~1.7×) plus 16 KB a module, and 0.9 GiB +
  0.05 per vCPU for the rest of the tab. `Signal` adds a flushed epoch's code for 30 s after the flush (V8 frees it
  only when its GC collects the instances). Against smaps every 10 s through Firefox's pages and churn sessions at
  the default budget it runs **12-19% over the renderer's median** (the wasm memories are 73-76% resident: RAM the
  guest hasn't touched since a snapshot's restore, and heap reserved but unwritten: the 4-vCPU page's heap mark
  reaches ~510 MiB) and **under its spikes**: a flush's garbage took one 10 s sample of the churn to 8.6 GB against
  a 6.8 GB estimate. Guest RAM touched isn't counted (the core would have to mark pages at
  every TLB fill and device write): over a session a guest's page cache fills its RAM anyway. The virgl resources
  aren't in the renderer: their textures are the GPU process's, their backing is guest RAM, and the GPU worker's
  shared transfer buffers were 37-45 MB.
- **Where it goes:** the machine worker reads it each second into the status (`Status.memory`, `Vm.hostUse`, and the
  `Signal`'s estimate and peak, `Status.estimateBytes` and `peakBytes`, which the page's mark and Tab memory take). Past what
  `navigator.deviceMemory` reports (at most 8 in Chromium), it caps the JIT cache at what it holds then (the gauge's
  limit word, `G_LIMIT`: the cache flushes there and refills to it, never under 16 MiB). The flush comes at a
  dispatcher's emit, never at a tier-up: that runs inside JIT code (`jit_hot`), and checks for room and allocates its
  slots against one read of the limit, so a limit stored in between can't flush under the code on the stack. The page
  keeps a mark per running machine in `localStorage` (`waarm64.alive.<machine id>`: name, RAM, vCPUs, JIT budget, the
  estimate and its peak), renewed every 10 s and cleared at every clean stop (power off, restart, the guest's shutdown,
  a crash the page saw, the tab's `pagehide`). A mark no tab renewed for 30 s means the tab went away with the machine
  running, most likely killed for memory (Chromium gives a page no out-of-memory error): the next start says so and
  offers a 160 MiB (or 64 MiB) JIT cache, half the RAM, or to start as it is ([frontend.md](frontend.md) "Too little
  memory").

## Invalidation and the stale-code checker

- `CTR_EL0.DIC = 0`, so guests issue `IC IVAU`/`IC IALLU(IS)`, and **IminLine is 9 (2 KiB lines)**: an IC drops
  the whole page whatever the line, and Linux, libgcc's `__clear_cache` and the JITs' own loops step by the line,
  so a page takes 2 ICs instead of 64. Each IC takes the JIT cache's lock, ends the chunk and adds to the tables'
  invalidation log: Debian's boot to a login issued 2.12 M with 64-byte lines and 122 k with 2 KiB, its lock
  acquisitions 6.65 M → 2.51 M (with a miss not waiting too); the `go build` loop 286 k → 9 k (1/32). A process
  that read CTR_EL0 before (Firefox in a snapshot) keeps its old line until it starts again. Those leave the interpreter with
  `Exit::Invalidate(pa)` (`u64::MAX` for IALLU), and the run loop drops the blocks of that
  physical page (a map from page to the keys filed under it, so IVAU on a page without code costs
  one lookup) or all of them. Invalidation is per 4 KiB page; a forward region with blocks in
  several pages is filed under each.
- **The stale-code checker** (`jit::Config::check`, on in JIT-stress) hashes each block's words
  when it's compiled and again at every entry (chained entries and back-edges call
  `jit_check(vcpu, key)`), and panics (trapping the wasm run) on a mismatch. In parallel SMP
  another vCPU may legally rewrite code before its IC reaches this one: the cache is **tolerant**
  (`Cache::tolerant`), counting a stale block (`Stats::stale`) and dropping it at the run loop's
  entry instead ([platform.md](platform.md) "Broadcast maintenance"), and a block another vCPU's
  IC has dropped from the shared cache passes until this vCPU's table catches up.
- **Parallel SMP** also compiles DSB as a helper call (the interpreter's DSB ends the chunk under
  `cpu::FEATURE_PARALLEL`, where the run loop completes this vCPU's TLBI IS broadcasts); ISB and
  ERET were helper calls already and end the chunk the same way.
- **Fast completions** (parallel SMP in realtime mode, `jit::State::fast`, set by the run loop before each chunk
  while the vCPU has no TLBI IS of its own to wait for): the helpers finish in place, and the block goes on, the
  exits the run loop would only complete. A CNTVCT_EL0/CNTPCT_EL0 read takes the VM's counter (`Vm::now`). ISB, DSB,
  ERET and DAIF writes retire when nothing is queued for the vCPU (`CpuPar::pending`), its ASID is published, and
  no IRQ is signalled while IRQs are unmasked; any of those, and an SCTLR write that switches the interpreter copy,
  still end the chunk. An ISB also exits while the vCPU's table is behind the cache (`Jit::behind`: another vCPU's
  IC or a flush dropped blocks its links, jump cache and transfer cache may still reach), so the dispatcher catches
  up and the code after it is the new code (tests/baremetal/isb.c); the test is two relaxed loads and a flag, and the
  exit comes once per invalidation, not per ISB. A tier-up's catch-up inside JIT code (`jit_hot`) leaves the table
  behind (the flag): the transfer cache and the callers' continuations in host frames still have the old code
  until the dispatcher's catch-up. In the desktop guest (2026-10-22, `bench/imgdecode/README.md`) a vDSO `clock_gettime` went
  from 660 to ~250 ns (13.5 natively) and `isb; mrs cntvct_el0` from 613 to ~200 ns; Firefox showing images reads
  the counter ~12K times a second and takes ~37K such resyncs.
- **Device accesses** (parallel SMP in realtime mode, through `fast` as above): a load or store whose helper
  (`jit_exec_mmu`, `jit_exec_flat`, `jit_exec_span`) met a page with no RAM (`Exit::Fault(Bus)`) is run there and
  then through `vm::Io`, as the run loop would (`Vm::io_par`: the platform's lock, the device, `refresh` of the
  lines), and the block goes on, unless that leaves the run loop something to do: a `DEVICE` exit (a virtio or xHCI
  doorbell), a full TX ring, a fault (nothing there, a watchpoint), or an IRQ on the vCPU's line with IRQs unmasked
  (taken before the next instruction, as when the access ended the chunk). Then the outcome goes to
  `jit::State::io`, the helper reports the exit, and the run loop's `Exit::Fault(Bus)` takes it from there instead of
  running the access again (`debug_assert`ed empty at each chunk). Such an exit has retired the instruction, so a
  load's or store's failure arm (`emit::fallback_arm`) reloads from the `Cpu` the registers it writes that an earlier
  site's segment of the same chain stores from its locals (else the pre-access value of a destination or a writeback
  base would overwrite the access's; PERF loop 22, tests/baremetal/mmio.c's writeback case; code only where the chain
  has such a register, nothing on the fast path). Not in place either while another vCPU's TLBI IS waits for this
  one's drain (`par.pending`) or the xHCI's completions are due: the run loop's top does both, and a loop polling a
  register would hold them a chunk. What is left to the chunk's end, as for any code that doesn't exit: the timers'
  lines (`drive_timers`) and other vCPUs' IRQs arriving after the access, at most a chunk (32768 steps, about a
  millisecond of polling) late. With the TLB's device entries (docs/cpu.md "Pages
  with no RAM behind them") an MMIO read under the JIT went from ~0.21 to ~0.09 µs in a bare-metal loop (PL011's FR,
  GICD_CTLR, a 4 KiB Device page at level 3) and Debian's fw_cfg read of the agent from 76-78 to 44-46 ms (0.70 →
  0.41 µs a byte; bench/boot/REPORT.md "PERF loop 21"). tests/baremetal/mmio.c checks the reads' order, the faults
  from compiled code and the IRQ (planted: each condition dropped fails it or the parallel USB test).
  **What's left of a read** (~90 ns, Node's profile): the interpreter twice (the helper's try, which decodes and finds
  the device entry, and `Io`'s run, which fetches and decodes the word again: passing the helper's word instead
  measured nothing), the lock and `refresh` (~15%), the device's own work (PL011's `read` ~5%). An access compiled to
  a device call (the PA from the device entry in the slow arm, a helper per size that skips the decode) would save
  the decodes, perhaps 30-40 ns, for a new slow-arm form on every load and store (code size) and a second copy of
  `Io`'s dispatch; not built: at ~0.1 µs a read, nothing we run reads devices often enough (Debian's fw_cfg read,
  ~100K reads at boot, is the most) for it to show.
- **Counter reads compiled inline** (parallel SMP in realtime mode, `emit::counter`): a block with an `MRS` of
  CNTVCT_EL0 or CNTPCT_EL0 imports the host clock (`env.now_ms`, web/jit-host.ts's `jitHost` passes the core's own) and
  computes `Vm::now`'s reading from the vCPU's `jit::State::counter` (the clock's start, ticks a ms, the ticks it
  had then and the address of the VM's last reading, which a CAS loop raises, so no vCPU sees it go back), without
  the helper's call into the core; `Vm::now` computes it the same way, so both agree to the tick. The helper reads
  it while the run loop hasn't set the counter (`last` 0: deterministic mode, the clock not started) and at EL0
  without CNTKCTL_EL1's enable (it traps). In the desktop guest `mrs cntvct_el0` went from ~178 to ~115 ns (the
  host clock call ~115 of it: nothing cheaper than `performance.now()` exists in a worker) and `isb; mrs
  cntvct_el0` from ~200 to ~135; the boots, the userspace benchmark and the modules' size didn't move
  (bench/boot/REPORT.md "M8: counter reads compiled inline"). tests/baremetal/timer.c reads the counter for 50 ms
  at EL1 and EL0 so the compiled reads run (checks 45-47).
- **What an exit to the run loop costs** (`mrs cntfrq_el0`, which still exits, in a loop in the desktop guest): 413
  ns, then 372 with the JIT's ~40 counter words published every 64K steps instead of at every chunk's end
  (`JIT_PUBLISH`; the steps and the PC, the PC sampler's, still at every one), then 258 with the timers checked
  against the clock every 4096 steps or when their registers change (`TIMER_STEPS`) instead of at every iteration
  (~240 ns at the end; the boots and the userspace benchmark 2.0-2.6% faster, bench/boot/REPORT.md "M8: exits
  finished in place"):
  the host clock (`env.now_ms`, `performance.now()` through an import) costs ~115 ns a call. A timer that comes due
  is then taken up to 4096 steps late, as one inside a chunk always was, but a guest that looks sees it at once:
  every platform access other than a counter read (a timer's ISTATUS, ISR_EL1, the GIC's registers) drives the
  timer lines first (`drive_timers`; tests/baremetal/timer.c's check 12 polls ISTATUS and then reads ISR_EL1).
  **What's left, part by part** (2026-11-10, bench/boot/REPORT.md "PERF loop 15"; perf with V8's `--perf-basic-prof`
  in Node on the dev VM, a bare-metal loop of one exiting instruction with the MMU on, 2 vCPUs, parallel and realtime,
  timed by the host): a WFE yield, an exit with nothing to do, takes ~65 ns: `jit::steps`' re-entry (`key`, `enter`,
  `fresh`) a fifth, the run loop's own iteration (the atomics, the timer check's test, the chunk's set-up) a fifth,
  `jit_exec_mmu` (the interpreter decoding and running the exiting instruction in the helper; the word is decoded
  again by `count` and by `fast`) a fifth, then `publish_cpu` 4%, `handle_par` 3%, `Vm::counter`'s u128 division
  (every chunk) 2.5%, `drain` 2%. `mrs cntfrq_el0` takes ~150 ns: every `Exit::Platform` reads the host clock first
  (16% of it there, though CNTFRQ shows no timer), and the interpreter's MRS. A fast-completed ISB takes ~20 ns.
  Each part is a few ns, and exits are ~0.2-0.3% of a busy vCPU's time in a browser: nothing to cut.

## Emission (`emit.rs`)

- **Registers in locals:** each guest register a block's inline code touches lives in a local
  (an i64 for X0–X30 and SP, a v128 for V0–V31), loaded on first use and written back before
  helper calls and returns; after a helper every local is dropped. One pair of masks (`Regs`:
  valid, dirty; bits 0–31 the X registers and SP, 32–63 the V registers) tracks both kinds, so
  every rule below holds for both. The slow path of an FP fast path writes
  back every dirty register before its helper (a load's or store's only what the helper reads or
  writes: below) and drops the instruction's destinations (`written`, V ones included)
  after it, reloading what the fast arm had loaded, so both arms merge. Only the locals a
  function uses are declared (`wasm::Code::compact_locals`: past 12 locals, or with any not
  i32/i64, Liftoff zero-fills every one at each call, ~2.8% of Alpine's boot on the Mac: [v8.md](v8.md) "Costs that
  shaped the design"; a filled function's 21 locals are half X registers, which sharing locals wouldn't take out at a
  measurable gain: [Tried and not kept](#tried-and-not-kept)); registers read once and never written stay plain loads (for a V register read as a
  scalar lane, a scalar load: `Func::vlane`). In regions, each member starts in a fixed register
  state (the merge of its incoming edges, found by a first emission) and every edge conforms to
  it; the head's state is loaded once before the loop.
  Locals map: i64 scratch 2..=5, i32 6..=9, the flag locals 10..=16, X registers from 17 (in
  order of first use), V registers 49..=79 then 96, SHA's i32s 80..=95, FT's f64s 97..=99 and
  113..=117 (the double FMA's exact product and sums), PMULL's i64s 100..=112, FZOK 118, VT 119–122,
  FPOK 123, VTMP 124, TAKEN 125; past `DEPTH` (128) FP16's HOK 129 and HT 130..=137, SUM 138, the V registers'
  scalar shadows (f64 139..=170, f32 171..=202) and a scalar result's FR (f64) 203 and FR32 (f32) 204. A function
  that declares more than 128 of them takes two-byte indices for every local (padded LEB128, `compact_locals`).
- **Scalar shadows** (PERF loop 23, `Regs`'s `s32`/`s64`): a V register can also live in an f32 or f64 local that
  holds its lane 0, so scalar FP reads and writes it with no lane op (on the M4 these paths are bound by the SIMD
  pipes: "What the checks cost"). Scalar results go to the shadow alone (`Func::vset_f`: the v128 dropped), and a
  shadow-only register is the shadow zero-extended when dirty (a scalar write zeroes the rest), the `Cpu`'s value
  when clean. Readers: `vlanef` takes the shadow as it is (from the v128 it extracts once and keeps the shadow too);
  `vlane` reads a shadow-only register's lanes without changing the state (tests in branches read lanes); a vector
  reader builds the v128 from a dirty shadow (`v128.const 0` and `replace_lane`, two lane ops, kept) or loads a clean
  one; the FMA forms take a splat of the shadow (`vget_lo`: one op, lane 0 being all they read). A store of a
  shadow-only register is the shadow's `f64.store` (or `f32.store`) and zeros above it. SIMD&FP loads of a single or
  double go to the shadow when the next instruction in the block that names the register reads it as a scalar FP
  operand a shadow serves (`Func::scalar_next`: arithmetic, a scalar store), else to the v128 (`v128.load64_zero`,
  no lane op, which integer NEON code reads); scalar stores take the shadow when it holds the value; DUP's scalar
  form of a single or double extracts into the shadow (the next use of each register after each instruction comes
  from one backward pass over the block, `emit::scalar_uses`, made at its first single or double load: built for
  every block it cost Alpine's boot 7% of its emit time). Where states meet, `Regs::merge` keeps a register
  shadow-only when every side holds it in that shadow alone or not at all: dirty when every side holds it dirty so,
  else clean (a clean or absent side's `Cpu` upper bits aren't known to be zero), the edges where it is dirty storing
  the shadow and the zeros above it; anything else is a v128. A member's incoming state merges only its real
  predecessors: the head's includes the function's entry (nothing held, the `Cpu`'s values), so a loop-carried
  scalar is clean in its shadow at the head (the back-edge stores it, two stores and no lane op) and never dirty
  there, which would zero the upper bits of a register the first iteration leaves before writing. Conforming builds
  or loads what the target holds; a target dirty in a shadow alone must be so on the edge (`conform` asserts it), and
  a region whose entry states don't settle in four emissions makes those clean (`Regs::loose`), a form any edge
  conforms to. No register is held in both shadows without its v128 (`Regs::sound`). A failure chain's segment stores each register from the form it had at its site (recorded with the
  segment), and a site joins the chain only while those forms still hold; one that writes such a register with more
  bits than its shadow (a reload from the `Cpu` would lose them) starts a new chain, a group's leader counting the
  span's SIMD&FP loads and their widths (not reached by the tests: only a device access `Vm::fast` retires and still
  reports would). Cost
  of a scalar FADD on shadowed operands: the op and one lane op (its result's move to a general register for the
  check), where it was the op and five (two extracts, that move, `movi` and `ins`); the FP guest +9% on the Mac (`bench/boot/REPORT.md` "PERF loop 23"). A reduction
  loop (`ldr d1, [x0], #8; fadd d0, d0, d1; subs; b.ne`): no lane op from the loop on, where a head holding V0 and V1
  as v128s took six (PERF loop 24).
- **Peepholes in the encoder** (`wasm::Code`): a `local.set N` followed by `local.get N` is one
  `local.tee N` (1.4% of the wasm: HOST and scratch read at once), and an `add`, `sub`, `or` or
  `xor` of a just-pushed `i32/i64.const 0` drops both (an access's address at offset 0, `ADD #0`).
  Neither merges across a `mark` or right after a `rewind` (`Code::fence`): marks nest, so the code
  can only be at the latest one, and a rewind to it must find the code as it was.
- **Lazy NZCV:** ADDS/SUBS, ADCS/SBCS, ANDS/BICS keep their operands (or result) in flag locals
  and record their kind; a setter replaced by the next one emits no flag code. Conditions (B.cond,
  CSEL & co, CCMP, ADC's carry) come straight from the operands where the kind allows (SUBS: EQ,
  CS, HI, GE, GT and inverses; ADDS: EQ, CS, MI; logical: all), else from NZCV computed in
  registers. On the cold paths (a failure chain's return, a slow arm, the FP guard's exit) a SUBS's
  or ADDS's NZCV is a call of one of the module's four helpers (`emit::nzcv_helper`, defined after
  the regions and not exported) instead of ~70 bytes inline: 1.6% of the wasm. NZCV is stored before helpers, on a load/store's failure return, and **before** the
  block's branch (after it, TurboFan ran the integer guest 35% slower). In regions, a member
  starts with lazy flags when every edge into it carries the same setter, else in memory or dead;
  an edge stores NZCV only into a member that needs it in memory, and exits store it; a region
  whose edges disagree is emitted again with flags in memory. A loop's head is never lazy (the
  function enters it with NZCV in memory), so its back-edges store NZCV unless a setter comes
  before anything that could read it, a cold path's store included: measured, not worth changing
  ([Tried and not kept](#tried-and-not-kept), "Lazy NZCV at a loop's head").
- **The PC on the way out:** a block whose successors are all members doesn't store the next PC
  (`Func::defer_pc`; a conditional branch keeps its outcome in `TAKEN`); only the exit paths do.
- **Integer:** MOVZ/N/K, ADR/ADRP (ADRP's page is the entry PC plus a constant, `Func::page`: a
  function runs at any VA of its PA, and a VA keeps the PA's page offset), ADD/SUB (all forms, S or not), ADC/SBC(S), logical, bitfield
  moves and aliases, EXTR, variable shifts, CSEL & co, CCMP/CCMN, MADD/MSUB and the long
  multiplies, SMULH/UMULH (from 32-bit halves: wasm has no wide multiply), UDIV/SDIV (with `if`s
  where wasm traps), REV*/RBIT/CLZ/CLS, all branches, the NOP hints. 32-bit forms run on i32 and
  zero-extend. UBFM's LSR and LSL forms are one shift (the rotate and mask for the rest), SBFM's
  SXTB/SXTH/SXTW wasm's `extendN_s`, CSET and CSETM the condition itself (`eqz`, or `− 1`).
  An instruction is inline only if its handler can't fail, decided from the word.
- **Loads and stores (the TLB fast path):** through the TLB array of the block's EL (static:
  EL is in the key), tag = `(va + len − 1) | 0xfff`, host = `va + addend`, entry offset
  `(va >> 5) & 0x7ff80` plus the array's `16 × (3·el + use)`: the six arrays are interleaved by
  index (`mmu::Tlb`), so every array's offset from the `Vcpu` stays under 0x800 and V8 folds it into
  the load (separate arrays at 0x30540 and up took a `mov`+`movk` for each tag and addend); with the
  MMU off a bounds check against RAM, whose layout the block embeds.
  Every addressing form of LDR/STR, LDP/STP/LDPSW/LDNP/STNP, LDR literal, PRFM, SIMD&FP single and
  pair, LD1/ST1 multiple and of one lane (a narrow load into the V register's lane, the others
  kept), LDTR/STTR (through EL0's TLB arrays). On a machine with spill memory, an entry for a page of spill
  memory 1 takes a second arm in the cold path: the body again, its RAM accesses naming memory 1
  ([spill-memories.md](spill-memories.md) "The JIT's spill arm"). Anything else (a miss, a fault,
  MMIO, a page-crossing access, a misaligned SP base) calls a helper that re-executes the whole
  instruction: the fast path changes nothing before its check, so fault state is exact by
  construction. Every guest RAM access in generated code goes through one lowering function
  (layout A's single point of change).
  **Groups share one probe** (`emit::plan`, with the MMU on): two or more loads and stores with an immediate offset off
  one base register, unchanged between them but by their writebacks and `ADD`/`SUB` of an immediate to it, over at most
  256 bytes, with at most four flagless inline integer instructions among them that leave `HOST` alone (each emitted
  once on its own to check: `emit::between`). The leader probes the group's whole span from its lowest address (the same
  compare, the span as the length), in the write array if a member stores (a page's write permission implies read, and
  debug watchpoints bypass the fast paths), and its fast arm stays open over the span: every member's body takes `HOST`
  (the lowest address's) with its own offset as the memarg, and a follower emits no address, probe or slow arm. With
  spill memories the `else` first takes each inline one's arm: the span emitted again, its accesses naming that memory
  (ADDR, BASE and TLBE still hold the leader's there, the fast arm not having run). On a miss (no entry, the span across
  a page, a fault, MMIO, SP misaligned, FP off) the `else` calls `jit_exec_span` with the span's words as constants, up
  to six a call, so the arm's size doesn't grow with the group's; it returns how many retired, and the first that doesn't
  leaves through the leader's segment of the failure chain. The arm writes back what the span reads or writes first and
  reloads what it writes after, and on a failure reloads those of them earlier sites' segments store (from their locals)
  before it leaves, or the chain would undo what the instructions before it retired. A load into the base ends its
  group; LDTR/STTR, exclusives and register offsets never join one. Measured on Firefox's pages session
  (`bench/boot/REPORT.md` "Groups of accesses, measured"): 32.6% of guest instructions are loads and stores, 92.8% of
  those immediate forms; groups leave 74-75% of their probes; 0.58% of group runs straddle a page. What's left
  isn't built ([Tried and not kept](#tried-and-not-kept), "Wider groups of accesses").
  **The slow arms share their failure exits** (`emit::Chain`, `fallback_chain`): the arm writes back only the
  dirty registers the instruction reads (its fast path's reads, `Func::ireads`) or writes, calls the helper, and
  if that doesn't retire branches with its retired count to its segment of the block's failure chain. A segment
  stores the registers dirty at its site that no earlier site's segment stores, then falls through the earlier
  ones to one lazy-flag store and one `return`. Segments are nested `block (result i32)`s opened at the sites,
  at the instruction level; a site joins the open chain while every register it stores is still valid and the
  sites' lazy flags have the same kind and size (the flag locals then hold the failing site's setter), else a
  new chain starts (after every helper call, which drops the locals); the chain closes at the block's end. The
  helper reads and writes nothing else, and the run loop takes its exception after the block returns, so
  the other registers stay in their locals on both arms. Before, each arm wrote back every dirty register and
  stored the flags itself: Alpine's boot made 6.1% less wasm with it, Liftoff 8.6% less code and TurboFan 6%
  (`bench/boot/REPORT.md` "M8: smaller slow arms of loads and stores").
- **Atomics:** LDAR/STLR (and FEAT_LRCPC's LDAPR*, as LDAR; FEAT_LRCPC2's LDAPUR* and STLUR* as LDAR and STLR at
  base + imm9, sign-extended loads after the atomic load, an SP base guarded for both its alignment and the access's) as aligned wasm atomics, single exclusives and the LSE atomics
  (add/clr/eor/set/swp as `atomic.rmw`, CAS as `cmpxchg`) inline; DC ZVA as a 64-byte zero.
  CASP inline too: the W pair as one 64-bit `cmpxchg`, the X pair as `Mem::cas_pair`'s protocol
  ([cpu.md](cpu.md) "Memory accesses and atomics"), its pair lock taken with an
  `i32.atomic.rmw.xchg` at the lock's address (`Ctx::pair_locks`, boxed so it never moves) in
  parallel SMP only: with vCPUs sharing a thread no other pair op runs meanwhile. The exclusive
  pairs likewise (M8): of two W registers an 8-byte exclusive; LDXP of two X registers reads the
  16 bytes as CASP does and arms the monitor with both halves, and STXP is CASP of the monitor's
  pair. That took the atomics stress's LL/SC `stack` (LDXP/STLXP, 4 parallel vCPUs, 10⁶
  iterations a thread; Node, ad hoc) from 5.6 to 3.8 s. CASP's gain on Alpine's boot is bounded by
  the helper's cost (SLUB's `cmpxchg128`, ~300K calls, ~30 ms of a ~10 s boot): under the noise,
  not measured.
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
  TPIDR_EL1 were 91% of Alpine's MRS calls); the MSRs above inline, and DAIFClr and `MSR DIT, #imm`
  (Linux 6.x sets DIT at every kernel entry: one per syscall and IRQ). An MSR that unmasks IRQs (DAIF,
  DAIFClr) stays inline while `jit::State::unmask` says its `Exit::Resync` would find no IRQ to take:
  deterministic round-robin's run loop sets `ok` before each chunk when the GIC signals none to the vCPU
  (nothing raises one within a chunk but an exit: deadlines bound deterministic chunks, devices and
  GIC writes exit) and the xHCI has no event due (its tick fires at the next chunk boundary, which the
  exit would bring forward: the USB guest's JIT run then parted from the interpreter's), and points `irq` at the VM's
  signal word, whose low byte the block loads atomically: a host signal (a completion, console input, a stop) that
  arrives mid-chunk sends the unmask to its exit, which brings the run loop's signal checks forward as before (PERF
  loop 20). Realtime round-robin never
  sets it: its chunks don't end at deadlines and devices signal at any time, so a timer that came due under the mask
  waited for the chunk's end (up to 32K steps; `tests/baremetal/unmask.c`, PERF loop 9). Parallel SMP sets it when the
  chunk has fast completions, and there the block also loads two atomic bytes, the vCPU's IRQ line (`CpuPar::irq`) and
  its queue's `pending`, as `fast` would decide (without the drain, another vCPU's TLBI IS waits in its DSB for this
  one's next drain point); not the published ASID, which a DAIF write doesn't synchronize (the ISB after a TTBR write
  ends the chunk). Else, and for ERET, the helper's `Exit::Resync` lets the run loop take it. Steps don't move
  (deterministic chunks end at the same places). The differential test runs the inline arm against the interpreter
  through `jit_unmask` (and `jit_parallel`, ABI 64), and counts the helper calls each condition sends there (a
  round-robin block's signal byte, a parallel one's IRQ and pending bytes);
  `unmask.c` checks the latency in realtime round-robin.
- **Counter reads from the step clock** (counted code in deterministic round-robin, PERF loop 47, `emit::step_counter`):
  a tick a step, so `MRS CNTVCT_EL0`/`CNTPCT_EL0` reads the steps retired before it plus the ticks WFI skipped. The
  run loop stores the counter as of the chunk's end (`jit::State::ticks`, `Vm::steps` + the chunk's *n* + `skipped`)
  before each chunk, and the block subtracts the steps still to run: `end - (left - k)`, `left` the budget at the
  member's entry and *k* the instructions before the read (one load, a subtraction, no call). The helper's exit stays
  where it would do more than read: `end` 0 in realtime mode, with another `ticks_per_insn`, and while the xHCI has
  an event due (the exit would fire it earlier and move the steps: planting that out moved the USB guest's JIT run
  off the interpreter's, 188,563,323 → 193,007,148), and at EL0 without CNTKCTL_EL1's enable (it traps). A host signal
  arriving mid-chunk waits for the chunk's end, as it does for any code without exits (an inline check of the signal
  byte, as the unmask's, changed what no test sees and was left out). Polled code keeps the helper (parallel SMP is
  realtime: the host clock above). Steps don't move (Alpine's boot and userspace benchmark as in tests/steps.txt);
  the deterministic gates' counter-read exits went from 0.31M (boot) and 1.20M (userspace) to 3.7K each, the reads
  left in interpreted code. `tests/baremetal/counter.c` reads the counter at a loop's head and further in, in a
  callee, after a forward edge and at EL0 with and without the enable, and prints a hash of every reading: the
  deterministic runs compare it between the interpreter and the JIT (planted: *k* dropped changes the hash; the EL0
  check dropped fails it and timer.c).
- **Timer registers from the step clock** (counted code in deterministic round-robin at EL1, PERF loop 49,
  `emit::timer_mrs`, `emit::timer_msr`): MRS of CNTV_/CNTP_ CTL, CVAL and TVAL computes what `interp::platform`
  would at the counter `end - (left - k)` (CTL's ISTATUS: enabled and the count at CVAL or past; TVAL: CVAL less the
  count, 32 bits). An MSR stays in the block when `end` is set and the timer's new state fires nothing before the
  chunk's end: disabled, masked, or CVAL at `end` or later (`cval >= end`; at `end` it fires at the chunk's end, as
  the exit's next chunk, cut at that deadline, would have). The run loop cut the chunk at the timers' old deadlines,
  so no deadline falls inside it either way. What the exit did besides is drive the timer's line into the GIC at the
  run loop's next look; a write that lowers it (Linux's handler masks the timer that fired) would leave the GIC
  seeing it high, so the code sets `StepClock::wrote` and the run loop drives the vCPU's two timer lines
  (`Vm::timer_lines`) when the chunk returns, before its exit runs (an ICC_IAR1 or ISR_EL1 read, a GIC MMIO access)
  and before the next look for an IRQ. Nothing in a chunk without exits sees the GIC, and the lines then are what the
  exit's would be (the new state fires nothing before `end`). A write that would fire inside the chunk takes the
  helper's exit, as at EL0 (CNTKCTL_EL1 may trap it) and while `end` is 0; those MSRs no longer end a block
  (`sys::msr_continues`), so the exit leaves mid-block as a helper's does. Steps don't move; Alpine's ticks keep two
  platform exits of their seven (ICC_IAR1, ICC_EOIR1: the GIC's state is the run loop's). `tests/baremetal/timerjit.c`
  arms the physical timer a few hundred ticks ahead (the chunk's end) and the virtual one 50 and 1 ticks before
  it, at it and 1 and 50 after it, through CVAL and TVAL, enabled before or after the compare value, hashes the
  counter at each IRQ and the registers' readings, and masks a fired timer inline before reading ISR_EL1 and
  ICC_IAR1 (planted: `wrote`'s refresh dropped fails it at once; the condition dropped, or `cval + 1 >= end`, moves
  the hash and the steps; TVAL's *k* dropped or its write zero-extended moves the hash or hangs it).
  SIMD&FP instructions check `CPACR_EL1.FPEN` once per block.
- **NEON → SIMD128** (`emit/simd.rs`): handler by handler after the interpreter's: three-same,
  shifts, moves and immediates, widening/narrowing, reductions, compares against zero, UZP/TRN/ZIP
  (one shuffle of Vn:Vm built from the interpreter's lane formula), TBL/TBX (as `i8x16.swizzle`,
  never `relaxed_swizzle`, whose out-of-range lanes aren't deterministic), SQADD/UQADD/SQSUB/UQSUB
  on 8- and 16-bit lanes as `add_sat`/`sub_sat` (FPSR.QC from a compare against the wrapping
  result) and their scalar forms at every size in i64 arithmetic. Also as SIMD128: MUL/MLA/MLS
  and the long multiplies by element (Vm's lane splat by a shuffle, then the vector form, `extmul`
  for the long ones), SQDMULH/SQRDMULH (`q15mulr_sat_s` for SQRDMULH on halfwords, else the exact
  product at twice the width; only MIN × MIN saturates), the halving adds and subtracts, SABD/UABD
  and SABA/UABA, the pairwise forms, ADDHN/SUBHN/RADDHN/RSUBHN, SABDL/SABAL, the rounding shifts
  and the narrowing shifts (rounding as `(x >> s) + (x >> (s − 1) & 1)`, no overflow), the
  saturating narrows and SQXTN/SQXTUN (wasm's `narrow` after a `min_u` for unsigned sources; QC
  where the narrowed lane widened isn't the source), SQSHL/UQSHL/SQSHLU by immediate on bytes and
  halfwords (at twice the width, then narrowed), SQABS/SQNEG, SHLL, RBIT (a nibble swizzle), 8-bit
  MUL and PMUL/PMULL on bytes (eight shifted partial products).
- **SDOT and UDOT** (`simd::inline_dot`, FEAT_DotProd): wasm has no dot product, so two `extmul`s, two shuffles
  gathering each 32-bit lane's pairs, two `extadd_pairwise`s, an add of those, and Vd added last: about 7 host
  instructions against SDOT's one, if V8 folds the middle add into a SADALP on arm64 as its timings suggest. **The order matters** (ns a dot on the
  M4, accumulating into one register / independent results): this order 0.51 / 0.45; the pairs added before
  gathering (an ADDP in shuffles, 8 instructions) 0.51 / 0.51; `i32x4.dot_i16x8_s` on even and odd bytes 0.88 /
  0.89; two SADALPs onto Vd 1.45 / 0.38, whose accumulator chain is what sum loops hit. The ADDP order ran x264
  medium 6.8% slower than its NEON path; this one is level with it (bench/boot/REPORT.md "FEAT_DotProd and FEAT_JSCVT, measured").
- **USDOT, SUDOT, SMMLA, UMMLA and USMMLA** (`simd::inline_i8mm`, FEAT_I8MM): a product of bytes of mixed signs
  has no `extmul`, so USDOT and SUDOT widen each side by its own sign (four `extend`s), multiply 16-bit lanes
  exactly (an unsigned by a signed byte fits) and then sum as SDOT does (two shuffles, two signed `extadd_pairwise`,
  Vd last): about 12 host instructions. The matrix forms make the four row-by-column products of eight bytes
  (SMMLA and UMMLA: four `extmul`s of Vn with Vm and with Vm's halves swapped; USMMLA: widened and multiplied),
  pair each to 32 bits (`extadd_pairwise`, unsigned for UMMLA, whose products are unsigned 16-bit) and sum each
  across in two levels of shuffles (an ADDP of ADDPs), Vd added last: about 19 and 22 instructions against
  SMMLA's one. Measured in bench/boot/REPORT.md "PERF loop 5: FEAT_I8MM".
- **SQRDMLAH and SQRDMLSH** (`simd::inline_rdm`, scalar forms `simd_lane::inline_rdm`, FEAT_RDM): Vd ± the doubled
  product's rounded high half, saturated once, is Vd + ((±xy + 2^(esize−2)) >> (esize − 1)). On halfwords
  `q15mulr_sat_s` is that high half except for MIN × MIN (1.0, which it saturates to MAX): a saturating add of it and
  then a saturating subtract of the MIN × MIN mask (−1) put the missing 1 back. SQRDMLSH rounds −2xy, so a tie
  (the product's low 15 bits 0x4000, from `i16x8.mul`) rounds the other way: the mask of those lanes added first.
  QC where the result isn't the wrapping sum. About 10 host instructions with the QC check (SQRDMLSH 14), about what
  SQRDMULH and SQADD, a guest's path without RDM, cost between them with theirs. On words the exact products in i64 lanes (`extmul`), the rounded
  shift, Vd widened and added, and the sum saturated where its low half sign-extended isn't it (`i64x2.ne`, MAX or
  MIN from its sign by `bitselect`), the low halves gathered by one shuffle: about 30 for the Q form, where SQADD
  on words is lane by lane. The scalar forms in i64 arithmetic. Measured in bench/boot/REPORT.md "PERF loop 6:
  FEAT_RDM and FEAT_LRCPC2".
- **NEON lane by lane** (`emit/simd_lane.rs`): what wasm has no lane op for, in i64 arithmetic per
  lane after the interpreter's i128 formulas: the saturating adds and subtracts on 32- and 64-bit
  lanes, SSHL/USHL/SRSHL/URSHL/SQSHL/UQSHL/SQRSHL/UQRSHL by register, the saturating shifts by
  immediate on 32- and 64-bit lanes, the narrows from 64-bit lanes, SQDMULL/SQDMLAL/SQDMLSL (vector,
  scalar and by element), CLS/CLZ, SUQADD/USQADD (not 64-bit), SQABS/SQNEG, and the scalar forms
  (64-bit ADD/SUB, compares and CMTST, ABS/NEG, shifts, SQDMULH/SQRDMULH, ADDP). Saturation ORs into
  an i32 local, and FPSR.QC is set once per instruction.
- **Structures** (`emit.rs`): LD2–LD4/ST2–ST4 (multiple structures) are one access through
  [`access`]'s fast path, with the registers de-interleaved from (or interleaved into) 16-byte
  chunks by shuffles (`gather`: one per pair of sources, plus one to merge); the one-lane forms
  (LD1–LD4/ST1–ST4) are a lane op per register; LD1R–LD4R are `v128.loadN_splat`. **CRC32/CRC32C**
  are a table lookup per byte; the two 1 KiB tables are statics in the core, their address the
  load's offset (the JIT's modules share the core's memory). Our encoder emits the SIMD128; the
  core itself is built without `simd128` ([backlog.md](backlog.md)). With these and the lane-by-lane
  forms, the guest's browsers decode images 1.4-4.3× faster (`bench/boot/REPORT.md` "M8: the integer
  NEON inline").
- **Crypto** (`emit/crypto.rs`): AESE+AESMC and AESD+AESIMC on the same register fused into one
  round; SubBytes by **nested inversion** over GF(2⁴) (Hamburg's formulas, our implementation;
  tables from `crypto::nested` at compile time; 30% faster than the S-box as 16 slice swizzles);
  `PMULL.1Q` as Karatsuba over three 32×32 `i64.mul`s with holes (4.5% faster than four
  products); SHA1C/P/M and SHA256H/H2 as scalar rounds on renamed i32 locals, the schedule
  updates as SIMD128, and `mov S, A; sha256h A, E, W; sha256h2 E, S, W` computed once.
  FEAT_SHA512 and FEAT_SHA3 (`inline_sha3`, when the vCPU has them): SHA512H/H2 as two scalar
  rounds on i64 locals, SHA512SU0/SU1 as `i64x2` shifts and adds, EOR3 and BCAX as
  `v128.xor`/`v128.andnot`, RAX1 and XAR as `i64x2` shifts; no helper calls.
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
  test: FPCR.RMode is round-to-nearest-even **and FPSR.IXC is already set**; and `FZOK`: FPCR.FZ is
  clear. They hold for the rest of the block (FPCR/FPSR change only through MSR, which ends a
  block, and helpers only OR flags in). If FPOK fails, the block's FP arithmetic runs through
  helpers, which set IXC on the first inexact result, so the next run is fast.
- **Why results, not operands:** without FZ, the host's IEEE operations take denormal operands as
  ARM does (exactly, with no IDC: IDC is FZ's flush), and a NaN or infinite operand makes a NaN or
  infinite result. So with a result that's normal and above the smallest normal binade, the only
  exception add, subtract, multiply, divide, square root, conversion or FMA can raise is Inexact,
  whatever the operands; FPSR doesn't change when IXC is set, and the fast path needn't know whether
  the result was exact. A zero result is taken only where it's exact (below). DN only acts on NaNs,
  which a fast result never is; AHP only concerns half precision's all-ones exponent, which the
  half forms exclude.
- **Under FZ** (llvmpipe's shaders run with it: requiring FZ clear made a frame 16× slower), a
  denormal operand would be flushed (IDC): the operands are tested for denormals too (|x| - 1 below
  the smallest normal's - 1, unsigned: three ops a lane; a NaN or ∞ fails the result test), in a
  branch on `FZOK` (`under_fz`, `under_fz_bad`) that a block takes the same way every time; without
  FZ it costs the branch. The tests that don't round (compares, min/max, FRINT, FCVT widening) test operands for
  NaNs, and for denormals under FZ the same way. A test in that branch reads only what the
  instruction read before it (a register's first read inside a branch would leave its local unset
  on the other path).
- **Per instruction:** the host's IEEE operation in RNE gives the ARM result; the result's exponent
  is checked (above 1, below all ones; integer conversions: the rounded value in range), and a
  failure sends the instruction to the helper with the operands untouched. Vector forms test every
  lane. Only the double FMA tests its factors without FZ (no denormal one, and the product from
  2^-900: its emulation's exactness is argued there; a search of 2M denormal-times-large cases found
  no case the denormal test was needed for, it's kept as the argument's precondition). Until
  2026-10-18 every operand was tested normal or zero, half the FP guest's time with everything else
  inline (bench/interp/REPORT.md "M8: results, not operands").
- **What the checks cost:** on the M4 these paths are bound by the SIMD pipes, which scalar FP
  shares: every lane op counts, a `movi` that V8 rematerializes a constant with and a move between
  a general and a SIMD register included, while the branches, the general-register compares and a
  reduction's branch cost next to nothing (one check for a whole run of FP instructions saved no
  time: "Tried and not kept"). So the checks are written for fewer lane ops
  (bench/interp/REPORT.md "M8: the FP fast paths' SIMD ops"):
  - the exponent range test is the bits shifted left once (the sign gone) less the range's start,
    unsigned below its length: three ops a lane (doubles: the sign flip of the signed compare folded
    into the subtraction's constant), where shift, mask, subtract and compare took four (five);
  - scalar arithmetic (FADD … FSQRT) reads its operands as floats (from their scalar shadows, "Scalar
    shadows" above, or `f64x2.extract_lane 0`: one op, where the bits through a general register took two)
    and their bits again only in branches: the zero clause's operand test when the result is zero, FZ's
    test; its result goes to the destination's shadow;
  - by element, FMLA's factor is the element in every lane, so both halves' products take one
    promoted copy;
  - without FZ, the lane tests' FZ branch passes the mask through (VTMP) instead of clearing no lanes
    with an `andnot` of a zero;
  - the single FMA's midpoint test is the sums' low words shifted left by 3 against the sign bit;
  - FZ's lane tests (`denormal_any`) are each operand's bits shifted left once less one, below the smallest normal's
    so shifted less one, unsigned (a zero wraps to all ones): singles take the operands' unsigned `min` before one
    compare, doubles compare each (signed, the sign flip in the subtraction's constant): two ops an operand where
    `and`, subtract, compare and three constants took six (llvmpipe's frames even; a shader-like kernel +15%:
    bench/interp/REPORT.md "FZ's operand tests and vector FMUL's zero clause");
  - vector FMUL, FMULX and FDIV test the fast results alone first and their zero clause (a zero result with a zero
    factor or dividend) only in a branch on some lane failing, as the scalar forms: llvmpipe's frames 2.5% faster,
    and the same kernel, whose clamped products have a zero lane in nearly every vector, 6% slower (kept: the real
    workload ranks).
- **FMA** (FMADD/FMSUB/FNMADD/FNMSUB, FMLA/FMLS vector and by element, FRECPS/FRSQRTS, single and
  double) has two arms: the host's relaxed-SIMD `madd` where it fuses, else an emulation in RNE f64
  operations. They give the same bits, flags and steps; only how often the helper runs differs.
  - *Fused* (`Ctx::fma`, `jit::Config::fma`, `VmConfig.fma`): `f32x4`/`f64x2.relaxed_madd`, or
    `nmadd` for a negated first factor (the spec's `nmadd` is `madd(-a, b, c)`), scalars on lane 0
    with the upper lanes ignored. Inside the guard, a fused a·b + c is ARM's result: one rounding in
    RNE, and a result that's normal above the smallest normal binade raises nothing but Inexact, set
    already, whatever the operands (NaNs, ∞ and 0 × ∞ end in a NaN or ∞ the check rejects). Negations
    come before the op (FNMADD's addend is negated, never the result: an exact zero's sign depends on
    it). So FPOK, FZ's operand tests and the result check stay as they are, and the double's factor
    bound goes: that was the emulation's. Singles stay in f32, with no midpoint test. FRSQRTS halves
    after the op, exactly (a denormal fails the check).
  - *Its zero clause* (vector singles only, as in the emulation): there's no double sum to read a
    zero from, and a fused sum that underflows to zero must reach the helper (Underflow). A zero lane
    is taken with a zero factor (the addend is then the zero) or an addend from 2^-100 up: then
    |a·b| > 2^-101, whose 48-bit product ends at or above 2^-148, as the addend does, so a nonzero
    exact sum is ≥ 2^-148 and rounds to no zero. Cancellation below 2^-100 goes to the helper. All of
    that is in a branch on some lane not being a fast result, so a block of plain lanes pays one
    reduction, as the other paths do.
  - *The probe* (`web/fma.ts`, once a host): `(1 + e)² - 1` through all four ops, with e = 2^-27
    (2^-13 in singles), the operands as parameters so nothing folds. Any op that doesn't fuse, or no
    relaxed SIMD: the emulation. `bootVm`'s `fma: false`, `?fma=emul`, `jit_fma(v, 0)` force it (the
    M4 always fuses).
  - *Why one probe holds for every tier:* the spec makes relaxed choices "fixed, that is, parameters
    are constant during the execution of any given program". In V8 14.6 (Node) and 15.3 (Chromium 153), by their source, Liftoff compiles
    these ops itself (no bailout), and both tiers lower them alike: arm64 is always `fmla`/`fmls`
    (Liftoff `EMIT_QFMOP`, TurboFan `VISIT_SIMD_QFMOP`); x86-64 goes through one macro,
    `QFMA`/`QFMS`, in `SharedMacroAssemblerBase`, FMA3's `vfmadd`/`vfnmadd` if
    `CpuFeatures::IsSupported(FMA3)`, else mul + add. Measured: the default, `--liftoff-only` and
    `--no-liftoff`, in Node and Chromium 153 on the M4; x64 Node under qemu-user: Haswell fuses,
    Nehalem and `--no-enable-fma3` don't, in those tiers alike. Other engines rest on the spec's sentence.
  - *What it saves* (bench/interp/REPORT.md "FMA through the host's fused op"): FMLA 2D about 64
    lane ops to 5, FMLA 4S about 23 to 5; the FP guest 1,401 -> 2,663 MIPS, a llvmpipe frame 4% less.
  - *Emulated:* the exact product, its sum with the addend, then one final rounding.
  - *Emulated single:* the product of two singles is exact in double, so the double sum is the exact sum
    rounded once (RN64), and its demote rounds a second time (RN32). Two roundings to nearest give
    the correctly rounded result unless the first lands exactly on a midpoint of the narrower
    format (a single's midpoint is a double, so RN64 is monotonic around it: an exact sum below a
    midpoint can only round to it, not past it). A double in the singles' normal range is on a
    midpoint when its low 29 bits are `1 << 28` (one `and` and a compare; the vector form shuffles
    the f64x2 sums' low words into an i32x4). Then, in a branch hinted unlikely, the sum is rounded
    to odd and RN32 of that is correct (53 ≥ 24 + 2 bits): TwoSum's error (Knuth: six ops) and, if
    it's nonzero and the sum's last bit even, its bits stepped ±1 toward the error (+ when the
    signs agree); the vector form redoes every lane's sum that way. On random data one sum in
    2^29 takes the branch, but exact sums of short significands land on midpoints often (the FP
    guest's matrix multiply: as helper calls instead of the branch, they cost all of the gain over
    rounding every sum to odd; bench/interp/REPORT.md "M8: the single FMA's midpoint test").
  - *Emulated double:* Boldo and Melquiond's emulated FMA ("Emulation of FMA and correctly rounded sums:
    proved algorithms using rounding to odd", IEEE TC 2008; glibc's soft `fma` does the same with
    a rounding-mode switch): Veltkamp's split and Dekker's product give p + pl = a·b exactly,
    TwoSum gives th + tl = c + p, and z = RN(th + RO(tl + pl)). Exact while every partial product
    is (a·b from 2^-900 up, biased ea + eb ≥ 1146, or a zero factor; the true limit is near
    2^-970). An overflow anywhere (the split's 2^27 + 1 scaling near 2^996, the product, Dekker's
    partial products) makes z infinite or a NaN, which the result check sends to the helper, so
    there's no upper bound to test. That needs the round to odd's inexact test to be |e| > 0, not
    e ≠ 0: an infinite sum has a NaN error, and stepping ∞'s bits toward a NaN's sign (the host's:
    negative on x86-64) gave the largest finite double. The vector form is the same on f64x2 (its five v128 scratch locals don't hold both
    splits, so the low halves are recomputed from the operands; by element, the factor's shuffle is
    made once into a local for the product and once for the guard: V8 doesn't merge repeated shuffles, which
    were five `dup`s an `FMLA Vd.2D, Vn.2D, Vm.D[i]` in TurboFan's code); the scalar form uses eight f64
    scratch locals (`FT`).
  - *Emulation's guard:* FPOK, a fast result (vector single: also an exact zero from a zero product and
    addend); doubles: the factors' test above. No midpoint or binade cases fall back. The single midpoint test
    holds above the smallest normal binade, where the singles' last place is the double's bit 29;
    below it (a sum rounding up to the smallest normal) the result's exponent sends it to the
    helper.
  - *Tested* by models of both algorithms against the software FMA (`core/src/fp/tests.rs`, 4M
    cases each, midpoints by construction; the single model also counts its midpoint branches),
    the fused rule on the same cases and on products and addends around the zero clause (`fused_zero_results`),
    and the differential test's FP edge cases (midpoints,
    the product bound, an error under 2^-1074 deciding a midpoint, zero, denormal and 0 × ∞
    operands, split overflow, sums underflowing to zero, lanes that differ), on both arms; planted
    bugs in each step fail them. `tests/browser.test.ts` runs the FP guest through both arms in
    Chromium (the same `Cpu` after 2G steps), and the FP suite takes both.
- **FCMLA and FCADD** (FEAT_FCMA, when the vCPU has it; `float::lanes`): FCMLA is the FMA forms above, both arms,
  on rearranged operands: Vn's real (0°, 180°) or imaginary (90°, 270°) element in both lanes of each pair (one
  shuffle: TRN1/TRN2 on V8's arm64), Vm's pair (by element the index's, in every pair) swapped for 90° and 270° and one
  lane of it negated (`v128.xor` with a sign mask), 180° the first factor negated as FMLS's (`nmadd`). FCADD is FADD's
  rule on Vn and Vm's pairs swapped, one lane negated. Negating before the operation is ARM's order (FPNeg, then the
  multiply-add), and the checks read those operands as the instruction uses them (FZ's denormal test skips the lanes
  it doesn't read; a NaN operand ends in a NaN the result check rejects, so the NaN's sign is the helper's business).
  By element the factor's halves are alike, so the emulated single path promotes it once, as FMLA's by element; the
  emulated double path holds a shuffled factor in a local. Cost: one to three shuffles and a sign flip more than an
  FMLA, so a guest's FCMLA #0 + #90 pair is level with the v8.0 sequence it replaces (TRN1, TRN2, REV64, EOR, two
  FMLAs) and the by-element and FCADD forms lose to code that shares a REV64 and keeps its constants in registers
  (bench/boot/REPORT.md "PERF loop 7: FEAT_FCMA"). The half forms (FEAT_FP16) are the helper's.
- **Half precision** (FEAT_FP16 and FEAT_FHM, when the vCPU has them; `emit/half.rs`): wasm has no f16, so the lanes go
  to singles exactly (each sign-extended into an i32 lane, shifted into a single's fields with bits 30:28 cleared:
  the value × 2^-112, denormals too, then × 2^112), the operation runs in f32, and the result comes back by integer
  rounding to nearest even (× 2^-112 puts the half's exponent in the single's field, so the rounded magnitude is
  (m + 0xfff + (m >> 13 & 1)) >> 13 and a zero stays 0; the signs shuffled in with one `bitselect`). That's ARM's
  result: FADD, FSUB, FMUL, FDIV and FSQRT round twice, innocuous at 24 ≥ 2 × 11 + 2 bits (Figueroa); a half's
  product is exact in a single (22 bits, from 2^-48), so the FMA forms (FMLA/FMLS vector and by element, FMADD …
  FNMSUB) are an exact multiply and one rounded add, whose single sum is then tested off a half's midpoint (low 13
  bits 0x1000: a second rounding there could go the wrong way; TestFloat's f16 cases and a differential case found by
  search land on it), and, in a branch on some lane failing, let through where the sum was exact (s - p == c and
  s - c == p: Fast2Sum's error from the larger): exact sums of short significands sit on midpoints often (an axpy by
  2^-7 ran 9.6× slower with every midpoint a helper call, 27% faster than its v8.0 code with the branch). Guards: FPOK (nearest even, IXC set), and once a block `HOK`, FPCR.FZ16 clear (local 129, past
  the 0..=127 of the rest; `Func::fp16_ok`); operands with no all-ones exponent (the widening makes ∞ and NaN finite):
  their lanes shifted left once, the unsigned maximum below 0xf800; a single result from 2^-13 up and below 65520
  (it rounds to a half in the second binade or up, finite), or ±0 (exact: a zero sum, product or quotient of halves is
  exact in singles). FMAX/FMIN/FMAXNM/FMINNM and the compares (FCMEQ … FACGT, with zero) work on the halves' bits:
  x ^ (sign spread & 0x7fff) orders as the values with -0 below +0 and is its own inverse (`i16x8.max_s`/`min_s`, mapped
  back), (m ^ s) - s orders them with ±0 alike (the compares), FACGE/FACGT compare magnitudes; no NaN operand (∞ is
  fine), HOK, no FPOK. FABS, FNEG and the FMOVs (register, immediate, general, vector immediate) are bits. Vector,
  AdvSIMD scalar (lane 0, the rest cleared) and scalar (ftype 3) forms share the code; 8H takes both singles' halves,
  4H and scalars one (the unused lanes ORed into the masks; a scalar form costs a vector's: in the f32 shadows
  ("Scalar shadows") it would be about a third, [backlog.md](backlog.md)). Cost: FADD 8H about 50 lane ops (two widened operands, 16; the operand test, 4;
  the op, 2; the result test, 10; the narrowing, 17) where a single FADD 4S is about 5, so per element half precision
  here is 4-5× single's: code that keeps halves in memory and converts once wins (an axpy, 27%), code that computes
  in halves loses (a GEMM tile 2×; bench/boot/REPORT.md "PERF loop 10"). **FMLAL/FMLSL(2)** (FEAT_FHM): the halves of Vn and Vm (the low or,
  "2", the high 2 or 4: Q = 0's moved down by a shuffle), widened, FMLSL's first negated, multiplied (exact) and added
  to Vd's singles: one rounding, FPMulAddH's; then the single FMA's rules (a fast result or an exact zero, under FZ no
  denormal addend), the halves used finite, HOK: by vector 17% faster than the FCVTL and FMLA it replaces, by element
  35% slower (it widens the same B row again for each of a tile's eight). Helpers on purpose (rare in fp16 code, each its own rule):
  FRECPE/FRSQRTE/FRECPX, FRECPS/FRSQRTS, FRINT*, the pairwise and across-lanes forms, the conversions to and from
  integers and fixed point, FCMP/FCCMP/FCSEL, FCMLA/FCADD's half forms.
- **BFloat16** (FEAT_BF16, when the vCPU has it; `emit/bf16.rs`; a bfloat16 is a single's top half, so widening is a
  shift or a mask, exact):
  - *BFCVT, BFCVTN, BFCVTN2:* FCVTN's rule to bfloat16 under FPOK: lanes that are ±0 or normal singles below
    0x7f7f8000 (which rounds to infinity) round to nearest even as (u + 0x7fff + (u >> 16 & 1)) >> 16 on the bits;
    bfloat16 has the single's exponent range, so a normal single makes a normal bfloat16 (no Underflow; FZ and DN
    don't act) and only Inexact can be raised, set already. One shuffle packs the high halves (BFCVTN2 beside Vd's
    low half; BFCVT tests lane 0 alone). About 12 lane ops for four lanes.
  - *BFMLALB, BFMLALT* (vector, by element): the single FMA forms above (both arms, their guards and zero clause) on
    Vn's and Vm's even (`i32x4.shl` 16) or odd (`and` 0xffff0000) halves; by element, Vm's half shuffled into every
    lane's top beside zeros. FPMulAdd on singles is ARM's rule for them. The product of two bfloat16s can be below the
    singles' range, so it isn't FHM's separate multiply and add: the fused op (or the emulation) keeps it exact.
  - *BFDOT* (vector, by element) *and BFMMLA:* BFDotAdd without FEAT_EBF16 (the M4 has none, so FPCR.EBF is RES0):
    the two products, their sum, and Vd plus that, each rounded **to odd** with denormal operands and results
    flushed to a zero of their sign, every NaN the default one, FPCR ignored and no flags (`fp::bf_dot_add`; the M4
    agrees on the corpus, and from 2^128 an infinity rather than FPRound's largest finite). Inline: with every
    bfloat16 operand ±0 or from 2^-56 to below 2^63 (biased exponent 71 to 189: the lanes shifted left once, less
    71 << 8, unsigned below the range, or zero), the products are exact singles from 2^-112, their sum is a multiple of
    2^-126 (exact by TwoSum: no flush, finite), and Vd and the RNE sum of the second addition ±0 or normal below 2^126
    (TwoSum's steps stay finite, no flush); then each sum is the RNE sum stepped to odd by TwoSum's error (where it's
    nonzero, the bits less one if the sum went away from zero, then the last bit set). IEEE's zero signs are BFAdd's
    (x - x is +0, -0 + -0 is -0). Anything else, a lane at a time, sends the instruction to the helper. BFMMLA is two
    of those steps on Vn's and Vm's pairs shuffled into the 2×2 block's lanes. Cost: BFDOT .4S about 60 lane ops
    (the operand tests 10, the widening 4, two TwoSums and odd steps 26, the single tests 10), where the v8.0 code it
    replaces (two widenings a register and two FMLA .4s) is about 20: 1.48× slower on a dot product, BFMMLA's GEMM
    tile 2.61× (bench/boot/REPORT.md "PERF loop 11"). The 2^126 bound on Vd is a margin: a 400M-case search for
    TwoSum overflowing with a finite sum near the singles' largest found none (planting a looser bound fails no test).
- **Conversions:** SCVTF/UCVTF inline (RNE, can't overflow), including the forms with the integer
  in a SIMD&FP register and the vector forms (2D lane by lane: no i64x2 convert);
  FCVT{N,M,A,P,Z}{S,U} to W, X and V registers, scalar and vector: the operand rounded in the
  instruction's mode first (FCVTA*'s ties away as FRINTA's sum), then a normal or zero operand whose
  rounded value fits, under FPOK (Inexact), into the saturating truncation (2D lane by lane);
  FCVTXN rounds to odd from the RNE demote (inexact, it steps toward zero where the demote went away
  from the operand, then sets the odd bit), with an RNE result from the second binade up and finite;
  FJCVTZS (FEAT_JSCVT, when the vCPU has it) from one `i64.trunc_sat_f64_s`, whose low half is the result for any
  |x| < 2^63 (the one check that refuses NaNs and infinities too, the helper's with what's past it). Past int32 it
  raises Invalid alone, so those don't need FPOK; in int32 an inexact one needs FPOK and, under FZ, no denormal. Z
  (exact, in int32, not -0) is computed for NZCV only, lazy as a 32-bit logical result of !Z, so code that ignores it
  skips the conversion back. **IOC is set behind a test of IOC itself:** whether a value fits int32 is a coin toss in
  a hash's `>>> 0`, and branching on that alone mispredicted away the instruction's gain (`hash` 1.07-1.15× the
  FCVTZS path against 0.96-0.98 now). The first form, `f64.trunc` with helpers past int32, ran past-int32 code
  2.7-4.3× slower than guests without JSCVT (bench/boot/REPORT.md "FEAT_DotProd and FEAT_JSCVT, measured"); FRINT32Z/X and FRINT64Z/X (FEAT_FRINTTS), scalar and
  vector, as FRINTZ and FRINTI/X (nearest even under FPOK) and then the rounded value (lanes) in the
  integer's range, under FPOK (Inexact) with no NaN or, under FZ, denormal operand: the saturating
  -2^(N-1) and its Invalid are the helper's;
  FCVT to and from half (scalar), as the vector half forms below, single or double straight to half
  in integer arithmetic (no double rounding);
  FCVT single↔double, scalar and vector (FCVTL/FCVTN, lane by lane): widening is exact, so it takes
  any operand but a NaN (and, under FZ, a denormal) without FPOK; narrowing takes FPOK and a fast
  result or a zero from a zero (a NaN, infinite, denormal or tiny operand makes a result the test
  rejects). FCVTN tests the source's zeros in its 64-bit lanes and narrows that mask to the result's
  two with one shuffle.
- **Zero results** (FADD/FSUB/FMUL/FDIV scalar and vector, FNMUL, the FMA forms): taken where
  they're exact. A zero sum or difference is always exact (a nonzero exact sum rounds to a nonzero
  result); a zero product or quotient only with a zero operand (the dividend), and only when the
  result is zero (0 × ∞ and 0 / 0 are NaNs). x / 0 is infinite. Vector single FMLA's zero result
  (emulated; the fused arm's clause is under FMA) only when its double sum is zero (the product is exact in a double, and a nonzero exact sum can't
  round to zero there; a tiny one demotes to a zero with Underflow); the other FMA forms take no
  zero result. A zero lane is a float compare with zero (a NaN isn't one). llvmpipe's shaders multiply and add zero lanes all the time; with
  the normal-only rule its FMLAs and FADDs were helper calls, as the FP guest's sums started at 0
  were.
- **Compares** (FCMEQ/FCMGE/FCMGT, FACGE/FACGT, the compares against zero) and **FRINTN/M/P/Z**:
  no rounding and no flags while no lane is a NaN or a denormal (FZ would flush it, raising IDC),
  so no FPOK; FRINTI/FRINTX round in FPCR's mode (nearest even under FPOK; FRINTX's Inexact is set
  already). FRINTA (ties away, no wasm op) is `trunc(x)` stepped ±1 when `|x - trunc(x)| ≥ 0.5`
  (both exact; a select keeps -0): scalar in f64 for singles (`round`), vector in its lanes
  (`vround`). The AdvSIMD scalar compares (FCMEQ … FACGT, the compares with zero) are the vector
  rule on one value.
- **Scalar compares and selects:** FCSEL is bits (no guard). FCMP/FCMPE raise nothing without a
  denormal operand (FZ), a NaN for FCMPE or a signaling NaN for FCMP, so no FPOK, and **their NZCV
  stays lazy:** an ordered result's flags are a 32-bit SUBS of (gt, lt) (1 − 0: 0010, 0 − 0: 0110,
  0 − 1: 1000), an unordered one's (0011) SUBS of (i32::MIN, 1), so B.cond and CSEL after them use
  the direct conditions. Their helper path turns the helper's NZCV back into those operands
  (`fallback_with`'s hook). FCCMP/FCCMPE store NZCV (an immediate like 0100 has no SUBS form); their
  helper path stores the lazy flags first, as the helper reads them.
- **FMAX/FMIN/FMAXNM/FMINNM** (scalar and vector): wasm's `max`/`min` with zero, normal or infinite
  operands (no NaN: then FMAXNM is FMAX), which order -0 below +0 as ARM does; no flags, no FPOK. The
  vector forms test the result for NaN lanes (wasm's `min`/`max` give a NaN where either operand is one),
  and under FZ both operands for denormals, in one branch.
  The pairwise forms (FADDP, FMAXP … on Vm:Vn, and the scalar pairs) shuffle the even and the odd
  lanes side by side and take the lane rules; FMAXV/FMINV/FMAXNMV/FMINNMV reduce lanes 0 and 1
  against 2 and 3, then the two (without NaNs the order doesn't matter).
- **FABD** is FSUB's rule with the difference's sign cleared; **FMULX** is FMUL's (its ∞ × 0 never
  meets the rule: no infinite operand). **FRECPS/FRSQRTS** are the FMA forms with the first factor
  negated and 2 (3) as the addend in every lane; FRSQRTS halves the sum before the demote (single)
  or after it (double), exactly or into a denormal the result check rejects. **FRECPX** is bits
  (no NaN or denormal operand). **Fixed point** (FCVTZS/FCVTZU, SCVTF/UCVTF with fbits, to and
  from W, X and V): × 2^fbits before the conversion (exact, or an infinity the range check
  rejects), × 2^-fbits after it (exact: never below 2^-64).
- **The AdvSIMD scalar forms** (FABD, FMULX, FRECPS/FRSQRTS, FMLA/FMLS/FMUL/FMULX by element, the
  pairs, the fixed-point conversions) run the vector rules on lane 0 alone (`Func::vsc`: the lane
  checks ignore the other lanes, and the write clears them); the scalar compares and conversions
  are the scalar path's (their size is bit 22).
- **FRECPE/FRSQRTE** (scalar and vector, lane by lane): the ARM ARM's integer estimates (without
  FEAT_RPRES) for the operands that raise nothing: FRECPE's normal ones below FZ's flush range
  (2^126, 2^1022), whose results are normal; FRSQRTE's positive normal ones. FRECPE's b = 2^19 /
  (2a + 1) is an `i32.div_u`; FRSQRTE's search (the least b ≥ 512 with a·(b + 1)² ≥ 2^28) is
  ceil(√(2^28 / a)) - 1 in f64: 2^28 / a is never a square, and its root is at least ~2^-22 from
  an integer, far above f64's error.
- **Still helper calls on purpose:** the half-precision forms listed under "Half precision", and every fast path's
  fallback: NaN and denormal operands, FPCR.RMode other than nearest even or FPSR.IXC clear where
  a result may be inexact, results in the smallest normal binade or beyond, the encodings that are
  UNDEFINED.
- **Half precision** (FCVTL/FCVTN with sz = 0, llvmpipe's 16-bit colour paths): FCVTL is exact
  without flags but for NaNs (FZ doesn't apply to half): the magnitude shifted into a single's
  fields is the value × 2^-112, denormals too, so an `f32x4.mul` by 2^112 converts it. FCVTN rounds
  to nearest even in integer arithmetic under FPOK, for zero lanes and lanes from 2^-14 up whose
  result is finite (no Underflow, Overflow or IDC). Without an all-ones half exponent in or out,
  FPCR.AHP's format reads and writes the same bits, so AHP isn't checked.
- FABS, FNEG and FMOV are bit operations without flags: inline without the guard (`emit/simd.rs` has
  FMOV).
- **The FP suite** (docs/testing.md "The FP suite", `scripts/ci-fp.sh`) runs TestFloat's cases
  through every form above (and the helpers') in a Linux guest under the JIT, with FPSR.IXC set and
  clear, against SoftFloat with ARM's rules, which the M4 passes; a new fast path runs it.

## What still runs through helpers

Counted on the real workloads (PERF loop 8, 2026-11-10, `bench/boot/REPORT.md` "PERF loop 8"): what's left of the
system instructions, and why each stays a helper:
- **ISB in parallel SMP** (Firefox's pages session: 13.7M in 214 s on 4 vCPUs, 3.8M of them at EL0, the vDSO's
  `isb; mrs cntvct_el0`; Debian's boot 0.66M): finished in place by `fast`, ~20 ns each (`isb; mrs cntvct_el0` ~135
  ns against the counter read's ~115, "Counter reads compiled inline"): ~0.3 s of the session's 96 G steps (some 100
  vCPU-seconds), under what a pages A/B resolves. Inline it would need every condition `fast` checks in the block: the queue and
  IRQ bytes, the table not behind the cache (two shared counters against the table's, and the tier-up flag) and the
  published ASID (TTBR/TCR and the TLB's `low_global`), each with a way to change mid-chunk. Outside parallel SMP
  it's inline (it does nothing there).
- **LSE min/max** (LDSMAX, LDUMIN and kin, their ST forms): none in Alpine's boot and userspace benchmark, Debian's
  boot and shell, or Firefox's pages session (musl and glibc's atomics and the kernel's use LDADD, SWP, CAS). A CAS
  loop over wasm atomics would do; nothing runs it.
- **The regime's MSRs** (TTBR0/1: 0.31M in Firefox's session, at context switches) end the block by
  design (the next block's code depends on them); **FPCR/FPSR** writes 0.18M each there (context switches too), NZCV
  and SPSel writes none worth counting; the timer and GIC registers (CNTV_CTL/CVAL, EOIR, SGI1R: 2.2M there) are the
  run loop's (`Exit::Platform`): parallel SMP has no step clock (deterministic round-robin's timer registers are
  inline: "System" above).
- **Unmasking DAIF writes in realtime round-robin** (Node's runners, the I/O and script benchmarks; neither the gates
  nor the page) end the chunk through the helper, as before PERF loop 8: the exit is what takes an IRQ that came due
  under the mask at once (PERF loop 9). Elsewhere they stay inline while `jit::Unmask` allows ("Emission").
- **MRS of the counter in realtime round-robin** (Node's I/O and script benchmarks; neither the gates nor the page)
  exits to the run loop, which reads the host clock. Deterministic round-robin reads the step clock inline ("System"
  above, PERF loop 47).

Of the integer NEON (after the image decoders' profile, 2026-10-18), what's left as helpers: SUQADD/USQADD on 64-bit lanes,
URECPE/URSQRTE, and the FP forms the FP
fast paths send there (`WAARM64_JIT_DIFF_HELPERS=1` on the differential test lists them per class).

## Tried and not kept

Findings worth not re-discovering (numbers in `bench/interp/REPORT.md`):
- **Fewer or cheaper entries from the dispatcher, and no signature check** (PERF loop 54, 2026-11-22;
  `bench/boot/REPORT.md` "PERF loop 54", `bench/boot/results/perf54/`): on the Mac, entries at a function's first
  instruction are 12.7% of the pages session's busy ticks. Of the dispatcher's 161 M block calls there (8% of the
  indirect entries), 82% follow interpreted code (the threshold's call, and the call is the entry itself) and 8% an
  exit or a chunk's end; the 10% that follow a compiled block whose successor was compiled come to 0.55% of busy time
  even at a fully cold transfer each (78 ns): not worth code to take them. A table of a final function type, where V8
  needn't check the signature, transfers no faster than the funcref table (`chain2.mjs`, 78 ns either way at 131,072
  functions, ~5 ns warm): the check's samples are the dispatch table's load, which the target's needs anyway.
- **Lazy NZCV at a loop's head** (PERF loop 42, 2026-11-21; `bench/boot/REPORT.md` "Lazy NZCV at loop heads,
  counted" and "PERF loop 42", `bench/boot/results/flagx/` and `results/perf42/`): a head whose flags only cold paths
  (a slow arm, a failure chain, the FP guard) want before its first setter still takes NZCV in memory, so the
  back-edge of a loop like `ldrb; subs; add; b.ne` computes and stores it every lap: 7-11 such laps a 1000 guest steps
  on Alpine's boot and userspace and Firefox's pages session. An unsound bound (such heads' flags dead: no store on the
  lap, and a stale NZCV on a cold path) measured nothing on the Mac: the gates −0.2% and +0.2%, `pagesS` and busy MIPS
  within the rounds' spread; the store is off the loop's dependence chain. The sound form (the head lazy on its
  back-edges and in memory from the entry, a local saying which, tested on every cold path before the first setter)
  isn't worth its flag state. Likewise **the branch outcome kept across a loop** (`TAKEN`, read by the exits of a
  member whose conditional branch has a successor in the region, so V8 makes it a 0/1 value every lap): 9-13.5 back-edges
  a 1000 steps from a lazy B.cond, ~3 host instructions each, a tenth of that bound.
- **A host return elsewhere absorbed in the caller's frame** (PERF loop 28; `bench/boot/REPORT.md` "PERF loop 28"):
  a `loop` around the call, the mismatch host-calling the miss function (depth + 1) and checking the continuation
  again, instead of tail-calling it in the caller's frame, so a lost frame couldn't make every outer return miss too.
  The returns elsewhere stayed as many (compress 2.0M → 1.4M, Lua 1.8M → 2.3M): they aren't such a cascade. Making a
  probe's miss inside a guest call a host call (it's a tail call) changed nothing either.
- **X registers sharing locals** (PERF loop 27, 2026-11-14; `bench/boot/REPORT.md` "PERF loop 27"): Liftoff's
  zero-fill (~2.8% of Alpine's boot, ~1.7% of its userspace on the Mac, loop 26) is linear in a function's locals,
  half of them X registers held from first use to the write-back. Estimated with a diagnostic core, not built: if
  each register dropped its local after its last touch and registers whose ranges never overlap shared one, the
  fill turns Alpine's boot runs would fall 3.7% (single blocks alone; its userspace 2.1%) or 14.9% (non-looped
  regions too; 13.5%), weighted by calls: ~0.1% and at best ~0.4% of the boot, under what an A/B can tell, before
  the new chains and edge stores sharing costs. Only 412 of the boot's 3,560 filled functions are single blocks out
  of a loop, and a loop holds every register it touches. Taking any one other local out of every filled function
  (a scratch, a flag local, the entry PC as a parameter) is bounded at ~0.3% likewise.
- **A lone table's jump cache and hot words as constants** (PERF loop 14, 2026-11-10; `bench/boot/results/perf14/`):
  with one table, modules can address its jump cache and hot words directly instead of through the vCPU
  (`emit::JC_PTR`, `HOT_PTR`). On the Mac's gates −0.2% on the boot and the userspace benchmark (compress −1.1%, apart;
  the totals' rounds overlapping), −0.45% of the wasm: only for one-table VMs, and a lone table's bytes would differ
  from any other's. Returning at once from a catch-up with nothing to take (98% of them) was even (+0.6%,
  overlapping): the lock's uncontended hold is short already.
- **Per-module eviction, coldest first** (M8, 2026-10-18/19; branch `evict-generations`, not merged;
  `bench/boot/results/m8-evict/` README): about half of a full cache's regions are idle at Firefox's flushes, but
  nearly every module holds one in use (a module is a batch of what got hot together), and V8 frees a module only
  whole: with generations (imports only within an eighth of the budget, which cost nothing measurable) and real
  marks it never evicted (0-12 MiB of 160 unused for 5-60 s). FIFO by install order (branch `fifo-evict-attempt`)
  collapsed a 4-vCPU Go build within 3 minutes: the oldest code is the hottest, and dropping it cascades through
  `linkers` to most of the live code. Whatever frees part of a cache must free whole modules and respect that a
  module's memory goes only with every module that imports it, transitively. Hence regions moved instead (the
  carry, next).
- **Carrying the hot set across a flush** (M8, 2026-10-19/20; the page's `?jit=replay`, ABI 41-42, taken out at
  43; `bench/boot/REPORT.md` "M8: carrying the hot set across a flush" and "M8: the carry timed, and a larger code
  cache"; the code is commit 277b738's): at a flush for room the regions entered since a probe (at 7/8 of the
  budget: every jump and transfer cache cleared, the dispatcher marking what it entered) and their direct-link
  closure kept running from their slots while the next epoch took the other half of the slots; the marked regions
  (up to half the budget) were compiled again into it from recipes, by the compile worker off the vCPUs and
  outside the cache's lock; then the old half was released. In steady WebGL with a flush forced every 30 s it
  shortened the slow phase (2-3 s against 3-5) and raised the worst second a little (median 10.5 frames against 8).
  But a browser's working set is about the cache: at every one of Firefox's page-load flushes the marked regions
  were more than half the budget (62,000-77,000 regions at 160 MiB, 122,000 at 240; the replay capped at 81 and 123
  MiB), so the replay filled half the next epoch, the next flush came after 23 G steps instead of 40, a third flush
  came (made classic by the guard against carrying a replay-filled epoch), and busy MIPS fell 2-7% in each of four
  pairs over two days, with 5-11 vCPU stalls of 50-95 ms against none. Replaying a quarter (`REPLAY_MAX` 2) or in
  modules of 128 regions changed neither (one session each). The 4-vCPU `go build` loop ran 9% faster with it (one
  flush, in its first minutes), which the larger budget gives without it; the gates were even. What it was for, a
  flush in a browser's session, the larger budget mostly removes.
- **Emitting outside the cache's lock** (M8, 2026-10-20; `bench/boot/REPORT.md` "M8: emitting outside the JIT
  cache's lock", the patch in `bench/boot/results/m8-emit/outside-lock.patch`): a batch or a tier-up taken under the
  lock (its slots, a held place in the log that no table installs past, its module number, the epoch, a pinned
  `ival_log` position, the imports looked up), emitted without it, and committed under it unless the epoch moved, an
  IC named one of its pages or an import moved (each rule with a unit test that a planted bug fails; a module
  discarded leaves an empty place and passes its number to the compile worker as no bytes). Correct, and identical
  in deterministic runs. From the pages snapshot, one session per arm with an A/A: the vCPUs' time waiting for the
  lock fell from 37.6/41.2 s to 25.9 s on the churn screen and from 25.4/24.5 s to 19.2 s on the pages session, with
  13 and 2 modules discarded of 32,800 and 6,750; busy MIPS 192 against 191/187 and 155 against 154/154, the churn's
  `doneS`, the heavy pages' loads and the stalls of 20 ms or more (0 against 0/3 and 0/4) even. Emission was 1% of
  the vCPUs' time at most (7.7 s of ~800 in the churn), so **emitting in the compile worker** (which would take it
  off the vCPUs altogether) can't show either and wasn't built.
- **Longer reports far from the threshold** (M8, 2026-10-21; `bench/boot/REPORT.md` "M8: fewer acquisitions of the
  JIT cache's lock", `LONG` in `bench/boot/results/m8-lock/screen.patch`): once a decoded block had counted `warm`
  dispatches, the cache let a table count its share of what was left to the threshold (that over the number of
  tables, 16 to 255) before reporting again, so a block under a high threshold (up to 1000 under pressure) reported
  a few times instead of ~60. On the churn screen, over the kept change: 39 M → 32 M acquisitions, 15.4 s → 14.0 s
  waiting, busy MIPS 221/222 → 228, `doneS` 120.3/120.6 → 120.5: within noise, and it makes the cache's counts
  coarser in parallel SMP (a block may overshoot the threshold by up to a table's share).
- **An adaptive budget** (M8, 2026-10-20; `bench/boot/REPORT.md` "M8: a machine's JIT budget and the page's memory
  signal", the code in `bench/boot/results/m8-budget/adaptive.patch`): starting at 160 MiB, a probe from 7/8 of the
  budget (the dispatchers marking the slots they enter), and at the fill a growth by half (up to the machine's 320)
  when the marked code was more than half the budget, else a flush, and a shrink by a third after two flushes with
  under a quarter in use. Correct, and even on the gates; with the tier-up's room at the cap (a tier-up refused over
  the budget leaves its head alone until a flush: 7% fewer busy MIPS in Firefox's pages until fixed) it matched 320 on
  the pages session, growing 160 → 240 → 320 without a flush. But **the renderer pays for the code compiled, not the
  budget**: a smaller budget saves memory only by flushing, the cost the budget exists to avoid. Firefox's own code in
  use passes 80 MiB, so every browser session grew to at least 240; holding there saved 4% of the renderer's median
  for an extra flush, and ran a reused hot set (the churn page's `hot=1500`) 4% slower. Counting what marked code links
  to directly grew it on code that never runs (to 320 MiB on the churn alone); clearing every jump and transfer cache
  at the probe marked no more.
- **Replaying the hot set after a flush without carrying it** (M8, 2026-10-19, `bench/boot/REPORT.md` "M8:
  carrying the hot set across a flush"): compiled again while everything else ran interpreted, the dip was deeper
  than the default's at a first flush (worst second 4-8 frames against 4-12); compiled all at the first miss, it
  held the cache's lock ~1.2 s and stopped every vCPU. It helped only where the doubled floor made the default's
  slow phase long. Carrying keeps that code running instead.
- **No doubling of the threshold's floor at a flush** (the same section): the interpreted steps after Firefox's
  flushes fell by a third, but 27% more wasm compiled brought a third flush in its pages session.
- **One check for a run of FP instructions** (M8, `bench/interp/REPORT.md` "M8: the FP fast paths'
  SIMD ops"): the inline SIMD&FP instructions between two that can't join (memory, branches,
  helpers, X registers or NZCV; integer instructions that touch no V register stayed inside the
  run) ANDed their conditions into an i32 and their lane masks into a v128, reduced and branched
  on once at the run's end, where a failure restored the V registers the run wrote (saved on
  their first write while dirty) and ran the members again, through the helpers or as they're
  emitted outside a run. Correct (the differential test and planted bugs), and the JIT's code
  much smaller (TurboFan's for the FP guest's n-body loop 36 → 24 KB), but the FP guest and
  `gl_llvmpipe_jit` ran no faster (1244 → 1228 MIPS with the second form; frames 278–288 ms →
  280–290): the
  reductions and branches it saves cost next to nothing (above). Folding the single FMA's
  midpoint test into the run's check (its 1% of FMLAs sent to the members' second emission)
  saved nothing either. The patch is in `bench/interp/results/m8-fp-runs/`.
- **The FP lane constants from memory** (the `Vcpu`'s, as the AES code's) instead of the
  `v128.const` V8 rematerializes with `movi`: the FP guest 1420 → 1420 MIPS.
- **TLB entry layouts:** an i32 addend, and split tag/addend arrays (12 bytes an entry): neither
  paid on Alpine's boot trace (the split's index arithmetic costs more than its density saves).
  The 16-byte entry stays.
- **A TLB translation memo in wasm locals** (M8, `bench/boot/REPORT.md` "M8: a TLB translation
  memo"): the TLB entry (tag, addend) an access last hit, kept in two i64 locals and checked
  before the probe. Safe as built: a translation changes only at a TLBI or a regime MSR, which
  `block::next` gives no successor, so the function returns after them. The check needs two
  compares, `(va | 0xfff) == tag` and, past one byte, the page offset ≤ 0x1000 − len: the TLB's
  tag compare is enough only because its index comes from the first byte, and any single range
  compare has no "empty" value, so zeroed locals would match a page. Lost in all three forms
  (Chromium, `alpine_user_jit`): one memo per kind (reads, writes) a function, 42–62% of the checks
  hitting, +13% (wasm +11.7%); one per base register and kind, 74–87% hits, +5.5% (wasm +8.7%);
  that only in loop regions, wasm +0.8%, still +2.1% (compress +5.8%) and `gl_llvmpipe_jit` +1.9%
  a frame. TurboFan's TLB hit (shift, mask, an L1 load, compare) is cheaper than the memo's
  compares and the extra loop-carried locals. The patch (with two-byte indices for locals from 128
  and bare-metal tests of its rules) is in `bench/boot/results/m8-memo/`.
- **One TLB check for a run of accesses off the same base** (M8, 2026-10-20, counted, not built; `bench/boot/REPORT.md`
  "M8: what Liftoff runs that a static change could cut"): in Firefox's pages session 27% of the 1.04 M access
  sites compiled follow an access in the same direction off the same, unchanged base register within a straight
  run (Alpine's userspace benchmark 28%). But a base's page offset isn't known when compiling, so a follower can't
  skip its check: it can only test that it falls in its leader's page (two compares, no load) and must keep the full
  TLB check behind that for when it doesn't (else a frame straddling a page sends one access to the helper every
  time), which makes its code bigger, not smaller, and the TLB hit it would save is ~0.1 ns in TurboFan. That is the
  translation memo's shape, which lost (above); V8's bounds checks don't collapse either, since each access's slow
  arm is a branch with a call. The count patches are in `bench/boot/results/m8-liftoff/baseruns/`.
- **Folding constants inside a block** (MOVZ/MOVK chains, ADRP+ADD; M8, 2026-10-20, counted, not built; the same
  section): MOVK is 1.1% of the instructions compiled in Firefox's pages session (0.7-0.8% in Alpine's boot and
  userspace benchmark), ADRP followed by an ADD of its register 0.6% (Alpine). A folded MOVK saves about four wasm
  ops (`get`, mask, `and`, `or`), so ~0.2% of the wasm: below anything a session can show.
- **Invalidation by the IC's line** (M8, `bench/apps/REPORT.md` "M8: invalidation by the IC's line, not
  its page"):
  each key filed with the bytes its code covers on each page, and `IC IVAU` dropping only the keys
  overlapping its 64-byte line. Architecturally sound (an IC names only its line), but the
  Chromium render saw no difference in time or blocks compiled over three pairs: the page rule's
  collateral is ~2,000 keys over ~60 ICs a render, and most ICs (3 M in a cold render, mostly
  the kernel's whole-page walks when it maps code) name pages with nothing compiled. The patch is
  in `bench/apps/results/m8-icrange/`; it also moves the stale-code checker's tolerated drop from
  the page's address to the block's, which a finer rule needs.
- **Relinking** (recompiling a block once a successor it returned through is compiled): doubled
  the blocks compiled and the flushes on Alpine for 9% fewer dispatches. **Selective relinking** (2026-11-05,
  `bench/boot/REPORT.md` "Relinking a region once its successors are compiled"; the patch in
  `bench/boot/results/m9-relink/`): a forward region's jump-cache tails and by-VA links counted their hits in its hot
  word, and at 64 or 256 the region was compiled once more from its recipe with the successors compiled since as
  imports, the tables' jump-cache entries repointed. Firefox's pages session relinked ~10,000 regions for 11% more wasm
  and 3% more RSS and ran slower (busy MIPS 212 and 205 without, 200 at 256, 187 at 64): the new copy starts in Liftoff
  while the old one stays in use through its direct importers and the transfer cache. On the Mac host, where code size
  costs nothing, still 296 against 304.
- **Regions of every seen successor** (M5, loops; forward regions since M8 hold each block of a
  batch once, which is what this lacked) duplicated each block into ~5 regions and cost Buildroot
  25–40%; **regions at the first threshold** (no tier-up) cost the boots 10–14% (~930 lukewarm
  loops compiled in Buildroot); **regions from any block in reach** under JIT-stress made it 42×
  slower. Hence: loops only, from seen blocks, after 1000 entries.
- **An atomic load of the signal word on back-edges** (as first planned, beside `left`): added nothing the run
  loop would act on sooner, since `left` bounded a region to the chunk. Parallel SMP's polled code now polls a
  per-vCPU word there *instead of* `left` ([Preemption](#preemption-parallel-smps-polled-code)).
- **Parallel SMP ending a chunk at the next dispatch** when the signal word is set, another vCPU
  queued maintenance or an unmasked IRQ is pending (2026-10-15, `bench/boot/REPORT.md` "M8: the
  device round trip"): a ping to a busy vCPU 17% faster (it waited up to a chunk for its IRQ), the
  userspace benchmark unchanged, but Firefox playing video no better (drops, guest MIPS, fence
  latency): a browser's vCPUs are seldom busy when their interrupts come. Nor is it worth it for the DSB waits
  that remain after the ASID filter ([platform.md](platform.md) "Broadcast maintenance"; a waiter sleeps until its
  targets end their chunks): in 300 s of the `go build` loop on 4 vCPUs they total 4.4–4.9 s, 0.4% of the vCPUs'
  time, and 0.5% with the JIT lock's waits in Firefox's pages session. Ending the target's chunk early saves only
  part of each 20–60 µs wait (a sleeping waiter takes ~10–35 µs to wake, and chained blocks and regions reach a
  dispatch only when they leave), so the gain is a fraction of 0.4%, under the ~1% a measurement can resolve
  (that loop's MIPS spread is 1,094–1,489), while the check sits on every dispatch. Ending it from outside with no
  dispatch would need a memory check in the compiled code's hot path.
- **Out-of-line jump-cache probes:** slower. The probes cost nothing measurable at steady state now
  that hot loops are regions.
- **A lower compile threshold** (2–50): both boots got slower (before the block interpreter).
- **The `Cpu` at a constant address** (to save V8's bounds checks at block exits): mixed, −10% to
  +7% by guest and placement ([v8.md](v8.md)).
- **Keeping blocks across an `IC` whose words didn't change**, and **a blocklist of pages a guest's
  own JIT keeps rewriting** (2026-10-15, with Firefox on the desktop guest: `bench/boot/REPORT.md`
  "M8: the JIT's compile worker"): `IC`s dropped a few hundred compiled regions a page load against
  22,000-165,000 compiled (16-98% of those with their words unchanged), tens compiled again;
  regions on pages that had seen four or more `IC`s were 1-6%. Measured, not built: the volume is
  new code (a browser's first run, and its code again after a budget flush).
- **Forward regions behind a tier-up** (M8, before the batch-time ones): every block with a
  same-page successor compiled alone with a hot word, its forward region compiled after 1,000
  (or 10,000, or 50,000) entries. Lua got 10 to 18% faster, but the boot and process churn 13 to
  20% slower at every threshold: the counting prologue in nearly every block is 16% more wasm,
  and it runs in the cold code that is most of a boot (guest code +17 to 20% in both V8 tiers).
  Forming the regions when the batch is compiled needs no prologue, no second compile and no
  redirect, and was faster everywhere (`bench/boot/REPORT.md` "M8: forward regions"). Tried with
  them and flat within noise then (in Node): 8 or 32 blocks a region instead of 16; on the Mac with today's JIT, 32 and
  64 were faster (the regions' size, above).
- **Rebinding a module's tails once their blocks are compiled** (2026-11-05, `bench/boot/REPORT.md` "Rebinding a
  module's tails once their blocks are compiled: 5% slower"; the patch in `bench/boot/results/m9-rebind/`): a tail to
  a successor not compiled yet imported as a function plus a length global (and by VA a host-address global), bound
  once the block is compiled by instantiating the module again in every table (V8 shares the code: nothing compiles).
  Firefox's pages session on the Mac: 316 busy MIPS against 330-335, 4% more wasm; the sites' code alone cost ~2%,
  binding ~3% more (~14,000 rebindings, 57,000 instantiations, 1.4% of the busy time). And a loop through several
  modules keeps one indirect edge a lap: an instance imports only instances that exist.
- **Copies of compiled callees in their callers' regions** (M8, with calls followed): a callee
  that is already compiled (the usual case: a shared function is hot long before a given caller)
  copied into the caller's region so the call and its predicted return stay inside. Limited to
  small leaf functions (every path returns within 4 or 10 blocks, no calls), it changed nothing:
  few calls qualify. Unlimited, it made 80% more wasm (Alpine's boot 30% slower, churn 20%)
  and no phase faster. The patch is in `bench/boot/results/m8-xpage/`.
- **Regions entered at more than one block** (a `br_table` on an entry index, v86's shape), so a
  member entered from outside its region runs there instead of waiting in the interpreter to be
  compiled again as a head: measured, not built. Such blocks run 0.01–0.04% of the userspace
  phases' steps interpreted (6–16% of their few dispatches), about 1% of a phase at most, and
  multi-entry would put an entry parameter on every function (`bench/boot/REPORT.md` "M8: what a
  region entered at more than one block could win").
- **A per-block compile threshold** (2026-10-25; `bench/interp/REPORT.md` "Compile by expected benefit against
  cost", the patch in `bench/interp/results/m8-cp/`): measured first, then screened against the floor and the
  pressure rule. Cost: a compiled guest instruction is ~94 wasm bytes and ~3.3 µs of the vCPU's time (the emit ~12.7
  µs a KB, Liftoff's lazy compile ~22-25 µs a KB; V8's validation ~1.2 µs a KB on the compile worker), the fixed
  costs small (~40 µs each a module, nothing a function), so cost grows with the region's length. Benefit under
  Liftoff: integer code saves 1-2.5 ns a step against the block interpreter, SIMD&FP 13-18 (the generic path). So
  the length shouldn't move the threshold, and a **threshold in steps** (dispatches × length) lost as predicted
  (the churn page 17% slower, 16% more wasm, a flush). **Weighting by the mix** (the threshold divided by `1 + 9 ×
  slow / len`, slow the SIMD&FP instructions, or every generic-path one: the regime's MSRs, ERET and ISB are helper
  calls compiled too) compiled FP blocks earlier (2% fewer steps interpreted in Firefox) and won nothing: the pages
  session, the boots and `smp_user_jit_4` even, the `go build` loop 1.5% slower; a browser's session interprets ~4%
  of its steps. **Decaying a block's count** while it isn't reported changed nothing. **Without the pressure rule**
  (a flat 2000) the wasm fell 9-11% but Alpine's boot ran 2.8% slower and Firefox's pages interpreted 27% more steps:
  a cold boot wants 1000, a browser's working set under pressure 2000, which the rule gives.
- **Wider groups of accesses** (closed 2026-11-09 unbuilt; `bench/boot/REPORT.md` "Groups of accesses, measured" and
  "Groups of accesses: the leftovers closed"; the analysis in `bench/boot/results/accstat/pages.txt`). Of every
  immediate access's probe on Firefox's pages session, today's groups leave 73.8%; all the untried rules together
  reach 70.0%: flag setters and readers among a group (SUBS, CSEL & co, MRS) 72.3%, two probes in one `if` (a second
  `HOST` through the bodies) 71.8%, three probes and any instruction 70.0%. Probes being ~10% of the wasm, that's
  ~0.5% at best, and the ~26 points the groups removed moved no time. Flag setters inside a span would also need
  the cold arm's failure exit to re-derive the setter's lazy flags (the chain's return stores the flag locals,
  stale once the helper retired the setter): the failure-chain class of bug. Register offsets (5.6% of accesses) have
  no static span. The one larger lever, if probes ever cost time: across blocks, 46% of probes land on the page of
  one of the function's last two probes, which no group reaches.
- **Larger batches in a browser** (2026-11-03; `bench/boot/REPORT.md` "The wasm code GC today, and larger batches in
  a browser"): `BATCH_STEPS` 200K and 800K against 50K, two sessions each of Firefox's pages session and the churn
  screen. Modules fell 45% and 67% (pages) and 31% and 57% (churn) for the same wasm on the pages session, but
  nothing a user would notice moved: busy MIPS and page loads within the sessions' spread, the churn page's work even
  at 200K (16% more steps interpreted, 50% more lock acquisitions) and 4% lower at 800K, memory 1-6% lower, and 800K
  had the most stalls of 20 ms or more in both. Not built: **rebuilding the live regions into 512-region modules
  while the guest idles**. The wasm code GC frees Liftoff code that TurboFan replaced, not dead modules' code (a
  module's code goes with the module), so rebuilt functions starting in Liftoff again would add to it, for a module
  saving that measured flat.
- **Cutting the JIT's wasm for its own sake** (PERF loop 13, 2026-11-10; `bench/boot/REPORT.md` "PERF loop 13: the
  JIT's wasm size cuts", the arms in `bench/boot/results/perf13/arms.patch`): on the Mac host size costs nothing
  (`bench/boot/REPORT.md` "What a function's size costs"), so only what changes the work can show, and it didn't:
  the kept cuts (the peepholes, the integer idioms, the cold paths' NZCV helpers, a failed guard's miss function:
  −6.4% wasm on Alpine, −2.5% in Firefox's pages session) ran even on the gates and the pages session. Two went
  further and lost: **every NZCV through the helpers** (the hot sites too, −5% more wasm) ran Alpine's userspace
  benchmark 1.3% slower than without (one session, rounds apart; the boot 1%);
  **an uncompiled successor in another page through the miss function** (−3.6% more) ran it 7% slower (Lua 12%,
  SQLite 10%): that site stays hot (regions aren't re-emitted), and the miss function's instruction TLB and jump-cache
  lookups each time cost more than the transfer cache's one probe. Not built: register offsets past 128 in one byte
  (~1 B on half the write-backs, a `Cpu` layout change), whatever is size alone.

## Validation

The golden corpus through the JIT (forced and stress), the JIT-vs-interpreter differential test on
random words and sequences (`tests/jit-diff-suite.ts`, run as `tests/jit-diff-[1-4].test.ts`), lockstep (`tests/jit-lockstep.test.ts`),
every boot's exact steps under the JIT, and planted bugs for every new rule. Details in
[testing.md](testing.md).
