# PERF loop 56: the ticker review's fixes, measured (2026-11-22)

The data behind `bench/boot/REPORT.md` "PERF loop 56". Base: 1b0224f8 (loop 55's tree), its core built in a side
checkout (`../waarm64-base`). M4, macOS, Chrome for Testing (the version is in each JSON).

- `gates.sh`: loop 55's driver, the base at 1b0224f8 (`base`, `counted`, `uncounted` with `--query=uncounted`).
  `p56-<arm>-r<round>-<bench>.json`: its results for `smp_alpine_jit` and `smp_user_jit_4`. `python3 summary.py . p56
  base uncounted` (or `counted`) prints the per-round medians as ranges and whether they overlap.
- `pages/`: Firefox's pages session from `target/snapbench/pages.waarm64snap` (`bench/gpu/ab-mac.sh`, 3 rounds:
  `base` from the base's tree, `counted` and `uncounted` this loop's core with `+count=1` and `+count=0`);
  `node bench/gpu/ab-summary.ts pages` sums them up; the platform lock's contended acquisitions are `par.lockContended`
  in each `results.json`.
