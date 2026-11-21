# PERF loop 39: the block map's page index (2026-11-21)

The data behind `bench/boot/REPORT.md` "PERF loop 39".

- `diag.patch`: the diagnostic core and page (on 3cfc1834): `jit::GAUGE_WORDS` 16, words 8-15 the page index's parts
  (pages with own keys, their table's bytes, the lists' bytes, the keys in them, pages with 1 key, with 2-4, pages with
  region heads, the heads' bytes), recounted every 4,096 keys added and after a prune; `hostUse().pi` in the page.
- `pages/`: Firefox's pages session from `target/snapbench/pages.waarm64snap` (cda6cfa7's core) on the Mac (M4, Chrome
  for Testing 158.0.8127.36), `MEMLOG=5 MEMLOG_UASM=0 bench/gpu/ab-mac.sh <out> 1 d=<diag core>`: `mem.jsonl.gz`
  (every 5 s), `results.json`, `wall.txt`.
- `churn/`: the run-once churn from the same snapshot, `PHASES=churn CHURN='rate=300&calls=120&n=2' CHURN_S=600
  MEMLOG=5 MEMLOG_UASM=0 JITLOG=1 bench/gpu/sway-mac.sh virgl target/archarm/desktop.qcow2 <tag>` with
  `WASM=<diag core>`: `mem.jsonl.gz`, `results.json`.
- `indexsum.json`: `node indexsum.ts pages/mem.jsonl.gz churn/mem.jsonl.gz` (the index's parts at the heap's live
  maximum and at the sample where its mark last rose, and the one before).
