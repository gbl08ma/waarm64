# PERF loop 71: a region's repeated last emission, kept (2026-11-24)

The data behind `bench/boot/REPORT.md` "PERF loop 71". Base ac38c9c1 (ABI 74); `new` is the commit's
`core/src/jit/block.rs` (an emission whose arguments are the last emission's is that one, kept). The cores are not
committed (`bench/results/local/perf71/`, `cores.sha256`). M4 Mac mini, macOS 26.6.2, Chrome for Testing
158.0.8127.88; the dev VM's Chromium 155.0.8059.84 for the counts.

- `dump/`: the sha256 of every module `bench/jit/dump-modules.ts` saved on Buildroot's boot (43) and Alpine's (317)
  for `base`, `new` and the planted bugs (`plant1`: the memo not comparing the flag states; `plant2`: not comparing the
  register states). `base` and `new` are identical; `plant1` too (no emission on either gate has the last one's
  `plain` and register states but other flag states); `plant2` changes 26 of Buildroot's 43.
- `counts/`: the diagnostic cores on the dev VM (`node bench/ab.ts --min 2 --cap 2`, the diagnostic core as the
  base, `new` beside it). `diag.patch` (on the change) emits again every emission the change keeps, asserts the two
  identical (bytes, inlined count, entry states and flags) and packs the passes per function into the flag counters;
  `passes.py` unpacks them (`passes.txt`). `diag2.patch` counts the regions whose states never settle and whether
  they come back to an earlier state within the four iterations; `cycles.py` (`cycles.txt`).
- `node/`: `bench/ab-mac.sh` on `node`, base against new (12 pairs); `counters.txt` from
  `python3 ../perf69/counters.py node/ab.json`.
- `boots/`: the parallel boots, 3 rounds alternated (`ARMS="base new" PREFIX=p71 gates.sh 3 smp_alpine_jit
  smp_user_jit_4`), then 3 more of `smp_user_jit_4` (`PREFIX=p71b`); `summary.txt`, `summary-b.txt` from
  `python3 ../region64/summary.py boots p71[b] base new`; the Chrome processes' peak RSS in `rss/`.
- `pages/`: Firefox's pages session cut to two pages (`KEEP_TIMELINES=1 PAGES=wiki,mdn bench/gpu/ab-mac.sh <dir> 3
  new=… base=…`), each session's files without the timelines; `pages-summary.txt` from `node bench/gpu/ab-summary.ts`,
  `latency.txt` from `node ../perf67b/latency.ts`.
- `gates/`: `WORKLOADS=user,boot bench/ab-mac.sh`, base against new; `counters.txt` as `node/`'s.
