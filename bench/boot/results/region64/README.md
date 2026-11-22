# Regions of 64 blocks (2026-11-22)

The data behind `bench/boot/REPORT.md` "Regions of 64 blocks". Base 1eb3f774; every core built from it with only
`block::REGION` (and, for `rm64`, the mitigations) changed. M4, macOS, Chrome for Testing (the version is in each JSON).

- `counts/`: diagnostic cores (`--features diag`, tallies past `tally::N`'s 80 words), in the dev VM's Node, on
  `boot_alpine_jit`'s and `alpine_user_jit`'s guests (deterministic, 1 vCPU):
  - `capstat.*`: every compiled block's entry by length, and for a block the cap ended, its straight-line length
    without the cap (`capstat.ts`, `capstat.patch` on d536f9e5).
  - `exitstat.*`: transfers inside regions and static exits out of them by why the successor isn't a member, at
    REGION 16 and 32 (`exitstat.ts`, `exitstat.patch`; `exitstat-r16.json`, `exitstat-r32.json`).
  - `walkstat.*`: `block::forward`'s walks per region, with the bound at 4 and unbounded (99), REGION 64 with the
    mitigations (`walkstat.ts`, `walkstat.patch`; `walkstat-w4.json`, `walkstat-w99.json`).
- `mac/`: the Alpine gates on the Mac (`gates2.sh`: `bench/run-mac.sh` per run, the arms alternated, the first
  rotated each round, 3 rounds), with the peak summed RSS of Chrome for Testing's processes sampled every second on
  the Mac (`mac/rss/<name>.txt`, KiB). `rg-r16-*`/`rg-r32-*`: REGION 16 against 32; `rh-r32-*`/`rh-r64-*`: 32 against
  64; `rm-r64-*`/`rm-rm64-*`: 64 against 64 with the mitigations (`mitigations.patch`, as first written: the measured
  core had `WALKS = 8` and the test with `WALKS + 1` calls). `python3 summary.py mac <prefix> <a> <b>` prints each
  result's per-round medians as ranges, the change and whether they overlap.
- `pages/`: Firefox's pages session from `target/snapbench/pages.waarm64snap`, REGION 16 against 64 (`pages-ab.sh`:
  `bench/gpu/ab-mac.sh` one arm a call, 3 rounds, the arms alternated, RSS sampled as above: `pages/rss-*.txt`).
  `node bench/gpu/ab-summary.ts bench/boot/results/region64/pages` sums them up.
