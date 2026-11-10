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
- **FEAT_SHA512 and FEAT_SHA3** (`SHA512H`/`H2`/`SU0`/`SU1`; `EOR3`, `RAX1`, `XAR`, `BCAX`):
  `VmConfig.features` bit 3 (`FEATURE_SHA3`, ABI 51), together and only with the crypto extensions
  (`cpu::has_sha3`; SHA512 needs SHA256, and Armv8.4 makes the two one choice). **On by default**
  in `bootVm` (`sha3: false` turns them off), the native runners and the page's machines (`?sha3=0`;
  a snapshot keeps its machine's, and the shape's hash leaves the feature out, so the snapshots kept
  before it still match: [frontend.md](frontend.md)); the bare-metal tests run without them. The
  user-mode entry points have them (the corpus is the M4's).
- **FEAT_JSCVT** (`FJCVTZS`: JavaScript's ToInt32 of a double, toward zero, modulo 2^32, NZCV = 0Z00
  with Z set when exact; `fp::Fpu::to_int_js`): `VmConfig.features` bit 4 (`FEATURE_JSCVT`, ABI 59),
  `ID_AA64ISAR1_EL1.JSCVT` = 1, Linux's `jscvt` hwcap. **On by default** in `bootVm` (`jscvt: false`
  turns it off), the native runners and the page's machines (`?jscvt=0`; a snapshot keeps its machine's,
  and the feature is in the shape's hash); the bare-metal tests run without it, the user-mode
  entry points with it. V8 and SpiderMonkey use it for ToInt32 when the hwcap says so, from generated code (their binaries hold none); the JIT
  runs it inline ([jit.md](jit.md) "Floating point"), level with or ahead of the FCVTZS they use without it
  (bench/boot/REPORT.md "FEAT_DotProd and FEAT_JSCVT, measured").
- **Small extensions past v8.0** (ABI 59), each its own `VmConfig.features` bit, on and switched as JSCVT is
  (`rcpc: false` and `?rcpc=0`, and so on), in the shape's hash. Not measured one by one. LDAPR runs LDAR's code, SB is free, and FRINTTS is inline. The FlagM forms are helper
  calls, slower than the inline flag code a compiler emits without them. That costs only code built for v8.4 and
  up, which has no other path anyway; distributions' binaries target v8.0, and nothing known dispatches on the
  hwcap:
  - **FEAT_LRCPC** (bit 5, `FEATURE_RCPC`, `rcpc`): `LDAPR`, `LDAPRB`, `LDAPRH` run as `LDAR` (RCsc is stronger
    than RCpc asks, which is allowed), the JIT's inline LDAR included. FEAT_LRCPC2 is its own bit (below).
  - **FEAT_SB** (bit 6, `FEATURE_SB`, `sb`): `SB` is a NOP (nothing speculates), inline in the JIT.
  - **FEAT_FlagM and FEAT_FlagM2** (bit 7, `FEATURE_FLAGM`, `flagm`): `CFINV`, `RMIF`, `SETF8`, `SETF16`,
    `XAFLAG`, `AXFLAG` (`interp::flagm`); helper calls in the JIT (compilers rarely emit them).
  - **FEAT_DIT** (bit 8, `FEATURE_DIT`, `dit`): PSTATE.DIT (`cpu::PSTATE_DIT`, bit 24 as in SPSR) through
    `MSR DIT, #imm`, `MSR`/`MRS DIT`; exception entry keeps it and copies it to SPSR, ERET takes it back
    (an illegal return too). It changes no timing: the emulator promises no data-independent timing either way.
  - **FEAT_FRINTTS** (bit 9, `FEATURE_FRINTTS`, `frintts`): `FRINT32Z`, `FRINT32X`, `FRINT64Z`, `FRINT64X`,
    scalar and vector (`fp::Fpu::round_int_n`, FPRoundIntN: out of range, a NaN or an infinity gives
    -2^(N-1) and Invalid only), inline in the JIT ([jit.md](jit.md)). dynarmic's table swaps the vector X forms'
    names (its `FRINT32X_1` is opcode 11111, FRINT64X): the handlers read the size from the encoding.
- **FEAT_DotProd** (`SDOT`, `UDOT`, vector and by element; `interp::simd_int::dot`): `VmConfig.features` bit 10
  (`FEATURE_DOTPROD`, ABI 60), `ID_AA64ISAR0_EL1.DP` = 1, Linux's `asimddp` hwcap, on and switched as JSCVT is
  (`dotprod: false`, `?dotprod=0`), in the shape's hash; inline in the JIT ([jit.md](jit.md)). Who uses it (words in
  the guests' binaries): dav1d (174), x264 (248), libvpx (1,200-2,300), libaom (4,900), Arch's Firefox's libgkcodecs
  (2,900), Chromium (6,500); **not libjpeg-turbo, libwebp, OpenH264 or rav1e** (none). Level with the NEON paths, so
  advertised: bench/boot/REPORT.md "FEAT_DotProd and FEAT_JSCVT, measured".
