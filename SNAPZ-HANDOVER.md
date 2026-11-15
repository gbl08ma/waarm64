# SNAPZ: faster snapshots — handover

The brief, its decisions and its loops: [SNAPZ-KICKOFF.md](SNAPZ-KICKOFF.md). The measurements behind it:
`bench/boot/REPORT.md` "SNAPZ: compression across the emulator, measured"; each loop's numbers: its "SNAPZ loop N"
entry there. How the track is worked: the kickoff's "How the track runs" (a supervisor, one general-purpose subagent
at a time, one loop each, in the main checkout).

## State (2026-11-15)

Opened. Nothing built yet. The desktop guest's warm snapshot is `target/snapbench/pages.waarm64snap` (689 MB; save
pauses 4.2 s, load 9.8 s, measured off the probe in `bench/snapz/`).

## The queue (the first is next)

| Loop | What | State |
|---|---|---|
| 0 | The probe and the baseline | next |
| 1 | lz4_flex and crc32fast in the core | |
| 2 | The save's pool | |
| 3 | The load's pool; then the out-of-context review | |
| 4 | The review's findings; a picked file staged through OPFS | |
| 5 | The disk's blocks, batched | |
| 6 | qcow2's clusters through miniz_oxide | |
| 7 | The load's machine start, broken down | |

## Open questions

None.
