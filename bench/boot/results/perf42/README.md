# PERF loop 42: lazy NZCV at a loop's head, bounded (2026-11-21)

The data behind `bench/boot/REPORT.md` "PERF loop 42".

- `diag.patch` (on baf10886, not for merging): `results/flagx/experiment.patch` (it applied unchanged after loops 36
  and 37) plus four tallies of the branch outcome's shape past the parallel tables (`tally::N` 72, slots 64-67: an
  edge taken from a member ending in a conditional branch whose outcome the exits read from `TAKEN`, a lazy B.cond's
  or another's, on a back-edge or on a forward edge in a looped region), `bench/boot/preempt-counts.ts` printing slots
  14, 15 and 64-67, and `web/vm.ts` putting the tallies in `stats().jit.diag` (so JITLOG's `jit.jsonl` carries them).
- `counts.json`: per 1000 guest steps. The gates' guests from `node bench/boot/preempt-counts.ts boot user` (Node on
  the dev VM, the diagnostic core); Firefox's pages session from one `bench/gpu/ab-mac.sh <out> 1 d=<diag core>` on
  the Mac (M4, Chrome for Testing 158.0.8127.36, `target/snapbench/pages.waarm64snap`), its `jit.jsonl` first record
  to last (97.9 G steps over 4 vCPUs).
- `screen.json`: the gate screen of the bound (`bench/interp/ab-mac.sh`, `boot_alpine_jit` and `alpine_user_jit`, one
  round a call, base first in rounds 1 and 3): `base` baf10886, `flagx` the patch's `--features flagx` (unsound:
  such heads' flags dead); `compile`: round 1's wasm bytes, `compileNs`, `emitNs`.
- `pages-summary.txt`: `node bench/gpu/ab-summary.ts` of the pages session's A/B of the same two cores (3 rounds, the
  first arm alternating).
