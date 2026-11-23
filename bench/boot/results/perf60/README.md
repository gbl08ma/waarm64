# PERF loop 60: the vCPU worker's idle and wake paths (2026-11-23)

The data behind `bench/boot/REPORT.md` "PERF loop 60". Base: 1fe6dec0 (`../waarm64-base`); the fix changes web/ only
(the core is the same file in every arm). M4, macOS; Chrome for Testing 158.0.8127.36 and Node 26.10.0 there.

- `tallies/`: `bench/run-mac.sh … --page bench/boot/index.html --only smp_alpine_jit|smp_user_jit_4
  "--query='tallies[&vyield=1]'"` with the diagnostic core (`WASM=target/diag/…`), 2 rounds of the arms `base`,
  `base-v1`, `new`, `new-v1` (`-v1`: `vyield=1`), the order rotated each round: `p60t-<bench>-<arm>-<round>.json`.
  `new-v1-1` of `smp_alpine_jit` is missing: its first boot hit the idle limit (REPORT). `python3 tallies.py` sums
  them up.
- `gates/`: `bench/run-mac.sh … --only smp_alpine_jit|smp_user_jit_4` with the normal core, 3 rounds, the first arm
  swapped each round: `p60-<arm>-r<round>-<bench>.json`; `python3 ../perf53/summary.py gates p60 base fix`.
- `pages/`: Firefox's pages session from `target/snapbench/pages.waarm64snap` (`bench/gpu/ab-mac.sh`, 3 rounds);
  `node bench/gpu/ab-summary.ts bench/boot/results/perf60/pages`.
- `idle/p60-idle-mac.txt`: `bench/boot/idle-cpu.ts 4 5 20` in the Mac's Node, one JSON line per run in run order.
- `race-mac.json`: a scratch page (not kept) in Chrome on the Mac: 4 workers each looping on `Atomics.waitAsync(word,
  0, current, 0.001)` with a few µs of spin between, 4 more bumping and notifying the words every 0-300 µs, 90 s, a
  watchdog for a wait that never resolves: `hangs` 0 of `waits` 9.7M.
