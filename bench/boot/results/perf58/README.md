# PERF loop 58: WFI's sleep to its deadline on macOS (2026-11-23)

The data behind `bench/boot/REPORT.md` "PERF loop 58". Base: 5d8f29ef (the core unchanged in every arm: only
web/vcpu-worker.ts's idle wait differs). M4, macOS; Node 26.10.0 and Chrome for Testing 158 there.

- `counts/`: `bench/boot/preempt-counts.ts` with the diagnostic core (`--features diag`), `--in <file>` prints them.
  In the Mac's Node: `p58-base-{1,2}` (one `Atomics.wait` to the deadline), `p58-halve-{1,2}` and `p58-f50-3` (waits of
  1/2 of the time left, the last 40 µs spun), `p58-f67-2` and `p58-final-1` (2/3, what was kept); smp1, smp4,
  smp-user4. The screen (smp4, smp-user4, one run each, env knobs in a scratch copy of web/idle-wait.ts):
  `p58-t40f50`/`p58-f50`/`p58-f50b` (1/2), `p58-t20f50` (a 20 µs tail), `p58-t40f75` (3/4), `p58-t40nospin` (1/2,
  a wait instead of the tail's spin), `p58-f60` (3/5), `p58-f67` (2/3). In the dev VM's Node: `p58-vm-base`,
  `p58-vm-halve` (1/2), `p58-vm-final` (2/3).
- `idle/`: `bench/boot/idle-cpu.ts 4 5 20` (`6 20` in the first file) in the Mac's Node, one JSON line per run, in run
  order: `p58-idle-mac.txt` base against 1/2 (3 rounds alternated), `-2` adds the no-spin variant (2 rounds),
  `-3` base, 1/2, 3/5 and 2/3 (3 rounds, the order rotated); `p58-idle-screen.txt` the screen's runs after each
  variant's counts and the kept code's.
- `gates/`: `bench/run-mac.sh … --page bench/boot/index.html --only smp_alpine_jit|smp_user_jit_4`, the first arm
  swapped each round. `p58a-*`: base against 1/2 (`halve`), 3 rounds of both and 3 more of `smp_user_jit_4` (Spotlight
  was indexing on the Mac during the first rounds); `p58-*`: base against 2/3 (`share`), 3 rounds.
  `python3 ../perf53/summary.py . p58a base halve` (or `p58 base share`).
- `pages-half/`, `pages-share/`: Firefox's pages session from `target/snapbench/pages.waarm64snap`
  (`bench/gpu/ab-mac.sh`, 3 rounds; the base arm from `../waarm64-base` at 5d8f29ef), base against 1/2 and 2/3;
  `node bench/gpu/ab-summary.ts pages-half` sums them up.
