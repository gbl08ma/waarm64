# virtio devices and host backends

How guest I/O works, as built: virtio-mmio transports in the core, backends in TypeScript in a
device worker (twinned in Rust for the native runners), and the display and input glue on the
page. The ring and record layouts are in [abi.md](abi.md) "Device backends".

## The split between core and host

- **In the core** (`core/src/virtio.rs`, on the vCPU thread): virtio-mmio v2 transports (magic,
  version 2, device and vendor ID `WBPC`, feature select and negotiation with `FEATURES_OK`
  refused unless `VERSION_1` is accepted and nothing unoffered is, queue select/size/ready/
  addresses, notify, InterruptStatus/ACK, status and reset, ConfigGeneration (the host's `config_gen`, with the config-change interrupt: abi.md), SHM regions
  (none, or with `DeviceEntry.shm` the VM's host-visible window as region 1: SHMSel, SHMLen, SHMBase), config space 8/16/32/64-bit), and **split virtqueues** with indirect descriptors and
  either `VIRTQ_AVAIL_F_NO_INTERRUPT` or `EVENT_IDX` (the driver's `used_event` decides each
  drain's interrupt; the core writes `avail_event` after posting, then reads the available index
  again). Our own split-ring code, not rust-vmm's `virtio-queue`.
- On a queue notify the core walks the new descriptor chains, checks each buffer lies in RAM,
  and writes it as a flat segment list to the device's **request ring** in shared memory: each
  segment names its memory (0, or a spill memory: docs/spill-memories.md), and the backends
  read it through `Ctx.ram()`, a view per memory (web/ram.ts).
  **TypeScript never parses virtio rings**, only the device protocol (e.g. the virtio-blk
  header). A malformed chain, a buffer outside RAM, a readable buffer after a writable one, more
  chains than the queue holds or an available index more than a queue ahead puts the device in
  NEEDS_RESET. A chain is at most the queue's size in buffers, or 1024 (`MAX_CHAIN`, QEMU's
  bound) once it goes through an indirect table: Linux bounds an indirect chain only by the ring
  slots it takes, and virtio-gpu posts a vmalloc'd command (a virgl command buffer, a
  framebuffer's backing entries) one page a segment, past the page's GPU queue of 16.
- **Notify = exit:** the core returns the `DEVICE` exit; the vCPU worker rings the device worker's
  doorbell and waits or resumes (below). One path for native and wasm.
- **Completions → IRQs:** the backend writes guest buffers directly, appends {queue, head, bytes
  written} to the completion ring, sets signal bit `SIGNAL_DEVICE` and `Atomics.notify`s. At the
  next chunk boundary the core drains completion rings, fills used rings, sets InterruptStatus
  and drives the transport's line.
- **Reset epochs:** records carry the transport's reset count (mod 256); the backend skips stale
  records and the core drops their completions, so a reset never lets a stale request complete
  into a reused ring. A backend that skipped any sets `SIGNAL_DEVICE` as a completion does: the room
  they held may be what the new driver's first chain waits for (below), and no completion would
  come for them. A reset also sets the shared block's negotiated features back to 0 (`Ctx.features()`
  is 0 until the next FEATURES_OK: net's link flap takes non-zero as a driver). (In realtime mode a backend can still write a buffer just after a reset, as
  DMA can on hardware; deterministic mode waits, so it can't happen there.)
- **Chains that don't fit the request ring** stay available and are posted at the next drain of the
  completions (`SIGNAL_DEVICE`: a completion, or stale records skipped).
- **Chains in flight:** each queue keeps the heads of the chains posted and not completed, in
  order. A completion is taken only for one of them, and a VM restored from a snapshot posts
  them again ([platform.md](platform.md) "Snapshots"): a backend that only holds buffers has
  nothing to save. One with state of its own gives it as JSON (`Backend.save`) and takes it back
  in a new VM (`restore`): the deterministic rng's position, a shared folders device's fids and qids. The in-memory 9p
  tree's aren't saved: a VM with one refuses a snapshot.

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
- **I/O counters** (`DevicesInit.io`, `Vm.deviceIo`): a Float64Array over a SharedArrayBuffer that
  `bootVm` makes and hands over with the init message, two slots per device. blk adds the bytes of
  each completed read and write, net those of each frame given to the guest and sent by it (`Ctx.io`):
  one store per request, from the backends' one thread; the machine worker reads them once a second
  for the page's status (frontend.md, `status`). They start at 0 with each `bootVm`.
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

### agent (ID 3): clipboard sharing's virtio-console

`{type: 'agent', port}` (`web/agent-device.ts`), only on a machine with clipboard sharing (`MachineRecord.clipboard`,
a transient machine's `?clipboard=1`: its own transport kind, `agent`, after `9p` in the slots, so other machines'
shapes don't move): a virtio-console with **MULTIPORT** (feature 1), one port (`max_nr_ports` 1, so four queues:
port 0's receive and transmit, the control receive and transmit) named **`org.webpc.agent.0`**. Linux's
virtio_console makes `/dev/vport<N>p0` of it and udev links `/dev/virtio-ports/org.webpc.agent.0`; no port is a console
(no CONSOLE_PORT), so no hvc. The handshake is the driver's: control buffers and DEVICE_READY, then PORT_ADD from the
device, PORT_READY from the driver, PORT_NAME and PORT_OPEN 1 (the host end is always open) from the device. The
guest's PORT_OPEN (1 on its open, 0 on its last close) goes to the page as `open`; the page's bytes fill the port's
receive buffers in order while the guest holds it open (dropped otherwise, as Linux drops them), at most `MAX_PENDING`
(1 MiB) held. The page's end is `web/app/agent-link.ts` (`AgentLink`, the tests' `window.__agent`): frames
(`web/agent-frame.ts`: a u32 length, a u8 type, the payload of at most 64 KiB and change) with at most `WINDOW` (256 KiB)
in flight, from the device's `taken` counts. A snapshot keeps the port's state, the bytes not yet taken and control
messages not yet sent; the guest's buffers come back with the core's held requests. What goes over it is the agent's:
[plans/clipboard.md](plans/clipboard.md).

#### The guest's agent

`webpc-agent` (`agent/`: a crate of its own, outside the core's workspace, with its own stable toolchain;
`images/build.sh agent`, docs/images.md "agent") is a static aarch64 musl binary with `rustix` as its one dependency.
A machine with clipboard sharing that has firmware fetches it (`web/app/guest-agent.ts` `agentBinary`: an ELF file or
nothing) and hands it to the guest as the fw_cfg file **`opt/webpc/agent`**, with a unit as SMBIOS credentials
(`agentCredentials`, frontend.md "What the page sets in the guest"); without the binary (not built) the machine starts
without the unit, its port never opened. The unit, `webpc-agent.service` (`Type=simple`, wanted by
`multi-user.target`): `modprobe -q qemu_fw_cfg` outside the sandbox (`ExecStartPre=-+`), then its script copies
`/sys/firmware/qemu_fw_cfg/by_name/opt/webpc/agent/raw` into `/run/webpc/agent` (a tmpfs of the unit's own,
`TemporaryFileSystem=` mode 0700 and `exec`: Debian 13 mounts /run `noexec`, so a `RuntimeDirectory` can't run it;
gone with the unit), waits for udev's link (`udevadm wait`) and `exec`s it. `Nice=10`, `MemoryMax=32M`,
`OOMScoreAdjust=500`, `Restart=on-failure`; sandboxed (`ProtectSystem=strict`, `ProtectHome=read-only`, private /tmp
and network, `RestrictAddressFamilies=AF_UNIX`, the kernel's tunables, modules, logs and clock protected, …:
`systemd-analyze security` 3.7, "OK") with the capabilities it needs: `CAP_SYS_ADMIN` for
TIOCSTI, `CAP_SETUID` and `CAP_SETGID` for the session children (no `NoNewPrivileges`), `CAP_KILL` to stop one (the
user's process by then); no DAC override.

The root process is one thread blocked in `ppoll` with no timeout, on the port, an inotify descriptor watching
logind's `/run/systemd/seats` and `/run/systemd/sessions` (`IN_MOVED_TO`, `IN_DELETE`: logind renames each file into
place) and `/proc/self/mountinfo` (POLLPRI when the mount table changes). It follows **the active session on seat0**
(`agent/src/logind.rs`): `seat0`'s `ACTIVE=`, that session's `UID=` and `CLASS=` (a user's, not a greeter's), whatever
its `TYPE` (a user logged in on a tty who runs sway has `TYPE=tty`), once the user's runtime directory
`/run/user/<uid>` is mounted (its owner the user: a `stat`, the agent's root having no `CAP_DAC_OVERRIDE`; the mount
is what the mount table's change says). For it the root process **forks a session child** (no exec), which closes the
parent's descriptors, drops to the user (`setgroups` to none, `setresgid`, `setresuid` to the directory's gid and the
uid) before it reads anything from the display, sets `PR_SET_PDEATHSIG`, and talks to the parent over a socketpair in
the port's own frames; the parent passes the clipboard's frames between the two (from the child only OFFER, REQUEST,
DATA, ACK, MORE) and answers them itself while there is no child (ACK `NO_SESSION`, DATA `FAIL`). A new active session
replaces the child (its socket closed, which ends it, then SIGKILL and reaped); a child that ends by itself (its runtime directory unmounted) isn't started again
for the same session. Each child's serials and request ids start at a base of its own (the parent's count << 24), so
a later child's never meet an earlier one's in the page.

**The session child** (`agent/src/session.rs`, one thread in `ppoll`) watches the runtime directory (inotify,
`IN_CREATE`, `IN_DELETE_SELF`: it ends when the directory goes) for a compositor's socket, `wayland-<n>`, and connects
(a socket that refuses, between its bind and its listen: 25 tries 200 ms apart, the only timeout); it comes and goes
with the compositor. Its Wayland client is written by hand (`agent/src/wire.rs`: the header, uint/object/new_id,
strings, `SCM_RIGHTS` for the pipes): `wl_display.get_registry` and a `sync`; when the callback is done, it binds the
first `wl_seat` (v1) and `ext_data_control_manager_v1` if the compositor has it, else `zwlr_data_control_manager_v1`
(v1; their messages are the same), and gets the seat's data device; without either it logs once and idles. Object ids
are never reused (a destroyed source is kept until `delete_id`, so a late `send`'s descriptor is still taken and
closed).

- **The guest's selection** (`selection` with a guest program's offer, not ours) with a text type (`clip::pick_text`:
  `text/plain;charset=utf-8`, then `UTF8_STRING`, `text/plain`, `STRING`/`TEXT`/`text`) is read at once up to 4 KiB and 1
  byte (`receive` into a pipe): whole and under 4 KiB it is an OFFER with its bytes inline (empty: nothing), unless its
  FNV-1a hash is that of the host's last text (echo suppression); longer, an OFFER of `text/plain;charset=utf-8` of
  unknown size, its bytes read again (`receive`) for each REQUEST and sent as DATA within the request's credit.
  A selection while our own source holds the clipboard is ours: dropped.
