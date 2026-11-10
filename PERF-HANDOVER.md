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
| 2 | Interpreter: the dispatcher's loop inside `jit::interpret` (round trips to compiled code) | next |
| 3 | Interpreter: `hot`'s per-micro-op cost — SUBS's flags from operands, ADRP+ADD pair, register caching | |
| 4 | Interpreter: misaligned stores inline | |
| 5 | CPU/ISA: unadvertised M4 extensions — LSE2, LRCPC2, RDM, FHM, FCMA, I8MM, BF16, FP16 (one loop each or grouped) | |
| 6 | JIT: helpers on real paths (MSR DAIFClr/regime/NZCV…, ISB, LSE min/max) | |
| 7 | JIT: wasm size cuts (local.tee peephole, a guarded chain's fallback as `xmiss`, one budget counter, NZCV functions) | |
| 8 | JIT: the shared cache's leftovers (one vCPU's 1-2%: a lone table takes the bytes) | |
| 9 | SMP: the ISB fix's cost; WFE sleeping; an exit's remaining cost | |
| 10 | Devices: virgl's occlusion-query poll (4 ms) | |
| 11 | Interpreter: more handlers (FP in a second `hot` copy, CASP, STTR/LDTR) | |
| 12 | JIT: scalar FP in f64/f32 locals | |
| 13 | JIT: Liftoff's zero-fill (a register allocator over a block's locals) | |
| 14 | JIT: the core's heap tuning, transfer cache costs, the rest of the JIT section | |

Left as they are: x86-only (DotProd/JSCVT tuning, `relaxed_trunc`), the OpenSSL MIDR (the user's call), bug watches
(Firefox's first page, the lost Firefox process).

## Loops done

- **Loop 1** (`8276864e`): slots. 1 Mi slots −0.8% on the pages session (rounds overlap; +48 MiB on 4 vCPUs); 8-byte
  slots −2.6 to −5.3% on the screen (`hot`'s masked compare). Dropped, docs/cpu.md "Tried and not kept"; entry removed.
