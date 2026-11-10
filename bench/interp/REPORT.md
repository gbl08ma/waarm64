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

## FMA through the host's fused op

2026-11-01, the dev VM (M4, arm64 Linux under Lima), Chromium 153.0.8010.52, one session, the two arms of
one build (`a46f67f`, the JSONs' `dirty` is their own untracked directory) alternated with `--query=fma=emul`, three
rounds, the order swapped each round; raw data `results/fma-fused/` (and `../boot/results/fma-fused/`). The JIT's
FMA forms use relaxed SIMD's `madd` where the host fuses it ([docs/jit.md](../../docs/jit.md) "Floating point", FMA).

| workload | emulated (3 rounds) | fused (3 rounds) | change |
|---|---|---|---|
| `jit_fp_mips`, eight placements (MIPS; IQR ≤ 58) | 1403.5, 1400.6, 1399.8 | 2651.6, 2663.1, 2665.8 | **+90%** |
| `gl_llvmpipe_jit` (ms a frame; IQR ≤ 6.3; 9,924,256,938 steps on both) | 266.6, 268.2, 265.6 | 257.4, 255.0, 255.4 | **-4.2%** |
| `alpine_user_jit`, total (ms; IQR ≤ 335) | 13,622, 13,603, 13,585 | 13,647, 13,596, 13,786 | none: the rounds overlap |

The GL guest ran on the `alpine-gl` image of 2026-10-14, which `images/build.sh --check` calls stale; both arms used
it. Beside the benchmarks, the FP suite took 78.1 s on the fused arm, 139.9 s on the emulation (`scripts/ci-fp.sh`).

**Exploration.** Counted from the emitter, lane ops an instruction: FMLA 2D ~64 → ~5 (the emulation's 42, its factor
bound's 17); FMLA 4S ~23 → ~5 (promotes, shuffles, the midpoint test). The backlog's ~10% for doubles was far short:
the FP guest's time is mostly these forms. V8's source (14.6-lkgr, Node's; 15.3-lkgr, Chromium 153's): Liftoff compiles
`Qfma`/`Qfms` itself; arm64 emits `fmla`/`fmls` in both tiers; x86-64's tiers share one macro keyed on
`CpuFeatures::IsSupported(FMA3)`. Probed through `madd` and `nmadd` of both lane types, 200,000 calls each:

| host | default | `--liftoff-only` | `--no-liftoff` | `--no-enable-fma3` |
|---|---|---|---|---|
| M4, Node 26.7, Chromium 153 | fused | fused | fused | n/a |
| x64 Node, qemu-user Haswell (2,000 calls) | fused | fused | fused | unfused |
| x64 Node, qemu-user Nehalem (2,000 calls) | unfused | unfused | unfused | unfused |

`jit-diff`'s FMA classes and edge cases pass on both of those x64 hosts under qemu (512 words a class). qemu's FMA isn't a
real CPU's, but the lowering, the probe's answer and the arm chosen are real.

**Not measured.** No x86 host: the gain there, where `vfmadd` and the emulation's SSE/AVX ops cost otherwise, is
unknown. Firefox's and Safari's tiers rest on the spec's "fixed" sentence, unverified.

**Next**, by promise: the scalar and double zero results still reach the helper, as in the emulation (a zero product
and addend could be taken as the vector single does, with the same clause); `relaxed_trunc` on x86 (backlog); what's
left of the FP guest is now the "Scalar FP in f64 and f32 locals" item's (backlog), worth re-profiling.

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
- `ldar`/`stlr` on guest accesses: 24 of them in `run`; `perf`'s cycle samples on them plus the instruction after
  each were 0.24% of `run`'s, on the M4, where acquire/release is nearly free. That's all it shows; what it doesn't cover: x86_64 (the user's desktop and most users), where wasm's
  sequentially consistent stores compile to `xchg` (or `mov` + `mfence`, ~20+ cycles) and loads to plain `mov`, never
  measured; the guest accesses outside `run` (the slow paths, the table walker, instruction fetch); and M7 loop 6's
  history, the interpreter with the MMU on 88.7 → 79.0 MIPS when the accesses became atomics, half alignment test
  and half ordering, on the M4.
  The memory rules stay until an x86_64 A/B (handover "Next").

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
core runs), and the boots' counts settled the order of the loops. (Later: the vCPU worker had crashed on the shim,
a `Uint8Array` at a heap pointer past 2 GiB read as a negative offset; the patch has `p >>> 0` now.)

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

### Loop 6 continued: one report from `warm` to the threshold

