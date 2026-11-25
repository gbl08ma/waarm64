# PERF loop 75: probes a region's earlier block made, Liftoff's fill again, and loop 74's review (2026-11-25)

The data behind `bench/boot/REPORT.md` "PERF loop 75". Hosts: the gates' counts in Node on the dev VM (Node 26.7.0);
the pages sessions on the Mac (M4, macOS 26.6.2, Chrome for Testing 158.0.8127.88).

- `diag.patch`: PERF loop 74's diagnostic core (`../perf74/diag.patch`, its `WAARM64_ENTRIES_ALL` hunk dropped: that
  rule is the tree's now) on 3a08fdf3, with this loop's counters at `tally::A` (1152): `block::dom_counts` (each
  region's probes that an earlier probe of the region already made, by a dataflow over its edges, in three variants,
  added at each member's run), the backward transfers that land at an entry (the review's finding 2) and the ways in
  at an entry, and PERF loop 27's model of X registers sharing locals with Liftoff's fill counted at each call
  (`tally::FILL`, an atomic add whose constant is patched once the function's locals are known). `summary.py` names
  the slots. Built with `CARGO_TARGET_DIR=target/diag75 scripts/build-wasm.sh --features diag`.
- `gates-vm.json`, `gates-vm-report.txt`: `node bench/boot/preempt-counts.ts --wasm … --json gates-vm.json boot user
  smp-user4`, one run (the one-vCPU runs are deterministic).
- `pages/diag-1`: one Firefox pages session from `target/snapbench/pages.waarm64snap` (`bench/gpu/ab-mac.sh <dir> 1
  diag=<core>@../waarm64-base`: the page's code from the side checkout carrying the patch); `pages/first-1` the same
  with the core before the backward-entry counters (slots 20-23), the rest the same counters.
- `summary.py` → `summary.txt`.
