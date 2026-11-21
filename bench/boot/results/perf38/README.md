# PERF loop 38: the decoded blocks' budget (2026-11-21)

The data behind `bench/boot/REPORT.md` "PERF loop 38".

- `pages/<arm>-<round>/`: Firefox's pages session from `target/snapbench/pages.waarm64snap` (made by cda6cfa7's core,
  `bench/gpu/warm-snapshots.sh firefox`) on the Mac host (M4, Chrome for Testing 158.0.8127.36),
  `MEMLOG=5 MEMLOG_UASM=0 bench/gpu/ab-mac.sh`, three rounds (round 1 `d1` first, round 2 `d2`, round 3 `d1`), nothing
  else on the dev VM or the Mac. `d1` is cda6cfa7 with `diag.patch` (`BUDGET` 16M micro-ops: 4M a table on 4 vCPUs),
  `d2` the same with `BUDGET` 1 << 25 (8M a table). Each session's `mem.jsonl` (every 5 s the page's accounting, the
  JIT counters and, from the patch, each vCPU's decoded-block counters; no smaps on macOS), `results.json`,
  `counts.json`, `stalls.json`, `jit.jsonl.gz`, `wall.txt`; the page screenshots dropped. `pages.log` the harness's
  lines (rounds 2-3 ran as a second `ab-mac.sh` call, renamed here).
- `diag.patch`: the diagnostic: a table's clear for its keys (not its arena) counted as a rescue, and each vCPU's
  `decBytes`, `decClears`, `decoded`, `decSteps`, `rescues` in the page's status and `mem.jsonl`.
- `pages-summary.json`: `node bench/gpu/ab-summary.ts --json pages`.
- `heapsum.json`: `node bench/boot/results/m8-heap/long/tools/heapsum.ts pages` (the heap at its live maximum).
- `decsum.json`: `node decsum.ts pages` (per session and per vCPU: the decoded blocks' MiB at most, clears, those by
  the keys, blocks decoded).
