# PERF loop 32: what a chunk end costs, and the ticker that wasn't kept (2026-11-16)

The data behind `bench/boot/REPORT.md` "PERF loop 32". The code measured is a9b8d140's (loop 31's) unless an arm says
otherwise; nothing of the arms below is in the tree.

- `counts-default.json`, `counts-long.json`, `counts-paced.json`: `bench/boot/preempt-counts.ts` (the diagnostic core,
  Node 26.7.0 on the dev VM; `--in` prints them) for `smp1`, `smp4`, `smp-user4`: loop 31's code with its default
  chunk, the same with `--chunk 1048576` (2^20-step chunks, no ticker), and the paced arm's core (`paced.patch`,
  `--features diag,paced`). The slots 31 and 47 (new in this loop) count the chunks that ended by their steps and the
  clock's ns from each one's end to the next one's start.
- `mac-<session>-r<round>-<arm>-<bench>.json`: the Mac A/Bs (`bench/run-mac.sh` with `WASM=` per arm, Chrome for
  Testing 157.0.8103.78, the arms' order reversed every other round, nothing else on the dev VM; Spotlight's `mds_stores`
  took ~40% of a Mac core through all of them). `python3 summary.py . mac-<session> <armA> <armB>` prints each bench's
  per-round medians as ranges, the change and the overlap.
  - `mac-ceiling`: `base` (default chunk) against `long` (`?chunk=1048576`, the same core), 5 rounds.
  - `mac-paced`: `base` against `paced` (`paced.patch`), stopped after round 2's first arm (the host was being changed
    for the next session): round 1 both, round 2 `paced` only (its `smp_user_jit_4` may have run with the compile worker's
    stores: the host changed about when it started).
  - `mac-cw`: `base` (`?nocwstop`: the compile worker leaves the stop words alone, as loop 31), `basecw` (loop 31's
    core, the compile worker storing 0 in every stop word when `ready` moves: `compile-stops.patch`) and `pacedcw`
    (`paced.patch`'s core with that host), 5 rounds.
  - `mac-short`: `base` against `short` (`?chunk=8192`), 3 rounds (both with `?nocwstop`, as loop 31's host).
- `paced.patch`: the paced run loop (`core/src/vm/parallel.rs`, behind a `paced = []` feature of `core/Cargo.toml`);
  `compile-stops.patch`: the compile worker as a setter (`web/`; the bench's `?nocwstop` turned it off through a
  temporary `compileStops` option of `bootVm`).
