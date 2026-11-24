# PERF loop 69: the compile threshold on the Mac at 64-block regions (2026-11-24)

The data behind `bench/boot/REPORT.md` "PERF loop 69". Base b9c6eb17 (ABI 74); every core built from it with only
`Config::DEFAULT`'s `threshold` and `threshold_max` (core/src/jit/mod.rs:218-219) changed (`build.sh <name> <floor>
<max>`; arms `t500` 500/1000, `t1000` 1000/2000 the base, `t2000` 2000/4000, `t4000` 4000/8000; `cores.sha256`, the
cores not committed: `bench/results/local/perf69/`). M4 Mac mini, macOS 26.6.2, Chrome for Testing 158.0.8127.88.

- `node/`, `node2/`: `bench/ab-mac.sh` on `node` (BUDGET 2700): t500 and t2000, then t2000 and t4000, against t1000.
  `out.txt` the verdict, `counters.txt` from `python3 counters.py <ab.json>` (perf68's), `node/pool-t2000.txt` from
  `python3 pool.py t2000 node/ab.json node2/ab.json`.
- `smp/`: `WORKLOADS=smp bench/ab-mac.sh`, t1000 against t2000, with the latency counters.
- `boots/`: the parallel boots `smp_alpine_jit` and `smp_user_jit_4`, 3 rounds alternated
  (`ARMS="t1000 t2000" PREFIX=p69 gates.sh 3 smp_alpine_jit smp_user_jit_4`), the Chrome processes' peak RSS in
  `rss/`; `summary.txt` from `python3 ../region64/summary.py boots p69 t1000 t2000`.
- `pages/`: Firefox's pages session cut to two pages (`KEEP_TIMELINES=1 PAGES=wiki,mdn bench/gpu/ab-mac.sh pages 3
  t2000=… t1000=…`), `summary.txt` from `node bench/gpu/ab-summary.ts`, `latency.txt` from
  `node ../perf67b/latency.ts` (the timelines it read stay in `bench/results/local/perf69/pages/`, not committed).
