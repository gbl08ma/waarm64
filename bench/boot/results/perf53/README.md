# PERF loop 53: `acc`'s bound re-measured, and a timer setter on the Mac (2026-11-22)

The data behind `bench/boot/REPORT.md` "PERF loop 53". Base: 2ae98b16 (loop 52's tree). M4, macOS, Chrome for Testing
158.0.8127.36.

- `p53-<arm>-r<round>-<bench>.json`: the parallel gates (`bench/run-mac.sh` with `WASM=` per arm), 3 rounds, the first
  arm swapped each round. `base`: 2ae98b16's core and web/. `noacc`: the core with `noacc.patch` (PERF loop 34's,
  applied unchanged; measurement only: `acc` a constant 0, polls `0 < word`, steps and MIPS wrong by design), run from
  a side checkout whose web/ had `compile-stops.patch` (the compile worker stores 0 in every stop word when `ready`
  moves). `python3 summary.py . p53 base noacc` prints each result's per-round medians as ranges, the change of their
  medians and whether they overlap.
- `pages/`, `pages.log`: Firefox's pages session from `target/snapbench/pages.waarm64snap` (`bench/gpu/ab-mac.sh`,
  3 rounds alternated), base against noacc; `pages2/`, `pages2.log`: a second session of runs with a third arm,
  `batch` (`batch.patch`: the base with polled code's compiled steps left out of the table's clock, as the noacc arm's
  are, which makes its batches wait longer: fewer modules). `node bench/gpu/ab-summary.ts pages` (or `pages2`) sums
  them up.
- `counts-mac-today.json`, `counts-mac-today-user.json`: `bench/boot/preempt-counts.ts` (the base's diagnostic core) in
  the Mac's Node 26.10.0: smp1, smp4, smp-user4; the latencies today (`--in <file>` prints them).
- `setters-mac.json` (gap 1 ms, every mechanism), `setters-mac-g1000.json`, `setters-mac-g4000.json` (`wait`, `spin`,
  `halve` at 1 and 4 ms gaps): `bench/boot/timer-setters.html`, samples rounded to 0.1 µs.
