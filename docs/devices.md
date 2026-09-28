# virtio devices and host backends

How guest I/O works, as built: virtio-mmio transports in the core, backends in TypeScript in a
device worker (twinned in Rust for the native runners), and the display and input glue on the
page. The ring and record layouts are in [abi.md](abi.md) "Device backends".

## The split between core and host

- **In the core** (`core/src/virtio.rs`, on the vCPU thread): virtio-mmio v2 transports (magic,
  version 2, device and vendor ID `WBPC`, feature select and negotiation with `FEATURES_OK`
  refused unless `VERSION_1` is accepted and nothing unoffered is, queue select/size/ready/
  addresses, notify, InterruptStatus/ACK, status and reset, ConfigGeneration 0, SHM regions
  absent, config space 8/16/32/64-bit), and **split virtqueues** with indirect descriptors and
  `VIRTQ_AVAIL_F_NO_INTERRUPT`, no `EVENT_IDX`. Our own split-ring code, not rust-vmm's
  `virtio-queue`.
- On a queue notify the core walks the new descriptor chains, checks each buffer lies in RAM,
  and writes it as a flat segment list to the device's **request ring** in shared memory.
  **TypeScript never parses virtio rings**, only the device protocol (e.g. the virtio-blk
  header). A malformed chain, a buffer outside RAM, a readable buffer after a writable one, more
  chains than the queue holds or an available index more than a queue ahead puts the device in
  NEEDS_RESET.
- **Notify = exit:** the core returns the `DEVICE` exit; the vCPU worker rings the device worker's
  doorbell and waits or resumes (below). One path for native and wasm.
- **Completions → IRQs:** the backend writes guest buffers directly, appends {queue, head, bytes
  written} to the completion ring, sets signal bit `SIGNAL_DEVICE` and `Atomics.notify`s. At the
  next chunk boundary the core drains completion rings, fills used rings, sets InterruptStatus
  and drives the transport's line.
- **Reset epochs:** records carry the transport's reset count (mod 256); the backend skips stale
  records and the core drops their completions, so a reset never lets a stale request complete
  into a reused ring. (In realtime mode a backend can still write a buffer just after a reset, as
  DMA can on hardware; deterministic mode waits, so it can't happen there.)
- **Chains that don't fit the request ring** stay available and are posted after the next
  completions.

## Threads and determinism

- **One device worker per VM** (`web/device-worker.ts`) holds every backend: OPFS synchronous
  access handles exist only in workers, and the main thread can't block. The main thread keeps
  UI, canvas and input and forwards events to it through `MessagePort`s (transferred with the
  device specs, `specPorts`).
- Doorbell: a pair of i32s in the host's scratch page; word 0 rung by the vCPU
  (`Atomics.notify`), word 1 the last value the device worker handled (`Devices.serve`). In
  parallel SMP every vCPU worker rings it (`ring`: a waiter compares with wrap-around, since the
  handled value may pass its own ring), Node serves it inline between the coordinator's awaits,
  and completions also bump and notify every vCPU's wake word (`DevicesInit.wakes`).
- **Deterministic mode:** the vCPU worker `Atomics.wait`s on each `DEVICE` exit until the device
  worker has completed everything posted, so completions land at a fixed step and boots keep one
  exact step count natively, in Node and in Chromium (backend latency only lengthens the wait).
  Asynchronous backends (qcow2 decompression) may answer with a promise; `Devices.poll` completes
  requests in order and the doorbell is acked only after all of them.
- **Realtime mode:** `DEVICE` exits don't wait (except config events, below); the vCPU idles on
  the signal word.
- **Where the thread can't block** (Node, a page's main thread) the same `Devices` class runs
  inline: `run` returns a `DEVICE` exit while asynchronous requests are in flight and the caller
  awaits `settle()`, so completions still land at the same step. The bench pages run their suites
  in a worker, so they use the device worker.
- Native twins of every backend live in `core/tests/common` (`p9.rs`, `qcow2.rs`, the overlay,
  net loopback, input agent), so native boots give the guest the same bytes.

