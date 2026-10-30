# Review of the core's interpreter (2026-10-30)

A static review of `core/src/interp*` and what it stands on (`mmu.rs`, `mem.rs`, `jit::interpret`, `jit::block::form`,
the run loop's `io`), then every finding that could be tested tested. Base: `157f36fe`.

**How the findings were validated.** `tests/baremetal/review/review.c` prints what each candidate does instead of
checking it; `tests/baremetal/review/run.sh` runs the one binary on QEMU TCG (`-cpu max`), the M4 under hvf (real
hardware at EL1) and webpc natively, under the reference interpreter (`jit` 0) and the block interpreter (`jit` 1), into
`tests/baremetal/review/out/` (committed). The M4 is the authority. Compiled wasm code was not run: findings below
that pass through helpers should behave the same under the JIT, but that is inferred, not observed.

The suites pass with these in place, so no guest they run depends on them, and none is in the instruction semantics the
corpus covers: the integer, FP and SIMD handlers and the block interpreter held up. All of it is at the edges: device
memory, tags, `SCTLR_EL1.A`, debug.

## Findings, ranked

Fixing any of them is a guest-visible change; none is fixed here.

### 1. Cache maintenance by VA aborts on anything that isn't RAM

`core/src/mmu.rs:940` (`Mmu::maint`), `:700` (`Flat::maint`), `core/src/vm.rs:1896` (`Io::maint`).

`maint` takes its host pointer through `Mem::host`, so a mapped address with no RAM behind it gives `FaultKind::Bus`.
`Io::maint` only forwards, so the retry through `io` fails the same way and the guest gets a synchronous external abort.

| `t4.*` on a Device mapping | M4, QEMU | webpc |
|---|---|---|
| DC CVAC, DC CIVAC, DC IVAC, IC IVAU on the UART | no exception | `0x96000150` |
| DC CVAC, IC IVAU on a hole | no exception | `0x96000150` |

With finding 2, one of the two that abort a correct program: a driver or firmware cleaning a range that includes device
or unbacked memory gets an abort where hardware does nothing. Fix: `maint` keeps translation and permission faults and
treats a `Bus` result as success; `IC IVAU` then has no block to invalidate (`Exit::Invalidate` needs a PA, or no exit).

### 2. LDAR and STLR on device memory abort

`core/src/vm.rs:1900` (`Io::host_aligned`), `core/src/mmu.rs:615-627` (`read_atomic`, `write_atomic`).

`Io` overrides `read_el` and `write_el` but not the atomics, which reach `host_aligned` and fail with `Bus`.

| `t3.*` | M4, QEMU | webpc |
|---|---|---|
| LDAR of the PL011's IBRD | 0x10, no exception | external abort |
| STLR then read back | 0x20, no exception | external abort, register keeps 0x10 |

Legal on Device memory, and Linux's `__raw_readl` is an LDAR under one erratum's alternative. Fix: `Io` overrides
`read_atomic` and `write_atomic` with an alignment check and `dev_read`/`dev_write`. Exclusives and LSE on device memory
are left out: not tested, and what hardware does there is IMPLEMENTATION DEFINED.

### 3. A branch to a tagged address keeps the tag in the PC

`core/src/interp.rs:770-773` (BR, BLR, RET), `core/src/interp/sys.rs:745` (ERET), `core/src/interp/block.rs:1073,1775`
(`K::Br`, `K::Blr`), and the JIT's indirect branches.

With TBI on the architecture removes the tag on the way into the PC (`AArch64.BranchAddr`: top byte the sign extension
of bit 55). Here the PC keeps it, so everything derived from the PC does too: ADR, BL's X30, ELR on the next exception.

| `t1.*` (TBI0 set, branch to `0x5a00...`) | M4, QEMU | webpc |
|---|---|---|
| ADR after BR | `0x0000000040006fc0` | `0x5a00000040006fc0` |
| ADR after ERET | `0x0000000040006fe4` | `0x5a00000040006fe4` |

Reached only by code that branches through tagged pointers (TBI0 is on for every Linux process). A check in every
indirect branch would cost the JIT's hot path. A way that wouldn't, not tried: a tagged PC always misses the transfer
cache and the same-page chain, so canonicalize it on the slow paths and never fill an instruction TLB entry for a
tagged VA, leaving a tagged PC nowhere to live.

### 4. IC IALLU with Rt != 31 leaves stale code

`core/src/interp/sys.rs:307-308`. The arm's comment says "as with 31", but it does nothing where Rt 31 returns
`Exit::Invalidate(u64::MAX)`.

| `t9.after_ic_iallu_rt0` (the stub patched to return 2) | M4, QEMU, `jit` 0 | `jit` 1 |
|---|---|---|
| | 2 | 1: the old block ran |

Fix, one line: return the same exit. `Rt` is should-be-ones, so no compiler emits this.

### 5. SCTLR_EL1.A checks a Q register at 8 bytes, not 16

`core/src/interp/ldst_fp.rs:11-29`: `load` and `store` split 16 bytes into two 8-byte accesses, each checked alone.

| `t2.*` with `SCTLR_EL1.A`, address 8 mod 16 | M4, QEMU | webpc |
|---|---|---|
| LDR Q, STR Q, LDP Q | alignment fault | no fault |

Fix: test `addr & 15` under `SCTLR_EL1.A` in both. Only the interpreter sees this: `A` keeps code out of the others.

### 6. Watchpoints: atomics and priority

`core/src/interp/debug.rs:266-269,309`, `:290-298`.

- A read-modify-write is checked as a write only (`Access::Write` at `host_aligned`), so a load-only watchpoint misses
  LDADD and CAS, a failing CAS included. M4 and QEMU: `0xd6000022`; webpc: no exception (`t7.*`). The fix needs to tell
  them from STXR and STLR, which share the path and must stay store-only: overrides of `rmw` and `cas` in `Watch` are not
  enough alone, as STXR uses `cas`.
- The watchpoint is checked before the translation, so on an unmapped address it wins. M4 and QEMU: translation fault
  `0x96000005`; webpc: watchpoint `0xd6000022` (`t8`). A debugger stops on an access that never happened.

### 7. DC ZVA on device memory

`core/src/interp/sys.rs:260-268`. On the M4 an alignment fault (`0x96000061`; `t5`), and with the MMU off, where every
access is Device (`t6.dc_zva_mmu_off`). Here a hole gets an external abort (as on QEMU), and by the code, not tested, a
real device's registers get eight stores of zero.

### 8. Unaligned accesses with the MMU off

`core/src/mmu.rs:686-693` (`Flat`). Device-nGnRnE memory: M4 and QEMU raise an alignment fault (`0x96000021`; `t6`);
webpc completes the access. Worth a note in docs/cpu.md, not a fix: correct firmware doesn't do it, and the `Flat`
copy exists to have no such test.

### 9. A reserved AdvSIMD encoding with FPEN 0 takes the FP trap

`core/src/interp.rs:900-904`: `fp_enabled` runs before the handler's field checks. M4 and QEMU: UNDEFINED, `0x02000000`;
webpc: EC 7, `0x1fe00000` (`t13`). Harmless to a kernel that enables FP on the trap (the retry is UNDEFINED); backlog.

### Static only, not tested

- `debug.rs:165-181`: a real external abort isn't in the list that restores `PSTATE.SS`, so a stepped instruction that
  aborts leaves SPSR.SS 0 (MMIO shares the kind, so the list can't just add it).
- `ldst.rs:14-17`, `ldst_fp.rs:43-46`: the SP alignment check comes before the checks for reserved encodings.
- `interp::run` and `run_system` treat `Exit::Wfe`, `Sev` and `TlbiIs` as faults (the latter panics in `take_exception`);
  they aren't reached there today, as only a VM's vCPUs have `FEATURE_SMP`.

## What was checked and found fine

- **`interp.rs`:** flags, condition codes (`cond_holds`), bitfield masks, EXTR, division, shifts, CCMP, every branch
  form, hint space against what's advertised.
- **`ldst.rs`, `ldst_fp.rs`:** writeback order, every addressing mode's decode, structure loads' commit after the
  last read, the exclusives' monitor, CAS/CASP masks and the XZR pair.
- **`sys.rs`:** ERET's illegal returns, SPSR, exception entry and vectors, ISS layouts, trap conditions at EL0, TLBI
  operands (`flush_va` masks the ASID that `<< 12` leaves in the top byte), the timer's EL0 checks, ID register fields.
- **`mmu.rs`:** the walk (sizes, levels, APTable, UXN/PXN, WXN, AF before permission), the TLB's tags, spill entries and
  page crossing, block invalidation.
- **`block.rs`:** decode and pack against `exec_op` kind by kind (`x` layouts, immediate ranges, UBFM masks being one
  run), `hot` against `run`, the fused B.cond and MOV runs at the prefix's end, a SLOW return's PC and step count,
  `mulh`, `bfm`, `extr`, slots and page lists, which instructions end a block and so what `Fast::ctx` may assume,
  arena pointers across decodes.
- **`simd*.rs`, `float.rs`:** every class's opcode table, reserved-field checks and saturation, from memory of the
  pseudocode; these are also what the corpus covers best.

## Optimization opportunities

Bench: `bench/interp/ab.sh`, dev VM, Chromium 153.0.8010.52, 3 alternated rounds, medians, JSON in
`bench/interp/results/review-interp/`. The rule: arms' rounds don't overlap and past ~1%.

Neither change adds code to `hot`, which is the difference from the shared probe that lost today (`bench/interp/REPORT.md`
"A shared TLB probe for pairs off one base"): that one added a path; these take instructions out of existing ones.

- **`reg`: no `& 31` on register indexes.** `rd`, `wr`, `rsp`, `wsp` mask the micro-op's byte so a bad index can't panic;
  `get_unchecked` gives the same no-panic guarantee from `pack`'s invariant and drops an instruction per operand.
- **`pair`: one TLB probe for LDP/STP and the FP pairs.** `fast_in` of `2 * size` at the first address replaces two
  probes; a pair across pages goes to the slow path, which handles it.

| benchmark | base | `reg` | `pair` |
|---|---|---|---|
| `boot_alpine_dec_mips` | 222.1 | 224.7, **+1.2%** | 224.7, **+1.2%** |
| `vm_dec_mmu_mips` | 472.3 | 482.8, **+2.2%** | 479.2, **+1.5%** |
| `dec_mips` | 475.1 | 483.2, +1.7%, rounds overlap | 474.3, −0.2% |
| `vm_dec_flat_mips` | 475.3 | 482.0, +1.4%, rounds overlap | 475.8, +0.1% |

Together (a second session, base rerun beside it), past the bar on every guest but Buildroot, which is inside its ~3%:

| benchmark | base | `reg` + `pair` |
|---|---|---|
| `boot_alpine_dec_mips` | 221.8 | 225.5, **+1.6%** |
| `boot_dec_mips` (Buildroot) | 184.2 | 186.8, +1.4%, rounds overlap |
| `dec_mips` | 472.4 | 486.5, **+3.0%** |
| `vm_dec_flat_mips` | 474.7 | 489.1, **+3.0%** |
| `vm_dec_mmu_mips` | 473.1 | 485.1, **+2.5%** |

The block interpreter's differential tests pass on all three builds; CI wasn't run on them. Not measured: x86_64, and
what this is worth under the JIT, where the interpreter runs the cold code (4.0% of the instructions on Firefox's pages
session, by the report above).

Patches: `bench/interp/results/review-interp/{reg,pair,both}.patch`.

Untried, by expected value:

- **XZR without a compare.** `rd` and `wr` still test `n == 31` on every operand. Mapping XZR at pack time to a slot
  that holds zero and one that's a write sink would drop the compare and its branch, on top of `reg`; `run`'s
  unpacking must map back, so it touches every kind.
- **`ldst_fp::multiple` copies all of `c.v`** (`ldst_fp.rs:174`, 512 bytes) for every structure access, stores
  included, to commit loads after the last read. Up to four `u128`s would do. LD1/ST1 are inline in the JIT, so this is
  LD2-4 and cold code: small, but free.
- **SUBS's flags in `hot` from its operands**, as the JIT's since today: `add_with_carry` does two carries where
  `x >= y` is one compare. `AddsI`'s `sf` could be two kinds too. Weigh against the new code in `hot`.
