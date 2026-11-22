# PERF loop 55: parallel SMP's polled code without `acc`, built (2026-11-22)

The data behind `bench/boot/REPORT.md` "PERF loop 55". Base: 216adb06 (loop 54's tree), its core built in a side
checkout (`../waarm64-base`). M4, macOS, Chrome for Testing (the version is in each JSON).

- `codestats.json`: `bench/jit/codestats.ts` (arm64 and x64) on three dumps of Alpine's parallel boot on 4 vCPUs
  (`bench/jit/dump-modules.ts --parallel 4`, in the dev VM's Node): the base, this loop's counted code, and its code
  without `acc` (`--uncounted`).
- `gates.sh`: the gates' driver (`bench/run-mac.sh` per run, the arms alternated, the first rotated each round):
  `base` (the base's tree and core), `counted` (this loop's core, the benchmarks' default) and `uncounted` (the same
  core, `--query=uncounted`). `p55-<arm>-r<round>-<bench>.json`: its results. `python3 summary.py . p55 base
  uncounted` (or `counted`) prints each result's per-round medians as ranges, the change of their medians and whether
  they overlap. The parallel gates are `smp_alpine_jit` and `smp_user_jit_4` (`p55-*`); the round-robin ones,
  `boot_alpine_jit` and `alpine_user_jit` with `ARMS="base counted"` (`p55rr-*`, `summary.py . p55rr base counted`).
- `pages/`: Firefox's pages session from `target/snapbench/pages.waarm64snap` (`bench/gpu/ab-mac.sh`, 3 rounds, three
  arms: `base` from the base's tree, `counted` and `uncounted` this loop's core with `+count=1` and `+count=0`);
  `node bench/gpu/ab-summary.ts pages` sums them up (its `platMs` is the platform lock's wait,
  `par.lockWaitNs`; `busyMips` and `share` mean nothing in the uncounted arm, whose compiled steps aren't counted).
  `mac.vmstat` is the whole Mac's: no per-process memory there (macOS has no smaps).