- **The page's OFFER** of text (`text/plain;charset=utf-8` or `text/plain`, at most 16 MiB) becomes a data source of
  ours offering `text/plain;charset=utf-8`, `text/plain`, `UTF8_STRING`, `TEXT`, `STRING` and `text`, set as the
  selection, then a `sync`: its callback's done sends ACK `HELD` (the page's paste chord waits for it). A guest
  program's paste (`send` with a pipe) gets the bytes from the cache (inline ones, or ones that crossed whole, up to 64
  KiB) or a REQUEST to the page, the page's DATA written into the pipe (nonblocking) and a MORE for each frame written
  whole; a reader that closes early gets the page a MORE 0. `cancelled` (another program copied) drops the source.
- **PAUSE**: the source's selection cleared (`set_selection(null)`) and the source destroyed, so a paste can't pull
  more of the host's text; transfers end (DATA `FAIL`, MORE 0); the guest's selections are ignored until RESUME,
  which sends nothing.
- **SESSION**: when the data device is bound, and when it goes (the compositor's connection lost, the seat's
  `finished`), the child's transfers end as at PAUSE and it sends SESSION; the parent sends one too when it stops a
  child or one ends.

Its frames are `agent/src/frame.rs`, the twin of `web/agent-frame.ts` (both tests pin the same bytes). Serials belong
to the side that offers, request ids to the side that requests:

