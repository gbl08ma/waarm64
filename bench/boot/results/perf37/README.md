# PERF loop 37: the review of region formation fixed (2026-11-21)

The data behind `bench/boot/REPORT.md` "PERF loop 37".

- `perf37-r<round>-r1-<arm>-<bench>.json`: `bench/interp/ab-mac.sh` on the Mac (M4, Chrome for Testing 158.0.8127.36),
  one round a call; `base` 10882a61 (PERF loop 36), `fix` the loop's core. Base first in rounds 1 and 3, fix first
  in round 2. `summary.txt`: the rounds, medians and compile-side counters per arm.
- `codestats.json`: `bench/jit/codestats.ts` over both arms' modules of Alpine's boot (`bench/jit/dump-modules.ts`,
  deterministic: 317 and 315 modules).
- `diag.py`: ports loop 36's diagnostic (`../perf36/diag-fix.patch`: apply its `emit.rs`, `mod.rs` and `lib.rs` hunks,
  then `python3 diag.py core/src/jit/block.rs base|fix`; build with `--features diag`): the returns elsewhere
  (`jit_diag_ret`) and tallies 13, 14 and 16 (17 dropped: it needed the walk's `inside`, gone).
- `diag-<arm>-rets.txt`: `../perf36/rets.ts` over `bench/boot/userprof.ts` with each diagnostic core (the dev VM, Node).
