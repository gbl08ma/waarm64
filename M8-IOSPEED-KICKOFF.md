**Drafted 2026-10-04 from a code read of the disk path; nothing in it is measured yet.** Covers a
track of M8 phase C: **the speed of the disk path when the user loads a local image** (a chosen
`File`, always under an OPFS overlay). The HTTP source is out of scope. The decisions below are
proposals: the first loop's measurements settle most of them, and the ones marked **needs OK**
change what the guest sees and wait for the user.

Start the **disk I/O speed** track of M8. Read `docs/devices.md` ("blk"), `docs/abi.md` ("Device
backends"), `docs/platform.md` (realtime mode, deterministic mode), `docs/benchmarking.md`,
`docs/backlog.md` (the virtio and "virtio-blk off the device worker's thread" entries), and the
code: `web/devices.ts` (`blk`, `blobSource`, `Devices.poll`/`serve`, `gather`/`scatter`),
`web/overlay.ts`, `web/qcow2.ts`, `web/vcpu-worker.ts` (the `DEVICE` exit), `core/src/virtio.rs`
(`post`, `complete`, `walk_chain`, the rings), and the native twins in `core/tests/common`.
CLAUDE.md's conventions and working rules apply; `scripts/ci.sh` passes at every commit (plus
`ci-gfx.sh` for anything near the display, `ci-long.sh` for anything that touches the memory
model). Work in short loops (one slice, one commit, a short report each), settle choices by
measurement, and ask only what can't be measured.

## The path today (what the plan changes)

Guest read, with a chosen disk: the virtio-blk driver notifies over MMIO (a `DEVICE` exit) → the
core's `Transport::post` walks the chain into the request ring as `(offset, len)` segments → the
vCPU worker rings the doorbell (`ring`) → the one device worker wakes in `Devices.serve` and
`poll()`s **every** device → `blk.request` gathers the header, calls `overlay.read` → the overlay
allocates `out`, walks the range by 4 KiB blocks: blocks it holds are read from OPFS with a sync
access handle (**one call per block**), runs it doesn't hold go to `blobSource.read`
(`FileReaderSync.readAsArrayBuffer(file.slice(…))`: a blob read, then a copy into `out`) → `scatter`
copies `out` into guest RAM, **one `subarray` + `set` per guest segment** → `complete` writes the
completion ring and `kick`s the signal word and every vCPU's wake word → the core drains
completions at the next chunk boundary and raises the IRQ.

Guest write: the same trip; `gather` copies the guest data out; `overlay.write` loops over 4 KiB
blocks, and a **first write** to a block allocates 4 KiB, writes its slot, then writes a **4-byte
map entry in a second file** (a partial first write also reads the base block first); `FLUSH`
calls `data.flush()` and `mapFile.flush()` **unconditionally**.

The reference numbers that exist (`bench/boot/REPORT.md`, M4 and Ryzen, **HTTP source**: they do
not describe a chosen disk): fio 4 KiB random read 1778 IOPS (M4) / 601 (x86_64), 1 MiB O_DIRECT
sequential 322 / 140 MiB/s, `dd` 84.7 / 47.8 MiB/s. **No benchmark covers the chosen-`File` path
or writes.**

## Hypotheses (ranked by expected impact; none measured)

H1. **`FileReaderSync` per request, no cache or readahead.** A file-backed blob read is likely a
round trip to the browser process (hundreds of µs a call). Linux's readahead sends ~128 KiB
requests; firmware and bootloader reads (EDK2, GRUB loading the kernel and initrd) have no page
cache and run at queue depth 1, so they probably pay it most.

H2. **Serial, blocking I/O on a thread shared with net, gpu and input.** Effective queue depth is
1 whatever the guest queues; a long read stalls the screen's flushes (backlog: worst case ~1 s).

H3. **`FLUSH` always does two OPFS `flush()` calls**, even with nothing written. ext4 journal
commits and `fsync` flush often; OPFS `flush()` may be a real fsync (platform-dependent). In
deterministic mode the vCPU waits for it too.

H4. **The overlay isn't coalesced:** a 1 MiB read of written data is 256 `data.read`s; a 1 MiB
fresh write is ~256 data writes + ~256 map writes + 256 4 KiB allocations. `take()` hands out
consecutive slots, so consecutive fresh blocks could be one data write and one contiguous map
write. Whole-block overwrites still allocate and zero a block they don't need.

