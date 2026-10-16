# The compile worker's modules, posted (2026-10-16)

`bench/boot/REPORT.md` "M8: the compile worker's modules, posted".

- `install-split.txt`: every install of one Firefox pages session timed (a `web/vm.ts` instrumented with the split,
  not kept; that session's `results.json` is `install-split.json.gz`, its `slow` lines one an install: `node install-split.mjs <results.json>`), by functions in the module.
- `sessions/`: each pages session's `results.json` (`d0`: before, the same build with the table always passing 0;
  `d`: posted) and `stalls.txt` (`bench/gpu/stalls.ts`). `d-2` hung on Firefox's first page (not counted).
- `gates/`: `bench/run.ts` JSON, three alternating rounds.
