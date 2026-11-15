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

Under a continuous disk read the worst flush-to-draw is 22–33 ms, against 89–972 ms in G1's measurement (docs/frontend.md "The screen"; before `serve`
yielded to the event loop every ~2 ms) and 1.2–5.6 s of device-worker lag with the storm. The blk worker would buy
nothing visible: **loop 5 dropped.** Caveat: the HTTP source here is localhost; a slow network's synchronous XHRs would still
hold the device worker for their length (a request is one XHR), which is the HTTP source's matter, not this track's.

## The inflate pool (2026-10-18): a request's compressed clusters on workers too

`web/inflate-pool.ts` (docs/devices.md "qcow2") splits a request's compressed clusters between the reading thread
and up to four workers. Measured on the dev VM (Chromium 153.0.8010.52, 8 cores) by setting its default size to 0 (no
workers: one cluster after another on the reading thread, as before), 1, 2 and 4 (the default here: cores − 1, at
most 4), alternating.

**bench/io's reads over a qcow2** (`--only io_reads`, a suite entry for the read jobs alone; the disk is
`target/bench/io-usr.qcow2`: 256 MiB of a tar of `/usr` through `qemu-img convert -c`, 64 KiB clusters, 103 MiB;
two rounds of 5 boots; `results/chromium-linux-arm64-dev-vm-inflate-pool-io.json`). Medians, both rounds:

| workers | sequential 1 MiB | sequential 128 KiB | random 4 KiB |
|---|---|---|---|
| 0 | 180 / 177 MiB/s (5.5 ms) | 89 / 90 MiB/s | 1131 / 1142 IOPS |
| 1 | 211 / 210 MiB/s | 91 / 91 MiB/s | 1147 / 1147 IOPS |
| 2 | 220 / 219 MiB/s | 91 / 90 MiB/s | 1140 / 1140 IOPS |
| 4 | **225 / 224 MiB/s** (4.4 ms) | 91 / 91 MiB/s | 1148 / 1146 IOPS |

A 1 MiB read (16 clusters) gains 25%; 128 KiB (2 clusters) and 4 KiB (one, kept on the reading thread) don't move.

**The page** (`node bench/io/inflate-page.ts <label>`: Debian's published qcow2 on the page with `?machine=debian`,
4 vCPUs, to its login prompt; then imported as a stored disk; then exported whole, qcow2 uncompressed, into OPFS;
4 rounds; `results/chromium-linux-arm64-dev-vm-inflate-pool-page.json`). Medians, the spread under 0.5 s:

| workers | boot to login | import | export |
|---|---|---|---|
| 0 | 35.0 s | 13.8 s | 8.4 s |
| 1 | 35.0 s | 13.1 s | 7.8 s |
| 2 | 35.0 s | 12.9 s | 7.6 s |
| 4 | 35.0 s | 12.8 s | 7.45 s |

The boot doesn't move with the pool at any size: inflating is ~1.6% of it (above) and the guest's reads are mostly
one or two clusters. Four workers beside four vCPUs cost the boot nothing, so the device worker keeps its pool. The
import gains 7% and the export 11%: their time is mostly the HTTP or file reads and the block store's writes. Shipped
with the default size (cores − 1, at most 4).

## The two-level map (2026-11-15, RESIZE loop 2b): the same speed, maps that grow with what's written

The overlay's map in leaves of 4 MiB made at a first write (docs/devices.md "blk"). A/B in one session on the dev VM
(Lima vz, 8 vCPUs, arm64, 18 GiB), Chromium 155.0.8059.84 headless, at `d950eb54`: A is its `web/overlay.ts` and
`web/stored.ts`, B the two-level map, swapped in the checkout between runs (`results/2026-11-15-two-level-map/`, with
`summary.py`). Rounds 1–3 ran A then B, rounds 4–5 B then A; B in rounds 4–5 also has the write path's `setRun` (below).
bench/io's suite (`--only io`, 5 boots a run: medians of each run below, KiB/s or MiB/s as the JSON has them):

| job | A (5 rounds) | B (5 rounds) | B/A, medians |
|---|---|---|---|
| random 4 KiB read (base) | 5784–5919 | 5840–5898 | +0.2% |
| sequential 1 MiB read | 282000–290525 | 281753–290377 | +0.6% |
| sequential 1 MiB write, first writes | 222155–222911 | 219183–225209 | −0.7% |
| the same with `fsync` | 195047–197397 | 190511–199804 | 0.0% |
| random 4 KiB write / with `fsync` | 4242–4336 / 3020–3121 | 4284–4325 / 3056–3103 | −0.2% / +0.6% |
| held 1 MiB / 4 KiB reads | 395341–407074 / 8126–8330 | 399226–404345 / 8190–8330 | +0.9% / 0.0% |
| `dd` read / write `conv=fsync` (MiB/s) | 56.0–57.0 / 21.6–22.1 | 56.4–56.9 / 21.5–22.0 | −0.2% / 0.0% |

