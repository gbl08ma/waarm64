# PERF loop 72: one counting pass for queue rows 8, 9, 10, 11, 13 and 18 (2026-11-24)

The data behind `bench/boot/REPORT.md` "PERF loop 72". Nothing here was built into the tree: the counters are
`diag.patch`, on the loop's commit (ABI 74), built with `CARGO_TARGET_DIR=target/diag scripts/build-wasm.sh --features
diag` (and again with `WAARM64_FOLLOW_ALL=1 CARGO_TARGET_DIR=target/diag-all` for the followed calls).

- `diag.patch`: `core/src/tally.rs`'s tables grown from 80 to 1,280 words. Past the tree's: 80-95 the dispatcher's
  block calls by what came before (PERF loop 54's), 96-127 compiled code's (the transfer cache's hits and misses by
  RET, BLR, BR and by-VA link; why the miss function was entered and whether it found the block; stops and their
  depth; host frames left unreturned; the jump cache's failed probes), 128-191 the TLB's (`Tlb::dg`: misses by array,
  the page in a sibling array, the slot's state, neighbours, walks by level, fills and evictions, flushes), 192-223
  parallel SMP's TLBI queues, 224-239 the jump cache's fills and the interpreted steps at region members, 240-247
  emission (regions, those never settled, `bad` fallbacks), 256 on the helper calls by `Op` (`ops.json` names the
  slots). Slots 14 and 15 are PERF loop 50's (a followed call run, a predicted return taken). The web/ part sums the
  words into `__status.stats.jit.diag`, so a session's `jit.jsonl` carries them. `report.py` labels every slot.
- `gates-vm.json`, `gates-vm-report.txt`: `node bench/boot/preempt-counts.ts --json … boot user smp-user4` with the
  diagnostic core (Node 26.7.0, the dev VM; Alpine's boot, its userspace benchmark by phase, `smp_user_jit_4`'s guest
  on 4 vCPUs in parallel mode). `gates-vm-follow-all.json` (and its report): the same with every callee followed.
- `pages/`: one Firefox pages session on the Mac (M4, macOS 26.6.2, Chrome for Testing 158.0.8127.88) from
  `target/snapbench/pages.waarm64snap`: `bench/gpu/ab-mac.sh <dir> 1 diag=target/diag/…/waarm64_core.wasm`, with the
  patch's web/ part in the tree. `jit-last.json` is the last line of `jit.jsonl.gz` (the session's totals),
  `report.txt` its labelled slots.
- `summary.py` → `summary.txt`: the tables of the REPORT entry (transfers per 1000 steps by workload and phase, the
  transfer cache, the TLB, the queues, the followed calls).
