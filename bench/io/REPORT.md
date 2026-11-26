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

## PERF loop 76 (2026-11-25): the blk path and the bulk writes on a persistent profile

Everything above was measured off the record (Playwright's default context: OPFS in memory, every sync-handle call
~0.3 ms, a flush free). A user's browser has a profile, where OPFS is a file on disk: a call costs µs and a flush is
what costs. `bench/run.ts --profile=<dir>` runs a page on a fresh persistent profile made under `<dir>` (on disk: the
dev VM's `/tmp` is RAM) and removed after; `bench/run-mac.sh` carries bench/io and the `--input` file to the Mac.
Hosts: the dev VM (Lima vz, 8 vCPUs, arm64, xfs), Chromium 155.0.8059.84; the Mac mini M4 (macOS, APFS), Chrome for
Testing 158.0.8127.88; both headless. Raw: `results/2026-11-25-perf76/` (`stats.py`, `summary.py`, `bulk.py`, the
drivers `ab.sh` and `ab-bulk.sh`, `bulk.patch`: this loop's change, which `ab-bulk.sh base` takes out for a run).

**The blk device's stages** (`io_stats`, one boot a workload; µs a request in `request`, then the calls that carry it;
`*-stats-*.json`):

| workload | VM off the record | VM profile, `ORDERED` | VM profile, unordered | Mac profile, `ORDERED` |
|---|---|---|---|---|
| random 4 KiB first write | 659: data write 329, map write 317 | 222: data flush 185, write 11, map 13 | 31 | 472: data flush 443 |
| sequential 1 MiB first write | 2,622: data write 2,088, map 338, gather 146 | 1,070: data flush 728, write 74, gather 165 | 344 (gather 184) | 1,353: flush 994, write 136, gather 93 |
| held 1 MiB / 4 KiB read | 447 / 257 (data read 365 / 223) | 99 / 15 (data read 56 / 4, scatter 20 / 1) | 88 / 13 | 90 / 14 |
| base 4 KiB read (`FileReaderSync`) | 412 | 415 | | 198 |

On a profile the ordered flush (one `data` flush per request that maps new slots: docs/devices.md "blk") is 83-94%
of a first write's time in the device; nothing else in the write path is past 10 µs a 4 KiB block.

**What the guest sees** (`--only io`, 5 boots a run, `ORDERED` on and off alternated on off off on on off, 3 runs
each; each run's median; `*-io-profile-{on,off}-N.json`, `summary.py`):

| job | VM on | VM off | VM off/on | Mac on | Mac off | Mac off/on |
|---|---|---|---|---|---|---|
| sequential 1 MiB first write, MB/s | 366-374 | 446-462 | +24.5% | 275-317 | 377-465 | +38% |
| ... latency µs | 2403-2446 | 1867-1949 | −23% | 2862-3331 | 1845-2359 | −31% |
| random 4 KiB first write, KB/s | 8023-8308 | 13698-13861 | +72% | 4558-5520 | 15753-16253 | +225% |
| ... latency µs | 435-452 | 245-248 | −46% | 677-815 | 203-210 | −73% |
| the same with `fsync` after each, KB/s | 4129-4162 | 4432-4452 | +7% | 1741-2202 | 1729-2124 | −3% |
| sequential 1 MiB with `fsync`, MB/s | 287-298 | 216-241 | −20% | 197-213 | 174-218 | −10% |
| `dd bs=1M conv=fsync` (buffered), MiB/s | 24.4-24.8 | 24.4-24.8 | −0.8% | 24.9-25.5 | 24.6-25.0 | −1.9% |
| every read job | | | within ±1.2% | | | within ±0.9% |

So the flushes cost a guest's **direct** first writes (fio's `direct=1` without `fsync`: −23% to −73% latency
without them), and nothing else: a write the guest flushes pays the same flush at its `FLUSH` instead (the fsync'd
jobs' bandwidth doesn't gain), and a buffered write isn't waiting on the device (`dd`'s requests are ~22 ms of its
~650: the guest's CPU is the rest). Debian's boot makes ~260 first-write requests (above, "The real case"): 0.05-0.26 s
of flushes in a 26-35 s boot. **Not built:** keeping new map entries in memory until the guest's `FLUSH` (one data
flush a group, "Order" above) keeps a crash consistent but loses what a closed tab keeps today: the OS's cache holds
every acknowledged write's data and entry, and a closed tab would take the entries written since the guest's last
`FLUSH` with it. Writing the entries at once without the flush loses the crash consistency `ORDERED` was added for.
What would keep both: entries that check themselves (each new entry, with a checksum of its slot's bytes, appended
to a log that the opening replays and drops where the bytes don't match), with every reader of a map file (a stored
disk's readers, merges, restores) reading the log too: a fourth file and a new format, for a gain only direct I/O
sees. Left as a finding (docs/devices.md "blk").

**The copies** (`gather` into a fresh buffer, `scatter` into the guest's memory): `scatter` is ~20 µs a MiB, ~1% of a
held 1 MiB read (a read straight into the guest's segments would save that); `gather` ~165-184 µs a MiB, 7-10% of the
direct 1 MiB write, about half of it the fresh buffer's making (a Node micro-benchmark, not kept: 90 µs against 45 µs a MiB
copied from 256 segments into a new buffer or a kept one), so a kept buffer would save ≤ ~4% of a direct write and nothing a
buffered one sees. Not built.

**The bulk writes** (row 15). `--only io_bulk` (`bench/io/bulk.ts`): the 256 MiB random file imported as a stored disk
(`importImage`), a 1 MiB run zeroed every 16 MiB, its blocks written as a changes file over a blank 256 MiB base and
loaded as a new overlay (`loadChanges`, the page's Import changes; its base hash, ~0.14 s, timed apart and left out),
then that overlay merged into an empty stored disk (`mergeOverlay`); 3 rounds a run, the first checking the merged
disk against the file. A snapshot's restore was already in runs (bench/boot/REPORT.md "SNAPZ loop 5": the desktop's
blocks ~0.1 s on a profile), and the merge since RESIZE loop 2c's review (runs of up to 256 blocks). What was left:

- **Import changes wrote a block a call** (a data write, a data flush and a map write each), and `readChanges` read
  the file a cluster at a time (a chosen file's `FileReaderSync` read is ~0.2-0.4 ms whatever its size: on a profile
  that, not OPFS, was most of the 21 s). **Built:** `readChanges` reads data clusters that follow each other in the
  file as on the disk in one read, up to 1 MiB (web/qcow2.ts); `changesInto` (web/changes.ts) gives `write` and
  `zero` runs of up to 256 consecutive blocks of one kind, into the new overlay opened unordered, both files flushed at
  its end.
- **An import flushed `data` after each MiB's write.** **Built:** the import's store is opened unordered and flushed at
  its end (web/stored.ts). Both are safe because nothing reads a new store or overlay before the page records it, and
  the page records it once the job is done, after that flush (web/app/disks.ts `importStored`, `loadChangesInto`): one
  cut off by a closed tab or a crash is never a disk; its files are the store's sweep's.

Medians of each run's 3 rounds, ms (base = without `bulk.patch`, new = with it; alternated base new new base base new
on a profile, one run each off the record):

| 256 MiB | VM profile base | VM profile new | VM off base / new | Mac profile base | Mac profile new | Mac off base / new |
|---|---|---|---|---|---|---|
| import | 465-480 | 462-474 | 1,052 / 1,026 | 347-465 | 180-184 | 416 / 408 |
| Import changes (without the hash) | 20,577-21,101 | 301-314 | 54,189 / 823 | 17,962-28,861 | 160-186 | 17,549 / 399 |
| merge | 231-261 | 280-312 | 819 / 775 | 352-575 | 333-383 | 377 / 352 |

Import changes is 70× faster on the VM's profile (180× off the record) and 110-170× on the Mac's: a 4 GiB changes file
would have taken ~5.5 min on a profile (~14 min off the record) and now takes ~5 s. The import on the Mac's profile
is twice as fast (its flushes were ~1 ms a MiB there); on the VM the flushes and the one flush at the end write the
same bytes, and the import doesn't move. The merge's code didn't change: on the VM it ran 20% slower right after the
new load, which leaves its 256 MiB to the OS's writeback a moment before (with 3 s between the load and the merge,
`diag-merge-after-pause-*.json`: new 235-312, base 291-353 ms); the Mac's overlap. Memory: a 1 MiB run buffer and
1 MiB reads of the changes file in place of 4 KiB ones during a load: ~2 MiB while it runs.

