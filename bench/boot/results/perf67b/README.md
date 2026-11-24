# PERF loop 67b: the warm-up's latency (2026-11-24)

The data behind `bench/boot/REPORT.md` "PERF loop 67b: the warm-up's latency". M4 Mac mini (4 P + 6 E cores), macOS
26.6.2, Chrome for Testing 158.0.8127.88. The cores (not committed: `bench/results/local/perf67b/`): `main.wasm`
(a1ece66b's core, identical to e629de4a's and to 96ca41ae^'s: no core change since) and `warm.wasm` (the local branch
`perf67-warmup`'s core: polled modules marked `waarm64.warm`, every function behind `emit::warm_guard`).

The arms' host code: `pre58` is 96ca41ae^ (before PERF loop 58's idle waits) in the side checkout `../waarm64-base`
(`@../waarm64-base`); `main`, `before`, `after` and `idle` ran from the main checkout at a1ece66b with
`variants-web.patch` applied (`perf67-warmup`'s compile worker, the warm-up's moment as `?jitwarm=before|after|idle`,
the compile worker's counters in the status). `main` runs `main.wasm`, whose modules carry no marker: its worker only
compiles, as on main. `before` is loop 67 as built (warm, then post and move `ready`); `after` posts and moves `ready`,
then warms in the same job; `idle` posts and moves `ready`, and warms one module a task while no compile job waits.

- `pages/`: Firefox's pages session from `target/snapbench/pages.waarm64snap`, 3 rounds alternated
  (`KEEP_TIMELINES=1 bench/gpu/ab-mac.sh pages 3 pre58=main.wasm@../waarm64-base main=main.wasm warm=warm.wasm`).
- `churn/`: `PHASES=churn CHURN_S=90` (bench/gpu/firefox/churn.html, 40 new JS functions a second), 2 rounds,
  `main before after idle` (`QUERY_after=jitwarm=after QUERY_idle=jitwarm=idle`).
- `churn-load/`: `CHURN=rate=200`, 2 rounds, `main before idle`, with six busy loops on the Mac throughout (`perl -e
  'alarm 1800; 1 while 1'`): four of ten cores free.
- `pages-idle/`: the pages session again, 2 rounds, `idle main before`.
- `boots/`: `boots.sh 3`: the parallel boots `smp_alpine_jit` (bench/run-mac.sh), `main before idle` rotated.
- `latency.txt` in each: `node latency.ts <outdir>` over the full outdirs (it reads the vCPU timelines, which aren't
  committed: 6-10 MB each). Per session: Firefox's starts and loads; over each page's churn window (Firefox's launch to
  10 s past its `ready`; the churn phase's whole run) the share of steps compiled, its worst 1 s and 100 ms, the
  compile worker's busy share and busiest second, the mean and p99 bucket of a module's emission-to-`ready` delay;
  Firefox's longest gap between frames in each second (its `maxms`: p50/p90/p99/max, seconds past 50 and 100 ms, in
  the churn windows and in the scroll); the stalled ms a second (10 ms bins of a vCPU inside one core call retiring
  nothing). `stalls.json` (bench/gpu/stalls.ts) has the stalls of 20 ms and more.
