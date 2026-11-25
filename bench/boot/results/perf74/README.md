# PERF loop 74: entries at every member a region's head page has, and the helper's one decode (2026-11-25)

The data behind `bench/boot/REPORT.md` "PERF loop 74". Hosts: the counts' Node runs and the micro-benchmark on the dev
VM (Node 26.7.0); the rest on the Mac (M4, macOS 26.6.2, Chrome for Testing 158.0.8127.88).

- `diag.patch`: PERF loop 73's counters (`../perf73/diag.patch`, without its TLBI queue slots, which no longer apply)
  on this loop's base (b4e00c00), with `tally::M`'s slots 10-15 (the steps interpreted at a member by what an entry
  there would be, the members where one could be, the entries made, the heads that were such members; `summary.py`
  names them), `WAARM64_ENTRIES_ALL` (at build time: every member where the head's page has it is an entry, the rule
  this loop keeps) and the JIT's counters in `bench/boot/preempt-counts.ts`'s JSON. Built with
  `CARGO_TARGET_DIR=target/diag scripts/build-wasm.sh --features diag`, and again with `WAARM64_ENTRIES_ALL=1
  CARGO_TARGET_DIR=target/diag-all`.
- The counts, one run each: `gates-vm.json` / `gates-vm-all.json` (and their reports: `node
  bench/boot/preempt-counts.ts --wasm … --json … boot user smp-user4`), `pages/diag-1` and `pages/all-1` (one Firefox
  pages session each from `target/snapbench/pages.waarm64snap`, `bench/gpu/ab-mac.sh <dir> 1 diag=… all=…`).
  `summary.py` → `summary.txt`.
- `node/`: `WORKLOADS=node,smp bench/ab-mac.sh`, `base` (b4e00c00) against `new` (every member an entry).
- `pages-ab/`: `bench/gpu/ab-mac.sh <dir> 3 base=… new=…`, three rounds alternated; `summary.txt` and `summary.json`
  from `node bench/gpu/ab-summary.ts`.
- `gates/`: `WORKLOADS=user,boot bench/ab-mac.sh`, `base` against `both` (the entries and the helper's one decode).
- `helper.c`, `run.ts`, `micro/`: the helper's micro-benchmark (8 M `LDSMAX`, an instruction with no inline form,
  each a call of `jit_exec_mmu`; PERF loop 21's runner), `micro/helper.bin` built with `-DADDR=0x40000000UL -DN=1000000
  -march=armv8.1-a` as tests/baremetal/build.sh builds; `micro/r<round>-<arm>.json`: `base` the entries alone, `new`
  with the one decode, alternated, five runs a round.
