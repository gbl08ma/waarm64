# PERF loop 70: XZR's writes through a sink slot, and one TLB probe for a pair (2026-11-24)

bench/interp/REPORT.md "PERF loop 70". M4 Mac mini, macOS 26.6.2, Chrome for Testing 158.0.8127.88; base `a7f20d86`.

- `diag.patch`: the counting core (not for commit; native, `--features diag`): `interp::block::diag` counts each
  kind's dispatches in `hot` and those with XZR as the destination, and the LdO/StO pairs by kind, base, size,
  offsets and page; printed at the end of `alpine_boots_through_the_block_interpreter`. `alpine-native-diag.txt`:
  its output (kind=dispatches/with d 31, then the pair counters in the order the patch's `P` comment gives).
- `sink.patch` (kept, as committed), `pair.patch` (dropped): the arms against `a7f20d86`.
- `p70s<round>-r1-<arm>-<bench>.json`: the block-interpreter guests, base, sink and pair, three rounds, the order
  rotated (`screen.sh.txt`); `sum.py.txt` prints the medians (`screen-summary.txt`; run from the repo root with the
  files under `bench/results/local/mac/`).
- `../../../boot/results/perf70/`: `node-smp/` and `gates/` (`bench/ab-mac.sh`'s ab.json, verdict.txt, log.txt),
  `pages/` and `pages-summary.txt` (`bench/gpu/ab-mac.sh` with `PAGES=wiki,mdn`, 3 sessions an arm).
