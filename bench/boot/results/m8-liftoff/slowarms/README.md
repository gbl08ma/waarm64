# Smaller slow arms of loads and stores (2026-10-20)

The data behind `bench/boot/REPORT.md` "M8: smaller slow arms of loads and stores". The dev VM, Chromium
153.0.8010.52, Node 26.7.0. `base` is main at fbd9b02; `chainf` the failure chain with the shared flag store
(docs/jit.md "Loads and stores"), swapped in as the core (`target/wasm32-unknown-unknown/release/webpc_core.wasm`).

- `pages/`: Firefox's pages session (`tools/pages.sh <core> <name>`: `PHASES=pages TIMELINE_ALL=1 JITLOG=1`, the
  Arch Linux ARM disk, 4 vCPUs, 2.5 GiB, with `bench/boot/results/m8-replay/r2/rss.sh` beside it), in the order
  base-0, chainf-1, base-1, chainf-2, base-2. Per session `results.json` (firefox-load.ts's), `stalls.txt`
  (`bench/gpu/stalls.ts` of the timeline, which isn't kept), `rss.txt` (the renderer's RSS and executable anonymous
  mappings, MiB, every 5 s), `jit.jsonl.gz` (the JIT's counters once a second). `summary.txt`: `tools/psum.sh`.
- `gates/`: `smp_alpine_jit` and `smp_user_jit_4` (`tools/gates.sh`), base and chainf alternating, three rounds;
  `summary.txt`: `tools/gsum.py` (the medians of each round, the wasm bytes, the change of the median of the
  rounds' medians).
- `tools/capture.ts <core> <dir>`: Alpine's boot under the JIT in Node (deterministic), every JIT module's bytes
  to `<dir>`; `tools/codesize.ts <dir> 8 liftoff|turbofan`: every 8th module compiled eagerly in one tier with
  `--print-wasm-code`, V8's instruction bytes summed; `tools/locals.py <dir>`: the functions' declared locals.
  They were run from `bench/results/local/liftoff/tools/`; the shell scripts expect that directory too.
