# M8: a machine's JIT budget and the page's memory signal (2026-10-20)

`bench/boot/REPORT.md` "M8: a machine's JIT budget and the page's memory signal". Headless Chromium 153.0.8010.52 on
the dev VM; every session from `target/snapbench/pages.webpcsnap` (the desktop guest: 2.5 GiB of RAM, 4 vCPUs) through
`bench/gpu/ab.sh` with `MEMLOG=10`.

- `signal/uasm-j160/`: the churn page at a 160 MiB budget, with `measureUserAgentSpecificMemory` every sample
  (`mem.jsonl`: `uasm.byRealm`, `smaps`, `memory`: the page's `Vm.hostUse`).
- `signal/calib/`: the fixed-320 MiB sessions' `mem.jsonl` (from `timed/`), and `signal/calibration.json`:
  `node bench/mem/calibrate.ts --json` over them.
- `screen/`: the adaptive budget's churn screens (`scr1`: `hot=1500`, 160 / adaptive / 320 / 320 A/A; `scr2`: no hot
  set; `scr3`: the planted bug, no marking; `scr4`, `scr5`: without the link closure). Arms by query on one core
  (`?jitmb=`, `?jitstart=`). `screen-summary.json`: `node bench/gpu/ab-summary.ts --json screen`.
- `timed/`: the full pages session (`pages*`: `ad` the first adaptive core, `noclear` without the probe's cache
  clearing, `ad2` with the tier-up's room at the cap, `base` the same tree with a fixed budget and no marking) and the
  churn pairs (`churn*`, `ad2` against `base`). `timed-summary.json` the same way.
- `gates/`: `smp_alpine_jit`, `smp_user_jit_4`, three rounds alternating (`tools/tpw.sh base ad -- 1 2 3`;
  `summary.txt` from `tools/gates.mjs`).
- `adaptive.patch`: the adaptive budget's JIT (`core/src/jit/mod.rs` as last measured, `ad2`) against the JIT of commit
  4bec4e3; `VmConfig.jit_start` (an appended u64, 0: the core's start) and the page's `?jitstart=MiB` chose its start.

Each session directory: `results.json` (firefox-load), `mem.jsonl`, `rss.txt` (the renderer's RSS and V8's wasm code
every 5 s), `counts.json`, `stalls.json`, `wall.txt`, `jit.jsonl.gz` (the JIT's counters once a second).
