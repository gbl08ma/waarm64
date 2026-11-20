# Static review: VM, workers, storage, snapshots (web/*.ts slice)

Scope: `web/vm.ts`, `web/devices.ts`, the device, vCPU and compile workers, overlay/qcow2/blockcache/diskcache/chunked,
stored, ramdisk, snapshot*, 9p*, balloon, offload, inflate-pool and the small helpers. Static reading only (nothing run).
Confidence: **confirmed** means I traced the code path end to end; **plausible** means the code does what I say, but
whether it matters depends on timing or on a browser behavior I didn't check.

---

## 1. Defects

### D1. A failed `bootVm` leaks the device worker and its open overlays, and the resume fallback then can't open the disk (confirmed path; high)
- `web/vm.ts:1807-1850` (`deviceHost`, worker path): when `ready` rejects (the worker posted `error`), nothing terminates
  `worker`. `web/device-worker.ts:58`: `start()` fails, posts `error`, and the worker stays alive.
- `web/devices.ts:1404-1432` (`Devices.open`): it opens every overlay first (`openOverlay`: an exclusive Web Lock plus
  sync access handles), then the sources, then `new Devices(...)`. If a source fails (an HTTP 404, offline) or the
  constructor throws (`state.length !== specs.length` at :1335, or a backend's `restore` throws: rng :408,
  snd.ts:186/566/883, gpu.ts:1064), the overlays that were opened are never closed. The lock is held by a `held`
  promise that never settles.
- `web/vm.ts:1017-1020`: after `deviceHost` succeeds, a failing `devices.quiesce()` on a restore (a backend throws on a
  re-posted chain, so `bell[1] = -1`) throws out of `boot()` without `devices.close()`.
- **Scenario:** a suspended machine is resumed and a backend's `restore` throws. For example, the page was updated
  between the suspend and the resume, so a backend's saved JSON has another shape while `coreVersion` hasn't changed.
  `web/app/worker.ts:257,262` then calls `bootInstead()`, which runs `start()` again **in the same machine worker**. The
  new `Devices.open` calls `openOverlay` on the same overlay, `lockOverlay` waits `OVERLAY_WAIT_MS` (10 s) for the
  orphaned device worker, and the start fails with "overlay … is in use". The machine can't start until the page closes
  that machine worker. The guest RAM stays reachable too: the orphaned worker keeps the shared memory alive.
- **Fix:**
  - In `Devices.open`, wrap everything after the overlays in try/catch, and on failure close the opened overlays and
    sources.
  - In `deviceHost`, `ready.catch(() => worker.terminate())`.
  - In `boot()`, put the work after `deviceHost` in try/catch that calls `devices.close()`, and `par?.close()` once the
    coordinator exists.

### D2. After `ready`, the device worker's error is lost, so "device backends failed (see their error)" has no error to see (confirmed; medium)
- `web/vm.ts:1832`: an `error` message only calls `reject` on the `ready` promise, which has already resolved, so the
  error is dropped. That message is how `web/device-worker.ts:58` reports `serve()` throwing, which is any backend
  throwing in `poll` (`devices.ts:1577-1583`).
- At the same moment `bell[1]` becomes -1, and the vCPU (`ring`, `devices.ts:1192`) or `ringAsync` (`vm.ts:1739`)
  throws `device backends failed (see their error)`. The real exception (its message, stack and wire error) never
  reaches the page or the logs. The inline parallel path keeps it (`failed`, vm.ts:1758-1765); the worker path doesn't.
- **Fix:** after `ready`, store the posted error in a `failed` variable. Have `settle`, `flush`, `quiesce` and the
  pending `save`, `ask` and `drained` waiters reject with it.

### D3. Remote disk fetches have no timeout: one stalled connection can hang the guest's I/O and every pause or snapshot (plausible; medium)
- `web/devices.ts:817-825` (`httpSource.readAsync`) and `web/chunked.ts:111-121` (`readPieceAsync`) call `fetch` with
  no `AbortSignal`.