At a floor of 500 a block reported every 16 dispatches, 31 times before it compiled. Now a block reports every 16
until it has run `warm` (16, what a forward region's members need the cache to have seen), and then once more at
the threshold (at most 255 at a time: a slot's quota); queued blocks still report every 16 (`BATCH_STEPS`).
Against loop 4's core (`results/m8-interp-l6/rep*`):

| | before | one report to the threshold |
|---|---|---|
| Firefox's pages session, two rounds: wasm MB / V8's code, median MB | 216, 217 / 589, 613 | **172, 173** / 475, 495 (−20%) |
| … busy MIPS / the wiki's and BBC's loads, s | 176, 187 / 14.5, 13.9 and 14.2, 13.2 | **194, 193** / 11.9, 12.1 and 12.6, 11.9 |
| … the cache's lock acquisitions / the renderer's RSS, median MB | 34.4M, 34.4M / 4,227, 4,258 | 17.6M, 17.5M / 4,021, 4,066 |
| churn page: busy MIPS / `doneS` / lock acquisitions / wasm MB | 234 / 115.7 / 58.8M / 362 | 243 / 114.0 / 28.2M / 363 |
| Alpine userspace benchmark (two rounds), total ms | 16,039, 16,316 | 16,302, 15,878 (even) |
| `smp_alpine_jit` to the script at 1 / 2 / 4 vCPUs, ms | 5,405 / 4,855 / 4,899 | 5,294 / 4,697 / 4,598 (−2 to −6%) |
| `smp_user_jit_4` total, ms | 17,027 | 16,261 (−4.5%) |
| `go build` loop, MIPS (one session) | 1,392 | 1,434 |
| Alpine's boot under the JIT, MIPS / regions, blocks in them | 393.7 / 10,903, 32,123 | 394.5 / 11,139, 31,563 |

Kept. It moves what compiles (the cache sees a block's counts between `warm` and the threshold only at the
threshold, so the batches gather differently: Firefox compiled a fifth less), unlike loop 2's 255 everywhere,
which hid the counts below `warm` too and slowed the batches (Alpine interpreted 2.5× the steps); here Alpine's
boot interpreted the same 104M steps.

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
with that bug. **On the Mac host** (one round, `results/m8-interp-l4/mac/`): `dec_mips` 427.1 → 440.8 (+3.2%),
`vm_dec_mmu_mips` 406.5 → 416.5 (+2.5%), Buildroot's boot 130.9 → 144.8 (+10.6%), Alpine's 175.6 → 185.7 (+5.7%).

## M8-INTERP round 2: the floor's curve, and more handlers

2026-10-21 (08:00-09:40), the dev VM, Chromium 153.0.8010.52, on main at `b2fdaea` (floor 500, one report from
`warm`); raw data `results/m8-interp-r2/`. The floor at 250, 500, 1000 and 2000 (`threshold_max` the larger of 1000
and the floor, so at 1000 and 2000 pressure no longer raises it), one round each unless said:

| | 250 | 500 | 1000 | 2000 |
|---|---|---|---|---|
| churn: wasm MB / modules | 410 / 22,608 | 368, 362 (A/A) / 22,310 | 335 / 21,978 | **233** / 20,987 |
| churn: first flush, s / `doneS` / busy MIPS | 91 / 127.9 / 201 | 100, 94 / 121.5, 113.9 / 222, 235 | 104 / 114.2 / 237 | none / 107.8 / 253 |
| pages: wasm MB / V8 code median MB / RSS median MB | 189 / 596 / 4,239 | 169 / 500 / 4,069 | 164 / 458 / 3,973 | **132 / 361 / 3,684** |
| pages: busy MIPS / wiki, BBC load s | 179 / 13.7, 13.4 | 179 / 12.3, 13.7 | **196** / 11.4, 11.6 | 195 / 10.8, 12.8 |
| Alpine boot under the JIT, MIPS (regions) | | 402.6 (11,139) | 405.4 (8,395) | 395.0 (6,189) |
| Alpine userspace, total ms | | 15,835 | 15,711 (−0.8%) | 16,196 (+2.3%; compress +4.9%) |
| `smp_user_jit_4`, total ms | | 16,210 | 15,901 (−1.9%) | 15,954 (−1.6%) |
| `go build` loop, MIPS by session | 50: 1,489, 1,094 | 1,454, 1,370, 1,382 | 1,455, 1,409 | 1,326, 1,370 |

The `go build` loop's sessions spread 1,094-1,489 at one floor, so its earlier "−4 to −6% at 500" is noise: across
eight sessions in two rounds, 50 gave 1,431, 1,243, 1,489, 1,094 and 500 1,351, 1,193, 1,454, 1,370, 1,382 (the
first two of each before the report change). **Kept: the floor at 1000.** Against 500 it compiles less (churn −9%,
pages −3%, V8's code −8%) and is as fast or faster everywhere measured; 2000 compiles least (pages −22%) but loses on
Alpine's userspace and boot and on the `go build` loop.

**Handlers** (one round, against `b2fdaea`: `dec_mips` / Alpine / Buildroot 424.7 / 171.0 / 112.7; the diffs in
`handlers/`): MRS of the registers `sys::plain` knows at the block's EL (`uop_el`, the JIT's inline set) 423.4 /
172.4 / 114.8; the SIMD&FP single and pair loads and stores (B to Q, offset, pre, post) 425.0 / 171.0 / 112.4; LSE
LD<op> and SWP of W and X registers (a CAS loop inline) 424.9 / 171.8 / 114.3; all three 424.5 / 173.6 / 113.6. All
three again, two rounds (`handlers-ab/`): Alpine's boot 167.7, 170.9 → 173.2, 173.9 (+3.2%), Buildroot's 112.2,
114.2 → 114.4, 115.2 (+1.9%), `dec_mips` 424.6, 424.0 → 424.0, 425.3, `vm_dec_mmu_mips` 411.0, 411.3 → 409.7, 408.3
(−0.7%). **Kept, all three** (as loop 5: under the bar, repeated on the boots, the small guests flat). Planted bugs
(LDCLR as AND, a Q pair's second register given the first value) each failed the differential test; MRS has
`an_mrs_runs_as_the_interpreter_runs_it`, every key `sys::plain` knows at EL0 and EL1.

**On the Mac host** (one round each, `results/m8-interp-r2/mac/`): the handlers, Alpine's boot under `jit` 4 185.6
→ 188.2 (+1.4%), Buildroot's 141.3 → 145.1 (+2.7%), `dec_mips` 438.9 → 440.1. The floor of 1000 against 500: Alpine's
boot under the JIT 544.2 → 533.2 MIPS (−2.0%), the userspace benchmark 12,738 → 12,820 ms (+0.6%): not the dev VM's
small gain; one round, within the session's spread, but the Mac doesn't confirm 1000 over 500 on Alpine (its
browser workloads, where 1000's case rests, weren't run there).

## M8-INTERP loop 8: `hot` re-profiled, the access path, superinstructions, LSE as single atomics

2026-10-21 (18:40-21:00), the dev VM, Chromium 153.0.8010.52, on main at `14e8cbf`; raw data
`results/m8-interp-l8/` (`abN/` one A/B each, three rounds alternated; the dropped variants' diffs against
`14e8cbf`). Judged by the noise floor this loop set (docs/benchmarking.md "Rules"): a build's per-round medians
stayed within ~0.5% (Buildroot's boot 2-3%), so a difference counts when the arms' rounds don't overlap and it's
past ~1%.

**The profile** (`perf` with `--perf-prof` in Node, Alpine's boot under `jit` 4, `bench/interp/boot-node.ts`,
189 MIPS; `perf-alpine.txt`, `hot-annotate.txt`): `hot` 81.5% of the samples, `Bus::write_el` 2.6%,
`jit::interpret` 2.3%, `exec_at_op` 1.7%. In `hot`'s machine code:
- **~30% is the dispatch, whatever the kind:** V8's interrupt check at the inner loop's head (`ldurb [x26, #-207];
  cbnz`, its slow path out of line), the micro-op's four field loads, the jump table's bounds check and `br` (10.2%
  together); each handler's first instruction (the indirect branch's redirect, 15-20% summed over the handlers);
  the back edge 4.7%, 2.7 points of it reloading `end` from the stack (spilled: the interrupt check's slow path
  calls).
- **Loads and stores ~30%:** the single-register handler 20% (mode, extension and size switches; SCTLR_EL1,
  PSTATE and the TLB's pointer re-read every access), the pairs 10%. Then AddR 6.8%, Mov 4.2%, MovI 3.3%, AddI64
  2.7%; chaining between blocks 8.9% and a block's entry 2.7%; the exits to the slow path 3.6%.

**Variants** (each against the one before it that was kept):

| | Alpine's boot | Buildroot's boot | `dec_mips` | `vm_dec_mmu_mips` | |
|---|---|---|---|---|---|
| v1: the access path's invariants once a `hot` call (`Fast::ctx`) | **+2.5%** | +2.3% | +0.1% | **+3.9%** | kept |
| v2: an `End` micro-op after each block, no `u == end` test | −2.7% | −2.6% | −4.8% | −13.3% | not |
| v3: `LdO`/`StO`, offset loads and stores of 4 or 8 bytes, own handler | **+1.4%** | +1.2% | **+4.1%** | **+4.5%** | kept |
| v4: runs of LdO/StO in one dispatch, a loop (as the MOV runs) | −0.6% | −1.6% | −8.2% | −8.4% | not |
| v4b: pairs of LdO/StO, straight-line | +0.8% | −0.4% | −0.2% | +0.3% | (below) |
| LSE: add, clear, xor, set, swap as one atomic op | 0.0% | | +0.6% | +0.3% | kept |
| v5: v4b and STP+STP pairs | +0.2% | −0.1% | −0.5% | −0.5% | not |

v2: the compare was cheap and predicted, the sentinel one more indirect dispatch a block (blocks are a few
instructions). v4: the loop's code slowed `hot` everywhere, as the literal load did in loop 2. The LSE change, on
the 4-vCPU userspace benchmark too (`smp_user_jit_4`, `ab5/`): total 15,806 against 15,751 ms, every phase's rounds
overlapping; hot atomics are compiled, so the interpreter's and the slow paths' CAS loops weren't a cost. Kept for
what it is (no retry loop under contention, the five common ops as the JIT does them).

**The final build** (`ab8/`, against main and against itself without the pairs, one session):

| benchmark (MIPS) | main | without the pairs | **loop 8** |
|---|---|---|---|
| `dec_mips` | 424.7 · 426.7 · 425.9 | 441.7 · 441.6 · 443.7 | **446.9 · 447.6 · 447.9** (+5.1%) |
| `vm_dec_flat_mips` | 422.6 · 425.1 · 424.7 | 442.6 · 443.8 · 444.1 | **443.6 · 445.2 · 445.0** (+4.8%) |
| `vm_dec_mmu_mips` | 407.2 · 403.7 · 408.6 | 439.6 · 439.5 · 440.9 | **442.0 · 439.0 · 441.0** (+8.3%) |
| Buildroot's boot | 117.0 · 119.2 · 118.2 | 121.6 · 122.1 · 122.9 | **123.0 · 122.7 · 122.9** (+4.0%) |
| Alpine's boot | 175.8 · 176.2 · 176.2 | 182.3 · 182.8 · 183.3 | **183.9 · 184.1 · 184.1** (+4.5%) |

The pairs over the build without them: Alpine's boot +0.7% and `dec_mips` +1.3% with disjoint rounds, as in `ab7/`
(+0.7%, +0.8%): repeated, so kept. Planted bugs: every access looked up in the read array (the native boot through
the block interpreter never powers off); LdO/StO always 8 bytes (the differential test); a pair not stopped at the
prefix (only `a_store_pair_stops_at_the_prefix`, new: random blocks rarely end a prefix inside a pair); LDCLR as AND
(`mem::tests::rmw_ops_are_lse`, new, and `interp::tests::lse`). The context's EL flipped passed the boot: a
flipped entry mostly misses and takes the slow path, so it isn't a useful plant.

## M8-INTERP loop 9: the floor on the Mac, the exclusives and barriers as handlers

2026-10-21 (21:15-22:00), on main at `17f02ac`; raw data `results/m8-interp-l9/`.

**The floor of 1000 on the Mac host** (Next 1; `mac/`, `bench/interp/ab-mac.sh`, three rounds alternated, 500
against 1000, Chrome for Testing on macOS 26):

| benchmark | floor 500 (rounds; median) | floor 1000 |
|---|---|---|
| Alpine's boot under the JIT, MIPS | 569.3 · 558.6 · 551.7; **558.6** | 559.1 · 553.9 · 553.0; **553.9** (−0.9%) |
| Alpine's userspace, total ms | 11,911 · 12,080 · 12,215; **12,080** | 12,087 · 12,220 · 12,175; **12,175** (+0.8%) |
| Buildroot's boot under the JIT, MIPS | 157.9 · 155.2 · 155.8; **155.8** | 164.3 · 161.5 · 162.9; **162.9** (+4.6%) |

Alpine's boot and userspace: the arms' rounds overlap (both drift down over the session), no difference; round 2's
one-round −2.0% was that drift. Buildroot's boot: 1000 faster in every round, past its ~3% bar. **The floor of
1000 stays.** Its browser case (less wasm, the pages session's busy MIPS) is counts that don't depend on the host;
the pages session wasn't run on the Mac.

**LDXR/LDAXR/LDAR, STXR/STLXR/STLR, DMB and DC ZVA as handlers** (Next 7; `excl/`, three rounds alternated on the
yardstick): `Ldx` and `Stx` (the monitor stays in the `Cpu`; the store-exclusive a CAS on the TLB's pointer when the
monitor is armed for its address and size, no access when it isn't), `Dmb` (a fence) and `Zva` (eight stores, DZE
checked at EL0); anything else (a TLB miss, a misaligned address, an SP base off 16) takes the slow path, the
interpreter's. Against main:

| benchmark (MIPS) | main | **handlers** |
|---|---|---|
| `dec_mips` | 446.7 · 447.2 · 447.4 | 446.1 · 446.4 · 445.9 (−0.2%) |
| `vm_dec_flat_mips` | 444.5 · 445.0 · 443.0 | 446.8 · 444.6 · 446.5 (+0.4%) |
| `vm_dec_mmu_mips` | 441.3 · 441.6 · 441.2 | 439.9 · 442.1 · 432.9 (−0.3%) |
| Buildroot's boot | 123.5 · 123.9 · 123.1 | **134.2 · 134.5 · 134.3 (+8.7%)** |
| Alpine's boot | 185.4 · 184.9 · 185.0 | **195.6 · 195.5 · 195.2 (+5.7%)** |

Loop 0's mix put these at ~1.3% of Buildroot's instructions and ~0.4% of Alpine's, so ~1% was expected. Not the
chain: blocks that end on a generic micro-op are rare (0.15% of the block runs in loop 10's browser count). What a
generic micro-op costs is `hot`'s exit and re-entry around it (its state written back, `run`'s call, the context
recomputed), many times a handled one's: by these numbers ~14× on Alpine's boot. Planted bugs, each failing the
differential test (which now draws the eight classes, an armed monitor half the time, on what a register points at,
and `SCTLR_EL1.DZE` off a quarter of the time): STXR's status inverted, LDXR not arming the monitor, DC ZVA
zeroing 56 bytes, STLR always 8 bytes, a failed STXR leaving the monitor armed.

## M8-INTERP loop 10: a browser's mix, its handlers, and what decoding costs

2026-10-21 (22:00-23:30), the dev VM, Chromium 153.0.8010.52, on main at `99769f4`; raw data
`results/m8-interp-l9/` (`mix/`, `fp/`, `pages-fp/`, `decode/`).

**A browser's mix** (Next 3; `mix/`: `diag.patch`, loop 0's diagnostic ported to `hot`, with the generic classes
that end their block counted too, through Firefox's pages session from `pages.webpcsnap`, 4 vCPUs): 3.36G
interpreted instructions in 654M block runs; **the generic path is 1.89% of them** (Alpine's boot had 3.46% before
loops 5-9), spread thin: MRS 8.9% of it (registers `sys::plain` doesn't know at the block's EL), FCMP 8.0%, FMOV
(general) 7.3%, MOVI 6.8%, FMUL 5.7%, FADD 4.7%, ADD (vector) 3.1%, FCSEL 2.8%, BFM 2.6%, then a long tail of
scalar FP and NEON under 2% each. Blocks ending on a generic micro-op: 0.95M of the 654M runs (WFE, ISB, SEVL,
MSR first). The decoded blocks: 12.9M decodes of 5.1M keys over the four tables.

**Its handlers, not kept** (`fp/fp-simd-handlers.patch`): BFM; FMOV immediate, register and general; MOVI/MVNI;
FCSEL; vector AND/BIC/ORR/ORN/EOR and ADD; DUP (general); the register-offset SIMD&FP loads and stores; FCMP/FCMPE
(NaNs and FZ to the slow path); FMUL/FDIV/FADD/FSUB of S and D on the JIT's fast-path rules (RNE, IXC already set,
FZ clear; a result normal above the smallest binade, else the slow path). Planted bugs failed the differential test
(given edge values: NaNs, infinities, denormals, products near the smallest normal) and a directed test (a product
that rounds up to the smallest normal is tiny before rounding: UFC). Measured:

| | loop 9 | handlers |
|---|---|---|
| `dec_mips` / `vm_dec_flat_mips` / `vm_dec_mmu_mips` (medians of 3 rounds) | 446.6 / 445.3 / 442.1 | 442.0 / 441.5 / 433.5 (−1.0%, −0.9%, −2.0%, disjoint) |
| Buildroot's / Alpine's boot | 132.8 / 194.7 | 132.4 / 195.1 |
| pages session: busy MIPS (3 rounds) | 199, 199, 198 | 202, 199, 202 |
| pages session: wiki, BBC load s | 10.0, 10.1, 10.4; 11.8, 11.8, 11.3 | 11.2, 11.4, 11.3; 11.5, 12.2, 11.9 |
| pages session: interpreted G steps | 3.36, 3.36, 3.36 | 3.35, 3.37, 3.35 |

The code they add to `hot` costs the integer paths 1-2% (as the literal load did in loop 2), and the browser's
interpreted share is too small for the 1.9% to pay it back: busy MIPS overlap, the wiki page loaded slower in every
round (page loads have moved ~1 s between sessions before, so not taken as a loss either). The FP handlers' fast
paths would pay only where cold FP code runs long in the interpreter, which nothing measured does.

**What decoding costs** (Next 2, loop 7's case; `decode/`, `dect.patch`: each decode timed with `now_ms`):
Firefox's pages session, the four tables 2.75M, 3.16M, 3.62M and 3.15M decodes (3-4 restarts each) in 1.55, 1.80,
2.04 and 1.79 s, ~0.6% of each vCPU's 320 s; Chromium in Debian on 4 vCPUs (`bench/apps/chromium.ts`, the boot and
three renders of the new tab page, now 22.7, 10.4 and 9.7 s), ~1.4-1.8M decodes a table in 0.8-0.95 s, ~1.1% of
the run. A decode is ~0.55 µs. **Loop 7 not built:** one store for every table saves at most the decodes another
table already made, under 1% here, for a lock-free shared arena with epochs, a page generation against stale
inserts and a heap reservation. Since the arenas were sized (2026-10-09: the renders took 45, 28, 26 s), the JIT
compiles most of what the renders run, and decoding stopped being where their time goes.

## M8-INTERP loop 11: a steadier Go gate, and the threshold's maximum at 2000

2026-10-21/22 (23:00-01:40), the dev VM, Chromium 153.0.8010.52, on main at `1e1ac79`; raw data
`results/m8-interp-l9/` (`go-aa/`, `churn/`, `pages-max/`, `gates/`, `go-max/`).

**The `go build` loop as a gate** (Next 6): judged by its build times, not its MIPS samples. `bench/stress/go-ab.sh`
alternates cores through 420 s sessions from `debian-go.webpcsnap`, the guest timing each build of `/work/hello` in
ms; `bench/stress/gobuild.ts` takes each session's median build after the first three (the cold ones). The builds
in round 2's earlier boot sessions, at 1 s resolution, already agreed: 38, 38, 38, 38, 36, 37, 39, 39 s, where the
same sessions' MIPS samples had spread 1,094-1,489. An A/A of main (`go-aa/`, two copies, two rounds each): 33.81,
31.80, 31.71, 31.81 s: the run's first session 6.6% slower, the three after it within 0.3%. The driver runs a
warm-up session first and drops it (the next run's warm-up wasn't slower: 32.29 s against 31.94-32.51).

**The floor and the maximum** (Next 5; floor/maximum, the churn page from `pages.webpcsnap`, one round):

| | 1000/1000 (main) | A/A | 1500/1500 | **1000/2000** | 1000/4000 | 1500/3000 |
|---|---|---|---|---|---|---|
| churn: flushes / wasm MB | 1 / 339 | 1 / 339 | 0 / 265 | **0 / 264** | 0 / 234 | 0 / 226 |
| churn: compiled share / `doneS` | 0.924 / 102.1 | 0.924 / 108.4 | 0.914 / 102.0 | 0.914 / 102.0 | 0.904 / 108.0 | 0.902 / 107.9 |

The maximum does under pressure what a higher floor does (the threshold doubles from 3/8 of the cache, 120 MiB, so
a boot's ~60 MiB never meets it), and keeps 1000 for cold code. Firefox's pages session, two rounds alternated:

| | 1000/1000 | **1000/2000** | 1000/4000 |
|---|---|---|---|
| wasm MB | 158, 158 | **138, 138** (−13%) | 137, 138 |
| V8's code, median MB | 463, 472 | **427, 420** (−10%) | 429, 419 |
| the renderer's RSS, median MB | 3,951, 3,943 | 3,845, 3,843 | 3,839, 3,793 |
| busy MIPS | 190, 192 | **203, 201** (+6%) | 191, 202 |
| wiki, BBC load s | 11.2, 11.1; 12.5, 13.4 | 10.9, 11.4; 11.4, 11.7 | 10.9, 11.3; 13.2, 12.6 |
| interpreted G steps | 3.37, 3.37 | 3.55, 3.57 | 3.53, 3.56 |

4000 compiled no less than 2000 here (pressure never takes the threshold past 2000 in this session). The gates,
1000/2000 against main (`gates/`, three rounds alternated): Alpine's boot under the JIT 418.8 → 417.0 MIPS (−0.4%),
its userspace 14,975 → 14,925 ms (−0.3%), `smp_user_jit_4` 15,801 → 15,715 ms (−0.5%), every phase's rounds
overlapping; the `go build` loop (`go-max/`, two rounds after a warm-up) 32.51, 31.94 → 32.06, 32.03 s.
**Kept: `threshold_max` 2000** (`jit::Config::DEFAULT`).

## M8-INTERP loop 12: 8-byte micro-ops, guest branches as host branches, conditions as masks

2026-10-22, the dev VM, Chromium 153.0.8010.52, Node 26.7.0, on main at `b853a4e`; raw data `results/m8-interp-l12/`
(`ab/` one round each on the yardstick, `pages/` one Firefox pages session each from `pages.webpcsnap`).

**The micro-op from 16 bytes to 8** (backlog "The core's heap": the decoded blocks were ~350-365 MiB of the 1 GiB on
4 vCPUs): a kind, three register bytes and a `u32` with the kind's flags and immediate (`interp::block::pack`). What
doesn't fit (a logical immediate's mask, an MRS constant, a SIMD&FP access's word and offset, a MOV immediate that
isn't a rotated 32-bit value) is an 8-byte slot after the block's micro-ops, addressed from the micro-op. Decoding
still makes the wide form, which the slow path unpacks. The block map's entries went from 12 bytes to 8, and the page
index from a `Vec<u64>` of keys a page to a page's last key, the rest of the list threaded through the map's entries.

**First measured at −30% on the small guests and −11% on the boots**, with the same work (the guest's registers
equal after 100M steps) and `hot`'s dispatch code instruction for instruction the same. Not the stride (padded to
16 bytes: as slow), not the field order, not the arena's alignment (shifted by 1-3 slots), not the kind's
`transmute`, and not a spill of `done` it caused (a countdown instead: +1%). Bisected by building the new micro-op
with the old fields beside it and taking the old handlers' text back by groups: **B.cond alone** (305 → 437 MIPS
in Node). Its old target was `if t { o.imm } else { 4 }`, the immediate loaded only where taken, so LLVM kept a
branch; with the offset already in a register LLVM made it a `select`, a `csel` in V8's code, and the next block's
lookup waited for the condition instead of following the host's prediction of the guest's branch. Now B.cond, CBZ
and TBZ read the offset where taken through a load LLVM can't hoist (`taken_imm`, a volatile read), and a condition
is a 16-bit mask of the NZCV values it holds for, made at decode (`cond_mask`; B.cond's in its spare register bytes,
CSEL's and CCMP's in the `u32`'s top half): the old `cond_holds` was a second jump table.

| (MIPS, one round each) | base | **loop 12** | |
|---|---|---|---|
| `dec_mips` | 446.3 | **472.1** | +5.8% |
| `vm_dec_flat_mips` | 444.3 | **468.2** | +5.4% |
| `vm_dec_mmu_mips` | 441.0 | **469.0** | +6.3% |
| Buildroot's boot | 132.8 | 134.4 | +1.3% |
| Alpine's boot | 197.3 | 199.8 | +1.3% |

Firefox's pages session (4 vCPUs, one session each): **the decoded blocks 376 → 233 MB** (`decBytes`), the renderer's
median RSS 3,874 → 3,684 MB, busy MIPS 199 → 201, interpreted 3.58 → 3.60 G steps, wiki and BBC loads 10.9, 11.3 →
11.5, 11.7 s (one round; these have moved ~1 s between sessions). That build counted a block's room in the arena
as twice its length (for its constants) and restarted the arenas 15 times against 13 (13.4M decodes against 12.6M);
the committed one counts its micro-ops and constants exactly. Planted bugs: a condition mask with one NZCV value
flipped, and Ubfm's mask a bit short, each failing the differential test (which also caught, during the work, the
W forms' replicated Ubfm masks).

## M8-INTERP loop 13: compares with their B.cond, more handlers, slow-path stretches, the FP core's FMA and lanes

2026-10-22, the dev VM, Chromium 153.0.8010.52, Node 26.7.0, on main at `8d30c39`; raw data `results/m8-interp-l13/`
(`fusion/` three rounds, `handlers/` and `total/` two, alternated on the yardstick).

**A compare and its B.cond in one dispatch** (backlog "`hot`'s cost per micro-op"; tried in loop 2 at +1%, when B.cond
was `cond_holds`' jump table): CMP/CMN/SUBS/ADDS immediate or shifted register and TST/ANDS immediate or register,
marked at decode when a B.cond follows; the handler tests the B.cond's mask and branches (`and_bcond!`). Against loop
12, three rounds: Alpine's boot 197.1 → 199.1 MIPS (+1.0%), Buildroot's 132.0 → 133.3 (+0.9%), `dec_mips` 470.0 →
474.1 (+0.9%), the EL1 guests +0.2-0.3%; some arms' rounds overlap, none is slower.

**What the slow path still ran** (a temporary counter in `run`, Alpine's native boot through the block interpreter):
22.9M micro-ops, 0.86% of the steps, at ~14× a handled one ~12% of the time. Integer: CAS 7.8%, UDIV 4.4%, STTR 4.4%,
ADC 3.9%, BFM 3.0%, UMULH 2.2%, ISB 2.2%, CASP 1.3%, LDTR 0.9%, SBC 0.8%, DSB 0.6%, DAIFClr 0.6%, SDIV 0.4%; the
handled kinds' own slow paths (TLB misses: Ld 7.0%, Ldp 5.8%); and ~42% SIMD (the SHA-256 forms, vector ORR, ADD,
DUP, REV32, MOVI: a hot loop the yardstick interprets only because it never compiles). **Handlers** for CAS of every
size and ordering (a CAS on the TLB's pointer), ADC/SBC(S), UDIV/SDIV, UMULH/SMULH (in 32-bit halves: a u128
product is a compiler-rt call in wasm), BFM, MSR of what `sys::plain_write` writes (a `Cpu` field, SP_EL0 while
SPSel is 1, DAIF unless it unmasks IRQs) and DAIFSet, and MRS of SP_EL0 (Linux's `current`). Not ISB and DSB: under
parallel SMP, what users run, they leave with `Exit::Resync` anyway. Not CASP (a 128-bit atomic), STTR/LDTR (the
EL0 TLB array from EL1). Against the fusion, two rounds: Alpine's boot +3.8%, Buildroot's +1.6%, the small guests
−0.6 to −0.9% (more code in `hot`); kept for the boots.

**Stretches:** `jit::interpret` ran one micro-op through `run` per `SLOW` and re-entered `hot`; now `run` takes the
micro-op and the generic ones right after it in the prefix (`Run::stretch`), and runs a generic one without unpacking
it. In Node: Alpine's boot 215.9 → 218.4 MIPS, the FP guest through the block interpreter 16.6 → 20.2-21.5.

**The FP core** (that guest at 16.6 MIPS against the integer one's 470; the reference interpreter 18.4: the FP core
itself, not the exits). Its profile: `add_exact` 15%, `round_with` 13%, `muladd` 9%, and compiler-rt's `__lshrti3`
and `__ashlti3` 15%. `Fpu::muladd` now runs the JIT's inline FMA (moved from `fp/tests.rs`'s models into `fp.rs`)
where it applies: RNE, FPSR.IXC already set (`Fpu::with_fpsr` seeds it), normal or zero operands, a normal result;
the models' tests now also check that the software FMA raises nothing but IXC wherever the fast path applies, and
that the fast path agrees with IXC set. Then `simd::elem`/`set_elem` and `simd_fp::finish` without a `u128` shift by a
variable (an element is within one 64-bit half). In Node, each step in one invocation: 20.3 → 29.5 (FMA), 35.5 → 44.4
(lanes), 44.5-47.5 → 50.2-52.8 (generic without unpacking).

**All of it against loop 12** (two rounds):

| (MIPS) | loop 12 | **loop 13** | |
|---|---|---|---|
| Alpine's boot | 197.5 | **210.5** | +6.6% |
| Buildroot's boot | 133.1 | **136.2** | +2.3% |
| `dec_mips` | 470.1 | 467.2 | −0.6% |
| `vm_dec_flat_mips` | 467.1 | 466.0 | −0.2% |
| `vm_dec_mmu_mips` | 462.7 | 469.1 | +1.4% |
| `interp_fp_mips` (the reference interpreter) | 19.3 | **57.4** | 3.0× |
| `jit_fp_mips` | 1414.4 | 1415.2 | 0 |

Planted bugs, each failing the differential test or the directed ones: SMULH without its signed correction, BFM's
tmask a bit long, ADC ignoring the carry, a division by zero giving 1, CAS writing back the new value, DAIF writes
that unmask IRQs inline, MRS SP_EL0 with SPSel 0 inline (caught once the MRS test tried each key 8 times; it tried
each once, so SPSel 0 was a coin flip); the new flags check, asserted with one more flag, failed both FMA
models' tests.

**Loops 12 and 13 against the track's base (`b853a4e`)**, the gates under the JIT (two rounds alternated,
`results/m8-interp-l13/gates/`): Alpine's userspace 14,850 → 14,692 ms (−1.1%; its churn phase −1.9%), Alpine's boot
423.2 → 427.2 MIPS (+1.0%, the rounds overlapping), Buildroot's 125.3 → 126.3 (+0.8%). Firefox's pages session, three
rounds alternated (`results/m8-interp-l13/pages/`):

| | base | **loops 12-13** |
|---|---|---|
| busy MIPS | 198, 199, 186 | **202, 204, 206** (+3%, disjoint) |
| BBC load s | 12.0, 12.2, 13.4 | 11.0, 11.1, 12.0 |
| wiki load s | 11.3, 11.1, 11.1 | 11.3, 11.8, 10.7 |
| the renderer's median RSS, MB | 3,828, 3,864, 3,856 | **3,648, 3,662, 3,643** (−208) |
| decoded blocks, MB (`decBytes`) | 379, 381, 382 | **208, 208, 208** (−45%) |
| decodes, M | 13.0, 12.4, 12.5 | 13.5, 13.3, 13.2 |
| interpreted G steps | 3.51, 3.55, 3.57 | 3.50, 3.56, 3.55 |

**Not kept: LDTR and STTR as `Ld`/`St` with EL0's TLB array** (`ldtr.patch`, with a directed MMU test: a page EL1
may read but EL0 may not, its EL1 entry cached, faults as the interpreter faults; a plant using EL1's context failed
it). Alpine's boot in Node 217.3, 218.7 → 214.9, 208.9 MIPS: the branch in the single-register handler cost more
than the uaccess loads it took off the slow path.

## Self-hosted debug: what it costs when nobody debugs

2026-10-23, the dev VM, Chromium 153.0.8010.52, Node 26.7.0; base `5e1af53` against the same tree with self-hosted
debug (docs/cpu.md "Self-hosted debug"); raw data `results/m8-debug/` (`main/` three rounds of the six gate
benchmarks and the two block-interpreter ones; `dec/` three more of those two, debug first; `pad/` a control; `fixed/`
the export fixes found by CI after the measurement). The gate, agreed beforehand: any difference past noise on Alpine's
boot, Alpine's userspace or the small guests and the feature doesn't land.

**V8's code:** the dispatcher's test is `ldrb [#1146]; tbnz #0; …; tbnz #1` where it was `ldr [#888]; tbnz #1; …;
tbnz #0` (one byte with "interpreter only" and a copy of SCTLR_EL1.M, where it tested SCTLR_EL1's A and M); the rest
of `jit::steps`' TurboFan code differs in register allocation and the debug interpreter's cold call. The block
interpreter's hot functions (`jit::interpret`, `block::hot`, `block::run`, with and without the MMU) and
`interp::steps` are the same wasm but for constants: static data 24-32 bytes on, and `size_of::<Cpu>()` (1072 → 1152).

**Three rounds, alternated** (medians of rounds; ms for Alpine, MIPS for the rest):

| benchmark | base | debug | |
|---|---|---|---|
| Alpine's boot, total | 5680 · 5625 · 5657 | 5654 · 5658 · 5678 | +0.0% |
| Alpine's userspace, total | 14454 · 14209 · 14139 | 14100 · 14241 · 14118 | −0.6% (faster) |
| `jit_mips` | 5587 · 5579 · 5598 | 5594 · 5559 · 5563 | −0.4% |
| `vm_jit_flat_mips` | 5480 · 5548 · 5472 | 5487 · 5502 · 5495 | +0.3% |
| `vm_jit_mmu_mips` | 4849 · 4831 · 4814 | 4773 · 4819 · 4825 | −0.2% |
| `boot_mips_jit` | 154.9 · 157.3 · 155.9 | 155.2 · 154.7 · 156.7 | −0.5% |
| `vm_dec_mmu_mips` | 467.5 · 467.8 · 470.5 | 467.2 · 468.8 · 472.1 | +0.2% |
| `dec_mips` | 470.0 · 467.4 · 470.7 | 465.6 · 469.1 · 465.1 | −0.9% |

Every row's rounds overlap. **`dec_mips` alone leans:** three more rounds with debug first, 470.0 · 469.8 · 468.2
against 465.7 · 464.3 · 467.0 (−0.9%, apart), and a third session 465.6 · 468.6 · 468.0 against 465.6 · 466.6 ·
464.7 (−0.5%): over nine rounds 468.6 against 465.6, −0.6%, the same at each of the eight placements. Its hot code is
the same wasm, and `jit::steps` (the changed dispatcher) runs only at a chunk's end there (`jit::interpret` loops on
its own), so it reads as layout: the static data and the heap behind a larger `Cpu` moved, which the placements
(guest RAM only) don't vary. The control, base with `Cpu` padded to 1152 bytes, was 467.8 · 458.8 · 467.4:
inconclusive. Accepted by the user (2026-10-23): ≤1% on that small guest, nothing on the long workloads, for the
profiling the feature allows.

**After the export fixes** (`jit_run`, `interp_run` and their `_exit` twins derive the dispatch bytes; `interp::run`
and `run_system` take the debug interpreter while an EL is armed; every hot function is the same wasm as measured):
`dec_mips` +0.3%, `interp_mips` −0.2%, `jit_mips` +1.5%, rounds overlapping.

## Compile by expected benefit against cost: measured, screened, not kept

2026-10-25, the dev VM, Chromium 153.0.8010.52, Node 26.7.0, on main at `92b6edb`; raw data `results/m8-cp/` (the
policy's patch `policy.patch`, the cost diagnostic `cost/`, the benefit microbenchmark `benefit/`, the sessions
`churn1/`, `pages1/`, `pages2/`, `gates1/`, `gates2/`, `go2/`). The backlog's item (the user's idea, 2026-10-21):
replace the one dispatch threshold by a per-block one from the block's size, its instruction mix or its rate.

**The cost model** (`cost/`: `diag.patch` puts each module's emit ns, regions and instructions in a custom section
and dumps the modules from a Node run, Alpine's boot and its userspace benchmark under the JIT; `analyze.ts` times
`new WebAssembly.Module` per module, lazily and with `--liftoff-only --no-wasm-lazy-compilation --single-threaded`;
`fit.ts` fits time against modules, functions and KB; `fit.txt`). Per KB of wasm: the emit ~12.7 µs (r² 0.87-0.89),
V8's validation ~1.2 µs, Liftoff ~22-25 µs (r² 0.94-0.999); per module ~40 µs each of the three; per function
nothing measurable. A guest instruction is ~94 wasm bytes, so **a compiled instruction costs ~3.3 µs of the vCPU's
time** (the emit and Liftoff's lazy compile at the first call run there; validation on the compile worker), plus
~10× its bytes in V8's memory (docs/jit.md "Memory"). The fixed costs are small next to that (~5 µs a region in a
module of ~27), so cost grows with the region's length almost exactly.

**The benefit model** (`benefit/`: `classes.S`, twelve loops of 16 instructions by class, run 20M steps at a time on
a vCPU whose cache never compiles, the block interpreter, and one that compiles at once, regions included; Liftoff
with the tiering budget set out of reach before the JIT's modules are made, `liftoff.json`; TurboFan after a warm-up,
`turbo.json`). Interpreted against compiled ns a step, Liftoff:

| class | interpreted | compiled | saved a step |
|---|---|---|---|
| ALU, MOV runs, loads/stores, pairs, flags, multiplies, bitfields | 1.2-3.0 | 0.2-0.9 | 1.0-2.5 |
| short blocks (2 instructions, B to the next) / calls and returns | 2.8 / 2.4 | 0.4 / 0.9 | 2.4 / 1.5 |
| plain MRS/MSR | 6.2 | 4.5 | 1.7 |
| scalar FP | 18.6 | 0.66 | **18** |
| NEON | 16.8 | 3.7 | **13** |

So integer code repays its compile after ~1,500-3,000 more runs of an instruction and SIMD&FP code after ~200; and
since cost and benefit both grow with the block's length, **length should not move the threshold**: a threshold in
steps (dispatches × length) penalizes short blocks for nothing. The mix should: SIMD&FP gains ~10× per step.

**The screen.** Arms built from one patch (`policy.patch`: a block's shape, its length and its instructions on the
interpreter's generic path, made at decode; an `Info` byte for it, which stays 16 bytes; `need()` scaling the
threshold): `mix9` (threshold × len / (len + 9 × slow), slow = generic path), `mixfp9` (the same, slow = SIMD&FP on
the generic path only: the other generic forms, the regime's MSRs, ERET, ISB, are helper calls compiled too),
`steps5` (a threshold of 1000 × 5 steps), `decay16` (a block's count halved every 16 ticks it wasn't reported),
`f2000` (a flat 2000: the pressure rule removed) and `f2000mix9`.

The churn page from `pages.webpcsnap` (one session each, an A/A: 262 against 259 MB, `doneS` 103.1 against 102.7):

| | base | mix9 | decay16 | f2000 | f2000mix9 | steps5 |
|---|---|---|---|---|---|---|
| flushes / wasm MB | 0 / 262 | 0 / 268 | 0 / 263 | 0 / **237** | 0 / 237 | **1** / 305 |
| compiled share / `doneS` | 0.914 / 103.1 | 0.915 / 102.8 | 0.914 / 103.0 | 0.904 / 103.0 | 0.906 / 103.1 | 0.911 / **120.8** |

Steps-weighting lost as the model said (+17%, a flush); decay changed nothing. Firefox's pages session (`pages1/`,
one round): f2000 −11% wasm but 27% more steps interpreted, busy MIPS 198 → 190 and the heavy pages a second slower.
The gates (`gates1/`, three rounds alternated): Alpine's boot **+2.8%** with f2000 and +2.9% with f2000mix9 (rounds
apart), userspace +0.8/+0.9%, `smp_user_jit_4` −1.4/−2.4%; mix9 +0.4%, −0.8%, −0.6% (overlapping). **The pressure
rule pays for itself**: a cold boot wants 1000, a browser's working set under pressure 2000.

Then the mix arms against a base from the same code (`pages2/`, `gates2/`, `go2/`):

| | base | mix9 | mixfp9 |
|---|---|---|---|
| pages: wasm MB / interpreted G steps | 136 / 3.51 | 137 / 3.44 | 137 / 3.45 |
| pages: busy MIPS / wiki, BBC load s (medians of 3) | 198 / 10.6, 11.5 | 198 / 10.6, 12.3 | 197 / 10.7, 12.1 |
| Alpine's boot / userspace / `smp_user_jit_4` (ms) | 5536 / 13861 / 14123 | +0.6% / +0.4% / +1.0% | +0.5% / −0.3% / −0.4% |
| `go build` sessions (s) | 31.73, 31.89 | 32.22, 32.37 (+1.5%) | 32.14, 33.76 |

Every gate's rounds overlap but `go build`'s mix9 (slower). Weighting by the mix compiles FP blocks earlier (2% fewer
steps interpreted in Firefox), but at ~4% of the session's steps interpreted there is nothing left for it to win.
**Not kept:** no arm beat the floor and the pressure rule on any workload past noise, nor saved memory without
losing a gate; the per-block hook's code goes with it (the user's call: sub-noise differences are what tuning the
floor gives, and the old mechanism is simpler). Also found: the boot benchmarks had fetched `bench/boot/undefined`
since the page moved to Vite (fixed in `9470549`), and the warm snapshots needed making again (machine state format
2).