## Configuration

- `VmConfig.devices`/`ndevices` point at up to 32 `DeviceEntry`s (device ID, offered features,
  queue count ≤ 8, QueueNumMax ≤ 1024, config length ≤ 256); index = transport slot, one DT node
  each, in slot order (QEMU fills from the top of its window; we fill from slot 0).
- Host side: `{devices: [{type: 'blk', url, overlay?}, {type: 'net', adapter}, …]}`
  (`web/vm.ts` `DeviceSpec`; `guestDevices` and `testDevices` build the tests' sets).

## Devices

### console and rng
virtio-console: TX to the host, receive buffers held (no host input path: console input goes to
the PL011, [platform.md](platform.md) "PL011"). virtio-rng:
`crypto.getRandomValues` in the browser's realtime mode; **splitmix64 seeded 0** in deterministic
mode (and natively in realtime mode: std has no CSPRNG).

### blk (ID 2)
- Features `SEG_MAX` = 126, `RO` (or `FLUSH` with an overlay); one queue of 128. `IN`, `GET_ID`,
  `OUT` and `FLUSH` with an overlay (`IOERR` without), the rest `UNSUPP`.
- **Over HTTP** in the browser: one **synchronous XHR range request** per request (needs a worker:
  no binary sync XHR on a page's main thread, no XHR in Node, where `file:` URLs read with
  `node:fs`). `tools/serve.ts` answers single `Range: bytes=` requests (206/416, `Accept-Ranges`,
  HEAD). No cache, merging or concurrency: the guest's page cache is the only cache, and the
  per-request XHR dominates random reads (fio 4 KiB random reads ~1,800 IOPS on the M4).
- **qcow2** v2/v3 (`web/qcow2.ts`, `core/tests/common/qcow2.rs`, detected by the magic): L1/L2,
  unallocated and zero-flag clusters as zeros, compressed clusters as raw deflate
  (`DecompressionStream('deflate-raw')`; `miniz_oxide` natively, a dev-dependency). Read-only
  (refcounts never read). **Refused at open:** encryption, backing files, external data files,
  extended L2, zstd, unknown incompatible features. Capacity is the virtual size. Debian's
  published image is 95% compressed clusters, which is why deflate is supported rather than
  converting the image. One host read per cluster, all L2 tables kept, the 16 most recent
  compressed clusters cached (1 natively).
- **Writable disks: a copy-on-write overlay** (`web/overlay.ts`) in an OPFS directory, 4 KiB
  blocks: `data` holds written blocks in first-write order, `map` a u32 per disk block (0 = base,
  n = slot n − 1), `base` the image's URL path and size (a mismatch refuses to open). A block's
  slot is written before its map entry, so a crash leaks a slot but never maps garbage. Opened
  with synchronous access handles (so deterministic mode stays exact) and closed on `close`.
  Natively, `Overlay` keeps 512-byte sectors in memory and can be shared by several boots. No
  DISCARD/WRITE_ZEROES, compaction, quota handling, content check of the base, or host API to
  reset/export an overlay yet (backlog).

### net (ID 1)
- **The host sees Ethernet frames only**; IP, DHCP, NAT and the rest live in the adapter, never in
  the emulator. Features `MAC` and `STATUS`, a receiveq and a transmitq of 256; MAC
  `52:54:00:12:34:56` by default, link always up. Each transmitted chain is one frame with the
  12-byte `virtio_net_hdr_v1` stripped (≤ 12 bytes, or over 12 + 1518, dropped). Frames for the
  guest wait for receive buffers (the oldest dropped past 256; one larger than the next buffer
  dropped) and get a zero header with `num_buffers` 1. No offloads, no `CTRL_VQ`, one queue pair.
- **Adapters** (`web/net.ts`): `NetAdapter = {send(frame), close?()}`, made with the
  `receive(frame)` it calls. `{adapter: 'loopback'}` runs the **loopback test adapter** in the
  device worker: it plays 10.0.2.2 at `52:55:0a:00:02:02` and answers ARP and ICMP echo
  synchronously (a TX's replies complete before the doorbell is acked, so deterministic mode
  stays exact). `{adapter: port}` puts the adapter on the page behind a `MessagePort`, one frame
  per transferred `ArrayBuffer`; such frames arrive whenever they arrive (realtime behavior).
  `v86Bus(port)` is a v86-compatible shim that [plans/networking.md](plans/networking.md) drops.

### 9p (ID 9)
- **Our own `9P2000.L` server** (`web/9p.ts`, twin `core/tests/common/p9.rs`), **not a port of
  v86's**: v86's `lib/9p.js` is built on its large `FS` inode store, and the native runner needs a
  Rust twin anyway; ours was written from the protocol as Linux's v9fs speaks it (v86 and TinyEMU
  read as references, no code copied).
