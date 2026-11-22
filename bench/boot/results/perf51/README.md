# PERF loop 51: a looped region's call continuations, counted (2026-11-22)

The data behind `bench/boot/REPORT.md` "PERF loop 51".

- `diag.patch` (on d3964b59): the diagnostic counts. `Region::conts` is `entries` without its `looped` early return;
  `Cache::install` files, under the `diag` feature, the members of a looped region from its first call continuation
  on (kind 1: a continuation, the member `entries` would give if the region weren't looped; kind 2: a later member)
  and the entries `Cache::entry` declined (kind 3, PERF loop 48's rule). `Jit::miss` adds each key's reported
  dispatches (`n`, what its decoded block counted since its last report: exact, whether the dispatcher or a chain in
  the block interpreter ran it) and `n` × its length to the table's `dg` words, with all reported dispatches
  besides. The run loops publish them at tally words 80-87 (`N` 88) and, for the page's JIT log, over the counters
  `flagsElided`, `condDirect`, `condComputed`, `condMemory` (kinds 1 and 2: dispatches, steps). Built with
  `CARGO_TARGET_DIR=target/diag scripts/build-wasm.sh --features diag`.
- `diag.txt`/`.json`: `node bench/boot/preempt-counts.ts --json … boot user` (deterministic, Node, the dev VM);
  `diag-smp.txt`/`.json`: `… smp1 smp4 smp-user4` (parallel realtime). Rows "interp. …" are the new words.
- `ff/`: one Firefox pages session on the Mac with the diagnostic core (`bench/gpu/ab-mac.sh … 1
  diag=<diag core>`, the snapshot `target/snapbench/pages.waarm64snap`): `jit.jsonl.gz` (the JIT log; the four
  counters above are the kinds 1-2 words there), `results.json`, `wall.txt`.