- `web/blockcache.ts:116-132`: a fetch holds one of the 8 `MAX_FETCHES` slots until it settles.
- `Devices.drain` (`devices.ts:1397-1400`) waits for every detached request. Its callers have no bound:
  `quiesce`/`drain` (vm.ts:1856-1862), `doPause`'s `c.quiesce()` (vm.ts:1519), round-robin `pause` (vm.ts:1399) and
  `snapshot()`'s `await devices.quiesce()` (vm.ts:1152). The `QUIET_MS` bound covers only the loop's checks, not these
  awaits.
- **Scenario:** a realtime machine on a remote (or chunked) image loses its network mid-read and the TCP connection
  stalls without an error for a long time (Chromium has no fetch timeout of its own). The guest's reads queue behind the
  stuck slots. If the user clicks Snapshot or Suspend, the machine pauses and the save waits indefinitely, with the guest
  frozen.
- **Fix:** give each remote fetch `AbortSignal.timeout(…)`; the read then returns undefined, the guest gets IOERR and
  retries. Optionally bound the quiesce wait and refuse the save with a message.

### D4. `saveFlash` truncates the variable store before rewriting it and doesn't check the write (confirmed; low-medium)
- `web/overlay.ts:1170-1178`: `h.truncate(0); h.write(bytes, {at: 0}); h.flush()`. The returned count isn't checked and
  `QuotaExceededError` isn't caught.
- **Scenario:** storage is near its quota. The 1 MiB file is truncated (its space released), and the re-grow is refused
  or comes back short. Or the tab dies between the truncate and the write. Either way the firmware variable store is
  empty or partial, `loadFlash` reads an empty file as "none", and the UEFI boot entries are gone. A guest that relies on
  NVRAM entries rather than the removable path then doesn't boot.
- **Fix:** write in place at offset 0, check the count, then `truncate(bytes.length)` and flush. Better still, write a
  `flash.new` and move it over the old file.

### D5. `deviceHost`'s `save` and `flush` keep one callback each: a second call strands the first (confirmed; low)
- `web/vm.ts:1808,1811,1865-1868,1884-1887`: `saved = …` and `flushed = …` are overwritten on each call. `drained` and
  `refusals` are FIFO queues; these two aren't.
- **Scenario:** two overlapping `deviceState()`/`snapshot()` calls (a test tool polling `deviceState` while a save
  runs), or two `flush()` calls (runToPowerOff's end racing a page stop). The first promise never settles.
- **Fix:** make them FIFO queues like `drained`, or move them to the id-keyed `ask`.

### D6. A remote image's cached blocks keep whole fetch buffers alive, so the 256 MiB cache can hold much more (plausible; medium)
- `web/blockcache.ts:76-79`: each kept block is `bytes.subarray(…)` of one multi-block response.
  - `fetchAsync` and `fetch` read whole runs: up to 8 blocks from the prefetch.
  - `widen` grows a read to a chunked image's full piece, `n × 1 MiB` (`chunked.ts:143`).
- LRU eviction drops the `Map` entry. The buffer stays alive while any sibling block survives.
- **Scenario:** a guest touches one block of each fetched run again, such as the qcow2 L2 tables or filesystem
  metadata at the start of many runs. The survivors pin up to 8x (or piece/block times) the budgeted bytes, which is
  GiBs at worst in the device worker.
- **Fix:** `slice()` each block when `b > a` (one copy per fetched MiB, which is cheap next to the network).

### D7. qcow2 caches a zeroed 64 KiB L2 table for every unallocated L1 entry a read touches (confirmed; low-medium)
- `web/qcow2.ts:244-253`: `off === 0 ? new Uint8Array(cs)` is stored in `l2s` for good.
- **Scenario:** a large, mostly unallocated qcow2 (a 1 TiB virtual disk) that the guest reads across: `fsck`,
  `dd if=/dev/vda`, an mdadm or LVM scan. Each 512 MiB of unallocated range costs 64 KiB that is never freed: 128 MiB
  for 1 TiB at 64 KiB clusters.
- **Fix:** one shared all-zero `DataView` for unallocated tables, or don't cache them (`allocationOver` already treats
  `!hasTable(t)` as known).