## What the guest accesses' atomics cost on x86_64

2026-10-26, a Claude Code cloud session (x86_64, Intel Xeon @ 2.10 GHz, 4 vCPUs, 15 GiB, shared hardware), Chrome
for Testing 153.0.8010.12, Node 26.12.1, at `faf3ef8`; raw data `results/m8-atomics-x86/`. The backlog's question
(docs/backlog.md "Interpreter"): the core's guest accesses are relaxed Rust atomics (docs/cpu.md "Memory model"),
and wasm has only sequentially consistent ones; on the M4 their `ldar`/`stlr` were 0.24% of `run`'s cycle samples,
and x86_64 was never measured. Only the core's accesses are concerned: JIT code uses plain wasm loads and stores.

**V8's code on x86_64** (`node --print-wasm-code --no-liftoff`, a shared memory): `i64.atomic.store` is an alignment
check (`lea`, `test`, `jnz` to a trap) and `xchgq` (a locked read-modify-write, a full barrier); `i64.atomic.load` the
same check and a plain `movq`; a plain `i64.store` / `i64.load` one `movq`.

**Arms**, measuring builds of `core/src/mem.rs` (UB under parallel SMP: racing plain accesses are data races in
Rust): `plain` (`plain.patch`, loop 0's `m8-interp-l0/plain-accesses.patch` ported: `load_aligned`,
`store_aligned`, `load_relaxed`, `store_relaxed` and `load_atomic` volatile, `store_atomic`'s byte too), `loads`
(`loads.patch`: the plain loads only) and `stores` (`stores.patch`: the plain stores only), against `base` and `aa`
(a copy of base). The guests are the block interpreter's small ones; the boots weren't run (a cloud session has no
Buildroot or Alpine image: docs/cloud.md).

**The yardstick in Chromium** (`bench/interp/ab.sh`, `ab1/` five rounds of all five arms, `ab2/` eight more of base,
plain and stores; median of the rounds' medians):

| | base (13 rounds) | plain (13) | stores (13) | loads (5) | aa (5) |
|---|---|---|---|---|---|
| `dec_mips` | 226.9 (202-233) | 234.8 (227-239), +3.5% | +1.7% | +0.8% | −0.3% |
| `vm_dec_flat_mips` | 225.3 (192-230) | 232.3 (227-248), +3.1% | +4.5% | +1.4% | +1.7% |
| `vm_dec_mmu_mips` | 240.9 (218-245) | 247.1 (201-293), +2.6% | −5.5% | +1.1% | −3.0% |

**Inconclusive by the rules**: a run's IQR over its eight placements is ±10-70 MIPS here, and within one placement
consecutive samples spread 160-260 (the host's other tenants, not the placement), so every arm's rounds overlap and
the A/A pair differs by up to 3%.

**Paired, in one process** (`bench/interp/paired.ts`, new: every arm's guests side by side, a 20M-step chunk each in a
shuffled order every iteration, the instances made in a shuffled order too; a sample is one iteration's MIPS over
base's). Chromium (`bench/run.ts --page bench/interp/paired.html`), six sessions of 60 iterations (`chromium/`):

| pooled (360 pairs): median [bootstrap 95%], wins | aa | plain | loads | stores |
|---|---|---|---|---|
| `dec_mips`'s guest, placement 0 | −0.2% [−0.9, 0.2] 172 | **+3.6%** [3.2, 4.1] 252 | +1.1% [0.7, 1.6] 218 | +2.5% [2.1, 3.0] 235 |
| `dec_mips`'s guest, placement 29696 | −0.0% [−0.8, 0.6] 179 | **+3.7%** [3.1, 4.3] 256 | +1.5% [0.9, 2.0] 219 | +2.9% [2.3, 3.5] 244 |
| `vm_dec_flat_mips`' guest | −0.5% [−1.0, 0.1] 166 | **+3.6%** [3.1, 4.0] 256 | +0.6% [0.1, 1.1] 200 | +2.6% [2.0, 2.9] 247 |
| `vm_dec_mmu_mips`' guest | −0.1% [−0.7, 0.4] 177 | **+2.6%** [2.0, 3.4] 244 | +0.7% [0.2, 1.4] 207 | −1.6% [−2.2, −1.0] 136 |

Per session (the six medians) the A/A stays within ±1.2% and `plain` is +1.9 to +4.6% in all 24 cells. One earlier
session with the instances made in a fixed order (`chromium-fixed-order.json`, 150 iterations) had an A/A of +3.6%
at placement 29696: where an instance lands moves it by a few percent, so the order is shuffled since. Node
(`node-paired.json`, 150 iterations, the same tool):

| pooled (150 pairs): median [bootstrap 95%], wins | aa | plain | loads | stores |
|---|---|---|---|---|
| `dec_mips`'s guest, placement 0 | +1.2% [−0.1, 2.2] 84 | **+7.6%** [7.0, 8.9] 121 | +0.4% [−0.3, 1.0] 80 | +6.2% [5.3, 7.9] 116 |
| `dec_mips`'s guest, placement 29696 | +0.4% [−0.2, 1.3] 84 | **+7.7%** [7.0, 8.6] 119 | +0.9% [0.0, 2.4] 86 | +6.2% [5.5, 6.6] 118 |
| `vm_dec_flat_mips`' guest | −0.3% [−0.9, 0.7] 70 | **+5.7%** [4.5, 6.5] 112 | −0.1% [−0.9, 0.9] 71 | +4.9% [3.8, 5.7] 116 |
| `vm_dec_mmu_mips`' guest | +0.4% [−0.4, 1.0] 83 | **+3.5%** [2.4, 3.9] 107 | +0.8% [−0.2, 2.1] 84 | +2.1% [1.5, 3.4] 105 |

**What it says.** The accesses' atomics cost the block interpreter **~3-4% in Chromium (3.5-8% in Node) on x86_64**,
nearly all of it in the stores (`xchg`); the loads' alignment checks are ~1%. `stores` alone on the MMU guest is
slower than base in every Chromium session but faster in Node (+2.1%): layout, Chromium's V8 placing that mix's
code worse; with the loads plain too it gains in both. So the backlog's first remedy, plain loads with atomic stores, would buy ~1%: only
plain stores (one vCPU or round-robin, atomics in parallel SMP) recover the cost. What that is worth on a real
workload wasn't measured: under the JIT the interpreter runs cold code and slow paths only (Alpine's boot under
`jit` 4, all interpreted, would bound it), so 3-4% of the interpreter's share of a boot.

**Closed, not taken (2026-10-31, the user's call).** Plain accesses are safe only without parallel vCPUs, and the
page's machines are parallel from 2 vCPUs up, with a default of `min(4, cores - 2)`: only a 1-vCPU machine would
benefit, since round-robin matters only to the tests. There the gain would be small: on Alpine's boot under the JIT
the interpreter ran 159M of 2,652M steps, ~0.7 s of ~5.5 s at its 224 MIPS on the M4, so ~13% of the boot and ~0.45%
for 3.5% of it, under the bar of ~1% (an estimate, not an x86_64 run, and without the JIT's slow paths). Against that, a
second copy of `hot`'s access paths in a loop that loses to small additions (the next section). The x86_64 run on the
boots was scripted and never run.

## A shared TLB probe for pairs off one base: a loss (2026-10-30)

The JIT's groups of accesses (`bench/boot/REPORT.md` "Groups of accesses, measured") in the block interpreter's terms:
`hot` already runs a pair of LdOs or StOs in one dispatch, each with its own probe; the pair off one base, of one kind,
took one probe of the bytes they span instead, falling back to the two singles on a miss. Tried because the block
interpreter runs 4.0% of the guest's instructions on Firefox's pages session (3.45 G of 85.8 G, every round) at a few
times the JIT's cost each. `bench/interp/ab.sh`, dev VM, 3 alternated rounds, JSON in `results/same-base/`, medians:

| | base | same base, one probe | |
|---|---|---|---|
| `dec_mips` | 475.2 | 461.9 | −2.8% |
| `vm_dec_flat_mips` | 477.4 | 384.2 | −19.5% |
| `vm_dec_mmu_mips` | 472.2 | 466.5 | −1.2% |
| `boot_dec_mips` (Buildroot) | 184.8 | 182.5 | −1.2%, inside its noise |
| `boot_alpine_dec_mips` | 221.2 | 220.3 | −0.4% |

Dropped. A probe here is two loads and a compare in a handler that does much more; what the pair gives back is less than
the extra tests and the code the inlined path adds to `hot`. The likely cause, not profiled: `hot`'s speed rests on what
V8 keeps in registers across the loop, and the flat guest, which has no TLB to save on, lost most. A new path in `hot`
for a probe's sake may well do the same. 
## SUBS's NZCV from its operands (2026-10-30)

`nzcv_of`'s `Kind::Sub` computed `x + !y + 1` and went through `add_nzcv`; now `r = x - y`, `C = x >=u y`,
`V = sign((x ^ y) & (x ^ r))` (`sub_nzcv`), which CCMP shares, one scratch local fewer. Kept: smaller code and no cost
seen. Dev VM, Chromium 153.0.8010.52, JSON and summaries in `results/nzcv-sub/`.

**Code.** On Firefox's pages session (from the snapshot, 3 alternated rounds with an A/A) wasm bytes per inline
instruction fell 1.6% (101.6-102.0 to 100.1-100.3), per block 1.4% (1547-1562 to 1520-1534), against the census's 2.8%
estimate (`bench/boot/results/wasm-size/`, static, Debian). The session's total stayed at 133 MB: it compiled ~1.2% more
instructions and 1.3% more blocks in every round; why wasn't traced.

**Time.** `bench/interp/ab.sh`, 3 alternated rounds, medians:

| | base | ops | |
|---|---|---|---|
| `alpine_user_jit_total` (ms) | 13307.8 | 13327.0 | +0.1% |
| `boot_alpine_jit_mips` | 498.7 | 513.2 | +2.9% |
| `boot_jit_mips` | 171.4 | 171.2 | -0.2% |
| `jit_mips` | 5641.8 | 5653.7 | +0.2% |
| `vm_jit_flat_mips` | 5517.2 | 5540.2 | +0.4% |
| `vm_jit_mmu_mips` | 5006.3 | 5044.1 | +0.8% |
| `jit_coremark_mips` | 2353.6 | 2352.9 | 0.0% |
| `jit_fp_mips` | 1426.0 | 1425.3 | -0.1% |

Every row's rounds overlap, Alpine's boot too (base 514.2, 497.4, 498.7; ops 513.2, 513.3, 509.6), and so do the
userspace phases (compress -0.4%, Lua +0.4%, churn +0.7%, SQLite -0.6%, in ms): no difference counts, either way.

**The long sessions didn't resolve anything finer.** Pages session, busy MIPS: base 198, 215, 215; A/A copy 212, 198,
213; ops 202, 195, 211. `bench/stress/go-ab.sh` (median build after the first three, s): base 30.07, 30.56, 32.34; ops
31.66, 31.77, 30.45. Both are bimodal, ~6% apart, with both arms in both modes: within a mode ops isn't slower, but it
was in the slow mode 2 times of 3 on each workload against base's 1, and these rounds can't say whether that's chance.
Twelve shorter `go build` sessions to count the modes were stopped: a change this small isn't worth the machine time,
and no benchmark showed a cost. Not measured on the Mac host or x86_64.

## No index masks, one probe for a pair (2026-10-30)

Two changes that take instructions out of `hot` rather than add a path, the difference from the shared probe above. `reg`:
`rd`, `wr`, `rsp` and `wsp` index `c.x` with `get_unchecked` where they masked with `& 31` (no panic either way: a
micro-op's register bytes are `pack`'s, below 32). `pair`: LDP, STP and the SIMD&FP pairs take one `fast_in` of both
registers' bytes where they took two; a pair across pages goes to the slow path. `bench/interp/ab.sh`, dev VM,
Chromium 153.0.8010.52, 3 alternated rounds, medians, JSON and patches in `results/review-interp/` (`three-arms/`, then
`combined/`, a session of its own):

| | base | `reg` | `pair` |
|---|---|---|---|
| `boot_alpine_dec_mips` | 222.1 | 224.7 (+1.2%) | 224.7 (+1.2%) |
| `vm_dec_mmu_mips` | 472.3 | 482.8 (+2.2%) | 479.2 (+1.5%) |
| `dec_mips` | 475.1 | 483.2 (+1.7%, rounds overlap) | 474.3 (−0.2%) |
| `vm_dec_flat_mips` | 475.3 | 482.0 (+1.4%, rounds overlap) | 475.8 (+0.1%) |

| | base | both | |
|---|---|---|---|
| `boot_alpine_dec_mips` | 221.8 | 225.5 | +1.6% |
| `boot_dec_mips` (Buildroot) | 184.2 | 186.8 | +1.4%, rounds overlap, inside its noise |
| `dec_mips` | 472.4 | 486.5 | +3.0% |
| `vm_dec_flat_mips` | 474.7 | 489.1 | +3.0% |
| `vm_dec_mmu_mips` | 473.1 | 485.1 | +2.5% |

Kept, both. Buildroot wasn't in the three-arm session (the worktree couldn't serve its image). Not measured: x86_64, and the
worth under the JIT, where the interpreter runs the cold code.

## XZR's reads without a compare (2026-10-30)

`rd` tests `n == 31` on every operand. `pack` now stores a slot that holds zero for the register bytes that are only read
(`reads`, per kind), and `hot` reads those with `ra`, a plain indexed load. Left with the compare: what's written through the
same byte (BFM's and MOVK's Rd, CAS's Rs) and what's no byte (MADD's Ra, MSR's Rt). Writes keep `wr`'s. `Uop::wide` maps
back for `run`. The slot is `Cpu::zero`, not saved. A slot that held a live register fails the differential test.
`bench/interp/ab.sh`, dev VM, Chromium 153.0.8010.52, 3 alternated rounds, medians, JSON in `results/xzr-spike/`. The
first two tables are a spike's, with `afsr0_el1` for a slot (no layout change); the third has the field:

| | base | zero slot | |
|---|---|---|---|
| `boot_alpine_dec_mips` | 219.4 | 226.2 | +3.1% |
| `boot_dec_mips` (Buildroot) | 183.3 | 187.1 | +2.1%, inside its noise |
| `dec_mips` | 476.8 | 489.2 | +2.6% |
| `vm_dec_flat_mips` | 482.5 | 482.3 | 0.0% |
| `vm_dec_mmu_mips` | 481.1 | 488.5 | +1.6% |

The boots again in a session of their own, with the build before the device memory fixes (the two sessions' bases sat ~3%
under that build's result that morning): the fixes cost nothing, and that was the session.

| | before the fixes | base | zero slot | |
|---|---|---|---|---|
| `boot_alpine_dec_mips` | 219.7 | 219.5 | 227.1 | +3.4% |
| `boot_dec_mips` (Buildroot) | 182.0 | 181.9 | 186.1 | +2.3%, inside its noise |

The field moves everything after `Cpu` in `Vcpu` by 16 bytes, so it was measured under the JIT too (the default config's
compiled benchmarks, `results/xzr-spike/field/`, one session). Against the spike it costs nothing, and compiled code isn't
hurt. The boots under the JIT interpret their cold code, so they share the gain.

| | base | `afsr0_el1` | `Cpu::zero` | |
|---|---|---|---|---|
| `boot_alpine_dec_mips` | 219.9 | 226.6 | 226.7 | +3.1% |
| `boot_dec_mips` (Buildroot) | 182.2 | 186.3 | 186.5 | +2.4%, inside its noise |
| `dec_mips` | 476.8 | 491.1 | 491.6 | +3.1% |
| `vm_dec_flat_mips` | 475.3 | 482.0 | 490.5 | +3.2% (flat in the first session) |
| `vm_dec_mmu_mips` | 482.1 | 490.2 | 488.3 | +1.3% |
| `boot_alpine_jit_mips` | 486.0 | 494.7 | 497.2 | +2.3%, rounds 0.1 apart |
| `boot_jit_mips` (Buildroot) | 167.6 | 169.5 | 169.6 | +1.2%, inside its noise |
| `jit_mips` | 5563 | 5579 | 5567 | +0.1%, rounds overlap |
| `vm_jit_flat_mips` | 5384 | 5384 | 5427 | +0.8%, rounds overlap |
| `vm_jit_mmu_mips` | 4849 | 4908 | 4920 | +1.5% |

The field kept: nothing can write it, where a system register's field would be zero by convention (a snapshot's bytes
reach those). Its ABI: `Cpu` is 1168 bytes, ABI 57. Not measured: x86_64.

## XZR's writes without a compare: a loss (2026-10-31)

The same for writes: `pack` stores a slot of its own (`Cpu::sink`, 0 again when `hot` returns, as tests compare whole `Cpu`s)
for the bytes only written, and `hot` stores through it with no compare. The flag setters kept theirs: CMP and TST would pay a
store that goes nowhere, and a store to wasm memory carries an explicit bounds check. `bench/interp/ab.sh`, dev VM,
Chromium 153.0.8010.52, 3 alternated rounds, medians, JSON and the patch in `results/xzr-spike/sink/`:

| | base | sink | |
|---|---|---|---|
| `boot_alpine_dec_mips` | 226.5 | 227.3 | +0.3% |
| `boot_dec_mips` (Buildroot) | 186.2 | 185.7 | −0.3% |
| `dec_mips` | 489.1 | 482.1 | −1.4% |
| `vm_dec_flat_mips` | 482.5 | 371.6 | **−23.0%** |
| `vm_dec_mmu_mips` | 489.6 | 492.0 | +0.5% |
| `boot_alpine_jit_mips` | 498.5 | 485.7 | −2.6%, rounds overlap |
| `boot_jit_mips` (Buildroot) | 170.7 | 168.4 | −1.3%, inside its noise |

Dropped. Nothing gained past noise, and the flat guest fell as it did for the shared probe above (−19.5%). Not profiled, but
the two look alike: `hot<Flat>` sits close to something in V8's register allocation, and a change that reads as smaller can
cross it. A change to `hot` has to be measured on the flat guest whatever it looks like.

## REVIEW P3 and P4: the structure loads' fast path, IXC, and the inlining P3 broke (2026-11-04)

The dev VM, Chromium 155.0.8059.84, Node 26.7.0; `bench/interp/ab.sh`, arms alternated each round, medians; JSON in
`results/review-p3p4/` (one directory a session). Base `aa9bd5fe` (before P3); P3 is `952bfc7f` (the structure loads
and stores through `Bus::fast`, REVIEW-20261103.md); P4 skips the FP fast paths' exactness test when FPSR.IXC is set.

**P3 cost the reference interpreter a call per instruction.** `first/`, three rounds:

| | base | P3 | P3 + P4 |
|---|---|---|---|
| `interp_fp_mips` | 59.1 | **42.6** (−27.8%) | 43.7 |
| `jit_fp_mips` | 2,740 | 2,728 | 2,739 |

The FP guest has no structure loads (`vld1q_u8` is an `ldr q`). In the wasm (`wasm-tools print`, debug sections
stripped), `interp::steps::go::<Flat>` went from ~3,980 lines to 306 and `jit_exec_flat` from ~3,780 to 218:
`exec_at`'s closure (`|c| exec(c, m, insn, pc)` through `cpu_pc_then`) had gone out of line, LLVM's size heuristic
tipped by `ldst_fp::exec`'s growth. The fix calls `exec` directly (`pc_back` after). That left −5% on both
reference guests (`v2/`: `interp_fp_mips` 59.1 → 56.1, `interp_mips` 122.9 → 116.8; `dec_mips` and `jit_fp_mips`
flat). Moving `multiple` and `single_structure` out of line changed nothing (`v3/`, fix2 = fix). The step loop's
callees against the base's: `extend`, `simd_int::handler` and the `or_else` closure to `simd_fp::handler` were now
calls. All three made inline (`#[inline(always)]`, a `match` for the closure): the loops call what the base's call.

| `v4/`, three rounds | base | P4 alone (B) | P3 + P4 + fixes |
|---|---|---|---|
| `interp_fp_mips` | 59.0 | 61.2 | **61.1** |
| `interp_mips` | 122.4 | 122.8 | 121.7 |

**What's left of P3, `interp_mips` −0.6 to −1.1%:** builds C (P4 and the direct call, base's `ldst_fp.rs`) and D (all
the fixes, base's `ldst_fp.rs`) equal P4 alone (`v5/`: 122.3, 122.4, 122.7 against 121.6). Bisected on the loop's
shape (its line count, a static proxy): base's `multiple` with the rest of P3 gives the base's loop; P3's `multiple`
gives the other whether its fast path is live, dead (`None`), inlined or not, and with base's post-index sum. In the
crate's IR, `ldst_fp::exec`'s result gains `initializes((0, 1))` (and `%c` `captures(none)`): LLVM's attribute
inference, and the loop then reads the `Exit` in bytes. No inlining change; kept.

**The whole of it against base** (`broad/`, three rounds):

| | base | P3 + P4 + fixes | |
|---|---|---|---|
| `alpine_user_jit` total, ms | 13,236 | 13,182 | −0.4%, rounds overlap |
| `boot_alpine_jit_mips` | 506.8 | 500.8 | −1.2%, rounds overlap (495-515 against 500-506) |
| `boot_alpine_dec_mips` | 229.3 | 228.9 | −0.1% |
| `boot_dec_mips` | 189.0 | 189.6 | +0.3% |
| `dec_mips` | 500.0 | 499.8 | 0 |
| `vm_dec_mmu_mips` | 495.9 | 493.4 | −0.5% |
| `interp_fp_mips` | 59.1 | **61.1** | **+3.5%** |
| `interp_mips` | 122.6 | 121.2 | −1.1% |
| `jit_fp_mips` | 2,701 | 2,740 | +1.4%, rounds overlap |

P4 alone is the FP guest's +3.5-3.9% (`v1/`, `v3/`). Natively, P3's structure forms (one instruction, release, flat
bus): `ld1 {v0-v3}.16b` 207 → 15 ns, `ld4 .16b` 183 → 22, `st4` 271 → 20 (`ldp q0, q1` 11).

**The block interpreter** (what users run before the JIT compiles): `hot`, its call-free loop, is the same code in
the base and HEAD (one data address apart, flat and MMU copies). Its slow path changed shape (`block::run`,
`interp::exec_at_op`, and `decode` a call from `run`), measured by `dec_fp_mips`, new: the FP guest through the
block interpreter, its SIMD and FP instructions generic micro-ops. `dec/`, three rounds: pre-P3 54.2, HEAD
(`9b657848`) **54.4** (+0.3%, every round ahead, under the noise floor). The rest of the block interpreter's
yardstick is in `broad/` above (flat); `vm_dec_flat_mips` wasn't run (it runs in `hot`).

## REVIEW P5: the smaller JIT items (2026-11-04)

The dev VM, Chromium 155.0.8059.84; `bench/interp/ab.sh`, arms alternated each round, medians; JSON in
`results/review-p5/` (`./`, `s2/` and `gl/`: one session each). Base `a079ec66`; P5 is all five of REVIEW-20261103.md's
items in one build: ADRP's page from the entry PC plus a constant; BR/BLR/RET keep their target in ADDR for the
transfer probe (no reload of the PC they stored); vector FMAX/FMIN/FMAXNM/FMINNM test the result for NaN lanes (and
under FZ both operands for denormals, in one branch); the emulated double FMA's by-element factor shuffled once into a
local; `Cache::invalidate` hands the dropped keys to the tables and the pending batch once, and `PageIndex::file`
files a key once.

What V8 makes of it (`tools/v8code.ts`, TurboFan): CoreMark's 81 hot functions reload the PC 87 times, from 97 (the
10 indirect transfers); a guest of two `FMLA Vd.2D, Vn.2D, Vm.D[i]` under `fma=emul` has 4 element `dup`s, from 12
(V8 doesn't merge the repeated shuffles), its function 2,128 → 2,096 bytes.

| | base | P5 | |
|---|---|---|---|
| `alpine_user_jit` total, ms (`./`) | 13,345 | 13,370 | +0.2%, rounds overlap |
| `alpine_user_jit` total, ms (`s2/`) | 13,265 | 13,161 | −0.8%, rounds overlap |
| `alpine_user_jit_lua`, ms (`./`) | 3,001 | 2,930 | **−2.4%**, rounds apart (2,987-3,002 against 2,924-2,942) |
| `alpine_user_jit_lua`, ms (`s2/`) | 2,969 | 2,918 | −1.7%, rounds overlap |
| `alpine_user_jit_churn`, ms (`./`, `s2/`) | 1,160, 1,145 | 1,187, 1,137 | +2.3%, −0.7%: noise (IQR ±190) |
| `boot_alpine_jit_mips` | 502.0 | 503.7 | +0.3% |
| `jit_coremark_mips` | 2,263 | 2,298 | **+1.5%**, rounds apart (2,261-2,284 against 2,288-2,301) |
| `jit_fp_mips` | 2,705 | 2,695 | −0.4%, rounds overlap |
| `jit_mips` | 5,544 | 5,583 | +0.7%, rounds overlap |
| `vm_jit_flat_mips` | 5,594 | 5,556 | −0.7%, rounds overlap |
| `vm_jit_mmu_mips` (`./`, `s2/`) | 5,006, 4,981 | 4,914, 4,988 | −1.8% then +0.1%: noise |
| `gl_llvmpipe_jit_frame`, ms (`s2/`, 3 rounds) | 247.3 | 251.9 | +1.9%, rounds overlap |
| `gl_llvmpipe_jit_frame`, ms (`gl/`, 4 rounds) | 248.5 | 248.5 | 0 |

llvmpipe's +1.9% (the item where FMAX/FMIN's clamps count) didn't hold in a session of its own with a third arm, P5
with the old FMAX/FMIN test (`oldmm`: 246.6, rounds overlapping both). Kept: nothing regresses past noise, CoreMark and
Lua (the most indirect transfers) gain. `bench/interp/yardstick.sh` now serves `gl_*` from bench/boot's page.

## REVIEW P6: a TLBI by VA scans a block only when its bucket counts entries (2026-11-04)

`Tlb::rblk` (docs/cpu.md "Blocks") replaces the per-class count: a flush by VA reads a block's indices only when a hash
bucket of its class and block counts live entries. Counted natively (the block interpreter, `tests/distros.rs`): Alpine's
boot made 6,071 block scans (25M slots) of ~34K flushes by VA, now 200-399; the userspace run 16K (65M slots). Against
233a8952, `bench/interp/ab.sh` alternated, 3 rounds, Chromium 155.0.8059.84 on the dev VM (`results/review-p6/`):

| | base | P6 | |
|---|---|---|---|
| `alpine_jit_total` (warm), ms | 5,207.9 | 5,208.0 | 0.0%, rounds overlap |
| `alpine_user_jit_total`, ms | 13,070 | 13,133 | +0.5%, rounds apart (13,018-13,077 against 13,110-13,161): under the 1% floor |
| `alpine_user_jit_lua`, ms | 2,898.9 | 2,915.5 | +0.6%, rounds apart (2,898-2,906 against 2,909-2,918) |
| `alpine_user_jit_compress`, `_sqlite`, `_churn` | | | +0.2%, +0.5%, +0.6%: rounds overlap |

No gain shows, as expected: ~25M byte checks are a few ms of a 5 s boot. The userspace run's +0.5% is under the
noise floor; Lua (compute, few TLBIs) moved as much, so it reads
as the build's layout rather than the hash in `fill` and `drop_slot`. Kept for the cases it targets: flushes in a
half with live block entries (always, in the kernel's), and a 1 GiB block's 16,384 indices.

## FZ's operand tests and vector FMUL's zero clause (2026-11-09)

The dev VM, Chromium 155.0.8059.84, at `1c76a1c8`; core builds alternated in place of the served one, five rounds
(`bench/interp/ab.sh`); raw data `results/fz-ops/` (a: the commit, b: the FZ tests) and `results/fmul-zero/` (b, c:
b with FMUL's zero clause in a branch). Two backlog items from "M8: the FP fast paths' SIMD ops" above.

**A benchmark for FZ.** Neither small guest ran under FZ, and llvmpipe's frame is too coarse to show a few lane ops
(below). `jit_fz_mips` runs the FP guest built with `-DFZ` (`guest-fz.bin`): FPCR.FZ set and a shader-like NEON loop
over 64 pixels of four single lanes (a light's dot product by element, clamped at zero, so about half the lanes are
zeros; FMLA by vector and by element; the clamped values' products; min, max) and a double FMLA loop.

**FZ's operand tests** (`denormal_any`): each operand's bits shifted left once less one, below the smallest
normal's so shifted less one, unsigned; singles take the operands' unsigned `min` before one compare, doubles
compare each with the sign flip folded into the subtraction's constant. Two lane ops an operand (singles, plus a
`min` past the first; doubles three) where `and`, subtract and compare with their three `movi` constants (doubles a
flip more) took six.

| | a (median of rounds) | b |
|---|---|---|
| `jit_fz_mips` | 1459.6, 1455.6, 1446.9, 1438.6, 1437.8; **1446.9** | 1668.4, 1668.4, 1655.6, 1660.4, 1653.2; **1660.4** (+14.8%) |
| `jit_fp_mips` (no FZ) | **2726.7** | **2731.3** (even) |
| `gl_llvmpipe_jit` ms a frame | 242.0, 245.9, 246.5, 245.4, 245.0; **245.4** | 240.5, 245.3, 242.6, 248.3, 243.6; **243.6** (overlapping: even) |

So the 8% llvmpipe gained with no operand tests at all wasn't the tests' lane ops: their branch, or what TurboFan
does around it, if anything. Kept on the kernel's gain.

**Vector FMUL's zero clause in a branch** (FMUL, FMULX, FDIV, by vector and by element): the fast results' mask
(FZ's test in it) is kept in a local and reduced alone; only when some lane fails does a branch add the exact zero
lanes (zero result, zero factor or dividend, no denormal operand under FZ) and reduce again, as the scalar forms do.

| | b | c |
|---|---|---|
| `gl_llvmpipe_jit` ms a frame | 244.5, 244.3, 246.1, 244.0, 248.7; **244.5** | 238.3, 239.0, 238.3, 239.5, 239.7; **239.0** (−2.3%) |
| `jit_fz_mips` | 1654.3, 1644.4, 1648.8, 1647.1, 1645.8; **1647.1** | 1550.7, 1546.5, 1543.8, 1545.9, 1545.0; **1545.9** (−6.1%) |
| `jit_fp_mips` | **2679.2** (two rounds' IQR ~300) | **2710.9** (even) |

The kernel is the branch's worst case: its clamped products have a zero lane in nearly every vector, in a pattern a
predictor can't learn, so it pays the second reduction and mispredicts. llvmpipe's shaders, the real workload,
gain; kept.

Correctness: the differential test with new edge cases (the largest denormals of either sign beside zeros and the
smallest normals, in any operand; vector products and quotients that underflow to zero beside exact zeros) and a
test that under FZ zero and smallest-normal lanes and exact zero products stay inline. Planted bugs, each failing:
the singles' or doubles' bound one exponent short (the edge cases), `max_u` for `min_u` (edge cases), a zero counted
as a denormal in singles or doubles (the inline test), no zero clause (the inline test), the zero clause on a zero
result alone and without FZ's test (the differential test's by-element and three-same FP runs, 4-8 tests).

## The block interpreter on the Mac, loop 1: why `hot` returns, and the calls it held (2026-11-09)

The Mac host (Chrome for Testing 157.0.8103.38, macOS 26.6.2), base `86c6ddf3`; raw `results/m9-interp-mac/` (README).
The Mac's profile (bench/boot/REPORT.md "Where a busy vCPU's time goes on the Mac, and the compile threshold there")
puts the block interpreter at 18.4% of the pages session's busy ticks: `hot` 14.05%, then `Cache::miss` 1.23%,
`Cache::count_out` 1.08%, `jit::interpret` 0.95%, `Cache::slot_in` 0.65%.

**Why `hot` returns** (a counting core, `diag/diag.patch`, one pages session from `pages.webpcsnap`, sums over the four
tables): 3.50 G interpreted steps in 678 M block runs (5.2 steps a run); `jit::interpret` entered 149 M times (one per
4.5 block runs: most of the interpreted code sits between compiled blocks), `hot` 266 M. `hot` chained 456 M blocks
(375 M of them in the same page) and returned for: the next block compiled 126 M, **its slot holding another block
82.5 M**, a slow micro-op 45 M (generic 26 M, a load or store off its fast path 19 M), the block's quota (a report due)
4.3 M, no instruction-TLB entry 6.5 M. `count_out` (a block out of its slot: a map lookup and `slot_in`'s two) ran
128.6 M times, 93.5 M of them putting the block back. 13.1 M blocks were decoded.

**The slots** (16,384, direct-mapped by `key >> 2`): a hash folding in the PA's bits from 16 up changed nothing (82.4 M
slot misses); 65,536 slots halved them (44.0 M with or without the fold; `count_out` 78 M). So half the misses aren't
conflicts of nearby blocks; not built yet.

**What sends loads and stores off the fast path** (`diag/counts3.txt`, its `g_` sums divided by the four tables that
printed them): misaligned 4- and 8-byte accesses at base + offset (LdO/StO) ~5.4 M, their TLB misses ~4.1 M, other
single accesses misaligned ~2.2 M and missing the TLB ~1.1 M, pairs ~0.6 M; an access across a page ~6 K, an SP off
16 never. Misaligned accesses are the largest cause, ~7.8 M exits of ~14× a handled micro-op each.

**Two calls in `hot`.** The loop is meant to make none (`Fast`: V8 spills every value live across a call at its
definition, docs/v8.md "Spills"), but since loop 13 it held two, in both its copies: LLVM had recognized UMULH's
32-bit halves as a u128 product and made it a call to compiler-rt's `__multi3` (the call the halves were written to
avoid), and SDIV's 32-bit arm kept `wrapping_div`'s panic (its zero test was on the 64-bit value). Now the halves'
width is a static read volatile (`HALF`), and each division arm tests its own divisor. A test (`tests/core-wasm.test.ts`,
through `tools/wasm-calls.ts`, which walks the functions' instructions) fails if `hot` makes any call; it failed on the
base. Planted bugs, each failing the differential test: SMULH without its signed correction, the 32-bit SDIV dividing
unsigned, the halves 31 bits wide. Three rounds alternated (`nocall/`), MIPS:

| | base | **no calls** |
|---|---|---|
| `dec_mips` | 516.5 · 514.1 · 513.8 | 514.4 · 516.5 · 515.5 (even) |
| `vm_dec_mmu_mips` | 508.0 · 510.1 · 505.9 | 511.7 · 511.9 · 513.1 (+0.6%, under the bar) |
| Alpine's boot through the block interpreter | 240.5 · 240.4 · 240.8 | 240.8 · 240.7 · 241.1 (+0.1%) |

**Not a speedup**: the calls cost the loop little, so V8 was already spilling its state around something else
(`hot`'s interrupt check calls out of line, loop 8). Kept for the rule the loop is written to, now checked.

**How these are measured from now on** (one decision shouldn't take a 70-minute A/B): counts first, from a diagnostic
core in one session, where they decide (the slot hash above); `hot`'s per-micro-op changes on the block-interpreter
guests (`bench/interp/ab-mac.sh … -- dec_mips vm_dec_mmu_mips boot_alpine_dec`, three rounds, ~18 min); Firefox's
pages session where a change is about cold, short-block code the small guests don't have; the JIT gates and the full
pages session once per batch of kept changes.

## The block interpreter on the Mac, loop 2: 262,144 slots (2026-11-09)

Loop 1's counts had `hot` return for a next block out of its slot 82.5 M times in Firefox's pages session (16,384
slots, direct-mapped). With 262,144 (4 MiB a table; `diag/counts4-s18.txt`): 23.4 M, `count_out` 128.6 → 49.3 M,
`hot`'s entries per block run 0.392 → 0.307. Each 4× about halved the misses (65,536: 44.0 M) and folding higher PA
bits into the index did nothing: the interpreted code's working set, not conflicts. Raw: `results/m9-interp-mac/slots/`.

**Firefox's pages session** from the snapshot (`PHASE_S=1`; each page's Firefox start and load, which run the cold
code, summed), three rounds alternated:

| | r1 | r2 | r3 | median |
|---|---|---|---|---|
| main (`a1ae06f4`) | 84.0 | 82.0 | 83.6 | 83.6 s |
| **262,144 slots** | 80.8 | 79.3 | 79.9 | **79.9 s (−4.4%)** |

Every page's start and load moved (wiki 17.4 + 6.1 → 16.8 + 6.3 s, BBC 14.2 + 6.8 → 13.6 + 6.5); interpreted steps
3.38-3.41 G in both arms. **The block-interpreter guests and the JIT gates**, three rounds alternated:

| | main | **262,144 slots** |
|---|---|---|
| `dec_mips` | 514.6 · 515.0 · 515.0 | 515.3 · 514.6 · 513.3 (even) |
| `vm_dec_mmu_mips` | 507.5 · 514.5 · 505.8 | 515.7 · 509.9 · 515.4 (even; this one's rounds spread ~2%) |
| Alpine's boot through the block interpreter, MIPS | 242.5 · 240.0 · 240.0 | **254.8 · 254.9 · 254.7 (+6.1%)** |
| Alpine's boot under the JIT, total ms | 4,156 · 4,164 · 4,105 | **4,047 · 4,065 · 4,071 (−2.0%)** |
| Alpine's userspace under the JIT, total ms | 10,934 · 11,068 · 10,944 | 10,887 · 10,908 · 10,894 (−0.4%) |

Kept, **for memory**: the slots go from 256 KiB to 4 MiB a table, written at allocation (an empty slot's key is all
ones), so +15 MiB resident on four vCPUs and +30 on eight, of the core's 1 GiB heap; in this session the decoded
blocks' arenas held ~198 MiB (`decBytes`) and the renderer ~3.5 GiB (loop 13's VM figure: these sessions didn't record
its RSS). Not tried: more slots (1 M would be +60 MiB on four vCPUs), before a smaller slot (one needn't keep the key
bits its index implies).

**Misaligned accesses, loads and stores apart** (the same counting session): LdO loads ~2.1 M and stores ~3.3 M, the
other single accesses' loads ~1.4 M and stores ~0.8 M. With loop 1's estimate (a `hot` return and the generic path,
a few tens of ns each) they are ~0.3% of the busy vCPU time, much less than the slots were.

## The block interpreter on the Mac, loop 3: the round trips to compiled code (2026-11-09)

A `--prof` profile of loop 2's core (Firefox's pages session, `PHASE_S=1`; `results/m9-interp-mac/prof/`: `attr.txt`
with tick offsets in `hot`, `jit::steps` and `jit::interpret`, `hot-node14.6.asm.gz` Node's code for `hot`, 14,492
bytes against Chrome 157's 14,464): the block interpreter 16.2% of busy ticks (18.4% before loops 1-2), `hot` 12.67,
`Cache::miss` 1.40 (+ its decoding closure 0.24), `jit::interpret` 0.71, `count_out` 0.64, `slot_in` 0.24; the
dispatcher (`jit::steps`) 2.18, compiled code's exits (`xmiss_el0`/`el1`) 1.61, `Jit::miss` 0.95. In `hot`, the
ticks sit on the handlers' first instructions (the indirect branch's landing; 0x1d9c, LdO's, 9% of `hot`) and after
their register writes, the dispatch head ~6%, the prologue 2.6% and the write-back on exit ~4%: the per-micro-op
dispatch, as loop 8 found in the VM. (Threaded dispatch, a jump table per handler, isn't expressible in wasm: LLVM's
backend routes irreducible control flow back through one dispatch block.)

**The round trips.** The dispatcher's loop runs ~311 M times a session: 162 M compiled dispatches and 149 M entries
to the interpreter, which stops before a compiled block 126 M times. Of what a round trip costs, compiled code's exit
and `hot`'s entry and exit stay whatever the dispatcher does, and the next PC's key is needed after every compiled
block; moving the dispatch loop into `jit::interpret` (it would call compiled blocks itself) would save only the
bookkeeping the two loops repeat, ~0.5-1% of busy time, for a rewrite of the dispatcher's unsafe core: not done.
Done instead: `hot` hands the dispatcher the key of the compiled block it stopped before (`Run::next`, and
`jit::interpret`'s jump-cache hit after a slot miss), so it skips `key`'s TLB lookup (~0.25%: not measured, under
what the pages session resolves). A debug assertion checks it against `key`; a planted key from the next page failed
the lockstep test (the FP guest, after 100,000 steps); no native test reaches it (compiled blocks exist only in wasm).

## The block interpreter on the Mac, loop 4: decoding without allocations (2026-11-09)

Decoding is `Cache::miss` and its closure, 1.64% of the pages session's busy ticks (loop 3). Measured natively
(`interp::block::tests::decode_speed`, `#[ignore]`: every 16th word of the guest kernel's first 4 MiB decoded as a
block start, 65,536 blocks of 4.2 micro-ops; Firefox's average is 5.2) and profiled with `perf`: 182 ns a block,
`Cache::miss` with the decoder inlined 24%, `pack` 18%, `end_op` 13%, `uop_op` 8%, `mov_runs` 7%, allocation
(malloc, realloc, `finish_grow`, memcpy) ~10%.

- `end_op` was a tree of compares over the ~900 classes, called a word: now a table made at compile time (`ENDS`,
  `end_class` holding the old match; an MSR keeps its test of the word), inlined: 182 → 176 ns.
- `form_with` grew a `Vec` from empty and `pack` made two more a block, copied into the arena: now `form_into` and
  `pack_into` fill two scratch vectors the `Cache` keeps, and a block's constants (at most `CAP`, 32) sit on the stack:
  176 → 149 ns. `pack` and `form_with` stay, as wrappers, for the tests and the JIT.
- One RAM lookup a block instead of a word (`mem.host` for the block's span): 149 → 150 ns natively, not kept.

**182 → 148 ns a block natively (−19%).** In Chromium on the Mac it doesn't resolve, as expected of ~0.3% of busy time
(`results/m9-interp-mac/decode/`, three rounds alternated against `5dcc1021`): Alpine's boot through the block
interpreter 253.9 → 253.6 MIPS (−0.1%, overlapping), `dec_mips` and `vm_dec_mmu_mips` even, the first-run `*_cold`
numbers even. Kept for what it is: no allocation a decode, no memory. A planted bug (the constants' offset one too far
in `pack_into`) failed three of the block interpreter's tests. What's left of decoding is compute: the decoder, `pack_into`
and `uop_op`'s matches.

Two A/A runs came first: a build in the side checkout `../webpc-base` (whose `target/` is this one's) left its core
in the shared output, the main checkout's next build counted as fresh, and the "change" arm was the base (`cmp` didn't
tell: the two checkouts' builds differ in their debug info's paths). Both arms agreed within ~0.2% on Alpine's boot,
which is this screen's noise. An arm is now checked by a changed function's size (`tools/wasm-sizes.ts`).

## The block interpreter on the Mac, loop 5: misaligned loads inline (2026-11-10)

Loop 2's counts had ~3.5 M misaligned loads (and ~4.1 M stores) a pages session leave `hot` for the generic path.
`hot`'s single-register loads (LdO and Ld) now read one inline where `fast_in` found its bytes in one range of RAM
(a page through the TLB, memory 0 through the flat map): `mem::load_misaligned`, the aligned 8-byte word holding its
first byte and, when it spills past it, the next (which starts at or before its last byte, so it's in the range too),
shifted together. Each byte is read once by an atomic load, all a misaligned access is owed without LSE2. Stores stay
on the slow path: one may write only its own bytes. `hot` 11,562 → 11,806 bytes of wasm, no call.

Correctness: a directed test (`misaligned_loads_run_as_the_interpreter_runs_them`: LDR X and W, LDRH, LDRSH, LDRSW,
LDUR and LDR by register at every misaligned offset, at a page's start and up to its last byte, against the reference
interpreter); a planted bug (the second word's shift 8 bits short) failed it and the differential test.

Three rounds alternated against `35f9fa41` (`results/m9-interp-mac/misaligned/`): `dec_mips` 514.7 → 517.9 (+0.6%,
rounds apart, under the bar), `vm_dec_mmu_mips` 510.8 → 516.2 (overlapping), Alpine's boot through the block
interpreter 253.75 → 254.13 MIPS (+0.1%). Nothing slower, so kept; its gain in a browser (~0.15% of busy time by
loop 1's estimate) is too small for the pages session to show, so not measured there. No memory.

## PERF loop 1: blocks out of their slot, more slots and a smaller slot (2026-11-10)

The Mac host (Apple M4, macOS 26.6.2), Chrome for Testing 157.0.8103.50; base `5d571308`; raw
`results/m9-interp-mac/perf1/` (README). Loop 2 left the decoded blocks' slots at 262,144 (16 bytes each, 4 MiB a
table), each 4× having halved the next-block misses, and two ideas: more slots, and a smaller slot to pay for them.

**More slots first, at 16 bytes** (1,048,576: 16 MiB a table, +48 MiB on four vCPUs; built only to see what more
would buy). Firefox's pages session from the snapshot (`PHASE_S=1`, each page's start and load summed), three rounds
alternated:

| | r1 | r2 | r3 | median |
|---|---|---|---|---|
| main | 79.1 | 78.5 | 78.8 | 78.8 s |
| 1,048,576 slots | 78.2 | 77.8 | 78.7 | 78.2 s (−0.8%, overlapping) |

Interpreted steps 3.37-3.40 G in both. Loop 2's 4× was −4.4%; this 4× is under the bar, so the slots are past where
more of them pay, whatever a slot's size.

**A smaller slot** (`slot8.diff`): 8 bytes, one `u64` holding only the key bits the index doesn't imply in place (the
regime bits and the PA's above the index; the key's bits from `PA_BITS` up are zero for every block, a filled bit
keeps an all-zero slot empty, so the table is allocated zeroed), the start (23 bits, under `MAX_BUDGET`), the length,
and the dispatches left before a report (counting down; the map keeps the quota given, so a report reads its count
as quota less what's left, and a dirty bit says an evicted slot's count must go back to the map). A lookup is
`(s ^ k) & TAG == FULL`, and `Flat::ikey` refuses a PC from `PA_BITS` up (it would alias one under). The block
interpreter's tests passed, plus a test of keys above `PA_BITS`; `hot` 11,806 → 11,828 bytes, no call. Three rounds
alternated (`p1s-r<round>-<arm>-<bench>.json`), MIPS:

| | main | 8-byte slots |
|---|---|---|
| `dec_mips` | 517.5 · 518.9 · 517.0 | 499.2 · 501.8 · 499.6 (−3.5%) |
| `vm_dec_mmu_mips` | 509.6 · 514.9 · 513.6 | 486.4 · 486.3 · 488.1 (−5.3%) |
| Alpine's boot through the block interpreter | 255.3 · 254.6 · 254.5 | 248.0 · 247.9 · 247.8 (−2.6%) |

**Not kept, either.** The packed slot's compare under a 64-bit mask, its fields' shifts and the full-word store back
cost `hot`'s chain step more than the 2 MiB a table (8 MiB on four vCPUs) is worth; these guests' reports are rare (no
compiles: every 255), so the loss is `hot`'s, not the map lookups the reports gained. With more slots not paying,
a smaller slot would have bought only memory, and not at this price. The slots stay 262,144 of 16 bytes.

## PERF loop 2: the dispatcher's loop inside `jit::interpret` (2026-11-10)

The Mac host (Apple M4, macOS 26.6.2), Chrome for Testing 157.0.8103.50; base `e6f37992`; raw
`results/m9-interp-mac/perf2/` (README). Loop 3 counted 126 M stops before a compiled block in Firefox's pages
session and 311 M trips around the dispatcher's loop, and put what a loop inside `jit::interpret` could save at
~0.5-1% of busy time.

**Built** (`fuse.diff`): `interpret` takes the vCPU's raw pointer and makes its references (the `Cpu`, the table, a
`Flat` or an `Mmu` over the TLB) afresh after each compiled block. When the decoded run stops before a compiled
block it runs it itself, as the dispatcher does (`Jit::fresh`, the jump cache, `Tlb::xdrops`, the transfer cache's
fill, the same statistics and clock through a shared `run_block`), keys the PC after it in the regime it runs
(`Regime::key`; a changed `Cpu::dispatch`, a tagged PC or a faulting fetch go back), runs a compiled successor the
same way, and a decoded one if `Cache::count` counts it; anything else goes back to the dispatcher with the key
made. Same steps and exits as before: lockstep, the differential test and `core-wasm` passed; a planted bug (the
next key from PC + 4) failed all four lockstep JIT cases. `interpret` 1,864 → 4,225 bytes of wasm (MMU) and
1,341 → 3,103 (flat), `steps` 2,824 → 2,733, `hot` unchanged (11,806 and 11,391), no memory. Firefox's pages
session from the snapshot (`PHASE_S=1`, each page's start and load summed), three rounds alternated:

| | r1 | r2 | r3 | median |
|---|---|---|---|---|
| main | 79.1 | 79.3 | 79.9 | 79.3 s |
| the loop in `interpret` | 77.8 | 79.4 | 79.2 | 79.2 s (−0.1%, overlapping) |

Interpreted steps 3.38-3.40 G in both. The JIT gates and the block interpreter's boot, three rounds
(`p2j-r<round>-<arm>-<bench>.json`):

| | main | the loop in `interpret` |
|---|---|---|
| Alpine's boot under the JIT, total ms | 3,957 · 4,022 · 4,022 | 3,971 · 3,978 · 3,992 (overlapping) |
| Alpine's userspace under the JIT, total ms | 10,814 · 10,886 · 10,894 | 10,825 · 10,859 · 10,881 (even) |
| Alpine's boot through the block interpreter, MIPS | 254.32 · 254.38 · 254.43 | 253.02 · 253.12 · 252.99 (−0.5%, rounds apart) |

**Not kept.** Nothing gains past the bar, and the block interpreter alone loses 0.5% (its `interpret` is now a
larger loop with a block call in it, for runs that never reach one). A trip around the dispatcher's loop costs
little beyond what stays (compiled code's exit, `hot`'s entry and exit, the next PC's key, `Jit::fresh`): the
loop head's tag strip, a second jump-cache probe, `interpret`'s call and `Run`'s setup, a few ns each time, which
126 M times a session is under what the pages session resolves. The unsafe rewrite isn't worth it.
