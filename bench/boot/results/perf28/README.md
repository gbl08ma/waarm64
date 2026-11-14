# PERF loop 28: the transfer cache's costs (2026-11-14)

The data behind `bench/boot/REPORT.md` "PERF loop 28".

- `diag.patch`: the diagnostic core (on c283763f): `TlbStats::diag` counters (flushes by VA, entries they cleared,
  nG and full flushes, bumps, the scan's host-clock ns and the clock's own cost), wasm counters in the transfer
  cache's probe hit and in the miss function (why it missed: zeroed entry, another tag, an older generation, tag and
  generation fine), and at the miss function's callers (a by-VA link's failed check, a host return elsewhere);
  `jit_helper_report` prints them as `XD<i>`. `tools/xd.ts <marks.json>` tabulates them per phase (its names are the
  last build's; slot 3 was the by-VA bumps, 6 and 7 the full flushes and drop bumps in `diag-marks.json`).
- `diag-marks.json`, `diag.txt`: `bench/boot/userprof.ts` with that core (Node, the dev VM), slot 17 = host returns
  at the continuation that still missed.
- `diag-depth-marks.json`: slots 3 and 17 = returns elsewhere at host depth < 8 and ≥ 56, 6 and 7 = `ret_up`s after
  a region's failed return prediction and all `ret_up`s at depth > 0.
- `diag-miss-call-marks.json`: a probe's miss inside a guest call as a host call; `diag-with-call-loop.patch` and
  `diag-call-loop-marks.json`: the host-call loop at a return elsewhere. Neither kept.
- `fix-counts.patch` (JIT and lib.rs part; in `mmu.rs` four counters in `flush_va`: calls, scans, kernel-half scans,
  kernel-half calls) and `fix-counts-marks.json`; `tools/xd2.ts` tabulates them.
- `perf28-r<round>-r1-<arm>-<bench>.json`: `bench/interp/ab-mac.sh` on the Mac (M4, Chrome for Testing
  157.0.8103.78), one round a call; `base` c283763f (9,418,983 bytes), `fix` the loop's core (9,420,592 bytes). Base
  first in rounds 1 and 3, fix first in round 2.
