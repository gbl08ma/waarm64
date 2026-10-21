# The guest CPU

What the emulated arm64 CPU is, as built: the ISA it implements, what it advertises, the
exception model, system registers, the MMU and TLB, floating point and the crypto extensions.
The interpreter (`core/src/interp*`) is the reference semantics; the JIT ([jit.md](jit.md)) must
match it step for step.

## ISA and features

- **ARMv8.0-A AArch64** with FP and AdvSIMD (NEON). No AArch32.
- **v8.1 LSE atomics** and **CRC32**.
- **Crypto extensions** (FEAT_AES with PMULL, FEAT_SHA1, FEAT_SHA256): switchable per VM with
  `VmConfig.features` bit 0 (`FEATURE_CRYPTO`, [abi.md](abi.md)). **On by default** in `bootVm` and
  the native runners (`crypto: false` turns them off). When off, the instructions are UNDEFINED,
  as on a CPU without the feature, so guests that probe by SIGILL (the `hwcap` kselftest) see what
  the ID register says. The user-mode entry points (`vcpu_new`, `jit_new`: the corpus, the
  differential tests, `bench/interp`) always have them, since the golden corpus records the M4's
  behavior.
- **FEAT_RNG** (`RNDR`, `RNDRRS`, at EL0 and EL1) and **FEAT_E0PD** (`TCR_EL1.E0PD0`/`E0PD1`):
  `VmConfig.features` bits 1 and 2 (`FEATURE_RNG`, `FEATURE_E0PD`, ABI 35). **On by default** in
  `bootVm` (`rng: false`, `e0pd: false` turn them off), the native runners and so the test guests and
  benchmarks, and on the page's machines (`web/app/worker.ts`; `?rng=0`, `?e0pd=0` turn one off
  for an A/B; a snapshot keeps its machine's). The bare-metal tests run without them (their
  `exceptions` test checks the ID registers' values). An `RNDR` read leaves the block (`Exit::Platform`) and the run loop
  answers from the vCPU's ChaCha20 stream (`rng.rs`: keyed by the host's `crypto.getRandomValues`
  in realtime mode, by zeros in deterministic mode, the vCPU's index as the nonce; a snapshot keeps
  each stream's block counter, a restored realtime VM goes on with its own key). It never fails
  (NZCV = 0000). Linux then has its crng at once on a direct boot (Alpine: 0 s, against 16.7 s
  waiting for `virtio_rng`) and on the way takes 6% fewer steps to boot Alpine. E0PD makes an EL0 access to
  the half it covers a level 0 translation fault before the walk (`mmu::e0pd`, also for `AT
  S1E0*`, LDTR/STTR and fetches); it is there for Linux's `kaslr_requires_kpti`: **a KASLR kernel
  forces KPTI on unless the CPU has E0PD**, whatever CSV3 says, and KPTI makes every kernel entry
  and exit an ASID switch, which drops the TLB's nG entries (and KPTI maps the kernel nG). The
  page's Debian has KASLR whatever we do (the EFI stub randomizes with EDK2's `EFI_RNG_PROTOCOL`,
  which comes from the virtio-rng): bench/boot/REPORT.md "M9: FEAT_RNG and FEAT_E0PD".
- **Left out, unadvertised:** SVE/SME, PAC, BTI, MTE, EL2/EL3, secure state. Their hint-space
  encodings (the PAC and BTI hints, CSDB, …) run as NOPs. Everything else the M4 has beyond v8.0
  (FP16, BF16, FHM, RDM, DotProd, I8MM, FCMA, JSCVT, FRINTTS, LSE2, RCpc, FlagM, SB, DIT, SHA512,
  SHA3, SM3/SM4, LOR, MOPS, HBC) is UNDEFINED and unadvertised. Candidates for later are in
  [backlog.md](backlog.md) "Unadvertised extensions".
- **Rule: ID registers advertise exactly what's implemented.** One deliberate exception:
  `ID_AA64DFR0_EL1` advertises the architectural minimum for self-hosted debug (v8.0 debug, 2
  breakpoints, 2 watchpoints, 1 context comparator), because ARMv8.0 doesn't allow less; the
  breakpoint and watchpoint registers are RAZ/WI, the OS lock is only state, and no debug
  exceptions are raised (backlog: self-hosted debug).

### ID registers and identification

- `MIDR_EL1`: implementer 0 (software use).
- `MPIDR_EL1`: `Cpu::mpidr`, per vCPU (`gicv3::mpidr`: `1 << 31`, Aff1 = i / 16, Aff0 = i % 16;
  `1 << 31` for one CPU).
