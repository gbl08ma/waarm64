# BENCH: faster, quieter A/Bs — handover

The brief, the loops and what needs the user's OK: BENCH-KICKOFF.md. What each loop measured: bench/boot/REPORT.md
"BENCH loop N". What exists: docs/benchmarking.md "Counters".

## State (2026-11-23, after loop 1)

Loop 1 is done: the renderer's instructions, cycles, CPU time, P-core share and energy are in every Mac gate run
(`_instr_step`, `_cycles_step`, `_pshare`, … beside each `_total`) and every pages session (`results.json` `proc`,
ab-summary's `ginstr`, `gcycles`, `instrStep`, `cyclesStep`, `pshare`). A/A floors, single samples: deterministic
gates' instructions a step 0.06-0.07% (the clock 0.7-1.6%), cycles a step 0.5-0.7%; the pages session's instructions
0.28% (`pagesS` 0.69%, four sessions). On the userspace gate the clock's noise is the P-core share's (correlation
−0.97). Its commit passed `scripts/ci-fast.sh`.

## Next: loop 2 (the paired command)

- One command for a Mac A/B: arms `name=core.wasm[@tree][?query]` against one base, an A/A arm, short alternated
  pairs, the first boot dropped, paired ratios' interval per measure (wall, cycles a step, instructions a step), a
  stop when the interval excludes zero or lies within ±0.5%, or at a cap; the memory and the compile counters in its
  verdict; `mac-leftovers.sh` inside.
- From loop 1 to use: the P-core share as a covariate for the clock (adjust or reject low-share samples; try both
  on the A/A data in `bench/boot/results/bench1/gates/`); each `bench/run-mac.sh` call costs ~25 s of rsync,
  `npm ci` and Chrome's check before its samples, so many arms and samples in one page load (the suite alternating
  cores inside one run, as `bench/interp/paired.ts` does) would cut a pair's cost more than anything else.
- Open from loop 1: the pages session's cycles and instructions a step in an A/A (three of four sessions lacked the
  steps; fixed, not re-run); per-thread counters weren't needed (the P-core share stands in for "which cores").
