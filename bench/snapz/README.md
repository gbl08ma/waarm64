# bench/snapz: the snapshot codecs and their wiring, measured

Dev-only tools behind `bench/boot/REPORT.md` "SNAPZ: compression across the emulator, measured". Nothing here ships.

- `src/lib.rs`, `Cargo.toml`: every candidate codec behind one C ABI in a wasm module of its own (non-shared memory):
  the core's LZ (`core/src/lz.rs`, included by path), lz4_flex, snap, miniz_oxide (levels 1, 2, 3, 6), ruzstd, and C
  zstd (`--features czstd`; needs clang with the wasm32 target), plus crc32fast. Its own workspace; build it as
  `RUSTFLAGS="-C target-feature=+bulk-memory,+mutable-globals" cargo build --release --target wasm32-unknown-unknown
  --target-dir target/<plain|safe|czstd> [--features safe|czstd]` from this directory (all three for `run.ts`).
- `corpus.ts <file.waarm64snap> <out.bin>`: a snapshot's frames unpacked (u8 tag, u32 length, bytes).
- `run.ts <corpus.bin> <plan.json> <out.json>`: headless Chromium (`PROFILE=<dir>`: a persistent profile, which OPFS
  numbers need; Playwright's default context is off the record), a coordinator worker (`www/coord.js`, the machine
  worker's stand-in) and pool workers (`www/pool.js`) reading the corpus from a SharedArrayBuffer. Plans in `plans/`;
  job types `single`, `pool`, `restore`, `crc`, `opfs`, `clusters`, `writable`. Pipe through `fmt.py` for pools.
- `compat.mjs <corpus.bin>`: the core's LZ and lz4_flex read each other's output.
- `phases.patch` (`git apply`; never commit it applied) times the page's save and load by phase; `probe-save.ts
  <file.waarm64snap>` loads the desktop snapshot on the page and saves it twice, printing the phases (run with
  `WAARM64_PROFILE=<dir>` and `WAARM64_DOWNLOADS=<dir>`, both under `target/`). Its timers print through the page's
  console: add `|| t.startsWith('TIMING')` to bench/gpu/guest-session.ts's console filter for the load's.
- The corpus: `bash bench/gpu/warm-snapshots.sh firefox`, then `corpus.ts target/snapbench/pages.waarm64snap
  target/snapbench/corpus-pages.bin` (1.68 GB).