### D8. Smaller items (confirmed by reading; low)
- **`web/inflate-pool.ts:263,273-276`:** if `close()` runs while `coreModule()` is still resolving, `start(m)` runs
  afterwards and creates workers that are never terminated (`started` was empty at close).
- **`web/stored.ts:103,108,113`:** `qcow2Allocated` builds `new DataView(x.buffer)` and ignores `byteOffset`. It works
  only because every current source returns fresh arrays (`chunkedSource.read` copies, `blobSource` does too). A source
  that returns a subarray, such as `cachedSource` with a future pass-through, would read the wrong bytes. Use
  `new DataView(x.buffer, x.byteOffset, x.byteLength)`, or reuse `openDisk`'s parser (Q4).
- **`web/diskcache.ts:278`:** a map entry dropped at open ("a slot claimed twice", or past a smaller budget) is zeroed
  only in memory. The stale file entry stays. If that slot is later reused, the next session can map the stale block to
  the new block's bytes (the first claimant in block order wins). It needs pre-existing damage, but the fix is cheap:
  write the zeroed entries back at open.

---

## 2. Performance

Ordered by the gain I expect in real workloads.

### P1. `Devices.serve` adds a macrotask hop to every doorbell that follows a quiet spell of more than 2 ms (confirmed; per DEVICE exit)
- `web/devices.ts:1562-1574`: `since` is reset only after a `macrotask()`, never after the `waitAsync` sleep. So the
  first iteration after the backends slept more than 2 ms always posts and awaits a MessageChannel round trip before
  polling. `waitAsync`'s resolution already arrives as a task, so the event loop has already had its turn.
- In deterministic mode the vCPU is blocked in `ring(bell, true)` during that hop. Every widely spaced blk, net or 9p
  request pays one extra task hop, tens of µs, and boots have tens of thousands of them.
- **Fix:** set `since = performance.now()` after an `await w.value` that actually waited. Measure with the Buildroot
  and Alpine boots (deterministic) and a realtime fio run.

### P2. Every completion calls `kick()`: N wake notifies plus 2N+1 new typed arrays (confirmed; per completed request)
- `web/devices.ts:1510-1533`: `complete()` calls `kick()`, which does `Atomics.or`/`notify` on the signal word, then
  allocates an `Int32Array` per stop word and per wake word and calls `Atomics.add`/`notify` on each vCPU.
- `net.deliver` (devices.ts:501-507) completes `n` merged buffers per frame. A concurrent blk completes many requests
  per poll.
- With 4 vCPUs, an RX burst of 1000 frames/s is about 12k futex notifies/s and 36k small allocations.
- **Fix:** coalesce. Mark the device bit and kick once at the end of `poll`, or once per microtask (`queueMicrotask`),
  for completions outside `poll`. Cache the `Int32Array` views (the memory is fixed-size, or rebuild them when
  `memory.buffer` changes).

### P3. Disk reads copy the data three or four times between the source and guest RAM (confirmed; per blk read)
- A remote qcow2 read under an overlay copies at each layer:
  1. `cachedSource.assemble` (blockcache.ts:236-245) into a new `out`
  2. `openDisk.read` (qcow2.ts:345-350) into a new `out`
  3. `overlay.read` (overlay.ts:628,643-645) into a new `out`
  4. `scatter` into RAM (devices.ts:981)
- A local image or OPFS read still does steps 2 to 4.
- **Fixes, cheapest first:**
  - In `overlay.read`, return the base's buffer as is when one base run covers the whole request (`pos === off && end === stop`).
  - Same in `grown()`.
  - In `openDisk.read` for raw images, it already passes through; for qcow2, when a single data range covers the
    request, return `from(...)` directly.
  - `assemble` can return the cached block's subarray when the read lies inside one block.
  - Plausible further step: OPFS's `SyncAccessHandle.read` takes `AllowSharedBufferSource`, so an overlay hit could read
    straight into the guest's segments. That needs a `readInto` path through the `Disk` type.
