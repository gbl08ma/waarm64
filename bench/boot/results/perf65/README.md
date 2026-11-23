# PERF loop 65: `BATCH_STEPS` on the Mac (2026-11-23)

The data behind `bench/boot/REPORT.md` "PERF loop 65". Base d1fcaf2a (ABI 74); every core built from it with only
`jit::BATCH_STEPS` changed (25K, 50K the base, 100K, 200K). M4, macOS, Chrome for Testing 158.

- `node/`, `gates/`: `bench/ab-mac.sh` (`ab.json`, `verdict.txt`, `log.txt`) on `node` (four arms) and
  `WORKLOADS=user,boot` (25K, 50K, 100K); `counters.txt` from `python3 counters.py <ab.json>`: each workload's median
  JIT counters, footprint, instructions and cycles against 50K.
- `smp/`: the parallel boots `smp_alpine_jit` and `smp_user_jit_4`, 50K against 100K, 3 rounds alternated
  (`gates.sh`, `bench/run-mac.sh` per run; `pg-<arm>-r<round>-<bench>.json`, the Chrome processes' peak RSS in
  `rss/`); `summary.txt` from `python3 ../region64/summary.py smp pg b50k b100k`.
- `pages/`: Firefox's pages session cut to two pages (`PAGES=wiki,mdn bench/gpu/ab-mac.sh pages 2 b100k=… b50k=…`),
  `summary.txt` from `node bench/gpu/ab-summary.ts`.
