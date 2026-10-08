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

## Loop 3: coalesced overlay I/O (`results/chromium-linux-arm64-dev-vm-loop3.json`, same session setup, 5 samples)

| workload | before | after |
|---|---|---|
| sequential 1 MiB write, first writes | 6.0 MiB/s | **212 ± 1 MiB/s** (35×) |
| the same with `fsync` after each | 5.9 MiB/s | **188 MiB/s** (32×) |
| read back of written blocks, 1 MiB | 17 MiB/s | **358 ± 10 MiB/s** (21×) |
| `dd` write, `conv=fsync` | 4.9 MiB/s | 20.0 ± 0.3 MiB/s (4×) |
| random 4 KiB write / with `fsync` | 1077 / 769 IOPS | 1075 / 764 (unchanged: one data and one map write each) |
| every base read, held random 4 KiB read | | unchanged (within IQR) |

Tests (`tests/overlay.test.ts`): call counts for a fresh, overwritten, read-back and unaligned request; a random model test
(writes, discards, reads, reopens); a crash test replaying every prefix of the logged OPFS writes (each block is the base or
a written one). Planted bug (map written before data in the run path): the crash test fails; restored.

Left in the overlay: a random first write still pays two ~0.3 ms calls. Deferring map entries to `FLUSH` would halve it.

## The real case: Debian's qcow2, chosen, through UEFI (loops 2, 4, 6, 7 judged)

One boot of `target/images/debian/disk.qcow2` chosen on the page (2 vCPUs, JIT, realtime, fresh overlay), the blk device's
stage timers on (temporary hooks: `stats` on the page's disk spec and a 2 s log of `Devices.stats()`, not committed):
`results/chromium-linux-arm64-dev-vm-debian-boot-stats.json`. Kernel's first output at 13.1 s, root prompt at **50.6 s**.

| stage | calls | time | share of the 50.6 s |
|---|---|---|---|
| all requests (`request`) | 5261 | 3.13 s | 6.2% |
| base reads (`FileReaderSync`, after qcow2 mapping) | 2769 (90 MB) | 1.96 s | **3.9%** |
| overlay writes (data + map) | 366 + 262 | 0.35 s | 0.7% |
| inflating compressed clusters (request − the rest) | | ~0.8 s | ~1.6% |
| `scatter` / `gather` / flush | | 0.02 s | <0.1% |

Requests are 4 to 128 KiB (one of 1 MiB, one of 4 MiB): nothing sits at `seg_max`.

- **Loop 2 (chunk cache, readahead): dropped.** Everything the base reads cost is 3.9% of the boot; a cache could save part
  of it, so under the 5% rule. (The part before the kernel is not split out; it is inside the same 1.96 s.)
- **Loop 4 (copies): dropped** (as the baseline said). **Loop 6 (limits, `EVENT_IDX`): dropped**: no request is capped, and all
  requests together are 6% of the boot. **Loop 7 (qcow2 inflate in parallel): dropped**, ~1.6%.
- **Loop 1: dropped** (flush ~10 µs). **Loop 5 (blk worker): not measured here**; it only matters for the screen stalling
  behind a long read (H2), which a boot's totals don't show. Left in `docs/backlog.md`'s entry.
- Shipped: loop 3 (writes and held reads ×4 to ×35). Debian's boot is guest CPU bound, not disk bound.

## Loop 5 judged: the screen no longer stalls behind disk reads (H2)

`node bench/gpu/draw-latency.ts out.json [--chosen]` (Debian on the page, tty1 changing every ~30 ms, then
`dd bs=1M count=16` at random offsets of `/dev/vda` in a loop after dropping the page cache; flush-to-draw ms from the
display's own `draw-stats`), alternating the served image over HTTP (localhost) and the same qcow2 chosen as a `File`
under an overlay, two runs each (`bench/gpu/results/2026-10-08-io-draw-*.json`, Chromium 153, dev VM):

| disk | idle: median of medians / worst | reading: median of medians / worst |
|---|---|---|
| HTTP, run 1 / 2 | 4.4 / 16.9 ms; 3.2 / 22.7 ms | 0.2 / 33.2 ms; 1.2 / 28.1 ms |
| chosen file, run 1 / 2 | 4.4 / 14.7 ms; 6.9 / 15.1 ms | 2.4 / 28.8 ms; 2.6 / 22.4 ms |

Under a continuous disk read the worst flush-to-draw is 22–33 ms, against 89–972 ms in graphics.md §12 (before `serve`
yielded to the event loop every ~2 ms) and 1.2–5.6 s of device-worker lag with the storm. The blk worker would buy
nothing visible: **loop 5 dropped.** Caveat: the HTTP source here is localhost; a slow network's synchronous XHRs would still
hold the device worker for their length (a request is one XHR), which is the HTTP source's matter, not this track's.