**Tests:** `tests/changes.test.ts` "a changes file loads in runs" (a file whose blocks cross the run's 256 and a leaf's
1,024, zeros after data, a lone block, a partial last block: the reads of the file, the calls, one data flush, both
files flushed after their last write, the disk and its zero blocks without slots); `tests/stored.test.ts` "an import
writes its store unordered and flushes both files once, at its end" and "in Chromium (OPFS): an import cut off by its
page closing leaves no stored disk" (a 256 MiB import, the page closed at its first progress: no record, its files
left). Planted, each caught: runs not split where data turns to zeros, no final flush (the load's and the import's),
the load opened ordered, the import opened ordered, no 256-block cap, a cluster a read, and the disk's record put
before the import's job.

## PERF loop 77 (2026-11-25): the out-of-context review of disk writes, fixed

The review of how disk data reaches OPFS outside the guest's own writes (branch `review/disk-writes` at b491684d,
`review/disk-writes.md`; static, at 0c5d26f1) ranked nine findings. Each was checked against the code; each defect got
its test at the cheapest layer, run first against 0c5d26f1's code (all seven reviewer scenarios that need no new API
failed there), then fixed. Nothing was measured: no change touches a path the guest's I/O takes (a meta write before a
bulk fill's first block and after its last flush; a lock probe per id-named directory at the page's start), and no
stored format changes for existing data (below). Step counts don't move.

