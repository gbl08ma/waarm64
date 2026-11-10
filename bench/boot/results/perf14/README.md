# PERF loop 14: the shared cache's leftovers (2026-11-10)

`bench/boot/REPORT.md` "PERF loop 14: the shared cache's leftovers".

- `arms.patch`: the diagnostic arms against `367757a9`, as build-time switches: `WEBPC_LONE` (L: the one table's jump
  cache and hot words as constants in the modules), `WEBPC_FAST` (F: a catch-up with nothing to take returns at once,
  counted in `pruneNs`), `WEBPC_ALLOCS` (allocator calls: all in `prunes`, under the cache's lock in `rescues`, in
  `block::module` in `lagFlushes`; this part overwrites those words in any build, diagnostic only).
- `gates/`: the Mac session (`perf14-r<round>-<arm>-<bench>.json`, arms base, L, F, LF); `python3 gates/table.py perf14
  base L F LF` prints the table.
- `node/`: `bench/boot/userprof.ts` marks for base, LF (no-op catch-ups) and the allocation-count core.
- `churn/`: the churn screen (`bench/gpu/ab.sh`, one session of base from `pages.webpcsnap`): results, stalls, counts.
