# Interpreter and JIT: MIPS, CoreMark, boots, `openssl speed` (M1–M6.5)

> A dated journal, appended to per milestone and loop; the current numbers and rules are in
> `docs/benchmarking.md`. References to PLAN.md sections (§2, §7 M…, M9) are to its layout before
> 2026-09-28, when that content moved to `docs/` (M9 is now `docs/backlog.md`).

## M1: integer guest

**What runs:** the tier-0 interpreter (`core/src/interp.rs`) in wasm, on shared memory in a dedicated worker, through the vCPU exports (`interp_run`). The guest is `guest.c`, bare metal on flat memory, built by `build.sh` into the committed `guest.bin` (clang 22.1.8, `-O2 -mgeneral-regs-only`). It's a loop over a table-driven CRC32, insertion sort, a 16×16 integer matrix multiply, a linked-list walk and byte-string work.
**Method:** `node bench/run.ts --page bench/interp/index.html --config <config>`. Cold is the first 2M instructions after instantiation (one sample). Warm is 15 samples of 20M instructions each, taken after 3 warm-up chunks.
**Date:** 2026-09-25, code at commit `fa617211a391`. The x86_64 JSON says `dirty` only because `M1-KICKOFF.md` was untracked. The Mac copy was an rsync of that tree with the same wasm bytes, not a git checkout, so its `commit` is null.

| Host | Chromium | Config | Cold (MIPS) | Warm median (MIPS) | IQR |
|---|---|---|---|---|---|
| Ryzen 7 5800X3D, Linux x86_64 | 152.0.7977.75 | default | 68.3 | **91.0** | ±0.06 |
| | | turbofan-only | 57.7 | 83.7 | ±0.38 |
| | | liftoff-only | 23.9 | 24.1 | ±0.08 |
| Apple M4, macOS 26.6 arm64 | 153.0.8010.12 (Chrome for Testing) | default | 104.2 | **148.8** | ±3.84 |
| | | turbofan-only | 82.5 | 138.5 | ±4.59 |
| | | liftoff-only | 34.1 | 36.6 | ±0.52 |

Raw data: `results/chromium-{linux-x86_64,darwin-arm64}-{default,turbofan-only,liftoff-only}.json`.

**Notes**
- An earlier x86_64 default run on a dirty tree measured 83.9 MIPS against 91.0 here, so treat about ±8% as noise on this shared desktop. The default vs turbofan-only gap is within that noise on both hosts.
- Liftoff is 3.8× (x86_64) and 4.1× (M4) slower than TurboFan on the interpreter. Tier-up happens early: even the cold 2M instructions run mostly in TurboFan code.
- Every instruction does a fetch through `Mem::host`, a bucket decode and a `match` dispatch, with no decode cache (`ponytail:` note in `interp::step`). That's the obvious lever if the interpreter's speed ever matters beyond being the JIT's fallback and reference.

## M2: FP/NEON guest, and the integer re-run

**What runs:** the same harness with a second guest, `guest-fp.c` → `guest-fp.bin` (clang 22.1.8, `-O2 -march=armv8-a -fno-math-errno`, so ARMv8.0 FP/AdvSIMD only). It's a loop over an auto-vectorized 16×16 f32 matrix multiply (FMLA), an 8-body f64 n-body step (FSQRT, FDIV, FMADD), FMA Horner polynomials, float↔int conversions and a NEON-intrinsics u8 image kernel (UMULL, UQXTN, TBL, CNT, UADALP). FPCR is 0 (round to nearest, no FZ/DN), so the fast paths apply wherever the operands allow. The integer guest is unchanged (same `guest.bin`).
**Method:** as for M1 (`node bench/run.ts --page bench/interp/index.html --config <config>`; the suite now runs `interp_mips` and `interp_fp_mips`).
**Date:** 2026-09-25, code at commit `628574ed6df9` on both hosts (`dirty` only because the kickoff notes are untracked). The Mac ran an rsync of that tree with the same wasm bytes (sha256 `b78189ff…`).

| Host | Chromium | Config | Integer cold | Integer warm (IQR) | FP/NEON cold | FP/NEON warm (IQR) |
|---|---|---|---|---|---|---|
| Ryzen 7 5800X3D, Linux x86_64 | 152.0.7977.75 | default | 50.9 | **95.2** (±0.10) | 14.9 | **15.3** (±0.05) |
| | | turbofan-only | 45.7 | 87.4 (±0.37) | 14.0 | 18.5 (±0.06) |
| | | liftoff-only | 23.6 | 24.0 (±0.03) | 6.0 | 6.0 (±0.01) |
| Apple M4, macOS 26.6 arm64 | 153.0.8010.12 (Chrome for Testing) | default | 64.4 | **151.7** (±2.97) | 21.8 | **22.7** (±0.08) |
| | | turbofan-only | 62.1 | 137.4 (±2.81) | 22.5 | 30.1 (±0.09) |
| | | liftoff-only | 31.2 | 32.2 (±0.33) | 8.5 | 8.8 (±0.07) |

Raw data: `results/chromium-{linux-x86_64,darwin-arm64}-{default,turbofan-only,liftoff-only}.json` (these replace the M1 files, which stay in git history; each now holds both guests).

**Notes**
- **Integer re-run:** 95.2 MIPS on x86_64 (M1: 91.0) and 151.7 on the M4 (M1: 148.8). Adding V0–V31, FPCR and FPSR to `Cpu` and the FP/SIMD decode arms cost nothing measurable; both differences are inside the ±8% noise noted above.
- **The FP/NEON guest runs at about a sixth of the integer rate** (15.3 vs 95.2 on x86_64, 22.7 vs 151.7 on the M4). Every FMLA/FMADD takes the exact software FMA in `fp.rs`. Every vector FP instruction goes lane by lane through an `Fpu` context and `u128` lane extraction. Those are the levers if the interpreter's FP speed ever matters. The JIT (M5) will inline the RNE fast paths instead.
- **TurboFan-only beats the default tiering on the FP guest** on both hosts: +21% on x86_64, +32% on the M4, repeated and well past noise. The integer guest shows the opposite. Why V8's dynamic tiering ends up slower here is open. It's worth a look when the core's helpers become JIT slow paths in M5.

## M3 step 3: the re-run after the MMU

**What changed:** every guest access now goes through `mmu::Bus` (`core/src/mmu.rs`). The benchmark guests still run in user mode with the MMU off (`interp_run`), so this measures what the MMU costs code that doesn't use it. Measuring with the MMU on needs the whole-VM export (`run_system`), which waits for the host ABI note.
**Method:** as for M1/M2. Code at commit `345b4a415737` on both hosts, the same wasm bytes (sha256 `030e4e01e2f3…`). `dirty` in the JSON is only the untracked kickoff notes, plus on the Mac the result files of the earlier configs of the same run.

| Host | Chromium | Config | Integer cold | Integer warm (IQR) | FP/NEON cold | FP/NEON warm (IQR) |
|---|---|---|---|---|---|---|
| Ryzen 7 5800X3D, Linux x86_64 | 152.0.7977.75 | default | 50.5 | **85.7** (±0.22) | 14.2 | **14.8** (±0.10) |
| | | turbofan-only | 40.6 | 80.7 (±0.62) | 12.7 | 17.5 (±0.10) |
| | | liftoff-only | 23.2 | 23.5 (±0.02) | 5.8 | 5.6 (±0.05) |
| Apple M4, macOS 26.6 arm64 | 153.0.8010.12 (Chrome for Testing) | default | 75.5 | **139.5** (±2.31) | 21.5 | **22.1** (±0.03) |
| | | turbofan-only | 61.4 | 127.5 (±2.57) | 21.0 | 29.1 (±0.20) |
| | | liftoff-only | 30.1 | 32.2 (±0.30) | 8.6 | 8.6 (±0.07) |

Raw data: `results/chromium-{linux-x86_64,darwin-arm64}-{default,turbofan-only,liftoff-only}.json` (these replace the M2 files).

**Notes**
- **Against M2: integer −10% on x86_64 (95.2 → 85.7) and −8% on the M4 (151.7 → 139.5); FP/NEON −3% on both.** Step 1 (exception model, system registers) had cost nothing: 94.9 on x86_64. The loss is the MMU step.
- **The first MMU build lost 43% (54.4 MIPS on x86_64),** although no guest instruction took an MMU path. Any call site into MMU code (a TLB miss, a page split) inlined into the interpreter's big dispatch function slowed the whole function down in V8: the fast paths are the same, only the untaken calls differ. Moving the fetch back to a plain physical read alone recovered 60 → 79 (`--quick`). The fix is two copies of the interpreter: `Bus` is a trait with `Flat` (MMU and `SCTLR_EL1.A` off: one physical access) and `Mmu` (TLB, walks, page splits), and the run loop picks the copy per instruction from `SCTLR_EL1`. Forcing the per-instruction step into the run loops (instead of leaving the call to V8) was worth another ~15%.
- **What the remaining 10% is** (x86_64, default, full runs): the SP alignment check on SP-based loads/stores costs 3.3% (88.6 without it), and it's architectural (Linux sets `SA0`). Choosing the interpreter copy per instruction costs 2.7% (88.1 with `Flat` hard-wired); moved out of the loop below. The last ~4% is spread over the new fault and accessor types and wasn't split further.
- **Choosing the copy outside the loop (commit `8912986`).** An `MSR` that changes `SCTLR_EL1.M` or `.A` now retires with the internal `Exit::Resync`, and the run loops re-pick the copy only then. Default config, full runs, same wasm on both hosts (sha256 `cae0c2c9c75b…`): **x86_64 88.5 integer / 15.2 FP** (±0.14 / ±0.05), **M4 145.4 / 22.4** (±2.50 / ±0.10). Against the per-instruction choice that's +3.3% integer on x86_64 (confirmed back to back: 86.7 old vs 88.8 new) and +4.3% on the M4; FP is unchanged. That leaves integer −7% (x86_64) and −4% (M4) against M2, of which the architectural SP alignment check is ~3%. `results/chromium-*-default.json` now hold these runs; the turbofan-only and liftoff-only files are still from `345b4a4`.
- These are V8 code-generation effects, so they will look different in JIT code. The JIT (M5) inlines its own TLB lookup and keeps slow paths as helper calls, which is the shape that suffered here: check the generated machine code (M0.5 method) when it's built.

## M3 step 4: the re-run after the platform devices

**What changed:** the timer, GIC, PL011 and the whole-VM run loop (`core/src/vm.rs`). The benchmark still runs the guests in user mode through `interp_run`, so this checks that the interpreter's flat and MMU copies didn't pay for the devices. They shouldn't: device MMIO re-executes the faulting instruction on a third `Bus` copy (`vm::Io`), and timer registers leave the interpreter through an exit. `exec` grew by 26 bytes per copy (`tools/wasm-sizes.ts`) and kept its inlined handlers.
**Method:** default config, full runs, code at commit `88c35afe466b`, the same wasm on both hosts (sha256 `19abbd20fd7f…`). `dirty` is the untracked kickoff notes. Before that, three back-to-back `--quick` pairs on x86_64 against a build of `fd7a3c0`: integer 88.3/87.7/88.3 old vs 88.6/88.3/86.6 new, FP 15.0/15.1/15.0 vs 15.0/15.0/15.1.

| Host | Chromium | Integer cold | Integer warm (IQR) | FP/NEON cold | FP/NEON warm (IQR) |
|---|---|---|---|---|---|
| Ryzen 7 5800X3D, Linux x86_64 | 152.0.7977.75 | 51.8 | **87.6** (±0.15) | 14.5 | **15.1** (±0.02) |
| Apple M4, macOS 26.6 arm64 | 153.0.8010.12 (Chrome for Testing) | 68.4 | **146.2** (±1.79) | 21.7 | **22.3** (±0.07) |

Against step 3 (88.5 / 15.2 and 145.4 / 22.4): −1.0% and −0.7% on x86_64, +0.6% and −0.4% on the M4, all under the 5% noise threshold and not seen in the back-to-back pairs. **No change.** Raw data: `results/chromium-{linux-x86_64,darwin-arm64}-default.json` (replacing the step 3 runs).

## M4 step 1: `vm_run` MIPS, splitting the system-mode gap

**What runs:** the integer guest (`guest.c`, rebuilt as `guest-vm.bin` linked at `0x4021_0000`; `guest.bin` rebuilds bit for bit) in a whole VM through `vm_run`, at EL1 with DAIF masked and no timer armed, so the run loop does its per-chunk work (signal word, interrupt lines, GIC, deadline, 1024 steps a chunk) but never takes an IRQ. `vm-start.S` (raw binary at `0x4020_0000`, booted by `vm_boot` like a kvm-unit-tests `.flat`) enables FP and, for `vm_mmu_mips`, the MMU: one 1 GiB identity block through TTBR0 (T0SZ 25), so VA = PA and the guest's code and data are the same in both variants. The TLB is per 4 KiB page whatever the block size, so after warm-up every access hits.
**Method:** `node bench/run.ts --page bench/interp/index.html`, default config, full runs; the four benchmarks in one page. Same wasm on both hosts (sha256 `e970eba0e18c…`), code at `d421351` plus this change. The Mac ran an rsync of the working tree, so its JSON's `commit` is its stale checkout's, not the code's.

| Host | Chromium | `interp_mips` (EL0, flat) | `vm_flat_mips` (EL1, MMU off) | `vm_mmu_mips` (EL1, MMU on) | Linux boot (`bench/boot`) |
|---|---|---|---|---|---|
| Ryzen 7 5800X3D, Linux x86_64 | 152.0.7977.75 | **87.5** (±1.13) | **85.9** (±0.82) | **54.9** (±0.12) | 44 |
| Apple M4, macOS 26.6 arm64 | 153.0.8010.12 (Chrome for Testing) | **145.9** (±3.82) | **145.7** (±3.36) | **94.7** (±1.30) | 68 |

Cold (first 2M instructions): 50.3 / 86.1 / 41.0 on x86_64, 78.2 / 144.8 / 68.9 on the M4. FP/NEON (`interp_fp_mips`) 15.0 and 22.4, unchanged. Raw data: `results/chromium-{linux-x86_64,darwin-arm64}-default.json` (replacing the M3 step 4 runs).

**The split of the gap** (user mode 87.5 → boot 44 on x86_64; 146 → 68 on the M4):
- **The run loop costs nothing measurable:** −1.8% on x86_64, −0.1% on the M4, both under noise. Chunking at 1024 steps and checking the signal word and the interrupt lines between chunks is free at this granularity.
- **The MMU copy of the interpreter costs 36% (x86_64) and 35% (M4)** on a guest whose every fetch, load and store hits the TLB. It's most of the gap: 87.5 → 54.9 of the way to 44, and 146 → 95 of the way to 68.
- **The rest (54.9 → 44, 95 → 68, about −20% and −28%) is the boot's own work:** TLB misses and walks, ~1,000 exceptions, ~46 IRQs, timer and UART accesses leaving the interpreter, and a different instruction mix (`bench/boot/REPORT.md`).
- Why the TLB-hit path costs a third isn't split yet: every instruction fetch goes through the TLB (no decode cache or per-page fetch pointer), and so does every load and store. M3 step 3 measured the MMU copy only with the MMU off. The JIT (M5) replaces both paths with its own inlined lookup, so whether to tune the interpreter's is an open choice (PLAN.md §7 M9).

## M5 step 2: the gadget-only JIT baseline

**What runs:** the same four guests through the tier-1 JIT's correctness scaffold (`core/src/jit/`): blocks of up to 32 instructions keyed by PA, every instruction a call from the block's wasm function to a core helper (`jit_exec_flat`/`jit_exec_mmu`, the interpreter's `exec_at`), batched into modules, entered through a dispatcher (instruction-TLB translation of the PC, a 4096-entry direct-mapped jump cache, a `call_indirect` through the core's table). Policy `jit::Config::DEFAULT`: threshold 50 dispatches, 32 blocks per module or a 100,000-step timeout, 16,384 blocks of code cache. `jit_mips`/`jit_fp_mips` run in user mode (`jit_new`/`jit_run`), `vm_jit_*` in the whole VM (`VmConfig.jit` = 1). **Expected to be slower than the interpreter; this is the baseline steps 4–8 improve on.**
**Method:** `node bench/run.ts --page bench/interp/index.html`, default config, one full run of all eight benchmarks, x86_64 only (both hosts come in M5 step 10). Code at `2ada422` plus step 2c. JIT counters over the cold window (the first 2M instructions) and the warm window (the 15 measured chunks), from `jit::Stats`.

| Guest | Interpreter warm (IQR) | JIT warm (IQR) | JIT / interp | Interp cold | JIT cold | Dispatches / insn | Avg block | Interpreted, cold / warm | Cold: blocks, modules, bytes, compile |
|---|---|---|---|---|---|---|---|---|---|
| integer, EL0 | 88.7 (±0.60) | **64.8** (±0.31) | −27% | 50.4 | 44.6 | 0.240 | 4.16 | 6.9% / 0 | 20, 4, 6.0 KB, 0.5 ms |
| FP/NEON, EL0 | 15.1 (±0.02) | **14.8** (±0.10) | −2% | 14.5 | 13.2 | 0.087 | 11.48 | 5.7% / 0 | 30, 2, 12.4 KB, 0.2 ms |
| integer, EL1 MMU off | 87.8 (±0.66) | **64.6** (±0.49) | −26% | 87.5 | 43.1 | 0.240 | 4.15 | 7.3% / 0.26% | 25, 5, 6.6 KB, 0.4 ms |
| integer, EL1 MMU on | 54.5 (±0.43) | **54.9** (±0.08) | +1% | 40.5 | 39.7 | 0.240 | 4.15 | 7.3% / 0.26% | 25, 5, 6.6 KB, 0.4 ms |

Host: Ryzen 7 5800X3D, Linux x86_64, Chromium 152.0.7977.75. Raw data: `results/chromium-linux-x86_64-m5-step2.json`.

**Notes**
- **The interpreter didn't move.** Sharing `exec_at` between `step_bus` and the helpers, and the run loop's branch to the dispatcher, left `interp_mips` 86.5 → 88.7, `interp_fp_mips` 14.7 → 15.1, `vm_flat_mips` 89.2 → 87.8 and `vm_mmu_mips` 54.9 → 54.5 against a build of `7de3be8` run just before (all within noise). One full run in between read 81.8 and 80.8 for the first and third; they came back to 88.5 and 86.6 alone and in the run above, so that was the shared desktop.
- **Where the gadget JIT loses:** on the integer guest it costs 15.4 ns per instruction against the interpreter's 11.3, about 17 ns more per 4.16-instruction block. Each block is one dispatch (a PC translation and a jump cache hit: the warm windows compile nothing and never reach the `HashMap`) plus a `call_indirect` over up to 20 hot blocks, which step 1 measured at 13–16 ns cycling over 16 blocks, plus four import calls into the core (~2.2 ns each, spike §3). So the table call, not the lookup, is most of the loss; linking (step 7) removes it, and inlining (steps 4–6) removes the helper calls.
- **FP loses little** because the blocks are long (11.5 instructions) and each instruction's helper does a lot of work.
- **With the MMU on the JIT breaks even**: a block translates its fetch once at entry, where the interpreter's MMU copy translates every instruction's fetch through the TLB (the 36% M4 step 1 measured is partly that).
- **Warm, in the VM, 0.26% of steps are interpreted:** blocks that don't fit in what's left of a 1024-step chunk (or before a deadline) run in the interpreter, which keeps the step count exact.
- **Cold:** 4–5 modules of ≤ 32 blocks compile in 0.4–0.5 ms in total (the 100,000-step timeout emits the partial batches); cold MIPS is 44.6 against the interpreter's 50.4 in user mode. The VM guest's cold window hides the interpreter's own warm-up (87.5, nearly warm), so the JIT's cold number there is mostly V8 compiling the JIT modules lazily.

## M5 step 4: inline integer ALU and branches