- This is the boot path's hot loop. Expect a few percent of device-worker CPU during I/O-heavy phases; the bench/io
  suite would show it.

### P4. RX checksums are computed twice for every frame that isn't merged (confirmed; per received frame)
- `web/offload.ts:251-276`: `mergeable(frames[i])` calls `checksumValid` (the full payload sum). When the run stays
  below 2, `checksumValid(frames[i])` runs again for `DATA_VALID`.
- The frame that ends a run is also checked in the inner loop (`mergeable(frames[j])`), then again as the next `first`.
- That covers every UDP datagram, every TCP segment not coalesced, and every boundary frame: about 2x the
  checksum cost on RX.
- **Fix:** carry the `Segment` or a `valid` flag from `mergeable` into the single-frame branch and the next iteration.
  Also, `follows` (offload.ts:226-233) allocates a `skip` array and calls `includes` per header byte, per pair; compare
  the fixed ranges directly.

### P5. Merging an overlay into a stored disk writes, and flushes, one 4 KiB block at a time (confirmed; cold but long)
- `web/stored.ts:173-179`: `copyIn` calls `store.write(at, changes.block(b))` per block. The store is an `ordered`
  overlay, so each first write is a data write, a `data.flush()` and a map write (overlay.ts:708-727), and
  `changes.block(b)` is another OPFS read.
- A 2 GiB overlay is about 512k blocks, so about 1.5M OPFS calls and 512k flushes, which is minutes at the measured
  0.3 ms/call and 0.15 ms/flush.
- **Fix:** batch runs of consecutive blocks, as `readSnapshot`'s DISK path does with `diskRuns`. Use
  `changes.blocks(list)` (one read per slot run) and write each run with a single `store.write`; zero runs go through
  one `store.zero`.

### P6. A ramdisk's `written()` is computed twice per snapshot and checks bytes through a closure (confirmed; cold, seconds)
- `web/overlay.ts:115-120` (`blockList`) walks `d.written()` twice (`countOf`, then the fill). For a ramdisk,
  `written()` (ramdisk.ts:168-174) scans every held chunk byte by byte with `.some((x) => x !== 0)`, so the scan runs
  twice.
- A 4 GiB swap ramdisk whose chunks are present but mostly zero is about 8G closure calls per snapshot or suspend.
- **Fix:** have `blockList` take an array when `written()` returns one. Scan with a `Uint32Array`/`BigUint64Array` the
  way `zeroPage` in snapshot-file.ts does.
- The same byte-closure scan is in `importImage` (stored.ts:81, every block of an import), where it costs tens of
  seconds over a 20 GB raw image.

### P7. Each 9p message makes needless copies and allocates per field (confirmed; per 9p request)
- `web/9p.ts:825,834`: `gather` already returns a fresh buffer, and `m.slice(0, size)` copies it again; a `subarray`
  is enough. A Twrite of 1 MiB is copied twice before the tree sees it.
- An Rread (9p.ts:626-633) copies the payload into a `Writer` that grows from 256 bytes, then `scatter` copies it into
  RAM. The header and the payload could be scattered separately.
- `Writer.u16`/`u32`/`u64` (9p.ts:131-133) and `finish` allocate a `DataView` per field. Keep one per buffer and
  rebuild it in `room()`.
- Shared-folder throughput is mostly bound by OPFS and the host API, so the gain is modest: GC pressure on large copies.

### P8. Allocations on per-exit and per-run paths (confirmed; low)
- **`web/vcpu-worker.ts:238`:** `new BigUint64Array(mem.buffer, info, 9)` on every exit, though with a fixed memory the
  buffer never changes. Cache the view and rebuild it when `mem.buffer.byteLength` changes.
- **`web/vm.ts:1321,1327,1342`:** the same per `run()` exit, plus `[...info.subarray(3)]`.
- **`web/vm.ts:1038-1047`:** `drain()` pushes each console byte into a `number[]`. Copy the ring's one or two spans
  with `subarray().slice()`.