- `ID_AA64PFR0_EL1`: FP and AdvSIMD = 0 (present, no FP16); **CSV2 and CSV3 set** (nothing
  speculates, which spares the guest Spectre mitigations and KPTI, unless its kernel has KASLR and
  the CPU no E0PD: above); GIC = 1 in a VM (the GICv3's
  system-register interface, `cpu::FEATURE_GICV3`), 0 for user-mode vCPUs.
- `ID_AA64ISAR0_EL1` (`interp::sys::isar0`): LSE, CRC32, and with the crypto feature AES = 2,
  SHA1 = 1, SHA2 = 1 (0x211120 with it on; the bare-metal `exceptions` test checks this value),
  and RNDR = 1 with FEAT_RNG.
  `ID_AA64ISAR1_EL1` reports none of RDM, DotProd, FHM, FCMA, JSCVT, FRINTTS, BF16, I8MM; no AFP.
- `ID_AA64MMFR0_EL1`: 4K granule, 16-bit ASIDs, 40-bit PA. `ID_AA64MMFR2_EL1` (`interp::sys::mmfr2`):
  E0PD = 1 with FEAT_E0PD, else 0.
- `CTR_EL0`: IDC = 1 (no data cache to clean), **DIC = 0**, so guests issue `IC IVAU` after
  writing code, which is what the JIT's invalidation relies on ([jit.md](jit.md)).
