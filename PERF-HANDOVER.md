# PERF: the performance backlog — handover

The user's brief (2026-11-10, overnight): go through every performance entry of docs/backlog.md that the dev VM or
the Mac host can try (ISA extensions count, implemented through to inline JIT code where it makes sense); for each,
try, measure, keep or drop with the reason written down, so the backlog keeps only what's still doable. x86-only
entries stay as they are. One subagent at a time in the main checkout, each committing and pushing its own loop; the
supervisor triages and keeps this file. Summary for the user around 10 AM, then keep going.

Measurement rules (each brief repeats them): rank on the Mac; tiers (diagnostic counts → a 15-20 min 3-round screen
with `bench/interp/ab-mac.sh` or `bench/run-mac.sh` → Firefox's pages session `bench/results/local/interp/ab-pages.sh`
PHASE_S=1 only for cold-code changes); ~1% with non-overlapping rounds; `bench/gpu/mac-leftovers.sh` after every Mac
run; arms checked by a changed function's size (`tools/wasm-sizes.ts`); memory cost next to every speedup (ask past a
few tens of MiB); CI alone in the background, plus the topic scripts (JIT: `ci-jit.sh`, a planted bug); `hot` makes no
calls.

## Queue (supervisor's order, by expected gain on real workloads)

| # | Entry (backlog section) | State |
|---|---|---|
| 1 | Interpreter: blocks out of their slot — a smaller slot, then maybe more slots | dropped (loop 1) |
| 2 | Interpreter: the dispatcher's loop inside `jit::interpret` (round trips to compiled code) | dropped (loop 2) |
| 3 | Interpreter: `hot`'s per-micro-op cost — SUBS's flags from operands, ADRP+ADD pair, register caching | dropped (loop 3) |
| 4 | Interpreter: misaligned stores inline; SUBS/ADDS as their own micro-op kinds (loop 3's idea) | SUBS kinds kept, stores dropped (loop 4) |
| 5 | CPU/ISA: unadvertised M4 extensions — LSE2, LRCPC2, RDM, FHM, FCMA, I8MM, BF16, FP16 (one loop each or grouped) | I8MM unadvertised (loop 5); RDM, LRCPC2 advertised (loop 6); FCMA unadvertised (loop 7); FP16+FHM, BF16, LSE2 after item 6 |
| 6 | JIT: helpers on real paths (MSR DAIFClr/regime/NZCV…, ISB, LSE min/max) | unmasking MSRs, DIT, ISB (det.) inline (loop 8) |
| 7 | JIT: wasm size cuts (local.tee peephole, a guarded chain's fallback as `xmiss`, one budget counter, NZCV functions) | |
| 8 | JIT: the shared cache's leftovers (one vCPU's 1-2%: a lone table takes the bytes) | |
| 9 | SMP: the ISB fix's cost; WFE sleeping; an exit's remaining cost | |
| 10 | Devices: virgl's occlusion-query poll (4 ms) | |
| 11 | Interpreter: more handlers (FP in a second `hot` copy, CASP, STTR/LDTR) | |
| 12 | JIT: scalar FP in f64/f32 locals | |
| 13 | JIT: Liftoff's zero-fill (a register allocator over a block's locals) | |
| 14 | JIT: the core's heap tuning, transfer cache costs, the rest of the JIT section | |