- **`web/devices.ts:1276`:** `ctx.ram()` allocates an array and a view on every call, several times per request. Cache
  it per `memory.buffer`.
- **`web/devices.ts:497-499`:** `net.deliver` builds a fresh `total`-byte buffer per frame to put `hdr` before `frame`,
  and `rx.slice(0, n).reduce` per frame. Scatter the header and the frame separately.
- **`web/vm.ts:443-446`:** each JIT install calls `WebAssembly.Module.imports(module)`, spreads `imports` and calls
  `Object.keys(f)`. This is negligible next to compiling, under 1%; listed only for completeness.

### P9. The snapshot writer copies disk blocks twice (confirmed; cold)
- `web/snapshot-file.ts:563` copies each block (`data.slice()`), then `flush` copies the run again into `raw`
  (:554-556). `writeSnapshot` already gets fresh, contiguous 256-block batches from `vm.diskBlocks`.
- **Fix:** accept a run view: one copy at most, none when a batch is one run. A large overlay saves about 2x its size
  in memcpy and allocation.

### P10. Each blk device creates its own inflate pool (plausible; memory)
- `web/devices.ts:926`: `inflatePool()` is created per blk device, each up to 4 workers (started at the first
  multi-cluster compressed read). Three compressed qcow2 disks can mean 12 inflate workers.
- **Fix:** one pool per device worker.

---

## 3. Code quality and architecture

### Q1. `web/vm.ts` (1900 lines) has clear seams for splitting
1. **The core instance's plumbing → `core.ts`:** `coreImports`, `stallHook`, `compileCore`, `exactCore`,
   `memoryLimits`, `unsigned`, `POINTERS`, `panicMessage`, `panicNote`, `withPanic`, `threadAlloc`,
   `instantiateThread`, `clockOffset`. `vcpu-worker.ts` imports these today, which pulls all of `vm.ts` into each
   vCPU worker.
2. **`jitHost` and its constants → `jit-host.ts`.**
3. **`Counter`, `stats`, `helperReport` → `counters.ts`.**
4. **Test and benchmark fixtures → their own module:** `guestDevices`, `testDevices`, `KEY_EVENTS`, `TABLET_EVENTS`,
   `CONSOLE_INPUT*`, `GUEST_CMDLINE`, `DISTROS`. They now ship in the page's bundle.
5. **`coordinator` (parallel SMP) → `coordinator.ts`.**
6. **`deviceHost`, `ringAsync`, `usbHost` → `device-host.ts`.**
7. **The console rings (`drain`, `pump`, `send`, `queued`) → a small class.**
8. **`runToPowerOff` → beside `runThroughSnapshots`.**

`boot()` itself is about 560 lines and returns a 40-member object literal; it would shrink to layout, the VmConfig and
assembly.

### Q2. The VmConfig is written as one 36-element positional array
- `web/vm.ts:953-959`: an ABI change has to land at exactly the right index of a `BigUint64Array.set([...])`, with the
  meaning only in trailing comments.
- **Fix:** an encoder keyed by field name, with each field's word offset next to the ABI number:
  `const CFG = { ramSize: 0, deterministic: 1, …, fma: 35 }`. Then `tests/core-wasm.test.ts` can check it against the
  core's layout.

### Q3. The three `deviceHost` variants repeat the same eight delegations
- `web/vm.ts:1762-1782` and `1791-1805` repeat `save`/`refusal`/`written`/`blocks`/`compact`/`inspect`/`hint`/`release`
  word for word; the worker variant differs only in transport.
- **Fix:**
  - Build the common part once from a `Devices`, and override only `kick`/`inFlight`/`settle`/`quiesce`/`close`.
  - On the worker side, give every `ToDeviceWorker` request an id. `save`, `flush`, `drain` and `refusal` are matched
    by arrival order today, with two different mechanisms (D5); one id-keyed `ask` serves them all.