- **FEAT_I8MM** (`USDOT` vector and by element, `SUDOT` by element, `SMMLA`, `UMMLA`, `USMMLA`;
  `interp::simd_int::usdot`, `mmla`): `VmConfig.features` bit 11 (`FEATURE_I8MM`, ABI 61),
  `ID_AA64ISAR1_EL1.I8MM` = 1, Linux's `i8mm` hwcap, switched as JSCVT is but off by default (below), in the
  shape's hash when on; inline in the JIT ([jit.md](jit.md)). Who uses it (the desktop guest, from HWCAP2_I8MM; executed
  through the JIT, a diagnostic build): dav1d's 8-bit motion compensation (5.5 M USDOT and 8.6 M USMMLA in 200
  frames of AV1), libvpx's VP9 convolutions (62 M in 200 frames decoded, 2 M in 48 encoded), FFmpeg's HEVC (19.5 M
  USDOT in 288 frames), x264 (11.5 M in 96 frames), x265 (46 M USDOT and 21 M USMMLA in 24 frames), ggml-style int8
  tiles (SMMLA); libaom's real-time encoder runs none, FFmpeg's VP9 and H.264 none. **Off by default**
  (`cpu::DEFAULT_FEATURES`; `bootVm`'s `i8mm: true`, the page's `?i8mm=1`, a machine's shape then has it), so
  unadvertised: the codecs are level with their DotProd paths (six rounds on the Mac, every pair overlapping), and
  the int8 tile is **19% slower** with SMMLA, rounds apart. A matrix product is about 19-22 host instructions here
  (wasm has no mixed-sign or matrix multiply, and summing its four outputs across takes two levels of shuffles), so
  two of them and the zips that feed them cost more than the four SDOTs (8 each) a guest without I8MM runs; USDOT
  (12) is dearer than SDOT and the bias trick the DotProd paths use. On the M4 itself the tile is slower with SMMLA
  too (1.32 against 0.65 ns). bench/boot/REPORT.md "PERF loop 5: FEAT_I8MM".
- **FEAT_RDM** (`SQRDMLAH`, `SQRDMLSH`, vector, scalar and by element, on halfwords and words;
  `interp::simd_int::rdm`): `VmConfig.features` bit 12 (`FEATURE_RDM`, ABI 62), `ID_AA64ISAR0_EL1.RDM` = 1, Linux's
  `asimdrdm` hwcap, on and switched as JSCVT is (`rdm: false`, `?rdm=0`), in the shape's hash; inline in the JIT
  ([jit.md](jit.md)). One rounding and one saturation of Vd << esize ± 2xy, not SQRDMULH's then SQADD's (they differ
  by one where MIN × MIN meets a negative Vd). Who uses it: of the desktop and Debian guests' binaries only
  glycin's image loader (`glycin-image-rs`, 88 words; disassembled, every ELF); no codec, browser or library.
  Advertised: faster than the SQRDMULH and SQADD a guest runs without it, on the Mac (`bench/imgdecode/rdmk.c`): a
  Q15 FIR by element 12.6% faster, a Q31 multiply-accumulate 39% (SQADD on words is lane code), a Q15 one 1.7%
  (rounds overlapping). bench/boot/REPORT.md "PERF loop 6: FEAT_RDM and FEAT_LRCPC2".
- **FEAT_LRCPC2** (`LDAPUR`, `LDAPURB`, `LDAPURH`, `LDAPURSB`, `LDAPURSH`, `LDAPURSW`, `STLUR`, `STLURB`, `STLURH`:
  the RCpc loads and stores with an unscaled offset): `VmConfig.features` bit 13 (`FEATURE_RCPC2`, ABI 62), only with
  FEAT_LRCPC (`cpu::has_rcpc2`): `ID_AA64ISAR1_EL1.LRCPC` = 2, Linux's `ilrcpc` hwcap; on and switched as JSCVT is
  (`rcpc2: false`, `?rcpc2=0`), in the shape's hash. LDAR and STLR at base + imm9 (aligned, as theirs: no FEAT_LSE2),
  the loads extended as LDUR's, in both tiers and inline in the JIT. dynarmic's table lacks them: `core/build.rs`
  adds the patterns (`EXTRA`). Who uses it: nothing in the guests' binaries (a couple of words that are data);
  code built for v8.4 and up. Advertised: a chain of acquire loads at an offset is level with the ADD and LDAPR a
  guest runs without it (+0.3%, rounds overlapping; the same report).
- **FEAT_FCMA** (`FCMLA` vector and by element, `FCADD`, on singles and doubles; `interp::simd_fp::fcma`):
  `VmConfig.features` bit 14 (`FEATURE_FCMA`, ABI 63), `ID_AA64ISAR1_EL1.FCMA` = 1, Linux's `fcma` hwcap, switched as
  JSCVT is but **off by default** like I8MM (`bootVm`'s `fcma: true`, the page's `?fcma=1`, in the shape's hash when
  on); inline in the JIT ([jit.md](jit.md)). The half-precision forms (size 01) are FEAT_FP16's and UNDEFINED with it,
  as are size 00, doubles without Q, and by element L = 1, Q = 0 or a size but 10, all ahead of the FPEN trap. Each
  lane is one FPMulAdd (FPAdd for FCADD) of the ARM ARM's elements, the negation before it (a NaN keeps it). Who uses it:
  nothing in the desktop (Arch) or Debian guests' binaries (every ELF's executable segments, then disassembled: three
  FP16 `fcmla` words in libgnutls and libleancrypto that are data); FFmpeg, libopus, FFTW, libjxl, Highway, Mesa and the
  browsers have no FCMA path. Unadvertised (PLAN.md's rule), from kernels written as libraries would pick them from the
  hwcap (`bench/imgdecode/fcmak.c`, three rounds on the Mac): a complex multiply-accumulate by vector level with the
  v8.0 form (singles −1.1%, doubles −0.5%, rounds overlapping), but by a complex constant (FCMLA by element) **10%
  slower** and a radix-4 butterfly with FCADD **3% slower**, rounds apart. Each FCMLA or FCADD here is its shuffles,
  a sign flip and the FMA (or add) with its checks, where the v8.0 code shares one REV64 between two outputs and keeps
  its constants in registers. bench/boot/REPORT.md "PERF loop 7: FEAT_FCMA".
- **FEAT_FP16** (half-precision data processing: scalar and AdvSIMD arithmetic, FMA, compares, conditional compare and
  select, min/max, rounding, estimates and steps, conversions to and from integers and fixed point, pairwise and
  across lanes, by element, the FMOVs, and FCMLA/FCADD's half forms with FEAT_FCMA; FPCR.FZ16): `VmConfig.features`
  bit 15 (`FEATURE_FP16`, ABI 65), `ID_AA64PFR0_EL1` FP = AdvSIMD = 1, Linux's `fphp` and `asimdhp` hwcaps, switched as
  JSCVT is but **off by default** like I8MM (`bootVm`'s `fp16: true`, the page's `?fp16=1`, in the shape's hash when
  on). The interpreter runs the v8.0 handlers on 16-bit lanes (`interp::simd_fp::fp16`, `float`'s ftype 3) over the
  generic FP core ("Floating point" below: FZ16); the half encodings are UNDEFINED without it, the AdvSIMD ones
  ahead of the FPEN trap. FPCR keeps FZ16 only with it (`cpu::fpcr_mask`). Inline in the JIT for the arithmetic, FMA,
  min/max, compares and bit forms ([jit.md](jit.md) "Half precision"). **FEAT_FHM** (`FMLAL`, `FMLSL`, `FMLAL2`,
  `FMLSL2`, vector and by element; `interp::simd_fp::fhm`): bit 16 (`FEATURE_FHM`), only with FP16 (`cpu::has_fhm`):
  `ID_AA64ISAR0_EL1.FHM` = 1, the `asimdfhm` hwcap; off by default too (`fhm: true`, `?fhm=1`), inline. Who uses them:
  of the desktop and Debian guests' binaries only Highway's `vqsort` on `float16_t` (libhwy_contrib's per-target
  code) and VapourSynth's filters (FP16 and FMLAL); no codec, browser (Chromium, Firefox), Mesa or ML runtime in the
  images. Unadvertised (PLAN.md's rule), from kernels written as fp16 libraries pick them from the hwcaps
  (`bench/imgdecode/fp16k.c`, three rounds on the Mac each): an axpy on halves in memory **27% faster** with FP16
  (FMLA .8h against FCVTL, FMLA .4s and FCVTN), but a half GEMM tile by element **2.05× slower**, a dot product 6%
  slower and scalar `_Float16` code (FMADD h) **2.1× slower**; FMLAL by vector **17% faster** than FCVTL and FMLA, by
  element (a GEMM tile) **35% slower**; all rounds apart. A half operation here is its operands widened to singles,
  the single op and the rounding back with its checks (about 50 lane ops an FADD .8h against 5 an FADD .4s): what the
  v8.0 code converts once and reuses, each FP16 or FMLAL instruction converts again. bench/boot/REPORT.md "PERF loop
  10: FEAT_FP16 and FEAT_FHM".
- **FEAT_BF16** (`BFCVT`, `BFCVTN`/`BFCVTN2`, `BFDOT` vector and by element, `BFMLALB`/`BFMLALT` vector and by element,
  `BFMMLA`; `interp::simd_fp::bf16`): `VmConfig.features` bit 17 (`FEATURE_BF16`, ABI 66), `ID_AA64ISAR1_EL1.BF16` = 1
  (no FEAT_EBF16, as on the M4: FPCR.EBF stays RES0), Linux's `bf16` hwcap, switched as JSCVT is but **off by default**
  like I8MM (`bootVm`'s `bf16: true`, the page's `?bf16=1`, in the shape's hash when on); UNDEFINED without it, ahead of
  the FPEN trap. BFCVT and BFCVTN are FPConvert to a format with the single's exponent and 7 fraction bits (`fp::BF`:
  FPCR's mode, FZ, DN, the flags); BFMLALB/T are FPMulAdd on the even or odd bfloat16s widened (exact); BFDOT and
  BFMMLA are BFDotAdd without EBF16 (`fp::bf_dot_add`): FPCR ignored, no flags, denormal operands and results flushed
  to zeros of their sign, NaNs the default NaN, each of the three operations rounded **to odd**, an exact sum from
  2^128 infinite (the M4's result, where FPRound's round to odd would saturate). Inline in the JIT ([jit.md](jit.md)
  "BFloat16"). Who uses it: nothing in the desktop or Debian guests' binaries (the 566 files with BF16-shaped words have
  them in data). Unadvertised (PLAN.md's rule), from kernels written as bf16 libraries pick their paths from
  HWCAP2_BF16 (`bench/imgdecode/bf16k.c`, three rounds on the Mac, all apart): BFDOT's dot product **1.48× slower**
  than XNNPACK's shift-and-mask widening and FMLA, a GEMM tile with BFMMLA **2.61×** and with BFDOT by element
  **2.26× slower**, BFMLALB/T level (0.995), BFCVTN **16%** and scalar BFCVT **21% slower** than integer rounding. On
  the M4 natively BFDOT is 3× faster than that v8.0 code; here each BFDOT is two TwoSums and two steps to odd behind
  its operand tests (about 60 lane ops against the v8.0 code's 20), and the conversions' FPOK and range tests cost
  more than the six integer instructions they replace. bench/boot/REPORT.md "PERF loop 11: FEAT_BF16".
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
  (LSE2, SM3/SM4, LOR, MOPS, HBC) is
  UNDEFINED and unadvertised; I8MM, FCMA, FP16, FHM and BF16 are implemented but off by default (above). Candidates for later are in
  [backlog.md](backlog.md) "Unadvertised extensions".
- **Rule: an optional extension is advertised unless measured slower** (PLAN.md): one that loses stays implemented,
  unadvertised. `ID_AA64DFR0_EL1` advertises
  v8.0 self-hosted debug with the architectural minimum (2 breakpoints, 2 watchpoints, 1 context
  comparator), all implemented: "Self-hosted debug" below.

### ID registers and identification

- `MIDR_EL1`: implementer 0 (software use).
- `MPIDR_EL1`: `Cpu::mpidr`, per vCPU (`gicv3::mpidr`: `1 << 31`, Aff1 = i / 16, Aff0 = i % 16;
  `1 << 31` for one CPU).
- `ID_AA64PFR0_EL1`: FP and AdvSIMD = 0 (present; 1, with FP16, with FEAT_FP16, off by default); **CSV2 and CSV3 set** (nothing
  speculates, which spares the guest Spectre mitigations and KPTI, unless its kernel has KASLR and
  the CPU no E0PD: above); GIC = 1 in a VM (the GICv3's
  system-register interface, `cpu::FEATURE_GICV3`), 0 for user-mode vCPUs; DIT = 1 with FEAT_DIT.
- `ID_AA64ISAR0_EL1` (`interp::sys::isar0`): LSE, CRC32, and with the crypto feature AES = 2,
  SHA1 = 1, SHA2 = 1 (0x211120 with it on; the bare-metal `exceptions` test checks this value),
  with SHA512/SHA3 too SHA2 = 2 and SHA3 = 1 (0x1_0021_2120), RNDR = 1 with FEAT_RNG, TS = 2 with FlagM, DP = 1 with DotProd, RDM = 1 with RDM, FHM = 1 with FHM and FP16 (off by default).
  `ID_AA64ISAR1_EL1` (`interp::sys::isar1`): JSCVT = 1, FCMA = 1 (off by default), LRCPC = 1 (2 with LRCPC2), FRINTTS = 1,
  SB = 1, BF16 = 1 (off by default) and I8MM = 1 (off by default) with their features; no AFP.
- `ID_AA64MMFR0_EL1`: 4K granule, 16-bit ASIDs, 40-bit PA. `ID_AA64MMFR2_EL1` (`interp::sys::mmfr2`):
  E0PD = 1 with FEAT_E0PD, else 0.
- `CTR_EL0`: IDC = 1 (no data cache to clean), **DIC = 0**, so guests issue `IC IVAU` after
  writing code, which is what the JIT's invalidation relies on ([jit.md](jit.md)); IminLine = 9
  (2 KiB lines, the largest: an IC drops its whole page, so guests issue 2 a page, [jit.md](jit.md)
  "Invalidation and the stale-code checker"); DminLine, CWG and ERG 64 bytes.
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
  QEMU TCG doesn't raise these, the M4 (hvf) does, and we follow the architecture. A load/store's
  checks run in the pseudocode's order: its reserved encodings are UNDEFINED first (decoding), then
  the FPEN trap for SIMD&FP, then the SP alignment fault (`ldst::undefined`, `ldst_fp::base`); a prefetch (PRFM,
  PRFUM) has none. A data access to **Device memory** (MAIR attribute 0000xxxx) must be aligned to its size, a
  page-crossing one never is (`Mmu::miss`, after the walk and its permission check; instruction fetches and cache
  maintenance aren't checked, though maintenance that fills a Device page's TLB entry fills it as Device, so the
  accesses after it are). With the MMU off, where everything is Device, it isn't checked: the flat bus
  exists to have no such test, and correct firmware doesn't notice (backlog). Exclusives,
  LDAR/STLR and LSE atomics need natural alignment (v8.0 rules; we don't advertise LSE2, which the
  M4 and QEMU implement: see [testing.md](testing.md) "Known oracle behavior").
- `Cpu::default()` is a Linux user process at EL0; `Cpu::reset()` the EL1 boot state.
- WFI: see the run loop ([platform.md](platform.md)). **WFE completes at once** with one vCPU
  (nothing to wait for); with more, in round-robin it ends the vCPU's quantum unless an event
  (SEV, SEVL) is pending, and SEV/SEVL set events; in parallel SMP it's a yield (it ends the
  chunk) and SEV does nothing ([platform.md](platform.md) "The run loop").

## Self-hosted debug (`core/src/interp/debug.rs`)

v8.0's breakpoints, watchpoints and software step, taken to EL1 (EL_D) with their syndromes:
what in-guest `gdb` (`stepi`, `hbreak`, `watch`), `ptrace` single step and perf's `mem:` events
use, and kvm-unit-tests' `debug-*`.

- **Registers:** `DBGBVR/BCR0-1`, `DBGWVR/WCR0-1` (`Cpu::dbgbvr` …, the control registers'
  v8.0 fields kept), `MDSCR_EL1` (SS, TDCC, KDE, MDE), the OS lock (`OSLAR`/`OSLSR`); the OS double
  lock, DCC and save/restore registers stay RAZ/WI, but with `MDSCR_EL1.TDCC` set EL0's accesses to
  the DCC (`MDCCSR_EL0`, `DBGDTR_EL0`, `DBGDTRRX/TX_EL0`) trap to EL1 (EC 0x18; Linux sets it at boot
  and sends SIGILL); an MSR of read-only `MDCCSR_EL0` is UNDEFINED first. Breakpoint 1 is the context-aware one. They're
  in snapshots (`snapshot::VERSION` 2, with the step's syndrome and `PSTATE.SS`).
- **What raises what:** debug exceptions need the OS lock clear, and from EL1 `MDSCR_EL1.KDE` and
  `PSTATE.D` clear (`AArch64.GenerateDebugExceptionsFrom`). Breakpoints (MDE): unlinked and linked
  address match on the instruction about to run (BAS non-zero), unlinked context ID match, PMC and
  SSC (no Secure state), EC 0x30/0x31 with ELR on the instruction. Watchpoints (MDE): BAS byte
  selection (on a doubleword, or a word with `WVR[2]`), MASK ranges, LSC, PAC (LDTR/STTR as EL0),
  linked context; plain and exclusive accesses, atomics, `DC ZVA`, device registers; EC 0x34/0x35, WnR, FAR the
  first watched byte the access touches (QEMU's too), taken after the access translates (its alignment, translation,
  access flag and permission faults first, `AArch64.TranslateAddress`) and before it reads or writes. An atomic
  read-modify-write (LD<op>, SWP, CAS, CASP; a failing CAS too) is a load and a store: a watchpoint for either
  matches, WnR 0 if one for loads does; a store-exclusive is a store (`Bus::store_exclusive`). Software step (`MDSCR_EL1.SS`):
  `PSTATE.SS` is bit 21 of `pstate`; an instruction that completes clears it, and the step
  exception (EC 0x32/0x33) is taken before the next one, with ISV and EX (a Load-Exclusive was
  stepped: LDXR, LDAXR, LDXP, LDAXP of any size, not CASP or LDAR from the same encoding group); an exception the instruction raises leaves it set (SPSR.SS = 1, the instruction runs
  again; a real external abort too, set by `take_exception`: the run loop's MMIO shares
  `FaultKind::Bus` and completes the instruction), SVC and HVC complete it; ERET restores `SPSR.SS` only while step is on at its target, and
  the step that leaves pending reports no ISV. An IRQ is taken before a pending step exception.
- **Order:** a pending step, then the PC alignment fault and the instruction abort, then a
  breakpoint, as the architecture prioritizes them.
- **Device accesses:** an instruction that reaches a device register runs again on the run loop's
  `Io` bus; `Watch` checked its accesses up to that one, and `Io` checks the device accesses after
  it (a pair's second register) with `debug::hit`, behind one `MDSCR_EL1.MDE` test on the MMIO path.
- **Left as is:** a `DC ZVA` or pair store hit part-way leaves the bytes before it written (the
  architecture allows that for multi-access instructions); a watched `DC ZVA` on a device's
  registers takes the watchpoint, where the alignment fault comes first.

**At no measured cost when nobody debugs** (bench/interp/REPORT.md "Self-hosted debug": Alpine's
boot and userspace and the JIT's small guests unchanged; the block interpreter's flat small guest
−0.6%, with its hot code the same: layout). The fast tiers never look at debug state; only the
dispatcher does, and what it tests costs what `SCTLR_EL1.A`'s test cost before:
- `debug::arm` recomputes, per EL, whether an exception could be raised there (`Cpu::interp_only`:
  step on, or MDE and an enabled comparator for that EL; EL1 also needs KDE; coarse on purpose,
  `PSTATE.D` is left to the exact checks), on the writes that can change it (`MDSCR_EL1`, a
  comparator's control, `OSLAR_EL1`, `SCTLR_EL1`) and a restore. `Cpu::dispatch` is the current
  EL's: one byte with "interpreter only" (that, or `SCTLR_EL1.A`) and a copy of `SCTLR_EL1.M`,
  which `Cpu::set_pstate` keeps as the EL changes. `jit::key()` loads it and tests two bits where
  it loaded SCTLR_EL1 and tested A and M: the same three instructions in V8's code for the
  dispatcher (`ldrb; tbnz; …; tbnz` for `ldr; tbnz; …; tbnz`).
- Arming changes only through an MSR none of `msr_continues` names, so it ends its JIT block and
  the block interpreter's run, and when it changes an EL's arming it returns `Exit::Resync`, which
  ends an interpreter chunk too. The EL changes only in the run loop (exceptions, IRQs) or by
  ERET, which ends its block. A new path that changes the EL or enters compiled code must go
  through `set_pstate` and the dispatcher; a debug register's MSR must never join `msr_continues`
  or `plain_write`.
- An armed EL runs in the **debug interpreter**: `step_bus`'s loop with the checks, over a `Watch`
  bus (an `Mmu` that checks each data access against the watchpoints, translating it first when one
  matches, and has no `fast` path): its own monomorphized copy of the interpreter (~110 KB of wasm), cold and never inlined,
  so `interp::steps` and the block interpreter are as they were. Without a JIT, the run loops
  (`Vm`'s chunk, `interp::run`, `run_system`) pick it for the whole chunk while any EL is armed.
  The user-mode exports, whose host writes `Cpu` fields directly, derive the dispatch bytes before
  each run ([abi.md](abi.md) "User-mode exports").
- What it costs while debugging: a stepped task runs a few hundred kernel instructions per step in
  the JIT and one instruction interpreted; a task with a hardware breakpoint or watchpoint runs at
  the step interpreter's speed while it's on the CPU, the kernel and other tasks in the JIT. Linux
  arms only then (MDSCR's SS on the return to a stepped task, MDE and a comparator's E while a task
  that has one runs; a boot writes zeros and `TDCC`). Breakpoints and watchpoints at JIT speed are
  in [backlog.md](backlog.md) "CPU".

Checked by kvm-unit-tests' `debug-bp`, `debug-wp`, `debug-sstep` and their migration variants
(through snapshots), the bare-metal `debug` test (the step machine's edges, breakpoint and
watchpoint matching, against QEMU's TCG; QEMU 11.1 steps and breaks with the OS lock set and has
no unlinked context breakpoints, so the oracle build leaves those out), and the LTP guest's
`breakpoint_test_arm64` and `webpc-debug` (ptrace single step through an SVC, perf breakpoint and
watchpoint counts; its expectations checked on the M4: two stops after a stepped SVC, Linux's
syscall-exit report and then the pending step).

## System registers

The table is `core/src/interp/sys.rs`.
- EL0-accessible: `TPIDR_EL0`, `TPIDRRO_EL0`, `CTR_EL0`, `DCZID_EL0`, `CNTVCT_EL0`,
  `CNTFRQ_EL0`; Linux emulates EL0 reads of ID registers.
- The v8.0 registers that exist at EL1 when it's the highest EL: `ACTLR_EL1`, `OSECCR_EL1`,
  `OSDTRRX/TX_EL1`, `DBGDTR_EL0`, `DBGDTRRX/TX_EL0` are RAZ/WI; `MDRAR_EL1`,
  `DBGAUTHSTATUS_EL1`, `MDCCSR_EL0`, `RVBAR_EL1` read as zero (the DCC ones from EL0 trap while
  `MDSCR_EL1.TDCC` is set: "Self-hosted debug" above); `RMR_EL1` reads 1 (AA64) and
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
  faults like a read (`DC IVAC` like a write); what's at the address doesn't matter, so a device or nothing is no
  fault. `DC ZVA` on what isn't RAM is an alignment fault, as on the M4 (never a store to a device).
- **The TLB** is the M0 spike's shape: direct-mapped, 16,384 entries × {tag, addend} (16 bytes) per
  (EL, read/write/execute). The tag is the page VA with bits 11:0 all ones (**bits 11:3 are
  reserved for an inverted memory index**, layout A's escape hatch, [architecture.md](architecture.md));
  a lookup compares with `(va + size − 1) | 0xfff`, so page-crossing accesses miss and are
  split. The host address is `va + addend` (QEMU-style). MMIO and unmapped pages always miss. 16,384 entries,
  2.4 MiB a vCPU, since 2026-11-03: at 4,096 most misses were conflicts among the kernel's linear-map pages, and the
  larger table cut misses 14-30% and the process-heavy phases 1-3% (`bench/boot/REPORT.md` "The TLB at 16,384
  entries"); per-ASID stashes of nG entries and victim buffers measured out there.
- **ASIDs:** entries hold no ASID. An ASID change or `TLBI ASIDE1` drops only the non-global
  (nG) entries, tracked in `Tlb::ng` (up to 1024 slots); past that the slots' nG marks in `Tlb::blk` are scanned
  (128 KiB read, eight slots a word), so the global entries survive a busy process too (a full flush there was ~7 a
  second in Firefox on 4 vCPUs, 2026-11-04); a change of
  `SCTLR_EL1.M` flushes everything. (Keeping global entries cut Alpine's boot misses 3.61M →
  1.07M.) Per-ASID stashes of nG entries would serve under a sixth of the nG refills (measured out: "The TLB" above).
- **Blocks:** a 2 MiB or 1 GiB leaf is cached as entries for the pages it was used through, and
  a TLBI by VA drops every one of them, not only its own page's: Linux unmaps a transparent huge
  page with one TLBI for the 2 MiB. `Tlb::blk` marks the slots filled from blocks by class (VA
  half, level) and `Tlb::rblk` counts the live ones in 1,024 buckets hashed by class and block; a flush by VA scans
  the block's indices (512 for 2 MiB, all 16,384 for 1 GiB) only when its block's bucket counts some (a collision
  costs a scan, nothing else). Counting by class alone sent every flush in the kernel's half through 512 indices,
  since its 2 MiB entries are always live: in Alpine's boot ~6K of ~34K flushes by VA, 25M slots read; in the
  userspace benchmark (THP in the low half too) 16K, 65M slots; with the buckets Alpine's boot scans under 400 times
  (counted natively; neither run filled an entry from a 1 GiB block). A flush by VA also drops an EL's transfer cache
  if its instruction TLB filled from a block in that half. Without this, stale pages of a freed THP
  stayed mapped until the next ASID switch: hidden while KPTI switched ASIDs at every kernel entry,
  it corrupted glibc's heap in dEQP once FEAT_E0PD let a KASLR kernel run without KPTI
  (`c3ae697`; bisected and narrowed with `kpti=1`, `nokaslr` and `transparent_hugepage=never`
  guests).
- **Watched write entries** (VK1): a write fill of a page of the host-visible window is recorded, and dropping the
  record marks the page for the host's upload ([devices.md](devices.md) "The host-visible window").
- The TLB also holds the JIT's **transfer cache** (`Tlb::xc`, VA to compiled block), which every
  flush above drops its share of ([jit.md](jit.md) "Linking").
- The interpreter has three copies of `exec` over a `Bus`: flat (MMU off), MMU, and `vm::Io`
  for device MMIO, LDAR and STLR included ([platform.md](platform.md)); the choice is made outside the instruction
  loop.
- **Device pages in the TLB:** their entries have tag bit 11 (`DEVICE`, above the inverted memory index) cleared,
  so the exact compares of every fast path (the interpreters', the JIT's inline arms, spill memories' included)
  miss them and `Mmu::miss` finds the entry and checks the alignment. MMIO already went that way; RAM mapped as
  Device (no guest of ours does: virtio-gpu's window is mapped cached) pays a call per access.
- **With the MMU off**, a VA past the 40-bit PA size is an address size fault at level 0, not an external abort
  (`mmu::flat_fault`, on a failed access's way out; `AT` reports it too). TBI isn't applied there.

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
  (`bench/interp/REPORT.md` "M7 loop 6"). On x86_64 an atomic store is an `xchg`: plain
  accesses would make the block interpreter ~3-4% faster in Chromium, nearly all of it the stores
  (`bench/interp/REPORT.md` "What the guest accesses' atomics cost on x86_64"). Not taken: plain
  accesses could only be used with one vCPU, and the page's machines run parallel (that section's end).
  JIT code uses plain wasm loads and stores, which wasm
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
- **LSE's LD<op> and SWP** (`Mem::rmw`, `mem::lse`) are one atomic op each where wasm has one
  (`atomic.rmw` add, and with the operand inverted for LDCLR, xor, or, xchg), as in the JIT; the min
  and max ops, and a spill memory's (reached through its imports), are a CAS loop. Measured neutral (the
  4-vCPU userspace benchmark and the yardstick, `bench/interp/REPORT.md` "M8-INTERP loop 8"): hot
  atomics are compiled.

## Floating point (`core/src/fp.rs`)

Wasm arithmetic is round-to-nearest-even only, has nondeterministic NaN payloads and no scalar
FMA, so:
- **Software FP**, our own implementation written from the ARM pseudocode (FPRound with tininess
  before rounding, FZ, DN, the ARM NaN order) over one generic u128 unpack/round/pack for half,
  single and double. Chosen over porting SoftFloat: smaller and ARM-specific.
- **Fast paths:** single and double add/sub/mul/div/sqrt use host arithmetic in RNE when inputs
  are normal and the result is normal above the smallest binade, with Inexact computed exactly, unless
  FPSR.IXC is already set (`Fpu::with_fpsr`): IXC is cumulative, so then the exactness test (for double MUL, DIV
  and SQRT a u128 product, compiler-rt calls in wasm) is skipped.
- NaNs are fixed up to ARM propagation rules (or the default NaN with `FPCR.DN`) after each op.
- `FMADD` and friends use the exact software FMA, except where the JIT's inline FMA applies (round to
  nearest even, FPSR.IXC already set, normal or zero operands and a normal result): then `Fpu::muladd` runs
  the same algorithm (`fp::fma64_fast`, `fp::fma32_fast`; [jit.md](jit.md) "Floating point", FMA), which
  raises no flag there. The interpreter's `Fpu` starts with FPSR's IXC for it (`Fpu::with_fpsr`).
- **No `u128` shift by a variable amount on the vector paths:** in wasm it's a call to compiler-rt
  (`__lshrti3`, `__ashlti3`). A vector element is at most 64 bits and within one half of the register,
  so `simd::elem` and `set_elem` pick the half and shift a `u64` (the FP guest +25% through the block
  interpreter; `bench/interp/REPORT.md` "M8-INTERP loop 13").
- FPCR RMode/FZ/DN/AHP/FZ16 and the FPSR cumulative flags and QC are implemented. **FZ16** (FEAT_FP16) flushes half
  inputs (FPUnpack, raising no Input Denormal, unlike FZ) and tiny half results (Underflow, no Inexact); FZ doesn't
  touch halves; conversions (FCVT, FPUnpackCV/FPRoundCV) ignore FZ16 and honor AHP, arithmetic ignores AHP. The
  half estimates use the ARM ARM's half constants (FRECPE: overflow below 2^-16, flush from 2^14, exponent 29 - e;
  FRSQRTE: (44 - e) / 2). FMLAL's FPMulAddH (`Fpu::muladd_h`): the addend single (FZ), the factors halves (FZ16), a
  half NaN quieted and converted to single (the addend's first), one rounding to single.
- **Validation:** TestFloat 3e (`scripts/testfloat.sh`, 51.2M cases under every FZ/DN
  combination) and the golden corpus natively and on wasm (host float behavior is where native
  and wasm builds can diverge).
- The JIT's exact FP fast paths are in [jit.md](jit.md) "Floating point".

## Crypto extensions (`core/src/crypto.rs`)

AESE/AESD/AESMC/AESIMC, PMULL/PMULL2 (8- and 64-bit), SHA1C/P/M/H/SU0/SU1, SHA256H/H2/SU0/SU1;
SHA512H/H2/SU0/SU1, EOR3, RAX1, XAR, BCAX (FEAT_SHA512, FEAT_SHA3).
- **Our own Rust** from FIPS 197, FIPS 180-4 and the Arm pseudocode (nothing ported; papers
  credited in `THIRD_PARTY.json`). Speed first: the interpreter's SubBytes is a 256-byte S-box
  (and its inverse) computed at compile time (x²⁵⁴ by square and multiply plus the affine map); the
  arithmetic form, the GF(2⁸) inverse by an addition chain of bytewise SWAR multiplies, is the tests'
  second reference only; the JIT inlines SubBytes as nested inversion over GF(2⁴) in `i8x16.swizzle`s
  of constant vectors ([jit.md](jit.md) "Crypto"); (Inv)MixColumns by `xtime` and rotations; `PMULL.1Q` as Karatsuba over 32×32 multiplies with
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
  5.1% fewer steps (`bench/interp/REPORT.md` "M6.5 loop 7"). SHA512 and SHA3 likewise: OpenSSL's
  SHA-512 +11-13%, its SHA-3 Keccak on them +83% at 16 KiB against its scalar code (which it runs
  on our MIDR all the same), no other workload slower (`bench/boot/REPORT.md` "M9: FEAT_SHA512 and
  FEAT_SHA3"). The rule for later extensions: **advertised unless measured slower than the paths
  guests use without them** (a tie is advertised; PLAN.md).

## Decoder (`core/build.rs` ← `core/src/a64/a64.inc`)

- Generated from dynarmic's pattern table (0BSD, attributed in `THIRD_PARTY.json`).
- Should-be-one fields are relaxed to match the M4, except in CAS/CASP, where the M4 raises
  UNDEFINED.
- Checked exhaustively against Capstone 5.0 ([testing.md](testing.md) "Decoder sweep").

## The block interpreter (`core/src/interp/block.rs`)

The interpreter has two forms. `interp::steps` fetches, decodes and runs one instruction at a time:
the reference, and what `VmConfig.jit` 0 runs. **The block interpreter** runs what the JIT's
dispatcher hasn't compiled (`jit::steps`; [jit.md](jit.md) "Dispatch"): every block the first
`threshold` times, and natively everything (no wasm engine), so the native boots with `jit` ≠ 0
test it against `tests/steps.txt`.

**The reference interpreter's speed rests on LLVM's inlining**: `exec` (the decode and the big match) must be
inlined into `steps`' loop and the JIT's per-instruction helpers (`jit_exec_flat`, `_mmu`), or each instruction
pays a call. A closure, a small `or_else` or a helper like `extend` left to LLVM's size heuristic can go out of
line when unrelated code grows: the structure loads' fast path (2026-11-04) did that to `exec_at`'s
closure (the FP guest −28%), then to `simd_int::handler`'s and `simd_fp::handler`'s lookup and `extend` (−4% more).
Those are now direct calls and `#[inline(always)]`. To check a change: strip the wasm's debug sections
(`wasm-tools strip -d '.debug.*'`), `wasm-tools print` it and compare the functions the step loop
(`interp::steps::go::<Flat>`) calls, and its size, with the base's. LLVM's attribute inference can also reshape
the loop with no inlining change: P3's `multiple` (its slow path's shape, even with the fast path dead or out of
line) made `ldst_fp::exec`'s result `initializes((0, 1))`, and the loop reads the `Exit` in bytes: `interp_mips`
−0.6 to −1.1% in three sessions, the other benchmarks flat, kept (`bench/interp/REPORT.md` "REVIEW P3 and P4").

- **A block is the JIT's** (`jit::block::form`, the same key: PA and regime bits), decoded once into
  8-byte micro-ops with their operand fields pulled out and kept in the vCPU table's cache: a kind, three
  register bytes and a `u32` that holds the kind's flags and immediate (`interp::block::pack` says what goes where
  per kind). A 64-bit immediate that doesn't fit (a logical immediate's mask, an MRS constant, a SIMD&FP access's
  word and offset, a MOV immediate that isn't a rotated 32-bit value) is an 8-byte slot after its block's
  micro-ops, the `u32` its distance from the micro-op, so `hot` reaches it from the micro-op's pointer it holds.
  Decoding makes the wide form (`Wide`: flags and a 64-bit immediate apart), which the slow path (`run`)
  unpacks a micro-op back into. The
  common integer forms (ADD/SUB in all three operand forms, the logical ones, MOV, MOVZ/N/K,
  UBFM/SBFM/BFM, the variable shifts, CSEL & co, CCMP/CCMN, MADD/MSUB, UMADDL & co, UMULH/SMULH,
  UDIV/SDIV, ADC/SBC(S), EXTR, RBIT/REV/CLZ, ADR/ADRP), every branch, MRS of what `sys::plain` reads at
  the block's EL (`uop_el`; SP_EL0 while SPSel is 1), MSR of what `sys::plain_write` writes there (a
  `Cpu` field, SP_EL0, DAIF unless it unmasks IRQs) and DAIFSet, CAS of any size, the LSE
  LD<op>/SWP of W and X registers (one atomic op, min and max a CAS loop), the exclusives and acquire/release
  (LDXR/LDAXR/LDAR, STXR/STLXR/STLR: the monitor in the `Cpu`, a store-exclusive a CAS when it's armed for its
  address), DMB and DC ZVA, the SIMD&FP single and pair loads and stores, and
  the integer loads and stores (single register in every addressing form but the unprivileged
  one, pairs, literal) have handlers; the rest is a generic micro-op that runs the interpreter's
  own code with the decoded `Op` (`interp::exec_at_op`). One micro-op is one instruction, so the
  steps and the exits are `interp::steps`'s for the same instructions.
- **Loads and stores** try the TLB entry inline (`Bus::fast`) and take the interpreter's path on a
  miss, so faults are the interpreter's. What the lookup needs that can't change while `hot` runs (the MMU
  and alignment check off SCTLR_EL1, the EL's TLB arrays: anything that changes them runs generically,
  outside the loop) is computed once a call (`Fast::ctx`), not once an access: +2.5% on Alpine's boot, +3.9%
  with the MMU on. The commonest form, an offset load or store of 4 or 8 bytes with no writeback or
  extension (`LdO`, `StO`, made at decode), has its own handler without `Ld`'s choices: +4% on the small
  guests, +1.4% on Alpine's boot (`bench/interp/REPORT.md` "M8-INTERP loop 8"). A pair (LDP, STP, their SIMD&FP forms)
  takes one TLB probe of both registers' bytes; one across pages takes the slow path. With the register indexes'
  masks gone, +1.6% on Alpine's boot, +2.5-3.0% on the small guests (`bench/interp/REPORT.md` "No index masks, one
  probe for a pair"). A register only read needs no compare for XZR: `pack` stores `Cpu::zero`'s slot for it (`reads`),
  `hot` reads it with a plain load and `Uop::wide` maps it back: +3.1% on Alpine's boot and the user-mode guest
  (`bench/interp/REPORT.md` "XZR's reads without a compare").
- **The structure loads and stores** (LD1–LD4, ST1–ST4, LD1R–LD4R: generic micro-ops, so the interpreter's own
  code, `interp::ldst_fp`) take `Bus::fast` for the whole transfer: when it's RAM in one page, the multiple forms move
  8 bytes an access and (de-)interleave the elements in a buffer, and the single forms' elements go through the one
  pointer. Otherwise (a page crossing, a TLB miss, SCTLR_EL1.A, a watchpoint's bus, a device) each element is its own
  access, which is where faults come from. Natively, `ld1 {v0.16b-v3.16b}` 207 → 15 ns, `ld4` 183 → 22 ns, `st4` 271 →
  20 ns (`ldp q0, q1` 11 ns); the JIT compiles these inline, so only cold code and the JIT's helper calls (a page
  crossing, a miss) run them. `interp::tests::structure_fast_path_matches_per_element` holds both paths to the same
  registers and memory for every form.
- **One call-free loop** (`interp::block::hot`): the blocks run, and chain from one to the next, in a
  loop with no call on any path (no generic micro-op, no slow load or store, no TLB walk, no panic:
  a micro-op's register bytes trusted, as `pack` makes them, the slots a fixed-size array), so V8 keeps its state in
  registers. What
  needs a call returns a status to `jit::interpret`, which runs that one micro-op through `run` (the
  slow path) or finds the next block, and calls `hot` again. +26% on the user-mode guest, +56-68% at
  EL1, +13% and +18% on the Buildroot and Alpine boots (`bench/interp/REPORT.md` "M8-INTERP loop 1").
- **A guest branch stays a host branch.** B.cond, CBZ and TBZ read their offset where the branch is taken, through
  a load LLVM can't hoist (`taken_imm`); with the offset already in a register LLVM made the choice a `select`
  (a `csel` in V8's code), and the next block's lookup waited for the condition instead of going on down the path
  the host predicted: the small guests 30% slower. A condition is a 16-bit mask of the NZCV values it holds for,
  made at decode (`cond_mask`; B.cond's in its spare register bytes, CSEL's and CCMP's in the `u32`'s top half), so
  testing it is a shift, not `cond_holds`' jump table: the small guests +6%, the boots +1.3%
  (`bench/interp/REPORT.md` "M8-INTERP loop 12").
- **A compare and its B.cond** (CMP/CMN/SUBS/ADDS immediate or shifted register, TST/ANDS immediate or
  register, then a B.cond: marked at decode, `mov_runs`) go in one dispatch: the compare's handler tests the
  B.cond's mask and branches (+0.9-1.0% on the boots and the user-mode guest, loop 13).
- **SUBS is its own kind** (`SubsI` immediate, `SubsR` shifted register, CMP among them; `AddsI` is then ADDS and CMN
  only), so `hot` computes C with the one compare the kind implies, as the JIT does: `x >= y` for a subtraction,
  `r < x` for an addition, where `add_with_carry` took two adds, two compares and an OR. +2.2-3.4% on the small guests,
  +0.6-0.7% on Alpine's boot, in two sessions on the Mac (`bench/interp/REPORT.md` "PERF loop 4"); the same compares
  chosen by the micro-op's subtraction bit lost 1-3% ("PERF loop 3"). The extended-register forms, ADDS by
  shifted register (through `AddR`) and CCMP/CCMN keep `add_with_carry`.
- **What `hot` can't run goes to the slow path a stretch at a time:** the micro-op it stopped at and the
  generic ones (and literal loads) right after it in the prefix, in one `run` (`Run::stretch`), so a run of
  SIMD or FP instructions costs one exit from `hot`, not one each; a generic micro-op runs without being
  unpacked. The FP guest +22-29% through the block interpreter, Alpine's boot +1.2% (loop 13).
- **Runs of MOVs** (MOVZ, MOVN, MOV of a bitmask immediate: `MovI`) go in one dispatch: each carries
  the number of MovIs right after it (`mov_runs`, at decode), and `hot` writes them all, never past
  the prefix (`run` ignores the count). +2-5% (`bench/interp/REPORT.md` "M8-INTERP loop 4").
  **Pairs of LdOs and StOs** go in one dispatch too (bit 16 of the first's `x`, pairs from the block's
  start), straight-line: ~+0.7% on Alpine's boot, in two sessions (loop 8).
- **Chaining:** after a block that ends on a branch or runs out, the next block is found without
  going back to the dispatcher (`jit::interpret`): in the same page from the block's own key (a
  block ends after anything that could change the translation), in another through the
  instruction TLB. The chain stops at a compiled block, at a block not decoded yet or due to report
  its dispatches, after a block that ends on an instruction run generically (an MSR, ERET: the
  regime may have changed), at an exit, or when the chunk's steps run out.
- **Counting:** a decoded block counts its dispatches in its slot and reports them to the shared
  cache every 16 (`REPORT`; past the JIT's `warm`, once at the threshold: [jit.md](jit.md) "Compile policy"; the cache's lock and map lookup were a third of the time), and the
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
- **The cache** (per JIT table, so per vCPU in parallel SMP): 262,144 direct-mapped slots (4 MiB; a browser's
  interpreted code is a large working set: 16,384 missed 3.5 times as many next blocks), a map,
  and the micro-ops in one arena, which starts over when full. **The arenas share 16M micro-ops
  (128 MiB, with the blocks' constants among them) among a VM's tables, at most 8M a table** (`interp::block::budget`, through
  `jit::Config::decoded`): 8M on one or two vCPUs, 4M on four, 2M on eight; they grow as they
  fill (Alpine decodes ~1M). At 2M a table, Chromium in Debian on 4 vCPUs re-decoded ~3.5M blocks
  a render; 4M halved that and made the warm renders ~3.5% faster; 8M ran the core's 1 GiB heap
  out (micro-ops were 16 bytes then). Evicting instead of starting over (keeping the newer half, or the blocks that ran in the
  last half of the arena's fill, compacted) won half of that at 2M and nothing at 4M: what fills
  the arena is code that runs again, not dead blocks (`bench/apps/REPORT.md` "M8: the decoded
  blocks' arenas"). **Invalidation is by
  page:** every `IC IVAU` (and `IC IALLU`) is logged in the shared cache (`Cache::ival_log`, with
  its own counter, so the transfer caches aren't touched), and a table drops that page's decoded
  blocks when it catches up, before its vCPU runs another block. Flushes of the code cache and the
  links between compiled blocks don't touch decoded ones: tying them to the JIT's dropped keys
  (which follow links transitively) emptied the caches a few dozen times per Chromium render.
  The map holds 8 bytes a block (where its micro-ops are, the dispatches it counted out of its slot, and the next
  key of its page by the key's low 12 bits), and the page index a page's last key: an IC's page walks that list.
  (It was 12 bytes a block and a `Vec<u64>` of keys a page.)
- **Tests:** a native differential test of random blocks against `interp::steps`
  (`interp::block::tests`), the golden corpus in it on wasm (`tests/corpus-wasm.test.ts`), the
  native boots through it (`linux_boots_through_the_block_interpreter`,
  `alpine_boots_through_the_block_interpreter`; `WEBPC_NATIVE_JIT=1` for every native guest test),
  and every JIT run's cold code with exact steps. The differential test drives each block through
  `hot` too (`run_hot`).
- **Its speed** (`bench/interp/REPORT.md` from "M8-INTERP loop 0"; the yardstick is
  `bench/interp/yardstick.sh`: the small guests and the boots under `VmConfig.jit` 4, with
  `--config liftoff-only` the JIT's reference): on the dev VM 467 MIPS on the user-mode guest,
  466-469 at EL1, 136 on Buildroot's boot and 210 on Alpine's (from 249, 176-198, 89 and 122; loop 8 +4-8%, loop
  9's exclusives and barriers +9% and +6% on the boots: a generic micro-op costs `hot`'s exit and re-entry, ~14×
  a handled one; loops 12-13 +6-7% on the boots, `bench/interp/REPORT.md`);
  on the Mac host (before the MOV runs) 427, 404, 144 and 182. Liftoff, compile included, boots Alpine at 244 MIPS and
  Buildroot at 60, and runs the hot guests at ~1,700-2,600. On the M4 the guest accesses' `ldar`/`stlr` in
  `run` took 0.24% of its cycle samples (with the instruction after); x86_64, where a sequentially consistent store
  is an `xchg`, costs the block interpreter ~3-4% (see "Memory model").

### Tried and not kept

In `bench/interp/REPORT.md` "M8-INTERP loop 2" unless said, the variants' diffs in `results/m8-interp-l2/` (and
`l8/`):
- **Lazy NZCV in `hot`'s locals** (the JIT's rules: SUBS/ADDS/ANDS keep kind and operands, B.cond,
  CSEL and CCMP read conditions from them): −2% on the user-mode guest, −4% on Alpine's boot. Three
  more loop-carried values, and the conditions' selects cost more than a stored NZCV's bits.
- **A flag setter fused with its B.cond** (one dispatch for the pair, ~6% of the instructions):
  +1%, twice; with lazy NZCV −4 to −8%; with the MOV runs −2 to +1% (loop 4).
- **More slots, or smaller ones** (`bench/interp/REPORT.md` "PERF loop 1"): 1,048,576 slots made Firefox's pages
  session −0.8%, under the bar (loop 2's 4× was −4.4%); 8-byte slots (only the key bits the index doesn't imply, the
  counts as dispatches left) cost `hot` 2.6-5% on the block-interpreter guests for 2 MiB a table.
- **The dispatcher's loop inside `jit::interpret`** (`bench/interp/REPORT.md` "PERF loop 2"): the interpreter running
  the compiled blocks it stops before itself, and the decoded blocks after them, through the vCPU's raw pointer.
  Firefox's pages session −0.1% (overlapping), the JIT gates even, the block interpreter's boot −0.5%: what a trip
  around the dispatcher's loop adds to compiled code's exit and `hot`'s entry is a few ns.
- **Pre-linked successors** (the arena index of each successor and a compiled bit in the slot):
  dropping the jump-cache check altogether, the most they could save, gave 1-1.5%. A block's cost
  is its micro-ops and the reports, not the slot and jump-cache lookups.
- **The micro-op copied whole** (`repr(C)`, two loads and the fields extracted, instead of a load a
  field): −25% / −7%.
- **The literal load inline in `hot`**: −4-5% on the user-mode guest.
- **An `End` micro-op after each block in the arena** instead of `hot`'s per-micro-op `u == end`
  test (whose `end` V8 reloads from the stack each time): −2.7% on Alpine's boot, −13% on the MMU
  guest. The compare was cheap and predicted; the sentinel is one more indirect dispatch a block,
  and blocks are a few instructions long (loop 8).
- **Runs of LdOs and StOs in a loop** (as the MOV runs): −8% on the small guests, −0.6% on Alpine's
  boot; the loop's code slowed `hot` for everything. Straight-line pairs (above) are what's kept;
  **STP+STP pairs** the same way added nothing (−0.5% on the small guests, +0.2% on Alpine's boot).
- **`hot`'s per-micro-op cost, three more ways** (`bench/interp/REPORT.md` "PERF loop 3", on the Mac): ADRP+ADD to
  the same register as one dispatch (0.5% of Alpine's pairs) +0.1% on Alpine's boot, under the bar; SUBS's carry
  from its operands as the JIT's (`x >= !y`) −0.8 to −2.9%, though `hot` got smaller: the subtraction bit is a
  micro-op's field there, so the JIT's one compare becomes a select of two, and V8's allocation moved; NZCV held in a
  local across `hot` (the one register cacheable without a compare an access) −1.9 to −3.5%, one more loop-carried
  value, as the lazy NZCV above. What a micro-op's dispatch costs is V8's interrupt check at the loop head, the field
  loads, the jump table's bounds check and the handler's landing (loop 8; the Mac's `--prof`, "The block interpreter
  on the Mac, loop 3"); threaded dispatch isn't expressible in wasm, and tail-call dispatch (`become`) wasn't built:
  V8's `return_call_indirect` costs ~15 ns an entry (`bench/boot/REPORT.md` "M8: where a busy vCPU's time goes in
  Firefox"), several micro-ops' worth.
- **Misaligned stores inline** (`bench/interp/REPORT.md` "PERF loop 4", on the Mac): as the misaligned loads, where
  `fast_in` found the bytes in RAM, but in naturally aligned pieces (a store may write only its own bytes). As a loop
  over the pieces (`mem::store_split`'s, inline) −3.2 to −4.3% on the block-interpreter guests: three more wasm loops
  in `hot` (the StO pair inlines `single_h` twice); as up to eight byte stores, unrolled, −0.7% on Alpine's boot
  (rounds overlapping), for ~4.1 M exits a pages session, ~0.15% of a browser's busy time. **CCMP as its own kind**
  (beside SUBS's, CCMN the other): even with SUBS's alone.
- **A browser's FP and NEON classes as handlers** (FMOV, MOVI, FCSEL, vector logic and ADD, DUP, BFM, FCMP,
  FADD/FSUB/FMUL/FDIV on the JIT's fast-path rules; loop 10): the small guests −1-2%, Firefox's pages session no
  faster. Its generic path is 1.9% of what it interprets, spread over dozens of classes; the code costs `hot` more
  than it wins there.
- **XZR's writes through a sink slot,** as its reads go through `Cpu::zero` (`bench/interp/REPORT.md` "XZR's writes without
  a compare"): nothing past noise on the boots, the flat guest −23%. A shared TLB probe for pairs of LdOs and StOs
  lost it −19.5% the same way: a change to `hot` that reads as smaller can still cross what V8's register allocation holds.
- **LDTR and STTR as handlers** (EL0's TLB array taken in the single-register handler; loop 13): Alpine's boot
  1-4% slower in Node, the branch costing more than the uaccess loads it took off the slow path.
- **One decoded-block store for every table** (loop 7's design, not built): decoding is ~0.6% of a vCPU in Firefox's
  pages session and ~1.1% in Chromium's renders on 4 vCPUs (~0.55 µs a block), so sharing could win under 1%
  (loop 10).
- **Reports every 255 dispatches in the JIT** (not only where nothing compiles): Buildroot's boot
  +23% (the interpreter beats Liftoff there), but the counts the cache doesn't see delay the
  batches and shrink the forward regions: Alpine's boot interpreted 2.5× the steps and made 19%
  more regions.