| Frame | Payload | |
|---|---|---|
| HELLO (1) | u16 version, u32 capabilities (LE); later versions append; the page's may append an 8-byte nonce | the page sends it at each opening of the port (`AgentLink`), the agent answers with its own; a side speaks the lower version and ignores capability bits it doesn't know. Version 1; `CAP.TYPE` (bit 0), `CAP.TEXT` (bit 1: the clipboard's frames below) |
| SYNC (10) | the page's nonce | the agent's, before its HELLO when the page's HELLO had a nonce (`hello_answer`). The page sends one where the agent's stream may not begin at a frame: the port open in a restored snapshot (the device's `open` says `restored`: a snapshot can fall between the writes of one frame) and when its reader goes out of step; its reader then drops everything before the SYNC (`FrameReader.sync`) |
| SESSION (11) | none | the agent's: the guest's clipboard changed hands (above). The page forgets its echo hashes, drops its transfers, and syncs the host's clipboard again if it may read it |
| OFFER (2) | u32 serial, u8 flags (1: inline), u8 count, per type u8 length, the type, u32 size (`0xffffffff` unknown); inline: the rest is the first type's bytes | a side's clipboard changed: what it has. Text inline under 4 KiB (plan §2), else the other side REQUESTs it |
| REQUEST (3) | u32 serial, u32 id, u8 length, the type | the bytes of offer `serial`, please; the answer may send `CREDIT` (4) DATA frames before the requester's first MORE |
| DATA (4) | u32 id, u8 flags (1 END, 2 FAIL), at most 64 KiB | an answer, in order; FAIL: none (a stale serial, a type not offered, paused, past the cap) |
| ACK (8) | u32 serial, u8 status (0 HELD, 1 NO_SESSION, 2 PAUSED, 3 TOO_LARGE, 4 NO_TYPE) | the agent's answer to the page's OFFER |
| MORE (9) | u32 id, u32 count | the requester takes `count` more DATA frames for request `id`; 0 stops the answer |
| TYPE (5) | UTF-8 text, at most 64 KiB a frame (`typePayloads` cuts between characters, never inside a CRLF) | the agent puts it in the foreground VT's input (`/dev/tty0`, TIOCSTI a byte at a time), line ends as Enter (CRLF and LF become CR, as terminal emulators paste); paced by the terminal's unread input (`FIONREAD`, every 256 bytes: the line discipline drops what doesn't fit its 4 KiB), so a long paste into a reader that keeps up arrives whole and one that stalls a second loses the rest. Not UTF-8: dropped |
| PAUSE (6), RESUME (7) | none | while paused the agent drops TYPE and the clipboard's frames (above); the link refuses `type()` while paused and says PAUSE or RESUME at every opening of the agent's end (a restarted agent starts unpaused; a restored one is as its snapshot was, and the pause is the run's); the parent passes both to its child, and PAUSE first to a new child |

A frame's length that can't be (zero, past 64 KiB and 256) breaks the agent's reader: it closes and reopens the port,
which starts both directions afresh (the link resets at each opening; the session child stays). It breaks the page's
reader too, which begins afresh at a SYNC (above). A child's stream that
breaks, or more than 4 MiB queued for it, stops the child. The log lines of both go to the journal
(`webpc-agent: …`, the child's `webpc-agent: session: …`).

**The page's side** is `web/app/clipboard.ts` (`ClipboardShare`, the tests' `window.__clipboard`), over the link:
the guest's OFFER is written with `writeText` while the document has focus (requested first if not inline; a MORE for
each DATA frame), else kept as `pending` (what step 4 writes later); the page's own offers come from the **paste
chord** (by the key: Ctrl+V, Ctrl+Shift+V, Shift+Insert; on a Mac Cmd+V and Cmd+Shift+V only, `isPasteChord`):
`web/input.ts` holds the key without `preventDefault` (`hooks.hold`) and queues the key events that come meanwhile
behind it (the chord's Ctrl released after the V; a second press a second press), the browser's `paste` event at the
document while the screen's canvas has focus gives the text (`pasted`), the page offers it unless it is the last text
either way (a hash of each) or empty, and the key goes to the guest at the agent's ACK or after 300 ms (`ACK_WAIT`;
300 ms more if no paste event comes, `PASTE_WAIT`). An ACK that refuses is taken whenever it comes. The hashes stand
for what the guest's clipboard has: an offer forgets the guest's, the guest's copy the page's, and the port's opening
or closing, HELLO, SESSION and the pause forget both (and drop the transfers). The page answers the agent's REQUESTs
for its newest offer within their credit; its serials and request ids start at random (a restored agent may hold an
earlier page's). Nothing of this happens while the link is paused, closed, or the agent's HELLO lacks `CAP.TEXT`.

### clock (ID 17): virtio-rtc

`{type: 'clock'}` (`web/clock.ts`; Linux's `virtio_rtc`, 6.16 and later, with `CONFIG_VIRTIO_RTC`, which Debian's
kernels up to 6.17 leave out): no features (no alarms: the requestq alone), no config space. **One clock**, UTC as the
browser keeps it, typed `UTC_SMEARED` with the smearing unspecified (a JavaScript time value has no leap seconds, and
Linux makes its RTC device only for that type): Linux gives it a PTP clock (`Virtio PTP type 3/variant 0`, which
chrony's `refclock PHC` can follow, so the guest's time follows the browser's through snapshots and the host's own
sleep and NTP) and a read-only RTC. `CFG` says one clock; `CLOCK_CAP` its type; `CROSS_CAP` that it has no counter
cross-timestamps (chrony brackets plain reads then); `READ` the time in ns, `performance.timeOrigin +
performance.now()` re-anchored on `Date.now()` whenever the two part by more than 2 ms (`browserClock`: µs steps that
still follow a step of the host's clock). Everything else (READ_CROSS, the alarm requests) is EOPNOTSUPP, an unknown
clock ENODEV, a short request EINVAL, each as the 8-byte head alone (an OK response fills its whole struct: the driver
takes any other size as an error). Deterministic runs read a fixed time (2026-09-01). It is checked against the
driver's formats (`tests/clock.test.ts`), not yet against a running driver (backlog "Snapshots"). Machines have it as
a device kind of their own (docs/frontend.md "The guest's clock").

### blk (ID 2)
- Features `SEG_MAX` = 126, `RO` (or `FLUSH` when writable: an overlay, or a ramdisk); one queue of 128. `IN`, `GET_ID`,
  `OUT` and `FLUSH` when writable (`IOERR` without), the rest `UNSUPP`. `GET_ID` answers the spec's `serial` (a
  machine's attachment: `webpc-<attachment id>`, so `/dev/disk/by-id/virtio-…` survives a reorder;
  docs/machines.md §4.1), else `webpc-blk` (the tests' guests).
- **Sources** (`BlkSpec`): an image by `url` (HTTP ranges, or `file:` in Node) or `file` (a `File`), or
  `source` with a `size`: `zero`, a **blank disk** reading as zeros (writable through its overlay, as any image),
  or `ram`, a **ramdisk** (`web/ramdisk.ts`): writable in itself, with `DISCARD` and `WRITE_ZEROES`, its bytes in
  1 MiB chunks of shared memory made on a chunk's first write and dropped when a discard or a zeroing covers the
  whole chunk (a missing chunk reads as zeros), so an empty ramdisk costs nothing and `fstrim` gives the memory
  back. Past 4 GiB of those in one worker (`SAB_BUDGET`: a tab's ArrayBuffers share an 8 GiB pool), chunks are
  slots in shared wasm memories, reused by the ramdisk when dropped but not given back; a write with no memory to be
  had fails with IOERR and the page says so (`notice`). It is the device worker's, so every start, the guest's reboot too, finds it empty
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
  `node:fs`). The dev server answers `Range: bytes=` requests on `target/` (206/416, `Accept-Ranges`,
  HEAD: sirv, `vite.config.ts`). The device worker reads it through a **block cache** (`web/blockcache.ts`): the file in aligned 1 MiB blocks,
  the 256 MiB most recently used kept in memory, a read's missing blocks fetched in one request per run of adjacent
  ones; a read larger than the cache goes past it. A remote desktop boot's 2160 reads became 422 requests, and its
  time to Firefox 181 → 82 s at 47 ms a request (bench/remote-disk/REPORT.md "R1"). The import, export and disk-job
  workers (`web/app/sources.ts`) read without the cache.
  **In realtime mode, requests run in parallel and nothing blocks** (R4): the sources read with `fetch`
  (`Source.readAsync`), the cache fetches a block being fetched once and at most 8 at a time, qcow2 reads a request's
  L2 tables and merged ranges at once (`openDisk`'s `readAsync`), and the blk backend is `concurrent`: `Devices.poll`
  completes its requests as they resolve (virtio allows any order) and serves the other devices meanwhile. A read
  starts once the last write, flush or discard before it ended; those wait for every request before them (the overlay
  changes one request at a time; a FLUSH covers the writes completed before it). A snapshot's quiesce drains them
  first (`Devices.drain`, the device worker's `drain`). The deterministic mode keeps one request at a time in order
  (synchronous XHRs), as do the image's opening (header, L1) and Node. The device worker's longest answer during a
  remote boot went 0.7 s → 17 ms.
  **A chunked image's boot trace is fetched ahead** (R5): its manifest's `prefetch` (`tools/disk-trace.ts` writes a
  boot's reads there: 1 MiB blocks in the order it first read them) is fetched in the background from the opening
  (realtime only): runs of adjacent blocks a request each, at most 4 of the 8 fetches, the guest's reads first in the
  queue (slots granted in order), and into the store alone where there is one. **It runs a window ahead of the guest's
  place in the list** (`AHEAD_START` 16 blocks), not the whole list: the window widens by 8 each time the guest's read
  needs a block of the list from the network that the window held back (not fetched while the prefetch sat idle on
  it, or fetched only once the guest moved), up to 128 and never past half of what can hold the blocks (the store's
  slots, or memory's). A guest at a boot menu, or one a fast host keeps up with, costs a window; a slow host widens
  it. It stops if the store gives up. A synchronous read (the
  image's opening) of a block the prefetch is fetching fetches it itself. A remote desktop boot's first boot: 96 →
  65 s, a local file's time (bench/remote-disk/REPORT.md "R5"). A read that throws is an IOERR, not a failed device.
  **The blocks are kept in OPFS** (`web/diskcache.ts`), in a Storage Bucket of their own where the browser has
  them (Chromium): `remote-cache`, not persisted (the browser may take it back under pressure even when the origin's
  storage is kept, as the machines' disks are), expiring a week after its last use (pushed on as an image opens);
  elsewhere the origin's `remote-cache/` directory. Either way an image's cache unused for a week (its map's
  modification time, touched at opening) is deleted when the page next looks. The blocks are kept where the image has an identity that changes with it (a chunked
  image's id, or the URL, size and the server's `ETag` or `Last-Modified`; without one nothing is kept), so a reload, a
  second boot or a resume reads them locally: a block missing in memory is looked for there before it is fetched, and
  what is fetched is written there. `<root>/<key>/`: `data` in 1 MiB slots, `map` a u32 per block; a reused
  slot's old entry is cleared durably before its block is written, and the block before its entry, so a crash loses
  blocks but never maps one to other bytes (`tests/diskcache.test.ts`). Bounded at opening by what it holds plus a
  quarter of the free quota, at most 2 GiB: other images' caches go first (least recently used), then this image's
  slots are reused in the order they were filled. The device worker holds the image's Web Lock (`webpc-cache:<key>`,
  waiting 2 s for a restarting machine's old worker); another tab on the same image reads without it. **The guest's
  writes go first:** the store checks each write's count (Chromium's sync handles come back short or throw at the quota;
  off the record a refused write returns 4294967288, and a fresh incognito profile takes ~0.8 GB while `estimate()`
  reports 3.2) and gives up for the session on a refused one (map cleared, data cut off); a guest's write, zeroing or
  discard that fails makes every open store give up (`releaseStores`) and is tried once more, and a kept snapshot's, a
  suspended machine's, a restore's fork's or a snapshot file import's write does the same across workers (`makeRoom`:
  every image's cache, as Clear; docs/machines.md "Storage"). The Machines
  page's storage footer shows and clears it (a machine reading one is asked over a BroadcastChannel to give its store
  up); `?diskcache=0` turns it off (benchmarks). A remote desktop boot's second
  boot: 109 → 63 s, no requests (bench/remote-disk/REPORT.md "R3").
- **A chunked image** (`web/chunked.ts`, made by `tools/chunk-image.ts`; [remote-disks.md](remote-disks.md)): a disk URL
  ending in `.json` is a manifest (`webpc-chunked-1`: the file's size, the piece size, each piece's SHA-256, an
  `id` hashed from them, and a `name` the page shows: `--name`, or the image's file name) of the image file cut into equal pieces, `pieces/<sha256>.bin` beside it. It reads as one
  file under the block cache: a piece by range, or whole where the host answers a range with the whole file (as
  a Cloudflare Worker's static assets and Pages do: the images' host, vmdisks.tny.im), and then `Source.span` has the cache take the whole piece. `bootVm` sizes it from the
  manifest and its first piece; the URL check (`web/app/urlcheck.ts`) gives the manifest's `id` as the disk's `etag`,
  so a machine's disk identity follows the content. Not checked against the hashes yet (reads are synchronous;
  `crypto.subtle` isn't).
- **qcow2** v2/v3 (`web/qcow2.ts`, `core/tests/common/qcow2.rs`, detected by the magic): L1/L2,
  unallocated and zero-flag clusters as zeros, compressed clusters as raw deflate
  (`DecompressionStream('deflate-raw')`; `miniz_oxide` natively, a dev-dependency). A request's compressed
  clusters are inflated as one batch (an `Inflater`): where the thread can start workers (the device worker, the
  disk-in and disk-out workers) it shares the batch with up to four of `web/inflate-pool.ts`'s
  (`inflate-worker.ts`; started by the first request with two or more, each share one message; a single cluster
  stays on the reading thread), otherwise one after another in place (Node): 1 MiB reads 25% faster, an import 7%
  and an export 11%, a boot no different (bench/io/REPORT.md "The inflate pool"). Read-only
  (refcounts never read). **Refused at open:** encryption, backing files (a changes file is read by `readChanges`, docs/frontend.md "Your own disk"), external data files,
  extended L2, zstd, unknown incompatible features. Capacity is the virtual size. Debian's
  published image is 95% compressed clusters, which is why deflate is supported rather than
  converting the image. A request's clusters are read from the file in merged host reads (ranges within 64 KiB of each other, up to 8 MiB: an image's clusters mostly follow each other, so a 1 MiB read of Debian's image is one or two HTTP requests, not sixteen; a merged read that fails leaves its ranges to their own reads; one read per cluster natively), all L2 tables kept, the 16 most recent
  compressed clusters cached (1 natively).
- **Writable disks: a copy-on-write overlay** (`web/overlay.ts`) in an OPFS directory, 4 KiB
  blocks: `data` holds written blocks in slots, `map` a u32 per disk block (0 = base,
  n = slot n − 1, 0xffffffff = zeros without a slot), `meta` its **generation** (a u64, bumped and flushed before
  the first change of each opening: a write, a discard or a zeroing; an opening that only reads leaves it, so "the
  overlay is as it was at generation g" is two integers compared: docs/machines.md §3.3) and, for a stored
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
  Overlay names are OPFS paths: a stored machine's are `overlays/<id>` (docs/machines.md §2), a transient one's
  (the tests' `?machine=`) are single names as before; `overlayMeta(name)` reads the generation without opening it.
- **Stored disks** (`web/stored.ts`, docs/machines.md §4.4): an image copied into the browser is the same
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
  `52:54:00:12:34:56` by default, the link up. Each transmitted chain is a frame with the
  12-byte `virtio_net_hdr_v1` stripped (≤ 12 bytes, over 12 + 1518 without GSO, 12 + `MAX_PORT_FRAME` on a frame
  port, or past an IPv6 packet's largest, dropped). **A card on an IP port has two paths** (web/gateway.ts
  `FramePath`): the gateway's, and a frame port of its own that the port's other end hands over (`{type: 'frames',
  port}`: the local helper's client; `port` null drops the frames until one comes; `{type: 'gateway'}` brings the
  gateway back). **The link flaps** (STATUS's `LINK_UP` cleared, a config-change interrupt, set again `FLAP_MS`, 7 s,
  later: networkd waits out a carrier loss under 5 s when its lease's MTU isn't the link's original, as a tailnet's
  1280 isn't, and a 1 s flap was ignored at the boot's first lease; only under a driver, the user's OK of 2026-11-01) when the path changes, and when the gateway's lease moves
  to another address than the one it last acknowledged (`stale`: another connection on the adapter; the same
  address again, a reconnect, doesn't), so the guest asks for a lease at once: networkd drops the link's addresses on
  a carrier loss and asks on its return, which cuts its open connections, hence only when its address is stale
  anyway. A reset puts the link up. Frames for the guest wait for receive buffers (the oldest dropped past
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
  (`02:77:65:62:70:63`); a machine's adapter `n` (`NetSpec.gateway`) has its own, 169.254.0.<n+1> at
  `02:77:65:62:70:63` plus `n` (`gatewayOf`), and its echo backend leases 198.18.0.<15+n> (`echoLease`), so a guest
  with several cards tells them apart (docs/network-adapters.md §4). A lease with `routes` (`Routes`, per family: the
  client's `setPrimary(false)`, `routedLease`; for IPv6 alone, `unreached6`, web/reach6.ts) makes the gateway that
  family's router for those prefixes only (IPv6's at `pref6`, the adapter's rank's preference, `ranked`): option 121 without a default and no option 3, a router advertisement with
  lifetime 0 and a Route Information option per IPv6 prefix (systemd-networkd installs them). When the advertisement
  stops making the gateway the default router but carries routes, it goes out again a second later (port backends):
  networkd drops the default route's nexthop, which the routes from that same advertisement share, so they went with
  it, coming back ~11 s later (measured: 11 s, then 2 s with the repeat); the adapter the page picks as the primary (`primaryOf`: the first that reaches the
  internet, else the first connected) gives the default route. A machine with several adapters (`SEVERAL_ADAPTERS`) has
  its lease renewed every 10 s (`renewSeconds`, DHCP's T1; the lease lasts two minutes), so IPv4's default follows the
  primary within that; IPv6's moves with the advertisement. **Proxy ARP** answers every request except for the guest's own address
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
- **Our own `9P2000.L` server** (`web/9p.ts`, its memory tree's twin `core/tests/common/p9.rs`), **not a port of
  v86's**: v86's `lib/9p.js` is built on its large `FS` inode store, and the native runner needs a
  Rust twin anyway; ours was written from the protocol as Linux's v9fs speaks it (v86 and TinyEMU
  read as references, no code copied).
- Feature `MOUNT_TAG`, one queue of 128. One T-message per chain, the R-message into the writable
  buffers (Linux's zero-copy split is undone by concatenation). Messages: version (msize ≤ 1 MiB),
  attach, walk, lopen, lcreate, read, write, readdir (with `.`/`..`), getattr, setattr, mkdir, symlink, mknod,
  readlink, link, renameat, unlinkat, remove, clunk, flush, fsync, statfs, lock (always granted), getlock (always
  unlocked), xattrwalk and xattrcreate (where the tree has xattrs; `EOPNOTSUPP` where it hasn't); the rest
  `EOPNOTSUPP`, malformed messages `EINVAL`.
- **Readdir offsets are the tree's cookies** (`P9Entry`), not positions: a listing resumes after the entry it stopped at
  even when entries before it went (`rm -rf` removes as it lists). **`qid.version`** is the tree's (`version`): it
  changes when a file's contents or a directory's entries do, so a caching mount (`cache=loose`, `fscache`) sees
  changes. Times are seconds and nanoseconds both ways (Tsetattr's nanoseconds are kept).
- **xattrs** are the server's protocol and the tree's storage: Txattrwalk gives a value (or, for an empty name, the
  names, each ending in a NUL) to a new fid to read; Txattrcreate makes the fid one to write the value to, set at its
  clunk (`EINVAL` if fewer bytes came than announced; a value of 0 bytes removes the attribute, as QEMU's server does:
  setxattr(2) with an empty value is a removal here). `XATTR_CREATE`/`XATTR_REPLACE` answer `EEXIST`/`ENODATA` at the
  create; names past 255 bytes `ERANGE`, values past 64 KiB `E2BIG`, a missing attribute `ENODATA`.
- **`P9Server` asks a tree.** A synchronous tree answers at the step it was asked; an asynchronous one's requests overlap
  (`concurrent`), and a Tflush is answered after the request it names.
- **The in-memory tree** seeded from the spec (`{type: '9p', tag, files: {path: text}}`, `MemoryTree`); qid paths
  in creation order; readdir offsets per directory in the order entries came (`.` 1, `..` 2, then from 3; a rename takes a
  new one); a version per node counted up by writes, truncates and entry changes. In deterministic mode every timestamp
  is 2026-09-01 at 0 ns unless a Tsetattr gives one, so native and Chromium boots see the same bytes; otherwise times
  come from `performance.timeOrigin + performance.now()` (sub-millisecond). Its native twin answers
  `tests/p9/transcript.txt` (recorded by `tests/devices.test.ts`, `P9_TRANSCRIPT=write`) byte for byte
  (`core/tests/p9.rs`).
- **xattrs and POSIX ACLs** in the memory tree: any name, kept per node (hard links share them). v9fs passes
  `system.posix_acl_access`/`_default` to the server as they are unless mounted `access=client,posixacl` (then the
  client does all of it itself), so the tree does what a local file system does with them: a valid ACL only (`EINVAL`
  otherwise; a default ACL on a non-directory `EACCES`); an access ACL sets the mode's permission bits (the owner's,
  the mask's or the owning group's, the others'), and one the mode can say is dropped for the mode; `chmod` writes the
  bits back into the ACL; a new file, directory or node in a directory with a default ACL starts with it, narrowed by
  its create mode (Linux's `posix_acl_create`; a directory also takes it as its default; symlinks take none). The
  client applied its umask to that mode already, which a local file system wouldn't with a default ACL (QEMU's server
  has the same gap). Nothing enforces the ACLs but the client, and only with `posixacl`: the server checks no
  permissions at all.
- **The page's shared folders** (`{type: '9p', tag: 'webpc', folders, port}`, `FolderTree`): [shares.md](shares.md).

### input (ID 18)
- `{type: 'input', kind: 'keyboard' | 'tablet' | 'mouse' | 'touch', port?}`; eventq and statusq of 64. The keyboard
  has keys 1–248, the Num/Caps/Scroll Lock LEDs and `EV_REP`; the tablet `BTN_LEFT/RIGHT/MIDDLE/SIDE/EXTRA`,
  `REL_WHEEL` and `ABS_X/Y` over 0–32767; the mouse the same buttons, `REL_X/Y` and `REL_WHEEL`; the touchscreen
  `INPUT_PROP_DIRECT`, `BTN_TOUCH`, `ABS_X/Y` and `ABS_MT_SLOT` (10 slots), `ABS_MT_POSITION_X/Y` (0–32767) and
  `ABS_MT_TRACKING_ID` (Linux's virtio_input makes the slots from `ABS_MT_SLOT`'s range).
- **A config write (`select`/`subsel`) is a `DEVICE` exit that waits for the device worker even
  in realtime mode**: the driver reads `size` right after.
- Linux's driver freezes for a suspend by deleting its queues **without a reset** (`virtinput_freeze`): a queue turned
  off (QueueReady 0) drops its in-flight chains in the transport, so a completion for an event buffer the backend held
  is dropped (it would write a used ring the driver freed), and a snapshot of the suspended guest restores (a queue
  that isn't ready with chains in flight is a state the restore refuses). The resume resets the device, and the
  backend drops what it held.
- Events come from the port as [type, code, value] arrays (`web/input.ts` `attachInput` makes
  them from DOM keyboard, pointer and wheel events, keys by `KeyboardEvent.code`, a US PC
  layout; what's held is released when the element or the window loses the focus, and `chord`
  sends combinations the browser keeps, docs/frontend.md "Input"); they wait for event buffers
  (oldest dropped past 1024). LED status events go to the port (the page lights the on-screen keyboard's lock keys by them). The page's mouse lock and touches: docs/frontend.md "Input".

### virtio-gpu (ID 16): 2D, and 3D through virgl
What the guests do with it, and why it is built as it is: [graphics.md](graphics.md) "The 2D display".
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
  **Two rules keep fbcon's console whole** (graphics.md "The console and the display size"): fbcon's buffer
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
  second, and with the queue full it commits once per frame (graphics.md "Console scrolling and the flush pacing" has the numbers). Commands are never
  delayed, only their replies. `?gpu=nopace,q<N>` on the page changes both, for measurements.
- **A guest that composites with llvmpipe shows stale frames** (graphics.md "Guests that composite with llvmpipe"): Mesa's software GL rasterizes
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

#### virgl (3D)
How the guest's 3D gets drawn (the GPU worker, the renderer on WebGL2, the caps, queries, video, snapshots) is
[graphics.md](graphics.md); this is the device's side.
- `{type: 'gpu', …, virgl: true, caps?}` (`GpuOptions.virgl`, off by default so no guest's bytes or steps move; the
  page's 3D machines, and `?gpu=virgl-null`). Adds feature `VIRGL` (bit 0) and `num_capsets` = 2, and the 3D commands: `GET_CAPSET_INFO`,
  `GET_CAPSET`, `CTX_CREATE`/`DESTROY`, `CTX_ATTACH`/`DETACH_RESOURCE`, `RESOURCE_CREATE_3D`, `TRANSFER_TO_HOST_3D`,
  `TRANSFER_FROM_HOST_3D`, `SUBMIT_3D`. Errors as virglrenderer gives them (`ERR_INVALID_CONTEXT_ID` for an unknown or
  reused context, context 0 included); at most 1,024 contexts and 65,536 resources. No blob resources, `HOSTMEM` or
  context init: virgl's resources are guest-backed.
- **The capsets** are VIRGL (v1, 308 bytes) and VIRGL2 (v2, 1408 bytes) from one blob, `GpuOptions.caps` or else
  `virglCaps` (`web/virgl.ts`, the floor: graphics.md "The caps"); a page machine is given the caps its GPU worker
  built from the browser (`capsFromGl`). The renderer string is `webpc`.
- **The device checks, the host runs** (`web/virgl-host.ts`): the device validates every command and keeps its tables
  (contexts, resources and their backings) as for the null renderer, and hands the work to `Gpu.host`: contexts,
  3D resources, backings, attachments, transfers and submits, and with a host every scanout too (a 2D resource's
  pixels then live in shared memory, in the guest's format, and the host's screen reads them in place and draws them
  through the format's swizzle). Calls are ordered and answer nothing (graphics.md "The GPU worker").
  **A command with the fence flag** has its reply held until the host's fence resolves (everything before it has
  run: uploads read, read-backs written), and every reply behind it waits in order (the flush pacing is the same
  queue). Without a host it is the null renderer: streams walked and counted (`VirglStats`), 3D transfers counted,
  fences at once, a 3D scanout black.
- **Captures** (`Gpu.onCapture`; `GpuSpec.capture` posts them on the display port; `web/virgl-trace.ts`): the 3D
  control commands and the guest memory they read, the renderer's fixtures (`tests/virgl/`, graphics.md "Tools").
  `web/virgl-replay.ts` runs one through the device into a host.
- **A 3D cursor:** a compositor on virgl (sway on GLES) draws its cursor with GL into a 3D resource, and Linux
  transfers only dumb buffers, so `UPDATE_CURSOR` on a 3D resource reads its pixels back from the renderer
  (`VirglHost.read`, after the commands before it; QEMU's `virgl_renderer_get_cursor_data`) and shows them, unless
  another update came meanwhile.
- **Snapshots** (graphics.md "Snapshots with 3D in use"): with 3D in use (a context that submitted, or a 3D
  resource), `save()` (async) asks the host (`VirglHost.save`: the GPU worker, after every call before it and once its
  queries have their results) for the renderer's state, and adds the device's 3D tables (the resources' gallium
  fields, the contexts' attachments, the contexts that submitted). The contents are Uint8Arrays in the state, which
  the snapshot file carries as BLOB frames. A restore sends the state to the new host (`load`), which makes everything
  again in a fresh renderer, and tells the host what the scanout shows (the GPU worker draws the screen on a 3D
  machine). Refused (`unsaveable`, and `vm.snapshot` refuses with the reason) only while a context has video codecs or
  buffers, or with a host without `save`. Contexts that never submitted are made again; on the null renderer only the
  tables are kept. The caps the guest read are saved; a restore in a browser that can't back them (`capsBacked`) keeps
  them for the guest and turns 3D off (new contexts refused, a saved 3D state not loaded) rather than refusing the
  machine.
- **Video** (graphics.md "Video", [plans/video.md](plans/video.md)): the caps' `video_caps`, and video commands in the
  submits, which the device hands to the host like any other (a capture includes DECODE_BITSTREAM's buffers).
- No native twin (`core/tests/common/gpu.rs` is 2D): the device and renderer are tested in Node (`tests/gpu.test.ts`,
  `tests/virgl.test.ts` on a recording WebGL2) and Chromium (`tests/virgl-browser.test.ts`).

#### Venus (Vulkan, VK1–VK3)
- `{type: 'gpu', …, virgl: true, venus: true}` (`GpuOptions.venus`, off by default: a per-machine choice; without it
  the device is exactly the virgl one, bytes and steps unmoved). Adds features `RESOURCE_UUID` (2), `RESOURCE_BLOB` (3)
  and `CONTEXT_INIT` (4), a third capset, VENUS (ID 4, version 0, 160 bytes: `GpuOptions.venusCaps`, the renderer's
  `vkr_get_capset`; web/venus.ts `venusCapset` by default), the host-visible window as the transport's shared memory
  region 1 (`bootVm` gives such a machine `VENUS_WINDOW`, 256 MiB, unless told), and the commands Venus's kernel path
  uses: `CTX_CREATE` with `context_init` (capset 4 makes a Venus context, 0 to 2 a virgl one, others
  `ERR_INVALID_PARAMETER`), `RESOURCE_CREATE_BLOB` (host memory of a Venus context only: `BLOB_MEM_HOST3D`, no entries,
  whole pages, at most 4 GiB together; guest-memory blobs aren't offered, the capset says no guest VRAM),
  `RESOURCE_MAP_BLOB` (a mappable blob, into the window at the guest's offset: page-aligned, inside it, over no other
  mapping; answers `MAP_CACHE_CACHED`), `RESOURCE_UNMAP_BLOB`, `RESOURCE_ASSIGN_UUID` (the resource ID in a fixed
  pattern), and `SUBMIT_3D` to a Venus context, whose bytes go to the host as they are (the renderer decodes Venus).
  `SET_SCANOUT_BLOB` is `ERR_UNSPEC`. A fenced reply on a ring (`FLAG_INFO_RING_IDX`, Venus's timelines) answers with
  its ring.
- **The renderer owns the blobs' bytes** (web/virgl-host.ts `VenusCall`): it gives a blob storage when it is made, and
  a map copies it into the window at the guest's offset and makes that the blob's storage until the unmap copies it
  out (wasm can't remap pages, and Linux picks the offset). So a create, a map, an unmap, an unref and a Venus
  context's destruction hold their reply until the host has run them, fence flag or not.
- Snapshots are refused while a Venus context exists ("the machine is using Vulkan (Venus), whose state can't be saved
  yet"; docs/backlog.md).
- A virtio reset (a guest reboot) ends every Venus context, with its blobs, imports and objects
  (web/venus-host.ts `VenusRenderer.reset`; VK4 T2): vkr refuses a context id it has, so the rebooted guest's
  contexts weren't made, and the old rings would have been polled over memory the new guest reuses.
- **The renderer** ([vk/README.md](../vk/README.md); web/venus-host.ts `VenusRenderer`): virglrenderer's `vkr` and our
  Vulkan driver (Mesa's runtime) in one wasm module (`vk/build.sh` → `target/vk/venus.wasm`), which the GPU worker
  fetches on the device's `venus-init` and instantiates **on the VM's memory 1**, its own: its stack, data and heap in
  the arena at memory 1's bottom (web/ram.ts `VENUS_ARENA`, 1,280 MiB; `vk/wasi/arena.c` stops the heap there), the
  window after it, then node 1's RAM if the machine has one ("The host-visible window" below). Memory 0 holds as much
  RAM with Vulkan as without; untouched arena pages cost nothing. web/venus-host.ts refuses a module with another
  arena (`venus_arena_end`): one built for memory 0 would write its data over the core's heap, and one with a larger
  arena would grow its heap into the window. So the guest's rings, command streams and mapped memory are the module's own pointers, read in place.
  vkr's threads are polls: a submit, a notify, a completion or a fenced command polls the rings, and the worker keeps
  polling while one is active or a submit is in flight (`venus_poll`; web/venus-host.ts `VenusPoll`: turns ~0.08 ms
  apart on the Mac, ~0.17 on Linux, timed by a ticker worker of its own, web/venus-ticker.ts, since `Atomics.waitAsync`'s
  own timeout takes ~1.5 ms on the Mac and every synchronous Venus call of the guest waits a turn, VK4 T13; never a
  nested `setTimeout`, whose ~4.5 ms clamp made every fence late, VK3 L2), and nudges WebGPU with an empty submit at most every 1 ms while one is in flight (Dawn on Vulkan says done only
  at Chromium's slow look otherwise). vkr's ring monitor, which tells Venus's watchdog in the guest the renderer lives,
  is the ticker too: it sets the monitored rings' alive bits every second from its own thread, whatever the GPU worker's
  thread is doing (GD G3: a 5 s createShaderModule in the GPU process blocked it and the guest aborted Godot; vk/README.md
  "Calls and rings"). A ring fence's reply is out of line (the only one that is: `rings` in `gpuBackend`): it stands for a queue's work, which
  may wait for the guest's own signal (a held submit, vk/README.md "Waits before their signal"), and held in order it
  held what follows, including the unfenced `SUBMIT_3D` every queue submit also sends, so 8 such submits filled the page's
  16 entries and the guest stopped in the kernel before it signalled. The kernel takes fences of different rings in any
  order. A program that queues work waiting for its own signal, from the thread that sends it, could fill the queue and stop
  that thread in the kernel, so while the queue is full and for 250 ms no ring fence has retired and the guest has sent
  nothing (`RING_STALL_MS`), the second newest of the ring with most is answered with no fence flag: its entry comes
  back, its fence stays unsignalled in the kernel, and the next fence of that ring to be answered signals it (a fence
  signals the earlier ones of its dma-fence context). The newest of a ring always keeps its entry. Only then, and one at a
  time: giving entries back whenever more than 8 were held hung dEQP's `timeline_semaphore.device_host`, whose guest waits
  for such a fence alone while its fences go on retiring.
  A fenced `SUBMIT_3D`'s reply waits for vkr to retire its fence,
  which happens once the GPU's work before it on that context's ring is done (`VenusRenderer.retired`: the GPU worker
  holds the device's fence until then). A fence names its context, ring and id (`FenceScope`) and waits for itself alone, not for what's sent after it on its ring, and a ring is a lane of the GPU
  worker's `FenceGate`, so a held submit holds its own ring's fences only: virgl's fences wait for virgl's queries,
  and a hold of the device's (a blob's create, map, unmap or unref, a context's end) for nothing but the calls before
  it. A Venus fence without `FLAG_INFO_RING_IDX` (Mesa's Venus sends none) is of the guest's global dma-fence context
  with virgl's, and stays in their order. The render stats (`?displaystats`) carry the way back a second (`venus`: submits done in, polls apart,
  nudges, fences retired in, and a submit's parts: encoding, `queue.submit`, writes, passes, draws, the GPU's ms with
  `?gpu=vkgputime`; `?gpu=vknudge=<ms>` sets the nudges' period, VK3 L2b). At each queue submit the driver takes the window's written pages (web/window.ts) and uploads them.
  Calls that come before the module is ready wait in a backlog, and so does the device's fence. The driver's
  pipelines are made asynchronously and a submit drawing with one not yet ready is held, in order (VK3 L3); the
  translated shaders persist across runs in IndexedDB `webpc-shaders`, the origin's, deflated (`venusPipelines` in the
  render stats; vk/README.md "Pipelines made asynchronously", "The shader cache"). A render pipeline is made when its
  draw is recorded (`?gpu=vkpremake=on`: at `vkCreateGraphicsPipelines` too, a loss measured by VK4 T17).
- **The driver** (vk/README.md "The driver"): Vulkan on the GPU worker's WebGPU device (web/venus-gpu.ts; with no
  adapter it keeps the objects and draws nothing). What it advertises follows the browser's WebGPU device, its limits
  and features read at the renderer's start (vk/README.md "The driver"; VK2 L7), less what the translator can't do yet,
  formats as WebGPU has them, plus what Venus's WSI shares through (dma-buf memory with the LINEAR modifier, foreign
  queue transfers, sync-file semaphores); the adapter's subgroups (held where the page's check at Venus's start finds
  them wrong in divergent control flow, VK3 L5), 16-bit storage and floats, tier2's read-write formats; texel buffers,
  per-face stencil and occlusion queries (VK3 L6); Dawn's row (VK3 L7.1: dynamically indexed descriptor arrays,
  sample-rate shading); YCbCr conversions and the 8-bit multi-planar formats (VK3 L7.2, by default since
  L7.3; `?gpu=vkycbcr=off` holds them); ANGLE's ES3 row (VK3 L7.4: the last vertex provoking, transform feedback, 13
  uniform buffers a stage); vkd3d's row (VK3 L7.5: draw parameters); the binding limits from one count of what WebGPU
  takes, a pipeline past them refused at creation (VK3 L7a); GTK4 stays on GL (it takes Vulkan only with a modifier other than LINEAR). vkcube on
  sway (headless, pixman, `MESA_VK_WSI_DEBUG=sw`) runs ~50 frames/s on 2 vCPUs on SwiftShader's WebGPU
  (`tests/page-venus.test.ts`); in VK1, with the null driver, on the desktop guest's sway (GLES, virgl) vkcube and
  GTK4's Vulkan renderer presented through dma-bufs at the display's 60 (bench/vulkan/apps-load.ts,
  bench/gpu/gtk4-load.ts with `VIRGL_GPU=virgl,vulkan`).
- **Presentation** (VK2 L4, [vk/README.md](../vk/README.md) "Presentation"): the compositor imports a Vulkan program's
  WSI image, a Venus blob, into its virgl context (the kernel's `CTX_ATTACH_RESOURCE`, which the device doesn't pass to
  virgl: the blob isn't a 3D resource) and types it with `PIPE_RESOURCE_SET_TYPE` in a submit; the virgl renderer then
  makes a texture of it and web/venus-share.ts fills it from the image's WebGPU texture (the driver's
  `venus_resource_texture`: the image bound to the memory the blob was exported from) whenever the driver has
  written it since, by one of three ways (bitmap, canvas, readback), a GPU way checked at its first copies against a
  readback and dropped for the next if it copies wrong. The device never reports NVIDIA's vendor ID: Venus's guest
  driver would then export a buffer it copies each frame into (the prime blit) instead of the image, which isn't
  shared (black windows on the user's NVIDIA desktop, VK3 L1). The desktop guest turns the guest driver's async present
  off (`VN_PERF=no_async_present`: Mesa 26's drops a present after one that failed, freezing a resized window, VK3 L4e;
  vk/README.md "The guest's Mesa"). The blob's unref drops the texture too. No guest scans a Venus blob out (`SET_SCANOUT_BLOB` stays
  `ERR_UNSPEC`): sway composited vkcube's tiled window; a fullscreen window, which wlroots may scan out directly, isn't
  tried yet (docs/backlog.md).
- **Imports** (VK2 L6, [vk/README.md](../vk/README.md) "Imports"): the other way, a virgl resource attached to a Venus
  context (a VA-API surface's plane that mpv on Vulkan imports as a dma-buf) isn't attached in virgl: the device hands
  it to Venus's renderer as `blob-ctx` with its size (its backing's pages, or its texels at 4 bytes, whichever is more),
  which makes it a dma-buf resource of the context; the driver's images on memory imported from it are written with
  the resource's bytes (web/venus-import.ts). A detach drops it there.
- On the page: a machine's Vulkan setting (the Machines page, beside 3D: `MachineRecord.vulkan`, in its shape) or
  `?gpu=vulkan` (with 3D on) gives it Venus (web/app/worker.ts); the module is fetched only then, and is in `npm run
  dist`'s copy (vk/README.md "On the page").
- Linux's driver says, for the gpu test kernel (`tests/venus.test.ts`): `Host memory window: 0x50000000 +0x10000000`,
  `features: +virgl +edid +resource_blob +host_visible`, `+context_init`, `cap set 2: id 4, max-version 0, max-size 160`.

#### The host-visible window (Venus, VK1)
For Vulkan through Venus ([graphics.md](graphics.md) "Vulkan through Venus"): guest-visible memory that the host renderer and the
guest share without copies (Venus's ring, its command streams, its reply buffers, and the Vulkan memory a program maps).
- **Its size** (`VENUS_WINDOW`, web/ram.ts): 1,280 MiB, the device's 1 GiB host-visible heap whole and 256 MiB for
  Venus's rings, command streams and replies. Linux's virtio-gpu gives each mappable blob its place in the window when
  the blob is made (`virtio_gpu_vram_map` from the create, `drm_mm` over the region) and frees it at the blob's end, and
  Venus makes a memory's blob at its first map: so the window caps the host-visible memory mapped at once, past which
  the create fails and the map returns `VK_ERROR_OUT_OF_DEVICE_MEMORY`. At 256 MiB (VK1 to GD G7) Godot's VMA, which
  keeps its 128 MiB blocks mapped for good, failed its third (the GI demo's "Couldn't map buffer memory (VkResult error
  -2)", GD G8); `tests/venus/vkmap.py` maps 768 MiB at once (tests/page-venus.test.ts). Untouched pages cost nothing;
  node 1's RAM moves to later spill memories (memory 1 holds 1,536 MiB of it at most).
- **Where it is** (`VmConfig.window`, ABI 53; `window_at`, ABI 55): at the guest PA after RAM, outside the DT's
  `/memory`; its bytes are **memory 1's**, after the renderer's arena (`window_at`) and before node 1's RAM, so the
  renderer reads them in place and memory 0 gives none of its 4 GiB to Vulkan (VK4 T19). The virtio-gpu transport
  reports it as shared memory region 1 (`VIRTIO_GPU_SHM_ID_HOST_VISIBLE`; `DeviceEntry.shm`), and Linux maps blobs into
  it. The guest reaches its pages as node 1's: JIT code through the memory-1 arm of each load and store, the core
  through the spill accessor ([spill-memories.md](spill-memories.md) "The JIT's spill arm"); every Vulkan machine's
  JIT modules carry that arm. Memory 1 rather than a memory of its own because the JIT inlines memory 1 alone.
- **The write-watch** (core/src/mem.rs `Watch`, core/src/mmu.rs `fill_watched`, web/window.ts): mappings are coherent,
  so the guest never says what it wrote, but WebGPU needs the written bytes uploaded at each submit. A write to a
  window page fills the vCPU's write TLB entry as for any page, and the vCPU records it (at most 64; then it drops them
  all first); dropping a recorded entry marks the page in a bitmap. To look (`WindowWatch.take`), the host bumps the
  watch's generation and waits for every vCPU whose running word is set to ack it: a vCPU checks the generation at
  each chunk boundary (`Tlb::catch_up`, in `drain`), drops its recorded entries and acks. A vCPU also drops them as it
  leaves its run loop, before it clears its running word, so an idle vCPU is never waited for. Then the host swaps the
  bitmap's words out. The marks are the pages written since the last look, plus pages whose entry was dropped
  without a write since; writes through an entry after the look reach the next one, since the entry was dropped
  first. A page-crossing store translates both pages before writing either (`Mmu::span`); when the second page's
  record overflows the 64, dropping the first page's with the rest, `span` translates the first page again, so its
  record outlives its store (else a look between the mark and the store would report the page with its old bytes,
  and the next look not at all). A vCPU that runs on without reaching a chunk boundary within the host's bound (100 ms) makes every page count
  as written. Writes with the MMU off (the JIT's flat path) and devices' writes aren't watched: nothing writes the
  window that way.
- **What it costs:** a machine without a window pays a compare on each TLB fill and an `Option` test at each chunk
  boundary (measured: VK1's report). With one, a page's first write after each look takes a TLB miss.
- **Tests:** `tests/baremetal/watch.c` (`// window`: phases that store to chosen pages in hot loops, a page-crossing
  store, LSE and exclusive atomics, 80 pages in one phase (past the 64 records), and STP Q, STR Q and ST1 across
  pages, DC ZVA, STLR, CASP, STXP and STTR), driven by `core/tests/baremetal.rs` `window_watch` (round-robin and parallel,
  the interpreter and the block interpreter) and `tests/window-watch.test.ts` (wasm: the interpreter, the block
  interpreter and the JIT); each look must report exactly the phase's pages. `core/src/mmu/tests.rs`
  `watched_page_crossing_store_after_overflow` looks between a page-crossing store's translations and its bytes.

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
  virtio-gpu (above) is the display for guests with the driver (the page's Debian: docs/frontend.md "The
  screen").
- The Buildroot test kernel has no fbcon (drawing the boot log would cost the boot test).

## Validation and oracles

Unit tests on hand-built rings (`core/src/virtio/tests.rs`: 13 malformed shapes, each ending in
NEEDS_RESET), `cargo fuzz run virtqueue`, Node tests of the 9p server, loopback adapter, input
config, overlay and qcow2, and the guests' device scripts natively, in Node and in Chromium
([testing.md](testing.md)). QEMU TCG (`virtio-*-device`, `-netdev user`, `-fsdev local`) runs the
same device scripts to the same output, up to the framebuffer (`virt` has none).
