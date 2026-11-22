# PERF loop 54: the dispatcher's entries and the signature check, counted on the Mac (2026-11-22)

The data behind `bench/boot/REPORT.md` "PERF loop 54". Core: 4fe2f1b3 (loop 53's tree). M4, macOS, Chrome for Testing
158.0.8127.36; Firefox's pages session from `target/snapbench/pages.waarm64snap` (`bench/gpu/ab-mac.sh`, one session
each).

- `counts/`: the session with a diagnostic core, `dispatch-counts.patch` applied to 4fe2f1b3 and built with
  `CARGO_TARGET_DIR=target/diag scripts/build-wasm.sh --features diag` (the tallies of `core/src/tally.rs` grown to 96
  words: 80-95 count the dispatcher's block calls by what came before them, and how chunks ended; the patch's web/
  part sums the tallies into `__status.stats.jit.diag`, so `jit.jsonl.gz`'s lines carry them). The slots are in the
  patch's comments; the REPORT entry has the totals.
- `prof/`: the session with the normal core under V8's `--prof` (`CHROMIUM_JS_FLAGS=--prof CHROMIUM_ARGS=--no-sandbox`);
  `attr.txt` is `prof-attr.mjs.txt`'s output over the vCPU isolates' logs (`--top 25 --windows 20`; the logs, 138 MB,
  not kept). `prof-attr.mjs.txt` is `../m9-macprof/tools/prof-attr.mjs.txt` with the crate's new name
  (`waarm64_core`) in its patterns; rename it to `.mjs` to run it.
- `chain2-mac.txt`: `../m9-relink/chain2.mjs` in the Mac's Node: a funcref table against a table typed by a final
  function type (V8 needn't check the signature), and imported and direct tail calls, at 1,000 and 131,072 functions.
