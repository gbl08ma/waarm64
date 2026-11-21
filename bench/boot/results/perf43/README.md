# PERF loop 43: the review of the block map and the heap's bounds (2026-11-21)

The data behind `bench/boot/REPORT.md` "PERF loop 43". Arms: `base` 84ed7551 (run from a side checkout, ABI 71),
`fix` the loop's commit. Mac M4, Chrome for Testing 158.0.8127.36, from `target/snapbench/pages.waarm64snap`,
`MEMLOG=5 MEMLOG_UASM=0`.

- `pages-summary.txt`: `node bench/gpu/ab-summary.ts` of Firefox's pages session, `bench/gpu/ab-mac.sh <out> 3
  base=…@../waarm64-base fix=…`.
- `pages-mem.json`, `churn-mem.json`: `node sum.ts <mem.jsonl>...` (loop 41's tool) over the pages sessions and the
  run-once churn (`PHASES=churn CHURN='rate=300&calls=120&n=2' CHURN_S=600` through `bench/gpu/sway-mac.sh`, fix base
  base fix).
- `screen.json`: the gate screen (`bench/run-mac.sh --page bench/boot/index.html --only boot_alpine_jit|alpine_user_jit`,
  3 rounds, base first in rounds 1 and 3).
