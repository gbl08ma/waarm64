# Relinking a region once its successors are compiled (2026-11-05)

`bench/boot/REPORT.md` "Relinking a region once its successors are compiled".

- `relink.patch`: the mechanism against `6abf0919` (`Config::relink`, `jit_relink`, ABI 61, counter word 121, the
  tests); `count.patch`: the diagnostic core counting `return_call_indirect` by kind (counts in the static counts'
  counter words 8, 9 and 11-19, as `split` in REPORT.md names them).
- `counts-session/`: the counting core's pages session (`jit.jsonl.gz`: the kinds in `inline`, `helpers`,
  `flagsStored`, `flagsElided`, `condDirect`, `condComputed`, `condMemory`, `regionBlocks`, `backEdges`, `tierUps`,
  `stale`: jc static tail, jc by key, xc RET, BR, BLR, by-VA link, xmiss taken, tier-up redirect, direct chain,
  guarded direct chain, xmiss entered).
- `r0-*`, `r256-1`, `r64-1`: the A/B's sessions (`bench/gpu/ab.sh`'s files; `RELINK` 0, 256, 64); `summary.txt`.
- `chain2.mjs`: `bench/boot/results/m8-warm/tools/chain.mjs` with a `typed` arm and `SCATTER` for the import arm.
