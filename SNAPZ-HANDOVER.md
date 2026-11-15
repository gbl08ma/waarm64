# SNAPZ: faster snapshots — handover

The brief, its decisions and its loops: [SNAPZ-KICKOFF.md](SNAPZ-KICKOFF.md). The measurements behind it:
`bench/boot/REPORT.md` "SNAPZ: compression across the emulator, measured"; each loop's numbers: its "SNAPZ loop N"
entry there. How the track is worked: the kickoff's "How the track runs" (a supervisor, one general-purpose subagent
at a time, one loop each, in the main checkout).

## State (2026-11-15)

Loop 0 done: the page times its saves and loads by phase (`#message`'s `data-snapshot` with `kind` and `phases`,
`data-load`; docs/frontend.md "Snapshots"), and `bench/snapz/probe.ts` measures them (docs/benchmarking.md "The
snapshot probe"; `probe-summary.ts` for medians). The baseline (REPORT "SNAPZ loop 0", `bench/boot/results/snapz-0/`,
3 rounds, persistent profile `target/snapz/profile`):
- desktop (`target/snapbench/pages.waarm64snap`): pause 4.22 s kept, 4.31 file, 4.28 suspend (compress 2.8-2.9 s,
  scan 0.5, crc 0.43, state 0.2, disk 0.13-0.17); load 9.5 s (prepare 1.9, check 0.68, ram 2.4 of it unpack 1.7,
  disk 2.1, start 2.2), resume 7.9.
- Debian (`debian-go.waarm64snap`, 97 MB): pause 0.56-0.61 s, load 2.0 s, resume 1.4.
- Memory a save adds: desktop kept 52 MiB, file 994 (the download's Blob), suspend 186. The browser's memory grows
  ~2 GB per desktop round (backlog; not found yet).
The probe runs on a stored machine it makes in the profile ("SNAPZ desktop"/"SNAPZ debian") from a header-rewritten
copy under `target/snapz/`; `MODE=transient` reproduces the eval's transient measurement (same numbers).

## The queue (the first is next)

| Loop | What | State |
|---|---|---|
| 0 | The probe and the baseline | done (REPORT "SNAPZ loop 0") |
| 1 | lz4_flex and crc32fast in the core | next |
| 2 | The save's pool | |
| 3 | The load's pool; then the out-of-context review | |
| 4 | The review's findings; a picked file staged through OPFS | |
| 5 | The disk's blocks, batched | |
| 6 | qcow2's clusters through miniz_oxide | |
| 7 | The load's machine start, broken down | |

## Open questions

None.
