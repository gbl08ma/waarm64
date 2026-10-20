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
  timer registers, WFI, HVC, TX full, `DEVICE`) need nothing special. A counter read's exit costs ~180 ns, under 1%
  of a busy vCPU in every workload counted, so CNTVCT stays an exit (bench/boot/REPORT.md "counter reads, inline or not").
- **Functions:** `f(vcpu, acc, left) -> acc + retired`, where `vcpu` points at the `Vcpu` (the
  `Cpu` at 0, the crypto constants, `State`, the TLB's scalars, then its arrays and the transfer
  cache), `left` is the step budget. Whatever JIT code loads at a fixed offset sits within the
  first 0x800 bytes, where V8 folds the offset into the load (past ~32 KiB it builds it with a
  `mov`+`movk` every time): the TLB arrays are interleaved (below, "Loads and stores"), and the
  transfer cache (at 0x80000 plus a small offset) is reached by ORing 0x80000 into its index.
  Core-internal: its shape can change without an ABI bump.
- **Where it runs:** in the vCPU worker (Chromium) and in Node, the same code (`jitHost` in
  `web/vm.ts`). Natively there's no wasm engine: `cargo test` covers the translator's structure
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
  taken once per 16 dispatches of a block that isn't compiled, not at every one.
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

- A key is counted per dispatch; past the **threshold** it joins a pending batch, emitted as
  one module at **512 blocks**, once the pending blocks have run **50,000 steps** in the
  interpreter since they joined it (`BATCH_STEPS`: each dispatch of a queued block adds its
  length), or **64M steps** after the batch's first entry (`BATCH_TIMEOUT`, for lukewarm blocks).
  So a block that keeps running is compiled soon, and blocks that rarely run wait for company.
