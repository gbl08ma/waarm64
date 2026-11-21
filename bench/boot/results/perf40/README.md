# PERF loop 40: the block map's table kept across a prune (2026-11-21)

The data behind `bench/boot/REPORT.md` "PERF loop 40".

- `diag.patch`: the diagnostic gauges (on 87a8dd52, `jit::GAUGE_WORDS` 16, `hostUse().mr` in the page): words 8-9 the
  block map's reserves that found no room and rehashed in place (count, ns), 10 its table's full capacity, 11 its
  `capacity()` now (10 − 11: the tombstones), 12-13 the reserves that resized it (count, ns). `d0` is main with it,
  `d1` main with it and the prune's `shrink_to(0)` removed, `d2` the kept change (the table kept, its tombstones
  rehashed in place in the prune) with it.
- The sessions (Mac M4, Chrome for Testing 158.0.8127.36, from `target/snapbench/pages.waarm64snap`, cda6cfa7's
  core, `MEMLOG=5 MEMLOG_UASM=0`): Firefox's pages session, `bench/gpu/ab-mac.sh <out> 2 d0=… d1=…` then `… 2 d2=…
  d0=…`; the run-once churn, `SCRIPT=firefox-load.ts PHASES=churn CHURN='rate=300&calls=120&n=2' CHURN_S=600
  MAC_TIMEOUT=900 bench/gpu/sway-mac.sh virgl target/archarm/desktop.qcow2 <tag>` with `WASM=<arm>`, in the order
  d0 d1 d1 d0 d2 d0 d2 (the session's index after the arm).
- `memsum.json`: `node sum.ts <mem.jsonl>...` over every session (the mark, the live maximum, when the mark last
  rose and the map's MiB then and the sample before, the prunes and their ms each, the gauges above).
- `pages-summary.txt`, `pages2-summary.txt`: `node bench/gpu/ab-summary.ts` of the two pages A/Bs (`pagesS`,
  busy MIPS, lock counts).
- `screen.json`: the gate screen (`bench/interp/ab-mac.sh`, `alpine_jit`, `alpine_user_jit`), base 87a8dd52 and
  the change, base first in rounds 1 and 3.