**The common fix: a bulk fill's mark.** A restore's, an import's and Import changes' bulk writes (unordered since
loop 76 and SNAPZ loop 5) went into an overlay a record could already name, so "nothing reads it before the page
records it" didn't hold. The overlay's `meta` gets a fill mark (a u64 at 40: `meta` grows from 40 to 48 bytes only
while marked; a 32- or 40-byte meta reads as unmarked, so every stored machine, disk and snapshot opens as before).
A fill opens its overlay `fresh` (emptied under the overlay's Web Lock, closing the gap `removeOverlay` then
`openOverlay` left), writes the mark before its first block and clears it after both files' flush. An opening that
finds the mark, under the lock (so no fill runs), never reads the overlay as written: a writer's empties it in place
with its generation moved on (no fork record or snapshot pin matches it again), a reader's sees it empty
(web/overlay.ts `openOverlay`). docs/devices.md "blk" says what exists.

| # | the review's finding | outcome | test (failing first) | fix |
|---|---|---|---|---|
| 1 | High: a restore cut off or refused leaves a half-written overlay recorded and attached; a later restore reuses it | **defect** | `tests/snapshot.test.ts` "a restore refused after some of its disk's blocks were written leaves the overlay marked…" (a stream's damaged second DISK frame, refused after the first was written: failed at 0c5d26f1, unmarked); `tests/template.test.ts` "a fork whose restore was cut off before its fill was done is never reused…" | the fill mark (web/snapshot.ts); the worker refuses a `keep` of a marked overlay; `earlierFork` skips a marked fork; a new fork records what its attachment had (`fork.before`, an optional field), and `undoCutRestores` (web/app/snapshot-undo.ts, run by `loadStored`) puts a machine whose fork is still marked and free back on it, the fork deleted; the worker's words now say the disks hold none of the snapshot (`worker-errors.notRestored.cause`) |
| 2 | High: Import changes onto a transient disk deletes the overlay before the file is known readable, then says "The disk is unchanged" | **defect** (confirmed) | `tests/changes.test.ts` "a changes file cut short (its tables past its end) is refused before the overlay is touched…" (the reviewer's case: failed, block 9 gone) and "a changes file whose blocks fail to read part way leaves the overlay empty…" | `readChanges`'s `check` (every L1, L2 table and cluster in the file) before the overlay is touched (`disks:qcow2.changesTruncated`); the load is a fill (`fresh`: the second tab's gap closed too); a failure after the emptying carries `cleared`, and the page says [The changes the disk held were deleted, and it starts from its image.](ui:disks:disk-changes.changes.failed.emptied) for its own disk |
| 3 | Medium-high: after a merge cut off, the machine with the merged overlay chosen can't start (its lock held by itself) | **defect** (confirmed) | `tests/stored.test.ts` "a machine whose disk is marked by a merge cut off of the overlay it has chosen starts…" (`Devices.open`: failed after 10,022 ms, "in use") | `Devices.open` finishes the stored disks' merges before it opens any overlay |
| 4 | Medium: an interrupted import's files are never removed (the sweep never runs), though the docs rely on it | **defect in the docs and the code**; the sweep **not** wired in (below) | `tests/stored.test.ts` "in Chromium (OPFS): an import cut off by its page closing…" now also removes what it left at the next page | imports are marked too; the page's start runs `Store.dropCutFills`: an id-named `disks/` or `overlays/` directory still marked, its lock free (`ifAvailable`), no record naming it, all checked under its lock; `tests/overlay.test.ts` "dropCutFill removes … only when marked, its lock free and no record names it"; machines.md §2 and devices.md say what is removed and what still isn't |
| 5 | Medium: a blank disk's conversion loses the overlay if cut off between the copy and the disk's record | **defect** | `tests/merge.test.ts` "a blank disk's conversion cut off after its copy, before the disk's record…" (the record write made to throw: failed, the overlay's files gone) | the copy keeps the overlay (`keep`); the page unchooses it, writes the disk's record, then deletes the overlay's record and files |
| 6 | Low: `writeMeta` on a raw sync handle throws `QuotaExceededError` where callers expect `false` | **defect** | `tests/overlay.test.ts` "writeMeta on a file whose write throws QuotaExceededError is a refusal…" | `writeMeta` writes through `shortOnFull`, so `withRoom` makes room and retries |
| 7 | Low: a merge blocked by an earlier unfinished merge deletes the other overlays first, then fails | **defect** | `tests/merge.test.ts` "a merge into a disk marked by an unfinished merge of another overlay is refused before any overlay is deleted" (failed: `overlayMerging` after the deletions) | refused up front, naming the overlay whose merge didn't finish ([A merge of the overlay {{name}} into this disk didn't finish…](ui:disks:merge.otherMerging)) |
| 8 | Low: `loadChanges` compares the changes' virtual size with a qcow2 base's file size | **defect** | `tests/changes.test.ts` "a changes file over a qcow2 base whose file is larger than its virtual size loads" (a 16 KiB qcow2 in a 36 KiB file: failed, `otherSize`) | an image base is compared by its virtual size; a stored or blank base as before (its bytes are its disk's, a grown one up to what its hash covers) |
| 9 | Suspicious: a sweep (once wired) could race `createOverlay`'s own size | **not a defect today** (nothing calls the sweep) | — | written into backlog.md "The store's sweep never runs" as a condition for wiring it |

**What was decided.**
- **The sweep stays unwired.** Its known races (a template's import keeps its snapshot outside the write lock; a
  `writing` nested in `writing` deadlocks behind a queued exclusive sweep; finding 9) aren't this review's to fix, and
  it would delete by "no record" alone. `dropCutFills` removes only what a fill's mark proves cut off, under the
  directory's own lock, so it is safe beside other tabs and their jobs; what else the sweep would take stays
  (backlog).
- **A cut-off restore's fork is undone, not just emptied.** The mark alone keeps a half fork from being read, but the
  machine would then boot the disk's image while its earlier overlay sat detached in the list. The fork's record
  says what its attachment had (`fork.before`, optional: older records lack it and are only emptied), and the page puts
  it back when it next loads the machine, after a closed tab and after a refusal alike (Retry reloads it).
- **A replace keeps no old blocks.** A restore's replace, a template's fresh overlay, a transient machine's load and
  Import changes onto the page's own disk empty the overlay before filling it; cut off, they start from the image,
  and the words say so. Keeping the old blocks until the new ones are whole needs a second directory and a pointer
  every opener reads (OPFS can't swap directories): out of proportion here, written as backlog.md "A restore's replace
  fills in place".
- **A conversion cut off after the disk's record** may leave the overlay's record beside the disk made stored
  (unchosen, its blocks the disk's): two IndexedDB writes apart, harmless, and deletable.

**Planted bugs, each caught:** the restore's mark not written; its mark never cleared; a writer's opening not
emptying a marked overlay; a reader's not; the generation not moved on; `fresh` ignored; a `keep` of a marked overlay
let through; `earlierFork` reusing a marked fork; no undo; the undo ignoring a fork open elsewhere (a reader holding
it); no `check`; Import changes unmarked (the test first wrote no block before its failure, so it missed this: it now
fails on the third of three runs); no `cleared`; the hashed size kept for an image base; no merge resume before the
overlays; the conversion's copy deleting the overlay; no up-front refusal of a blocked merge; `writeMeta` on the raw
handle; `dropCutFill` ignoring the record (the test first passed by a released lock that hadn't landed yet: it waits
for the release now) and ignoring the lock; a 40-byte meta growing without a mark; the import unmarked.

**A flake fixed on the way:** `tests/page-home-levels.test.ts` failed once in `scripts/ci.sh` with two levels in the
column (a strict-mode locator): its wait for one level alone could pass before the move had started. It now waits
for the level it expects to be there alone (`atLevel`).

## PERF loop 78 (2026-11-26): the out-of-context review of cut-off disk jobs, fixed

The review of what the page does about disk jobs cut off part way (branch `review/cut-jobs` at ad551489,
`review/cut-jobs.md`; static, at 7d9a42e0) ranked ten findings. Each was checked against the code at 5e38a73e; each
defect got its test at the cheapest layer, run first against that code (each failed there), then fixed. Nothing was
measured: no change touches a path the guest's I/O takes (the restore's disk phase takes its disks' locks in a pass
before the first `fresh` opening instead of one by one; a machine's start holds a shared Web Lock per stored disk
while it opens its disks; the check of a changes file unpacks only a compressed cluster the file's end cuts into).
No stored format changes; step counts don't move.

| # | the review's finding | outcome | test (failing first) | fix |
|---|---|---|---|---|
| 1 | High: a fork the page attached but the worker never opened (cut off in the check pass, the RAM's, before the start message) is not undone; the machine boots an empty disk | **defect** (confirmed) | `tests/template.test.ts` "a fork the restore attached but no fill opened is undone…" (failed: left on the fork) | `cutFork` (web/app/snapshot-undo.ts): a fork with `before` whose files are at generation 0 (never opened by its fill) or marked, its lock free; the undo runs under the machine's Web Lock, taken only if free, and the restore takes that lock before its commit (`Runner.own`; its start keeps it to the run's end), so its own reloads and another tab's loads leave a restore under way alone; `MachineLock.settled` lets a reload wait for the page's last run's lock to go; the refusal before any disk was written no longer opens with "Nothing was changed" (`notLoaded.cause`) |
| 2 | Medium: a replace into an earlier fork, cut off, sends the machine back to what that fork replaced (or to writing in place) and deletes the fork | **defect** (confirmed) | `tests/template.test.ts` "a replace into an earlier fork, cut off, leaves the machine on that fork…" (failed: back on the overlay from before the first restore) | `commitStep` drops the fork's `before` when a replace writes into it; `cutFork`'s doc states `before` holds only for the fork's own fill |
| 3 | Medium: Import changes hangs when the import worker can't open the base | **defect** (by reading: `openSource` outside the chain that posts failures) | `tests/changes.test.ts` "Import changes' worker posts the failure when the disk's base can't be opened…" (the worker module under a stubbed `self`: failed, a rejection and nothing posted) | the worker's whole job in one `try`: every failure is posted, the base closed before the answer |
| 4 | Medium-low: a restore of several disks empties the earlier ones before it has the later ones' locks | **defect** (confirmed in Node) | `tests/snapshot.test.ts` "a restore of several disks takes every disk's lock before it empties any…" (disk 1's lock held; once the restore waits on it, by `navigator.locks.query`, disk 0 was already emptied and marked) | the disk phase takes every target's lock first and hands each to its `fresh` opening (`openOverlay`'s `held`) |
| 5 | Low-medium (suspicious): a start in another tab during a merge opens the merged overlay as a new one, which the merge then forgets | **defect** (by reading; the Node test shows the start went ahead under a held merge lock) | `tests/stored.test.ts` "a machine whose stored disk a merge holds (another tab) is refused at once…" (failed: `Devices.open` opened) | `holdAgainstMerges` (web/stored.ts): `Devices.open` holds each stored disk's `mergeLock`, shared and only if free, until its disks are open; a merge under way refuses the start (`disk-merging`, said as `machine:worker-errors.diskMerging.cause`, Retry), and a merge asked for meanwhile waits and then finds the overlays in use |
| 6 | Low: `check` misses an L1 entry past the disk's end with its table past the file's end, and a file cut inside a compressed cluster | **two defects** (confirmed) | `tests/changes.test.ts` "a changes file whose spare L1 entries … loads" (a second L1 entry pointing past the end: failed, "L2 table past the end of the file" after the emptying) and "a changes file cut through a compressed cluster is refused by its check…" (qemu-img's compressed file cut 32 bytes into its last cluster: failed, passed `check`) | `blocks` skips L1 entries past the disk's end as `check` does; `check` (now async) unpacks a compressed cluster whose extent the file's end cuts into (in a whole file at most the last one or few) |
| 7 | Low: `notRestored.cause` reassures alike whether a disk was put back or emptied | **defect in the words** | `tests/snapshot.test.ts` "a restore refused part way says whether it emptied a disk's own overlay…" (failed: no `emptied`) | the plan marks a new fork (`DiskPlan`'s `fork`); a fill refused after it emptied an overlay that isn't a new fork carries `emptied`, and the page says `snapshots:worker-errors.notRestored.emptied` |
| 8 | Low: a marked overlay is shown, exported and merged as if it held its bytes | **defect** | `tests/merge.test.ts` "an overlay a restore was cut off in … isn't merged: nothing deleted" (failed: a blank disk converted, its other overlay deleted); `tests/stored.test.ts` "in Chromium (OPFS): a marked overlay's record says it holds nothing…" (Node has no OPFS sizes) | the merge refuses a marked overlay or a cut fork (`disks:merge.cutOff`) before it deletes anything; `refreshOverlay` records 0 bytes for a marked overlay. Export of one stays an empty file (it reads as empty) |
| 9 | Low: leftovers `dropCutFills` can't see; one failed entry stops the sweep | **the sweep: defect**; the leftovers: real, **nothing to fix** | `tests/stored.test.ts` "the sweep of cut-off fills goes on past an entry it can't remove…" (failed: the second entry left) | each entry in its own `try`, the first failure thrown at the end. A cut-off between a fill's opening and its mark leaves only empty files (the opening just made them; a new fork in that state is now undone as never filled): written into devices.md, not the backlog |
| 10 | Docs and copy | **real** | `tools/i18n-check.ts` | devices.md no longer says every fill opens `fresh` (an import's new store doesn't need to); machines.md §5.2 and devices.md "blk" say what the undo does now; `disks:merge.otherMerging` marks `<ui>Merge into the disk</ui>`; frontend.md "Loading changes" says what `check` checks |

**Planted bugs, each caught by its test:** `cutFork` without its generation-0 case; the replace keeping `before`; the
undo ignoring the machine's lock; `settled` resolving at the drop (the test now pins that it waits for the lock's
request to end: Node's Web Locks release before a query either way); the restore's locks not taken first; `emptied`
never set, and set for forks too; the worker's errors not choosing the `emptied` cause; the import worker opening the
base outside its `try`; `blocks` reading spare L1 tables; `check` not unpacking a cut compressed cluster; no merge hold
in `Devices.open`; the merge hold said as another tab's disk; the sweep stopping at a failure; the merge of a cut
overlay let through, and of a cut fork only; a marked overlay's bytes counted.

**A test that pinned the old state:** `tests/page-demos.test.ts` "started before says whether the machine has
changes…" took the stand-in worker's start (it fills nothing) as a disk that moved on: its fork left at generation 0
is now a restore cut off before its fill, undone at the next load. The test now leaves the fork as the worker and the
guest would (generation 2) before it asks, once the start reached the stand-in (by then the fork is recorded: its
first version wrote before the commit under `scripts/ci.sh`'s load and failed there once). Left in the backlog: a template's first start cut off before its fill
boots plain next time (`restoreFirst` is cleared before the start).

**CI:** `scripts/ci.sh` OK (706 s, after the demo test's two fixes above), `scripts/ci-machines.sh` OK (306 s),
`scripts/ci-debian.sh` OK (305 s).
