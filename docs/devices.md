# virtio devices and host backends

How guest I/O works, as built: virtio-mmio transports in the core, backends in TypeScript in a
device worker (twinned in Rust for the native runners), and the display and input glue on the
page. The ring and record layouts are in [abi.md](abi.md) "Device backends".

## The split between core and host

- **In the core** (`core/src/virtio.rs`, on the vCPU thread): virtio-mmio v2 transports (magic,
  version 2, device and vendor ID `WBPC`, feature select and negotiation with `FEATURES_OK`
  refused unless `VERSION_1` is accepted and nothing unoffered is, queue select/size/ready/
  addresses, notify, InterruptStatus/ACK, status and reset, ConfigGeneration (the host's `config_gen`, with the config-change interrupt: abi.md), SHM regions
  absent, config space 8/16/32/64-bit), and **split virtqueues** with indirect descriptors and
  either `VIRTQ_AVAIL_F_NO_INTERRUPT` or `EVENT_IDX` (the driver's `used_event` decides each
  drain's interrupt; the core writes `avail_event` after posting, then reads the available index
  again). Our own split-ring code, not rust-vmm's `virtio-queue`.
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
- **Chains in flight:** each queue keeps the heads of the chains posted and not completed, in
  order. A completion is taken only for one of them, and a VM restored from a snapshot posts
  them again ([platform.md](platform.md) "Snapshots"): a backend that only holds buffers has
  nothing to save. One with state of its own gives it as JSON (`Backend.save`) and takes it back
  in a new VM (`restore`): the deterministic rng's position. 9p's tree and fids aren't saved yet:
  a VM with a 9p device refuses a snapshot.

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
- Native twins of every backend live in `core/tests/common` (`p9.rs`, `qcow2.rs`, `gpu.rs`, `snd.rs`, the overlay,
  net loopback, input agent), so native boots give the guest the same bytes.

## Configuration

- `VmConfig.devices`/`ndevices` point at up to 32 `DeviceEntry`s (device ID, offered features,
  queue count ≤ 8, QueueNumMax ≤ 1024, config length ≤ 256); index = transport slot, one DT node
  each, in slot order (QEMU fills from the top of its window; we fill from slot 0).
- Host side: `{devices: [{type: 'blk', url, overlay?, file?}, {type: 'net', adapter}, …]}`
  (`web/vm.ts` `DeviceSpec`; `guestDevices` and `testDevices` build the tests' sets).

## Devices

### USB (an xHCI, not virtio)
An xHCI in the core (`core/src/xhci.rs`) with its devices in the device worker behind `web/usb.ts`, on the
same doorbell as the virtio backends, through a shared block of its own (`vm_xhci`) with request and
completion rings as `DevShared`'s. Gadget Zero is its virtual test device, with a native twin; WebUSB and
WebHID devices are the page's. All of it is in [usb.md](usb.md).

### console and rng
virtio-console: TX to the host, receive buffers held (no host input path: console input goes to
the PL011, [platform.md](platform.md) "PL011"). virtio-rng:
`crypto.getRandomValues` in the browser's realtime mode; **splitmix64 seeded 0** in deterministic
mode (and natively in realtime mode: std has no CSPRNG).

### blk (ID 2)
- Features `SEG_MAX` = 126, `RO` (or `FLUSH` when writable: an overlay, or a ramdisk); one queue of 128. `IN`, `GET_ID`,
  `OUT` and `FLUSH` when writable (`IOERR` without), the rest `UNSUPP`. `GET_ID` answers the spec's `serial` (a
  machine's attachment: `webpc-<attachment id>`, so `/dev/disk/by-id/virtio-…` survives a reorder;
  docs/plans/machines.md §4.1), else `webpc-blk` (the tests' guests).
- **Sources** (`BlkSpec`): an image by `url` (HTTP ranges, or `file:` in Node) or `file` (a `File`), or
  `source` with a `size`: `zero`, a **blank disk** reading as zeros (writable through its overlay, as any image),
  or `ram`, a **ramdisk** (`web/ramdisk.ts`): writable in itself, with `DISCARD` and `WRITE_ZEROES`, its bytes in
  1 MiB chunks of shared memory made on a chunk's first write and dropped when a discard or a zeroing covers the
  whole chunk (a missing chunk reads as zeros), so an empty ramdisk costs nothing and `fstrim` gives the memory
  back. It is the device worker's, so every start, the guest's reboot too, finds it empty
  (`tests/ramdisk.test.ts`; on the page `tests/page-machines.test.ts`).
- **`DISCARD` and `WRITE_ZEROES`** with an overlay and the spec's `discard` (the page's machines;
  the tests' guests and the native twin are without it, as their step counts are): the config
  space goes on to 60 bytes, one segment of at most 2 GiB per request, `discard_sector_alignment`
  8 (Linux's discard granularity: the overlay's 4 KiB blocks), `write_zeroes_may_unmap`. A discard
  with the unmap flag, and unknown flags, are `UNSUPP`; a range past the end or too long, and
  anything but one segment, `IOERR`. Linux takes it as it is (`fstrim` on Buildroot's and Debian's
  ext4; `tests/trim.test.ts`). The guest has to trim: `fstrim -av`, a `discard` mount option, or
  the distribution's weekly `fstrim.timer`.
- **Over HTTP** in the browser: one **synchronous XHR range request** per request (needs a worker:
  no binary sync XHR on a page's main thread, no XHR in Node, where `file:` URLs read with
  `node:fs`). `tools/serve.ts` answers single `Range: bytes=` requests (206/416, `Accept-Ranges`,
  HEAD). No cache, merging or concurrency: the guest's page cache is the only cache, and the
  per-request XHR dominates random reads (fio 4 KiB random reads ~1,800 IOPS on the M4).
- **qcow2** v2/v3 (`web/qcow2.ts`, `core/tests/common/qcow2.rs`, detected by the magic): L1/L2,
  unallocated and zero-flag clusters as zeros, compressed clusters as raw deflate
  (`DecompressionStream('deflate-raw')`; `miniz_oxide` natively, a dev-dependency). A request's compressed
  clusters are inflated as one batch (an `Inflater`): where the thread can start workers (the device worker, the
  disk-in and disk-out workers) it shares the batch with up to four of `web/inflate-pool.ts`'s
  (`inflate-worker.ts`; started by the first request with two or more, each share one message; a single cluster
  stays on the reading thread), otherwise one after another in place (Node). Read-only
  (refcounts never read). **Refused at open:** encryption, backing files (a changes file is read by `readChanges`, docs/frontend.md "Your own disk"), external data files,
  extended L2, zstd, unknown incompatible features. Capacity is the virtual size. Debian's
  published image is 95% compressed clusters, which is why deflate is supported rather than
  converting the image. A request's clusters are read from the file in merged host reads (ranges within 64 KiB of each other, up to 8 MiB: an image's clusters mostly follow each other, so a 1 MiB read of Debian's image is one or two HTTP requests, not sixteen; a merged read that fails leaves its ranges to their own reads; one read per cluster natively), all L2 tables kept, the 16 most recent
  compressed clusters cached (1 natively).
- **Writable disks: a copy-on-write overlay** (`web/overlay.ts`) in an OPFS directory, 4 KiB
  blocks: `data` holds written blocks in slots, `map` a u32 per disk block (0 = base,
  n = slot n − 1, 0xffffffff = zeros without a slot), `meta` its **generation** (a u64, bumped and flushed before
  the first change of each opening: a write, a discard or a zeroing; an opening that only reads leaves it, so "the
  overlay is as it was at generation g" is two integers compared: docs/plans/machines.md §3.3) and, for a stored
  disk, the overlay being merged into it, `base` the image's identity (`diskIdentity`: a URL's path and the size, or a chosen `File`'s name, size and modification time; a mismatch refuses to open). A block's
  slot is written before its map entry, so a crash leaks a slot but never maps garbage. **Few OPFS calls:** a sync-handle
  call costs ~0.3 ms whatever its size (Chromium on Linux, `bench/io/REPORT.md`), so reads and writes go in runs: blocks held in
  consecutive slots are one read or write, whole blocks not held take consecutive slots where `take` has them and are written
  from the request's bytes in one write with their map entries in one more; only a block a write covers in part is
  read-modify-write.
  **What the guest discards leaves the overlay:** the whole blocks of a discard that the overlay
  holds become zeros without slots (never the base's bytes again: QEMU's qcow2 does the same over
  a backing file; blocks it doesn't hold stay the base's), a `WRITE_ZEROES`'s whole blocks too,
  held or not. Slots no block maps (those, and leaked ones) are found at open and taken by the
  next first writes; free slots at the end of `data` are cut off, and once half of `data` is free
  the blocks in its highest slots are copied down (copy, then the map entry) and the file shrinks.
  Measured on Buildroot: an 8 MiB file written and deleted leaves 8.3 MiB of `data`; after
  `fstrim`, 132 KiB. A changes file carries the zero blocks as zero clusters (no data), and
  Load changes and a snapshot's restore keep them without slots. Opened
  with synchronous access handles (so deterministic mode stays exact) under the overlay's Web Lock
  (`openOverlay`), and closed on `close` (the device worker answers `closed`, and `vm.close()`
  resolves then): the handles are exclusive, so a new VM on the same overlay waits for the lock,
  which the old one holds until its handles are closed or its worker is gone
  ([frontend.md](frontend.md) "Overlay hand-over").
  Natively, `Overlay` keeps 512-byte sectors in memory and can be shared by several boots; in
  Node, which has no OPFS, `openOverlay` keeps an overlay in memory for the process's life, by
  name (the tests' writable disks, e.g. `tests/uefi.test.ts`), under the same Web Lock. No quota handling or content check of the base
  (backlog). Host API (web/overlay.ts, a page or a worker): `removeOverlay(name)` deletes an
  overlay once no VM has it open (the page's "Reset disk", M8), `overlayBytes(name)` says what it holds.
  Overlay names are OPFS paths: a stored machine's are `overlays/<id>` (docs/plans/machines.md §2), a transient one's
  (the tests' `?machine=`) are single names as before; `overlayMeta(name)` reads the generation without opening it.
- **Stored disks** (`web/stored.ts`, docs/plans/machines.md §4.4): an image copied into the browser is the same
  block store over nothing, in `disks/<id>/` (`importImage`: a qcow2's virtual bytes, compressed clusters inflated,
  or a raw file's, zero blocks left out; `storedEstimate` bounds what it takes from a qcow2's allocated clusters).
  Under an overlay it is the base (`BlkSpec.stored`: `openStored` reads it with read-only handles under a shared
  lock, so several machines can); written in place it is its own overlay over zeros (exclusive, as any overlay).
  `mergeOverlay` writes an overlay's blocks in (its zero blocks as zeros) and deletes it, with the store's
  generation bumped and its `meta` naming the overlay first, so an interrupted merge is finished at the store's next
  opening (`resumeMerge`), before anything reads it (`tests/stored.test.ts`, with the resume left out as the planted
  bug).

### net (ID 1)
- **The host sees Ethernet frames only**; IP, DHCP, NAT and the rest live in the adapter, never in
  the emulator. Features `MAC`, `STATUS` and the offloads below, a receiveq and a transmitq of 256; MAC
  `52:54:00:12:34:56` by default, link always up. Each transmitted chain is a frame with the
  12-byte `virtio_net_hdr_v1` stripped (≤ 12 bytes, over 12 + 1518 without GSO, or past an IPv6
  packet's largest, dropped). Frames for the guest wait for receive buffers (the oldest dropped past
  256) and fill as many as they need (`MRG_RXBUF`: the header's `num_buffers`; without it, one larger
  than the next buffer is dropped). Frames from a port (a page adapter or a port backend) are delivered
  in batches: those one task brought, at its end (a microtask, so no timer); the test adapters' at once,
  so deterministic mode stays exact. No `CTRL_VQ`, one queue pair.
- **Offloads** (`web/offload.ts`; byte tests in `tests/offload.test.ts`): what the guest's stack would
  run as guest code runs in the device worker, and adapters still see ordinary frames. `CSUM`: a
  `NEEDS_CSUM` frame gets its checksum finished (from `csum_start` to the end, at `csum_offset`).
  `HOST_TSO4`, `HOST_TSO6` (with `HOST_ECN`) and `HOST_USO`: a packet of up to 64 KB is cut into
  `gso_size` payloads, each with the headers, its IPv4 total length (or IPv6 payload length), an IPv4
  ID counting up from the packet's (its header checksum redone), the TCP sequence number moved on
  (FIN and PSH on the last segment only, CWR on the first) or the UDP length, and the transport
  checksum over its pseudo-header; the transport header is where `csum_start` says, so IPv6
  extension headers pass. A packet the guest got wrong (no `gso_size`, the wrong family for its
  `gso_type`, an IPv4 fragment) is dropped; UFO (`gso_type` 3) isn't offered. `GUEST_CSUM`: a frame for the
  guest whose TCP or UDP checksum the device found right (IPv4, or IPv6 without extension headers; not a
  fragment; padding left out) is marked `DATA_VALID`, and the guest doesn't check it again; anything else
  is left to the guest. The guest's MSS follows the lease's MTU (DHCP option 26, and the gateway's MSS
  clamp), so segments fit the tunnel. `GUEST_TSO4`, `GUEST_TSO6` (only with `MRG_RXBUF`: without it
  Linux posts a 64 KB chain per buffer): within a batch, consecutive segments of one TCP stream become
  one packet, by the rules of Linux's GRO: each with a right checksum, IPv4 without options or IPv6
  without extension headers, the same headers byte for byte but for the lengths, IPv4 ID, checksums,
  sequence number and PSH; contiguous sequence numbers; only ACK, and PSH on the last; every payload as
  long as the first but the last; up to 65,535 bytes of IP. The packet has the first segment's headers
  with the lengths and IPv4 checksum redone and PSH from the last, `gso_type` TCPv4 or TCPv6, `gso_size`
  the first payload's length, and `NEEDS_CSUM` with the pseudo-header's sum in the checksum (the spec
  asks for it with GSO; the guest takes a partial checksum as checked). The relay's messages carry 2 to
  4 packets of a download (bench/net/REPORT.md "Batches"), so a download reaches the guest's stack as
  ~1.5 times fewer packets. The loopback adapter's ARP and ICMP are neither offloaded, marked nor merged.
- **Adapters** (`web/net.ts`): `NetAdapter = {send(frame), close?()}`, made with the
  `receive(frame)` it calls. `{adapter: 'loopback'}` runs the **loopback test adapter** in the
  device worker: it plays 10.0.2.2 at `52:55:0a:00:02:02` and answers ARP and ICMP echo
  synchronously (a TX's replies complete before the doorbell is acked, so deterministic mode
  stays exact). `{adapter: port}` puts the adapter on the page behind a `MessagePort`, one frame
  per transferred `ArrayBuffer`; such frames arrive whenever they arrive (realtime behavior).
  This frame port is the adapter API (no v86 compatibility: [plans/networking.md](plans/networking.md)).
  Layer-3 backends use the **IP-packet port**, `IpPort = {send(packet), close?()}` (`ipPort(port,
  receive)` over a `MessagePort`): one IPv4 or IPv6 packet per transferred `ArrayBuffer`, no Ethernet
  header, or a **batch**, an array of them (`packetsOf` reads either). Both ends send with `batchSender`
  (web/net.ts): what one task sends is posted in one message from a microtask, so a batch waits for no
  timer: the segments of one TSO packet from the device, everything one relay message brought from the
  tailnet worker (the relay writes ~4 KB at a time, so 2–4 packets of a download). **The Ethernet gateway** (`web/gateway.ts`, in the device worker) sits between a frame
  adapter and an IP backend (`IpBackend = {lease(), send(packet)}` plus the `deliver` it's made
  with): `{adapter: 'echo'}` is the synchronous test backend (answers ICMP echo for any address;
  lease 198.18.0.15 and `fd00:5eb0::f`, MTU 1280; answers ICMPv6 echo too), `{adapter: {ip: port}}` a backend behind a `MessagePort` (an
  ArrayBuffer is one packet; `{type: 'lease', lease}` from the backend sets the lease: the
  Tailscale worker, N4). What the guest sees: a LAN with one router at 169.254.0.1
  (`02:77:65:62:70:63`). **Proxy ARP** answers every request except for the guest's own address
  (probes from 0.0.0.0 ignored), so no address range is assumed. **DHCP** (DISCOVER/REQUEST
  only) hands out the backend's address with mask 255.255.255.255 (a zero mask makes current systemd-networkd drop the lease: "DHCP error: no netmask"; the routes are option 121's), router = the gateway,
  the backend's DNS, first search domain, MTU (option 26), broadcast and classless routes
  (option 121: the gateway on-link, a default route through it); no lease means no offer and a
  NAK for a request; a renewal is answered unicast. **Framing:** the Ethernet header is cut on the
  way out (padding too) and added on the way in (gateway MAC to the guest's, learned from its first
  frame). **IPv6** (`web/ip6.ts` builds the packets; the gateway's link-local
  address is derived from its MAC, `fe80::77:65ff:fe62:7063`): a **router advertisement**
  (to all nodes; sent to router solicitations, whenever the lease gains or loses an IPv6 address
  (lifetime 0 when it loses it), and, on a port backend, every 60 s) with the managed and other
  flags, router lifetime 1800 s, the MTU and the resolvers (RDNSS), and **no prefix**: nothing is
  on-link and nothing autoconfigures, so the guest's default route is the gateway and no proxy NDP
  is needed. **DHCPv6** (to `ff02::1:2` or the gateway): SOLICIT/ADVERTISE, REQUEST/RENEW/REBIND/
  CONFIRM/INFORMATION-REQUEST/REPLY with one IA_NA holding the lease's `address6` as a /128 (T1/T2
  half and four fifths of the lease, valid = preferred), DNS (23), the first search domain (24),
  DUID-LL; another address in a renew gets NoBinding, in a confirm NotOnLink; no IPv6 address in the
  lease, no answer. Neighbor solicitations are answered for the gateway's own address only
  (duplicate-address probes from `::` and off-link hop limits ignored); ICMPv6 echo to the
  gateway is answered. Packets from the guest must come from `address6`; over the lease's MTU gets
  ICMPv6 Packet Too Big. Dropped: non-IP ethertypes, multicast and broadcast beyond that,
  packets whose source isn't the leased address, anything before a lease. A packet over the lease's MTU gets ICMP
  fragmentation-needed if DF is set and is dropped otherwise (no fragmentation). The gateway
  answers pings to its own address. Tests: tests/gateway.test.ts (bytes of ARP, DHCP, framing, router advertisements, neighbor discovery, DHCPv6).

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
  layout; what's held is released when the element or the window loses the focus, and `chord`
  sends combinations the browser keeps, docs/frontend.md "Input"); they wait for event buffers
  (oldest dropped past 1024). LED status events go to the port. No pointer lock or multitouch.

### virtio-gpu (ID 16): 2D, and 3D through virgl
- `{type: 'gpu', width, height, dpi?}` (`web/gpu.ts`; the native twin is `core/tests/common/gpu.rs`
  and must give the same answers, the same EDID bytes and the same pixels). controlq and cursorq,
  feature `EDID`, config `events_read`, `events_clear` (write-one-to-clear), `num_scanouts` = 1,
  `num_capsets` = 0. Commands: `GET_DISPLAY_INFO` (the spec's size), `GET_EDID`, `RESOURCE_CREATE_2D`,
  `RESOURCE_UNREF`, `SET_SCANOUT`, `RESOURCE_FLUSH`, `TRANSFER_TO_HOST_2D`, `RESOURCE_ATTACH_BACKING`,
  `RESOURCE_DETACH_BACKING`, `UPDATE_CURSOR`, `MOVE_CURSOR`; everything else `ERR_UNSPEC`, unknown
  IDs and rectangles outside a resource the spec's errors. The fence flag, id and context are
  echoed (2D work is synchronous). The cursorq has no responses.
- **Resources are RGBA bytes in JS memory**, capped at 64 MiB each and 256 MiB together
  (`ERR_OUT_OF_MEMORY`). `TRANSFER_TO_HOST_2D` gathers the rectangle's rows from the backing pages
  (the first row at `offset`, rows a resource width apart, as QEMU reads them) and swizzles to
  RGBA in the same pass, for all eight 32-bit formats. **An X format's unused byte is kept as
  alpha:** Linux creates every dumb buffer as `B8G8R8X8`, and a cursor that is an ARGB8888
  framebuffer on one carries its alpha there. The screen ignores alpha. **Where the screen is
  WebGL2** (a 3D machine's host, and a 2D machine's presenter on a GPU: `GpuHooks.raw`) a resource
  keeps the guest's bytes as they are (a plain copy, 3 to 4 times faster than the swizzle) and the
  screen swizzles in its draw; the hashes and the cursor are RGBA all the same.
- **The backing pages are guest-physical addresses inside the command**, which the core's chain
  checks don't cover: every entry must lie in RAM (`ERR_INVALID_PARAMETER` otherwise, nothing
  attached), a transfer reads only through the entries, and the backend never writes guest RAM.
- **Display size and events:** `Gpu.setSize` changes what `GET_DISPLAY_INFO` and the EDID say and
  raises `VIRTIO_GPU_EVENT_DISPLAY` through `Ctx.changeConfig` (ABI 31). The EDID (`web/edid.ts`)
  is ours: one 128-byte block, CVT reduced-blanking timings for the preferred mode (60 Hz, lower
  for the largest sizes to keep the pixel clock in a detailed timing), physical size from the DPI,
  sizes from 480×300 to 4095×4095; `edid-decode --check` passes for every size tested.
  **Two rules keep fbcon's console whole** (found on Debian's page, graphics.md §13): fbcon's buffer
  is allocated once, and DRM rejects any mode wider or taller than it (`VIRTUAL_X`), so the EDID lists
  after the preferred mode the size of the resource the guest last showed (the console's buffer; kept in a
  snapshot) and the *floor*, or the guest finds no mode and blanks the console. And when a guest answers a smaller mode with a rectangle smaller than the
  resource it keeps (a crop, at the origin), the display never reports less than that resource again
  (`floor`) and raises the event once more: the console gets its whole buffer back and the page
  letterboxes it. A compositor that makes a resource per mode never trips either, so a desktop
  that changes its mode isn't held back. Both are the page machine's (`GpuOptions.keepConsole`): the test guests leave them off so their bytes and step counts stay. The page's size and the reported one are separate (`wanted`, `width`/`height`).
- **A transfer copies when it arrives; a flush shows.** `TRANSFER_TO_HOST_2D` is the guest's only promise about
  its buffer: Linux waits for no reply on a primary plane (no fence; a 60 Hz vblank timer only since 6.19), so a
  compositor is already drawing a later frame into the same buffer while earlier replies are outstanding. A copy
  made any later than the command (at the reply, at the page's draw) reads half-drawn frames, and the host never
  reads a backing on its own (a guest draws into buffers the host still shows). `RESOURCE_FLUSH` and `SET_SCANOUT`
  are what damage the screen (`GpuHooks.damage`, `scanout`); a transfer alone shows nothing.
- **Flush replies are paced on the page** (`GpuOptions.paceFlushes`, `GpuSpec.queueSize` 16; off and 64 for the
  test guests, whose bytes and step counts must not move): one `RESOURCE_FLUSH` is answered per 16 ms frame, the
  first after an idle moment at once, and whatever is queued behind a held flush waits with it, in order. It is the
  only back-pressure a 2D guest takes: with replies instant a scrolling console commits thousands of times a
  second, and with the queue full it commits once per frame (graphics.md §16 has the numbers). Commands are never
  delayed, only their replies. `?gpu=nopace,q<N>` on the page changes both, for measurements.
- **A guest that composites with llvmpipe shows stale frames** (graphics.md §16): Mesa's software GL rasterizes
  on its own threads after `glFlush`, wlroots flips without waiting, so the transfer copies a buffer that is
  still being drawn and nothing tells the device when it is done. That is the guest's race (a real display hides it
  by scanning memory continuously); `WLR_RENDERER=pixman` in the guest removes it, and pixman is also about ten
  times lighter under the JIT.
- **A QueueNum of 0 means the device's maximum** (the transport, for every device): EDK2's virtio-gpu driver writes 0 and expects the ring it laid out for QueueNumMax; QEMU ignores the write, and the first version of ours put the device in NEEDS_RESET, so the firmware hung at its first command.
- **Where the pixels go** is `GpuHooks` (`scanout`, `damage`, `cursor`): the backend calls them
  and keeps no presentation of its own; `web/gpu-present.ts` wires them to an `OffscreenCanvas` in the device worker (docs/frontend.md "The screen"): WebGL2 where the browser has it on a GPU, else a 2D context. For the 2D context a resource that is set as the scanout loses its alpha (one pass, then every transfer writes 255): a canvas takes the pixels as they are, and `alpha: false` was not enough in a worker (the screen came out transparent). Without hooks the state is
  all there is: `Gpu.state()` (and `Backend.save`, so a snapshot) gives the display, the resources
  without pixels, hashes of the visible scanout (alpha forced opaque) and of the cursor image, and
  with `trace` the scanout's hash at every flush (tests). A restore reads every resource again
  from its backing in the restored RAM and draws the scanout; a guest that wrote its backing
  without transferring shows the newer pixels until its next flush.
- A virtio reset drops all resources, the scanout and the cursor. The backend is a pure class
  (`Gpu`) over RAM and a command buffer, so Node tests drive it without a guest.
- Guests: Linux's `virtio_gpu` (a module in Debian and Alpine, built in `images/gpu` with
  `CONFIG_DRM_VIRTIO_GPU_KMS`, without which it says "KMS disabled" and offers no display).

#### virgl (3D: G2's guest side, G3's renderer on WebGL2)
- `{type: 'gpu', …, virgl: true, caps?}` (`GpuOptions.virgl`, off by default so no guest's bytes or steps move; the
  page's `?gpu=virgl-null`). Adds feature `VIRGL` (bit 0) and `num_capsets` = 2, and the 3D commands: `GET_CAPSET_INFO`,
  `GET_CAPSET`, `CTX_CREATE`/`DESTROY`, `CTX_ATTACH`/`DETACH_RESOURCE`, `RESOURCE_CREATE_3D`, `TRANSFER_TO_HOST_3D`,
  `TRANSFER_FROM_HOST_3D`, `SUBMIT_3D`. Errors as virglrenderer gives them (`ERR_INVALID_CONTEXT_ID` for an unknown or
  reused context, context 0 included); at most 1,024 contexts and 65,536 resources.
- **The capsets** are VIRGL (v1, 308 bytes) and VIRGL2 (v2, 1408 bytes) from one blob, `GpuOptions.caps` or else
  `virglCaps` (`web/virgl.ts`: virglrenderer's own caps on a GLES 3.0 host, graphics.md §19, so the guest's Mesa
  reports **OpenGL ES 3.0**, GLSL level 130, minus what WebGL2 lacks and at WebGL2's minimum limits). A 3D machine on
  the page is given `capsFromGl` (`web/virgl-caps.ts`): that floor with the browser's limits and only the formats its
  extensions back (graphics.md §20). The renderer string is `webpc`.
- **The device checks, the host runs** (`web/virgl-host.ts`): the device validates every command and keeps its tables
  (contexts, resources and their backings) as for the null renderer, and hands the work to `Gpu.host`: contexts,
  3D resources, backings, attachments, transfers and submits, and with a host every scanout too (a 2D resource's
  pixels then live in shared memory, in the guest's format, and the host's screen reads them in place and draws them
  through the format's swizzle). Calls are ordered and answer nothing.
  **A command with the fence flag** has its reply held until the host's fence resolves (everything before it has
  run: uploads read, read-backs written), and every reply behind it waits in order (the flush pacing is the same
  queue). Without a host it is the null renderer: streams walked and counted (`VirglStats`), 3D transfers counted,
  fences at once, a 3D scanout black.
- **The renderer** (`web/virgl-renderer.ts`, graphics.md §20) runs the stream on one WebGL2 context:
  virglrenderer's decoder and state model (contexts, sub-contexts owning the objects, resources attached to
  contexts), state applied at each draw, programs from `web/virgl-tgsi.ts` (TGSI → GLSL ES 3.00, per vertex and
  fragment pair and draw-state key) cached by shader and key. Resources: buffers (a GL buffer and a CPU copy, the
  element buffer made from the copy; staging buffers only the guest's pages), textures by target (1D and rectangles
  as 2D, 1D arrays as 2D arrays, cubes, 3D), multisampled and stencil-only ones as renderbuffers; formats from
  `web/virgl-formats.ts`, stored as their bytes are (no BGRA in WebGL2) and swizzled in the shaders; an X format's
  unused byte gets the fragment's alpha when drawn to (blending reads it; sampling an X format reads 1, and its
  destination alpha is 1 through substituted blend factors). Uploads read the
  guest's pages in place where they are contiguous (`COPY_TRANSFER3D` from a staging buffer, `TRANSFER3D`, the
  virtio transfer, `RESOURCE_INLINE_WRITE`); read-backs (`readPixels`, or the buffer's copy) write them. What WebGL
  refuses and GLES allows is worked around at the draw: front and back stencil states whose reference or masks
  differ draw twice (each face's triangles with its own state on both faces, the other face culled); an attribute
  whose stride or offset isn't a multiple of its type's size, or whose stride is over 255, is repacked from the
  buffer's copy into a scratch buffer of its slot; WebGL2 always restarts primitives at the index type's largest
  value, so indices that hold it with restart off (GLES 2) are widened to the next type, and another restart index is
  mapped onto the largest (in a scratch element buffer; a draw's indices start at the index buffer's offset alone:
  Mesa folds the draw's start into it, as vrend reads it). A color target without alpha (RGB565, R8) gets the
  fragment's alpha in its output's fourth component (blending reads it); WebGL2's one color mask leaves on the
  components the first target doesn't store (another may); a blit drawn through the formats' swizzles has only its
  destination attached (sampling a texture still attached from the last draw is a feedback loop WebGL refuses); flat
  varyings travel as integers. A fence waits for the occlusion queries ended before it (WebGL's results come only
  after the task that ended them; GL's are ready at a fence, so a guest's `glFinish` sees them: `FenceGate`); a query destroyed before its result stops counting (a deleted WebGL query never has one). `gl_FragCoord` is upper-left whatever the
  shader's `FS_COORD_ORIGIN` says: the caps offer no lower-left origin, so Mesa flips y itself. Z24_UNORM_S8_UINT and Z24X8_UNORM uploads are rotated (Gallium
  keeps depth in a word's low 24 bits, GL in its high 24); Z32_FLOAT_S8X24_UINT uploads are drawn (WebGL2 takes no data
  for its type: the depth through `gl_FragDepth`, the stencil a bit a pass). Clears,
  `CLEAR_SURFACE`, `CLEAR_TEXTURE`, blits (a framebuffer blit for the same stored layout, a draw through both
  formats' swizzles otherwise), copies between resources, occlusion queries as "any samples passed" (exact, or
  conservative for virgl's conservative type; a counter reads 0 or 1, written to the query's buffer when WebGL has it), stream output (transform feedback, graphics.md
  §20: interleaved into one buffer or one output a buffer, unindexed lists, cut at a full buffer, read back into the
  buffer's copy; PRIMITIVES_GENERATED and PRIMITIVES_EMITTED counted by the draws). Multisampled resources are renderbuffers
  (`texture_multisample` is advertised where the browser multisamples: Mesa makes no multisampled renderbuffer
  without it); a multisampled source is resolved into a texture of its format before a blit that converts layouts or
  flips, a multisampled texture sampled is resolved at the draw (one value a pixel, whatever the sample index), and
  the sample mask is WebGL's sample coverage. Not there yet (none advertised): conditional rendering, user clip
  planes, depth read-backs.
- **What the guest sends** (Mesa 26.1 and 26.2): textures are uploaded and read back through staging buffers
  (`VIRGL_BIND_STAGING`, `COPY_TRANSFER3D` in the stream), vertex data through `TRANSFER3D` in the stream (the
  buffer's own pages), so glcomp and sway send no `TRANSFER_*_3D` at all; dumb buffers (fbcon, a console's cursor, pixman)
  stay 2D.
- **Captures** (`Gpu.onCapture`; `GpuSpec.capture` posts them on the display port; `web/virgl-trace.ts`): the 3D
  control commands and the guest memory they read, the renderer's fixtures (`tests/virgl/`, graphics.md §20).
  `web/virgl-replay.ts` runs one through the device into a host.
- **A 3D cursor:** a compositor on virgl (sway on GLES) draws its cursor with GL into a 3D resource, and Linux
  transfers only dumb buffers, so `UPDATE_CURSOR` on a 3D resource reads its pixels back from the renderer
  (`VirglHost.read`, after the commands before it; QEMU's `virgl_renderer_get_cursor_data`) and shows them, unless
  another update came meanwhile.
- **Snapshots** (the G3 kickoff's decision 3: a machine with 3D that isn't using it saves): contexts that never
  submitted (a process holding the render node open: Alpine's initramfs keeps one) are saved and made again in the
  renderer on restore; a context that submitted, or a 3D resource, has objects outside guest RAM, so `save()` marks
  the machine `unsaveable` and `vm.snapshot` refuses with the reason until they're gone. The caps the guest read are
  saved; a restore in a browser that can't back them (`capsBacked`) keeps them for the guest and turns 3D off (new
  contexts refused) rather than refusing the machine. The restore tells the host what the scanout shows (the GPU
  worker draws the screen on a 3D machine).
- **Video** ([plans/video.md](plans/video.md); on with 3D, `?gpu=novideo` off): the caps' `video_caps` list the decoders
  the browser's `VideoDecoder` takes (H.264 Constrained Baseline, Main and High, VP9 profile 0, AV1 Main 8-bit; `web/virgl-video.ts`
  `probeVideo`, in the GPU worker before it answers, which also notes which are in hardware), so the guest's Mesa offers
  VA-API decoding. The renderer keeps each context's codecs and video buffers (CCMD 53-61: a buffer is its planes'
  resources, R8 and RG8) and reads each picture's parameters and data from the guest's staging buffers. `VideoContext`
  makes a chunk of each END_FRAME (H.264 rebuilt as Annex B with our SPS and PPS by `H264Stream`, `web/video-h264.ts`;
  VP9 as sent) for one `VideoDecoder` per codec (`optimizeForLatency`; recreated at the next key picture after an
  error), and writes each frame's Y and interleaved U/V into the buffer's planes (`VirglRenderer.writePicture`).
  Mesa's `end_frame` makes no fence, so the GPU worker's `CallQueue` (`web/virgl-host.ts`) holds a call while it
  could see a pending picture: a call of a context that has a pending picture's plane attached (unless the submit
  only decodes) or one naming a plane, and what must follow a held call (its context, its resources; fences, reads,
  the screen and a resource's end wait for every held call). The rest runs, so a decoder that holds pictures stalls
  only the context that shows them (Firefox's compositor attaches the planes per frame). The SPS's reorder depth is
  0 for a hardware decoder; in software (which outputs in display order) the larger of the stream's reference count
  and the depth learned from the POCs (`H264Stream` `'stream'`): FFmpeg drops a picture that comes after one it has
  shown, and a pending picture of a lesser POC than one that comes out is given up at once. If calls wait 200 ms and
  nothing comes out, a software H.264 decoder is drained without loss: flushed, and a new one decodes the IDR period
  again from its start (kept up to 600 pictures or 32 MiB; else the next IDR); a picture still out after 1 s is given
  up (logged; the guest sees the old planes). VP9 frames with `show_frame` 0 give no output and aren't waited for.
  A picture is written into the planes its buffer had at END_FRAME as long as they exist, attached to the decoding
  context or not (virglrenderer writes at END_FRAME; Firefox's decoder process lets go of its surfaces at a seek while
  the compositor's context still shows them), never over a later picture in the same planes; a destroyed buffer's
  pending picture is still written, and a destroyed codec's decoder is flushed (what it holds written) before it
  closes. A decoder error (WebCodecs reports a damaged chunk; none conceals) closes the decoder and drops the codec's
  pending pictures; a new decoder starts at the next key picture. A seek sends a key picture to the same codec; a size
  change makes a new codec (plans/video.md §9). AV1 (`web/video-av1.ts` `Av1Stream`, plans/video.md §10): a sequence
  header and each frame header written from the desc, a tile group of the tiles; the decoder's reference slots are
  this side's (Mesa sends no refresh_frame_flags): a frame goes to a slot holding nothing the guest's reference map
  has, or waits for the next frame's map (`nudge`d out after 30 ms of calls waiting: `CallQueue`'s `nudgeMs`, and
  before a destroyed codec's flush), and one sent stored nowhere is decoded again if a later frame references it; a
  hidden frame the guest shows later is written shown, and frames with no output go in the next temporal unit. Film
  grain reaches the shown surface through webpc-va 2 (Mesa sends the film grain target too late). `renderer.videoStats` (decoded, dropped, errors;
  each picture's END_FRAME to written and its write, in ms) and the queue's `ahead` and `maxWaitMs` go out in
  render-stats (`bench/gpu/guest-session.ts` sums them over a phase). Mesa's wire numbers its profiles by its own
  `enum pipe_video_profile` (26.2's in `PROFILE`), which isn't stable across releases. A capture includes
  DECODE_BITSTREAM's buffers. `capsBacked` wants every decoder the guest was told of. The guest needs our `webpc-va`
  (NV12 surfaces only, plans/video.md §1; AV1 film grain, §10), in the desktop image.
- No native twin (`core/tests/common/gpu.rs` is 2D): the device and renderer are tested in Node (`tests/gpu.test.ts`,
  `tests/virgl.test.ts` on a recording WebGL2) and Chromium (`tests/virgl-browser.test.ts`).

### snd (ID 25)
- `{type: 'snd'}` (`web/snd.ts`, the native twin `core/tests/common/snd.rs`: the same statuses, completions at the
  same exits, the same control log). virtio 1.2 §5.14, written from the spec with Linux's `sound/virtio` read for
  behavior ([audio.md](audio.md)). No features, or with the spec's `mixer` `VIRTIO_SND_F_CTLS` (below); controlq,
  eventq, txq, rxq of 64; config jacks 0, streams 2, chmaps 0 (Linux takes zero jacks and channel maps: it builds no
  jack or channel-map controls), and with the controls `controls` 2 (16 bytes). On every page machine (the last
  device, so the others keep their slots) and the snd guest's test machines.
- **Controls** (virtio 1.3 §5.14.6.11, `VIRTIO_SND_F_CTLS`; Linux has the driver's side, `virtio_kctl.c`, since 6.7):
  only with `mixer` (the page's machines: `{level, muted}`, the Sound menu's at the start), so the test guests and
  their twin stay as QEMU's device, the oracle, which has none. Control 0 is `Master Playback Volume` (role VOLUME,
  INTEGER, one member, 0–400, read, write and TLV read; its TLV a `DB_SCALE` from -100 dB in 0.25 dB steps, 0 silent),
  1 is `Master Playback Switch` (role MUTE, BOOLEAN, 1 plays). `CTL_INFO` answers them as the other info queries
  (items of at least the 96-byte struct); `CTL_READ` needs room for a whole `virtio_snd_ctl_value` (512 bytes);
  `CTL_WRITE` of a value out of range, a control past 1 or a TLV read of the switch is `BAD_MSG`, `CTL_ENUM_ITEMS`
  (none enumerated) too; TLV writes and commands `NOT_SUPP`; without `mixer` every control request is `NOT_SUPP`. The
  page's level is the slider's fraction and the gain its cube (PipeWire's and PulseAudio's law), the value
  `round(4 × (60 log10 level + 100))`: the guest's mixer shows the page's percentage. A guest's write that changes a
  value is said on `port` (`mixer`: the page's menu follows); the page's changes there (`SndFromPage`) set the values
  and, if the driver took the feature, notify it with `VIRTIO_SND_EVT_CTL_NOTIFY` (mask VALUE) on an event buffer,
  held until one comes. The values survive a virtio reset and are in the snapshot (`controls`; one from before them
  keeps the page's), and a restore says them on `port`.
- **An output stream (0) and an input stream (1)** (the input since audio S4: older snapshots, with one, still
  load): `PCM_INFO` answers hda_fn_nid 0, no stream features, formats S16, S32 and FLOAT, rates
  8–192 kHz (what every browser's `AudioContext` takes), 1–2 channels, and the direction. Each stream has its own
  state machine and parameters; the control log names stream 1 (`PCM_START#1`). Linux derives its limits from that: periods
  2–16 of 160–122,880 bytes, a buffer of up to 245,760. `SET_PARAMS` takes those; unoffered features, formats,
  rates or channel counts are `NOT_SUPP`; a period of no whole frame or a buffer of no whole period, `BAD_MSG`.
  The state machine is the spec's (§5.14.6.6.1): `SET_PARAMS` from nothing, set, prepared or released;
  `PREPARE` from set, prepared or released; `START` from prepared or stopped; `STOP` from started; `RELEASE` from
  prepared or stopped; anything else, a stream id past 1 or a short request is `BAD_MSG`. Jack and channel
  map queries for anything are `BAD_MSG` (there are none), `JACK_REMAP` too; unknown codes `NOT_SUPP`. An info
  query's items must fit the reply's room and be at least the struct's size (a larger size is padded with zeros).
- **Transmit messages** (`virtio_snd_pcm_xfer`, frames, then a writable `virtio_snd_pcm_status`, written in the
  last 8 writable bytes): held while the stream is prepared or stopped, given to the **sink** once started, and
  completed with `OK` when the sink says they were played. `STOP` pauses (Linux sends it for a pause too, and
  resumes with `START` without posting its messages again), `RELEASE` returns every held message (`OK`, after
  its own reply), which is what Linux's `sync_stop` waits for. A message on another stream, of no whole frame, or
  on a stream not prepared is `BAD_MSG` at once. **Receive messages** (rxq: `virtio_snd_pcm_xfer`, then writable
  room for frames and the status) go to the input stream the same way, given to the **source** once started and
  completed with the frames it recorded, then `OK` (the used length the frames plus the status's 8); room of no
  whole frame, or none, is `BAD_MSG`. Linux posts a whole buffer of them at the input's START and posts a period
  again as soon as ALSA counts it, before its reader has it ([audio.md](audio.md) "Linux driver behavior"): a source that ran ahead of real time
  would overwrite unread frames. Event buffers are held for the controls' notifications (no stream events are sent).
  A virtio reset drops the streams and what's held.
- **The sink** (`SndSink`): `play(params, frames, done)`, `start`, `stop`, `release`, `tick` (the end of a
  `DEVICE` exit's requests: `Backend.polled`, which `Devices.poll` runs for every device on every exit). In
  deterministic mode the **deterministic sink** (`checksumSink`) plays (hashes, FNV-1a, and counts) and
  completes at the end of the exit that posted a message, or START's for those held, **at most a buffer less a
  period per exit**: Linux counts its position in completions modulo the buffer, so a whole buffer completed
  before it looks again reads as nothing played and the stream stalls ([audio.md](audio.md) "Linux driver behavior"); the rest completes at the
  next exit. `toF32` converts a format to the f32 an AudioWorklet takes.
- **The source** (`SndSource`): `record(params, bytes, done)`, and the same `start` to `restore`. The
  **deterministic source** (`patternSource`) fills at the end of the exit that posted a message, a buffer less a
  period at most, with `pattern`: integer triangle waves, 1 kHz left and 1.5 kHz right at 48 kHz (48 and 32 frames a
  cycle, ±12000; S32 shifted, FLOAT over 32768, mono the left), counted in frames since the first, so every runner
  records the same bytes. In realtime mode the **microphone source** (`micSource`): the spec's `mic` is the page's
  **microphone ring** (the sound ring's layout the other way round: the page's `webpc-mic` worklet writes, the source
  reads), and the source says on `port` when the input starts (`capture-start`, with its rate: the page opens the
  microphone) and stops (`capture-stop`). While the worklet's heartbeat moves, a message completes once the ring has
  its frames (converted from f32 stereo by `fromF32`; mono the mean), at most a buffer behind the newest (older frames
  are skipped); otherwise (no page, no permission, turned off) silence at the stream's rate by the clock, restarted at
  each switch; both under the same bound as the ring sink (a buffer less a period since the guest's last message, the
  rest after its next one or half a buffer's time and 30 ms after the core took the batch).
- **The realtime sink** (`ringSink`, every realtime machine): a message's frames go into the **sound ring**
  (`web/audio-ring.ts`: a `SharedArrayBuffer` of 65,536 f32 stereo frames behind an i32 header, Atomics only; a mono
  stream is written to both channels) as soon as it has room, and the message completes once the ring's read index
  passed its last frame, with `latency_bytes` the browser's output latency (the page writes it into the header;
  Linux makes it ALSA's delay). The read index is the page's AudioWorklet's while it plays (its heartbeat moved in
  the last 50 ms), else the sink's own clock's (the stream's rate by `performance.now()`, from the worklet's last quantum when it
  takes over; when the ring runs dry it waits for the guest, and counts that wait as the worklet counts a gap): a
  machine without a page, or a page whose context waits for a click, still plays in real time. Both move
  it by compare-and-exchange. The sink completes in a pump, at the worklet's notify (every 2 quanta) or after 5 ms
  (`?snd=timer`: a 5 ms interval instead), **at most a buffer less a period since the guest's last message** (across
  pumps: Linux reports progress from a work item that one run serves for any number of completions, so a whole
  buffer completed before it runs reads as none, [audio.md](audio.md) "Linux driver behavior"), the rest after the guest's next message, or (a
  stream's end) half a buffer's time and 30 ms after the core was seen to have taken the batch's first completion
  (`Ctx.untaken`: it takes them when a vCPU runs), so the guest's clock ran that long and ALSA's jiffies check takes
  a whole buffer for a wrap even if its work runs late (`completionBound`, [audio.md](audio.md) "Linux driver behavior"). After a restore the bound counts the
  guest as having had a whole buffer in flight: completions the old device made may be in the restored RAM unseen. The spec's `ring` and `port` are the page's (web/audio.ts `attach`; the port says the stream's
  start, with its rate, and its stop, and with `stats` its completions' timing each second); without them the sink
  makes a ring nothing plays. [audio.md](audio.md) "How it fits together".
- **Snapshots:** `save` gives the streams' states and parameters, the control log, the controls' values and the sink's and source's
  counts (the realtime ones have none); the held messages are posted again by the core and play or fill once (the
  sink hashes at completion; the source's pattern goes on from its count). A started stream's sink or source is
  started again at restore: the re-posted messages play while the vCPUs
  start (on the page a gap of 20-35 ms follows, counted as an underrun), and the guest plays on ([audio.md](audio.md) "Linux driver behavior").

### Framebuffer (`simple-framebuffer`)
- `VmConfig.fb_width`/`fb_height` (0: none). x8r8g8b8, packed rows (stride 4 × width), in guest
  RAM in whole 2 MiB units just below the DTB's 2 MiB (`boot::framebuffer`; at most half of RAM).
  The DT has `/chosen/framebuffer@…` and reserves the region under `/reserved-memory` with
  `no-map`. `vm_framebuffer(vm)` returns its PA.
- `web/display.ts` compares the buffer with the frame drawn last on every animation frame and puts
  the rows that changed on a `<canvas>` (or a worker's `OffscreenCanvas`: the page draws in its
  machine worker, docs/frontend.md "The screen") as opaque RGBA; fixed size, no mode setting.
  virtio-gpu (above) is the display for guests with the driver; the page switches to it in
  [plans/graphics.md](plans/graphics.md) G1 loop 4.
- The Buildroot test kernel has no fbcon (drawing the boot log would cost the boot test).

## Validation and oracles

Unit tests on hand-built rings (`core/src/virtio/tests.rs`: 13 malformed shapes, each ending in
NEEDS_RESET), `cargo fuzz run virtqueue`, Node tests of the 9p server, loopback adapter, input
config, overlay and qcow2, and the guests' device scripts natively, in Node and in Chromium
([testing.md](testing.md)). QEMU TCG (`virtio-*-device`, `-netdev user`, `-fsdev local`) runs the
same device scripts to the same output, up to the framebuffer (`virt` has none).