Left as they are: x86-only (DotProd/JSCVT tuning, `relaxed_trunc`), the OpenSSL MIDR (the user, 2026-11-10: don't report another CPU's MIDR for now; the item stays in the backlog —
add that note to it after loop 10), bug watches
(Firefox's first page, the lost Firefox process).

## Loops done

- **Loop 1** (`8276864e`): slots. 1 Mi slots −0.8% on the pages session (rounds overlap; +48 MiB on 4 vCPUs); 8-byte
  slots −2.6 to −5.3% on the screen (`hot`'s masked compare). Dropped, docs/cpu.md "Tried and not kept"; entry removed.
- **Loop 2** (`fda7a22d`): the dispatcher's loop inside `jit::interpret`. Pages session −0.1% (overlapping), JIT
  gates even, the block-interpreter boot −0.5%. Dropped, docs/cpu.md "Tried and not kept"; entry removed.
- **Loop 3** (`38180965`): `hot`'s per-micro-op cost. SUBS's carry from operands −0.8 to −2.9%, NZCV in a local −1.9
  to −3.5%, ADRP+ADD fused within ±0.3%. All dropped (docs/cpu.md); entry removed.
- **Loop 4** (`f5c44c14`): **kept** SUBS immediate/shifted as their own micro-op kinds (one static carry compare):
  `dec_mips` +3.1/+3.4%, `vm_dec_mmu_mips` +2.2/+3.4%, Alpine's block-interpreter boot +0.6/+0.7% (two sessions,
  rounds apart), no memory, `hot` +707 B, no calls; ci.sh passed (second run; first hit the known clipboard-toolbar
  timeout). Dropped: misaligned stores inline (loop −3%, unrolled even; ~0.15% bound), CCMP as its own kind (even).
  Its leftover ideas (ADDS shifted/extended kinds; re-screening earlier losers over the SUBS kinds) judged too small
  for a loop: the latter isn't a backlog item.
- **Loop 5** (`a4e21ce4`): FEAT_I8MM complete (interpreter, inline SIMD128, corpus 2,000 vs M4+QEMU, `?i8mm=1`, ABI
  61) but **off by default**: codecs tie on the Mac (±3-5% noise), a ggml-style SMMLA tile 19% slower than SDOT's
  (the M4 itself: 2×). Codec A/B on the Mac: `SCRIPT=../imgdecode/codecs.ts ROUNDS=3 MAC_TIMEOUT=2700
  bench/gpu/sway-mac.sh <feature>,codecs target/arch/desktop.qcow2 <name>` (~4 min a round); counting script
  `bench/results/local/i8mm/count.ts`. CI: ci.sh, ci-jit.sh, ci-debian.sh passed.
- **Loop 6** (`1d1843bb`): FEAT_RDM and FEAT_LRCPC2 complete, inline, **advertised** (ABI 62; `?rdm=0`, `?rcpc2=0`).
  Kernels (`bench/imgdecode/rdmk.c`, codecs.sh `kernels` mode): Q15 FIR −12.6%, Q31 MAC −38.6% (rounds apart), LDAPUR
  ties. Only glycin's loader uses RDM in the images, nothing LRCPC2. Steps moved once (asimdrdm, ilrcpc). CI: ci.sh,
  ci-jit.sh, ci-debian.sh passed.
- **Loop 7** (`aed95154`): FEAT_FCMA complete, inline over the FMA fast paths, **off by default**: no user in the images;
  `bench/imgdecode/fcmak.c` FCMLA vector ties, by element +10% and FCADD +3% slower (rounds apart: per-instruction
  shuffles and sign masks the v8.0 code shares). ABI 63, `?fcma=1`. CI: ci.sh, ci-jit.sh, ci-fp.sh passed.
- **Loop 8** (`217a66fa`): **kept** DAIFClr and `MSR DIT` inline; unmasking DAIF writes inline behind a per-vCPU
  `jit::State::unmask` word (no IRQ due; parallel SMP also loads the IRQ byte); ISB inline outside parallel SMP.
  Mac: Alpine's boot −1.9% (rounds apart), userspace −1.2% (overlapping); 8 B a vCPU; steps unchanged. LSE min/max: no
  workload runs them. ci.sh (second run: the first caught an xHCI-tick divergence, fixed), ci-jit.sh, ci-debian.sh
  passed. Untested: the parallel IRQ-byte check (a miss waits to the chunk's end). Two gate-only items added to the
  backlog (counter reads inline in deterministic runs; the gates' timer rate).
- **Review** after loop 8 (static, loops 4-8's code): no wrong-result defect; four latency/test/comment findings.
- **Loop 9** (`67c5f4ca`): the review's four fixes, each failing first: no inline unmask in realtime round-robin (a
  bare-metal guest caught IRQs up to a chunk late); parallel blocks also check the pending-maintenance byte; jit-diff
  covers the inline arm (`jit_unmask`/`jit_parallel` exports, ABI 64); comments. Gates even. CI passed.