Every job's rounds overlap. The first writes were 1.3% slower in rounds 1–3 (apart: 219.2–220.7 against
222.2–222.9 MB/s); in Node the leaves cost ~10 µs more JS per fresh 1 MiB write (callbacks per entry in `setMap`),
so the write path got `setRun` (a run's consecutive slots, no callback: ~8 µs left, 0.2% of the 4.2 ms request), and
with it and B first, rounds 4–5 were 225.2 and 223.7 against 222.2 and 222.2. The stage timers (`io_stats`, one boot
each, `stats-*.json`) of the first writes: 64 data writes 129 / 131 ms, map writes 64 in 21.9 ms / 65 (the header
once) in 22.8 ms: a map write costs the same whether it extends the flat file or writes into a leaf.

**The page** (`node bench/io/inflate-page.ts`: Debian's qcow2 booted to its login, imported as a stored disk,
exported whole; `page.jsonl`), ms, rounds 1–3: boot A 29717 (the session's first, cold) / 26198 / 26250, B 25987 /
26177 / 26125; import A 13086 / 13003 / 12403, B 12914 / 12658 / 12720; export A 8334 / 7795 / 7673, B 8212 / 7874 /
7772. No difference.

**Map files and memory** (`map-sizes.ts` in Node, `sizes.jsonl`; and the page's OPFS after the boot and the import):

| disk | A: map file / kept at opening | B: map file / kept at opening |
|---|---|---|
| Debian's boot overlay (page) | 1,693,708 B | 73,888 B (18 leaves) |
| Debian imported, stored (3 GiB, 1.04 GB of data) | 3,145,728 / 3,145,728 B | 1,321,504 / 1,324,560 B (322 leaves) |
| grown to 256 GiB, GPT's two headers | 256 MiB / 256 MiB | 8,224 B / 264 KiB |
| grown to 1 TiB | (past A's cap; would be 1 GiB / 1 GiB) | 8,224 B / 1.0 MiB |
| grown to 8 TiB (`MAX_RESIZE` now) | (8 GiB / 8 GiB) | 8,224 B / 8.0 MiB |

What an opening keeps past the leaves is the top table, 4 bytes per 4 MiB of disk.

## Ordered flushes (2026-11-15, RESIZE loop 2c): the overlay's write order durable, at no cost the suite sees

A review found that the overlay's "data before its map entry" held only while the OS kept its page cache: nothing was
flushed between dependent writes, so after a power loss a map entry could point at a reused slot's old bytes (another
block's), or past `data`'s end once a compaction's cut was durable before the entries it moved. `ORDERED`
(web/overlay.ts; docs/devices.md "blk") adds the flushes that make the order durable: `data` before the map entries of
a request that maps new slots (one flush per such request), the map before a freed slot is reused, a compaction's
copies before their entries, the map before `data` is cut. A/B in one session on the dev VM (Lima vz, 8 vCPUs, arm64,
18 GiB), Chromium 155.0.8059.84 headless, at `2f0c3153` + this loop: A `ORDERED = false`, B `true`, swapped in the
checkout between runs, alternated A B B A A B (`results/2026-11-15-ordered-flushes/`, with `summary.py`). bench/io's
suite (`--only io`, 5 boots a run: each run's median, KiB/s, dd in MiB/s):

| job | A (3 rounds) | B (3 rounds) | B/A, medians |
|---|---|---|---|
| random 4 KiB read (base) | 5855–5926 | 5852–5886 | −0.2% |
| sequential 128 KiB / 1 MiB read | 116611–117294 / 295056–298368 | 116057–116355 / 292327–294664 | −0.6% / −0.6% (apart) |
| sequential 1 MiB write, first writes | 221405–223672 | 219919–221405 | −1.3% |
| the same with `fsync` | 150311–170666 | 138847–154566 | −1.9% |
| random 4 KiB write / with `fsync` | 4264–4348 / 3075–3112 | 4304–4329 / 3056–3093 | +0.4% / −0.3% |
| held 1 MiB / 4 KiB reads | 423653–425984 / 8288–8329 | 419840–423794 / 8252–8338 | −0.6% / +0.2% |
| `dd` read / write `conv=fsync` | 61.6–62.3 / 23.5–23.7 | 61.4–61.6 / 23.4–23.6 | −0.8% / −0.8% |

The writes' rounds overlap (the first writes' at one value, 221405); the base reads are apart by 0.6%, under the ~1%
floor, and the change doesn't touch reads. A fresh write's extra `data` flush is cheap on this host (Chromium's
`flush` on a file the guest just wrote); the suite has no discards, so reuse's map flush isn't exercised, and it costs
one flush per write that reuses slots after a trim. Kept on. Not measured: the Mac's or the user's x86_64 host, where
a flush may cost more.