- **The threshold follows the code cache's pressure** (`Cache::retune`, set where modules are
  installed and at flushes, so a dispatch only compares): **50** while the live modules are under
  two eighths of the byte budget (80 MiB), doubled at each further eighth up to **1000**
  (`Config::threshold`, `threshold_max`, `PRESSURE_KNEE`), and each flush doubles the floor it
  starts from. Code that fits is compiled early; a working set that doesn't fills the rest of the
  budget with the code that runs most. JIT-stress, JIT-check, the dispatcher-only mode and the
  user-mode `jit_new` keep a fixed threshold.
  Fewer, larger modules run faster (chains stay within a module) and cost V8 ~16 KB less each
  ([Memory](#memory)): Alpine's userspace benchmark makes 970 modules (3,860 with the 1M-step
  timeout alone, which emitted half of them with one function).
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
      too, and the `ret` is an edge to it when X30 holds that address, an indirect branch
      otherwise (`Region::returns`). Only for callees compiled in the same batch: one already
      compiled keeps its own function.
    - Alpine's boot: 47,200 functions of 49,400 blocks became 26,000 of 56,000, in 29.6 MB of
      wasm instead of 23.6. JIT-stress compiles a block at a time, so it makes none; JIT-check
      and the tests' forced mode take any block in reach in the head's page (any page with the
      MMU off), as their loop regions do.
  - **Loop regions** (`block::region`): a hot block and the blocks that lead back to it by static
    edges (its loop; seen by the dispatcher). Without a loop the region is the head alone.
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
  jump-cache miss, when the cache's `drops` moved (an atomic read before each block, without the
  lock), and in `jit_hot`, always before a block runs that could use them. Bytes every table has
  taken are freed. **No V8 compile runs under the lock** (only a table's two miss functions, once):
  a worker stalled in `jit_install` holding it kept the other vCPUs from even reaching their DSB
  (`tests/hoststall.test.ts`), and in a browser one worker's compile would hold up every vCPU's
  misses.
  - **What the lock costs** (counter words 108–113, `ab-summary`'s `locks`, `contended`, `waitMs`, `lockedMs`):
    Firefox's pages session on 4 vCPUs takes it ~87 M times (~230,000 a second: jump-cache misses and the decoded
    blocks' reports), 5% of them finding it held, ~25 s of vCPU time waiting in all (~1.7% of the vCPUs' time);
    the churn screen 66 M times, 3.6% held, ~38 s (~4.7%). Emitting the modules is 3.6 s and 7.7 s of that held
    time, forming the batches 1 s and 2 s: emitting outside the lock cut the waiting by a fifth to a third and
    nothing else ([Tried and not kept](#tried-and-not-kept)). What's left is the acquisitions' number.
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
  dropped since, or all of it past 4,096). The broadcast drains don't touch the JIT any more. Until
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
  rechecked"), one vCPU 1–2% slower. On one vCPU the same load compiled 227
  MiB; four private caches compiled ~2.9× that.

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
  single-cache VM gets the whole budget (then 160 MiB) (`Config::for_vcpus`; Debian's 73 MB boot never flushes) and
  only the 4-vCPU page runs at 40 MiB per cache. After a guest panic and `page.reload()` the renderer
  went from 3.55 GB to 1.2 GB at once (`mem-run6-crash` in the summary).
- **The page's memory check before a start** (`hostMemoryGiB`, `web/app/machine.ts`: RAM + 1 + 0.3 per vCPU, plus
  four times the machine's JIT budget past 160 MiB, `jitHostGiB`) matches the capped median of that mixed load and
  Firefox's pages session at 160 and 320 MiB (4.6-4.7 and 5.1-5.4 GiB with 2.5 GiB of RAM on 4 vCPUs, the rule's
  4.7 and 5.3); the peaks above it are the GC's lag.

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
- **Where it goes:** the machine worker reads it each second into the status (`Status.memory`, `Vm.hostUse`). Past
  what `navigator.deviceMemory` reports (at most 8 in Chromium), it caps the JIT cache at what it holds then (the
  gauge's limit word, `G_LIMIT`: the cache flushes there and refills to it, never under 16 MiB). The page keeps a mark
  per running machine in `localStorage` (`webpc.alive.<machine id>`: name, RAM, vCPUs, JIT budget, the estimate and
  its peak), renewed every 10 s and cleared at every clean stop (power off, restart, the guest's shutdown, a crash
  the page saw, the tab's `pagehide`). A mark no tab renewed for 30 s means the tab went away with the machine running,
  most likely killed for memory (Chromium gives a page no out-of-memory error): the next start says so and offers a
  160 MiB (or 64 MiB) JIT cache, half the RAM, or to start as it is ([frontend.md](frontend.md) "Too little memory").

## Invalidation and the stale-code checker

- `CTR_EL0.DIC = 0`, so guests issue `IC IVAU`/`IC IALLU(IS)`. Those leave the interpreter with
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

## Emission (`emit.rs`)

- **Registers in locals:** each guest register a block's inline code touches lives in a local
  (an i64 for X0–X30 and SP, a v128 for V0–V31), loaded on first use and written back before
  helper calls and returns; after a helper every local is dropped. One pair of masks (`Regs`:
  valid, dirty; bits 0–31 the X registers and SP, 32–63 the V registers) tracks both kinds, so
  every rule below holds for both. The slow path of an FP fast path writes
  back every dirty register before its helper (a load's or store's only what the helper reads or
  writes: below) and drops the instruction's destinations (`written`, V ones included)
  after it, reloading what the fast arm had loaded, so both arms merge. Only the locals a
  function uses are declared (`wasm::Code::compact_locals`: Liftoff zero-initializes each one
  per call); registers read once and never written stay plain loads (for a V register read as a
  scalar lane, a scalar load: `Func::vlane`). In regions, each member starts in a fixed register
  state (the merge of its incoming edges, found by a first emission) and every edge conforms to
  it; the head's state is loaded once before the loop.
  Locals map: i64 scratch 2..=5, i32 6..=9, the flag locals 10..=16, X registers from 17 (in
  order of first use), V registers 49..=79 then 96, SHA's i32s 80..=95, PMULL's i64s 100..=112,
  VT 119–122, FPOK 123, VTMP 124, TAKEN 125.
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
  `(va >> 5) & 0x7ff80` plus the array's `16 × (3·el + use)`: the six arrays are interleaved by
  index (`mmu::Tlb`), so every array's offset from the `Vcpu` stays under 0x800 and V8 folds it into
  the load (separate arrays at 0x30540 and up took a `mov`+`movk` for each tag and addend); with the
  MMU off a bounds check against RAM, whose layout the block embeds.
  Every addressing form of LDR/STR, LDP/STP/LDPSW/LDNP/STNP, LDR literal, PRFM, SIMD&FP single and
  pair, LD1/ST1 multiple and of one lane (a narrow load into the V register's lane, the others
  kept), LDTR/STTR (through EL0's TLB arrays). Anything else (a miss, a fault,
  MMIO, a page-crossing access, a misaligned SP base) calls a helper that re-executes the whole
  instruction: the fast path changes nothing before its check, so fault state is exact by
  construction. Every guest RAM access in generated code goes through one lowering function
  (layout A's single point of change).
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
- **Atomics:** LDAR/STLR as aligned wasm atomics, single exclusives and the LSE atomics
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
  TPIDR_EL1 were 91% of Alpine's MRS calls); the MSRs above inline; an MSR or ERET that unmasks
  IRQs leaves through its helper's `Exit::Resync`. SIMD&FP instructions check `CPACR_EL1.FPEN`
  once per block.
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
  - scalar arithmetic (FADD … FSQRT) reads its operands as floats (`f64x2.extract_lane 0`: one op,
    where the bits through a general register took two) and their bits again only in branches: the
    zero clause's operand test when the result is zero, FZ's test;
  - by element, FMLA's factor is the element in every lane, so both halves' products take one
    promoted copy;
  - without FZ, the lane tests' FZ branch passes the mask through (VTMP) instead of clearing no lanes
    with an `andnot` of a zero;
  - the single FMA's midpoint test is the sums' low words shifted left by 3 against the sign bit.
- **FMA** (FMADD/FMSUB/FNMADD/FNMSUB, FMLA/FMLS vector and by element, single and double),
  in RNE f64 operations only (wasm has no deterministic FMA; relaxed-simd's `madd` may not fuse):
  the exact product, its sum with the addend, then one final rounding.
  - *Single:* the product of two singles is exact in double, so the double sum is the exact sum
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
  - *Double:* Boldo and Melquiond's emulated FMA ("Emulation of FMA and correctly rounded sums:
    proved algorithms using rounding to odd", IEEE TC 2008; glibc's soft `fma` does the same with
    a rounding-mode switch): Veltkamp's split and Dekker's product give p + pl = a·b exactly,
    TwoSum gives th + tl = c + p, and z = RN(th + RO(tl + pl)). Exact while every partial product
    is (a·b from 2^-900 up, biased ea + eb ≥ 1146, or a zero factor; the true limit is near
    2^-970). An overflow anywhere (the split's 2^27 + 1 scaling near 2^996, the product, Dekker's
    partial products) makes z infinite or a NaN, which the result check sends to the helper, so
    there's no upper bound to test. That needs the round to odd's inexact test to be |e| > 0, not
    e ≠ 0: an infinite sum has a NaN error, and stepping ∞'s bits toward a NaN's sign (the host's:
    negative on x86-64) gave the largest finite double. The vector form is the same on f64x2 (its five v128 scratch locals don't hold both
    splits, so the low halves are recomputed from the operands); the scalar form uses eight f64
    scratch locals (`FT`).
  - *Guard:* FPOK, a fast result (vector single: also an exact zero from a zero product and
    addend); doubles: the factors' test above. No midpoint or binade cases fall back. The single midpoint test
    holds above the smallest normal binade, where the singles' last place is the double's bit 29;
    below it (a sum rounding up to the smallest normal) the result's exponent sends it to the
    helper.
  - *Tested* by models of both algorithms against the software FMA (`core/src/fp/tests.rs`, 4M
    cases each, midpoints by construction; the single model also counts its midpoint branches)
    and the differential test's FP edge cases (midpoints,
    the product bound, an error under 2^-1074 deciding a midpoint, zero, denormal and 0 × ∞
    operands, split overflow); planted bugs in each step fail them.
- **Conversions:** SCVTF/UCVTF inline (RNE, can't overflow), including the forms with the integer
  in a SIMD&FP register and the vector forms (2D lane by lane: no i64x2 convert);
  FCVT{N,M,A,P,Z}{S,U} to W, X and V registers, scalar and vector: the operand rounded in the
  instruction's mode first (FCVTA*'s ties away as FRINTA's sum), then a normal or zero operand whose
  rounded value fits, under FPOK (Inexact), into the saturating truncation (2D lane by lane);
  FCVTXN rounds to odd from the RNE demote (inexact, it steps toward zero where the demote went away
  from the operand, then sets the odd bit), with an RNE result from the second binade up and finite;
  FCVT to and from half (scalar), as the vector half forms below, single or double straight to half
  in integer arithmetic (no double rounding);
  FCVT single↔double, scalar and vector (FCVTL/FCVTN): widening is exact without FPOK for a zero,
  normal or infinite operand; narrowing takes FPOK, a normal or zero operand and a fast result or a
  zero.
- **Zero results** (FADD/FSUB/FMUL/FDIV scalar and vector, FNMUL, the FMA forms): taken where
  they're exact. A zero sum or difference is always exact (a nonzero exact sum rounds to a nonzero
  result); a zero product or quotient only with a zero operand (the dividend), and only when the
  result is zero (0 × ∞ and 0 / 0 are NaNs). x / 0 is infinite. Vector single FMLA's zero result
  only when its double sum is zero (the product is exact in a double, and a nonzero exact sum can't
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
  operands (no NaN: then FMAXNM is FMAX), which order -0 below +0 as ARM does; no flags, no FPOK.
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
- **Still helper calls on purpose:** FP16 arithmetic (not advertised), and every fast path's
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

On Alpine's paths (~2.5M helper-retired steps a boot): unmasking MSRs (DAIFClr, an MSR DAIF that
unmasks), the regime, FP-control, SPSel and NZCV MSRs, ISB, LSE min/max,
the load/store fallbacks (TLB misses, MMIO); in OpenSSL's GCM path scalar `SHL`. `jit_helper_report`
has the live histogram. None was worth a loop by itself at M6.5's end. Of the integer NEON (after
the image decoders' profile, 2026-10-18), what's left as helpers: SUQADD/USQADD on 64-bit lanes,
URECPE/URSQRTE, the dot products and SQRDMLAH/SQRDMLSH (not advertised), and the FP forms the FP
fast paths send there (`WEBPC_JIT_DIFF_HELPERS=1` on the differential test lists them per class).

## Tried and not kept

Findings worth not re-discovering (numbers in `bench/interp/REPORT.md`):
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
  the blocks compiled and the flushes on Alpine for 9% fewer dispatches.
- **Regions of every seen successor** (M5, loops; forward regions since M8 hold each block of a
  batch once, which is what this lacked) duplicated each block into ~5 regions and cost Buildroot
  25–40%; **regions at the first threshold** (no tier-up) cost the boots 10–14% (~930 lukewarm
  loops compiled in Buildroot); **regions from any block in reach** under JIT-stress made it 42×
  slower. Hence: loops only, from seen blocks, after 1000 entries.
- **An atomic load of the signal word on back-edges** (as first planned): adds nothing the run
  loop would act on sooner, since `left` bounds a region to the chunk.
- **Parallel SMP ending a chunk at the next dispatch** when the signal word is set, another vCPU
  queued maintenance or an unmasked IRQ is pending (2026-10-15, `bench/boot/REPORT.md` "M8: the
  device round trip"): a ping to a busy vCPU 17% faster (it waited up to a chunk for its IRQ), the
  userspace benchmark unchanged, but Firefox playing video no better (drops, guest MIPS, fence
  latency): a browser's vCPUs are seldom busy when their interrupts come.
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
  them and flat within noise: 8 or 32 blocks a region instead of 16.
- **Guest calls as host calls** (M8, `bench/boot/REPORT.md` "M8: guest calls as host calls"): a `BL`/`BLR` as a
  wasm `call` (a depth parameter, at most 64 deep) and a `ret` as a wasm `return`, so the host predicts guest
  returns. The continuation must be in the caller's function (as its own function, the caller's jump to it stalled
  as the `ret` had) and an entry of it (every exit unwinds the host frames, and returns then come through the
  transfer cache; a member without an entry ran interpreted until compiled again: 54% more dispatches in Firefox).
  Built that way it was even on the boots and the userspace benchmark (churn −11%), but in Firefox the returns'
  entry stalls only moved into the callers' bodies (guest code 61.3% → 59.6% of samples: the stall is fetching cold
  code), while 23% more wasm cost a third flush. The patch is in `bench/boot/results/m8-calls/`.
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

## Validation

The golden corpus through the JIT (forced and stress), the JIT-vs-interpreter differential test on
random words and sequences (`tests/jit-diff.test.ts`), lockstep (`tests/jit-lockstep.test.ts`),
every boot's exact steps under the JIT, and planted bugs for every new rule. Details in
[testing.md](testing.md).