**What runs:** the step 2 JIT with `core/src/jit/emit.rs`: moves, ADR/ADRP, add/sub (all forms, with flags), ADC/SBC, logical, bitfield moves, EXTR, shifts, conditional select and compare, multiplies, divides, REV/RBIT/CLZ/CLS, the NOP hints and every branch are emitted as wasm over the `Cpu` in memory (NZCV stored whole after each flag-setting instruction). Everything else (loads and stores above all) is still a helper call. Same policy as step 2 (threshold 50, batches of 32, 16,384 blocks).
**Method:** `node bench/run.ts --page bench/interp/index.html`, default config, one full run of the eight benchmarks at `641aa67`; `interp_mips` again alone twice (below). Boots: `--page bench/boot/index.html --only boot|boot_jit|boot_alpine|boot_alpine_jit` (the `_jit` variants are new: `VmConfig.jit` = 1), deterministic, 5 cold and 10 warm Buildroot boots, 3 cold and 5 warm Alpine boots. "Inline, static / dynamic": the share of compiled instructions that are inline, and of the instructions run in JIT code (`jit::Stats`, ABI 12).

| Guest | Interpreter warm (IQR) | JIT warm (IQR) | JIT / interp | Step 2 JIT | Interp cold | JIT cold | Dispatches / insn | Inline, static / dynamic |
|---|---|---|---|---|---|---|---|---|
| integer, EL0 | 88.8 (±0.33)¹ | **134.8** (±0.15) | **+52%** | 64.8 | 48.4¹ | 89.3 | 0.240 | 72% / 72% |
| FP/NEON, EL0 | 15.2 (±0.01) | **15.5** (±0.03) | +1% | 14.8 | 14.2 | 13.6 | 0.087 | 28% / 30% |
| integer, EL1 MMU off | 89.1 (±0.11) | **131.9** (±0.12) | **+48%** | 64.6 | 77.5 | 65.0 | 0.240 | 70% / 72% |
| integer, EL1 MMU on | 54.1 (±0.19) | **90.5** (±0.09) | **+67%** | 54.9 | 41.0 | 55.9 | 0.240 | 70% / 72% |

¹ Alone (`results/chromium-linux-x86_64-m5-step4-interp-alone.json`; a second run read 88.6 ± 0.21). In the full run it read 69.0 (± 1.20), the shared desktop's one-off low reading the step 2 notes describe; the interpreter's code didn't change in step 4 (a few field helpers became `pub(crate)`).

| Boot (Chromium, deterministic) | Interpreter warm (IQR) | JIT warm (IQR) | JIT / interp | Step 3 JIT | Steps in JIT code | Dispatches / insn | Inline, static / dynamic | Compiled |
|---|---|---|---|---|---|---|---|---|
| Buildroot, to power-off | 1069 ms (±6) | **1071 ms** (±113) | 0% | 1.6 s² | 84.5% | 0.198 | 66% / 68% | 12,425 blocks, 471 modules, 2.0 MB, 51 ms |
| Alpine, to power-off | 68.1 s (±0.07) | **58.9 s** (±0.05) | **−14%** | 104 s² | 96.1% | 0.180 | 70% / 73% | 244,487 blocks, 15,116 modules, 42 MB, 1.49 s, 14 flushes |
| Alpine, to its script | 57.3 s (±0.07) | **48.2 s** (±0.07) | −16% | | | | | |

² `tests/browser.test.ts` timings from step 3 (one boot each), not `bench/run.ts`. Cold boots: Buildroot 1168 ms JIT vs 1091 interpreter, Alpine 58.9 s vs 68.1 s.

Host: Ryzen 7 5800X3D, Linux x86_64, Chromium 152.0.7977.75. Raw data: `results/chromium-linux-x86_64-m5-step4.json`, `results/chromium-linux-x86_64-m5-step4-interp-alone.json`, `../boot/results/chromium-linux-x86_64-m5-step4-{boot,boot_jit,boot_alpine,boot_alpine_jit}.json`.

**Notes**
- **The JIT now beats the interpreter** on every integer guest and on Alpine. The integer guest costs 7.4 ns per instruction against 15.4 at step 2 and the interpreter's 11.3; the other 28% of its instructions (loads and stores) are still helper calls, and each 4.2-instruction block is still one dispatch and one `call_indirect`, the costs steps 5 and 7 remove.
- **With the MMU on the gain is largest (+67%)**: the interpreter translates every fetch through the TLB, a block translates once at entry, and inline instructions touch no TLB at all.
- **FP barely moves**: its hot code is FP and NEON helpers (M6 lowers them); 30% of its steps are inline integer bookkeeping.
- **Buildroot breaks even**: its boot is short and cold. 15.5% of its steps run in the interpreter (code below the threshold, or blocks that don't fit a chunk), the JIT compiles 12k blocks in 51 ms, and its warm IQR (±113 ms) is 10× the interpreter's, which looks like V8 tiering the 471 modules up at different points in each boot.
- **Alpine flushes the code cache 14 times** (244k blocks through a 16,384-block cache). What it costs, and a larger cache or per-module eviction, belong to steps 7–8 (linking and regions change the block count anyway).
- **The dynamic mix follows the static one** (72% of the integer guest's instructions are inline, statically and as run). The helper-call histogram that picked group 6 was ad hoc (a counter in the interpreter's step for words `emit::inline` rejects, over the Buildroot boot): loads and stores were 85% of the remaining helper calls; then NOP/BTI/PAC hints (2.9% of helper calls), MRS (1.7%), exclusives, MADD (1.1%), DC ZVA, DMB, REV, UMADDL, CLZ. The histogram by `Op` is step 9.

## M5 step 5: inline loads and stores

**What runs:** step 4 plus `emit::ldst`: LDR/STR of every size and sign (unsigned offset, unscaled, pre/post-index, register offset), the integer pairs, LDR (literal) and PRFM inline, through the TLB array of the block's EL with the MMU on (the spike's fast path: tag compare on `(va + len − 1) | 0xfff`, `host = va + addend`) or a bounds check against RAM with it off. Misses, faults, MMIO, page-crossing accesses and a misaligned SP base re-execute the instruction through the step 2 helper. Exclusives, atomics, LDTR/STTR and FP/SIMD accesses stay helpers. **Method:** as step 4, one full `bench/interp` run at `1f5c2b9`, then `boot_jit` and `boot_alpine_jit`; the interpreter's boot numbers are step 4's (its code hasn't changed since).

| Guest | Interpreter warm (IQR) | JIT warm (IQR) | JIT / interp | Step 4 JIT | Interp cold | JIT cold | Inline, dynamic |
|---|---|---|---|---|---|---|---|
| integer, EL0 | 89.2 (±0.31) | **337.9** (±0.80) | **3.79×** | 134.8 | 51.9 | 116.6 | 100% |
| FP/NEON, EL0 | 15.2 (±0.04) | **15.6** (±0.05) | +3% | 15.5 | 14.6 | 15.3 | 31% |
| integer, EL1 MMU off | 89.0 (±0.08) | **218.6** (±0.26)³ | **2.46×** | 131.9 | 78.2 | 98.5 | 100% |
| integer, EL1 MMU on | 54.0 (±0.25) | **179.6** (±0.32)³ | **3.33×** | 90.5 | 40.6 | 81.5 | 100% |

³ The low of two modes. In other runs the same builds switched mid-run, for several samples, to 320 (MMU off) and 225–240 (MMU on) and back (`../results/local` runs; the step 5.1 samples `217 217 217 217 320 320 …`), under the default config and under `--config turbofan-only` alike, so it isn't Liftoff→TurboFan tier-up. It's plausibly V8's speculative inlining of the core's `call_indirect` into the blocks and its deopts, but I haven't verified that. Linking (step 7) replaces that call; until then, compare these guests' modes, not their medians alone.

| Boot (Chromium, deterministic) | Interpreter warm (IQR) | JIT warm (IQR) | JIT / interp | Step 4 JIT | Steps in JIT code | Inline, dynamic | Compiled |
|---|---|---|---|---|---|---|---|
| Buildroot, to power-off | 1069 ms (±6) | **853 ms** (±136) | **−20%** | 1071 ms | 84.5% | 97.1% | 12,425 blocks, 471 modules, 3.4 MB, 56 ms |
| Alpine, to power-off | 68.1 s (±0.07) | **40.1 s** (±0.18) | **−41%** | 58.9 s | 96.1% | 96.9% | 244,487 blocks, 15,116 modules, 69 MB, 1.98 s, 14 flushes |
| Alpine, to its script | 57.3 s (±0.07) | **32.3 s** (±0.12) | −44% | 48.2 s | | | |

Cold: Buildroot 962 ms (JIT) vs 1091 (interpreter), Alpine 40.2 s vs 68.1 s. Host: Ryzen 7 5800X3D, Linux x86_64, Chromium 152.0.7977.75. Raw data: `results/chromium-linux-x86_64-m5-step5.json`, `../boot/results/chromium-linux-x86_64-m5-step5-{boot_jit,boot_alpine_jit}.json`, `results/m5-step5-tlb/` (the layout experiments).

**TLB entry layout (PLAN §7 M5):** against the 16-byte {tag, u64 addend} entry, (A) a `usize` addend (32 bits on wasm32, added in i32) and (B) A plus split tag and addend arrays (12 bytes per entry), on Alpine's boot under the JIT: 40.34 s (±0.21), 40.42 s (±0.02), 41.23 s (±0.18); the interpreter's MMU guest 53.4, 52.6, 52.5 MIPS; Buildroot's JIT boot 857, 860, 870 ms (±135 each) and the JIT's MMU guest (TurboFan-only, bimodal as above) the same within noise. Neither pays: B's extra index arithmetic (the addend offset is half the tag's) costs more than the denser arrays save on this trace, and A saves one wasm op. The entry stays as it is; the emitter finds it with one shift and mask, `(va >> 8) & 0xfff0`.

