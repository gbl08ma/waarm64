# The wasm code GC today, and larger batches in a browser (2026-11-03)

`bench/boot/REPORT.md` "The wasm code GC today, and larger batches in a browser". Headless Chromium 153.0.8010.52 on
the dev VM, every session from `target/snapbench/pages.webpcsnap` through `bench/gpu/ab.sh` at core `0cacda0f`.

- `pages-*`, `churn-*`: one session each of the pages session and the churn screen (`PHASES=churn`) with
  `CHROMIUM_JS_FLAGS=--trace-wasm-code-gc DEBUG=pw:browser`: `*-stalls.json` (`bench/gpu/stalls.ts`), `*-counts.json`
  (`bench/boot/results/m8-replay/counts.ts`), `*-codegc.txt.gz` (V8's `[wasm-gc]` lines: each GC's trigger, start and
  count freed, and the modules that died; the per-module "Freeing" and per-isolate lines left out).
- `ab-pages/`, `ab-churn/`: `BATCH_STEPS` 50K (`base`), 200K (`b200k`), 800K (`b800k`), the constant changed in
  `core/src/jit/mod.rs` and nothing else; two rounds alternating. Each session's `results.json`, `stalls.json`,
  `counts.json`, `wall.txt`, `rss.txt`; `summary.txt` is `node bench/gpu/ab-summary.ts` over the sessions with their
  `jit.jsonl.gz` (not kept), so its flush times aren't reproducible from this directory.
