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
  (chains stay within a module) and cost V8 less per module: Alpine makes ~2,600 modules.
- **Regions** (the compile unit): a hot block and the blocks that lead back to it by static edges
  within its guest page (its loop; seen by the dispatcher), up to 16 blocks (`block::REGION`), in
  reverse postorder, one function. Without a loop the region is the head alone.
- **Tier-up:** a loop head is first compiled **alone** with a hot word (one u32 per code-cache
  slot) counting entries down from `region_after` (**1000**); the entry that reaches 0 calls
  `jit_hot(vcpu, key, pc)`, which compiles the loop region in its own module (never with a flush,
  since JIT code is on the stack) and stores `1 << 31 | index` in the word; from then on the head's
  prologue tail-calls the region, so blocks linked to the head reach it too.
- **The code cache holds 262,144 regions** (4 bytes per slot up front); when full, everything is
  flushed (slots freed, modules left to the GC). Alpine's boot compiles ~57K and Debian's ~110K,
  so neither flushes. Per-module eviction is backlog.
- **Modes** (`jit::Config`; `VmConfig.jit`): 1 = the default above; 2 = **JIT-stress**: threshold
  0, batch 1, a 4-region cache, `region_after` 1 and the stale-code checker. Tests also use a
  forced mode (threshold 0, batch 1, a big cache, `region_after` 0: regions at once). The
  user-mode `jit_new` takes all five knobs.
- The sweeps of threshold (2–200), batch size, timeout and `region_after` after M6's chunk change
  were flat on Alpine: the defaults stand.

## Linking

- **Chaining:** a block whose successor is static (a direct branch, both sides of a conditional
  one, the fall-through after a cap, page end or a chaining system instruction) and compiled
  **tail-calls** it (`return_call`) with `acc + len` and `left − len` when `left` covers both.
  Successors in the same batch are direct calls; already-compiled ones are imports of module `t`
  by table index. With the MMU on, a successor in another page is chained behind a check that its
  VA hits the instruction TLB of the block's EL and maps to the host address it was compiled for.
- **Through the jump cache:** a successor not compiled yet when its predecessor is (the common
  case: blocks compile in hotness order), and every BR/BLR/RET target (translated through the
  instruction TLB into a key), is probed in the jump cache from wasm and tail-called with
  `return_call_indirect` on a hit that fits `left`. The jump cache only holds compiled blocks and
  is cleared by invalidation and flushes, so these links need no bookkeeping.
- **Inside a region:** members are nested wasm `block`s; an edge to a later member is a `br`
  taken when `left` covers it; back-edges to the head branch to a wasm `loop` under the same
  budget check (the budget alone: no atomic load, since `left` never exceeds the chunk). Other
  edges leave through the tails above.
- Dropping a block drops the blocks chained to it, transitively (the cache records who chains to
  whom).

## Invalidation and the stale-code checker

- `CTR_EL0.DIC = 0`, so guests issue `IC IVAU`/`IC IALLU(IS)`. Those leave the interpreter with
  `Exit::Invalidate(pa)` (`u64::MAX` for IALLU), and the run loop drops the blocks of that
  physical page (a map from page to the keys filed under it, so IVAU on a page without code costs
  one lookup) or all of them. Invalidation is per 4 KiB page.
- **The stale-code checker** (`jit::Config::check`, on in JIT-stress) hashes each block's words
  when it's compiled and again at every entry (chained entries and back-edges call
  `jit_check(vcpu, key)`), and panics (trapping the wasm run) on a mismatch.

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
  DMB/DSB are no-ops (one vCPU; M7 revisits them).
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
- **Regions of every seen successor** duplicated each block into ~5 regions and cost Buildroot
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
- **Vector registers in locals** wasn't built: no profile asked for it (the boots and CoreMark use
  little NEON). It's the lever for AES-CBC (latency-bound on the V registers' store and reload
  between instructions) and NEON-heavy code generally.

## Validation

The golden corpus through the JIT (forced and stress), the JIT-vs-interpreter differential test on
random words and sequences (`tests/jit-diff.test.ts`), lockstep (`tests/jit-lockstep.test.ts`),
every boot's exact steps under the JIT, and planted bugs for every new rule. Details in
[testing.md](testing.md).
