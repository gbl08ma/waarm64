# PERF loop 48: the review of the block map's bounds and RAM's layout, fixed (2026-11-22)

The data behind `bench/boot/REPORT.md` "PERF loop 48". Arms: `base` 2e202705 (loop 47), `fix` the loop's commit; Mac
M4, Chrome for Testing (bench/mac-chrome.sh's current Stable).

- `perf48-<n>-r1-<arm>-<bench>.json`: the gate screen, `bench/interp/ab-mac.sh perf48-<n> 1 <arms> -- boot_alpine_jit
  alpine_user_jit`, three calls, base first in calls 1 and 3.
- `pages-<arm>-1-mem.jsonl.gz`, `pages-summary.txt`: Firefox's pages session once an arm from
  `target/snapbench/pages.waarm64snap` (`MEMLOG=5 MEMLOG_UASM=0 bench/gpu/ab-mac.sh <out> 1 base=… fix=…`), its
  memory log every 5 s (`jit.decBytes`: the decoded blocks' arenas and maps, all tables) and `node bench/gpu/ab-summary.ts`.
