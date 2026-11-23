# PERF loop 59: what a module's install grows outside the heap's bound, counted (2026-11-23)

The data behind `bench/boot/REPORT.md` "PERF loop 59".

- `diag.patch`: the diagnostic core and page (on 96ca41ae; `jit::GAUGE_WORDS` 32, `hostUse().pr` the words 8-31, so
  `mem.jsonl` carries them). Per `Cache::install` it adds up the allocations its filing makes: the links' table
  (`linkers`: a growth is its capacity past the most it has held, counted as its new table's bytes, buckets of 25
  bytes on wasm32) and their lists, the page index's region heads (table and lists), the tiers' table (filed after the
  install, by `emit_batch` and `tier_up`: 33-byte buckets) and the module log (32 bytes an entry); the installs made
  from `tier_up` (inside JIT code) apart; the largest install's sum and the largest one allocation. `sum.ts` reads a
  session's `mem.jsonl` (`counts.json` is its output for both sessions); `counts.ts` runs a gate guest in Node with
  that core.
- `pages-mem.jsonl.gz`: Firefox's pages session once, Mac M4, Chrome for Testing 158.0.8127.36, from
  `target/snapbench/pages.waarm64snap` (`MEMLOG=5 MEMLOG_UASM=0 bench/gpu/ab-mac.sh <out> 1 diag=…`).
- `churn-mem.jsonl.gz`: the run-once churn once (`PHASES=churn CHURN='rate=300&calls=120&n=2' CHURN_S=600` through
  `bench/gpu/sway-mac.sh`, from the same snapshot, as `bench/results/local/perf43/churn.sh`).
