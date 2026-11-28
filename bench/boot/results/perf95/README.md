# PERF loop 95: block ends at the system instructions, counted (2026-11-28)

The data behind `bench/boot/REPORT.md` "PERF loop 95". Tree 387a6c2a (ABI 74). The dev VM's Node v26.7.0 and Chromium
155.0.8059.84; the Mac's Firefox pages session on M4, macOS, Chrome for Testing 158.0.8127.88.

- `diag.patch` (applies to 387a6c2a): the `diag` tallies grown to 184 words; compiled code bumps `80 + 2 * class +
  edge` at a block's last word when it ends the block (`block::end` is `After`) and is a system instruction
  (`tally::p95_class`: the MSRs by register, MSR immediate by field, TLBI by op, AT, DC and IC by op, ISB, CLREX,
  YIELD, SEV, SEVL, WFE, WFI, ERET); `edge` is 1 when the block goes on to the next instruction and that block is a
  member of its region (an edge, not a chain or an exit). The web/ part sums the tallies into
  `__status.stats.jit.diag`. Built with `CARGO_TARGET_DIR=target/diag scripts/build-wasm.sh --features diag`.
- `preempt-counts.json`: `bench/boot/preempt-counts.ts boot user` with that core in the dev VM's Node (it prints the
  `p95` rows).
- `counts/`: `node bench/ab.ts --workloads node,smp --min 2 --cap 2 --warm none` with the diagnostic core as both arms
  in the dev VM's Chromium (counts only; its verdict means nothing).
- `pages-diag/`: one Firefox pages session with that core (`bench/gpu/ab-mac.sh <dir> 1 diag=<core>`); `jit.jsonl.gz`'s
  last line has the totals.
- `p95.py <ab.json>`: the classes per 1000 steps of a paired run; `bound.py` (run here) writes `bound.txt`, the bound
  per workload.