H5. **Copies and allocations:** a read is file → `ArrayBuffer` → `out` → RAM; a write is RAM →
`gather` buffer → OPFS; every request allocates a `len`-sized array; `scatter`/`gather` allocate
one `subarray` per 4 KiB segment (a 504 KiB request: ~126).

H6. **Round trip per request:** one exit, one doorbell wake of the device worker, one
completion, the IRQ at the next chunk boundary or a vCPU wake (~17 µs per `Atomics.wait` wake in
the dev VM); no `EVENT_IDX`; `serve` yields to a macrotask every 2 ms; `poll()` visits every
device and builds fresh views and segment arrays per request.

H7. **Request limits:** `seg_max` 126 caps requests at ~504 KiB unless pages merge; the request
ring (4096 words, ~256 per big request) holds ~16 such chains, the rest wait for a completion
round trip (`backlog`).

H8. **Local qcow2:** compressed clusters inflate one at a time, a new `DecompressionStream` each,
the whole cluster for a 4 KiB read, 16 cached. (Raw images avoid it; Debian's published image is
qcow2 and 95% compressed.)

## Loop 0: measure first (no behavior change)

The decisions below are worth nothing without numbers for the path that matters.

1. **A benchmark for a chosen disk.** In `bench/boot` (or a new `bench/io/` page, whichever
   matches how `fio`/`dd` are built there): the same fio and dd workloads on a **`File`-backed
   disk with an overlay** (Chromium's `FileReaderSync` needs a real `File`: Playwright's
   `setInputFiles`, or a `File` made from a served image, as the page tests do for the disk
   picker). Add: random 4 KiB read, sequential 128 KiB and 1 MiB read (buffered and O_DIRECT),
   **sequential write and random 4 KiB write with and without `fsync`** (`fio --fsync=1`,
   `dd conv=fsync`), reads of data the guest wrote earlier (overlay-held), and a boot-loader-like
   case (GRUB's kernel+initrd load time on the page's Debian through UEFI: the guest-visible
   time from the first disk request to the kernel's first output, from the serial log). Both a
   raw disk and the qcow2 Debian image. Realtime mode, medians and IQR per CLAUDE.md,
   `bench/results/local/` until a report is written.
2. **Per-stage timers in `blk.request`** (a debug flag, off by default and absent from the
   deterministic path's behavior): time in `FileReaderSync`, `data.read`, `data.write`,
   `mapFile.write`, `flush`, `scatter`/`gather`, and request count and size histograms; plus the
   gap between doorbell ring and `poll` start, and between `complete` and the IRQ (a counter in
   the signal path). Output as JSON next to the benchmark's.
3. **Report** (`bench/io/REPORT.md` or a section of `bench/boot/REPORT.md`) with the committed
   JSON: which of H1–H8 carry the time, per workload. Reorder or drop the loops below by it.
   Anything H-numbered that costs under ~5% of its workload is dropped (noise rule).

## Loops (order set by loop 0; each is guest-invisible unless marked)

### Loop 1: flush that costs nothing when clean (H3, write path)

- A dirty flag in the overlay: `flush()` calls `data.flush()` only if `data` was written since
  the last flush, `mapFile.flush()` only if `map` was. Discard/zero/compact set them too.
- Keep the ordering guarantees: a block's slot is flushed before its map entry is relied on after
  a crash (today both files are flushed on every `FLUSH`; keep "data then map").
- Measure `fsync`-heavy workloads (loop 0), and a **crash test**: kill the device worker (or the
  tab) between a guest write+flush and the next flush; reopen; every flushed write is there and no
  map entry points at an unwritten slot (a test over the in-memory `SyncFile` that fails writes
  and drops unflushed data, as the overlay's tests do for failed writes).
- Question to settle by measurement: whether `flush()` is worth issuing on every guest `FLUSH`
  at all vs. a short coalescing window (a guest flush must still mean durable: no window unless
  the user opts in; document the trade-off in `docs/devices.md` and do not default to it).

### Loop 2: a host-side chunk cache and readahead for `blobSource` (H1)

- A small read cache in front of `FileReaderSync`: aligned chunks (start at 256 KiB; settle
  chunk size, 1 to 4 MiB, by loop 0), a few kept (LRU, a fixed memory budget, ~16–64 MiB;
  count it against the page's memory story in `docs/frontend.md`), and sequential-read detection
  to read the next chunk ahead (a single prefetch, since the reads are synchronous: it pays only
  when issued while the vCPU is busy, so see loop 5).
- Requests larger than a chunk bypass the cache (one read straight into the destination).
- Invalidate nothing: the base is read-only and the file's identity is checked at open. (If the
  file changes underneath, `FileReaderSync` already throws; keep that error path.)
- Measure on: GRUB's initrd load, `dd` buffered, random 4 KiB reads over a cold and a warm
  region, and memory growth. Ship only if the boot-loader case or sequential reads gain >5%.

### Loop 3: coalesce the overlay's I/O (H4)

- **Reads:** merge runs of consecutive overlay-held blocks whose slots are consecutive into one
  `data.read` (the common case: data written sequentially). Combine with the existing base-run
  merge.
- **Writes:** for a range of whole blocks being first-written, take consecutive slots when
  `take()` can (free list empty or consecutive), write all of them in one `data.write`, then
  write the map entries as **one contiguous `mapFile.write`** (the map entries of consecutive
  blocks are contiguous in the file). Keep "slot before map entry".
- Whole-block overwrites of held blocks: write straight from the request buffer (no 4 KiB
  allocation); first writes of whole blocks need no zero-filled temporary either: write the
  request's bytes in place.
- Partial first writes keep the read-modify-write, but read the base block through the loop 2
  cache.
- Tests: the overlay's unit tests (random writes/reads/discards against an in-memory model,
  including failed writes mid-range, a crash between slot and map writes, ranges that straddle
  held, zero and base blocks); the page tests that write and re-read (`tests/uefi.test.ts`,
  `tests/trim.test.ts`). Plant a bug (map written before data) and check the crash test fails.

### Loop 4: fewer copies and allocations on the data path (H5, H6's per-request cost)

- Read: where the destination is a single contiguous guest segment, read from the overlay or
  cache directly into `ram.subarray(seg)` (the cache's chunk, or an OPFS read into the
  shared-memory view: **verify first that `FileSystemSyncAccessHandle.read` accepts a view on a
  `SharedArrayBuffer` in the pinned Chromium**; fall back to one staging buffer reused across
  requests if not). Never `new Uint8Array(len)` per request: a reused, growing scratch.
- `scatter`/`gather`: avoid the per-segment `subarray` allocation (index arithmetic with
  `ram.set(data.subarray(...))` only at segment boundaries that need it; merge adjacent segments
  in `Devices.poll` when `off+len === next.off`; the core could merge them when writing the ring:
  **ABI change → `ABI_VERSION` bump, docs/abi.md**, only if the TS merge doesn't capture it).
- `Devices.poll`: keep one `Uint32Array` view per `memory.buffer` (re-made on growth only), don't
  visit devices with an empty ring and no events (check the three words before allocating
  anything), build segment lists without `Array.from`/closures.
- Measure each separately (alternating A/B in one session, CLAUDE.md); keep only what clears 5%
  on the workloads that matter.

### Loop 5: blk off the device worker's thread, asynchronous reads (H2, backlog item)

The largest change, and the one that fixes the screen stalling behind disk reads and lets the
guest's queue depth matter. Do it only if loop 0 shows H2 (or H1 after loop 2) still dominates.

- **A dedicated blk worker** that owns the `File`, the overlay's sync access handles (they are
  worker-bound) and the cache. The device worker no longer touches it: blk requests it reads off
  the request ring go to the blk worker (a second doorbell + the same request/completion ring
  records, or a separate pair of rings per device: settle the shape in the first commit's
  design note; `docs/abi.md` "Device backends" says what already allows a backend to complete
  later).
- **Async reads where it helps:** `file.slice().arrayBuffer()` on the blk worker lets several
  reads be in flight (the browser reads the file on its own threads) while OPFS writes stay
  synchronous; completions may then return out of order: the core already completes chains by
  head and tracks `inflight`, and `Devices.poll` currently completes **in order** (keep that for
  deterministic mode, drop it for realtime mode).
- **Deterministic mode must not move:** the vCPU worker still `Atomics.wait`s on each `DEVICE`
  exit until everything posted is complete; every exact-step boot test keeps its count
  (`tests/steps.txt` must not change in this loop). The blk worker is realtime/async only if it
  can be made to give the same completion step; otherwise deterministic mode keeps today's
  in-device-worker path (a second implementation to keep tested: say so in `docs/devices.md`).
- Ordering rules: a `FLUSH` completes only after every earlier write is durable; a read of a
  block with a write in flight sees the write (serialize per-block, or just serialize reads
  behind writes); discards and zero-writes are barriers.
- Tests: a device-level test with many requests in flight and a randomised completion order
  against a model; the reset-epoch tests (a reset with requests in flight, the stale completion
  dropped); snapshots (`quiet` must wait for the blk worker; the overlay's handles hand over
  through the Web Lock exactly as before: `docs/frontend.md` "Overlay hand-over"); a stress test
  of screen-flush latency under a sequential read (the number in graphics.md §12 should drop from
  ~1 s locally to frame times).
- Natively nothing changes (the twins in `core/tests/common` stay as they are).

### Loop 6: queue and request limits, and notifications (H6, H7; guest-visible, needs OK)

- **Needs OK (guest-visible: the driver reads the new config, so every writable guest's step
  count moves once):** raise `seg_max` and/or offer `size_max` and a larger request ring so big
  requests aren't capped at ~504 KiB and deep queues of big chains don't wait on completions;
  offer `EVENT_IDX` (fewer notify exits and IRQs under load). Do each only if loop 0's counters
  show it (request-size histogram pinned at the cap; backlog events; notify exits per request
  above ~1).
- If done: bump `ABI_VERSION` if exports or layouts change, move `tests/steps.txt` once in that
  commit (user's OK first), update the native twin, `core/tests` virtio tests (`EVENT_IDX` needs
  the ring-suppression cases and the fuzzer: `cd core && cargo fuzz run virtqueue`), and
  `scripts/ci-long.sh`.
- The device worker's macrotask yield every 2 ms and the wake costs are only touched if loop 0
  shows them above noise.

### Loop 7: local qcow2 (H8)

- Inflate in parallel for requests spanning several compressed clusters (the web's pools exist:
  `web/app/deflate-pool.ts`; settle whether a worker pool or several concurrent
  `DecompressionStream`s on the blk worker wins), and a larger decompressed-cluster cache sized
  in bytes rather than 16 entries; readahead the next compressed cluster for sequential reads.
- Partial reads of a compressed cluster still inflate the whole cluster: the cache is what
  makes the next page read free; keep it LRU by bytes.
- Measure with the Debian image (95% compressed) booting through UEFI and `dd` of a file in it;
  also the case the user may prefer: **offer converting a chosen qcow2 to raw in OPFS** is *not*
  in this track (disk space and an import step; note it in the backlog if the numbers argue for
  it).

## Alternative to weigh in loop 0 (not a loop unless the numbers say so)

**Import the chosen image into OPFS once** and read it through sync access handles instead of
`FileReaderSync`: no blob IPC, reads into views directly, same handle type as the overlay. Cost:
a one-time copy (progress UI, quota, doubled disk space, a "disk changed on disk" story). Measure
an OPFS-resident base's reads against loop 2's cache before deciding; if the cache closes most of
the gap, do not do this.

## Exit criteria

- The loop-0 benchmark exists, is in `docs/benchmarking.md`'s table, and its before/after numbers
  for every shipped loop are committed JSON with medians, IQR, host and Chromium version, in one
  report; shipped loops are those that cleared 5% on a real workload (GRUB's kernel+initrd load,
  Debian's boot to login, `dd`/fio sequential and random, write+`fsync`), with no regression on
  the others.
- No guest-visible change without the user's OK; `tests/steps.txt` unchanged except in an
  approved loop 6 commit; exact-step boots, `ci-gfx.sh` (screen latency, loop 5) and
  `ci-long.sh` pass.
- The overlay's durability contract holds (a flushed write survives a crash; no map entry points
  at garbage): tested with planted bugs.
- Docs updated in the same commits: `docs/devices.md` (blk, overlay), `docs/abi.md` (anything
  that changes a layout), `docs/frontend.md` (memory budget, hand-over), `docs/benchmarking.md`,
  `docs/backlog.md` (the entries this track closes are removed; what it leaves is added),
  `PLAN.md` §3 M8 (this track's status). Delete this kickoff in the commit that finishes the
  track, and its handover with it.

## Risks

- **A cache or readahead that helps benchmarks and hurts real use** (memory, a stale view of a
  changing file): fixed budget, read-only base, measured on Debian's boot rather than only fio.
- **Async completions vs. deterministic mode:** the whole track is judged by `tests/steps.txt`
  not moving; loop 5 keeps a deterministic path if it must.
- **Durability regressions from "optimizing" flush and map writes:** loops 1 and 3 each carry a
  crash test with a planted bug.
- **Browser behavior not in the docs I read** (OPFS `flush()` cost, shared views in sync-handle
  reads, `FileReaderSync` cost per call): each is an explicit loop-0 or loop-4 measurement, not
  an assumption.
