# SNAPZ: faster snapshots — handover

The brief, its decisions and its loops: [SNAPZ-KICKOFF.md](SNAPZ-KICKOFF.md). The measurements behind it:
`bench/boot/REPORT.md` "SNAPZ: compression across the emulator, measured"; each loop's numbers: its "SNAPZ loop N"
entry there. How the track is worked: the kickoff's "How the track runs" (a supervisor, one general-purpose subagent
at a time, one loop each, in the main checkout).

## State (2026-11-15)

Loops 0-2 done. The page times its saves and loads by phase (`data-snapshot`, `data-load`; docs/frontend.md
"Snapshots"), `bench/snapz/probe.ts` measures them (docs/benchmarking.md "The snapshot probe"). Codec 2 is lz4_flex
in the core (`core/src/codec.rs`), the frames' CRC the core's crc32fast (ABI 68; docs/abi.md "SNAPZ: the snapshot codec
and CRC"). A save's RAM frames go through a pool of `min(hardwareConcurrency − 1, 6)` workers started with the save
(`web/snapshot-pool.ts`, `web/snapshot-pool-worker.ts`; docs/platform.md "A save's pool"), the rest of the save and
the whole load on the machine worker (`web/lz.ts`'s one instance). Now (REPORT "SNAPZ loop 2",
`bench/boot/results/snapz-2/`, persistent profile `target/snapz/profile`, a fresh browser per round):
- desktop (`target/snapbench/pages.waarm64snap`): pause 1.07 s kept, 1.16 file, 1.10 suspend (4 workers: 1.22; state
  0.23, ram 0.67 wall, disk 0.12); load 9.1 s (prepare 1.85, check 0.66, ram 1.73, disk 2.16, start 2.37), resume 6.9.
- Debian (`debian-go.waarm64snap`, 97 MB): pause 0.16 s kept and file, 0.14 suspend; load 2.1 s, resume 1.9.
- Memory a save adds: the pool's instances ~90-140 MiB while it runs (desktop kept +137 MiB); the desktop's file
  +1,303 (the download's Blob), suspend +532 (~200 MiB more than the pool explains: backlog). The browser's memory
  grows ~2 GB per desktop round within a session (backlog): A/Bs run each round in a browser of its own
  (`bench/boot/results/snapz-2/run-ab.sh` for JS-only arms, snapz-1's for wasm arms).
- Compatibility code a later piece may remove (the user's 2026-11-15 OK to drop old files): codec 1 (deflate-raw) in
  the reader (`deflateCodec`; the writer's default only in tests), the old-LZ fixture and its tests
  (`tests/fixtures/old-lz.waarm64snap`, `tests/old-lz-content.ts`, `core/src/codec.rs` `old_codec_frames_still_load`),
  and the JS CRC in the reader where a core codec is always given (format version 1 is still written: a file
  without BLOB frames).

## The queue (the first is next)

| Loop | What | State |
|---|---|---|
| 0 | The probe and the baseline | done (REPORT "SNAPZ loop 0") |
| 1 | lz4_flex and crc32fast in the core | done (REPORT "SNAPZ loop 1") |
| 2 | The save's pool | done (REPORT "SNAPZ loop 2") |
| 2b | Old-format code removed (kickoff decision 7); the file and suspend saves' unexplained memory found and cut (decision 8) | next |
| 3 | The load's pool; then the out-of-context review | |
| 4 | The review's findings; a picked file staged through OPFS | |
| 5 | The disk's blocks, batched | |
| 6 | qcow2's clusters through miniz_oxide | |
| 7 | The load's machine start, broken down | |

## Open questions

None.
