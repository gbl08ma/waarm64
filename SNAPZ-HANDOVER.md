# SNAPZ: faster snapshots — handover

The brief, its decisions and its loops: [SNAPZ-KICKOFF.md](SNAPZ-KICKOFF.md). The measurements behind it:
`bench/boot/REPORT.md` "SNAPZ: compression across the emulator, measured"; each loop's numbers: its "SNAPZ loop N"
entry there. How the track is worked: the kickoff's "How the track runs" (a supervisor, one general-purpose subagent
at a time, one loop each, in the main checkout).

## State (2026-11-15)

Loops 0 and 1 done. The page times its saves and loads by phase (`data-snapshot`, `data-load`; docs/frontend.md
"Snapshots"), `bench/snapz/probe.ts` measures them (docs/benchmarking.md "The snapshot probe"). Codec 2 is lz4_flex
in the core (`core/src/codec.rs`), the frames' CRC the core's crc32fast (`crc32(seed, src, len)`, ABI 68; `Codec.crc32`
in `web/lz.ts`), both one thread on the machine worker; the exports take addresses only (no VM, no allocation), as a
pool's per-worker instances on the guest's memory need (docs/abi.md "SNAPZ: the snapshot codec and CRC"). Now (REPORT
"SNAPZ loop 1", `bench/boot/results/snapz-1/`, persistent profile `target/snapz/profile`, a fresh browser per round):
- desktop (`target/snapbench/pages.waarm64snap`): pause 3.79 s kept, 3.79 file, 3.73 suspend (compress 2.55 s, scan
  0.46, crc 0.29, state 0.2, disk 0.13); load 9.2 s (prepare 1.9, check 0.75, ram 2.1 of it unpack 1.15, disk 2.1,
  start 2.3), resume 7.2. Files 2% smaller (kept 676 MB).
- Debian (`debian-go.waarm64snap`, 97 MB): pause 0.51-0.54 s, load 2.1 s, resume 1.9.
- Memory a save adds: desktop kept ~21 MiB, file ~990 (the download's Blob), suspend ~182. Within one browser session
  the memory grows ~2 GB per desktop round (backlog); A/Bs run each round in a browser of its own
  (`bench/boot/results/snapz-1/run-ab.sh`: an arm is its tree checked out and its wasm copied into the build's path).

## The queue (the first is next)

| Loop | What | State |
|---|---|---|
| 0 | The probe and the baseline | done (REPORT "SNAPZ loop 0") |
| 1 | lz4_flex and crc32fast in the core | done (REPORT "SNAPZ loop 1") |
| 2 | The save's pool | next |
| 3 | The load's pool; then the out-of-context review | |
| 4 | The review's findings; a picked file staged through OPFS | |
| 5 | The disk's blocks, batched | |
| 6 | qcow2's clusters through miniz_oxide | |
| 7 | The load's machine start, broken down | |

## Open questions

None.
