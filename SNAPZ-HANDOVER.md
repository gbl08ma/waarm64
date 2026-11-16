# SNAPZ: faster snapshots — handover

The brief, its decisions and its loops: [SNAPZ-KICKOFF.md](SNAPZ-KICKOFF.md). The measurements behind it:
`bench/boot/REPORT.md` "SNAPZ: compression across the emulator, measured"; each loop's numbers: its "SNAPZ loop N"
entry there. How the track is worked: the kickoff's "How the track runs" (a supervisor, one general-purpose subagent
at a time, one loop each, in the main checkout).

## State (2026-11-16)

Loops 0-5 and 7 done. The page times its saves and loads by phase (`data-snapshot`, `data-load`; docs/frontend.md
"Snapshots"), `bench/snapz/probe.ts` measures them (a load, a kept snapshot, the machine started from it, a download,
a picked file standing in by an OPFS file, a suspend, the resume) and `bench/snapz/memwatch.ts` the browser's memory
by process beside it (docs/benchmarking.md "The snapshot probe"). Codec 2 is lz4_flex in the core, the frames' CRC
crc32fast; older files are refused by their header (ABI 69). A save's RAM frames and a load's CRCs and RAM frames go
through one pool of `min(hardwareConcurrency − 1, 6)` workers (`web/snapshot-pool.ts`), started per save and per load
and closed after; a failed or silent worker (10 s) fails the whole pool, whose work the machine worker then does. A
file save (picked or downloaded) is staged through OPFS (`web/snapshot-stage.ts`; docs/frontend.md "Snapshots"):
written there during the pause, copied into the picked file after the resume (Blob slices) or downloaded from it;
direct when there's no room or a staging write is refused. A restore writes the disk's blocks a run a call
(`diskRuns`), its overlay unordered and flushed at the end; a save reads them with the overlay's `blocks(list)`
(docs/devices.md, docs/platform.md "The disk is in the file"). The dev server answers a HEAD from the file's stat
(sirv's read the whole disk image: 4.3 s of every desktop load the probe measured until loop 7), and a start's device
worker is started beside the check pass and gets the restore's state moved, not copied (web/vm.ts `warmWorkers`). The probe also runs off the record
(`WAARM64_PROFILE=off`) and a subset of operations (`OPS`). Now (REPORT "SNAPZ loop 7", `bench/boot/results/snapz-7/`,
persistent profile `target/snapz/profile`, a fresh browser per round):
- desktop (`target/snapbench/pages.waarm64snap`): pause 1.11 s kept, 1.26 download, 1.18 picked (then a ~1.4 s copy,
  the machine running), 1.28 suspend; load 1.44 s (prepare 0.03, check 0.5, state 0.09, RAM 0.6, the disk's blocks
  0.11, start 0.09; the probe's wall 1.58), kept snapshot's start 1.37, resume 1.19. Off the record (loop 5, before
  the HEAD fix): load 5.8 s (disk 0.76), kept pause 2.7 (2.2 of it the sink's OPFS writes).
- Debian (`debian-go.waarm64snap`, 97 MB): pause 0.16 s kept, download and picked, 0.16 suspend; load 0.29 s.
- Memory while a save runs: desktop kept +141 MiB, download +163, picked +253, suspend +211 (loop 5); Debian +60-85.
  A desktop load peaks at 3.2 GiB for the browser, ~200 MiB under loop 5's.

## The queue (the first is next)

| Loop | What | State |
|---|---|---|
| 0 | The probe and the baseline | done (REPORT "SNAPZ loop 0") |
| 1 | lz4_flex and crc32fast in the core | done (REPORT "SNAPZ loop 1") |
| 2 | The save's pool | done (REPORT "SNAPZ loop 2") |
| 2b | Old-format code removed (kickoff decision 7); the file and suspend saves' unexplained memory found and cut (decision 8) | done (REPORT "SNAPZ loop 2b") |
| 3 | The load's pool | done (REPORT "SNAPZ loop 3") |
| flakes | Timing-dependent tests fixed (the user's request, 2026-11-15): condition waits (`tests/until.ts`, docs/testing.md "Waiting in tests") | done |
| 3r | The out-of-context review of the pool, save and load (`review/snapz-3`) | done (fixed in loop 4; branch deleted) |
| 4 | The review's findings; a picked file staged through OPFS | done (REPORT "SNAPZ loop 4") |
| 5 | The disk's blocks, batched | done (REPORT "SNAPZ loop 5") |
| 7 | The load's machine start, broken down (before loop 6: one CI run covered loops 5 and 7) | done (REPORT "SNAPZ loop 7") |
| 6 | qcow2's clusters through miniz_oxide | next |

## Open questions

None.
