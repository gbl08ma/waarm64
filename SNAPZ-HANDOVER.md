# SNAPZ: faster snapshots — handover

The brief, its decisions and its loops: [SNAPZ-KICKOFF.md](SNAPZ-KICKOFF.md). The measurements behind it:
`bench/boot/REPORT.md` "SNAPZ: compression across the emulator, measured"; each loop's numbers: its "SNAPZ loop N"
entry there. How the track is worked: the kickoff's "How the track runs" (a supervisor, one general-purpose subagent
at a time, one loop each, in the main checkout).

## State (2026-11-15)

Loops 0-2b done. The page times its saves and loads by phase (`data-snapshot`, `data-load`; docs/frontend.md
"Snapshots"), `bench/snapz/probe.ts` measures them and `bench/snapz/memwatch.ts` the browser's memory by process
beside it (docs/benchmarking.md "The snapshot probe"). Codec 2 is lz4_flex in the core (`core/src/codec.rs`), the
frames' CRC the core's crc32fast; the writer and the reader are always given that codec (the JS CRC is the header's
only). A restore reads its own state version only (ABI 69: `snapshot_version_min` gone): older files are refused by
their header before their frames are read (`otherVersion`; docs/platform.md "The snapshot file", Refusals). A save's
RAM frames go through a pool of `min(hardwareConcurrency − 1, 6)` workers started with the save (`web/snapshot-pool.ts`,
`web/snapshot-pool-worker.ts`; docs/platform.md "A save's pool"), their buffers recycled to the workers after the sink
wrote them; the download's chunk buffers come back from the page (`snapshot-spare`). The load is on the machine
worker (`web/lz.ts`'s one instance). Now (REPORT "SNAPZ loop 2b", `bench/boot/results/snapz-2b/`, persistent profile
`target/snapz/profile`, a fresh browser per round):
- desktop (`target/snapbench/pages.waarm64snap`): pause 1.18 s kept, 1.36 file, 1.17 suspend; load 9.3 s, resume 8.5.
- Debian (`debian-go.waarm64snap`, 97 MB): pause 0.16 s kept, 0.17 file, 0.15 suspend; load 2.2 s, resume 1.8.
- Memory a save adds (the browser's peak, 50 ms samples): desktop kept +89 MiB, suspend +206 (the pool's instances and
  the 3D state's 109 MB), file +1,238 (the download: blob storage ~685, the renderer ~600 until the save ends: loop
  4's); Debian kept +66, file +207, suspend +54. The browser's memory grows ~2 GB per desktop round within a session
  (backlog): A/Bs run each round in a browser of its own (`bench/boot/results/snapz-2b/run-ab.sh`, wasm arms).

## The queue (the first is next)

| Loop | What | State |
|---|---|---|
| 0 | The probe and the baseline | done (REPORT "SNAPZ loop 0") |
| 1 | lz4_flex and crc32fast in the core | done (REPORT "SNAPZ loop 1") |
| 2 | The save's pool | done (REPORT "SNAPZ loop 2") |
| 2b | Old-format code removed (kickoff decision 7); the file and suspend saves' unexplained memory found and cut (decision 8) | done (REPORT "SNAPZ loop 2b") |
| 3 | The load's pool; then the out-of-context review | next |
| 4 | The review's findings; a picked file staged through OPFS | |
| 5 | The disk's blocks, batched | |
| 6 | qcow2's clusters through miniz_oxide | |
| 7 | The load's machine start, broken down | |

## Open questions

None.
