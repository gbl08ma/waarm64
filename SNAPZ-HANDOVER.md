# SNAPZ: faster snapshots — handover

The brief, its decisions and its loops: [SNAPZ-KICKOFF.md](SNAPZ-KICKOFF.md). The measurements behind it:
`bench/boot/REPORT.md` "SNAPZ: compression across the emulator, measured"; each loop's numbers: its "SNAPZ loop N"
entry there. How the track is worked: the kickoff's "How the track runs" (a supervisor, one general-purpose subagent
at a time, one loop each, in the main checkout).

## State (2026-11-15)

Loops 0-3 done. The page times its saves and loads by phase (`data-snapshot`, `data-load`; docs/frontend.md
"Snapshots"), `bench/snapz/probe.ts` measures them (a load, a kept snapshot, the machine started from it, a file, a
suspend, the resume) and `bench/snapz/memwatch.ts` the browser's memory by process beside it (docs/benchmarking.md
"The snapshot probe"). Codec 2 is lz4_flex in the core (`core/src/codec.rs`), the frames' CRC the core's crc32fast;
older files are refused by their header (ABI 69). A save's RAM frames and a load's CRCs and RAM frames go through one
pool of `min(hardwareConcurrency − 1, 6)` workers (`web/snapshot-pool.ts`, `web/snapshot-pool-worker.ts`), started per
save and per load and closed after (docs/platform.md "A save's pool", "A load's pool"); a load reads a Blob in 4 MiB
slices, four ahead, each piece handed whole to a worker. Now (REPORT "SNAPZ loop 3", `bench/boot/results/snapz-3/`,
persistent profile `target/snapz/profile`, a fresh browser per round):
- desktop (`target/snapbench/pages.waarm64snap`): pause 1.28 s kept, 1.67 file, 1.27 suspend; load 7.6 s (check + state
  + RAM 1.13; the disk's blocks 2.16, prepare 1.95, start 2.2), kept snapshot's start 8.4, resume 6.5.
- Debian (`debian-go.waarm64snap`, 97 MB): pause 0.17 s kept, 0.18 file, 0.15 suspend; load 2.0 s (share 0.13; disk
  0.45, start 0.83), kept start 2.1, resume 1.8.
- Memory: a save as in loop 2b (desktop kept +89 MiB, suspend +206, file +1,238: loop 4's); a desktop load's peak
  170-240 MiB under loop 2b's, Debian's +58 (the pool's instances).

## The queue (the first is next)

| Loop | What | State |
|---|---|---|
| 0 | The probe and the baseline | done (REPORT "SNAPZ loop 0") |
| 1 | lz4_flex and crc32fast in the core | done (REPORT "SNAPZ loop 1") |
| 2 | The save's pool | done (REPORT "SNAPZ loop 2") |
| 2b | Old-format code removed (kickoff decision 7); the file and suspend saves' unexplained memory found and cut (decision 8) | done (REPORT "SNAPZ loop 2b") |
| 3 | The load's pool | done (REPORT "SNAPZ loop 3") |
| 3r | The out-of-context review of the pool, save and load (`review/snapz-3`) | next |
| 4 | The review's findings; a picked file staged through OPFS | |
| 5 | The disk's blocks, batched | |
| 6 | qcow2's clusters through miniz_oxide | |
| 7 | The load's machine start, broken down | |

## Open questions

None.
