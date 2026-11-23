# BENCH loop 3's sessions (bench/boot/REPORT.md "BENCH loop 3")

- `r16-3`: `block::REGION` 16 against 64 on `node`, `user` (its phases alone, as this run timed it) and `boot`.
- `aa-node`: the base alone on `node` and `user` (its phases alone), the defaults.
- `pages-cut/`: four A/A sessions of `PAGES=wiki,mdn bench/gpu/ab-mac.sh` (`node bench/gpu/ab-summary.ts` reads it).
- `replay.txt`: `node bench/boot/results/bench2/replay.ts bench/boot/results/bench3/aa-node bench/boot/results/bench3/r16-3`.
