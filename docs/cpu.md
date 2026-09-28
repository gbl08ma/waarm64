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
- `MPIDR_EL1` = `1 << 31` (one CPU, Aff0 = 0). M7 changes this per vCPU.
- `ID_AA64PFR0_EL1`: FP and AdvSIMD = 0 (present, no FP16); **CSV2 and CSV3 set** (nothing
  speculates, which spares the guest Spectre mitigations and KPTI).
- `ID_AA64ISAR0_EL1` (`interp::sys::isar0`): LSE, CRC32, and with the crypto feature AES = 2,
  SHA1 = 1, SHA2 = 1 (0x211120 with it on; the bare-metal `exceptions` test checks this value).
  `ID_AA64ISAR1_EL1` reports none of RDM, DotProd, FHM, FCMA, JSCVT, FRINTTS, BF16, I8MM; no AFP.
- `ID_AA64MMFR0_EL1`: 4K granule, 16-bit ASIDs, 40-bit PA.
- `CTR_EL0`: IDC = 1 (no data cache to clean), **DIC = 0**, so guests issue `IC IVAU` after
  writing code, which is what the JIT's invalidation relies on ([jit.md](jit.md)).
- `DCZID_EL0.BS` = 4: `DC ZVA` zeroes 64 bytes, as on the M4 (QEMU's `max` uses 512).
- `CLIDR_EL1` = 0 (no caches, so set/way operations are NOPs).
- The unnamed part of the ID space reads as zero.
- Linux derives the hwcaps (and `/proc/cpuinfo`, and userspace's `getauxval`) from these.
- Spectre reporting: Linux prints "Spectre-v4" and "Spectre-BHB" as "Vulnerable" because MIDR 0
  is on none of its safe lists; nothing is mitigated (backlog).

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
- WFI: see the run loop ([platform.md](platform.md)). **WFE completes at once** (one vCPU: nothing
  to wait for; M7 revisits it).

## System registers

The table is `core/src/interp/sys.rs`.
- EL0-accessible: `TPIDR_EL0`, `TPIDRRO_EL0`, `CTR_EL0`, `DCZID_EL0`, `CNTVCT_EL0`,
  `CNTFRQ_EL0`; Linux emulates EL0 reads of ID registers.
- The v8.0 registers that exist at EL1 when it's the highest EL: `ACTLR_EL1`, `OSECCR_EL1`,
  `OSDTRRX/TX_EL1`, `DBGDTR_EL0`, `DBGDTRRX/TX_EL0` are RAZ/WI; `MDRAR_EL1`,
  `DBGAUTHSTATUS_EL1`, `MDCCSR_EL0`, `RVBAR_EL1` read as zero; `RMR_EL1` reads 1 (AA64) and
  ignores writes (no warm reset). `IC IALLU(IS)` with Rt ≠ 31 executes as with 31.
- Left out (the decoder sweep's `SYS_NOT_OURS`, UNDEFINED): EL2/EL3 and secure state, AArch32
  banked registers, GICv3's `ICC_*`, PMU, SPE, AMU, trace, RAS, BRBE, MPAM, SVE/SME, MTE, PAuth
  keys, LOR, RNG, post-v8.0 PSTATE fields, range and outer-shareable TLBI, AT with PAN,
  `DC CVAP`, and breakpoints/watchpoints past the two advertised.
- The generic timer registers ([platform.md](platform.md)) and `ISR_EL1` leave the interpreter
  (`Exit::Platform`) and complete in the run loop with the exact step count.

## MMU and TLB (`core/src/mmu.rs`)

- **Stage 1 only, 4K granule, 48-bit VA**, TTBR0/TTBR1 with T0SZ/T1SZ 16–39, TBI, EPD, IPS
  capped at the 40-bit PARange, APTable/UXNTable/PXNTable, WXN, the implicit PXN on
  EL0-writable pages, **software-managed access flag** (no hardware AF/DBM).
- AT S1E{0,1}{R,W} into `PAR_EL1`. TLBI VMALLE1, ASIDE1, VAE1, VAAE1, VALE1, VAALE1 and their IS
  forms (no range or outer-shareable forms).
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
- The interpreter has three copies of `exec` over a `Bus`: flat (MMU off), MMU, and `vm::Io`
  for device MMIO ([platform.md](platform.md)); the choice is made outside the instruction loop.
- Loose ends (backlog): no Device-memory alignment faults, no address-size fault for VAs past 40
  bits with the MMU off, PRFM with a misaligned SP base faults, cache maintenance by VA to a
  device PA faults.

## Memory accesses and atomics (`core/src/mem.rs`)

- Guest RAM is one region of the shared wasm memory (layout A). Plain accesses are
  `ptr::read/write_unaligned` of up to 8 bytes.
- Exclusives, LSE atomics and LDAR/STLR use real wasm atomics even single-core (SMP-ready).
- **Exclusives are compare-and-swap based:** `STXR` succeeds if memory still holds the value
  `LDXR` saw (ABA-tolerant, as QEMU).
- **128-bit atomics:** wasm has no 128-bit CAS, so `CASP` and 64-bit-pair `LDXP`/`STXP` run
  under one spinlock (`Mem::pair_locked`). The lock only excludes other pair operations; M7
  must decide how to keep single-copy atomicity against plain or 64-bit atomic accesses from
  other vCPUs.
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
