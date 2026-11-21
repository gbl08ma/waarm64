# PERF loop 41: the block map's constants (2026-11-21)

The data behind `bench/boot/REPORT.md` "PERF loop 41".

- `diag.patch`: the diagnostic core and page (on 54507cfd; `jit::GAUGE_WORDS` 24, `hostUse().pr` the words 8-23; it
  also carries loop 38's per-vCPU decoded-block counters in `mem.jsonl`'s `cpus`). At each prune: 8 the keys before,
  9-11 the needed, recent and warm ones (classes, in that order), 12-13 prunes that fell to the second and the third
  retain, 19/20/22 the keys dropped cold (`hits` < `KEEP_HITS`), warm and recent; four Bloom filters of 2^24 bits (8
  MiB, two hashes, cleared at each prune) of the keys dropped and of those that came back, so 14/15 the dropped keys
  added again before the next prune (cold/warm when dropped), 17/18 those that then reached the threshold, 16 the keys
  added, 21 those added after a prune, 23 the diagnostic's own ns (taken out of `pruneMsEach`). Its prune collects the
  dropped keys in a `Vec` (up to ~20 MiB), so the diagnostic arms' marks at a prune are high: the marks in the REPORT
  are the clean arms'. Arms (`MAP_KEYS`): `d0` 1.5 M (main), `d1` 900,000, `d2` 450,000, `d3` 900,000 with the
  prune's second retain keeping the needed and the warm keys instead of the needed and the recent ones; `c0` main and
  `c1` main with 900,000 (no diagnostic).
- The sessions (Mac M4, Chrome for Testing 158.0.8127.36, from `target/snapbench/pages.waarm64snap`, cda6cfa7's core,
  `MEMLOG=5 MEMLOG_UASM=0`): Firefox's pages session `bench/gpu/ab-mac.sh <out> 3 d0=… d1=…` (`pages/`), `… 3 d1=…
  d2=… d3=…` (`pages2/`), `… 3 c0=… c1=…` (`clean/`); the run-once churn (`PHASES=churn
  CHURN='rate=300&calls=120&n=2' CHURN_S=600` through `bench/gpu/sway-mac.sh`) d0, d1, d2 once each (`churn/`) and
  c1 c0 c0 c1 (`cchurn/`).
- `memsum.json`: `node sum.ts <mem.jsonl>...` over every session (the mark, the live maximum, when the mark last rose,
  the map's MiB, the prunes and their ms, the counts above).
- `pages-summary.txt`, `pages2-summary.txt`, `clean-summary.txt`: `node bench/gpu/ab-summary.ts` of the three pages
  A/Bs (`pagesS`, busy MIPS, Gsteps interpreted, lock counts).
- `screen.json`: the gate screen (`bench/interp/ab-mac.sh`, `boot_alpine_jit`, `alpine_user_jit`), `base` main and
  `keys` 900,000, base first in rounds 1 and 3.
