# Disk I/O on a chosen disk (M8 track IOSPEED, loop 0)

Baseline at `845b2c00dc07` + the benchmark and timers (this change). Chromium 153.0.8010.52 headless, dev VM
(Lima vz, 8 vCPUs, arm64), realtime mode, Buildroot kernel, a 256 MiB random-data raw file chosen through an
`<input type=file>` (`FileReaderSync` reads) under a fresh OPFS overlay, one boot per sample, 5 samples
(`results/chromium-linux-arm64-dev-vm-base.json`, medians and IQR inside). Stage timers, one boot per workload
(`…-base-stats.json`, `io_stats`): count, time and bytes per OPFS call, base read and request.

## Baseline (median ± IQR)

| workload | result |
|---|---|
| random 4 KiB read (base) | 1459 ± 22 IOPS, 642 µs |
| sequential 128 KiB read | 110 ± 1 MiB/s |
| sequential 1 MiB read | 268 ± 1 MiB/s |
| `dd` 1 MiB buffered read | 55 MiB/s |
| sequential 1 MiB write, first writes | **6.0 MiB/s** (165 ms per MiB) |
| the same, `fsync` after each | 5.9 MiB/s |
| random 4 KiB write | 1077 IOPS; with `fsync` 769 |
| `dd` write, `conv=fsync` | 4.9 MiB/s |
| read back of written blocks, 1 MiB | **17 MiB/s** (58 ms per MiB) |
| read back, random 4 KiB | 2082 IOPS |

## What carries the time (hypotheses H1–H8)

- **H4 (overlay not coalesced): the writes and every read of written data.** An OPFS sync-handle call costs
  ~220 µs (read) to ~320 µs (write) *whatever its size* (a 4-byte map write: 322 µs; a 4 KiB data write: 322 µs).
  A fresh 1 MiB write makes 256 data + 256 map writes (10.6 s of a 64 MiB run's 10.7 s are those calls); reading
  it back makes 256 `data.read`s (219 µs each, 2.9 s of 3.0 s). Call count is the lever.
  A random 4 KiB first write is one data + one map write: half of its request time is the map write.
- **H1 (`FileReaderSync`): ~420 µs per call, nearly flat in size** (4 KiB 428 µs; 128 KiB 540 µs; 1 MiB 1.6 ms).
  64% of a random 4 KiB read's latency, 50% of a 128 KiB read's, 40% of a 1 MiB read's. Ships a cache only if the
  boot-loader case gains; loop 2 decides.
- **H3 (flush): dropped.** `flush()` costs ~10 µs a call here (255 flushes: 0.8 ms of 190 ms), under 1% of every
  workload. (The Mac host's OPFS may differ: not measured.)
- **H5 (copies): dropped.** `gather` 13 ms and `scatter` 28 ms of 10 s and 1.5 s: under 2%.
- **H7 (limits): dropped.** Adjacent pages merge: `dd` and 1 MiB reads arrive as up to 4 MiB requests, the
  request ring holds them; nothing is pinned at `seg_max`.
- **H6 (round trip): not isolated.** fio's mean latency exceeds the time in `request` by ~240 µs (4 KiB random),
  ~550 µs (128 KiB) and ~2 ms (1 MiB); that is guest driver work plus doorbell, completion and interrupt. A counter
  in the signal path would split it; loop 4/6 only if the larger items leave it above 5%.
- **H2 (device worker shared), H8 (qcow2): not measured yet** (the screen-stall test and the qcow2 and GRUB cases
  are the rest of loop 0).

## Order

Loop 3 first (coalesced overlay I/O: ×10–100 on writes and held reads), then loop 2 (`FileReaderSync` cache) judged on the
boot-loader case, loop 1 dropped, loop 4's copies dropped, loop 5 and 6 by the remaining numbers.
Candidate inside loop 3: keep map entries in memory and write them, coalesced, at `FLUSH` (a flushed write still
survives a crash; unflushed ones may be lost, which the virtio flush contract allows; slot data still goes before
its map entry).
