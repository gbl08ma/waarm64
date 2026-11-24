# PERF loop 68: `WARM` with `REPORT` on the Mac (2026-11-24)

The data behind `bench/boot/REPORT.md` "PERF loop 68". Base f591d64e (ABI 74); every core built from it with only
`jit::WARM` (core/src/jit/mod.rs:537) and `interp::block::REPORT` (core/src/interp/block.rs:3154) changed
(`build.sh <name> <WARM> <REPORT>`; arms named `w<WARM>r<REPORT>`, `w16r16` the base; `cores.sha256`, the cores not
committed: `bench/results/local/perf68/`). M4 Mac mini, macOS 26.6.2, Chrome for Testing 158.0.8127.88.

- `node/`, `node2/`, `node3/`: `bench/ab-mac.sh` on `node` (BUDGET 2700/2400), three runs of the base and four arms
  each: w4r4 w8r8 w32r16 w32r32; w32r32 w64r32 w64r64; w64r64 w128r64 w128r128. `out.txt` the verdict,
  `counters.txt` from `python3 counters.py <ab.json>` (perf65's, with the JIT's flushes). `pool.py <arm> <ab.json>...`
  pools an arm's pairs over runs (a plain 99% t interval, no sequential correction).
- `smp/`: `WORKLOADS=smp bench/ab-mac.sh`, w16r16 against w64r64 (12 pairs), with the latency counters.
- `boots/`: the parallel boots `smp_alpine_jit` and `smp_user_jit_4`, 3 rounds alternated
  (`ARMS="w16r16 w64r64" PREFIX=p68 gates.sh 3 smp_alpine_jit smp_user_jit_4`), the Chrome processes' peak RSS in
  `rss/`; `summary.txt` from `python3 ../region64/summary.py boots p68 w16r16 w64r64`.
- `pages/`: Firefox's pages session cut to two pages (`KEEP_TIMELINES=1 PAGES=wiki,mdn bench/gpu/ab-mac.sh pages 3
  w64r64=… w16r16=…`), `summary.txt` from `node bench/gpu/ab-summary.ts`, `latency.txt` from
  `node ../perf67b/latency.ts` (the timelines it read are in `bench/results/local/perf68/timelines/`, not committed).