**Notes**
- **Where the integer guest's time goes now:** 3.0 ns per instruction (11.2 in the interpreter), every instruction inline, one dispatch and one `call_indirect` per 4.2-instruction block. That per-block cost is likely most of what's left: step 1's 13–16 ns per table call cycling over 16 blocks would be more than the whole 12.4 ns a block takes now, so it's cheaper in this steady loop, but it's still a call V8 can't inline without speculation, and linking (step 7) removes it. Registers and NZCV still round-trip through memory (step 6).
- **Alpine:** 97% of the instructions run in JIT code are inline, and 3.9% of its steps are interpreted (cold code under the threshold, blocks that don't fit a chunk). Compiling costs 2.0 s of the 40 s (69 MB of wasm: inline loads and stores are larger than the helper calls they replace, +65% bytes over step 4), and the 16,384-block cache flushes 14 times.
- **Buildroot:** −20%, but its warm IQR stays wide (±136 ms), which fits the same bimodality at boot scale.
- **Still slower under the JIT:** kvm-unit-tests `timer` (3.3 s vs 2.6 s in Node, 106M steps): it spends its time in short blocks around timer polls and WFI, where a dispatch per block costs more than it saves.

## M5 step 6: registers in locals, lazy NZCV

**What runs:** step 5 plus, within each block: guest registers in i64 locals (loaded on first use, written back before helper calls and returns; the load/store slow path writes back before its helper and reloads the instruction's destinations after it), lazy NZCV (setters keep their operands in flag locals; a setter the next one replaces emits no flag code; conditions come straight from the operands where the kind allows, e.g. `cmp; b.lt` is `i64.lt_s`; NZCV is stored before helpers, on a load/store's failure return, and before the block's branch), only the locals a block uses declared, and registers read once and never written read straight from memory. NZCV is still live out of every block (no successor knowledge until steps 7–8). **Method:** as step 5: one full `bench/interp` run at `901bb1a`, `boot_jit` and `boot_alpine_jit`; `--only jit_mips --config liftoff-only|turbofan-only` runs for the per-tier numbers (`results/m5-step6/`, each named after the slice and experiment).

| Guest | Interpreter warm (IQR) | JIT warm (IQR) | JIT / interp | Step 5 JIT |
|---|---|---|---|---|
| integer, EL0 | 89.4 (±0.16) | **370.5** (±1.04) | **4.14×** | 337.9 |
| FP/NEON, EL0 | 15.1 (±0.03) | **15.5** (±0.04) | +3% | 15.6 |
| integer, EL1 MMU off | 88.0 (±0.29) | **349.6** (±0.89)⁴ | **3.97×** | 218.6 (modes 218 / 320) |
| integer, EL1 MMU on | 54.2 (±0.22) | **192.8** (±0.10)⁴ | **3.56×** | 179.6 (modes 177 / 240) |

⁴ The high mode (MMU off) and the low mode (MMU on) of step 5's two-mode behavior, which persists: compare with 320 and 177–180. Earlier step 6 runs read MMU off at 307, 220 and 231.

**The integer guest by V8 tier and slice** (`--only jit_mips`, MIPS):

| Build | Default | TurboFan only | Liftoff only |
|---|---|---|---|
| step 5 | 337.9 | 351.7 | 118.1 |
| 6.1 registers in locals | 357.4 | 368.1 | 111.3 |
| 6.2 lazy NZCV (stored at the block's end) | **240.5** | 231.9 | 105.5 |
| 6.3 NZCV stored before the block's branch | 369.8 | | 101.1 |
| 6.4 only the used locals declared | 373.5 | 382.2 | 107.9 |
| 6.5 once-read registers without a local | 370.5 | 379–384 | 116.2 |

| Boot (Chromium, deterministic) | Step 5 JIT | Step 6 JIT (IQR) | Steps in JIT code | Inline, dynamic | Compiled |
|---|---|---|---|---|---|
| Buildroot, to power-off | 853 ms (modes 785 / 920) | **867 ms** (±157; modes 786 / 945) | 84.5% | 97.1% | 12,425 blocks, 3.9 MB (+13%), 56 ms |
| Alpine, to power-off | 40.1 s (±0.18) | **39.3 s** (±0.32) | 96.1% | 96.9% | 244,487 blocks, 77.6 MB (+12%), 2.04 s, 14 flushes |
| Alpine, to its script | 32.3 s (±0.12) | **31.5 s** (±0.27) | | | |

**Flags (static, `jit::Stats`, ABI 13):** in Alpine's compiled code 8.5% of the lazy flag setters are never stored (Buildroot 9.2%) and 90.5% of conditions are computed directly from a setter's operands (0.8% from NZCV computed in registers, 8.6% from NZCV in memory: flags set before the block). The rest of the setters are stored because NZCV is live out of every block; that, and the conditions from memory, are what steps 7–8 (successor knowledge, regions) can remove.

Host: Ryzen 7 5800X3D, Linux x86_64, Chromium 152.0.7977.75. Raw data: `results/chromium-linux-x86_64-m5-step6.json`, `results/m5-step6/`, `../boot/results/chromium-linux-x86_64-m5-step6-{boot_jit,boot_alpine_jit}.json`.

**Notes**
- **Where NZCV is computed matters to TurboFan, not how often.** 6.2 computed the lazy NZCV at the block's end, after the branch's `select` of the next PC: 240 MIPS (TurboFan only 232). Storing it eagerly after every setter (more work) ran at 368, and storing it just before the block's last instruction at 371. So 6.3 stores lazy flags before a block-ending instruction, keeping them lazy so the branch's condition stays direct. I haven't looked at V8's machine code to see why; the order is pinned by a unit test.
- **Liftoff pays for every declared local**, on every call (it zero-initializes them): 20 unused i64 locals took the integer guest from 101 to 83 MIPS under `--liftoff-only`. Registers in locals won under TurboFan (+5–9%) and lost under Liftoff (118 → 101), which is why the boots didn't gain at first (Alpine 41.9 s at 6.3, Buildroot slower in both modes: much of a boot runs in Liftoff code, and Alpine flushes and recompiles 14 times). Declaring only the used locals (6.4) and leaving once-read registers in memory (6.5) brought Liftoff back to 116 and Alpine to 39.3 s.
- **Code size:** +12–13% over step 5, mostly the load/store slow paths (each writes back the dirty registers before its helper call, stores lazy NZCV on its failure return, and reloads after). Compile time barely moved (Alpine 2.04 s vs 1.98 s).
- **A rustc/LLVM miscompile** (wasm32, simd128, nightly-2026-09-24): counting register uses in a `[u8; 32]` and comparing it into a u32 mask swapped the mask's 16-bit halves (PLAN.md M9 has a 12-line repro). The multi-instruction differential test caught it within the first run; the emitter tracks uses as bit masks instead.

## M5 step 7: linking

**What runs:** step 6 plus chaining. Block functions are `block(vcpu, acc, left) -> acc + retired`; a block whose successor is static (a direct branch, both sides of a conditional one, the fall-through, or the instruction after an MRS, a barrier, CLREX, YIELD/SEV or DC whose helper retired) tail-calls it (`return_call`) with `acc + len` and `left − len` when `left` covers both, so chains retire exactly what the dispatcher would have run. Compiled successors are direct calls (same batch) or imports by table index (`t.<index>`); with the MMU on, one in another guest page is chained behind an instruction-TLB check that its VA still maps to the PA it was compiled for. A successor compiled *after* its predecessor, and every BR/BLR/RET target (translated through the instruction TLB), is probed in the jump cache from wasm and tail-called through the table (`return_call_indirect`). The code cache holds 65,536 blocks (was 16,384) and the jump cache 65,536 entries. **Method:** `bench/run.ts` as step 6, one full `bench/interp` run and `boot_jit`/`boot_alpine_jit` at `b4884bf`; step 6's boots re-measured with the new harness (a GC before every boot, below) at `9b8370b`.

| Guest | Interpreter warm (IQR) | JIT warm (IQR) | JIT / interp | Step 6 JIT | Dispatches / insn (step 6) |
|---|---|---|---|---|---|
| integer, EL0 | 89.1 (±0.29) | **1258.3** (±1.39) | **14.1×** | 370.5 | 0.0000 (0.240) |
| FP/NEON, EL0 | 15.2 (±0.02) | **15.7** (±0.01) | +3% | 15.5 | 0.0000 (0.087) |
| integer, EL1 MMU off | 87.9 (±0.10) | **1090.8** (±7.91) | **12.4×** | 349.6 | 0.001 (0.240) |
| integer, EL1 MMU on | 53.9 (±0.22) | **925.5** (±5.05) | **17.2×** | 192.8 | 0.001 (0.240) |

| Boot (Chromium, deterministic, GC before each) | Interpreter | Step 6 JIT (IQR) | Step 7 JIT (IQR) | Step 7 / step 6 | Dispatches / insn (step 6) | Compiled (step 6) |
|---|---|---|---|---|---|---|
| Buildroot, to power-off | 1069 ms | 938 ms (±3) | **927 ms** (±6) | −1% | 0.0075 (0.198) | 12,430 blocks, 5.0 MB, 68 ms (12,425, 3.9 MB, 56 ms) |
| Alpine, to power-off | 68.1 s | 39.4 s (±0.07) | **24.0 s** (±0.38) | **−39%** | 0.0062 (0.180) | 56,791 blocks, 23.9 MB, 0.78 s, no flush (244,487, 77.6 MB, 1.83 s, 14 flushes) |
| Alpine, to its script | 57.3 s | 31.9 s | **20.2 s** | −37% | | |

Alpine now boots 2.84× faster than on the interpreter. The interpreter numbers are step 4's (its code hasn't changed). Host: Ryzen 7 5800X3D, Linux x86_64, Chromium 152.0.7977.75. Raw data: `results/chromium-linux-x86_64-m5-step7.json`, `results/m5-step7/`, `../boot/results/chromium-linux-x86_64-m5-step{7,6-gc}-{boot_jit,boot_alpine_jit}.json`, `../boot/results/m5-step7-modes/`.

**How the dispatches went** (Alpine in Node, `bench/results/local` scripts, ad hoc): 0.18 per instruction at step 6 → 0.068 with direct links (7.1) → 0.067 with cross-page links and the larger cache → 0.025 with the jump cache for indirect branches → 0.0062 with jump-cache probes for successors compiled later. A histogram of why blocks returned (ad hoc instrumentation, reverted) drove each slice: after 7.1, Buildroot's 2.8M dispatches were RET 28%, successors in another page or not yet compiled 43%, system-instruction ends 16%; after the jump cache, failed probes were almost all misses of blocks compiled after their predecessor, which the static probes then took.

**The two modes (steps 4–6) are explained.** V8 reuses a module's compiled code when a module with the same bytes is still alive, and a deterministic boot emits the same JIT modules every time (and loads the same core), so a boot ran in the fast mode when the previous boot's modules hadn't been collected yet. Without a GC before each boot, Buildroot's samples split 700 / 920 ms (default tiering) and 630 / 2975 ms (TurboFan-only: every module compiled eagerly, or reused); a per-VM nonce appended to each module removes the fast mode; disabling speculative `call_indirect` inlining and deopts changes nothing (`../boot/results/m5-step7-modes/`). `bench/run.ts` now passes `--expose-gc` and the boot suite collects before every timed boot, so the numbers are a first boot's. The user-mode guests' mid-run switches are gone with the dispatcher's `call_indirect` off the hot path.

**Notes**
- **Relinking was tried and dropped:** recompiling a block once a successor it returned through got compiled doubled Alpine's compiled blocks and its cache flushes (30) for 9% fewer dispatches. The jump-cache probe gets the same links without compiling anything, and needs no bookkeeping: the jump cache only ever holds compiled blocks, and invalidation clears it. Direct links are recorded, and dropping a block drops the blocks linked to it, transitively (`tests/jit.test.ts`).
- **The code cache size mattered more than any link:** at 16,384 blocks Alpine flushed 14 times and recompiled 244k blocks; at 65,536 it compiles 56,791 once (Node: 32.4 → 24.8 s).
- **Buildroot doesn't gain:** its boot is short and cold (15.6% of its steps interpreted, 12k blocks compiled for 41M steps), so compiling and Liftoff code dominate, not dispatch.
- **Two bugs in 7.2/7.3 only cost chaining,** so no correctness test could see them: the cross-page guard compared against the page's host address instead of the target's, and the jump-cache index was computed wrongly. The dispatch histogram found both; a call-and-return loop test now pins the indirect lookup.
- **Open (M9):** the jump-cache probes cost the integer guest 12% under default tiering (1258 vs 1430 MIPS without them) though they run once per ~5,000 instructions, and the same build does 1481 under TurboFan-only; flags for inlining, deopts and the tier-up budget change nothing, and moving the probes out of line made the EL1 guest erratic. The remaining Alpine dispatches are mostly instruction-TLB refills after whole-TLB flushes (41,665 per boot: no ASIDs, M9).

## M5 step 8: regions

**Host change.** From step 8 on, numbers come from the Lima VM `dev` on the M4 Mac mini (openSUSE Tumbleweed aarch64, 8 vCPUs, Chromium 153.0.8010.52 headless), not the x86_64 desktop: none of the step 2–7 numbers above compare with them. The step 7 commit `70e323d` is re-measured there as the baseline (a worktree build, with simd128 as it was then).

### 8.1–8.2 measured (regions as the head's loop)

**What runs:** step 7 plus regions (8.1: one function per region, members as nested wasm `block`s, registers kept across internal edges; 8.2: members only the seen blocks of the head's loop, back-edges a wasm `loop` under the budget check). **Method:** `bench/run.ts`, default config, one full `bench/interp` run and `boot_jit` / `boot_alpine_jit` for each build; Buildroot again for the tier split and the experiments; Alpine also in Node (`bench/results/local` scripts, single runs, for profiles).

| Guest (MIPS) | Step 7 (IQR) | 8.2 (IQR) | 8.2 / step 7 | Blocks per region, back-edges (static) |
|---|---|---|---|---|
| interpreter, integer | 138.6 (±1.85) | 138.8 (±1.49) | 0% | |
| integer, EL0 | 1184.5 (±4.6) | **2607.6** (±15.2) | **2.20×** | 2.15, 20 |
| FP/NEON, EL0 | 20.3 (±0.10) | 20.4 (±0.16) | +1% | 1.43, 18 |
| integer, EL1 MMU off | 1105.9 (±10.7) | **1942.7** (±16.9) | **1.76×** | 1.37, 24 |
| integer, EL1 MMU on | 1072.4 (±4.6) | **1736.1** (±19.1) | **1.62×** | 1.37, 24 |

| Boot (Chromium, deterministic, warm; cold) | Step 7 | 8.2 | Compiled, step 7 → 8.2 |
|---|---|---|---|
| Buildroot, to power-off | **655 ms** (±8), rerun 677 (±7); cold 685 | 746 ms (±5), rerun 767 (±6); cold 805 | 12,430 blocks, 5.0 MB → 12,225 regions of 16,970 blocks (1,212 back-edges), 6.8 MB |
| Alpine, to power-off | **17.54 s** (±0.15); cold 17.99 | 18.23 s (±0.19); cold 17.85 | 56,791 blocks, 23.9 MB → 56,137 regions of 69,166 blocks (3,620 back-edges), 28.5 MB |

Dispatches per instruction don't move (Buildroot 0.0075 → 0.0072, Alpine 0.0062). Between runs of the same build the Buildroot medians moved ~3% (655 vs 677), more than their IQRs.

**Buildroot by V8 tier** (warm total, ms): default 655 / 746 / 678, Liftoff-only 1012 / 1054 / 950, TurboFan-only 2147 / 2845 / 2221 for step 7 / 8.2 / 8.2 with regions cut to the head (self-loops still wasm loops). Regions cost ~10% in both tiers and +28% where everything is compiled by TurboFan; without them 8.2 is step 7 within noise.

**Where the boots lose** (Node `--cpu-prof`, self time, step 7 → 8.2):
- Buildroot: JIT code 99 → 92 ms (regions do save execution), but the dispatcher (`jit::steps`, which V8's lazy compilation of JIT functions is charged to) 206 → 245 ms, and our own emission ~+45 ms (`emit_region` runs twice per region, up to six times for a loop, with allocations; `block::next` recomputed per query). 930 of the 12,227 regions are loops, 6.1 blocks each: their members, mostly also compiled on their own, are the +4,750 block copies.
- Alpine (Node: 17.0 s step 7 and 8.2 without regions, 17.7 s 8.2): JIT code 8.28 → 8.62 s, dispatcher +0.20 s, emission ~+0.15 s. By tier (Node, one run each): Liftoff-only 25.6 → **23.6 s**, TurboFan-only 20.4 → 23.1 s; with V8's tier-up budget lowered to 2M (diagnostic only) 16.6 → **16.1 s**, raised to 60M 17.4 → 17.3 s. Region code is faster once compiled; the loss is compiling more and bigger code, and when it reaches TurboFan.
- **Deferring loop regions** to 500 dispatches of the head (the head interpreted until then): Buildroot 705 ms (8.2: 746), Alpine 18.23 s (±0.92; no gain); 5,000: Buildroot 728 ms (interpreting the heads costs more). Not kept (`../boot/results/m5-step8/loop-wait.diff`).

**simd128** (off since 8.2, PLAN M9): the interpreter doesn't notice it: 138.1 (±2.2) integer, 19.7 FP, 142.9 EL1 MMU off, 84.2 MMU on with `+simd128`, against 138.5–138.8, 19.6–19.7, 140.5–142.4, 84.7–85.3 without (two runs).

Raw data: `results/m5-step8/chromium-linux-arm64-{step7,step8.2,step8.2-r2,step8.2-simd128}.json`, `../boot/results/m5-step8/`.

### 8.3: tier-up to loop regions

**What runs:** a head whose region is a loop is compiled alone first, with a hot word counting its entries down from 1000 (`jit::Config::region_after`); the entry that reaches 0 calls `jit_hot`, which compiles the loop region at once and points the head at it (its prologue then tail-calls the region through the table). A region's members that are candidate heads stop counting, except inner loops' heads (PLAN §2 "ABI 17"). **Method:** as 8.2; `region_after` picked in Node (Buildroot 640 / 607 / 620 ms and Alpine within noise at 100 / 1000 / 10,000).

| | Step 7 | 8.2 | **8.3** |
|---|---|---|---|
| integer guest, EL0 (MIPS) | 1184.5 | 2607.6 | **2672.0** |
| EL1 MMU off / on (MIPS) | 1105.9 / 1072.4 | 1942.7 / 1736.1 | **1878.8 / 1724.9** |
| Buildroot, warm (cold) | 655 / 677 ms (685) | 746 / 767 ms (805) | **694 ms** (±6; cold 724) |
| Alpine, warm (cold) | 17.54 s (17.99) | 18.23 s (17.85) | **17.81 s** (±0.30; cold 17.76) |
| Buildroot compiled | 12,430 blocks, 5.0 MB | 16,970 blocks in 12,225 regions, 6.8 MB | 12,777 blocks in 12,494 functions, 69 tier-ups, 5.3 MB |
| Alpine compiled | 56,791 blocks, 23.9 MB | 69,166 in 56,137, 28.5 MB | 59,540 in 57,292, 566 tier-ups, 25.3 MB |

The first version silenced every member that was a candidate head, which left nested loops' inner loops without a region (the integer guest ran at 1637 MIPS: `results/m5-step8/chromium-linux-arm64-step8.3-silenced-inner-heads.json`); `block::Region::inner_free` keeps inner loops' heads counting. **Validation:** the corpus through the JIT (forced: regions at once; stress: tier-up on the second entry, which found that a tier-up must never flush the cache, since JIT code is running: the stale-code checker tripped in kvm-unit-tests `cache`), `tests/jit-diff.test.ts`, a tier-up test in `tests/jit.test.ts`, the Node boots with exact steps. Buildroot is still ~3–6% behind step 7 (694 vs 655–677 ms), Alpine even within noise; the steady-state guests keep regions' gain.

Raw data: `results/m5-step8/chromium-linux-arm64-step8.3*.json`, `../boot/results/m5-step8/chromium-linux-arm64-step8.3-*.json`.

### 8.4: flags across region edges

**What runs:** each region member starts with its flags lazy (every edge into it carries the same setter: conditions come from its operands, `cmp; b` → `b.lt` is `i64.lt_s` across the edge), in memory, or dead (a setter comes before anything reads them, a helper or a possible exit: `emit::Func::touched`); an edge stores NZCV only into a member that needs it in memory, and a block skips the store before its branch when every successor is such a member (exits store it on their way out). The head's flags are never lazy (the function starts from memory), but a head that sets flags first takes its back-edges without a store.

| Guest (MIPS) | 8.3 default | **8.4 default** | 8.3 / 8.4 Liftoff only | 8.3 / 8.4 TurboFan only |
|---|---|---|---|---|
| integer, EL0 | 2672.0 (±12) | **3279.2** (±17), **+23%** | 1639 / **1898** (+16%) | 2683 / **1802** (−33%) |
| EL1 MMU off | 1878.8 | **1944.7** (+3.5%) | 1225 / 1324 | — / 1969 |
| EL1 MMU on | 1724.9 | **1749.9** (+1.4%) | 1118 / 1231 | — / 1747 |

Static counts (integer guest): conditions direct 30 → 32, from memory 5 → 3. Boots unchanged within noise (they have few loop regions): Buildroot 711 ms (±8), Alpine 17.79 s (±0.12).

**TurboFan-only runs the integer guest 33% slower**, the default 23% faster, and both come from the store skipped before the branch: storing there always (lazy flags and dead flags still carried) reads 2642 default and 2674 TurboFan-only. Both tiers run TurboFan code in the loop; what differs is the feedback dynamic tiering collects in Liftoff (speculative inlining of indirect calls among others), which is also where step 7's jump-cache probe cost showed up. Default tiering is the product configuration (M5 decision), so the skip stays; the TurboFan-only drop is in PLAN M9. **Validation:** `tests/jit-diff.test.ts` region classes fail with each planted bug (no store on any edge: 4 and 10 of 1024 programs differ; every member's flags dead: 17 / 19; lazy entry states started from memory: 9 / 4); unit test `flags_cross_region_edges_lazily`; CI.

Raw data: `results/m5-step8/chromium-linux-arm64-step8.{3,4}*.json`, `../boot/results/m5-step8/chromium-linux-arm64-step8.4-*.json`.

### 8.5: the PC stored only on the way out

**What runs:** a block whose successors are all region members doesn't store the next PC at its branch (a conditional one keeps only its outcome): the path that leaves the region when `left` doesn't cover the edge stores it before returning.

| Guest (MIPS) | 8.4 | **8.5** |
|---|---|---|
| integer, EL0: full suite | 3279.2 (±17) | **3856.8** (±30), **+18%**; one run of four in a slow mode, 1986 (±11) for all 15 samples |
| integer, EL0: alone, two runs | 3247, 3226 | **3810, 3766** (+17%) |
| integer, Liftoff only | 1898 | **2231** (+18%) |
| EL1 MMU off / on | 1944.7 / 1749.9 | **2148.2 / 1913.4** (+10% / +9%) |

Boots: Buildroot 725 ms (±18), Alpine 18.17 s (±0.30), against 8.4's 711 and 17.79 (+2%, within the runs' spread; they have few loop regions). The slow mode is decided when the hot code tiers up (the same run gives the same number throughout), like step 4–6's modes and 8.4's TurboFan-only drop; Node runs the same guest at 3656–3819 every time. **Validation:** a planted bug (the exit's PC store dropped) fails the differential test's region classes (228 and 93 of 1024 programs); unit test `flags_cross_region_edges_lazily` checks no PC store before the edge.

Raw data: `results/m5-step8/chromium-linux-arm64-step8.{4,5}*.json`, `../boot/results/m5-step8/chromium-linux-arm64-step8.5-*.json`.

### Step 8 summary

Regions pay where guests loop: the integer guest runs at **3857 MIPS against step 7's 1184 (3.3×)**, the EL1 guests at 2148 / 1913 (1.9× / 1.8×). The boots don't gain: Buildroot 694–725 ms against 655–677 and Alpine 17.6–18.2 s against 17.5 s. They run few hot loops, and compiling more costs them a little; the tier-up (8.3) is what kept regions from costing them 10–14%. **JIT-stress** at first built regions of every block in reach on every miss, 42× slower than step 7 (kvm-unit-tests `gic active` 522 s vs 12.5 s); from seen blocks only it takes 15.7 s, and the stress boots take Buildroot 198 s, the device test 568 s (`cache` 32 s vs step 7's 26.5 s). **Validation at the end of the step:** CI, lockstep at 300M steps per JIT case (clean), every Node boot under the JIT and JIT-stress with the interpreter's steps, Alpine under the JIT in Node and Chromium (3,009,151,562 steps). Open (PLAN M9): the TurboFan-only drop and the one-off slow mode of 8.4–8.5; compiling off the vCPU thread.

## M5 step 9: coverage and JIT-stress everywhere

**Coverage.** Every instruction the JIT meets compiles, inline or as a helper call; the only steps interpreted are ones the JIT chooses not to run. An ad hoc histogram of why the dispatcher interpreted (reverted) on Buildroot's boot in Node: with the default policy 15.28% of the steps, of which 98% are code not compiled yet (below the 50-dispatch threshold, or waiting in a batch), 1.6% chunk-end tails (a block longer than the budget left before a deadline, run step by step so interrupts land where the interpreter's would) and nothing else; compiling on first sight (threshold 0) leaves 2.49%, still pending batches and tails. Alpine interprets 1.37% of its steps (default policy).

**The threshold** (Node, Buildroot boot ms and interpreted share / Alpine boot s and share, blocks compiled):

| Threshold | Buildroot | Alpine |
|---|---|---|
| 50 (default) | 625 ms, 15.3%, 12,493 blocks | 16.3 s, 1.36%, 57,279 blocks |
| 20 | 734 ms, 10.1% | 17.3 s, 1.07%, 86,439 |
| 10 | 876 ms, 7.4% | 18.8 s, 0.95%, 121,840 |
| 5 | 971 ms, 5.6% | 18.7 s, 0.80%, 135,460 |
| 2 | 1071 ms, 3.9% | (found the bug below) |

Lower thresholds compile far more cold code and are slower everywhere, so the default stays; "≥ 99% of steps in JIT code" holds for Alpine (98.6%, of which the rest is warm-up) and for everything under compile-on-sight, and Buildroot's short, cold boot is the exception by design.

**A bug the sweep found:** a head queued for compilation whose code changed before its batch was emitted formed no blocks, and `block::region` indexed the empty list (Alpine with threshold 2). Fixed, with a unit test in `a_region_is_a_loop_with_registers_across_its_edges`.

**Under the JIT and JIT-stress, exactly the interpreter's steps and console:** the bare-metal tests, kvm-unit-tests, the Buildroot boot and device test, Alpine (JIT in Node and Chromium; JIT-stress in Node: 3,009,151,562 steps in 15,306 s), and now the LTP subset with the arm64 kselftests, which only ran natively before: `tests/boot-node.test.ts` runs them under the interpreter (52 s), the JIT (16 s) and JIT-stress (10,331 s), 2,737,414,881 steps, every test passing or skipping as `core/tests/ltp.rs` expects.

**JIT-stress speed:** regions in stress mode now take only blocks the dispatcher has seen (building them from every block in reach made the stress boots 42× slower than step 7's), and a flush clears only the jump-cache entries used since the last one (clearing all 65,536 was a fifth of a stress run's time): kvm-unit-tests `gic active` 522 s → 15.7 s → 9.4 s (step 7: 12.5 s), Buildroot 198 s → 134 s.

**How long stress runs should be:** no bug in M5 was found only by a long stress run; the short ones (kvm-unit-tests `cache` caught the tier-up flush bug in seconds), the differential test and the exact-step boots found them. The long Alpine and LTP stress runs passed on their first try. From here: the long ones once per milestone, at its end; short stress variants (tiny cache with the default threshold, compile-on-sight with a big cache, tier-up after one entry) for coverage per minute (PLAN §4).

## M5 step 10 and M5 in numbers

**CoreMark** is a benchmark guest now (`bench/interp/build-coremark.sh`: EEMBC's sources at a pinned commit, unmodified, with our port layer, `-O2`, the 2K performance run; CoreMark's own CRC validation checked on every run). **The helper-call histogram** comes from `jit_helper_report` (ABI 18) and is recorded with every JIT guest and boot.

**Method:** `bench/run.ts`, default config, one full `bench/interp` run and `boot`, `boot_jit`, `boot_alpine`, `boot_alpine_jit` at `fa98e31` (the code of `e812e2c`: the commits between them changed PLAN.md only; `dirty` in the JSON is the untracked kickoff notes), run after the stress runs had finished; this commit's stress-speed fix changes nothing outside stress mode. Host: the Lima VM `dev` on the M4 Mac mini (Linux aarch64, 8 vCPUs), Chromium 153.0.8010.52 headless; only this host (the user's call: the x86_64 desktop ranked every M0–M5 change the same way).

| Workload | Interpreter warm (IQR) | JIT warm (IQR) | JIT / interp | Cold: interp / JIT |
|---|---|---|---|---|
| integer guest, EL0 (MIPS) | 143.1 (±2.4) | **3857.3** (±14.9) | **27×** | 55.9 / 211.0 |
| FP/NEON guest, EL0 (MIPS) | 19.7 (±0.0) | 19.6 (±0.0) | 1.0× | 18.9 / 18.8 |
| integer guest, EL1 MMU off (MIPS) | 147.7 (±3.3) | **2135.6** (±26.0) | **14.5×** | 119.7 / 146.2 |
| integer guest, EL1 MMU on (MIPS) | 85.5 (±0.2) | **1918.5** (±20.6) | **22×** | 58.1 / 187.7 |
| CoreMark (iterations/s) | 528.1 (±2.1) | **5955** (±219) | **11.3×** | 400 / 606 |
| Buildroot boot, to power-off | 722 ms (±5) | 717 ms (±7) | 1.0× | 749 / 744 ms |
| Alpine boot, to power-off | 46.9 s (±0.31) | **18.4 s** (±0.10) | **2.55×** | 46.5 / 18.5 s |
| Alpine boot, to its script | 39.4 s | **15.3 s** | 2.57× | |

**CoreMark against references** on the same host with the same sources and flags (`target/bench/coremark-linux`, raw syscalls, CoreMark timing itself for a valid run): native 55,000 iterations/s, QEMU 11.1.1 TCG user mode (`qemu-aarch64`) 11,764. The JIT runs it at **51% of QEMU's TCG** (1.98× slower) and 10.8% of native; one iteration is 244,595 guest instructions.

**JIT counters:** Buildroot 84.7% of steps in JIT code (the rest is warm-up, above), 97.0% of those inline, 12,494 functions (69 loop tier-ups), 5.3 MB, 0.0073 dispatches per instruction; Alpine 98.6% in JIT code, 96.8% inline, 57,292 functions, 25.4 MB, 0.78 s in `new WebAssembly.Module`, 0.0062 dispatches per instruction.

**Where the helper calls are** (the input to M6):
- Buildroot: `MRS` 200,780, `LDXR` 141,697, `DC ZVA` 122,046, `STXR` 112,393, `DMB` 101,998, `STLXR` 88,472, `LDAXR` 59,024, `STLR` 41,083, `IC IVAU` 31,168, then `STTR`/`LDTR`-class and `MSR`.
- Alpine: `MRS` 27.1M, NEON integer (`USHR` 9.6M, `EOR` 7.5M, `SLI` 6.4M, `ADD` 5.7M, `EXT` 2.1M: the kernel's ChaCha/crypto code), `DC ZVA` 7.7M, `DMB` 3.3M, `LDADD` 2.2M, `CAS` 1.8M, `LD1`/`ST1` multiple 1.8M/1.4M, `STLR` 1.4M.
- FP guest: `FMLA` (by element) 42.8M, FP/SIMD loads and stores (`LDR` register 37.6M, `LDP`/`STP` 29.1M), `FMADD` 20.0M, `FMOV`, `SCVTF`.
- CoreMark: FP/SIMD loads and stores and integer NEON (the autovectorized matrix code: `ADD`, `MOVI`, `SMLAL`, `SMULL`, `ADDV`).

**What's inline** (`emit::inline`, `emit::ldst`): moves, ADR/ADRP, every add/sub form (with flags), ADC/SBC, logical, bitfield moves and extends, EXTR, shifts, CSEL/CSINC/CSINV/CSNEG, CCMP/CCMN, multiplies (including long and high), divides, REV/RBIT/CLZ/CLS, the NOP-class hints, every branch, and every integer load and store (all sizes and signs, unsigned offset, unscaled, pre/post-index, register offset, pairs, literal, PRFM) through the TLB or the flat RAM check. **Helpers:** everything FP and SIMD (loads and stores included), system instructions (MRS/MSR, barriers, cache maintenance, SYS), exclusives, LSE atomics, LDTR/STTR, exception-generating instructions.

Raw data: `results/m5-step10/chromium-linux-arm64-m5.json`, `../boot/results/m5-step10/chromium-linux-arm64-m5-{boot,boot_jit,boot_alpine,boot_alpine_jit}.json`.

## M6 loop 0: V8 on our code, and the placement effect

**Host:** the Lima VM `dev` on the M4 Mac mini (Linux aarch64, 8 vCPUs; the host otherwise idle), Chromium 153.0.8010.52 headless; Node 26.7 (V8 14.6) where it says so. Raw data: `results/m6-loop0/`, `../boot/results/m6-loop0/`. The rules that came out of it are in PLAN.md §2 "V8 and our code". V8's code for a JIT function: `node tools/v8code.ts` (Node; openSUSE's Chromium has no disassembler, and `--perf-prof` with `perf` gives Chromium's code as annotated profiles).

**Tiering (integer guest, Chromium, at `80e7bda`):** default 3660–3756 MIPS over 12 runs, TurboFan-only 3806 and 3835; the default's first ~4 samples (~20 ms) are ~10% slower while hot code tiers up, which is its wider IQR. At step 8.4's own commit: default 3157, TurboFan-only 3218–3249 over 8 runs, so 8.4's "TurboFan-only 1802" and 8.5's one-in-four 1986 don't reproduce (both about half speed for a whole run; the host was shared then). FP guest: default 19.2, TurboFan-only 26.1 (+36%); `perf` in Node puts 14% of the default's time in calls to compiler-rt's `__lshrti3`/`__ashlti3` from `fp.rs`, which TurboFan-only inlines.

**Bounds checks (integer guest, Chromium):** default 3740 MIPS, `--wasm-enforce-bounds-checks` 3469, `--no-wasm-bounds-checks` 4739 (diagnostic only). A store loop (`st.wat`, `st-chrome.mjs`) runs at 1.025 / 1.030 / 0.540 ns per iteration with default / enforced / no checks in Chromium, 1.022 / – / 0.501 in Node: no trap handler on this host.

**The `Cpu` through a constant address (committed as `78e2086`, reverted):**

| Chromium, one placement | `80e7bda` (parameter base) | `78e2086` (heap address as a constant) |
|---|---|---|
| integer guest | 3740 | 3972 (+6%) |
| EL1 MMU off / on | 2149 / 1911 | 2087 / **1687** (−3% / −12%) |
| CoreMark (it/s) | 5919 | **5545** (−6%) |
| Buildroot / Alpine boot (JIT) | M5: 717 ms / 18.4 s | 690 ms / 17.33 s |

The hot region's machine code halved (52 KB → 26 KB) and its checks went, but each access now materializes a 32-bit constant (`movz`/`movk`), and the EL1 and CoreMark code spilled more. A **low slot** (the first `Vcpu` below `--global-base`, the stack moved after static data, so the `Cpu` is below 32 KiB: one `str x, [membase, #imm]` per access) made the integer guest 4200 MIPS in Node but **2500 in Chromium, with either code shape** (`low-*`, `low64k*`: at 4096 and 64 KiB, with and without bounds checks, TurboFan-only), and 3802 with the same flags and the `Vcpu` back on the heap (`nolow-layout`). That led to:

**The placement effect.** `node-vcpu-placement-sweep.txt`: 15 `Vcpu` addresses from 4 to 27 KiB × both code shapes × four guests, in Node. The integer guest is bimodal under both shapes (constant: 2500 or 4170–4270; parameter: 2458–2535 or 3680–3790), CoreMark likewise (~1200 or ~1500), and the EL1 guests aren't (±4%). With the parameter base the JIT code is byte-identical at every address, and with the `Vcpu` fixed a sub-page offset of guest RAM flips the integer guest the same way (pad 0 and 1 KiB: 3778, 3757; 2, 3, 4 KiB: ~2530; 8 KiB: 3683; 16 and 32 KiB: ~2535), so it's where guest data falls relative to the core's, a hardware aliasing effect (no PMU in the VM to name the unit). Placement-averaged, the constant base against the parameter base: integer 3547 vs 3332 (+6.5%), CoreMark 1393 vs 1339 (+4%), EL1 MMU off 2109 vs 2122, **MMU on 1797 vs 1865 (−3.6%)**; not kept (PLAN §2).

**Benchmarks from here:** the small guests run at eight fixed guest-RAM offsets within a page (`PADS` in `suite.ts`), each on a fresh core, one median per placement as the samples (every sample in `params.placements`). At `80e7bda`'s code, two runs each in Chromium: integer 3733 (±52) and 3742 (±29) MIPS, CoreMark 5550 (±82) and 5642 (±51) iterations/s (`p1-*`, `p2-*`); no placement split in Chromium at these offsets for this build, where Node splits.

## M6 baseline and loop 1: system instructions inline

**M6 baseline** (`131daff`, M5's JIT with loop 0's placement-averaged small guests; `results/m6-baseline/`, `../boot/results/m6-baseline/`): integer guest 3735 MIPS (±18), FP 19.5, EL1 MMU off / on 2166 / 1895, CoreMark 5636 iterations/s (±201), interpreter 137.6 / 19.7; Buildroot under the JIT 711 ms (±9), **Alpine 18.31 s** (±0.01; 15.24 s to its script).

**What runs** (PLAN.md §2 "JIT ABI", M6 loop 1): Alpine's 27.06M MRS helper calls were SP_EL0 (Linux's `current`: 19.21M), TPIDR_EL1 (5.38M), DAIF (0.73M), DCZID_EL0, CNTVCT_EL0 (0.40M) and a tail of EL1 registers (an ad hoc count by register, not kept). 1.1: `interp::sys::plain` gives the reads the JIT does inline at the block's EL (a `Cpu` field, a constant, pstate bits, NZCV made current, SP_EL0 behind an SPSel guard, DCZID_EL0 at EL0 from SCTLR_EL1.DZE), checked against the interpreter's `read` over random state; the timers, ISR_EL1 and traps stay helper calls that return from the block mid-way, as MMIO loads do. MRS and DMB/DSB/SSBB/PSSBB (no-ops for one vCPU) no longer end a block. 1.2: LDAR/STLR (all sizes) as wasm atomic loads/stores behind the natural-alignment check, DC ZVA as eight i64 stores of 0 at Xt & ~63 behind SCTLR_EL1.DZE at EL0, both on the load/store fast path; DC ZVA no longer ends a block.

| Chromium, deterministic, warm | M6 baseline | 1.1 | **1.2** |
|---|---|---|---|
| Alpine to power-off | 18.31 s (±0.01) | 17.74 s (±0.13) | **16.76 s** (±0.05), −8.5% |
| Alpine to its script | 15.24 s | 14.79 s | **13.97 s** |
| Buildroot to power-off | 711 ms (±9) | 688 ms (±8) | 711 ms (±7) |
| Alpine: functions, compile | 57,292, 784 ms | 54,226, 788 ms | 54,216, 774 ms |
| Alpine: helper calls (steps retired by helpers) | 94.4M | 64.4M | **54.6M** |

Steps unchanged (Alpine 3,009,151,562, Buildroot 40,909,861); dispatches per instruction unchanged (0.0062); inline share of JIT steps 96.8% → 98.2%. EL1 guests unchanged (1.1: 2145 / 1894 MIPS). Alpine's helper calls now: NEON integer (USHR 9.58M, EOR 7.46M, SLI 6.41M, ADD 5.69M, EXT 2.13M), LSE atomics (LDADD 2.23M, CAS 1.85M), MSR (1.91M + 1.37M), LD1/ST1 multiple (1.78M, 1.42M), STRx fallbacks (1.24M: TLB misses and MMIO), STTR/LDTR (2.1M), FP/SIMD loads and stores. **MSR** (not done): MSR DAIF 0.90M, DAIFSet 1.23M, DAIFClr 0.15M, SP_EL0 0.37M, SPSR/ELR 0.21M each; at MRS's ~13 ns per call saved that's ~0.1 s, so it waits (PLAN M9).

**Validation:** unit tests for each shape (`system_register_reads`, `acquire_release_and_dc_zva`, `plain_matches_read`, `jit_diff_offsets`); new differential classes: system registers and barriers (MRS of the inline registers and helper-call neighbours, barriers, DC ZVA, at EL0, EL1t and EL1h with random system registers and SCTLR trap bits), load-acquire/store-release, DC ZVA; planted bugs caught: SP_EL0 unguarded (89 of 4096 words), TPIDR_EL1 at a wrong offset (64), NZCV read without committing lazy flags (110 of 1024 sequences), LDAR/STLR without the alignment check (a wasm alignment trap), DC ZVA unmasked (195), DC ZVA without the DZE guard (280); CI (the Node boots with exact steps); lockstep at 300M steps per case, clean in all eight (JIT and JIT-stress; user mode, EL1 MMU off and on).

Raw data: `results/m6-loop1/`, `../boot/results/m6-loop1/chromium-linux-arm64-1.{1,2}-*.json`.

## M6 loop 2: SIMD&FP loads and stores inline

**What runs:** LDR/STR/LDUR/STUR (unsigned offset, unscaled, pre/post-index, register offset), LDP/STP/LDNP/STNP and LDR (literal) of B/H/S/D/Q registers take the load/store fast path, with the V registers read and written in the `Cpu`: `v128.load`/`v128.store` for Q, `v128.load32_zero`/`load64_zero` for S/D loads (which zero the rest of the register), i64 loads and narrow stores otherwise; behind CPACR_EL1.FPEN (11 at EL0, x1 at EL1) and, for an SP base, SP's alignment (`access` now takes a list of guards). Structure loads and stores (LD1/ST1 & co) stay helper calls.

| Chromium (small guests: eight placements) | Loop 1 (`0e3fc15`, where measured) | **Loop 2** |
|---|---|---|
| FP guest (MIPS) | 19.5 (baseline) | **21.6** (±0.07), +11% |
| CoreMark (iterations/s) | 5636 (baseline) | **6288** (±38), +11.6% |
| integer, EL1 MMU off / on | 3735, 2166 / 1895 (baseline) | 3745, 2170 / 1918 |
| Alpine / Buildroot boot | 16.76 s / 711 ms | 16.58 s (±0.08) / 686 ms (±7) |

**Where they stand:** CoreMark retires 99.73% of its steps inline (its helper calls: `ADD` 0.12M, `MOVI` 0.10M, `SMLAL`/`SMULL`/`SUB` 0.05M each per window), yet runs at 1544 MIPS against the integer guest's 3745: what's left of its gap to QEMU is in the inline code and the linking, not in helpers. The FP guest is 54.7% inline: `FMLA` (by element) 19.1M, `FMADD` 9.0M, `FMOV` 4.8M, `SCVTF` 4.8M, `MOVI` 3.7M, `FMUL` 2.6M per window.

**Validation:** unit test `simd_fp_loads_and_stores`; four SIMD&FP differential classes (random V registers) and SIMD&FP accesses in the system-register class (random CPACR_EL1); planted bugs caught: FPEN guard dropped (148 of 4096 words), an S load not zeroing the rest (148), the pair's second register at the first's address (2878), a Q store of 8 bytes (a trap). The new classes needed two harness fixes: the probe that finds allocated words ran them on the interpreter's vCPU and left SIMD&FP literal loads' V registers changed (sequences don't reset V), and the system-register class didn't restore code that DC ZVA zeroed; both mismatches were the harness's, not the JIT's.

Raw data: `results/m6-loop2/`, `../boot/results/m6-loop2/`.

## M6 loop 4: integer NEON and SIMD&FP moves as SIMD128

**What runs** (`core/src/jit/emit/simd.rs`, mirroring `interp::simd` and `interp::simd_int` handler by handler): 4.1 three-same ADD/SUB, the logical group (AND…BIF as `v128.bitselect`), CMEQ/CMTST/CMGT/CMGE/CMHI/CMHS (unsigned compares by flipping sign bits: wasm has no unsigned 64-bit compare), MUL/MLA/MLS (16/32-bit), S/UMAX, S/UMIN; SSHR/USHR/SSRA/USRA/SHL/SLI/SRI (a shift by the lane width special-cased: wasm takes it modulo the width); REV16/32/64, NOT, NEG, ABS, CNT, XTN(2); EXT; DUP/INS/UMOV/SMOV; MOVI/MVNI/ORR/BIC/FMOV (vector immediate, expanded at compile time with the interpreter's function); FMOV general/register/immediate. 4.2 ADDL/ADDW/SUBL/SUBW, MULL (`extmul`), MLAL/MLSL with the 2 forms; ADDV, S/UMAXV, S/UMINV, S/UADDLV (shuffle trees in a v128 scratch local); S/UADDLP, S/UADALP; S/USHLL, SHRN; UQXTN (setting FPSR.QC); TBL/TBX (`i8x16.swizzle`, which gives 0 past index 15 as TBL does). Operands and results stay in the `Cpu`'s V registers; Q=0 clears the top half. SIMD&FP instructions check CPACR_EL1.FPEN once per block, before the first inline one (nothing within a block can change it), which replaced loop 2's per-access guard. Scalar forms, saturating arithmetic other than UQXTN, rounding shifts, polynomial multiply and the rest stay helper calls.

| Chromium (small guests: eight placements) | Loop 2 | 4.1 | **4.2** |
|---|---|---|---|
| CoreMark (iterations/s) | 6288 (±38) | 7068 (±195) | **7934** (±27), +26% |
| FP guest (MIPS) | 21.6 | 24.2 | **28.7** (±0.1), +33% |
| Alpine to power-off | 16.58 s | **14.86 s** (±0.09) | 14.83 s (±0.02) |
| Buildroot to power-off | 686 ms | 712 ms | 687 ms |
| integer, EL1 MMU off / on | 3745, 2170 / 1918 | 3687, 2124 / 1885 | 3687, 2155 / 1897 |

Alpine's NEON helper calls (the kernel's ChaCha: USHR, EOR, SLI, ADD, EXT, 31M a boot) are gone: 1.72 s of its boot. CoreMark now retires every step inline; the FP guest's helpers are FP arithmetic (FMLA by element 19.1M, FMADD 9.0M, SCVTF 4.8M, FMUL, FADD, FMLA vector, FNMUL, FSUB, FCVTZS per window): loops 5–6.

**Alpine, where the time goes now** (`perf` with `--perf-prof` in Node, whole boot at 4.1): JIT code 43.9% of samples, **more than half of it in Liftoff code** (23.4 points against 20.5 in TurboFan), spread thin (3207 functions with samples; the top 1000 hold half of the JIT time): the boot is a long tail of lukewarm code that dynamic tiering never promotes. V8's own work: background TurboFan 12.9%, main-thread native ~14% (lazy Liftoff compiles, `CallIndirectIC`, module creation: `new WebAssembly.Module` 0.58 s), the interpreter and helpers (`interp::exec`) 7.1%, the dispatcher 2.8%, the JIT cache's misses and the MMU's fetch/walk ~2%. Helper calls retire 16.9M of 3.0G steps (LSE atomics ~5.5M, MSR 3.3M, LD1/ST1 multiple 3.2M, STTR/LDTR 2.1M). The input to loop 8 (compiling off the vCPU thread) and the tuning loop.

**Validation:** unit test `advsimd_integer`; differential classes for every AdvSIMD encoding group (three same, three different, shift by immediate and modified immediate, two-register miscellaneous, across lanes, copy, extract, table lookup; FP/general moves) with random V registers, and NEON in the system-register class (random CPACR); the golden corpus through the JIT; planted bugs caught: USHR by the lane width (16 of 4096 words), BIT's operand order (10), DUP's lane (166), the FP check skipped (226), Q=0 keeping the top half (348), a short reduction (228), extmul's halves swapped (490), TBL's register offsets (2876), UQXTN not setting QC (31, after the harness fix below). Harness fix: each run now starts the JIT's vCPU from a full copy of the interpreter's, FPSR cleared or QC only; QC is sticky, and a helper's saturation earlier in a class had hidden the missing-QC bug.

Raw data: `results/m6-loop4/`, `../boot/results/m6-loop4/`.

## M6 loops 5–6: scalar and vector FP on exact fast paths

**What runs** (`core/src/jit/emit/float.rs`, the design in PLAN.md §2 "The JIT's FP fast paths"): a block's first inline FP arithmetic instruction computes the guard once into a local (FPCR.RMode is round to nearest even and FPSR.IXC is already set); each instruction then tests its operands for normal exponents and its result for an exponent above 1 (below the smallest normal binade and at infinity the result could raise Underflow or Overflow), and anything off the fast path runs the helper on untouched operands. Loop 5 (scalar): FADD/FSUB/FMUL/FDIV/FNMUL/FSQRT in S and D; FMADD/FMSUB/FNMADD/FNMSUB in S through f64, with the midpoint check (a sum exactly halfway between two singles goes to the helper), D staying a helper call (wasm has no exact f64 FMA); SCVTF/UCVTF from and FCVTZS/FCVTZU to general registers; FABS/FNEG as bit operations. Loop 6 (vector, lane by lane): FADD/FSUB/FMUL/FDIV in 4S, 2S and 2D and FMUL by element; FMLA/FMLS vector and by element in single precision (each half through `f64x2`, the midpoint check per lane; 2D stays a helper call); SCVTF/UCVTF and FCVTZS/FCVTZU on 32-bit lanes; FCVTL/FCVTN; FABS/FNEG. 6.1 (after the loop's numbers below): loop 6's SCVTF/UCVTF arm matched the *scalar* encoding (`SCVTF_int_2`, the integer in a SIMD&FP register) where the vector one is `SCVTF_int_4`, and returned early on it (bit 28), so neither form was inline; now the vector arm takes `_int_4` and the scalar form is inline too (S from a 32-bit integer, D from a 64-bit one), with a differential class for the scalar two-register FP group (planted bug: the scalar form without the guard, 100 of 4096 words). Lane masks for normal operands and fast results are reduced with `all_true` and ANDed with the guard: any lane off the fast path sends the instruction to the helper.

| Chromium (small guests: eight placements) | Loop 4.2 | 5 | **6** (`55defe0`) |
|---|---|---|---|
| FP guest (MIPS) | 28.7 | 31.1 (±0.3) | 139.2 (±0.8); **6.1: 152.9** (±0.8), 7.8× M5's 19.6 |
| FP guest: steps retired inline | 54.7% (loop 2) | 78.2% | 90.8%; 6.1: **93.7%** |
| CoreMark (iterations/s) | 7934 | – | 7899 (±53) |
| integer, EL1 MMU off / on | 3687, 2155 / 1897 | – | 3751, 2169 / 1895 |
| Buildroot to power-off | 687 ms | – | 689 ms (±13) |

Loop 5 alone moved the FP guest little: its hot loop is the auto-vectorized single-precision matrix multiply, whose `FMLA` by element (19.1M calls per window) is loop 6's. The FP target (≥ 5× M5, ≥ 98 MIPS) is met. **Helpers left** per window: `FMADD` double 6.35M (a helper by design), `FMLA` vector 2.17M and by element 1.36M (the 2D forms of the n-body code), all f64 fused multiply-adds; loop 6's `SCVTF` 4.78M was the scalar form of 6.1.

**Alpine, the loop 6 "regression":** loop 6's first three Alpine runs read 15.90, 16.43 and 16.41 s against loop 4.2's 14.83 s, with identical JIT counters (steps, functions, bytes, inline and helper counts, dispatches). Re-measured alternately later the same day: loop 4 (`c516185`) 15.14 and 15.41 s, loop 6 (`55defe0`) 14.93 and 15.07 s, with wider IQRs (±0.4–0.6 s) than earlier in the day: the host, not the code (loop 0 saw the M4's clock state move a run by ~8%). Alpine barely runs FP. **Rule kept:** compare boots only against a build measured in the same session.

**Validation:** unit tests for the scalar and vector shapes; differential classes for FP data processing with one, two and three sources, FP three-same, by element, two-register miscellaneous and conversions, seeded with zeros, infinities, NaNs, denormals and extreme normals, with random FPCR (RMode, FZ, DN) and FPSR.IXC; directed "FP edge cases" (a product rounding up into the smallest binade, f32 FMAs whose f64 sum lands on a midpoint in every lane, the FCVTZS/FCVTZU range limits) under four FPCR states with IXC set and clear. Planted bugs caught, loop 5: no IXC test (233 of 4096 words), no RMode test (215), an operand unchecked (17), the smallest binade allowed, no midpoint check, FCVTZS's bound inclusive (the last three by the directed cases only); loop 6: no midpoint check, lanes 2–3 of Q=1 unchecked (34), no result check (21), FCVTN's result unchecked (13). Lockstep at 300M steps per case after loop 6: clean in all eight (JIT and JIT-stress; the integer and FP/NEON guests in user mode, EL1 MMU off and on). **Harness fix (6.1):** the sequence and region classes copied only X, PC and NZCV into the JIT's vCPU, so a run skipped because it rewrote its code could leave V different for every later run; the new class shifted the seed onto such a run (1 skipped, then 271 of 1024 sequences "differing" in V3). They now start from a full `Cpu` copy, as the single-word classes have since loop 4.

Raw data: `results/m6-loop5/`, `results/m6-loop6/`, `../boot/results/m6-loop6/` (the recheck runs in `recheck/`).

## M6 loop 11: branch hints, so TurboFan spills on the slow paths

**Why** (`perf` with `--perf-prof` in Node, CoreMark): nearly all of CoreMark's time is TurboFan code of our regions, and the hot loops spent it on stack spills at the loop head and on bounds checks, not on the guest's work. V8's wasm code has no callee-saved registers, so every value live across a call is spilled, and TurboFan spills at the definition when *any* path calls: here the slow paths of loads and stores (a TLB miss, MMIO, a misaligned access) and the helper-call exits, which almost never run. TurboFan moves spills into *deferred* blocks when it knows a branch is unlikely, and wasm can say so: the branch-hinting custom section (`metadata.code.branch_hint`, on by default in V8 14.6 and Chromium 153). A micro-benchmark (a loop with two cold calls) ran 12% faster with the two `if`s hinted.

**What runs:** `wasm::Code::hint` records an `if`'s offset and whether it's likely; `Module` writes the section before the code section (offsets from the function body's start, its locals included; rewinding code drops its hints). Hinted likely: the load/store fast path, the scalar and vector FP fast paths, SP_EL0's SPSel check, jump-cache hits and the `left` checks of region edges and chains; unlikely: a helper that didn't retire (the block returns), the FPEN check's trap, division by zero and INT_MIN / −1. Also (measured separately, neutral): a conditional branch with one side in the region defers its PC store to the paths that leave, as when both sides are members, so a loop's conditional back-edge no longer stores the PC every iteration.

| Chromium (small guests: eight placements), same session | base (`2a54962`) | deferred PC only | hints only | **both** |
|---|---|---|---|---|
| integer guest (MIPS) | 3683 (±15) | 3393 | 3906 | **4020** (±28), +9.1% |
| EL1 MMU off / on | 2129 / 1886 | 2091 / 1899 | 3784 / 2965 | **3887 / 3028**, +83% / +61% |
| CoreMark (iterations/s) | 7753 (±83) | 7615 | 7788 | **8285** (±162), +6.9% |
| FP guest (MIPS) | 152.6 | 150.0 | 151.8 | 152.7 |
| interpreter (MIPS; untouched: the host's state) | 141.6 | 133.3 | 130.8 | 141.2 |
| Buildroot to power-off (JIT) | 729 ms | – | – | 733 ms |
| Alpine to power-off (JIT), two runs each, alternated | 15.80, 15.83 s | – | – | 15.76, 14.92 s |

The base and "both" runs saw the same host (interpreter 141.6 vs 141.2 MIPS); the two single-change runs came during slower host states (interpreter −6 to −8%), so their columns only show that the hints carry the gain and the deferred PC store adds nothing measurable. The EL1 guests gain most: their loops have more slow paths (TLB lookups with the MMU on, the MMU-off RAM check) whose calls spilled the hot path. Alpine and Buildroot don't move beyond the host's noise: most of Alpine's JIT time is Liftoff code (loop 4's profile), which hints don't change. Steps unchanged (Alpine 3,009,151,562); code +5% (25.7 → 27.0 MB, the sections), compile +3%.

**Validation:** unit tests `wasm::branch_hints` (the section's bytes, a rewound hint dropped) and `two_instruction_block_bytes` (a hinted helper exit at its offset); the differential test, the corpus through the JIT and 20M-step lockstep; exact steps in every boot (CI). Hints don't change semantics (V8 treats a wrong hint as a slow path, not a wrong one), so no planted bugs apply.

Raw data: `results/m6-loop11/`, `../boot/results/m6-loop11/`.

## M6 loop 10.1: fewer, larger modules; flags stored on the way out

**Why:** Alpine in Node, sweeping the JIT's batching (one run each, `bench/results/local/alpine.ts`): the pending batch was emitted after 100,000 dispatched steps (`BATCH_TIMEOUT`) far more often than when full (32 blocks), making 8245 modules a boot. Timeout 100K / batch 32: 13.3 s; 1M / 128: 12.4 s; 1M / 512: 12.0–12.3 s; 2M / 512: 12.1 s; 10M / 512: 12.4 s (blocks wait interpreted too long); batch 8: 15.3 s. The threshold (20, 50, 200 dispatches) moved nothing beyond noise. Profiled (Node, `perf`): with 2580 modules instead of 8245, Liftoff JIT code −1.0 s, TurboFan JIT code −0.6 s, V8's native work (compiles, instantiation) −0.6 s. So most of the gain is JIT code running faster, not compiling less: chains within a module are direct calls and tail calls, across modules imports or `call_indirect` between instances. A compile worker (loop 8) would move the native part off the vCPU thread but not the execution part.

**A code shape it exposed:** the longer timeout made the integer guest 25% slower (4029 → 3000 MIPS in Node) with byte-identical code volume. Its insertion-sort loop has two blocks, and which one heads the loop region depends on which hot counter reaches zero first, which the batching changed. With the second block as head, the region stored the full NZCV to the `Cpu` before that block's branch on every iteration: the step 8.4 rule skipped the store only when *every* successor is a member that doesn't need it, and one side of this branch leaves the region. Now the store is skipped when a successor is a member and no member successor needs it; the exits store NZCV on their own paths (`sync_flags`, as they already did). A region headed at the loop's first block had simply been lucky.

**What changed:** `BATCH_TIMEOUT` 100,000 → 1,000,000 steps, `Config::DEFAULT.batch` 32 → 512; the flag rule above (`block::emit_region`).

| Chromium, same session | HEAD (`665a3be`) | **loop 10.1** |
|---|---|---|
| integer guest (MIPS, eight placements) | 4014 (±35) | **5076** (±37), +26% |
| EL1 MMU off / on (MIPS) | 3857 (±74) / 3058 (±65) | 3673 (±40) / 2930 (±43), −5% / −4% |
| CoreMark (iterations/s) | 8274 (±172) | 8278 (±572) |
| FP guest (MIPS) | 151.6 | 152.4 |
| Alpine to power-off (JIT), alternated | 14.88, 14.91, 14.93, 15.11 s | **14.11, 13.85 s** (batching alone: 13.67, 13.50 s) |
| Alpine cold | 14.8–15.2 s | 13.9–14.1 s |
| Buildroot to power-off (JIT) | 730 ms | 696 ms (batching alone 701) |
| Alpine: modules, compile | 8245, 0.55 s (Node) | 2580, 0.32 s (Node) |

Steps unchanged (Alpine 3,009,151,562). The EL1 guests lose 4–5% in Chromium (8–10% in Node, with the same dispatches and a slightly different set of tier-ups and chains: a code-layout effect in a synthetic guest); accepted under the relaxed target: distro boots and real programs first, short boots and synthetic guests second (PLAN §7 M6). The flag rule may cost Alpine up to ~2% (13.5–13.7 s with batching alone vs 13.9–14.1 s with both, below the noise line): lukewarm code carries the NZCV computation on its exit paths instead of once before the branch.

**Validation:** the differential test (sequences, regions, loops), the golden corpus through the JIT, 20M-step lockstep, CI's boots with exact steps; planted bug: region exits without their flag store, caught by all five sequence and region classes.

Raw data: `results/m6-loop10/` (`head`, `loop10`), `../boot/results/m6-loop10/` (`head-*`, `batchonly-*`, `loop10-*`).

## M6 loops 9 and 7: global TLB entries kept; atomics, exclusives, LDTR/STTR, LD1/ST1 and MSR inline

**Why (loop 9):** Alpine's TLB counters split by cause (Node, instrumented once): of 3.61M misses, 3.26M landed on an empty slot right after a whole-TLB flush and 3.24M were global kernel pages; only 0.30M were conflicts and 0.32M nG. The whole flushes were 4,162 ASID switches and 1,559 `TLBI ASIDE1` (Linux's `flush_tlb_mm`), each dropping ~560 kernel entries that refilled at once; the other 35,867 flushes are `TLBI` by VA. (No KPTI: we advertise CSV3; no ASID changes on syscalls: they don't happen with software PAN either.)

**What changed (loop 9):** an ASID change or `TLBI ASIDE1` drops only the non-global entries, found through a list of the slots they were filled into (`Tlb::ng`, 1024 slots; past that it flushes all). Architecturally exact: global entries match every ASID and ASIDE1 never touches them. `VMALLE1` and MMU enable changes still flush everything. Misses 3.61M → 1.07M, dispatches 18.5M → 17.3M.

**What changed (loop 7):** inline through the same TLB fast path as loads and stores:
- LSE LDADD, LDCLR (an AND with the complement), LDEOR, LDSET and SWP as one wasm `atomic.rmw`, CAS as a `cmpxchg` of the masked expected value, every size and ordering (wasm atomics are sequentially consistent); LSE min/max and CASP stay helpers.
- LDXR/LDAXR and STXR/STLXR of one register with the interpreter's compare-and-swap semantics, the monitor in the `Cpu`; exclusive pairs stay helpers.
- LDTR/STTR through EL0's TLB arrays at EL1. **This fixed an interpreter bug (approved by the user):** since M3 the interpreter checked LDTR/STTR at EL1 against EL1's permissions; they now use EL0's (`tests/baremetal/mmu.c` checks 32–34, passed on QEMU TCG and on the M4 under hvf; check 32 failed on the old core).
- LD1/ST1 (multiple structures) of one to four registers, one contiguous access; LD2–LD4/ST2–ST4 stay helpers.
- MSR of DAIFSet, DAIF (unless it unmasks IRQs: then the helper, whose `Exit::Resync` leaves mid-block), SP_EL0, SPSR/ELR_EL1 and the TPIDRs inline, and those MSRs no longer end a block (`interp::sys::msr_continues`).

Alpine in Node: helper-retired steps 16.9M → 2.5M (left: MSR (register) 0.66M, ISB 0.56M, MRS 0.52M, STR fallbacks 0.46M, CASP 0.30M, ERET 0.21M), dispatches 17.3M → 14.9M. Steps unchanged (Alpine 3,009,151,562; every Node boot, LTP/kselftests included).

| Chromium 153, M4 VM, alternated with the baseline (`b8c01bf`) | baseline | after |
|---|---|---|
| Alpine to power-off (JIT), loop 9 alone, cold | 13.66, 13.78 s | 13.48, 13.36 s |
| Alpine, loop 9 + atomics/exclusives/LDTR, cold | 13.75, 13.72 s | 13.42, 12.90 s |
| **Alpine, loops 9 + 7 complete, cold** | 13.41, 13.98 s | **12.39, 12.70 s** (−8 to −9%) |
| Alpine, loops 9 + 7 complete, warm | 13.45, 13.95 s | 12.44, 12.73 s |
| Buildroot to power-off (JIT), cold | 746 ms | 712 ms |
| integer / FP guest (MIPS, eight placements; before LD1/MSR) | 5076 / 151.6 | 5083 / 151.8 |
| CoreMark (iterations/s; before LD1/MSR) | 8413 | 8383 |
| EL1 MMU off / on (MIPS; before LD1/MSR) | 3663 / 2811 | 3683 / 2880 |

The baseline itself moved 13.4–14.0 s between sessions (host state); the "after" column beats every baseline run it alternated with. The small guests use none of these instructions.

**Validation:** unit tests (the nG list and its overflow; LDTR/STTR permissions; the emitted TLB arrays); the differential test with new classes (LSE atomics, compare and swap, load and store exclusive with the monitor armed at random, LD1/ST1 multiple, MSR in the system-register class at EL0/EL1t/EL1h), `ldxp`/`ldsmax`/`msr daif` in the sequences; the golden corpus through the JIT (forced and stress); lockstep 300M steps; every Node boot with exact steps. **Planted bugs:** STXR ignoring the monitor's size, STXR's status inverted, LDXR leaving `val[1]`, LDCLR without the complement, LD1 registers not wrapping, LD1 post-index by one register, DAIFSet on the wrong bits, SP_EL0 ignoring SPSel: all caught by the differential test. An MSR DAIF that unmasks done inline (no `Resync`) is invisible to the differential test and to Buildroot's boot; Alpine's steps catch it (3,010,874,217).

Raw data: `results/m6-loop7/`, `../boot/results/m6-loop7/`.

## M6: ERET and the chunk size

**Why:** after loops 9 and 7, Alpine interpreted ~59M of its 3.0G steps (Node, a temporary counter by reason): 22.4M hot blocks waiting in the pending batch, 21.6M cold ones, and 14.1M in compiled blocks longer than what was left of the run loop's 1024-step chunk (2.07M times, a chunk's tail each). Trying larger chunks moved Alpine's steps, although chunk boundaries should be invisible to a deterministic guest: ERET restored DAIF from SPSR without ending the chunk, so an IRQ that went pending while masked waited up to a chunk (running up to 1023 more guest instructions) instead of being taken right after the ERET, as hardware does and as an unmasking MSR already did.

**What changed (both with the user's OK):** ERET returns `Exit::Resync` when it clears PSTATE.I (retired; the run loop then takes the IRQ). With that, every suite takes identical steps at chunk sizes 1024, 8192, 32,768 and 131,072 (bare-metal, kvm-unit-tests, Buildroot, the device test, LTP/kselftests, Alpine), so `CHUNK` is now 32,768. Step constants: Buildroot's boot unchanged (40,909,861), device test 113,872,868 → 113,841,233, LTP/kselftests 2,737,414,881 → 2,747,263,866, Alpine 3,009,151,562 → 3,009,537,573.

**Why it's fast:** a loop region checks its step budget on every back-edge, and the budget is the chunk, so with 1024-step chunks every hot loop returned to the dispatcher and the run loop ~3M times per boot. Alpine in Node by chunk size: 11.4 s (1024), 9.8 s (8192), 9.5 s (32,768 and 131,072); dispatches 14.8M → 12.4M, compiled-block tails 14.1M → 0.4M interpreted steps.

| Chromium 153, alternated with `c60acf2` | loop 7 | **ERET + 32K chunks** |
|---|---|---|
| Alpine to power-off (JIT), cold | 12.99, 12.80 s | **10.73, 10.79 s** (−17%) |
| Alpine, warm | 13.02, 12.68 s | 10.73, 10.87 s |
| Buildroot to power-off (JIT), cold | 722 ms | 707 ms |
| EL1 MMU off / on (MIPS) | 3650 / 2833 | **4843 / 3752** (+33%) |
| integer / FP guest (MIPS, eight placements) | 5086 / 152.1 | 5099 / 151.6 |
| CoreMark (iterations/s) | 8444 | 8315 (noise: no chunk boundaries in user mode) |

Alpine's M6 target (≤ 12.2 s, 1.5× M5's 18.4 s) is met: 1.71×. Cost: in realtime mode, host signals and timers are seen up to one chunk (~0.1 ms) late, and the PC-sampling profiler's samples each stand for up to 32K steps.

**Validation:** a unit test for the ERET exit (unmasking and not); CI with the new constants (Node and Chromium boots with exact steps).

Raw data: `results/m6-chunk/`, `../boot/results/m6-chunk/`.

## M6 loop 10 (tuning) and the loop 8 question (compile pauses)

**Tuning, re-swept after the chunk change** (Alpine in Node at `4b552a4`, two runs each; the baseline's three runs 9.6–9.7 s): threshold 10: 9.4, 9.7 s; 20: 9.6, 9.3; 200: 9.8, 9.9. Batch timeout 300K steps: 9.7, 9.7; 3M: 9.8, 9.8. Batch size 128: 9.7, 9.8; 2048: 9.7, 9.6. `region_after` 100: 9.6, 9.8; 300: 9.6, 9.6; 3000: 9.6, 9.7. All within noise except threshold 200 (slower): the defaults (50, 512, 1M, 1000) stay.

**Would a compile worker (loop 8) help latency?** The question (the user's): even if it doesn't change total time, does compiling on the vCPU thread pause the guest noticeably (a guest GUI)? Measured in Node over Alpine's boot (`bench/results/local/alpine-stalls.ts`, ad hoc): each JIT module's compile + instantiate (1,923 installs: every batch and tier-up) took a median 0.07 ms, p99 0.5 ms, **max 1.3 ms** (188 ms in all); wall time per 100K guest steps (emission, V8's lazy Liftoff compiles and cold code interpreted included) had a median of 0.25 ms, p99 1.9 ms, p99.9 4.6 ms, and one slice in 29,948 above 16 ms (29 ms). So synchronous compiling doesn't make visible pauses; the slow stretches are cold code being interpreted, which a compile worker wouldn't remove. **Loop 8 isn't built in M6**; worth a second look with a GUI guest (M8), which compiles far more new code than a boot.

## M6: Debian timed; the code cache to 262,144 regions

Debian 13 to power-off under the JIT in Chromium (`--only boot_debian_jit`, new: one cold and one warm boot): 50.3 s cold, 48.2 s warm, 16,654,729,762 steps. It compiled 183K regions into a 65,536-region cache and flushed it twice, recompiling. With 262,144 regions (the cache's only up-front cost is its hot words, 4 bytes a slot): no flush, 110,685 regions, 52.6 MB of wasm instead of 87.6 MB, **44.3 s** cold and warm (Node: 42.9 → 39.3–40.0 s); steps unchanged. Alpine and Buildroot never filled the old cache. Per-module eviction isn't needed for these guests.

Raw data: `../boot/results/m6-debian/`.

## M6 exit table

On a quiet host (a stale experiment had held one vCPU busy through the earlier M6 measurements; alternated A/Bs are unaffected, absolute numbers were ~5% pessimistic): Chromium 153, the M4 VM, `2c9771b`. Peers run the same kernels, images and CoreMark binary; peer comparisons are a one-off for this table (PLAN §5).

| | M5 (JIT) | **M6 (JIT)** | qemu-wasm (Chromium) | QEMU TCG (this VM) | native (M4) |
|---|---|---|---|---|---|
| CoreMark, user mode (it/s) | 5955 | **8602** | — | 12,500 (`qemu-aarch64`) | 61,111 |
| CoreMark as init in a VM (it/s) | — | **7857** | 428–461, invalid (CRC errors) | 10,000 | 61,111 (hvf) |
| integer / FP guest (MIPS) | 3857 / 19.6 | **5175 / 155** | — | — | — |
| EL1 guest, MMU off / on (MIPS) | 2136 / 1919 | **4932 / 4045** | — | — | — |
| Buildroot to power-off, cold | 717 ms | **670 ms** | 3.13 s | 0.30 s | 0.10 s (hvf) |
| Alpine boot to power-off, cold | 18.4 s | **10.2 s** | — | 5.4–5.6 s | 2.4 s (hvf) |
| Alpine userspace (new) | — | **23.7 s** | — | 11.2 s | 2.9 s (hvf) |
| Debian 13 boot to power-off | (377 s interpreted) | **42.2 s** | — | 31.3 s | 2.4 s (hvf) |

**Against the targets:** Alpine ≤ 12.2 s: met (10.2 s, 1.80× M5). FP guest ≥ 98 MIPS: met (155, 7.9× M5). CoreMark ≥ TCG: not met, 69% of TCG user mode and 79% of TCG system mode in a VM; the user decided it doesn't block the exit (wasm's usual 10–30% gap to native on compute-bound code is most of what's left).

**Alpine userspace, per phase** (the approved M6 phase, 3 boots): compress 2.78 s, Lua 5.14, churn 2.14, SQLite 3.93; 23.7 s to power-off.

**The peers:** QEMU TCG runs 1.4–2.1× faster than webpc on the boots and 1.2–1.45× on CoreMark, from native code on the same host; hvf is 3.5–18× faster than TCG on boots dominated by kernel work. qemu-wasm (ktock/qemu-wasm, built in rootless Podman under x86_64 emulation, GPL, only run) boots Buildroot 4.7× slower than webpc and gets CoreMark wrong (its list and state CRCs mismatch, with either CPU model), so its CoreMark speed isn't a valid result. Details and every run: `../boot/results/m6-exit/peers.txt`.

Raw data: `results/m6-exit/`, `../boot/results/m6-exit/`.

## M6.5 loop 0: the bar (`openssl speed` on the NEON-only paths)

`--only alpine_crypto_jit` (new, `bench/boot/suite.ts`): Alpine's user image (`images/build.sh alpine-user`, now with `openssl=3.5.8-r0`) booted with `webpc.phase=crypto`, which runs only OpenSSL: a check line (SHA-1 and SHA-256 of a fixed MiB, AES-128-CBC encrypt and decrypt, AES-256-CTR, compared with arm64 hardware's) and `openssl speed -elapsed -mr -seconds 1 -bytes {256,16384} -evp <alg>`, one process per algorithm and size. **Realtime mode** (`openssl speed` times itself with the guest clock); the default `alpine_user_jit` run and the Alpine boot benchmark are unchanged apart from the image's new package (`ALPINE_USER_STEPS` 10,856,495,986 → 10,873,074,162; `churn: 1069 files`). `webpc.armcap=X` on the command line sets `OPENSSL_armcap` (for loop 7's on/off). Chromium 153, the M4 VM, 5 boots, medians (IQR), MB/s = 10⁶ bytes/s:

| | 256 B | 16 KiB |
|---|---|---|
| AES-128-GCM | 24.4 (3.3) | **51.0** (0.7) |
| AES-256-GCM | 24.4 (6.4) | **40.7** (0.3) |
| AES-128-CBC (encrypt) | 44.7 (1.0) | **46.8** (0.9) |
| SHA-1 | 45.8 (0.8) | **256.5** (1.4) |
| SHA-256 | 32.7 (0.4) | **87.5** (0.2) |

- The guest's OpenSSL sees `OPENSSL_armcap=0x81` (NEON and the CPUID bit): `vpaes` for AES, the scalar/NEON SHA code, and for GHASH no 8-bit `PMULL` at all.
- **The helper histogram of the phase** (from its start marker to power-off): 1.2M helper calls in 10.5 s, none of them crypto or NEON arithmetic (the top ones are the kernel's: `STRx_LDRx_imm_2` 0.26M, `LD1` multiple 0.14M, `MSR` 0.13M, `ISB` 0.13M; process start-up and exits). The NEON-only paths run entirely inline since M6 loop 4, so the bar is the inline code's speed; 8-bit `PMULL` doesn't appear, so loop 5 has no reason to inline it for OpenSSL.
- The 256-byte AES-GCM rows are the first `openssl speed` runs, when the JIT still compiles `libcrypto`'s code (kept afterwards: blocks are keyed by physical address, and the library's pages are shared), hence their IQR; the 16 KiB rows are the steady-state numbers to beat.

Raw data: `../boot/results/m65-loop0/neon-only.json`.

## M6.5 loops 2–4: the extensions switchable, then AES inline

`--only alpine_crypto_ce_jit`: loop 0's benchmark with `VmConfig.features` bit 0 (ABI 19, loop 2): the guest's OpenSSL sees `OPENSSL_armcap=0xbd` and takes its CE paths (`aes-gcm-armv8_64`, the AESE/AESMC CBC loop, `sha1/sha256` with SHA1*/SHA256*); its check line matches arm64 hardware's. Chromium 153, the M4 VM, 5 boots each unless marked, medians (IQR), MB/s at 16 KiB (256 B in the JSON):

| | NEON-only (loop 0) | CE, all helpers (1 boot) | CE, AES inline: 16 slices | nested inversion | **nested, constants in the `Vcpu`** |
|---|---|---|---|---|---|
| AES-128-GCM | 51.0 | 4.5 | 86.0 (0.2), 86.1 (1.6) | 104.7 (0.1), 102.2 (1.0) | **124.7** (0.8) |
| AES-256-GCM | 40.7 | 3.2 | 70.1, 70.4 | 89.4, 89.1 | **112.7** (0.7) |
| AES-128-CBC | 46.8 | 4.7 | 112.1 (0.7), 111.2 (0.1) | 148.4 (2.3), 143.5 (0.6) | **152.1** (1.5) |
| SHA-1 | 256.5 | 57.2 | | | 56.7 (helpers) |
| SHA-256 | 87.5 | 48.1 | | | 48.3 (helpers) |

- **Through the generic helper** every crypto instruction costs a call into the interpreter's table-free arithmetic (the SWAR S-box is ~1800 wasm ops): 10× under the NEON bar for AES, 2–4.5× for SHA.
- **Loop 4, AES inline** (`core/src/jit/emit/crypto.rs`): AESE/AESD as AddRoundKey, a ShiftRows swizzle and SubBytes; AESMC/AESIMC by `xtime` and column rotations; an `AESE`+`AESMC` (`AESD`+`AESIMC`) whose mix reads and writes the round's register is one emitted round (`Func::next`/`fused`), anything else two instructions. Only when the vCPU has the feature (`Ctx::crypto`, from `jit::Cache::features`).
- **The two SubBytes candidates**, measured alternately (slices, nested, slices, nested): the S-box as 16 swizzles of 16-byte slices (a byte selects slice j by XOR with 16j: other lanes' indices are ≥ 16, which swizzle reads as 0) against **nested inversion** over GF(2⁴) (Hamburg, CHES 2009, §3.3: GF(2⁴) = F₂[ζ]/(ζ⁴+ζ³+ζ²+ζ+1), GF(2⁸) = GF(2⁴)[t]/(t²+t+ζ), 1/(xt+yt̄) = (t+ζ)/(1/(1/y+1/ζ(x+y))+x) + (t̄+ζ)/(1/(1/x+1/ζ(x+y))+y) with ∞ as an out-of-range index; our implementation of the paper's formulas, tables generated at compile time by `crypto::nested`, checked byte by byte in a swizzle model): 9 swizzles instead of 16, **+30% on CBC, +20–27% on GCM**. Nested inversion is kept.
- **Constants out of `v128.const`**: TurboFan built every 128-bit constant from immediates at each use, in the loop (the AESE+AESMC, AESD+AESIMC loop's TurboFan code: 145 `movk`, 50 `movz`, 24 `fmov` of 1720 bytes; `tools/v8code.ts --guest bin:<raw>`, new). The tables and swizzle indices now sit in `Vcpu::consts` (between the `Cpu` and the TLB, filled at creation), one `ldr q` each: 816 bytes, 24 `tbl` (one per swizzle, as planned), no `movk`. GCM +19–26%; CBC +3%.
- **CBC is latency-bound**: its rounds are one dependency chain, and each instruction stores its V register to the `Cpu` and the next loads it back, so a round costs ~2 cycles per swizzle level plus a store-to-load round trip. Vector registers in locals (M6 loop 3, not done) is what would help it; GCM's parallel blocks hide it.
- The GCM runs still spend helpers on `PMULL` (58M calls in the phase: loop 5) and SHA is all helpers (loop 6).

Raw data: `../boot/results/m65-loop4/` (each variant's JSON; `helpers-only-quick.json` is the one-boot helper run).

## M6.5 loop 5: PMULL.1Q inline; a realtime WFI race

**PMULL/PMULL2 (64-bit)** inline (`jit::emit::crypto::pmull64`): Karatsuba over three 32×32 carry-less products, each 16 `i64.mul`s of the operands masked to every fourth bit (the partial sums can't carry into the next bit of a class), all scalar: wasm has no carry-less or wide multiply, and `i64x2.mul` has no arm64 instruction. Four 32×32 products instead of Karatsuba, measured alternately with the fix below in both: `alpine_crypto_ce_jit`, Chromium 153, 5 boots each, medians (IQR), MB/s at 16 KiB:

| | loop 4 (PMULL a helper) | four products | **Karatsuba** |
|---|---|---|---|
| AES-128-GCM | 124.7 | 204.4 (2.7), 204.0 (2.9) | **213.8** (0.6); 212.8 (2.4), 212.2 before the fix |
| AES-256-GCM | 112.7 | 167.3, 167.2 | **175.0** (1.6), 172.5 |

Karatsuba is 4.5% faster in both repeats; kept. GCM is now 4.2× (AES-128) and 4.3× (AES-256) the NEON-only bar (51.0, 40.7). The phase's helper calls are all SHA now (SHA1H 28M, SHA1SU0/SU1 22M each, SHA256H/H2 20M each): loop 6.

**The realtime WFI race (found here, fixed):** a 5-boot run stalled with the vCPU asleep at ~9% CPU for 17 minutes; the same run passed 11 times after that. The boot benchmarks now pass `idleLimitMs` (`web/vm.ts`: a realtime idle with no timer deadline and nothing signaled for 30 s throws), and the next stall threw at the kernel's idle loop with no device request in flight. Cause: `Vm::wfi` read the realtime clock three times: `lines()` at time A found the timer not yet due, `next_deadline()` at a later time B dropped it as already fired, so the WFI returned idle with no deadline and the host slept for good (and `t - now()` could wrap for the reported sleep). `openssl speed`'s 1 s alarms land in that window more often than boots do. `wfi` now decides from one reading (`lines_at`, `next_deadline_at`; the invariant is a unit test in `vm::tests`). Deterministic mode was never affected (its clock is the step count). The watchdog stays on in the benchmarks.

**Constant time dropped** (the user, 2026-09-28, PLAN §7 M6.5): the interpreter's S-box is now a 256-byte table (the SWAR arithmetic stays as a test reference); the JIT's code was table-free because it measured fastest, and stays so.

Raw data: `../boot/results/m65-loop5/`.

## M6.5 loop 6: SHA-1 and SHA-256 inline

`jit::emit::crypto`: SHA1C/P/M and SHA256H/H2 as four scalar rounds on i32 locals (the words renamed between rounds at emit time, not moved), SHA1H a rotate; the schedule updates (SHA1SU0/SU1, SHA256SU0/SU1) as SIMD128 shuffles and `i32x4` rotations. SHA256H and SHA256H2 run the same four rounds and keep one half each; OpenSSL and Linux write them as `mov S, A; sha256h A, E, W; sha256h2 E, S, W`, and that triple is emitted as one set of rounds writing both halves (`Func::prev`; any other shape, two). New corpus form `crypto.sha256_rounds` (the triple, a fifth with one register changed; M4 and QEMU agree on all 2300 tests) and jit-diff class "SHA rounds and NEON". `alpine_crypto_ce_jit`, Chromium 153, 5 boots, medians (IQR), MB/s at 16 KiB (256 B):

| | NEON-only (loop 0) | CE, SHA helpers (loop 5) | **CE, all inline** |
|---|---|---|---|
| SHA-1 | 256.5 (45.8) | 56.7 | **369.9** (3.5); 51.8 at 256 B |
| SHA-256 | 87.5 (32.7) | 48.3 | **293.7** (4.9); 56.2 at 256 B |
| AES-128-GCM | 51.0 | 213.8 | 231.3 (0.9) |
| AES-256-GCM | 40.7 | 175.0 | 191.4 (2.7) |
| AES-128-CBC | 46.8 | 152.1 | 151.9 (1.0) |

(GCM's gain here isn't from SHA: same code; within one session's spread, not claimed.) Helpers left in the phase: scalar `SHL` (6.6M, plain AdvSIMD in OpenSSL's GCM glue), `LD1`/`ST1` single structure (0.45M each), the kernel's usual. Planted: σ0's rotation off by one (913 of 4096 words, 118 of 1024 sequences, 42 corpus tests), the triple fused when SHA256H2 reads another register (9 sequences, 30 corpus tests).

Raw data: `../boot/results/m65-loop6/`.

## M6.5 loop 7: the extensions off and on

`--only alpine_crypto_jit` (off: NEON-only paths) and `--only alpine_crypto_ce_jit` (on), alternated in one session (off, on, off, on): Chromium 153, the M4 VM, 5 boots each, medians (IQR), MB/s:

| | off | on | on / off |
|---|---|---|---|
| AES-128-GCM, 16 KiB | 50.2 (0.9), 50.4 (0.4) | **232.0** (3.4), **232.2** (0.6) | 4.6× |
| AES-128-GCM, 256 B | 24.1 (3.0), 26.7 (1.1) | 48.9 (0.7), 50.6 (0.4) | 1.9–2.0× |
| AES-256-GCM, 16 KiB | 40.7 (0.6), 40.7 (1.6) | **191.9** (0.6), **192.3** (0.9) | 4.7× |
| AES-256-GCM, 256 B | 24.3 (6.0), 23.9 (0.4) | 47.5 (0.2), 48.1 (1.2) | 2.0× |
| AES-128-CBC, 16 KiB | 45.2 (0.5), 45.0 (0.9) | **151.1** (1.2), **151.2** (0.7) | 3.4× |
| AES-128-CBC, 256 B | 43.3 (1.0), 42.4 (0.7) | 129.7 (1.5), 129.4 (0.4) | 3.0× |
| SHA-1, 16 KiB | 256.9 (1.0), 253.0 (2.5) | **373.4** (1.2), **375.3** (2.1) | 1.5× |
| SHA-1, 256 B | 45.3 (0.4), 44.3 (0.9) | 51.7 (2.0), 52.1 (1.1) | 1.16× |
| SHA-256, 16 KiB | 87.1 (0.4), 86.0 (0.4) | **297.2** (0.8), **297.9** (1.7) | 3.4× |
| SHA-256, 256 B | 32.4 (0.2), 31.7 (0.3) | 56.0 (0.9), 56.0 (0.7) | 1.7× |

On beats off in every row of both repeats (the smallest margin, SHA-1 at 256 B, is 16%). **Boot with them advertised** (Node, deterministic, Alpine's boot test, twice each): 3,009,537,573 → 2,856,603,825 steps (−5.1%: the kernel's CE code), 8.9–9.1 s either way; the boot passes.

Raw data: `../boot/results/m65-loop7/`.

## M6.5 exit: advertised by default

The user approved advertising the crypto extensions by default on loop 7's numbers (2026-09-28): `bootVm` and the native runners (`core/tests/common`, `core/tests/baremetal.rs`) give VMs `VmConfig.features` bit 0 unless told otherwise (`crypto: false`; the ABI's 0 still means none). The step constants moved once, in the same session as the re-baselined boots: Buildroot 40,909,861 → 40,890,907, the device test 113,841,233 → 114,044,960, LTP/kselftests 2,747,263,866 → 2,744,982,696, Alpine 3,009,537,573 → 2,856,603,825, Alpine userspace 10,873,074,162 → 10,746,996,638 (interpreter and JIT alike); the bare-metal `exceptions` test now expects `ID_AA64ISAR0_EL1` = 0x211120.

**Boots re-baselined** (Chromium 153, the M4 VM, extensions on; medians, IQR): Buildroot under the JIT 674 (17) ms cold, 655 (4) warm; Alpine 9963 (57) ms cold, 10,048 (19) warm; Alpine userspace 24.1 s (compress 2.82, Lua 5.13, churn 2.21, SQLite 4.00). M6's exit table (another session: 670 ms, 10.2 s, 23.7 s) is within the host's session-to-session spread; no gain or loss claimed for the boots, whose kernels spend little time in crypto (in Node, Alpine's boot was 8.9–9.1 s either way).

| `openssl speed`, 16 KiB, MB/s | NEON-only | **crypto extensions** |
|---|---|---|
| AES-128-GCM | 50.3 | **232.1** (4.6×) |
| AES-256-GCM | 40.7 | **192.1** (4.7×) |
| AES-128-CBC | 45.1 | **151.2** (3.4×) |
| SHA-1 | 255.0 | **374.4** (1.5×) |
| SHA-256 | 86.6 | **297.6** (3.4×) |

(Loop 7's two alternated runs per column, averaged.) Raw data: `../boot/results/m65-exit/`, `../boot/results/m65-loop7/`.

## M7 loop 6: guest-RAM accesses as atomics

Loop 6 makes the core's guest-RAM loads and stores relaxed atomics (`mem::load`/`store`: the
interpreter, the walker, instruction fetch), so parallel SMP has no Rust data race; aligned
accesses are one atomic, unaligned ones naturally aligned pieces. Wasm's atomics are all
sequentially consistent (`ldar`/`stlr` on arm64). Measured with `vm_mmu_mips` (the integer guest
at EL1, MMU on, interpreted; no placements, 15 samples each, all IQRs ≤ 0.8), Chromium 153, the
M4 VM, one session, 2026-09-28:

| Build | MIPS |
|---|---|
| A: base (`3fcfafb`) | 88.7 |
| B: atomics, `is_multiple_of(size)` (a remainder) and the split inline | 74.7 |
| C: as B with volatile plain accesses on wasm | 74.9 |
| C2: as C, a mask test, the split out of line | 80.6 |
| D: A's plain `read_unaligned` bodies on wasm (diagnostic) | 87.8 |
| **E: atomics everywhere, a mask test, the split out of line (kept)** | **79.0** |
| F: as E, the split plain (diagnostic: the split isn't what costs) | 79.3 |
| G: as E, both paths plain (diagnostic: the alignment test alone) | 83.9 |

The alignment test costs ~5% and the sequentially consistent accesses ~6%; volatile is no cheaper
than atomics and is UB under races all the same, so E keeps one code path on every target. The
interpreter runs ~1.4% of Alpine's boot (41M of 2,857M steps), and the boot stayed within noise
(`../boot/REPORT.md` "M7 loop 6"). Raw data: `results/m7-loop6/`.

## M8: the block interpreter

2026-10-09, the dev VM, Chromium 153.0.8010.52, one session; raw data `results/m8-dec/`. The
interpreter (`VmConfig.jit` 0 / `vcpu_new`) against the block interpreter (the dispatcher never
compiling: `jit` 4 / `jit_new` with a threshold of `u32::MAX`; [docs/cpu.md](../../docs/cpu.md)
"The block interpreter"), medians (IQR ≤ 1.1 everywhere):

| guest | interpreter | block interpreter | |
|---|---|---|---|
| `vm_mmu_mips` (EL1, MMU on) | 72.6 | 195.6 | 2.69× |
| `vm_flat_mips` (EL1, MMU off) | 112.2 | 196.6 | 1.75× |
| `interp_mips` / `dec_mips` (user mode, 8 placements) | 133.5 | 258.2 | 1.93× |
| cold (the first 2M steps), MMU on | 51.3 | 101.7 | 1.98× |

How it got there (`vm_dec_mmu_mips`, same build otherwise; the interpreter's 70.8 then):
1. Decoded blocks run from the dispatcher, a dispatch through the JIT cache's lock every block:
   70.4. A `perf` profile in Node: the dispatcher (lock, two map lookups, `Table::sync`) cost as much
   as the micro-ops.
2. Dispatches counted in the block's slot, reported every 16: 106.5.
3. Blocks chained in the interpreter's own loop (same page: the next key from the block's;
   another: the instruction TLB) and loads/stores through an inline TLB probe (`Bus::fast`): 207.1.
   The later fixes for the real workloads (counts that survive eviction, reporting at the threshold,
   one decode a word) left it at 195.6.

Native, natively everything runs through the dispatcher: Alpine's boot in the block interpreter at
~190 MIPS (15 s), every step in it, the same 2,856,663,287 steps.

## M8: inline FMA

2026-10-14, the dev VM, Chromium 153.0.8010.52, one session, the builds alternated in place of
the served core (so every JSON's `commit` reads `f2ebe78`, dirty); raw data `results/m8-fma/`
(and `../boot/results/m8-fma/`). Every FMA form is now inline ([docs/jit.md](../../docs/jit.md)
"Floating point", FMA): Boldo and Melquiond's emulated FMA for doubles (an exact product from
Veltkamp's split and Dekker's product, TwoSum, the sum's low part rounded to odd), and for
singles the double sum rounded to odd before the demote. That's RNE f64 operations only, no
relaxed-simd and no host `fma`. `jit_fp_mips`, eight placements, medians of the runs (IQR ≤ 14):

| build | FP guest (MIPS) | helper calls per window |
|---|---|---|
| base (`f2ebe78`) | 197.3, 197.8, 197.2 | `FMADD` 6.34M, `FMLA` 2D 2.14M, `FMLA` by element 0.17M, `FADD` 0.05M |
| + scalar double FMA (normal operands) | 262.0, 260.8 | `FMADD` 2.16M (singles: zero factors and midpoints), … |
| + scalar single rounded to odd, zero factors and addends | 329.7, 329.7 | `FMLA` 2D 2.14M, … |
| + vector double (f64x2) | 679.5, 676.2, 677.0 | `FMLA` by element 0.17M (single lanes on midpoints), `FADD` |
| **+ vector single rounded to odd (kept)** | **713.3, 705.3, 706.8** (3.6×) | `FADD` 0.05M |

Real workloads, A/B alternating:
`gl_llvmpipe_jit` (single-precision FMLA heavy) 321.7, 331.6, 326.6 → 307.8, 308.3, 308.0 ms a
frame (−6%, the same 484.20M steps a frame); `alpine_user_jit` 17,666 → 17,590 ms (noise: the
kernel and userspace barely use FP). The algorithm's correctness is argued in jit.md and checked by
models of both forms against the software FMA (`core/src/fp/tests.rs`) and the differential test's
FP edge cases; a planted bug in each step (round to odd, Dekker's last product, either TwoSum
error term, the product bound with and without the sign bits, FMLS's negation) failed them.

**Then scalar zero operands** (2026-10-14, same session; raw data `results/m8-fma/fadd-*.json`): the
scalar FADD/FSUB/FMUL/FNMUL/FDIV fast path takes ±0 operands and exact zero results as the vector
one does ([docs/jit.md](../../docs/jit.md) "Zero operands"). The FP guest's last helper, `FADD`
(0.05M per window, its sums starting at 0), is gone: 100% of its steps retire inline. Its speed is
within noise: 710.5, 711.8, 711.7 against 711.2, 702.1, 704.9 MIPS.

## M8: the single FMA's midpoint test

2026-10-18, the dev VM, Chromium 153.0.8010.52, one session, the builds alternated in place of the
served core (every JSON's `commit` reads `d0b9957`, dirty); raw data `results/m8-fp-mid/` (and
`../boot/results/m8-fp-mid/`). The single FMA forms (FMADD & co. with sz = 0, FMLA/FMLS vector and
by element) rounded every double sum to odd (TwoSum, then ±1 on the bits) before the demote. Now
the demote takes the plain RNE double sum, which is correct unless that sum is a single's midpoint
(its low 29 bits `1 << 28`); only then, in a branch, the sums are rounded to odd as before
([docs/jit.md](../../docs/jit.md) "Floating point", FMA). `jit_fp_mips`, eight placements,
medians of the runs (IQR ≤ 30):

| build | FP guest (MIPS) | helper calls per window |
|---|---|---|
| base (every sum rounded to odd) | 718.8, 713.1, 712.1 | none |
| midpoints to the helper (first try) | 719.7, 713.9 (base in that session: 718.3, 711.1) | `FMLA` by element 0.17M |
| no midpoint test (wrong: the ceiling) | 849.8, 851.0, 849.4 | none |
| **midpoints rounded to odd in a branch (kept)** | **866.7, 854.4, 851.7** (+20%) | none |

The first try sent midpoint lanes to the helper: the FP guest's matrix multiply (short decimal
significands) puts exact sums on single midpoints 0.17M times a window, and those helper calls
cost the whole gain. With the branch the build is at the ceiling. A cloud session's ceiling on a
Xeon (`M8-FP-HANDOVER.md`) was +29%.

`gl_llvmpipe_jit` (single FMLA heavy), A/B alternating: 318.7, 313.6, 309.4 → 303.7, 306.4,
298.1 ms a frame (−3%, under the noise bar but every pair agrees; the same 484.20M steps a
frame). Checked by the single model in `core/src/fp/tests.rs` (rewritten to the new algorithm,
4M cases, 19% of them midpoints by construction) and jit-diff's FP edge cases (two new: FMLA 2S,
a sum just above a midpoint); planted bugs (midpoints not fixed, scalar and vector) failed both.

## M8: every FP instruction inline, and results, not operands

2026-10-18, the dev VM, Chromium 153.0.8010.52; builds alternated in place of the served core;
raw data `results/m8-fp-checks/` (and `../boot/results/m8-fp-checks/`).

**Every FP instruction we advertise got a fast path** (the FP handover's item 2: FCMP/FCCMP/FCSEL,
the conversions in every rounding, half, fixed point, FMAX & co., FRINT*, FABD, FMULX, FRECPS/FRSQRTS,
FRECPE/FRSQRTE, FRECPX, the pairwise and across-lanes ops, the AdvSIMD scalar forms; [docs/jit.md]
(../../docs/jit.md) "Floating point"), checked by the FP suite in the guest (docs/testing.md). The
FP guest runs none of them: 865.3, 864.7, 853.5 MIPS before, 866.7, 863.0, 851.2 after (`item1-*`,
`item2-*`), as expected.

**Then the checks.** With every fast path's guard forced true (wrong: `ceiling-*`) the FP guest ran
at 1,764, 1,742, 1,759 MIPS, 2.04× the build: its checks were half its time. Most were operand tests
(normal or zero), there for FZ alone: without FZ the host's IEEE operations take denormal operands
as ARM does (exactly, and IDC is FZ's flush), and a NaN or infinite operand makes a NaN or infinite
result, which the result check rejects. So the operand tests now run only under FZ, in a branch on
the block's FZ bit (`under_fz`); the double FMA keeps its factor test (folded into the product
bound), the zero-result clauses gained `result == 0` (0 × ∞ is a NaN), and the tests that don't
round test for NaNs (and for denormals under FZ the same way).

| build | FP guest (MIPS) | `gl_llvmpipe_jit` (ms a frame) |
|---|---|---|
| before | 839.4, 841.9, 844.4 | 293.1, 293.6, 296.3 |
| operand tests dropped, FZ required in the block guard | 1162.5, 1152.1, 1151.9 | **4814.0, 4782.0, 5004.4** (`gl-fz-required-*`; before, that session: 303.2, 295.7, 299.3) |
| **operand tests under FZ only (kept)** | **1093.8, 1104.8, 1094.1** (+30%) | **297.2, 299.4, 299.8** (+1.5%, every pair) |

The first try required FZ clear for every fast path, and llvmpipe's frames took 16× longer: its
shaders run with FPCR.FZ set, so everything went to the helpers (the FP suite passed it: it checks
results, not speed). Under FZ the kept build costs llvmpipe ~1.5% (a branch per instruction, the
zero clause's extra test), the same 484.20M steps a frame. Correctness: the FP suite (both FZ
settings with FPSR.IXC set), jit-diff, the corpus; planted bugs (no `result == 0` in FMUL's and
FMLA's zero clause; the double FMA's bound past its limit; FZ's factor test left out, which the
suite caught as an IDC lost under FZ) each failed.

**Then the FZ path's tests themselves** (same day; `*denormal-*`): llvmpipe with no checks at all ran
at 240.8, 235.2, 235.9 ms a frame (`gl-ceiling-*`), 21% under the build's 302.9, 299.5, 300.5. Under
FZ the only operand case left is a denormal (a NaN or ∞ fails the result test), so the normal-or-zero
masks (nine ops a lane) became a denormal test, |x| - 1 below the smallest normal's - 1 unsigned
(three ops; doubles four), ORed across operands and cleared from the result mask with one `andnot`;
the NaN-only tests' FZ path likewise. `gl_llvmpipe_jit` 299.3, 300.4, 301.6 → **282.8, 282.7,
283.3** ms a frame (−6%; 4% under the build before any of this), the FP guest 1100.9, 1100.0,
1080.4 → 1120.0, 1110.5, 1110.5 MIPS (noise: it runs without FZ). A planted "no denormals" in both
tests failed 89 forms of the FP suite, all under FZ.

**Then the zero tests** (`*zeros-*`): a zero lane is a float compare with zero (one op, where the
integer mask and compare took two), and vector single FMLA's exact-zero clause (a zero result from a
zero product and addend: four zero tests) became "the double sum is zero" (the product is exact in a
double, and a nonzero exact sum can't round to zero there: two ops a half and a shuffle). The FP guest
1107.4, 1110.8, 1111.1 → **1242.6, 1234.8, 1237.4** MIPS (+12%), `gl_llvmpipe_jit` 281.6, 290.0,
284.4 → **275.5, 275.3, 276.0** ms a frame (−3%).

## M8: the FP fast paths' SIMD ops

2026-10-18, the dev VM, Chromium 153.0.8010.52; builds alternated in place of the served core, three
pairs a step; raw data `results/m8-fp-ops/` (and `../boot/results/m8-fp-ops/`); the run experiment's
in `results/m8-fp-runs/` with its patch.

**One check for a run first** (the backlog's lead idea, [docs/jit.md](../../docs/jit.md) "Tried and
not kept"): the inline SIMD&FP instructions up to one that can't join (memory, branches, helpers, X
registers, NZCV; integer instructions between them stay in the run) ANDed their conditions into one
i32 and their lane masks into one v128, reduced and branched once; a failure restored the V registers
the run wrote and ran its members again. Through the helpers (`fp2-*`): 1270.3, 1273.3, 1274.9 →
1283.5, 1271.2, 1278.2 MIPS. With the members emitted again as outside a run, so that the single FMA's
midpoint test could join the run's check too (`fp3-*`): 1249.4, 1244.2, 1239.7 → 1228.3, 1229.6,
1226.2; `gl_llvmpipe_jit` 278.3, 288.1, 284.3 → 280.6, 280.0, 290.3 ms a frame
(`../boot/results/m8-fp-runs/`). TurboFan's code for the n-body loop shrank from 36 to 24 KB, yet
nothing ran faster.

**Why: the SIMD pipes.** Ceiling builds, each wrong on purpose, in Node (a local runner of the FP
guest under the JIT, 3·10⁹ steps after a warm-up, alternated; directional, no JSON): the build 1232,
1275, 1269 MIPS; runs 1294, 1283, 1271; no FZ branches 1263, 1314, 1305; no midpoint test (TurboFan
drops what it computes) 1392, 1372, 1368; no checks at all (with runs) 1704, 1687, 1792. The midpoint
test's branch and reduction were what the run removed; its four lane ops were the 8%. In TurboFan's
code a vector single FMLA by element was ~37 SIMD-pipe ops for ~15 of FMA arithmetic (`movi`
constants and the reductions' `umaxp`/`fmov` among them), while its branches and general-register
compares cost next to nothing: on the M4 these paths are bound by the SIMD pipes, which scalar FP
shares (a scalar FSUB was eight such ops: `umov` and `fmov` for each operand, the op, `fmov` of the
result for its check, `movi` and `ins` to write it back). So, op by op:

| step | before (MIPS) | after (MIPS) |
|---|---|---|
| range tests on the bits shifted left once (three lane ops, doubles' sign flip folded; midpoint test shifted by 3) (`shl-*`) | 1245.9, 1232.1, 1226.4 | 1256.1, 1269.0, 1261.4 |
| by element, FMLA's factor promoted once; without FZ the lane tests' FZ branch passes the mask through (`simd2-*`) | 1264.2, 1266.2, 1262.7 | 1312.6, 1309.8, 1303.1 |
| scalar FADD … FSQRT read operands with `f64x2.extract_lane 0`, their bits only in branches (`scal-*`) | 1318.8, 1314.3, 1299.6 | 1396.4, 1386.7, 1385.3 |
| **all, against the commit before** (`fin-*`) | 1244.2, 1224.6, 1244.6 | **1404.5, 1400.6, 1405.2** (+13%) |

`gl_llvmpipe_jit` with all of it: 278.2, 279.3, 279.1 → 275.1, 281.9, 284.0 ms a frame (noise; the
same 484.2M steps a frame). Its shaders run under FZ, where the operand tests remain: without them
(wrong, `glfz-*`) 279.8, 277.1 → 258.1, 257.6 ms. Not kept: the lane constants loaded from the `Vcpu`
instead of rematerialized with `movi` (`kst-*`: 1424.8, 1419.7, 1370.5 → 1445.3, 1407.2, 1420.3).

Along the way the run's re-emission (a plain `if` arm, where wasm checks the stack's height) found
the scalar double FMA leaving Veltkamp's `h` on the stack (twice an instruction): harmless where a
`return` or `br` followed, now set instead of teed. Correctness: the differential test, the FP suite
in the guest (`scripts/ci-fp.sh`), and planted bugs (each range test's bound one exponent long,
vector single and double, scalar; the scalar zero clause always true; its FZ test reading Vn twice;
the FZ arm dropping the operand test; the by-element product from a stale local), each failing
2–6 of the differential test's FP and NEON tests.

## M8-INTERP loop 0: the block interpreter's yardstick, profile and mix

2026-10-21, the dev VM, Chromium 153.0.8010.52, at `a6dcd65`; raw data `results/m8-interp-l0/`. The track's
yardstick (`M8-INTERP-HANDOVER.md`) is the block interpreter alone (`VmConfig.jit` 4 / `jit_new` never compiling):
the small guests, and now the boots as MIPS (`bench/boot` `boot_dec`, `boot_alpine_dec`: steps over the whole boot,
the steps checked against each other; one warm-up boot, then 7 and 3). The reference is the same guests under the
JIT on Liftoff alone (`--config liftoff-only`; `boot_mips_jit`, `boot_alpine_mips_jit`: compiling included).
`bench/interp/yardstick.sh` runs either set, `bench/interp/ab.sh` alternates core builds on it.

| | block interpreter | Liftoff (JIT, compile included) | |
|---|---|---|---|
| `dec_mips` / `jit_mips` (user mode, 8 placements) | 248.9 ±2.8 | 2627 ±43 | 0.09× |
| `vm_dec_flat_mips` / `vm_jit_flat_mips` (EL1, MMU off) | 198.4 ±1.7 | 1770 ±22 | 0.11× |
| `vm_dec_mmu_mips` / `vm_jit_mmu_mips` (EL1, MMU on) | 176.4 ±1.3 | 1725 ±20 | 0.10× |
| Buildroot boot (40,211,695 steps) | **89.5 ±1.6** (449 ms) | 60.2 ±0.4 (668 ms) | 1.49× |
| Alpine boot (2,651,936,453 steps) | **122.0 ±0.4** (21.7 s) | 244.4 ±0.1 (10.9 s) | 0.50× |

So the 1.5-2× gap to Liftoff the handover counted on is the boots' (cold code, compiling included); in a hot loop
Liftoff's code is ten times the interpreter's. On Buildroot's boot the interpreter alone already beats Liftoff.

**Profile** (`perf` with `--perf-prof` in Node, Alpine's boot under `jit` 4, `bench/interp/boot-node.ts`; 124.8
MIPS there): `run` (MMU) 67.1%, `jit::interpret` 13.3%, `Jit::miss` 2.5% and `Table::sync` 2.2% (with
`Cache::slot_in`, `count_out` and `counted`, 1.6%: a block reports its dispatches every 16, and under `jit` 4 it never
stops reporting), `Bus::write_el` 2.1% (stores whose inline TLB probe missed), `exec_at_op` 1.8% (the generic
path), `jit::steps` 1.3%, `sys::exec` 1.1% (`perf-alpine.txt`). In `run`'s machine code (`perf annotate`):
- the dispatch is a jump table (`cmp`, `ldrsw`, `br`) behind four loads of the micro-op's fields; the handlers'
  first instructions take ~20% of `run`'s samples, the indirect branch's redirect (the VM has no PMU to say how
  much of it is mispredicts);
- the loop's index, length and PC live on the stack: spilled at definition because the generic arm and the slow
  paths call, and reloaded every iteration (`ldr x8, [sp, #72]` 3.5% at the loop's back edge);
- every register write is a Rust bounds check on the index (`cmp w25, #0x1f; b.hi` to a panic) and a wasm bounds
  check that reloads the growable memory's size (`ldur x11, [x7, #39]; sub; cmp; b.cs`); loads aren't checked;
- `ldar`/`stlr` on guest accesses: 24 of them in `run`, 0.24% of its samples with the instruction after. **The
  atomics don't cost here**, so the memory rules stay.

**Mix** (`diag.patch`: a diagnostic core counting each decoded block's instructions, statically per block key and
dynamically by the block's runs in the interpreter; Alpine's boot in Node, `mix-alpine.txt`; Buildroot's,
`mix-buildroot.txt`). Alpine: 501M block runs, **5.3 instructions a block**, 125K blocks. Dynamically
`STR/LDR` (unsigned offset) 13.6%, `MOVZ` 10.0%, `B.cond` 8.1%, `STP/LDP` 6.7%, `ORR` (shifted, mostly `MOV`)
6.1%, `ADD` imm 5.6%, `SUBS` shifted 3.8% and imm 3.6%, `ADD` shifted 3.5%, `CBZ` 2.6%; 96% of the dynamic mix in
the first 45 classes. **The generic path is 3.5%** of the instructions: `MRS` 28% of it, `UMADDL` 17%, `DC ZVA`
8%, `EXTR` 4%, `REV` 3.5%, `DMB` 3.5%, `LDADD` 2.4%, `CLZ` 2.2%. The top pairs: `MOVZ+MOVZ` 6.7% (runs of
`MOV xN, #0`: `MOVZ+MOVZ+MOVZ` 5.4%), `STR+STR` 3.2%, `SUBS+B.cond` 2.8% (shifted) and 2.7% (imm), `STP+STP` 2.4%,
`ANDS+B.cond` 0.8%, `CCMP+B.cond` 0.6%, `ADRP+ADD` 0.5%: the compare-and-branch pairs together ~7%, no pair
dominant. Buildroot: 9.0M runs, 4.5 instructions a block, generic 4.0% (`MRS` 15%, the exclusives 28%, `DC ZVA`
8%, `EXTR` 7.5%, `REV` 7%). **Not counted: a browser's decoded blocks**: Firefox's pages session from the snapshot
with the diagnostic core never got its first guest command through (three tries; the same session with the base
core runs), and the boots' counts settled the order of the loops.

**What it says for the loops.** Blocks are short, so per-block costs (`interpret`'s 13%, the counting, `run`'s entry
and exit) weigh as much as per-instruction ones: loop 1 (one call-free loop) and loop 2 (the per-block lookups)
first; superinstructions (loop 4) have no dominant pair to fuse; the generic path (loop 5) is 3.5% of the
instructions, `MRS` and `UMADDL` first; lazy flags (loop 3) touch ~10% of the instructions (the flag setters and
their branches).

## M8-INTERP loop 1: a call-free hot loop

2026-10-21, the dev VM, Chromium 153.0.8010.52, two rounds alternating (`bench/interp/ab.sh`); raw data
`results/m8-interp-l1/`. `interp::block::hot` runs the decoded blocks and chains from each to the next in one loop
with no call on any path: no generic micro-op, no slow load or store (a TLB probe that misses, an unaligned access,
a misaligned SP base: `Fast::fast_ptr` and `mem::load_aligned`/`store_aligned`), no instruction-TLB walk
(`Fast::ikey`), no panic (register indexes masked, the slots a fixed-size array). What needs a call returns a
status (`SLOW`: the micro-op at `Run::u`, which `jit::interpret` runs through the old `run`, then calls `hot` again;
`NEXT`: the next block out of its slot or its key not in the TLB; `STOP`), and the loop's state goes back to a
`Run` in memory only then. Nothing returns through the shadow stack; the old `run` is the slow path.

| benchmark (MIPS) | base (round 1 · 2) | loop 1 (round 1 · 2) | |
|---|---|---|---|
| `dec_mips` (8 placements) | 247.0 ±1.2 · 248.3 ±2.2 | 310.5 ±1.0 · 310.5 ±3.6 | +25.7% |
| `vm_dec_flat_mips` | 197.5 ±0.5 · 197.3 ±0.5 | 307.0 ±3.7 · 309.5 ±1.4 | +55.6% |
| `vm_dec_mmu_mips` | 175.3 ±1.1 · 174.9 ±1.3 | 293.8 ±1.8 · 293.9 ±2.1 | +68.0% |
| Buildroot boot (`boot_dec_mips`) | 88.9 ±1.4 · 88.4 ±0.8 | 101.9 ±1.7 · 100.2 ±0.9 | +13.3% |
| Alpine boot (`boot_alpine_dec_mips`) | 121.5 ±0.2 · 122.4 ±0.3 | 143.5 ±0.1 · 143.7 ±3.8 | +18.1% |

Alpine's boot under `jit` 4 now 18.5 s (from 21.7); against Liftoff's 244 MIPS, 0.59× (from 0.50×). The steps are
the same (40,211,695 and 2,651,936,453). Correctness: the differential test runs every random block through `hot`
too (`run_hot`, `jit::interpret`'s driving), against `interp::steps`; a planted carry bug in `hot`'s ADDS/SUBS
failed it, and a planted same-page chaining bug (the next key's bit 2 dropped) kept the native Buildroot boot
through the block interpreter from powering off.

**On the Mac host** (`bench/interp/ab-mac.sh`, two rounds, `results/m8-interp-l1/mac/`; no explicit bounds checks
there): `dec_mips` 261.3 → 326.9 (+25.1%), `vm_dec_mmu_mips` 232.3 → 315.9 (+36.0%), Buildroot's boot 104.4 →
124.4 (+19.1%), Alpine's 138.2 → 149.9 (+8.5%). (`bench/run-mac.sh` copies `tools/svelte.ts` and the repo's
`node_modules` now: the server imports the Svelte compiler.)

## M8-INTERP loop 2 (and screens of loops 3-5): what the hot loop left

2026-10-21, the dev VM, Chromium 153.0.8010.52; each screen one round of `dec_mips` (8 placements) and
`boot_alpine_dec` per arm, with an A/A arm (a copy of the base) in each (`results/m8-interp-l2/scr*`, the variants'
diffs beside them). With `hot` call-free, what returns to the dispatcher matters: under `jit` 4 a block's quota of
16 dispatches runs out forever, and each report is a return, the dispatcher, the cache's lock and a sync.

| variant (screen 1, against loop 1: 309.9 / 142.1; A/A 309.9 / 142.0) | `dec_mips` | Alpine boot |
|---|---|---|
| `REPORT` 64 | 379.2 (+22.4%) | 157.6 (+10.9%) |
| `REPORT` 255 (`q255`) | 405.2 (+30.8%) | 163.5 (+15.0%) |
| no jump-cache check in `hot` (`nojc`: what pre-linked successors with a compiled bit would save at most) | 312.9 (+1.0%) | 144.2 (+1.5%) |
| lazy NZCV in `hot`'s locals (`lazy.patch`: SUBS/ADDS/ANDS keep kind and operands, B.cond, CSEL and CCMP read conditions from them, materialized at `hot`'s return) | 303.4 (−2.1%) | 136.3 (−4.1%) |
| flag setter + B.cond fused (`fuse.patch`: a mark on the setter, `hot` takes the branch with it; one dispatch for the pair) | 313.2 (+1.1%) | 143.3 (+0.8%) |
| lazy NZCV and fused | 285.7 (−7.8%) | 136.4 (−4.0%) |
| UMADDL & co, EXTR, RBIT/REV/CLZ and the literal load as handlers (`more.patch`) | 296.7 (−4.2%) | 143.7 (+1.1%) |

| variant (screen 2, against `q255`: 405.0 / 163.3; A/A 402.2 / 163.3) | `dec_mips` | Alpine boot |
|---|---|---|
| the micro-op copied whole, `repr(C)`, fields extracted (`copy.patch`: two loads instead of one a field) | 302.3 (−25.4%) | 151.9 (−7.0%) |
| fused setter + B.cond | 409.4 (+1.1%) | 165.4 (+1.2%) |
| the handlers | 383.9 (−5.2%) | 165.0 (+1.0%) |

**`REPORT` 255 under the JIT** (`scrj`: `boot_mips_jit`, `boot_alpine_mips_jit`, default config, two rounds) moved
what compiles: Alpine's boot made 26,537 regions of 56,414 blocks (from 22,247 of 56,362), 263 modules, and
interpreted 72.7M steps (from 29.2M); Buildroot's 5,232 regions (from 4,700) and ran 23% faster (the interpreter is
faster than Liftoff there), Alpine's +0.6%. The counts a block holds back are counts the cache doesn't see: a queued
block's steps (`BATCH_STEPS`) and a successor's hits (`warm`, the forward regions' members) come late. So **kept:
255 only where nothing compiles** (`REPORT_IDLE`: the cache off, or `jit` 4's threshold), and 16 in the JIT, whose
counters stay identical (`scrj2`: every count the same as loop 1's). Against loop 1, `dec_mips` +30%, Alpine's boot
under `jit` 4 +16%; this is bookkeeping that only the yardstick and native runs paid, not interpreting.

Screen 3, on `REPORT_IDLE` (402.4 / 165.3; A/A 406.6 / 164.1): the handlers without the literal load
(`moreH.patch`) 401.7 / 168.9 (+2.2% on the boot), the handlers in `run` only, `hot` sending them to the slow path
(`moreR.patch`) 406.9 / 165.9.

What lost, and why (none kept): **lazy NZCV** adds three loop-carried values to `hot`, and its conditions'
selects cost more than `cond_holds` on a stored NZCV; **the copied micro-op** makes TurboFan shuffle 16 bytes
through registers (the jump table then waits on the extraction); **pre-linked successors** can save at most what
`nojc` saved, 1-1.5%: the slot and jump-cache lookups are not what a block costs; **fusion** saves a dispatch for
~6% of the instructions, ~1% (repeated, under the 5% bar); **the literal load inline** slowed the user-mode guest
(each handler in `hot` is code the hot path carries).

## M8-INTERP loop 5: the generic path's commonest classes as handlers

2026-10-21, the dev VM, Chromium 153.0.8010.52, two rounds alternating; raw data `results/m8-interp-l5/`. Loop 0's
mix put `MRS` (28% of the generic path), `UMADDL` & co (17%), `EXTR` (4%) and `REV`/`CLZ` (6%) first. `K::Maddl`
(UMADDL, SMADDL, UMSUBL, SMSUBL), `K::Extr` (no `u128`: compiler-rt's shifts are calls) and `K::Bit1` (RBIT,
REV16, REV32, REV, CLZ), in `run` and in `hot`; the literal load stays on the slow path (inline, it cost the
user-mode guest 4-5% in two screens). `MRS` isn't a handler: its plain registers are a fraction of a `sys::read`
that also reads the timers, and the screens left no room for it.

| benchmark (MIPS) | loop 2 (round 1 · 2) | handlers (round 1 · 2) | |
|---|---|---|---|
| `dec_mips` | 405.6 ±3.7 · 404.5 ±2.8 | 405.3 ±2.7 · 405.2 ±1.8 | +0.2% |
| `vm_dec_flat_mips` | 402.3 ±3.6 · 404.0 ±3.0 | 405.6 ±3.3 · 406.7 ±2.2 | +0.8% |
| `vm_dec_mmu_mips` | 389.4 ±2.8 · 393.2 ±5.6 | 396.0 ±1.6 · 391.2 ±10.6 | +0.5% |
| Buildroot boot | 112.0 ±1.5 · 110.8 ±3.1 | 114.0 ±2.0 · 113.1 ±1.6 | +2.1% |
| Alpine boot | 162.8 ±0.2 · 163.2 ±0.1 | 167.4 ±0.1 · 166.9 ±0.1 | +2.5% |

Under the 5% bar, but the third time in a row on the boots (screen 3: +2.2%), with the small guests flat: kept.
The differential test draws the new classes; a planted EXTR bug (the high word shifted one short) and a planted
UMSUBL bug (the sign bit read for the subtract) each failed it.

**Loops 2 and 5 on the Mac host** (one round, `results/m8-interp-l5/mac/`, against loop 1): `dec_mips` 326.6 →
426.7 (+30.6%), `vm_dec_mmu_mips` 314.2 → 403.6 (+28.4%), Buildroot's boot 124.7 → 143.9 (+15.4%), Alpine's 156.5
→ 182.1 (+16.3%). From the track's start (loop 0's base on the Mac: 261.3, 232.3, 104.4, 138.2): +63%, +74%, +38%,
+32%.

## M8-INTERP loop 6: the compile threshold's floor, 50 → 500

2026-10-21, the dev VM, Chromium 153.0.8010.52, loop 5's core with the pressure-driven threshold's floor
(`Config::DEFAULT.threshold`) at 50 (the base), 100, 200 and 500, `threshold_max` 1000 as before; raw data
`results/m8-interp-l6/`. Screens first (one round), then 50 against the winners.

| JIT workload | floor 50 | 100 | 200 | 500 |
|---|---|---|---|---|
| Alpine boot, MIPS (`boot_alpine_mips_jit`) | 355.1 | 368.6 (+3.8%) | 379.4 (+6.8%) | 383.8 (+8.1%) |
| its wasm, MB / regions | 27.6 / 22,247 | 23.9 / 18,475 | 20.6 / 15,129 | 15.8 / 10,903 |
| Alpine userspace benchmark, total ms | 16,630 | 16,781 (+0.9%) | 16,181 (−2.7%) | 15,934 (−4.2%) |
| its wasm, MB (boot included) | 32.8 | 28.6 | 25.2 | 21.2 |
| churn page from the snapshot: wasm MB / modules | 532 (A/A 529) / 23,088 | 478 / 22,599 | 429 / 22,210 | **363** / 21,637 |
| churn: first flush, s / `doneS` / busy MIPS | 58 / 120.5 / 217 (A/A 57 / 120.5 / 222) | 71 / 120.7 / 224 | 82 / 114.3 / 228 | **99 / 114.1 / 231** |
| churn: interpreted G steps / lock acquisitions | 2.97 / 40.6M | 3.35 / 44.9M | 3.80 / 49.8M | 4.53 / 58.4M |

Firefox's pages session from the snapshot, two rounds alternating (`pages/`; no flush at 320 MiB in any):

| | floor 50 | 200 | 500 |
|---|---|---|---|
| wasm compiled, MB | 271, 270 | 225, 225 (−17%) | 218, 218 (−19%) |
| V8's wasm code, median MB | 886, 884 | 664, 685 (−24%) | 601, 589 (−33%) |
| the renderer's RSS, median MB | 4,861, 4,945 | 4,354, 4,385 (−11%) | 4,380, 4,131 (−13%) |
| modules | 2,802, 2,810 | 2,812, 2,811 | 2,914, 2,894 (+3.5%) |
| busy MIPS | 181, 180 | 189, 187 (+4%) | 184, 185 (+2.5%) |
| the wiki page's / BBC's load, s | 14.8 / 13.1, 15.0 / 12.8 | 13.6 / 12.8, 13.6 / 12.1 | 13.7 / 13.3, 13.9 / 12.9 |
| interpreted, G steps | 1.13, 1.11 | 1.63, 1.64 | 2.13, 2.13 |

Chromium in Debian, 4 vCPUs (`apps/`, one boot each, three renders of `chrome://newtab`): floor 50 32.1, 15.4,
11.2 s (111.2 MiB of wasm in the first render); 500 29.3, 11.7, 10.8 s (70.4 MiB, −37%). The 4-vCPU `go build`
loop from `debian-go.webpcsnap` (`go/`, 300 s, MIPS median of the 5 s samples): 50 1,431 and 1,243; 200 1,291
(one session); 500 1,351 and 1,193: −4 to −6%, inside the loop's session-to-session spread (13% here) but behind
both times. The gates (`gates/`, one round): `smp_alpine_jit` to the script 5,961 / 5,406 / 5,411 → 5,393 /
4,861 / 4,859 ms at 1 / 2 / 4 vCPUs (−10%), to power-off −7.5%; `smp_user_jit_4` 17,484 → 16,749 ms (−4.2%), every
phase faster; Buildroot's boot under the JIT 72.9 → 105.2 MIPS (+44%: the interpreter beats Liftoff there).

**Kept: the floor at 500.** The interpreter's 1.3-1.9× (loops 1, 2, 5) moved the trade the October sweep made
(`../boot/REPORT.md` "M8: a compile threshold that follows the code cache's pressure": then 500 lost 1.5-6% on the
userspace phases and Chromium's renders): now every workload but the `go build` loop is faster at 500, and every one
compiles a fifth to two fifths less code. The cost is in the counting: a block reports 31 times before it compiles
(lock acquisitions +44% on the churn page, +54% in the pages session), which "longer reports far from the
threshold" (docs/jit.md "Tried and not kept") would address.

**On the Mac host** (one round, `results/m8-interp-l6/mac/`): Alpine's boot 501.1 → 526.7 MIPS (+5.1%), Buildroot's
99.6 → 141.7 (+42%), the userspace benchmark 13,162 → 12,854 ms (−2.3%: Lua −2.7%, its process churn +5.9%).
Correctness: `scripts/ci.sh` (a unit test of the pressure's steps now sets its floor of 50 itself) and
`scripts/ci-debian.sh` pass; the steps don't move (a threshold changes what compiles, not what runs).

## M8-INTERP loop 4: superinstructions, a run of MOVs in one dispatch

2026-10-21, the dev VM, Chromium 153.0.8010.52; raw data `results/m8-interp-l4/` (`scr4/` the screen). Loop 0's
mix has no dominant pair; its largest were `MOVZ+MOVZ` (6.7%, mostly runs: `MOVZ+MOVZ+MOVZ` 5.4%) and the flag
setters with their B.cond (~6% together, loop 2's `fuse`: +1%). Screen 4 (one round, against loop 6's core:
405.9 / 167.3 / 113.6 for `dec_mips` / Alpine / Buildroot; A/A 403.9 / 167.6 / 114.0): **MOV runs** (each MovI
carries the number of MovIs right after it, `mov_runs` at decode, and `hot` writes them all in its dispatch, never
past the prefix) 424.9 / 171.4 / 114.1; MOV runs with the fused setter and B.cond (`fuse-movrun.patch`) 408.6 /
166.4 / 111.3. Then MOV runs against the base, two rounds:

| benchmark (MIPS) | loop 6 (round 1 · 2) | MOV runs (round 1 · 2) | |
|---|---|---|---|
| `dec_mips` | 404.2 ±3.6 · 405.7 ±2.5 | 425.0 ±3.4 · 423.5 ±4.9 | +4.8% |
| `vm_dec_flat_mips` | 406.6 ±1.9 · 407.7 ±2.6 | 424.4 ±2.5 · 415.7 ±10.1 | +2.2% |
| `vm_dec_mmu_mips` | 395.9 ±4.7 · 391.5 ±1.8 | 411.9 ±1.7 · 412.0 ±1.3 | +5.2% |
| Buildroot boot | 114.0 ±1.0 · 113.1 ±1.2 | 114.1 ±1.2 · 114.3 ±2.2 | +0.9% |
| Alpine boot | 168.1 ±0.2 · 167.7 ±0.2 | 171.8 ±0.2 · 171.5 ±0.1 | +2.2% |

Kept. The two fusions together lost (the fused setter's test sits in five handlers, the MOV run's in one). A planted
bug (each MOV of a run writing the first one's value) failed the differential test; a run not bounded by the prefix
didn't (random blocks rarely end a prefix inside a run), so `a_mov_run_stops_at_the_prefix` covers it and fails
with that bug.