- Feature `MOUNT_TAG`, one queue of 128. One T-message per chain, the R-message into the writable
  buffers (Linux's zero-copy split is undone by concatenation). Messages: version (msize ≤ 1 MiB),
  attach, walk, lopen, lcreate, read, write, readdir (with `.`/`..`; offsets are entry indices),
  getattr, setattr, mkdir, symlink, mknod, readlink, link, renameat, unlinkat, remove, clunk,
  flush, fsync, statfs, lock (always granted), getlock (always unlocked); xattrs and the rest
  `EOPNOTSUPP`, malformed messages `EINVAL`.
- **An in-memory tree** seeded from the spec (`{type: '9p', tag, files: {path: text}}`); qid paths
  in creation order; in deterministic mode every timestamp is 2026-09-01, so native and Chromium
  boots see the same bytes. `qid.version` is always 0 (only `cache=none` is coherent);
  whole-second timestamps.

### input (ID 18)
- `{type: 'input', kind: 'keyboard' | 'tablet', port?}`; eventq and statusq of 64. The keyboard has
  keys 1–248, the Num/Caps/Scroll Lock LEDs and `EV_REP`; the tablet `BTN_LEFT/RIGHT/MIDDLE`,
  `REL_WHEEL` and `ABS_X/Y` over 0–32767.
- **A config write (`select`/`subsel`) is a `DEVICE` exit that waits for the device worker even
  in realtime mode**: the driver reads `size` right after.
- Events come from the port as [type, code, value] arrays (`web/input.ts` `attachInput` makes
  them from DOM keyboard, pointer and wheel events, keys by `KeyboardEvent.code`, a US PC
  layout); they wait for event buffers (oldest dropped past 1024). LED status events go to the
  port. No pointer lock or multitouch.

### Framebuffer (`simple-framebuffer`)
- `VmConfig.fb_width`/`fb_height` (0: none). x8r8g8b8, packed rows (stride 4 × width), in guest
  RAM in whole 2 MiB units just below the DTB's 2 MiB (`boot::framebuffer`; at most half of RAM).
  The DT has `/chosen/framebuffer@…` and reserves the region under `/reserved-memory` with
  `no-map`. `vm_framebuffer(vm)` returns its PA.
- `web/display.ts` converts the whole buffer into an opaque `ImageData` on every animation frame
  and puts it on a `<canvas>` (no dirty tracking, fixed size, no mode setting). virtio-gpu is the
  next display step ([plans/graphics.md](plans/graphics.md)).
- The Buildroot test kernel has no fbcon (drawing the boot log would cost the boot test).

## Validation and oracles

Unit tests on hand-built rings (`core/src/virtio/tests.rs`: 13 malformed shapes, each ending in
NEEDS_RESET), `cargo fuzz run virtqueue`, Node tests of the 9p server, loopback adapter, input
config, overlay and qcow2, and the guests' device scripts natively, in Node and in Chromium
([testing.md](testing.md)). QEMU TCG (`virtio-*-device`, `-netdev user`, `-fsdev local`) runs the
same device scripts to the same output, up to the framebuffer (`virt` has none).
