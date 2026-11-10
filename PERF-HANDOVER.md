# PERF: the performance backlog — handover

The user's brief (2026-11-10): go through every performance entry of docs/backlog.md that the dev VM or the Mac host
can try (ISA extensions count, implemented through to inline JIT code where it makes sense); for each, try, measure,
keep or drop with the reason written down, so the backlog keeps only what's still doable. x86-only entries stay as
they are. The first session (2026-11-10, loops 1-20, one subagent a loop) stopped at the user's request to switch
workflow; what each loop did is in the REPORT entries named "PERF loop N" (bench/interp/REPORT.md for the block
interpreter, bench/boot/REPORT.md for the ISA and JIT, bench/gpu/REPORT.md for the query poll).

Measurement rules: rank on the Mac; tiers (diagnostic counts → a 15-20 min 3-round screen with
`bench/interp/ab-mac.sh` or `bench/run-mac.sh` → Firefox's pages session `bench/results/local/interp/ab-pages.sh`
PHASE_S=1, 5 rounds when it decides, only for browser-side changes); ~1% with non-overlapping rounds;
`bench/gpu/mac-leftovers.sh` after every Mac run; arms checked by a changed function's size (`tools/wasm-sizes.ts`);
memory next to every speedup; CI alone in the background plus the topic scripts; `hot`'s copies make no calls.
Feature A/Bs: `SCRIPT=../imgdecode/codecs.ts ROUNDS=3 MAC_TIMEOUT=2700 bench/gpu/sway-mac.sh <feature>,<mode>
target/arch/desktop.qcow2 <name>` (modes `codecs`, `kernels`, `fp16k`, `bf16k`). Subagents' Monitor watchers
(`tail -F | grep`) can outlive them: check `ps` for stray `ugrep`/`tail` between loops.

## State (2026-11-10, after loop 20 `9be5a0f7`)

Kept: SUBS/CMP micro-op kinds (dec_mips +3%); misaligned pair and SIMD&FP loads inline; the rich FP copy of `hot`
chosen per block (FP guest +12-14%); DAIF/DAIFClr/DIT unmasks and ISB (outside parallel) inline (Alpine's boot
−1.9%); the JIT's wasm size cuts (−6% wasm) and one budget counter (Lua −1.7%); virgl's `spin` query poll
(glquery 15 → 280 frames/s); FEAT_RDM and FEAT_LRCPC2 advertised. Built but off by default (measured slower):
I8MM, FCMA, FP16, FHM, BF16. Dropped with findings in docs: slot size/count, the dispatcher in `interpret`,
SUBS's carry as a field, NZCV in a local, ADRP+ADD, misaligned stores, CCMP's kind, LSE2, LSE min/max inline, ISB
inline in parallel, the shared cache's leftovers, the SMP leftovers (ISB cost, WFE sleep, an exit's parts). Two
out-of-context reviews (after loops 8 and 19), their findings fixed in loops 9 and 20.

## Still open (the queue, by expected gain)

| Entry (docs/backlog.md) | Notes |
|---|---|
| JIT: scalar FP in f64/f32 locals | FP guest and FP-heavy guests only (0.5% of a browser's compiled instructions) |
| JIT: Liftoff's zero-fill (a register allocator over a block's locals) | bounded at ~0.3% of a browser now; likely a finding |
| JIT: the core's heap (decoded blocks' budget, page index, the untuned constants), the transfer cache's costs, the 320 MiB budget session, V8's per-function overhead | measure before building |
| JIT: counter reads inline in deterministic runs; the gates' timer rate (loop 8) | gates only |
| Interpreter, loop 19's ideas | cheaper `SWITCH` re-entry; more rich handlers (FMADD, FCVTZS, SIMD&FP LDR/STR register, vector MUL/SUB/CMxx, shifts, permutes); blocks marked rich at run time for hot slow paths (misaligned stores, STTR/LDTR, CASP); count single-MOVI rich blocks |

Left as they are: x86-only (DotProd/JSCVT tuning, `relaxed_trunc`), the OpenSSL MIDR (the user, 2026-11-10: keep
ours for now), bug watches (Firefox's first page, the lost Firefox process), parallel `make` (needs a harness), the
default vCPU count (settings, not a measurement).