### Q4. One qcow2 header is parsed and validated in four places
- `openDisk` (qcow2.ts:180-208), `readAllocation` (:110-121), `readChanges` (:404-417) and `qcow2Allocated`
  (stored.ts:102-120) each read the version, cluster bits, L1 size and offset, and the incompatible features, with
  slightly different refusals.
- The compressed-cluster extent math is written three times: `allocationOver.host` :97-101, `extent` :265-269 and
  `compressedCluster` :366-373.
- **Fix:** one `parseHeader(head): {version, clusterBits, size, l1Size, l1Offset, …} | refusal` and one `extent(e, bits, fileSize)`.

### Q5. `web/devices.ts` (1591 lines) can split by backend and by source
- **Backends → their own modules:** `blk` (with `blkInspector`, `liveImage`, `rangesOfRequest`, about 300 lines),
  `net` (with the flap and hold logic), `input` (with `inputConfig`, `trimInput`), and console, rng and clock.
- **Sources → `sources.ts`:** `httpSource`, `remoteSource`, `reblock`, `blobSource`, `fileSource`, `zeroSource`.
- **What stays:** the `Devices` class and the specs and types.
- **`blk()` takes ten positional parameters** (devices.ts:912: `discard, st, serial, concurrent, onFull, size,
  diskSize`). Use an options object.
- **Its request handler** computes `op` at :976, then compares `h.byteLength === 16 && h.getUint32(0, true) === X`
  five more times (:979-999). Switch on `op` instead.
- **Its wrapper chain** (stats → concurrent → compaction → inspector, each replacing `backend.request`, :1044-1095) has
  an order that matters and is explained only in a comment (:1124-1126). Composing it explicitly would make that order
  part of the code: `request = inspect(compactGuard(concurrent(stats(base))))`.

### Q6. Doc comments that describe the wrong thing (confirmed)
- **`web/vm.ts`:**
  - :751 `/** Their kernel command line. */` sits above `helperReport`; it belongs to `GUEST_CMDLINE` at :764.
  - :1136 documents a member that doesn't exist: "Moves a suspended guest's clock on by `ms`".
  - :1217 documents `Devices.save` but sits on `deviceStatus`.
  - :1229-1234 documents the heap scan (`heapUse`) but sits above `hostUse`.
- **`web/devices.ts`:**
  - :306-310 (`Backend`'s doc) sits above `CLOSE_MS`.
  - :898-904 is a second, stale doc on `blk` that is stacked above the current one.
  - :1402-1403 stacks two docs on `open`.

### Q7. Exports used only by tests, and small inconsistencies
- **`diskBlocks`** (snapshot-file.ts:279) is used only by tests and bench, beside `diskRuns`, which the restore uses.
- **`zeroSource`** (devices.ts:880) and **`zeroDisk`** (stored.ts:18) are the same "reads as zeros" object for two
  types.
- **`grown`** (overlay.ts:169) and the stored-disk "grown" handling both pad with zeros. Consider one `Source → Disk`
  adapter.
- **`Devices.close`** doesn't call `flush`. The worker path drains first (device-worker.ts:116), but the inline paths
  (`vm.ts:1776-1781`, `1804`) don't, so a shared folder's write session isn't landed by an inline close. It is minor
  because folders are page-only, but the two close paths differ.
- **`deviceHost` (worker path)** reaches its `closing`/`closed` state through four separate variables. A small state
  machine (`'open' | 'closing' | 'closed'`) would state the invariant.

### Q8. Types that could state invariants
- `Restore.fill`'s `spill?: Uint8Array[]` and `VmState.host.devices: unknown[]` could carry a branded per-backend state
  type, so a mismatch is a type error at the producer, not a `restore` throw at load (the D1 trigger).
- `ToDeviceWorker`/`FromDeviceWorker` could be a `Request<T>`/`Response<T>` map keyed by type: `ask`'s answer is
  `DiskAnswer` with every field optional, and its callers dereference with `!`
  (`(await ask(...)).bytes!`, vm.ts:1876).
