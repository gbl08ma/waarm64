# PERF loop 13: the JIT's wasm size cuts (2026-11-10)

`bench/boot/REPORT.md` "PERF loop 13: the JIT's wasm size cuts".

- `arms.patch`: every arm against `272f7f13`, behind A/B switches (`PEEPHOLES` in `wasm.rs`; `IDIOMS`, `NZCV_HOT`,
  `ONE_COUNTER` in `emit.rs`; `NZCV_CALLS`, `MISS_FALLBACK`, `MISS_UNCOMPILED` in `block.rs`); `arm.sh` sets them and
  builds a core (its `SUM` there is still 129, which FP16's `HOK` also takes: fixed to 138 before the second session).
- `sizes.txt`: each arm's wasm compiled over Alpine's boot and userspace benchmark in Node (`bench/boot/userprof.ts`,
  deterministic: the same steps in every arm).
- `gates/`: `bench/interp/ab-mac.sh` sessions on the Mac (`perf13-*`: base, S, Shot, Sunc, Scnt; `perf13b-*`: base, S,
  Scnt with `SUM` at 138), 3 rounds each; `table.py <prefix> <arms...>` prints them.
- `pages/`: Firefox's pages session from `pages.webpcsnap` on the Mac (`pages.sh`), base, S, Scnt, 3 rounds
  alternated: `results.json`, `stalls.json` (busy MIPS), the JIT's log; `summary.txt`.
