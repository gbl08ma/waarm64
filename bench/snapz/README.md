# bench/snapz: the snapshot codecs and their wiring, measured

Dev-only tools behind `bench/boot/REPORT.md` "SNAPZ: compression across the emulator, measured". Nothing here ships.

- `src/lib.rs`, `Cargo.toml`: every candidate codec behind one C ABI in a wasm module of its own (non-shared memory):
  the core's LZ as it was until SNAPZ loop 1 (`src/lz.rs`, a copy of the removed `core/src/lz.rs`), lz4_flex, snap, miniz_oxide (levels 1, 2, 3, 6), ruzstd, and C
  zstd (`--features czstd`; needs clang with the wasm32 target), plus crc32fast. Its own workspace; build it as
  `RUSTFLAGS="-C target-feature=+bulk-memory,+mutable-globals" cargo build --release --target wasm32-unknown-unknown
  --target-dir target/<plain|safe|czstd> [--features safe|czstd]` from this directory (all three for `run.ts`).
- `corpus.ts <file.waarm64snap> <out.bin>`: a snapshot's frames unpacked (u8 tag, u32 length, bytes).
- `run.ts <corpus.bin> <plan.json> <out.json>`: headless Chromium (`PROFILE=<dir>`: a persistent profile, which OPFS
  numbers need; Playwright's default context is off the record), a coordinator worker (`www/coord.js`, the machine
  worker's stand-in) and pool workers (`www/pool.js`) reading the corpus from a SharedArrayBuffer. Plans in `plans/`;
  job types `single`, `pool`, `restore`, `crc`, `opfs`, `clusters`, `writable`. Pipe through `fmt.py` for pools.
- `compat.mjs <corpus.bin>`: the old core LZ and lz4_flex read each other's output. It and `run.ts`'s old-LZ arm are
  why `src/lz.rs` stays: the page reads no file of the old LZ's any more (older files are refused by their state
  version, SNAPZ loop 2b), but the format is the same, so both still run as the REPORT ran them.
- `memwatch.ts <profile> <out.jsonl> [<stop-file>]` (SNAPZ loop 2b): the browser's memory by process every 50 ms,
  beside a probe run (docs/benchmarking.md "The snapshot probe").
- `probe.ts <desktop|debian> [out.json]` (SNAPZ loop 0 on): a warm snapshot loaded on the page and saved as a kept
  snapshot (started from, since loop 3), to a file and as a suspend, then resumed, with the page's own phases and the browser's memory per round
  (docs/benchmarking.md "The snapshot probe"); `WAARM64_PROFILE=off` off the record, `OPS` a round's operations
  (SNAPZ loop 5). It replaced the measuring session's `phases.patch` (the timing points,
  now the page's own) and `probe-save.ts` (git history has both).
- `readback.ts [out.json]` (PERF loop 85): the warm desktop's 3D read-back alone (its resources loaded into a
  VirglRenderer on a WebGL2 canvas in the page, `save()` timed); `readback-mac.sh` runs arms of it on the Mac's GPU,
  `probe-mac.sh` arms of `probe.ts` (docs/benchmarking.md "The snapshot probe").
- The corpus: `bash bench/gpu/warm-snapshots.sh firefox`, then `corpus.ts target/snapbench/pages.waarm64snap
  target/snapbench/corpus-pages.bin` (1.68 GB).