- `DCZID_EL0.BS` = 4: `DC ZVA` zeroes 64 bytes, as on the M4 (QEMU's `max` uses 512).
- `CLIDR_EL1` = 0 (no caches, so set/way operations are NOPs).
- The unnamed part of the ID space reads as zero.
- Linux derives the hwcaps (and `/proc/cpuinfo`, and userspace's `getauxval`) from these.
- Spectre reporting: Spectre-v2 is cleared by CSV2 and Spectre-v4 (`spec_store_bypass`) by the core's
  SMCCC 1.1 answers over the PSCI conduit (`ARCH_FEATURES` says `ARCH_WORKAROUND_1`, `_2` and `_3` are
  NOT_REQUIRED, [platform.md](platform.md) "PSCI"); v4 has no other way here (no SSBS, MIDR 0 is on no safe
  list). **Spectre-BHB stays "Vulnerable"**, so `spectre_v2` reads "Mitigation: CSV2, but not BHB": Linux
  clears BHB only with CSV2_3 (needs `SCXTNUM_ELx`), ECBHB (reads "Mitigated") or a MIDR on its list;
  an SMCCC answer can't (found by reading `proton-pack.c`, 6.18; backlog).

## Privilege and exceptions

- **EL0 and EL1 only.** PSTATE EL/SPSel/DAIF with banked SP; exception entry and ERET (illegal
  returns take the Illegal Execution State exception).
- EL0 → EL1 traps: `SCTLR_EL1` UCT/UMA/DZE/UCI/nTWI/nTWE, `CPACR_EL1.FPEN` (which also covers
  FP/SIMD loads and stores and FPCR/FPSR accesses). Trapped FP and WFx ISS use CV = 1, COND = AL,
  as QEMU does.
- **HVC at EL1 is a PSCI call** ([platform.md](platform.md)); `SMC`, `HLT`, `DCPS1-3`, `DRPS` are
  UNDEFINED (no EL3, no halting debug); `ERET` is UNDEFINED at EL0.
- **Alignment:** `SCTLR_EL1.A` alignment faults; SP alignment faults (`SA`/`SA0`, EC 0x26) —
  QEMU TCG doesn't raise these, the M4 (hvf) does, and we follow the architecture. Exclusives,
  LDAR/STLR and LSE atomics need natural alignment (v8.0 rules; we don't advertise LSE2, which the
  M4 and QEMU implement: see [testing.md](testing.md) "Known oracle behavior").
- `Cpu::default()` is a Linux user process at EL0; `Cpu::reset()` the EL1 boot state.
- WFI: see the run loop ([platform.md](platform.md)). **WFE completes at once** with one vCPU
  (nothing to wait for); with more, in round-robin it ends the vCPU's quantum unless an event
  (SEV, SEVL) is pending, and SEV/SEVL set events; in parallel SMP it's a yield (it ends the
  chunk) and SEV does nothing ([platform.md](platform.md) "The run loop").

## System registers

The table is `core/src/interp/sys.rs`.
- EL0-accessible: `TPIDR_EL0`, `TPIDRRO_EL0`, `CTR_EL0`, `DCZID_EL0`, `CNTVCT_EL0`,
  `CNTFRQ_EL0`; Linux emulates EL0 reads of ID registers.
- The v8.0 registers that exist at EL1 when it's the highest EL: `ACTLR_EL1`, `OSECCR_EL1`,
  `OSDTRRX/TX_EL1`, `DBGDTR_EL0`, `DBGDTRRX/TX_EL0` are RAZ/WI; `MDRAR_EL1`,
  `DBGAUTHSTATUS_EL1`, `MDCCSR_EL0`, `RVBAR_EL1` read as zero; `RMR_EL1` reads 1 (AA64) and
  ignores writes (no warm reset). `IC IALLU(IS)` with Rt ≠ 31 executes as with 31.
- The GICv3 CPU interface (`ICC_*_EL1`, in a VM): [platform.md](platform.md) "The GIC".
- Left out (the decoder sweep's `SYS_NOT_OURS`, UNDEFINED): EL2/EL3 and secure state, AArch32
  banked registers, `ICC_AP{0,1}R1–3_EL1` (5 priority bits) and `ICC_NMIAR1_EL1`, PMU, SPE, AMU, trace, RAS, BRBE, MPAM, SVE/SME, MTE, PAuth
  keys, LOR, RNG, post-v8.0 PSTATE fields, range and outer-shareable TLBI, AT with PAN,
  `DC CVAP`, and breakpoints/watchpoints past the two advertised.
- The generic timer registers ([platform.md](platform.md)), `ISR_EL1` and the `ICC_*` registers
  leave the interpreter (`Exit::Platform`) and complete in the run loop with the exact step count.

## MMU and TLB (`core/src/mmu.rs`)

- **Stage 1 only, 4K granule, 48-bit VA**, TTBR0/TTBR1 with T0SZ/T1SZ 16–39, TBI, EPD, IPS
  capped at the 40-bit PARange, APTable/UXNTable/PXNTable, WXN, the implicit PXN on
  EL0-writable pages, **software-managed access flag** (no hardware AF/DBM).
- AT S1E{0,1}{R,W} into `PAR_EL1`. TLBI VMALLE1, ASIDE1, VAE1, VAAE1, VALE1, VAALE1 and their IS
  forms (no range or outer-shareable forms); with more than one vCPU the IS forms leave the
  interpreter (`Exit::TlbiIs`, retired): round-robin does them on the other vCPUs' TLBs at once,
  parallel SMP queues them and the issuer's next DSB waits ([platform.md](platform.md) "Broadcast
  maintenance").
- Faults carry kind, level and access (ESR WnR, CM). Cache maintenance by VA translates and
  faults like a read (`DC IVAC` like a write).
- **The TLB** is the M0 spike's shape: direct-mapped, 4096 entries × {tag, addend} (16 bytes) per
  (EL, read/write/execute). The tag is the page VA with bits 11:0 all ones (**bits 11:3 are
  reserved for an inverted memory index**, layout A's escape hatch, [architecture.md](architecture.md));
  a lookup compares with `(va + size − 1) | 0xfff`, so page-crossing accesses miss and are
  split. The host address is `va + addend` (QEMU-style). MMIO and unmapped pages always miss.
- **ASIDs:** entries hold no ASID. An ASID change or `TLBI ASIDE1` drops only the non-global
  (nG) entries, tracked in `Tlb::ng` (up to 1024 slots, else a full flush); a change of
  `SCTLR_EL1.M` flushes everything. (Keeping global entries cut Alpine's boot misses 3.61M →
  1.07M.) Per-ASID stashes of nG entries are a backlog item.
- **Blocks:** a 2 MiB or 1 GiB leaf is cached as entries for the pages it was used through, and
  a TLBI by VA drops every one of them, not only its own page's: Linux unmaps a transparent huge
  page with one TLBI for the 2 MiB. `Tlb::blk` marks the slots filled from blocks by class (VA
  half, level) and `Tlb::nblk` counts them; a flush by VA scans the block's indices (512 for
  2 MiB, all 4096 for 1 GiB) only for a class the TLB holds, and drops an EL's transfer cache if
  its instruction TLB filled from a block in that half. Without this, stale pages of a freed THP
  stayed mapped until the next ASID switch: hidden while KPTI switched ASIDs at every kernel entry,
  it corrupted glibc's heap in dEQP once FEAT_E0PD let a KASLR kernel run without KPTI
  (`c3ae697`; bisected and narrowed with `kpti=1`, `nokaslr` and `transparent_hugepage=never`
  guests).
- The TLB also holds the JIT's **transfer cache** (`Tlb::xc`, VA to compiled block), which every
  flush above drops its share of ([jit.md](jit.md) "Linking").
- The interpreter has three copies of `exec` over a `Bus`: flat (MMU off), MMU, and `vm::Io`
  for device MMIO ([platform.md](platform.md)); the choice is made outside the instruction loop.
- Loose ends (backlog): no Device-memory alignment faults, no address-size fault for VAs past 40
  bits with the MMU off, PRFM with a misaligned SP base faults, cache maintenance by VA to a
  device PA faults.

## Memory accesses and atomics (`core/src/mem.rs`)

- Guest RAM is one region of the shared wasm memory (layout A), shared by every vCPU's thread in
  parallel SMP.
- **The core's accesses are relaxed atomics** (`mem::load`/`store`: the interpreter, the table
  walker's descriptor reads, instruction fetch, DC ZVA): a plain Rust access racing another
  thread's is UB, even where the hardware is fine. An aligned access is one single-copy-atomic
  access; an unaligned one is split into naturally aligned pieces (the architecture asks only for
  bytes: we don't advertise LSE2). ThreadSanitizer checks this natively with nothing suppressed.
  **The cost** is on wasm, whose atomics are all sequentially consistent (`ldar`/`stlr` on arm64):
  the interpreter with the MMU on (`vm_mmu_mips`) went from 88.7 to 79.0 MIPS, half from the
  alignment test and half from the ordering; volatile plain accesses (UB all the same) measured no
  better. The interpreter runs ~1.4% of Alpine's boot, which stayed within noise
  (`bench/interp/REPORT.md` "M7 loop 6"). JIT code uses plain wasm loads and stores, which wasm
  defines under races ([jit.md](jit.md) "Atomics").
- Exclusives, LSE atomics and LDAR/STLR use real wasm atomics even single-core (SMP-ready), all
  sequentially consistent (stronger than acquire/release).
- **Exclusives are compare-and-swap based:** `STXR` succeeds if memory still holds the value
  `LDXR` saw (ABA-tolerant, as QEMU).
- **Barriers:** the interpreter fences at every DMB/DSB (`fence(SeqCst)`, `atomic.fence` on
  wasm); the JIT only in parallel SMP ([jit.md](jit.md) "Atomics"). litmus7's tests pass on 4
  parallel vCPUs, and a DMB emitted as nothing fails MP+dmb.sys and SB+dmb.sys
  ([testing.md](testing.md) "Litmus tests").
- **128-bit atomics** (`CASP`, `LDXP`/`STXP` of two X registers; the 32-bit pairs are one 64-bit
  atomic): wasm has no 128-bit CAS. They run under a lock that only other pair ops take, hashed by
  address (16 cache-line-sized locks, so per-CPU pairs don't contend), and write each half with a
  64-bit CAS against what they read: a store to the low half since the read fails that CAS before
  anything is written (the op starts over), and a store to the high half is ordered after the op
  and kept. So pair ops are single-copy atomic against each other and never overwrite a racing
  plain or 64-bit store. **Not covered:** a 64-bit atomic read-modify-write of the high half inside
  the op's two-CAS window (both would have read the old value), and an observer that reads the
  halves with ordered 64-bit loads during it (it can see the new low half with the old high one).
  No guest we run does either: Linux's `cmpxchg128` users (SLUB's freelist and counters, ~300K
  CASPs in an Alpine boot, all at EL1) and libatomic's 16-byte atomics reach those bytes only
  through pair ops. **Why not the alternatives:** stopping the world per pair op
  costs up to a chunk of every other vCPU each time, at SLUB's one CASP per ~10K instructions; a
  lock taken by every 64-bit atomic too would tax every LDXR/LDADD/CAS and still not cover plain
  stores. The JIT runs CASP and LDXP/STXP inline with the same lock and CASes ([jit.md](jit.md) "Atomics").
  `tests/baremetal/pairs.c` checks it (CASP and LDXP/STXP against each other and against
  plain stores; passes on QEMU TCG and on the M4 under hvf).
- `Mem::rmw` is a generic CAS loop (the JIT does the LSE operations as single `atomic.rmw` ops).

## Floating point (`core/src/fp.rs`)

Wasm arithmetic is round-to-nearest-even only, has nondeterministic NaN payloads and no scalar
FMA, so:
- **Software FP**, our own implementation written from the ARM pseudocode (FPRound with tininess
  before rounding, FZ, DN, the ARM NaN order) over one generic u128 unpack/round/pack for half,
  single and double. Chosen over porting SoftFloat: smaller and ARM-specific.
- **Fast paths:** single and double add/sub/mul/div/sqrt use host arithmetic in RNE when inputs
  are normal and the result is normal above the smallest binade, with Inexact computed exactly.
- NaNs are fixed up to ARM propagation rules (or the default NaN with `FPCR.DN`) after each op.
- `FMADD` and friends use the exact software FMA.
- FPCR RMode/FZ/DN/AHP and the FPSR cumulative flags and QC are implemented.
- **Validation:** TestFloat 3e (`scripts/testfloat.sh`, 51.2M cases under every FZ/DN
  combination) and the golden corpus natively and on wasm (host float behavior is where native
  and wasm builds can diverge).
- The JIT's exact FP fast paths are in [jit.md](jit.md) "Floating point".

## Crypto extensions (`core/src/crypto.rs`)

AESE/AESD/AESMC/AESIMC, PMULL/PMULL2 (8- and 64-bit), SHA1C/P/M/H/SU0/SU1, SHA256H/H2/SU0/SU1.
- **Our own Rust** from FIPS 197, FIPS 180-4 and the Arm pseudocode (nothing ported; papers
  credited in `THIRD_PARTY.md`). Table-free, because that measured fastest: SubBytes as the
  GF(2⁸) inverse (x²⁵⁴ by an addition chain of bytewise SWAR multiplies) plus the affine map;
  (Inv)MixColumns by `xtime` and rotations; `PMULL.1Q` as Karatsuba over 32×32 multiplies with
  holes. Scalar Rust, since the core is built without `simd128`.
- **Constant time is not a requirement** (decided 2026-09-28): we control the wasm we emit, not
  what V8 makes of it, and the guest's NEON fallbacks have no timing guarantees on our JIT
  either. Turning the extensions off isn't the safer setting anyway: OpenSSL's GHASH without
  PMULL is `gcm_ghash_4bit`, tables indexed by the hash key.
- **Why not the Web Crypto API** (settled): the instructions are single rounds and bare
  multiplies, `crypto.subtle` only does whole asynchronous operations with its own key schedule,
  and the vCPU runs synchronously inside one wasm call. A paravirtual crypto device would need
  AF_ALG in userspace, which Linux 7.2 deprecated (CVE-2026-31431).
- **Why they're advertised:** with them on, `openssl speed` beats the NEON-only paths in every
  row (AES-GCM 4.6–4.7×, AES-CBC 3.4×, SHA-256 3.4×, SHA-1 1.5× at 16 KiB), and Alpine boots in
  5.1% fewer steps (`bench/interp/REPORT.md` "M6.5 loop 7"). The rule stands for future
  extensions: **advertise only if faster than the paths guests use without them.**

## Decoder (`core/build.rs` ← `core/src/a64/a64.inc`)

- Generated from dynarmic's pattern table (0BSD, attributed in `THIRD_PARTY.md`).
- Should-be-one fields are relaxed to match the M4, except in CAS/CASP, where the M4 raises
  UNDEFINED.
- Checked exhaustively against Capstone 5.0 ([testing.md](testing.md) "Decoder sweep").

## The block interpreter (`core/src/interp/block.rs`)

The interpreter has two forms. `interp::steps` fetches, decodes and runs one instruction at a time:
the reference, and what `VmConfig.jit` 0 runs. **The block interpreter** runs what the JIT's
dispatcher hasn't compiled (`jit::steps`; [jit.md](jit.md) "Dispatch"): every block the first
`threshold` times, and natively everything (no wasm engine), so the native boots with `jit` ≠ 0
test it against `tests/steps.txt`.

- **A block is the JIT's** (`jit::block::form`, the same key: PA and regime bits), decoded once into
  16-byte micro-ops with their operand fields pulled out and kept in the vCPU table's cache. The
  common integer forms (ADD/SUB in all three operand forms, the logical ones, MOV, MOVZ/N/K,
  UBFM/SBFM, the variable shifts, CSEL & co, CCMP/CCMN, MADD/MSUB, ADR/ADRP), every branch, and
  the integer loads and stores (single register in every addressing form but the unprivileged
  one, pairs, literal) have handlers; the rest is a generic micro-op that runs the interpreter's
  own code with the decoded `Op` (`interp::exec_at_op`). One micro-op is one instruction, so the
  steps and the exits are `interp::steps`'s for the same instructions.
- **Loads and stores** try the TLB entry inline (`Bus::fast`) and take the interpreter's path on a
  miss, so faults are the interpreter's.
- **One call-free loop** (`interp::block::hot`): the blocks run, and chain from one to the next, in a
  loop with no call on any path (no generic micro-op, no slow load or store, no TLB walk, no panic:
  register indexes masked, the slots a fixed-size array), so V8 keeps its state in registers. What
  needs a call returns a status to `jit::interpret`, which runs that one micro-op through `run` (the
  slow path) or finds the next block, and calls `hot` again. +26% on the user-mode guest, +56-68% at
  EL1, +13% and +18% on the Buildroot and Alpine boots (`bench/interp/REPORT.md` "M8-INTERP loop 1").
- **Chaining:** after a block that ends on a branch or runs out, the next block is found without
  going back to the dispatcher (`jit::interpret`): in the same page from the block's own key (a
  block ends after anything that could change the translation), in another through the
  instruction TLB. The chain stops at a compiled block, at a block not decoded yet or due to report
  its dispatches, after a block that ends on an instruction run generically (an MSR, ERET: the
  regime may have changed), at an exit, or when the chunk's steps run out.
- **Counting:** a decoded block counts its dispatches in its slot and reports them to the shared
  cache every 16 (`REPORT`; the cache's lock and map lookup were a third of the time), and the
  dispatch that reaches the compile threshold reports itself (the cache returns how many may be
  counted before it), so a block joins the pending batch exactly when it did with every dispatch
  reported. A cache that never compiles (`VmConfig.jit` 4, or no JIT: natively) has its blocks report
  every 255 (`REPORT_IDLE`): the block interpreter alone +30% on the user-mode guest, +16% on Alpine's
  boot. Not in the JIT: reports every 255 there delayed the batches and shrank the regions (the
  forward regions take the members whose counts the cache has seen), and Alpine's boot interpreted
  2.5× the steps (`bench/interp/REPORT.md` "M8-INTERP loop 2"). Without that, blocks of one path joined different batches, and the forward regions,
  which take only their batch's blocks, came out 30% more and smaller (Alpine's boot 8% slower): check
  `blocks` against `regionBlocks` in a run's counters whenever the batching changes.
  A slot's count and the quota it had left survive eviction (the map keeps them), so a block put back in its slot
  counts on instead of reporting at once (before, 62% of the cache's lock acquisitions in Firefox's pages session).
  A key with no instructions (an SVC first, say) is kept too, with length 0, so the dispatcher asks the JIT's cache
  about it once ([jit.md](jit.md) "Sharing").
- **The cache** (per JIT table, so per vCPU in parallel SMP): 16,384 direct-mapped slots, a map,
  and the micro-ops in one arena, which starts over when full. **The arenas share 16M micro-ops
  (256 MiB) among a VM's tables, at most 8M a table** (`interp::block::budget`, through
  `jit::Config::decoded`): 8M on one or two vCPUs, 4M on four, 2M on eight; they grow as they
  fill (Alpine decodes ~1M). At 2M a table, Chromium in Debian on 4 vCPUs re-decoded ~3.5M blocks
  a render; 4M halved that and made the warm renders ~3.5% faster; 8M ran the core's 1 GiB heap
  out. Evicting instead of starting over (keeping the newer half, or the blocks that ran in the
  last half of the arena's fill, compacted) won half of that at 2M and nothing at 4M: what fills
  the arena is code that runs again, not dead blocks (`bench/apps/REPORT.md` "M8: the decoded
  blocks' arenas"). **Invalidation is by
  page:** every `IC IVAU` (and `IC IALLU`) is logged in the shared cache (`Cache::ival_log`, with
  its own counter, so the transfer caches aren't touched), and a table drops that page's decoded
  blocks when it catches up, before its vCPU runs another block. Flushes of the code cache and the
  links between compiled blocks don't touch decoded ones: tying them to the JIT's dropped keys
  (which follow links transitively) emptied the caches a few dozen times per Chromium render.
- **Tests:** a native differential test of random blocks against `interp::steps`
  (`interp::block::tests`), the golden corpus in it on wasm (`tests/corpus-wasm.test.ts`), the
  native boots through it (`linux_boots_through_the_block_interpreter`,
  `alpine_boots_through_the_block_interpreter`; `WEBPC_NATIVE_JIT=1` for every native guest test),
  and every JIT run's cold code with exact steps.
