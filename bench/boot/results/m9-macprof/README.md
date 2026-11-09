# Profiles on the Mac host, and the compile threshold there (2026-11-09)

bench/boot/REPORT.md "Where a busy vCPU's time goes on the Mac, and the compile threshold there". The M4 Mac mini
(macOS 26.6.2), Chrome for Testing 157.0.8103.38, through `bench/gpu/sway-mac.sh`.

- `pages/`: Firefox's pages session from `pages.webpcsnap` under V8's `--prof` (`SCRIPT=firefox-load.ts`,
  `CHROMIUM_JS_FLAGS=--prof`, `CHROMIUM_ARGS=--no-sandbox`). `attr.txt` is `tools/prof-attr.mjs.txt`'s output
  (`--top 30 --windows 20 --guest 20` over the isolates' logs, which stay out of the repo: ~160 MB each);
  `results.json` the session's, `jit.jsonl.gz` the JIT's counters over time.
- `godot-6144/`, `godot-4608/`: Godot's GI demo in the editor on Venus (`bench/vulkan/godot.ts`, `gi-editor`) with
  6144 MiB of RAM (the default: spill memory 2 in use) and 4608 MiB (none), under `--prof`; `godot-gi-editor.log` is
  Godot's own log.
- `thr/`: the threshold A/B (`tools/thr-run.sh`): arms `t1000` (floor 1000, max 2000), `t500`, `t250`, three rounds.
  `pages-<arm>-r<n>.json` and `.jit.jsonl.gz` per pages session, `thr-r<n>-<arm>-<bench>.json` from
  `bench/run-mac.sh`, `run.log` the medians as they ran.
- `tools/`: `prof-attr.mjs.txt` (rename to `.mjs`; `node prof-attr.mjs [--windows S] [--top N] [--guest N]
  isolate-*.log`; cap its memory, a log takes ~4 GB), `thr-run.sh`.
