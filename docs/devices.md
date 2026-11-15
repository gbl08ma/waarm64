# virtio devices and host backends

How guest I/O works, as built: virtio-mmio transports in the core, backends in TypeScript in a
device worker (twinned in Rust for the native runners), and the display and input glue on the
page. The ring and record layouts are in [abi.md](abi.md) "Device backends".

## The split between core and host

- **In the core** (`core/src/virtio.rs`, on the vCPU thread): virtio-mmio v2 transports (magic,
  version 2, device and vendor ID `WA64`, feature select and negotiation with `FEATURES_OK`
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
- **Across a suspend** (`Transport::suspending`, `carried`): Linux's resume resets every virtio-mmio device
  (`virtio_device_restore`: reset, ACK, DRIVER, the features, the driver's `restore`, DRIVER_OK), and a driver without
  `restore` never sets its queues up again: in Linux 6.18 virtio-gpu (a black screen after the first resume, and
  whatever waits on a GPU fence hangs: a login manager's stuck task) and 9p. virtio-pci avoids it with PCI PM's
  No_Soft_Reset (the device keeps its state, neither freeze nor restore runs; QEMU's `x-pcie-pm-no-soft-reset`);
  virtio-mmio has no such bit, so the transport does the same: when the guest enters SYSTEM_SUSPEND
  ([platform.md](platform.md) "System suspend") each device live then (DRIVER_OK) is marked, and its next reset is
  **carried**: the guest sees status 0 and negotiates again (QueueReady reads 0), but the queues, the chains in flight,
  the epoch and the backend go on. DRIVER_OK with the same features ends it: the device runs on, and the buffers made
  available meanwhile are posted. A queue's register written first (QueueSel included: a driver with `restore`, which
  sets its queues up) or other features at FEATURES_OK make it a reset there and then, at the status the guest has
  written. Only a reset after a suspend is carried: Linux frees a queue's rings only after turning it off (`del_vqs`
  writes QueueSel), but a kexec'd kernel would find a device still writing into the old one's memory. A suspend Linux
  aborts after its devices' suspend (a wakeup event) resets them without a SYSTEM_SUSPEND: that one isn't carried.
  Saved in snapshots (format 6; a format-5 state of a suspended guest has its live devices marked at the restore).
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
  (`web/vm.ts` `DeviceSpec`; `guestDevices` and `testDevices` build the tests' sets). A `MessagePort` (or canvas) a
  spec carries must be in `web/devices.ts`'s transfer list (the `specs.flatMap` beside `DeviceSpec`'s transfer), or
  every machine with that device fails to start with a DataCloneError.

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

### The guest's agent (over vsock)

The guest agent is a program of ours the page starts in a `firmware` machine's guest at each boot (`MachineRecord.agent`,
on unless `false`; a transient machine's `?agent=0` or `1`, which is over a stored machine's too). It isn't a device:
it connects to the page over the machine's vsock (above, `AGENT_PORT`), so turning it on or off changes no machine's
shape. It sets the guest's clock (TIME, below; frontend.md "The guest's clock"), on a machine that shares the
clipboard (`MachineRecord.clipboard`, `?clipboard=1`; what the page's HELLO says) shares it ([clipboard.md](clipboard.md)),
and on one with virtio-gpu's screen sets the session's outputs to the page's size (DISPLAY, "The screen's size" below);
it says when the guest's graphical session is up (DESKTOP, "The desktop's state" below), it trims the guest's
filesystems when the page asks (TRIM, "Disk space handed back" below), it grows a disk the page grew into its new space
(GROW, "A disk grown" below), it names the guest's OS (OS, "The guest's OS"
below), and it powers the guest off or reboots it cleanly for the toolbar (POWER, "Power off and restart from the
guest" below).
The page's end is `web/app/agent-link.ts` (`AgentLink`, the tests' `window.__agent`), made by
`web/app/areas/agent-actions.ts` for each run: frames (`web/agent-frame.ts`: a u32 length, a u8 type, the payload of at
most 64 KiB and change) with at most `WINDOW` (256 KiB) in flight, from the device's `taken` counts. Each connection is
a stream of its own, begun at a frame: a restore resets the guest's transport (the device's TRANSPORT_RESET), and the
agent connects again; nothing of a connection is kept in a snapshot. Its asks (LEASE, TRIM, COPY, POWER) are answered by
type, an answer each: one that gave up still has its answer coming, which the next ask of its type doesn't take (a
COPY's stale screen); a connection's end and the run's (the link's `close`) settle them, and its `onClose` listeners
take down what the page shows the agent can do (the storage bar's trim, Power off's clean shutdown).

`waarm64-agent` (`agent/`: a crate of its own, outside the core's workspace, with its own stable toolchain;
`images/build.sh agent`, docs/images.md "agent") is a static aarch64 musl binary with `rustix` as its one dependency, `no_std` (`agent/src/rt.rs`: 203,552 bytes, its gzip 120,101, 2026-11-15).
A `firmware` machine with the agent on fetches it at a boot (not at a restore, whose guest has its own: `web/app/guest-agent.ts` `agentBinary`: the build's gzip (an ELF file a server decoded is gzipped), or
nothing) and hands it to the guest as the fw_cfg files **`opt/waarm64/agent.000`**, `.001`, … (its gzip in pieces of
4 KiB: `agentFiles`), with a unit as SMBIOS credentials
(`agentCredentials`, frontend.md "What the page sets in the guest"); without the binary (not built) the machine starts
without the unit, and nothing connects. The unit, `waarm64-agent.service` (`Type=simple`, wanted by
`multi-user.target`): `modprobe -q qemu_fw_cfg` outside the sandbox (`ExecStartPre=-+`), then its script copies
the pieces (`…/by_name/opt/waarm64/agent.[0-9][0-9][0-9]/raw`, in the glob's order) into `/run/waarm64/agent` (a tmpfs of the unit's own,
`TemporaryFileSystem=` mode 0700 and `exec`: Debian 13 mounts /run `noexec`, so a `RuntimeDirectory` can't run it;
gone with the unit) and `exec`s it. `Nice=10`, `MemoryMax=32M`,
`OOMScoreAdjust=500`, `Restart=on-failure` (`RestartSec=5s`) under a start limit it can reach, 5 starts in 10
minutes (`StartLimitIntervalSec=`, `StartLimitBurst=`: systemd's default, 5 in 10 s, starts 5 s apart never reach,
and a failure that lasts would restart for the boot, each start reading the binary out of fw_cfg again, ~0.3 s of a
vCPU); sandboxed (`ProtectSystem=strict`, `ProtectHome=read-only`, private /tmp (with the host's `/tmp/.X11-unix`
bound in read-only, `BindReadOnlyPaths=-`: an X session's socket, where a session child connects),
`RestrictAddressFamilies=AF_UNIX AF_VSOCK` (no `PrivateNetwork`: a kernel with vsock namespaces would keep a private
network namespace from the host's CID), the kernel's tunables, modules and logs protected (not the clock, which it
sets), …) with the capabilities it needs: `CAP_SYS_TIME` for the clock, `CAP_SYS_ADMIN` for TIOCSTI, `CAP_SETUID` and
`CAP_SETGID` for the session children (no `NoNewPrivileges`), `CAP_KILL` to stop one (the user's process by then),
`CAP_SYS_TTY_CONFIG` for the consoles' keymap (KEYMAP's `loadkeys`: KDSKBENT), `CAP_SYS_BOOT` for POWER's request
(logind grants a power-off to a caller that has it; else polkit decides, and a guest may have none), `CAP_SYS_RESOURCE`
for GROW's ext4 resize ("A disk grown" below); no DAC override.

**Its connection** (`agent/src/vsock.rs`: `struct sockaddr_vm` of its own, which rustix lacks): a stream to the host's
CID 2 on `AGENT_PORT` (8574), blocking. When it ends (the page's reset, a restore's transport reset, the page gone) the
agent connects again at once, then while connecting fails (the vsock driver not loaded yet, a page with no end for it:
the device refuses) at waits that double from 0.5 s to 30 s, logging the first failure of a run. What lasts across
connections (the pause, the session child) stays; the page's HELLO at each connection says the rest.

The root process is one thread blocked in `ppoll` with no timeout (but 1 ms ticks while a paste is typed: TYPE
below), on the connection, an inotify descriptor watching
logind's `/run/systemd/seats` and `/run/systemd/sessions` (`IN_MOVED_TO`, `IN_DELETE`: logind renames each file into
place; an `IN_Q_OVERFLOW` counts as a change) and `/proc/self/mountinfo` (POLLPRI when the mount table changes). Where
the page's HELLO has `CAP.TEXT` or `CAP.IMAGE` (the machine shares the clipboard), `CAP.DISPLAY` (the screen's size
is followed) or `CAP.DESKTOP` (the desktop's state: every page says it), it follows **the active session on seat0**
(`agent/src/logind.rs`): `seat0`'s `ACTIVE=`, that session's `UID=` and `CLASS=` (a user's, not a greeter's), whatever
its `TYPE` (a user logged in on a tty who runs sway has `TYPE=tty`), once the user's runtime directory
`/run/user/<uid>` is mounted (its owner the user: a `stat`, the agent's root having no `CAP_DAC_OVERRIDE`; root's
bare mount point is root's too, so root's directory counts as mounted once it is on another device than `/run/user`;
the mount is what the mount table's change says). For it the root process **forks a session child** (no exec), which closes the
parent's descriptors, drops to the user (`setgroups` to none, `setresgid`, `setresuid` to the directory's gid and the
uid) before it reads anything from the display, sets `PR_SET_PDEATHSIG`, and talks to the parent over a socketpair in
the connection's own frames; the parent passes the clipboard's frames between the two (to the child the page's HELLO and
DISPLAY too, and to a new child the last of each first: it starts after the connection's HELLO; from the child only
OFFER, REQUEST, DATA, ACK, MORE, SESSION, and DESKTOP, which it keeps and says itself) and answers them itself while there is no child (ACK
`NO_SESSION`, DATA `FAIL`). A new active session
replaces the child (its socket closed, which ends it, then SIGKILL and reaped); a child that ends by itself (its runtime directory unmounted) isn't started again
for the same session. Each child's serials and request ids start at a base of its own (the parent's count << 24), so
a later child's never meet an earlier one's in the page. **Its jobs** (`session::Jobs`, from the HELLO: the clipboard,
the screen's size, the desktop's state) are fixed at its start: a HELLO with none stops the child, one with other jobs
starts it afresh (a child without the clipboard binds no data-control and connects to no X server for it).
Its tests (`agent/src/serve_test.rs`) run the root loop natively: a socketpair for the connection, a recorder for the
clock, directories of their own for logind's and the runtime directories, a console of
their own, and a child on a thread that echoes what it gets.

**The session child** (`agent/src/session.rs`, one thread in `ppoll`) watches the runtime directory (inotify,
`IN_CREATE`, `IN_DELETE_SELF`: it ends when the directory goes) for a compositor's socket, `wayland-<n>`, and connects
(nonblocking: a compositor stopped with its backlog full refuses rather than holding the child's one thread; a socket
that refuses, between its bind and its listen: 25 tries 200 ms apart, armed when a socket comes or the connection
goes, not again by a failed try: a killed compositor's socket, which refuses for good, is given up after them; the
only other timeout is X11's owner wait, below); it comes and goes
with the compositor. Its Wayland client is written by hand (`agent/src/wire.rs`: the header, uint/object/new_id,
strings, `SCM_RIGHTS` for the pipes): `wl_display.get_registry` and a `sync`; when the callback is done, it binds the
first `wl_seat` (v1) and `ext_data_control_manager_v1` if the compositor has it, else `zwlr_data_control_manager_v1`
(v1; their messages are the same), and gets the seat's data device; without either it logs once and turns to X11
(below). Object ids are never reused (a destroyed source is kept until `delete_id`, so a late `send`'s descriptor is
still taken and closed).

**X11** (`agent/src/x11.rs`, by hand: the core protocol, little-endian, no Xlib, xcb or x11rb) is the child's way where
the session has no compositor, or one without data-control (its registry's roundtrip came without either manager);
where data-control exists, Wayland's way stays, and an X connection gives way to a compositor's data device (the
compositor syncs Xwayland's selection with its own). The child watches X11's sockets' directory, `/tmp/.X11-unix`
(inotify `IN_CREATE`; the unit's bind of it), and takes **the session's display**: the one its session file names
(`DISPLAY=`, a display manager's X11 session: logind's `DISPLAY=`, which the parent passes), else a socket `X<n>`
that a process of the user's names (its `DISPLAY`, or an argument `:<n>` as a server's command line has it: Xorg's
from startx, Xvfb's, Xwayland's; `/proc/<pid>/cmdline` and `environ`, read as the user, at each socket's coming),
and only a socket of root's or the user's own (`/tmp/.X11-unix` is anyone's to bind in: another user's listener at a
display not up yet would get the cookie); connected nonblocking, as Wayland's. **The cookie** (`MIT-MAGIC-COOKIE-1`) comes from the server's `-auth` file, a process's `XAUTHORITY`, or the
`.Xauthority` of a process's `HOME` or of the user's home (`/etc/passwd`): the entry for the display's number, this
host's first, else any local one, else a wildcard; none if none has one (a server without access control: Xwayland
under sway). A server that refuses the setup (the cookie not there yet) is tried again by the 25 retries, then left
until its socket comes again. The connection: the setup, the atoms it knows types by (interned: the text's names,
the images', `text/html`), XFixes' `QueryVersion` and `SelectSelectionInput` on **CLIPBOARD** (PRIMARY isn't
shared), seven InputOnly windows (one owns the selection; one for each of six conversions at once, since an owner
keeps one transfer per requestor window, as xclip's INCR does), and `GetSelectionOwner` (the owner when the watch
began), after which SESSION. A new owner (XFixes' SelectionNotify; its window destroyed or its client gone: no owner)
is a new offer, whose `TARGETS` are converted: the names known are its types, as a Wayland offer's (however many
others the list has: GTK's names every gdk-pixbuf format). A **conversion**
is a pipe, as Wayland's `receive`: ConvertSelection to a conversion window's property (with the owner's selection
time), and at its SelectionNotify `GetProperty` in 64 KiB pieces from its offset (deleted with the last), the next
asked only once the pipe took the last; an `INCR` property is read chunk by chunk as each new value comes
(PropertyNotify), until an empty one; a reader that goes during INCR leaves the transfer read to its end into nothing
(its owner waits for each chunk to be taken). A conversion waits (queued, six at most) while the owner is busy with
another of ours (one not answered yet, or an INCR not ended): Debian 13's xclip (0.13) serves one INCR at a time and
drops the requests that come meanwhile, so a REQUEST behind the probe's INCR was never answered. A conversion whose
owner doesn't answer for 10 s (`OWNER_WAIT`: its SelectionNotify, or under INCR its next value) ends as refused (its
pipe closed, its property deleted; a TARGETS an offer without types): an owner that exits without answering, or drops
our request during another requestor's INCR, would otherwise hold a slot and its own later conversions for good (six
such, and the guest's copies were never offered again); a late answer is told from a later conversion's by its
target. **Our source**: `SetSelectionOwner`, then `GetSelectionOwner` says
whether it took (ACK `HELD`); a SelectionRequest for a type the page's offer has (the text as `UTF8_STRING`,
`text/plain;charset=utf-8`, `text/plain`, `TEXT`, answered as `UTF8_STRING`, and `STRING`, UTF-8 too; `text/html`;
`image/png`) gives a pipe the paste fills as Wayland's `send` does, and the requestor's property gets its bytes
whole if they fit under the server's largest request (at most 256 KiB), else by **INCR** (the size so far, then
64 KiB values, each once the requestor deleted the last, and an empty one; the requestor window's PropertyNotify
stays selected while another INCR to it goes on); a transfer that fails (the page's DATA `FAIL`, a cap, HELLO, the
pause) is refused while collecting (no property, as ICCCM has it, not an empty paste), and under INCR, which can't say
so once begun, ends with what came; `TARGETS` and `TIMESTAMP` are answered at once, `MULTIPLE` and other types
refused. At most eight transfers to requestors at once (the oldest goes: a requestor gone mid-INCR leaves one behind). SelectionClear (another program copied) drops the source. The native tests
(`agent/src/x11_test.rs`) run it against an Xvfb of their own with xclip; `tests/page-clipboard-x11.test.ts` against
the Debian test image's Xvfb session.

- **The guest's selection** (`selection` with a guest program's offer, not ours) with a text type (`clip::pick_text`:
  `text/plain;charset=utf-8`, then `UTF8_STRING`, `text/plain`, `STRING`/`TEXT`/`text`) is read at once up to 4 KiB and 1
  byte (`receive` into a pipe): whole and under 4 KiB it is an OFFER with its bytes inline (empty: nothing), unless its
  FNV-1a hash is that of the host's last text (echo suppression); longer, an OFFER of `text/plain;charset=utf-8` of
  unknown size, its bytes read again (`receive`) for each REQUEST and sent as DATA within the request's credit.
  A selection while our own source holds the clipboard is ours: dropped. The host's hash stands for "the guest's
  clipboard still has the host's text": set by the page's inline offer (forgotten by one not inline, until a paste of
  it crosses whole, unless a newer offer replaced it meanwhile) and forgotten once the guest's clipboard holds anything
  else (offered, emptied, no text, an image with it), so the host's text copied again after that is news.
  **An image** among the selection's types (`clip::pick_image`: `image/png` first, else the first of `image/jpeg`,
  `image/webp`, `image/bmp` and its `x-` names, `image/gif`, `image/avif`, which the page converts; not SVG or TIFF) joins
  the OFFER after the text, as the program's type and of unknown size (Wayland says none), never read for the offer:
  its bytes are read (`receive` of that type) only for a REQUEST of it, streamed within the credit as text is, at most
  64 MiB (`clip::IMAGE_CAP`, counted as they cross; the text's cap 16 MiB). An image alone is offered at once; with
  text, once the text's first bytes are read (the host's own text with an image: the image alone). Nothing of an image
  is kept or hashed: the agent holds none. **HTML** (`text/html`, plan §3.2) joins the OFFER after them in the same
  way (unknown size, read only for a REQUEST of it, within text's cap; alone, offered at once; never hashed: the
  text stands for the content in the echo rule, so HTML beside the host's own text back isn't offered either).
- **The page's OFFER** of text (`text/plain;charset=utf-8` or `text/plain`), an image (`image/png`) and HTML
  (`text/html`), any of them, each against
  its cap by the offer's size before any bytes cross (a type past it left out; none left: ACK `TOO_LARGE`; neither type:
  `NO_TYPE`), becomes a data source of ours offering `text/plain;charset=utf-8`, `text/plain`, `UTF8_STRING`, `TEXT`,
  `STRING` and `text` for the text, `text/html` for the HTML and `image/png` for the image, set as the selection, then a `sync`: its callback's
  done sends ACK `HELD` (the page's paste chord waits for it). A guest program's paste (`send` with a pipe and the type
  it asks) gets the text's bytes from the cache (inline ones, or ones that crossed whole, up to 64 KiB) or a REQUEST to
  the page, an image's and HTML's always from a REQUEST (never cached), the page's DATA written into the pipe (nonblocking) and a
  MORE for each frame written whole; a reader that closes early gets the page a MORE 0; a type the source hasn't gets
  its pipe closed. `cancelled` (another program copied) drops the source.
- **PAUSE**: the source's selection cleared (`set_selection(null)`) and the source destroyed, so a paste can't pull
  more of the host's text; transfers end (DATA `FAIL`, MORE 0); the guest's selections are ignored until RESUME,
  which sends nothing.
- **SESSION**: when the data device is bound, and when it goes (the compositor's connection lost, the seat's
  `finished`), the child's transfers end as at PAUSE and it sends SESSION; the parent sends one too when it stops a
  child or one ends.
- **The page's HELLO** (passed on by the parent: at each connection, a new page's or a restored guest's), whose page knows
  nothing of the one before: the transfers in flight were an earlier page's, which won't answer them; they end without
  a word to the new page (a guest program pasting gets its pipe's end, not a wait for DATA that won't come; a
  request's MORE from the new page with an earlier page's id finds nothing). The host's offer goes, its selection
  cleared as at PAUSE (its REQUESTs would name a serial the new page never gave), unless it is text whole in the cache
  (its pastes need no page). The guest's selection is offered again under a new serial (unless paused): the new page
  never had it.

**The screen's size** (DISPLAY; `agent/src/outputs.rs`): the page gives the link each size it asks the guest's display
for (`web/app/areas/screen-view.ts` `onSent`, the settled window or the fixed size: the size virtio-gpu's display
event says, devices.md "Display size and events"), and the link sends it at once and again at each agent's HELLO (a
restored guest's session has its snapshot's size). On the child's Wayland connection, where the compositor has
**wlr-output-management** (`zwlr_output_manager_v1`, bound at version 1: sway and other wlroots compositors), it learns
the heads, their modes and the manager's serial; whenever the page's size is known and an enabled head's current mode
isn't it, a configuration under the last serial enables each enabled head at a **custom mode** of that size (refresh
0: the compositor's choice; the kernel's mode list isn't waited for, since sway keeps its own once an output is
connected: graphics.md "The console and the display size") and disables the disabled ones, then applies. One is in
flight at a time; `cancelled` (the state changed under the serial) asks again at the next `done`; `failed` is logged;
either way a size asked once isn't asked again until the page's changes, so a mode the user sets in the session stays
until the window changes. A new compositor (a new connection) takes the page's size at its start. No program of the
guest's is run (no `swaymsg`, `wlr-randr`): a compositor without the protocol (KDE's KWin on Wayland, which follows the display event by
itself: a user's session; GNOME's mutter, expected to, unmeasured) is left alone, logged once. The native test (`agent/src/sway_test.rs`) runs a headless sway;
`tests/page-clipboard.test.ts` the Debian image's headless sway as the page's window changes.

**Under X11** (`agent/src/x11/randr.rs`, RandR 1.2 by hand on the child's X connection; no `xrandr`): only for an X11
session, one with no Wayland compositor (the child connects to the session's X server for the size alone if the
clipboard isn't shared). Under a Wayland compositor (one without data-control, whose Xwayland shares the clipboard)
the connection does no RandR (`session::x_jobs`): Xwayland's screen is the compositor's, and since Xwayland 21.1 its
outputs take the compositor's names, so `XWAYLAND*`, also skipped, doesn't tell it. For a size not asked
yet: GetScreenResources (the server probes its outputs, so a kernel's mode of the new size after the display event is
found), GetOutputInfo of each output, GetGeometry of the root; the first connected output with a CRTC; its own mode of
the page's size, else the server's (AddOutputMode), else one made (CreateMode named `WxH`, CVT-like timings at 60 Hz:
the virtual GPU reads none; a mode of that name but another size is someone's own and stops it). Then SetScreenSize to
hold the CRTC if the mode doesn't fit the screen now, SetCrtcConfig (0,0, no rotation, the one output), SetScreenSize to
the mode (its millimetres at 96 dpi); one run at a time, a size that came meanwhile after it. A CRTC refused for a
stale time (`InvalidConfigTime`, `InvalidTime`: the configuration changed under the run, as the display event's probe
does, which the page's DISPLAY races) is asked again from the resources, three times at most; other refusals and
errors are logged. The mode made last is deleted (DeleteOutputMode, DestroyMode) once the screen is set to another, so
the window's sizes don't pile up. A desktop's own daemon (KDE's kscreen) may set the same size too. The native test
(`agent/src/x11_test.rs`) runs Xorg on the dummy driver (Xvfb's screen can't grow past the size it started with; the Debian
image's X11 page test sees it set smaller); Xorg's modesetting on virtio-gpu isn't measured (backlog).

**A template's identity** (RENEW; `agent/src/renew.rs`): a snapshot flagged as a template (its header's `template:
true`, set by `tools/snapshot-template.ts` with `web/snapshot-file.ts` `asTemplate`, which rewrites the header alone: an
internal tool for demo images, never set by the page, whose own snapshots keep their identity) is one every visitor
restores the same: the same kernel CRNG, machine id, random seed and SSH host keys in every copy. At its restore (not a
resume) the worker's `restored` says `template`, and the run's link owes RENEW (64 random bytes) until the agent's RENEWED: sent at
the HELLO of an agent with `CAP.RENEW`, once a connection (a connection that ends before RENEWED sends it again at the
next; the agent renews once at a time, so a RENEW during the keys' helper is the same renewal's). The root process: the bytes added to `/dev/random`'s input pool and credited (`RNDADDENTROPY`),
then the CRNG reseeded (`RNDRESEEDCRNG`: added entropy otherwise reaches it only at its next periodic reseed); a new
`/etc/machine-id` (version 4, written in place, its 0444 mode made writable for the write and back: root without
`CAP_DAC_OVERRIDE`), what has read the old one (journald, networkd's DUID) keeping it until it restarts; systemd's
random seed (`/var/lib/systemd/random-seed`, if there) new bytes of its length; and, where there are host keys
(`/etc/ssh/ssh_host_<type>_key`) and `ssh-keygen` (the agent runs a guest program only where it exists), each key made
again into `<key>.new` (`ssh-keygen -q -N "" -t <type>`, umask 022) and renamed over the old one and its `.pub`, so
sshd never finds one missing, in a forked helper whose pidfd the root loop polls (an RSA key takes seconds of a
vCPU); then each sshd listener (a process named `sshd` whose parent isn't one, found in `/proc`) gets SIGHUP and
re-executes itself: since OpenSSH 9.8 the listener loads the host keys only at its start and at SIGHUP and hands them
to each connection, so without it the copy went on serving the template's keys (the BETTERAGENT review's finding 1,
measured with OpenSSH 10.5; a socket-activated `sshd -i` reads them each time). The new ids mix the page's bytes into `getrandom`'s too, should the reseed have failed. Not the hostname (the
user's choice: it takes effect properly only after a restart). RENEWED says what was done. The unit's
`ReadWritePaths=-/etc/machine-id -/etc/ssh -/var/lib/systemd/random-seed` lets it through `ProtectSystem=strict`, so a
template must be taken from a guest booted by a page with it. Tests: `agent/src/serve_test.rs` (a fake ssh-keygen and
the real one), `tests/agent.test.ts` (the link, `asTemplate`), `tests/page-template.test.ts` (Debian: the same snapshot
unflagged keeps its identity, flagged gets a new machine id and seed; the test image has no sshd).

**The network after a restore** (LEASE; `web/app/areas/lease-actions.ts`, `agent/src/lease.rs`; the user's design,
2026-11-13): a restored guest (a snapshot, a suspended copy: the worker says `restored`) holds the leases it had when
it was saved, while the page may connect its cards elsewhere now. Not at once: the page's gateway offers nothing while
its connection has no lease and NAKs a renewal (web/gateway.ts `dhcp`), after which a client backs off for long. So the
page waits until its network has settled with a card connected (web/app/net-settled.ts `NetSettled.when`, fed by the page network's `onChange`: every adapter
with a client connected, or waiting on the user, a login or an error; 30 s at most once the first connected; none
connected, pending until one is; the grace ending with none connected, nothing), then asks the agent (its HELLO within
20 s) for LEASE with the connected cards' MACs: a card still connecting would be NAKed and back off. The agent tells
the guest's network manager through its own tool, where both are there: systemd-networkd (running:
`/run/systemd/netif/links`) through `busctl call org.freedesktop.network1 … RenewLink i <ifindex>` for each of those
cards (`/sys/class/net/<name>` with a `device`, its `address` one of LEASE's; each tried, past one that fails), what `networkctl renew` calls (networkctl resolves a link over netlink, even an index, which the unit's
`RestrictAddressFamilies` refuses: seen on Debian 13), or NetworkManager (`/run/NetworkManager`) through `nmcli
device connect <name>`, in a forked child polled by its pidfd; LEASED says what came of it. A renewal keeps an address
that is still right (open connections live on), and the gateway's NAK of one it doesn't hold has the client ask afresh.
Where the agent can't (none within 20 s, no `CAP.LEASE`, LEASED not 0, no answer in 60 s), each connected card's link
flaps instead: the run's link port to its device (`Run.netLinks`, `{type: 'flap'}`) → `FLAP_MS`, 7 s down (net
below). networkd's DHCP DUID stays the one its start read (a template's old machine id). Tests: the root loop (fake
busctl, nmcli), the link, `LeaseActions` with fakes, `NetSettled` (tests/net-live.test.ts), the flap on asking
(tests/net-path.test.ts), and on Debian (`tests/page-template.test.ts`) the agent's renewal through busctl.

**The desktop's state** (DESKTOP; the user's decision, 2026-11-13: for the tests only): the session child says when a
graphical session is up for seat0's active user: Wayland's once its connection to a compositor has the globals (the
registry's `sync` done), else X11's once an X server took its connection (its setup's reply), none when they go; the
child runs for it alone too (`Jobs::desktop`), and with no compositor connects to the session's X server for it
(`x_wanted`). The root keeps the child's last state (none when the child stops or ends; a value it doesn't know is
dropped: the child is the user's process) and says it to a page whose HELLO has `CAP.DESKTOP`, each change once, and at
a new connection once that page's HELLO came. The page's HELLO says `CAP.DESKTOP` always (every machine has a screen),
so the child runs wherever seat0 has an active session, at no idle cost (it waits on inotify). The link keeps it
(`AgentLink.desktop`, none while the agent isn't connected) and the run's actions show it as `body[data-desktop]`
(`none`, `wayland`, `x11`; absent without an agent), which the tests wait on (`tests/page-desktop.ts`). **Nothing the
user sees changes:** not the status bar's state, not the boot card. Tests: the child against sway and Xvfb
(`agent/src/sway_test.rs`, `agent/src/x11_test.rs`), the root's filtering (`agent/src/serve_test.rs`), the link and
`body[data-desktop]` (`tests/agent.test.ts`), and on Debian the sway and X11 page tests' waits (down and up again
across a new session).

**The caches dropped before a snapshot** (DROP; `agent/src/drop.rs`, `AgentActions.dropCaches`; the user's choice,
2026-11-14): under Preferences' [Drop the guest's disk caches before a snapshot](ui:machines:PreferencesPane.dropCaches)
(`settings().dropCaches`, on by default; `?dropcaches=1` or `0` decides for the page), a snapshot (to a file or kept)
and Suspend first have the agent drop the guest's clean caches, so the memory they held is free when the balloon's hint
takes it ("balloon" below): in a forked child, a `sync`, then `3` written to `/proc/sys/vm/drop_caches` (the page cache,
dentries and inodes; the one file of `/proc/sys` the unit makes writable through `ProtectKernelTunables`:
`ReadWritePaths`, the deeper mount wins). The page waits for DROPPED 15 s at most (`DROP_WAIT_MS`), the state line saying
[Freeing the guest's unused memory](ui:snapshots:worker-snapshot.phase.freeing). The guest reads its files from its disk
again afterwards. Tests: `serve_test.rs` (the switch written, FAILED without it).

**Disk space handed back** (TRIM; `web/app/areas/trim-actions.ts`, `agent/src/trim.rs`; the user's choice,
2026-11-13): a guest deletes files and its disks' overlays keep their blocks until it trims (blk below: a `discard`
mount, or `fstrim.timer` once a week). The page has the agent trim them at three times: the Machines page's storage
bar's [Free unused disk space](ui:machines:StorageBar.storage.trim) (shown while this tab's machine runs with an agent
that says `CAP.TRIM`; its notice says what the disks' changes took before the trim and after the compaction: measured
first, since the trim's discards may compact an overlay already, past half free), when a disk's write found the
browser's storage full (`isStorageFull`, at the storage-full notice, at most once a minute: what the guest freed makes
room; said only if the overlays shrank), and before a disk's Export stops the running machine (the file then holds only
what the guest still uses; whatever comes of it, the export goes on). The agent does what `fstrim -a` does, itself (no
guest tool): in a forked child polled by its pidfd, a `sync` (what was deleted and not yet written out is free on disk
too), then FITRIM on one mount point of each filesystem whose source is under `/dev/` and whose superblock isn't
read-only (`/proc/self/mountinfo`; the first of its mount points that opens: ProtectSystem's read-only binds take it
too, FITRIM needs CAP_SYS_ADMIN, which the unit keeps; nothing in the unit changed). TRIMMED says 0 trimmed, 1 none
takes it (EOPNOTSUPP: a disk that doesn't discard), 2 one failed; a TRIM while one runs is answered by its TRIMMED, and
the page joins asks into one. Then, if anything was trimmed, the page asks the machine's worker to compact the overlays
in full (`compact` → `Vm.compact` → the device worker → `Devices.compact`, which with `measure` only reports the sizes: each overlay's `compact()`, however few
slots are free, once none of its disk's requests is in flight; a change compacts only past half free, so after a trim
of a fifth of a disk the file wouldn't shrink): the disk's I/O waits while the blocks above the free slots are copied
down (at most as many as were freed). Measured on Debian (`tests/page-agent.test.ts`, 2026-11-13): 96 MiB kept and a
48 MiB file deleted (a change's compaction leaves a third free), then the button: the overlay's files went from 153 MiB to
106 MiB; the agent's idle cost stays 0 ticks and 0 wakeups. Tests: the mount table's rules and
the root loop's (fake FITRIM: once per filesystem, a disk that doesn't discard, one that fails; `agent/src/trim.rs`,
`serve_test.rs`), `TrimActions` (joined asks, the compaction only after a trim, the notices; `tests/agent.test.ts`), the
compaction asked for (tests/overlay.test.ts, and on Buildroot `tests/trim.test.ts`: 4 MiB trimmed of 16, which a change
leaves, given back), and Debian's end to end from the storage bar (`tests/page-agent.test.ts`).

**A disk grown** (GROW; `agent/src/grow.rs`, `agent/src/table.rs`; the user's choices, 2026-11-14: on by default, mounted filesystems only): a disk grown
on the page while its machines were off (machines.md §4.5) carries a mark, and the page asks the guest for its side of
it: GROW with the disk's serial (`waarm64-<attachment id>`; the agent compares the first 20 bytes, what virtio-blk's
`GET_ID` gives) and the size the page expects the guest to see. The agent answers each GROW once with GROWN: a status
for the partition's step and one for the filesystem's, the failed step's errno, the partition's (or whole disk's) size.
One disk at a time (the others wait), each in a forked child polled by its pidfd that writes GROWN's payload into a pipe
(a child that ends without one: FAILED, errno 0); a GROW for a disk already waiting or running is answered by that
one's GROWN; a GROW whose payload doesn't read is answered at once, BAD_REQUEST (8) with EINVAL and what of its serial
reads (the page takes it as a failure). By syscalls and ioctls only, no guest program:
1. **The disk**: the `/sys/block/*` entry whose `serial` matches (none: NOT_FOUND); its node opened read-write, its
   size by `lseek` (smaller than GROW's size: NOT_YET, nothing written), its `LOCK_EX` taken (as partitioning tools do:
   udev doesn't probe it meanwhile; 5 s at most), its logical sector size from `queue/logical_block_size`.
2. **The table** (`table.rs`): GPT if LBA 1 has its signature, else MBR (the signature, boot flags 0 or 0x80, a slot in
   use, not a FAT boot sector), else none (NO_TABLE: the filesystem step on the whole disk). **GPT**: both headers'
   CRCs, sizes and layouts, the entry array's CRC and the backup's entries equal to the primary's, every partition
   inside the usable space, the backup inside the disk; anything else is BAD_TABLE and nothing is written. The partition
   whose last LBA is highest grows (Debian's root, p1, ends after p14 and p15; whatever its entry index), its end aligned
   down to 1 MiB within the new last usable LBA; the backup's entries and header move to the disk's last sectors.
   Written backup first (its entries, its header, fsync), then the primary: its entries, the old backup header zeroed
   (a stale table's inside the grown partition), its header, fsync; then a pure protective MBR's 0xEE entry covers the
   disk again (a hybrid MBR is left alone; a GROW finding it short covers it whatever else it does). **A cut run**
   (the child killed, the guest crashed, a write's EIO): until the backup's header is written the old table stands,
   both copies, except where the disk grew by at most the entry array's sectors (16 KiB: 32 of 512 bytes, 4 of 4 KiB),
   whose new backup's entries are written over the old backup's header, so the primary alone (Linux reads the primary
   and warns of the backup); from then the new backup is whole. The next GROW completes any cut, by two precise
   exceptions to "nothing written to a bad table": (a) **a primary whose header holds but not its entries' CRC** is
   repaired from the backup when the disk's last LBA has a whole backup (its CRCs, MY the last LBA, ALT 1) of the same
   disk (GUID, first usable LBA, the entry array's shape), whose last usable LBA is at least the primary's and whose
   entries are byte for byte the primary's: only the primary's header is rewritten (from the backup's, at LBA 1, its
   entries where they are), then the old backup header its old self named is zeroed if it is still a backup header of
   this disk outside the new backup, and the run goes on (UEFI firmware repairs it the same way at a boot; Linux uses
   a backup only with `gpt` on its command line); (b) **a backup the primary names that doesn't hold**, where the disk
   grew by at most the entry array's sectors, is taken as this run's own when its sector holds byte for byte what this
   GROW writes there (the new backup's entries over it), and the run goes on. Any other mismatch (a corrupt primary
   whose entries differ from the backup's, a backup not at the disk's end, a corrupt backup header) is BAD_TABLE with
   nothing written; so is a cut run whose disk was grown again before the next GROW (its new backup then isn't at the
   end). A disk grown by less than the next whole MiB moves only the backup (NOTHING). **MBR**: the last-ending primary, its end within 2^32 sectors (the
   format's 32-bit LBAs) aligned down to 1 MiB, its end CHS rewritten (1023/254/63 past CHS's reach); an extended
   partition that ends last isn't grown, nor its logical ones (NOT_LAST, as a GPT without partitions).
3. **The kernel**: the partition of that number in sysfs (its start must be the table's: else FAILED, EINVAL), told its
   new length by `BLKPG_RESIZE_PARTITION` on the disk (online, mounted or not) when its size there is smaller: so a GROW
   after one that wrote the table but failed here completes it. GROWN when the kernel's partition grew, else NOTHING.
4. **The filesystem**, only if mounted: a partition with `holders` (LVM, LUKS, md) is STACKED; its mount
   (`/proc/self/mountinfo`, trim.rs `mounts`: the line's `major:minor` the partition's (ext2/3/4's and xfs's are: a
   root the kernel mounted without an initramfs shows `/dev/root`), the source `/dev/<name>`, or a node with its device
   number; btrfs's `major:minor` is the filesystem's own, so a btrfs root shown as `/dev/root` isn't found) else
   NOT_MOUNTED (the user's choice: only mounted filesystems are grown); ext2/3/4, btrfs and xfs grow, any other is
   UNSUPPORTED. On the first of its mount points that opens **on this filesystem** (another mounted over the point is
   EXDEV, and the next point is tried; the last error is the answer's): ext2/3/4's and xfs's opened directory's
   `st_dev` must be the partition's (sysfs `dev`), btrfs's filesystem id (`BTRFS_IOC_FS_INFO`) the one in the
   partition's own superblock (64 KiB in). ext4 `EXT4_IOC_RESIZE_FS` (the size in its blocks), btrfs
   `BTRFS_IOC_RESIZE` "`<devid>:max`" (the devid the partition's superblock's `dev_item` names, which
   `BTRFS_IOC_DEV_INFO` must know), xfs `XFS_IOC_FSGROWFSDATA` (its blocks past `XFS_IOC_FSGEOMETRY`'s data blocks,
   its imaxpct kept). GROWN if `statfs`'s block count grew, else NOTHING (a second GROW finds nothing);
   an ioctl's error is FAILED with its errno.

Grow only: nothing shrinks (the new ends are past the old or nothing is written), no write reaches past the device's
end (`table::Fd` refuses it). **The unit's sandbox**: the node is root's (no DAC override), `ProtectSystem=strict`
leaves `/dev` writable and nothing in the unit closes the device policy; BLKPG and btrfs's and xfs's ioctls take
CAP_SYS_ADMIN, ext4's resize CAP_SYS_RESOURCE too (added to the unit's bounding set for it). The resize ioctls want a
writable mount (`mnt_want_write_file`), which the sandbox's read-only binds aren't: the agent reaches the filesystem
through a detached clone of its mount with the read-only flag cleared (`open_tree` `OPEN_TREE_CLONE`, `mount_setattr`;
the agent's alone, gone when closed; a kernel without them, before 5.12, gets the mount point itself). Measured on loop
devices under the unit's properties (`systemd-run`, 2026-11-15): resize2fs fails EROFS through the read-only bind,
the agent without CAP_SYS_RESOURCE grows the partition and gets EPERM for ext4, with it ext4, btrfs and xfs grow
(df's sizes), the kernel's partition is the table's and `sgdisk -v` finds no problems; another btrfs or xfs mounted
over the point is refused (EXDEV) and left as it was. **Memory**: the unit's `MemoryMax=32M` holds what the resize
dirties (the new groups' bitmaps and descriptors in the page cache, charged to the agent's cgroup): measured
2026-11-15 on the dev VM (Linux 7.2) with the tests' binary (13 MiB of its own, more than the agent) under the unit's
properties and `MemorySwapMax=0`, ext4 from 1 GiB to 1 TiB grew in 0.9 s (81 MiB peak without the cap, 32 MiB and 270
`max` events with it, no OOM) and to 8 TiB (the page's most) in 13.5 s capped against 13.3 s at a 1 GiB cap whose
peak was 562 MiB: the cgroup's reclaim writes the dirty pages back, without an OOM kill or a slower grow; btrfs (0.3 s)
and xfs (3.2 s) to 8 TiB stayed at the binary's 13-14 MiB. Tests: `table.rs` on image files
made in the test (Debian's layout, a plain GPT, 4 KiB sectors, a partition after free space, a growth smaller than a
MiB, growths within the entry array's sectors, a run cut after each of its writes then completed, each CRC
corrupted at the old size and grown, a table past the disk, MBR within 32 bits, an extended partition last, a FAT boot sector), each
grown table re-parsed and, where the dev VM has them, `sfdisk --verify` and `sgdisk -v` on tables they wrote;
`serve_test.rs` through the root loop with sysfs, the nodes and the mount table the test's and BLKPG and the
filesystem's grow faked (found or not, not yet, grown then nothing, one answer per disk, MBR unmounted, a cut serial,
a whole disk's btrfs, LVM's holders, xfs failing, vfat, BLKPG failing then completed, a corrupt table untouched, a
directory not on the partition (EXDEV), a root shown as `/dev/root`, a GROW that doesn't read); the
real ioctls on a loop device: `grow.rs`'s ignored `a_real_disk`, run by hand as root (no CI script has it).

**The page's side** (`web/app/areas/grow-actions.ts` `GrowActions`, a follower of each run's link: agent-actions.ts
`LinkFollower`; the marks through web/app/resize.ts): at each HELLO of an agent that says `CAP.GROW` (a boot, the agent
started again, a restored guest's agent), the page reads the stored machine's records then (`growsOf`: a restore may
have attached a fork) and sends GROW for each writable attachment whose overlay or stored disk carries a grow mark
(machines.md §4.5), with its serial and the size the guest sees (`sizeSeen`); a transient machine has no records, a
read-only attachment or a ramdisk no mark. A stored disk's mark is the disk's, sent through whichever machine boots it
first with the agent (written in place, or through its overlay, which then holds the grown table: the disk itself and
other machines' overlays over it don't), and the next one finds it cleared; only through an overlay whose own size is
below the disk's (an overlay grown past it already hid the disk's growth: its guest saw no change, and an answer from it
would clear a mark another machine's guest still needs). Each GROWN (the link's `onGrown`, whichever
connection it comes on) is matched to the run's disks by serial against the marks then, one at a time: a GROWN whose
mark is gone (a duplicate, one another answer cleared) says nothing. **What clears the mark** (`answer`):
- a final answer: grown (the partition and filesystem, or the filesystem of a disk without a table), nothing left to
  grow, or what the user must do themselves (the filesystem not mounted, not ext2/3/4, btrfs or xfs, on LVM, LUKS or md;
  BAD_TABLE, NOT_LAST): cleared, and said once on the message bar;
- NOT_FOUND and NOT_YET (the guest has no disk with the serial, or not at its new size yet): kept, silently, for the next
  start;
- FAILED (either step, or the filesystem's step not reached, or a status the page doesn't know): kept once, with
  `failed` on the mark, and said with "tries again at the next start" (a failure may pass: a busy disk, the 5 s lock;
  a table written but not told to the kernel is completed by the next GROW); a second FAILED clears it and says to grow
  it by hand. A failure that lasts is said twice, not at every start;
- BAD_REQUEST (the agent didn't read the GROW: a page and an agent of different versions, not a failure of the disk):
  kept as it is (no `failed`), and said once in the page's life (`machine:grow-actions.badRequest`),
  so an agent that reads it grows the disk at a later start.
A run that ends before its GROWN keeps the mark: the next start asks again, and a grow done already answers NOTHING
(cleared then, "already fills"). A restored guest is asked again for what still stands (the GROW is idempotent); a mark
cleared before a snapshot isn't (a resize orphans the snapshots from before it, so a restorable guest saw the new size).
A machine whose agent is off, or whose agent lacks `CAP.GROW`, keeps the mark and the page says nothing at the start:
the dialog's box says it needs the agent (`ResizeDisk.grow.note`), and a notice at every start would be noise. Tests:
tests/agent.test.ts (the link's GROW only to an agent with `CAP.GROW`, GROWN on a later connection; the actions: GROW
for several marked disks at each HELLO, each answer's effect and words, a duplicate, a restore's HELLO, a late GROWN,
the run ending first, a transient machine; `answer` for every status), tests/resize.test.ts (`growsOf`, `growFailed`),
and on Debian tests/page-stored.test.ts (a stored disk grown by 1 GiB before its in-place boot: GROWN, the notice, the
mark cleared, `lsblk` and `df` seeing the size).

**The keyboard layout in the running session** (KEYMAP; `agent/src/keymap.rs`, `web/app/areas/keyboard-follow.ts`;
the user's decisions, 2026-11-13): the machine's layout setting reaches the guest's disk at every boot without the agent
(frontend.md "The keyboard layout"); the agent sets it in the running session too. The page says KEYMAP (XKB's layout,
model and variant, the console's keymap; names of `[A-Za-z0-9_.,+-:()]` only, or the frame is dropped: they reach sway's
command parser and tools' arguments) at each agent's HELLO and when the setting is saved while the machine runs. The
root keeps the layout the session has: the boot's (`/etc/environment`'s `XKB_DEFAULT_*`, which the page's script writes),
then what it applied (a restore brings back the snapshot's, the agent's memory being the snapshot's); a KEYMAP of that
layout does nothing. Another goes to the session child, now and for each session's child to come: sway's through its
IPC socket (`sway-ipc.<uid>.<pid>.sock` in the user's runtime directory; `input type:keyboard xkb_variant ""`, then the
model, the layout and its variant: a layout with the old one's variant may not compile), spoken by the agent (no
swaymsg); an X11 session's server (no compositor) through `setxkbmap` where the guest has it, with the session's
`DISPLAY` and the cookie's file; any other compositor keeps its own (said in the journal). The root loads the consoles'
keymap with `loadkeys -q <vc>` where kbd is there (CAP_SYS_TTY_CONFIG: the unit has it). Not GNOME or KDE: no shared
live D-Bus path (localed's is the system's default, read-only on Debian 13; GNOME's is the user's dconf
`org.gnome.desktop.input-sources`, KDE's `kxkbrc` and its reload signal, both kept in the user's settings): later, with
a test image each (backlog). Tests: the payload, the boot's file and the root's rule (`agent/src/keymap.rs`,
`serve_test.rs`: nothing for the boot's layout, the child and loadkeys for another, once, a new session's child told),
against headless sway (`sway_test.rs`: sway compiles the keymap at each command, so `xkb_variant neo` takes only on
German and `intl` only on US: the layout read back without a keyboard), the link and the actions (`tests/agent.test.ts`),
and on Debian's sway (`tests/page-clipboard.test.ts`, the same probe).

**A text console's text** (COPY; `agent/src/screen.rs`, `web/app/areas/clipboard-actions.ts`): the clipboard menu's
[Copy the console's text](ui:clipboard:ClipboardMenu.console) asks the agent for the foreground virtual terminal's screen
(COPY), and writes COPIED's text to the host's clipboard (as Copy the screen, with a promise, so the click's activation
outlasts the answer; paused too, the user's own copy). The root reads it as it is now: `/dev/tty0` (the foreground
console) says its mode (KDGETMODE: graphics, a compositor's, has no text) and its size (TIOCGWINSZ: vcsa's header has
it in a byte each, too small past 255 columns); `/dev/vcsu` (the foreground's minor) its cells, a u32 code point each,
or `/dev/vcs` (a byte a cell; past ASCII U+FFFD) where the console isn't in UTF-8 mode (vcsu says ENODATA). The nodes
are root's (0620), so nothing in the unit changed. Each row loses its trailing blanks, the rows after the last with text
go, a NUL or control cell is a space; at most 64 KiB of UTF-8 (cut between characters). The screen only, not the
scrollback. A character the console's font lacks may come back as the glyph it was shown with (a snowman as ■ on
Debian): the kernel builds vcsu's copy of a console from its glyphs at the first read, and keeps the characters
themselves only from then on. Tests: the rows' rules and the files' paths (`agent/src/screen.rs`, `serve_test.rs`), the frames and the
link (`tests/agent.test.ts`), the menu with the test's agent (`tests/page-clipboard-ui.test.ts`), and on Debian's tty1
(`tests/page-agent.test.ts`: UTF-8 text in, its lines back; graphics mode refused).

**The guest's OS** (OS; `agent/src/os.rs`; the user's decision, 2026-11-14: the name only, no interface addresses): at
each HELLO of a page that says `CAP.OS` (every page), the agent sends OS after its own HELLO: `/etc/os-release`, else
`/usr/lib/os-release`, read then (an upgrade between two connections shows), its PRETTY_NAME (else NAME and VERSION,
else NAME, else `Linux`: os-release(5)'s defaults), ID and VERSION_ID, unquoted as a shell would (single quotes as
they are; in double quotes `\"`, `\\`, `` \` `` and `\$` escapes). The page keeps the last for the run
(`AgentLink.os`, over the agent's connections) and shows its name in the status bar's
[Guest OS](ui:statusbar:statusbar-kinds.kind.os) (frontend.md "The status bar": in the defaults, drawn once the agent
named it). Tests: the parsing and the payload (`agent/src/os.rs`, `serve_test.rs`), the frame, the link and the
element (`tests/agent-power.test.ts`), and on Debian (`tests/page-power.test.ts`: the bar's name is PRETTY_NAME's).

**Power off and restart from the guest** (POWER; `agent/src/power.rs`, `web/app/run/soft-power.ts`; the user's
design, 2026-11-14): the toolbar's [Power off](ui:toolbar:Toolbar.powerOff) and Restart, on a running machine whose
agent says `CAP.POWER`, ask the guest to power off or reboot itself (POWER: 0 off, 1 reboot) rather than cut its power,
and ask nothing first. The root asks systemd-logind (running: `/run/systemd/seats`) through `busctl`, as `systemctl
poweroff` does: `org.freedesktop.login1.Manager.PowerOffWithFlags` (`RebootWithFlags`) with flags 1
(`SD_LOGIND_ROOT_CHECK_INHIBITORS`), so a block inhibitor refuses it even to root and a delay inhibitor holds it for
its time; without logind or busctl, `shutdown now` (`shutdown -r now`) where the guest has it. Not the `reboot(2)` system call
(which `CAP_SYS_BOOT` allows too): it skips the clean shutdown (no programs stopped, no filesystems unmounted), and
on the systemd 256+ guests the agent runs on, `shutdown` reaches systemd without logind anyway (the user's decision,
2026-11-14). The tool runs in a forked
child; POWERED says whether it was taken (busctl's exit status). The page waits up to 15 s (`SOFT_WAIT_MS`) with
[Shutting down…](ui:toolbar:Toolbar.soft.off) (or [Restarting…](ui:toolbar:Toolbar.soft.reboot)) beside the stop
button, which turns red and then cuts the power (its tooltip says so); the status bar's power state says it too, until
the machine stops ([Powered off](ui:machine:messages.state.off)). A second Power off or Restart is today's hard one,
asked first (the question says the guest is on its way). Taken, the sign stays until the run ends: the guest's PSCI power-off stops the machine (state `off`),
its reset starts a new run (frontend.md "Starting and stopping"). The agent may be stopped by the shutdown before
POWERED leaves: the connection's end is taken as the request taken, and an agent that connects again (a HELLO: it was
restarted, the guest isn't shutting down) clears the sign. The connection's end hides only the capability, not the sign
(`web/app/areas/agent-shown.ts`: the run's end, `ended`, clears both): systemd stops the agent on every shutdown, so a
sign cleared there went back to Running seconds before the power-off (fixed 2026-11-14, `tests/agent-power.test.ts`). Refused, busy (a request the page gave up on still runs in
the guest), no tool, no answer in time (each said in the message bar), or no agent that can: today's hard power-off
(or restart), which asks first, and acts only if the run it asked about is still the machine's (the guest's own reboot
may have started another meanwhile). A request given up on isn't withdrawn: logind can't take one back, so the guest
may still shut down after the page's question. The page never
forces on its own. **The Machines screen's stops** (`web/app/run/clean-stop.ts`; the user's design, 2026-11-14): a
change that keeps the machine's disk (a disk's export, after its trim; the Machines page's Power off before an edit;
Save and restart of its settings; another machine opened) asks the guest to shut down first where its agent can (its
question says so), with a dialog meanwhile ([Shutting down](ui:machine:power-actions.shuttingDown.title)) whose one
button, [Power off now](ui:machine:power-actions.shuttingDown.now), cuts the power (not focused; Esc does nothing: the
button is the way out); the dialog goes when the guest's power-off ends the run (looked at every 200 ms). A request the
toolbar made already counts as asked; an agent that connects again meanwhile (a HELLO with POWER: the guest isn't
shutting down after all) is asked once more. The agent's connection ending is the shutdown stopping the agent before the guest
powers off: it leaves the sign (above), and only a sign cleared with an agent that can connected counts as "came back",
so the wait goes on (taking an end as one once asked again, got no agent, and put the question below up over a guest
that was shutting down). Refused or unanswered, the user is asked whether to power off at once: the
guest powering off while that question is open takes it down and the change goes on as after a clean stop; Cancel
keeps the machine running and the change isn't made (`PowerActions.powerOff` and `stopCleanly` say so to their callers: the Machines
page's edit, the export, the settings, the switch stop there). No agent that can: the hard stop, which the change's
question said. Stops that drop the running guest's state (a disk's reset, a snapshot's restore, changes
imported, another disk booted) stay hard. Tests: the commands (`agent/src/power.rs`, `serve_test.rs`: busctl's method, refused, shutdown
without logind, no tool), the link and `SoftPower`'s rules (`tests/agent-power.test.ts`), the clean stop's
(`tests/clean-stop.test.ts`), and on Debian
(`tests/page-power.test.ts`: refused under `systemd-inhibit --mode=block`, then Restart reboots the guest itself and
Power off shuts it down to `off`, no question asked).

**The forked helpers** (lease, trim, power, loadkeys, the keys' ssh-keygen; `lease::spawn`, `rt::close_inherited`):
each closes every descriptor past stderr first (`close_range`), and the session child all but its socket
(`rt::close_inherited_but`): a helper that kept the page's connection open held it for as long as it ran (in the tests,
other tests' sockets too: a `ci.sh` flaked that way). A helper whose pidfd can't be had is killed before it is reaped
(`lease::adopt`). A guest tool is checked from inside the unit, on Debian, not only natively: the sandbox's
`RestrictAddressFamilies=AF_UNIX AF_VSOCK` breaks tools that use netlink (networkctl, even with an index;
`if_nametoindex`), while D-Bus tools (busctl, nmcli) work. Piped, `swaymsg` prints JSON (`current_mode` there), not
its human format.

Its frames are `agent/src/frame.rs`, the twin of `web/agent-frame.ts` (both tests pin the same bytes). Serials belong
to the side that offers, request ids to the side that requests:

| Frame | Payload | |
|---|---|---|
| HELLO (1) | u16 version, u32 capabilities (LE); later versions append | the page sends it at each connection (`AgentLink`), the agent answers with its own; a side speaks the lower version and ignores capability bits it doesn't know. Version 1; `CAP.TYPE` (bit 0), `CAP.TEXT` (bit 1: the clipboard's frames below), `CAP.IMAGE` (bit 2: images in them; the page offers an image only to an agent that says it, and takes one only from such an agent), `CAP.TIME` (bit 4: TIME), `CAP.DISPLAY` (bit 5: DISPLAY), `CAP.RENEW` (bit 6: RENEW, the agent's; the page sends RENEW to an agent that says it), `CAP.LEASE` (bit 7), `CAP.DESKTOP` (bit 10: DESKTOP), `CAP.TRIM` (bit 11: TRIM, the agent's), `CAP.KEYMAP` (bit 12: KEYMAP; the page's says it always), `CAP.COPY` (bit 13: COPY, the agent's), `CAP.OS` (bit 14: OS; the page's says it always), `CAP.POWER` (bit 15: POWER, the agent's), `CAP.DROP` (bit 16: DROP, the agent's), `CAP.GROW` (bit 17: GROW, the agent's). The page's says the clipboard's three and COPY only on a machine that shares it, DISPLAY only on one with virtio-gpu's screen, DESKTOP always (`pageCaps`), and the agent runs its session child only for one of them |
| DISPLAY (14) | u32 width, u32 height (LE; none of them 0) | the page's, to an agent whose HELLO has `CAP.DISPLAY`: the size the guest's display was asked for, at each change and at each agent's HELLO. The session child sets the compositor's outputs to it ("The screen's size" above) |
| RENEW (15) | the host's random bytes (64; the agent uses at most 512) | the page's, once after the restore of a template, at the first HELLO of an agent that says `CAP.RENEW` ("A template's identity" below) |
| RENEWED (16) | u8 renewed, u8 failed (bits: 1 the kernel's entropy, 2 the machine id, 4 the random seed, 8 the SSH host keys) | the agent's, when RENEW's work is done (the keys' helper ended); what isn't there is in neither (`AgentLink.renewed`) |
| LEASE (17) | u8 count, then that many MACs (6 bytes each): the cards to renew; empty (an earlier page): every card | the page's, after a restore once its connections are up ("The network after a restore" below), to an agent whose HELLO has `CAP.LEASE` (bit 7) |
| LEASED (18) | u8 status: 0 renewed, 1 no network manager the agent knows (or its tool missing), 2 its tool failed | the agent's, when its tool ended (`AgentLink.lease`'s answer) |
| DESKTOP (19) | u8 state: 0 none, 1 Wayland's, 2 X11's | the agent's, to a page whose HELLO has `CAP.DESKTOP`: the graphical session's state at each change, and at a connection once the page's HELLO came if it isn't none ("The desktop's state" above) |
| TRIM (20) | none | the page's, to an agent whose HELLO has `CAP.TRIM`: the guest's filesystems trimmed ("Disk space handed back" above) |
| TRIMMED (21) | u8 status: 0 trimmed, 1 no filesystem takes it, 2 one failed | the agent's, when the trim's child ended (`AgentLink.trim`'s answer) |
| KEYMAP (22) | XKB's layout, model, variant, the console's keymap: a u8 length and the bytes each | the page's, to an agent whose HELLO has `CAP.KEYMAP`: at each agent's HELLO and when the setting is saved while the machine runs ("The keyboard layout in the running session" above) |
| COPY (23) | none | the page's, to an agent whose HELLO has `CAP.COPY`: the foreground text console's screen, please ("A text console's text" above) |
| COPIED (24) | u8 status: 0 the text follows, 1 the console shows graphics, 2 no text console, 3 reading failed; then (0) the screen's UTF-8 | the agent's answer to COPY, at once (`AgentLink.copy`) |
| OS (25) | the pretty name, ID, VERSION_ID: a u8 length and UTF-8 each (at most 255 bytes, cut between characters) | the agent's, after its HELLO to a page whose HELLO has `CAP.OS` ("The guest's OS" above) |
| POWER (26) | u8: 0 power off, 1 reboot | the page's, to an agent whose HELLO has `CAP.POWER` ("Power off and restart from the guest" above); one at a time, a second while one runs answered by its POWERED |
| POWERED (27) | u8 status: 0 taken, 1 refused (an inhibitor) or failed, 2 no tool, 3 busy (an earlier request still runs) | the agent's, when its tool ended (`AgentLink.power`'s answer; the connection's end first: `gone`) |
| DROP (28) | none | the page's, to an agent whose HELLO has `CAP.DROP` (bit 16), right before a snapshot or Suspend ("The caches dropped before a snapshot" above) |
| DROPPED (29) | u8 status: 0 dropped, 1 the kernel's switch couldn't be written | the agent's, when the child ended (`AgentLink.dropCaches`'s answer) |
| GROW (30) | u8 length and the disk's serial (ASCII), u64 the size in bytes the page expects the guest's disk to have | the page's, to an agent whose HELLO has `CAP.GROW` (bit 17), for a disk it grew ("A disk grown" above) |
| GROWN (31) | u8 length and GROW's serial, u8 the partition's status (0 grown, 1 nothing to grow, 2 no such disk, 3 not at the size yet, 4 no partition table, 5 the space doesn't follow a partition it grows, 6 a bad table, 7 failed), u8 the filesystem's (0 grown, 1 nothing to grow, 2 not mounted, 3 unsupported, 4 stacked: LVM, LUKS, md, 5 failed, 6 not tried), u32 the failed step's errno (0 none), u64 the partition's (or whole disk's) size in bytes now | the agent's, once per GROW (`GROWN_PART`, `GROWN_FS`, `decodeGrown`) |
| TIME (13) | u64 nanoseconds since the Unix epoch (LE): the host's wall clock as the page sent it | the page's, to an agent whose HELLO has `CAP.TIME` and under Preferences' switch (`web/app/areas/agent-actions.ts`): at each agent's HELLO, after a save's pause, when the host's own sleep shows. The agent sets CLOCK_REALTIME to it (`clock_settime`) unless the guest's clock is within 50 ms of it, and logs the step. (10 was SYNC, before vsock: a stream begun afresh after a restore; unused) |
| SESSION (11) | none | the agent's: the guest's clipboard changed hands (above). The page forgets its echo hashes, drops its transfers, and syncs the host's clipboard again if it may read it |
| OFFER (2) | u32 serial, u8 flags (1: inline), u8 count, per type u8 length, the type, u32 size (`0xffffffff` unknown); inline: the rest is the first type's bytes | a side's clipboard changed: what it has. Text first, inline under 4 KiB (plan §2), else the other side REQUESTs it; an image after it, never inline |
| REQUEST (3) | u32 serial, u32 id, u8 length, the type | the bytes of offer `serial`, please; the answer may send `CREDIT` (4) DATA frames before the requester's first MORE |
| DATA (4) | u32 id, u8 flags (1 END, 2 FAIL), at most 64 KiB | an answer, in order; FAIL: none (a stale serial, a type not offered, paused, past the cap) |
| ACK (8) | u32 serial, u8 status (0 HELD, 1 NO_SESSION, 2 PAUSED, 3 TOO_LARGE, 4 NO_TYPE) | the agent's answer to the page's OFFER |
| MORE (9) | u32 id, u32 count | the requester takes `count` more DATA frames for request `id`; 0 stops the answer |
| TYPE (5) | UTF-8 text, at most 64 KiB a frame (`typePayloads` cuts between characters, never inside a CRLF); empty: the paste's end (`AgentLink.type` sends one after each paste's frames) | the agent puts it in the foreground VT's input (`/dev/tty0`, TIOCSTI a byte at a time), line ends as Enter (CRLF and LF become CR, as terminal emulators paste); queued (1 MiB at most) and typed in bursts of 4 KiB between the loop's other work (`console::Typist`, stepped every 1 ms while it has text), paced by the terminal's unread input (`FIONREAD`, every 256 bytes: the line discipline drops what doesn't fit its 4 KiB; for a reader in canonical mode, whose `FIONREAD` counts whole lines only, the line typed so far counts too, so a line longer than the buffer stalls and is dropped, not cut short), so a long paste into a reader that keeps up arrives whole and one that stalls a second loses the rest. A frame with no room in the queue is dropped with the rest of its paste (up to the empty frame), so what is typed is a prefix, and the typed bytes go from the queue once they pass half of it (a long paste holds about 1 MiB, not itself). Only while the VT shows text (`KDGETMODE` is `KD_TEXT`, checked at each burst): a compositor running on it puts it in graphics mode, and the lines would wait in its input for the shell to run once the compositor ends. Not UTF-8: dropped. PAUSE drops what is queued |
| TYPED (12) | u8 status (0 DONE, 1 NOT_TEXT, 2 REFUSED, 3 DROPPED) | the agent's: what became of TYPE's text, once it has nothing left to type (DONE) or as it drops it (NOT_TEXT: graphics on the console, none of it typed; REFUSED: the console can't be opened or refused it, or not UTF-8; DROPPED: the reader stalled or too much was queued, said as it happens and again as the queue's end). The page keeps the last for the clipboard menu (`ClipboardShare.typed`), which says why after Type the clipboard |
| PAUSE (6), RESUME (7) | none | while paused the agent drops TYPE and the clipboard's frames (above); the link refuses `type()` while paused and, on a machine that shares the clipboard, says PAUSE or RESUME at each connection (a restarted agent starts unpaused; a restored one is as its snapshot was, and the pause is the run's); the parent passes both to its child, and PAUSE first to a new child |

A frame's length that can't be (zero, past 64 KiB and 256) breaks the agent's reader: it closes the connection and
connects again, which starts both directions afresh (the link resets at each connection; the session child stays). It
breaks the page's reader too: the page resets the connection (`reset` to the device), and the agent connects again. A
child's stream that
breaks, or more than 4 MiB queued for it, stops the child. The log lines of both go to the journal
(`waarm64-agent: …`, the child's `waarm64-agent: session: …`).

**The page's side** is `web/app/clipboard.ts` (`ClipboardShare`, the tests' `window.__clipboard`), over the link:
the guest's OFFER is written with `writeText` while the document has focus (requested first if not inline; a MORE for
each DATA frame), else kept as `pending` (what step 4 writes later); the page's own offers come from the **paste
chord** (by the key: Ctrl+V, Ctrl+Shift+V, Shift+Insert; on a Mac Cmd+V and Cmd+Shift+V only, `isPasteChord`):
`web/input.ts` holds the key without `preventDefault` (`hooks.hold`) and queues the key events that come meanwhile
behind it (the chord's Ctrl released after the V; a second press a second press), the browser's `paste` event at the
document while the screen's canvas has focus gives the text (`pasted`), the page offers it unless it is the last text
either way (a hash of each) or empty, and the key goes to the guest at the agent's ACK or after 300 ms (`ACK_WAIT`;
300 ms more if no paste event comes, `PASTE_WAIT`). An ACK that refuses is taken whenever it comes. The hashes stand
for what the guest's clipboard has: an offer forgets the guest's, the guest's copy the page's, and the connection's
coming or going, HELLO, SESSION and the pause forget both (and drop the transfers). An offer that a newer one began during
its waits (reading an image's bytes for its hash) isn't sent, nor is a focus read's whose read a paste began during:
the guest's clipboard ends with the newest. The page answers the agent's REQUESTs for its newest offer within their
credit; its own requests stop (MORE 0) when no DATA came for 30 s (`REQUEST_WAIT`: a guest program that never serves
its type would hold an image's write, and the focus syncs behind it, for good); its serials and request ids start at
random (a restored agent may hold an earlier page's). Nothing of this happens while the link is paused, closed, or the agent's HELLO lacks `CAP.TEXT`.
**Images** (plan §4.4, with `CAP.IMAGE` from both sides): the page offers a PNG (way 1's `read()`, the paste event's
`File`, Send's `read()`) after its text in one OFFER, its size known (at most 64 MiB, else left out), and answers
REQUESTs for `image/png` from its bytes, the one image it holds (a newer image's offer fails the older one's answers);
the guest's image is requested at the write to the host's clipboard (frontend.md "The toolbar", Clipboard), each
request with its type's cap. Its hashes cover text and image together (`contentHash`: the text's cyrb53, the image's
SHA-256), and the guest's image stands as the host's read-back of it.

### vsock (ID 19): systemd's notify socket and the guest agent

`{type: 'vsock', port, agent}` (`web/vsock-device.ts`), on every `firmware` machine: a virtio-vsock with no optional
features (stream sockets are implied), three queues (receive, transmit, event), the guest's CID **3** in its config.
Its two services are the guest agent's connection (below) and systemd's **`vmm.notify_socket`**: the machine's fw_cfg credential (`web/app/firmware-files.ts`; a
`?credential=` of that name replaces it) is `vsock-stream:2:8573`, the host's CID and `NOTIFY_PORT`, the form
systemd-vmspawn hands its guests. systemd 254 and later reads it in PID 1 and sends its sd_notify messages there, each
over a connection of its own: **`READY=1`** (with `STATUS=Ready.`) when the boot's jobs are done, `STATUS=…`,
`X_SYSTEMD_UNIT_ACTIVE=<target>` as targets come up (256 and later; never from the initrd), `EXIT_STATUS=` at the end.
Older systemd, or none, ignores it. The page's end (`onReady`, in `Runner`) turns READY=1 into the worker's `up`: the
machine is `running` (frontend.md "Worker → page", `state`), whichever of it, the serial `ready` marker and the
clipboard agent's HELLO comes first.

**The guest agent's connection** (devices.md "The guest's agent"): a REQUEST to **`AGENT_PORT` (8574)** on CID 2 of
type STREAM, while the page has an end for it (`agent`, a machine with the agent on: web/app/run/start-message.ts),
gets RESPONSE and the page hears `open`; without one, RST. One connection at a time: a new one (the agent started
again) resets the old, and the page hears it close and open. Both ways carry bytes: the agent's RW payloads go to the
page as `data` at once, so the device's `buf_alloc` (`AGENT_BUF`, 256 KiB) is credit only, given back (CREDIT_UPDATE)
each time a quarter of it has been taken since the guest was last told; the page's bytes (`data`, at most
`MAX_PENDING`, 1 MiB, held) go into the guest's receive buffers as RW packets, each as large as the buffer and the
guest's credit (its `buf_alloc` less what was sent past its `fwd_cnt`, from every packet's header) allow; out of
credit, it waits for the guest's own CREDIT_UPDATE, which Linux sends as its reader frees room (a CREDIT_REQUEST is
answered at once, room or not, and the two sides bounced packets until the agent read: found by the track's review),
and the page hears how many were `taken` (`AgentLink`'s window). The agent's
SHUTDOWN or RST ends it (the device answers SHUTDOWN with RST), as does the page's `reset` (RST to the guest) and a
device reset; the page hears `open` false. Each connection has a number (`conn`, from 1), in every message both ways:
the agent connects again at once, so the page's messages for one (the rest of a paste, a reset) can reach the device
after the next has opened, and the device's `data` and `taken` the page after; each side drops the other's for a
connection that isn't the current one, and the link asks one reset a connection. A REQUEST again from the same guest
port is a new connection too. A restore resets the transport (below), so the restored agent connects again.

The device answers every connection, whatever the page does, because the guest's PID 1 is the sender and waits:
systemd 256 and later sends, `shutdown(SHUT_WR)`s, then `recv`s until EOF (254 and 255 `close`). A REQUEST to
`NOTIFY_PORT` on CID 2 of type STREAM gets RESPONSE (`buf_alloc` 64 KiB, `fwd_cnt` the bytes taken); anything else, or
a packet of no connection, gets RST. The message is posted (`{type: 'notify', lines}`) at the guest's SHUTDOWN with
SEND: a half close is answered by the host's own SHUTDOWN of both ways (Linux then resets, and its `recv` gives EOF),
a full close by RST. A message past 64 KiB is reset and dropped; CREDIT_REQUEST gets CREDIT_UPDATE (the device sends no
data on these, so the guest's credit doesn't matter). Nothing is kept across a snapshot: a restored device sends
TRANSPORT_RESET on the event queue, so a connection in flight fails in the guest rather than hanging its sender.

With sshd installed, the device also has systemd 258+'s ssh-generator make `sshd-vsock.socket` (vsock port 22), whose
`systemd-ssh-issue --make-vsock` would put "Try contacting this VM's SSH server via 'ssh vsock%3' from host." above the
login prompt; no host side can connect (the device takes no host connections), so the page's SMBIOS strings carry a
`systemd.unit-dropin.sshd-vsock.socket~waarm64-no-issue` that clears its `ExecStartPost=` and `ExecStopPre=`
(`web/app/firmware-files.ts` `NO_SSH_VSOCK_ISSUE`; the generator's own switch, `systemd.ssh_auto=no`, is on the kernel's
command line only, which a UEFI boot's loader owns).

It is the last slot, after the disks (machines.md §4.1), so it moved no machine's disks, and it is left out of the
shape's hash (`shape.ts` `hashed`): a snapshot or suspended machine from before it restores without it
(`worker-header.ts` `slotsOf`), as one from before the clock does. Linux's driver is `vmw_vsock_virtio_transport`
(`CONFIG_VIRTIO_VSOCKETS`, a module in Debian's and Arch's kernels, loaded by its modalias). Tests: `tests/vsock.test.ts`
(the device through hand-built queues, both closes, the refusals, the credit, a restore, the page's end, the
credential; the agent's connection: both ways, the guest's credit and the device's, one at a time, the page's reset,
refused without the page's end); on Debian, `tests/page-debian.test.ts` boots with `?ready=guest`, so only READY=1 makes the page `running`,
and checks the driver bound, the credential and PID 1's silence about it. READY=1 can come before the serial getty's prompt, so a test that logs in on the serial terminal waits for `login: ` itself, not for `running`.

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

### balloon (ID 5): free memory left out of snapshots

`{type: 'balloon'}` (`web/balloon.ts`; Linux's `virtio_balloon`, a module Debian's udev loads), on every machine of the
page (after the notify socket: web/app/shape.ts `slots`, out of the shape's hash, and a snapshot from before restores
without it: web/app/worker-header.ts `slotsOf`). It never inflates (`num_pages` stays 0): it is there for what the guest
says of its free memory, so that a snapshot, which leaves zero pages out (platform.md "The snapshot file"), leaves that
memory out too. Features FREE_PAGE_HINT (3) and REPORTING (5), not PAGE_POISON (without it Linux turns reporting off only
in a guest that poisons or zeroes what it frees, whose free pages are what they are already); four queues of 128,
compacted as virtio-mmio's Linux numbers them (inflateq 0, deflateq 1, then free_page_vq and reporting_vq where their
features were taken); 12 bytes of config (`num_pages`, `actual`, `free_page_hint_cmd_id`).
- **Free page reporting**, all the time: the guest hands over free blocks (2 MiB and up, ~2 s after they were freed, a
  sixteenth of a free list per pass, so a large free takes tens of seconds) and keeps them aside until the request
  completes. The backend zeroes each page of them that isn't zero (`zeroPages`) and only reads the others.
- **Free page hinting**, right before a snapshot or a suspend (the machine worker's `hint`, `HINT_MS` = 10 s at most:
  web/app/worker-snapshot.ts; `Vm.hint` → the device worker → `Devices.hint`): the backend writes a new command id (from
  2) into the config, the driver allocates every free 4 MiB block it can get, sends their addresses after the id, and
  ends with STOP: then the save pauses the machine. The guest holds the blocks until DONE (`release`, after the save; the
  backend of a machine restored from it says DONE at its start, as the saved config's id is a hint's), or until its
  shrinker gives some back under memory pressure, so the device **never writes them** (a block the shrinker gave back may
  be the guest's again before its request is seen): they are zero because the guest's allocator zeroes what it hands out
  (`init_on_alloc`, Debian's and Arch's default). A guest without it gains nothing; one without the driver, or before it
  probed, isn't asked (no FEATURES_OK).
- **Committing nothing:** a wasm memory can't give pages back, so a store of zeros to guest RAM the guest never touched
  commits it on the host for the tab's life. Reporting only reads a page that is zero; the allocator's zeroing is
  `DC ZVA`, which doesn't store over a zero block (cpu.md "ID registers and identification"; measured: 738 MiB hinted on an idle Debian,
  Chromium's RSS unmoved but for the file's download).
- Measured (Debian 13, 960 MiB, 2 vCPUs, 2026-11-14, one run each): after a boot 87 MB; the page cache filled
  (650 MiB, `find /usr … cat`) 378 MB, or 126 MB with the agent's DROP first (122 MB again), against 452 MB and 450 MB
  without the balloon (drop_caches alone frees pages with their old bytes). The hint took 10–45 ms; the guest has its
  memory back after the save and after a restore of it (`free`: 846 MiB).
- Not done: inflating the balloon (the page has no use for it: a wasm memory can't shrink), its statistics queue.
  Giving the reported pages back to the browser needs WebAssembly's memory-control proposal (backlog "Upstream
  reports").

### blk (ID 2)
- Features `SEG_MAX` = 126, `RO` (or `FLUSH` when writable: an overlay, or a ramdisk); one queue of 128. `IN`, `GET_ID`,
  `OUT` and `FLUSH` when writable (`IOERR` without), the rest `UNSUPP`. `GET_ID` answers the spec's `serial` (a
  machine's attachment: `waarm64-<attachment id>`, so `/dev/disk/by-id/virtio-…` survives a reorder;
  docs/machines.md §4.1), else `waarm64-blk` (the tests' guests).
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
  the distribution's weekly `fstrim.timer`; with the guest agent the page has it trim, and compacts the overlays after
  ("Disk space handed back" above).
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
  slots are reused in the order they were filled. The device worker holds the image's Web Lock (`waarm64-cache:<key>`,
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
  ending in `.json` is a manifest (`waarm64-chunked-1`: the file's size, the piece size, each piece's SHA-256, an
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
  blocks: `data` holds written blocks in slots, `map` a u32 entry per disk block (0 = base,
  n = slot n − 1, 0xffffffff = zeros without a slot) in **two levels** (below), `meta` its **generation** (a u64, bumped and flushed before
  the first change of each opening: a write, a discard or a zeroing; an opening that only reads leaves it, so "the
  overlay is as it was at generation g" is two integers compared: docs/machines.md §3.3), for a stored
  disk the overlay being merged into it, and the overlay's **own size** (a u64 at 32: a grown overlay's,
  docs/machines.md §4.5; a 32-byte `meta` from before sizes has none), `base` the image's identity (`diskIdentity`: a URL's path and the size, or a chosen `File`'s name, size and modification time; a mismatch refuses to open). A block's
  slot is written before its map entry, so a crash leaks a slot but never maps garbage: a block reads as the base, as
  something written to it, or as zeros it was given, never as another block's data or an I/O error. **Against an OS
  crash or a power loss too** (`ORDERED`): the OS may write either file back first, so the order is made durable by
  flushes where one write depends on another: a write's new data is flushed before its map entries (one `data` flush
  per request that maps new slots), a slot freed by a discard or a move is reused only once the map that freed it is
  flushed, a compaction's copies are flushed before their entries move, and `data` is cut only once the map entries
  that left its end are flushed. They cost nothing bench/io's suite can see (bench/io/REPORT.md "Ordered flushes");
  `tests/overlay.test.ts` replays every crash point with either file as of its last flush.
  **The map's two levels** (RESIZE loop 2b): the entries are in **leaves** of 1,024 (4 KiB, a 4 MiB range of the
  disk), a leaf made at the first write (or zeroing) into its range; a range without one reads as the base (or zeros
  past it), as an unwritten block does. So the map file and the memory grow with what's written, not with the disk's
  size (a flat map was 4 bytes per block: 1 GiB per TiB in memory, and a write at the end, as GPT's backup header,
  made the file that long). The `map` file: a 16-byte header (u32 `0xfffffffe`, u32 version 2, u64 where the records
  start), then the leaves' **records** in the order they were made, 4,104 bytes each: the 1,024 entries, then the
  range + 1 (the leaf's top entry), then 0. **The top table** (range → record, 4 bytes per 4 MiB: 1 MiB per TiB) is
  rebuilt in memory at opening from the records, which are read whole (`readMap`, 256 records a read); the leaves are
  kept in memory as the file has them. A range's leaf is its first record; a record without a range, or a later one
  for a range that has one, is **dead** (zeros in memory, so no walk sees its entries; dead records at the file's end
  are cut off at the opening's first change). **A map that reads back short** (an I/O error, a read cut off) refuses
  the opening ([The disk's block map can't be read from this browser's storage.](ui:disks:overlay.mapUnreadable)):
  taken as empty, the disk would read as its base, every slot would be free, and the next writes would land on other
  blocks' data. **Crash and refusal:** a leaf is one appending write, its entries before its top entry, and an
  opening counts only records the file holds whole, so a write that lands in part (refused, or cut by a crash) leaves
  no leaf; refused, the file is cut back and the change fails (its slots free). A new leaf's entries map only blocks
  whose data is written already (a run's data, then its leaves). Entries in a leaf that exists are written over in
  place (`putMap`: inside the file, so they need no room; one that falls short anyway is written back as it was). A
  zeroing of whole ranges without leaves makes up to 256 leaves (1 MiB) in one write (a restore with the whole disk).
  Everything that walks the map walks the leaves only: the opening's free slots, compaction (a slot's owner is its
  entry's place in the leaves), `written` (the leaves in their ranges' order, walked as it's taken, never a list:
  a snapshot sends the device's as a `Uint32Array`, 4 bytes a block) for exports, snapshots and merges, and
  a stored disk's reader (web/stored.ts `blockSource`, whose `held` gives a whole export the blocks it holds: a
  qcow2 of a stored disk reads its data, not its size).
  **A flat map** (from before leaves: no header) is read as it is (its leaves built in memory, the file untouched):
  an opening that only reads (a stored disk under its machines' overlays, read-only handles in several workers)
  never changes it. The first change of a writable opening converts it (`convert`) before anything else: a trailer
  (u32 `0xfffffffd`, 0, u64 the flat map's length) at where the records will end, the records into the room before
  it (after the flat map, a whole number of records past the header), then the header over the flat map's first
  entries (inside the file) is the switch; then, where the records fit in the flat map's room, they're copied down to
  16, the rest of the room zeroed, the header moved to them, and the file cut after them (a dense flat map keeps its
  room: ~2× the records). Until that cut, a reading from 16 takes the room as records too: zeroed, they're dead, and
  so is the records' first copy after them (each a range's second record), where the room's stale entries would have
  been read as leaves. Interrupted anywhere, the file reads as the flat map (the trailer bounds it) or as the
  converted one, and the next change converts it again; refused, it is cut back to the flat map and the change
  fails. (A conversion interrupted in that window by the code before 2026-11-15, whose records weren't a whole number
  of records past 16, can't be told from its leaves.) (A version in `meta` was the brief's suggestion; the header keeps the map
  file self-describing, since several readers open it without its `meta`: a stored disk's reader, a merge's copy, a
  restore's writes. Leaves in a file of their own would have needed every opener to open a fourth file.)
  Debian's boot on the page leaves its overlay a map of 74 KB (18 leaves) where the flat one was 1.7 MB; imported as a
  stored disk, 1.32 MB (322 leaves) where it was 3.0 MiB (GPT's backup header at the end); a disk grown to 1 TiB with
  GPT's headers written: 8 KiB of map file and 1 MiB kept at opening, where the flat one would be 1 GiB of each
  (bench/io/REPORT.md "The two-level map").
  **Few OPFS calls:** a sync-handle
  call costs ~0.3 ms whatever its size (Chromium on Linux, `bench/io/REPORT.md`), so reads and writes go in runs: blocks held in
  consecutive slots are one read or write, whole blocks not held take consecutive slots where `take` has them and are written
  from the request's bytes in one write with their map entries in one more per leaf the run crosses (a range's first
  write makes its leaf in that write); only a block a write covers in part is read-modify-write.
  **Its size** is the largest of the base's, its own (`meta`) and the spec's `size` (the guest's, from the page):
  past the base's end it reads as zeros until written (`grown`), and its map grows as blocks there are written
  (the capacity the guest sees is the spec's `size`), a leaf where a range is first written.
  **What the guest discards leaves the overlay:** the whole blocks of a discard that the overlay
  holds become zeros without slots (never the base's bytes again: QEMU's qcow2 does the same over
  a backing file; blocks it doesn't hold stay the base's), a `WRITE_ZEROES`'s whole blocks too,
  held or not. Slots no block maps (those, and leaked ones) are found at open and taken by the
  next first writes; free slots at the end of `data` are cut off, and once half of `data` is free
  the blocks in its highest slots are copied down (copy, then the map entry, 256 at a time) and the file shrinks (a
  compaction that fails part way keeps the moves it made, and the slots they freed are free).
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
  (the tests' `?machine=`) are single names as before; `overlayMeta(name)` reads the generation (and own size) without opening it, `writeOwnSize(name, size)` grows it (a writable stream, from a page too: docs/machines.md §4.5).
- **Stored disks** (`web/stored.ts`, docs/machines.md §4.4): an image copied into the browser is the same
  block store over nothing, in `disks/<id>/` (`importImage`: a qcow2's virtual bytes, compressed clusters inflated,
  or a raw file's, zero blocks left out; `storedEstimate` bounds what it takes from a qcow2's allocated clusters).
  Under an overlay it is the base (`BlkSpec.stored`: `openStored` reads it with read-only handles under a shared
  lock, so several machines can); written in place it is its own overlay over zeros (exclusive, as any overlay).
  `mergeOverlay` writes an overlay's blocks in (its zero blocks as zeros) and deletes it, with the store's
  generation bumped and its `meta` naming the overlay first, so an interrupted merge is finished at the store's next
  opening (`resumeMerge`), before anything reads it (`tests/stored.test.ts`, with the resume left out as the planted
  bug).
- **Its surface** (web/surface.ts, docs/plans/surface.md): `Backend.inspect` answers a disk's surface (per cell of
  4 MiB × a power of two, the blocks the disk and its overlay hold) and one 4 MiB range block by block, from the maps
  the device has in memory (the overlay's `leaves()`, a stored disk's `blockSource`, a ramdisk's chunks, an image's
  `liveImage`). A stored disk under an overlay doesn't change, so its per-range counts are taken once. Under a grown
  overlay a stored or blank disk is opened at the guest's size; the spec's `diskSize` (web/app/worker-devices.ts
  `blkSpec`) is its own, which the surface's disk layer takes (nothing else reads it).
  **An image**: a qcow2's clusters from its L2 tables (web/qcow2.ts `Disk.allocation`: one object over the tables read
  so far, per cluster data or compressed against unallocated or zero, its bytes' place in the file, and per table
  whether it is known; a 4 KiB block is the disk's if any cluster in it is). `openDisk` reads L2 tables lazily, as
  requests need them, and keeps them; each inspect reads those not read yet from a local file (a bounded read: at most
  `ALLOCATION_MAX`, 32 MiB of tables, an image of 256 GiB at 64 KiB clusters; past it, only those the guest's requests
  read), and from a remote image only those the block cache holds in memory or in OPFS (`Source.kept`,
  web/blockcache.ts): nothing is fetched for the map. The layer is counted per table as tables are known
  (`allocationCounts`, each table once: the image doesn't change while open), the blocks under a table not known yet
  in its `unknown` (not examined: `why` `'tables'` remote, `'large'` local). The tables it reads it keeps for the
  guest's reads too. A raw image is not examined (`'raw'`), nor read by the content check. **Kept**: a remote image
  says per cell how many of its blocks this browser keeps (`kept`): a raw one's of all its blocks (the file is the
  disk), a qcow2's of its blocks with data, a block kept when every cache block its clusters' bytes take is (a data
  cluster's, a compressed one's packed bytes; unallocated and zero clusters need nothing from the server). The
  qcow2's clusters are indexed once per table (`keptIndex`: a cluster's units and its first and last cache block),
  and each answer looks each cache block up once and passes over the index (`keptCounts`): 2.5 to 4.9 ms for a
  20 GiB image at 64 KiB clusters with every cluster allocated (327,680; the index 10 to 23 ms once, the tables'
  counts 2 to 4 ms once; Node in a cloud container, 2026-11-15: `tests/surface-image.test.ts` prints it). A range's
  detail marks a block under an unknown table not examined (5) and a kept one in `kept`. The content check reads a
  local qcow2's blocks
  through the image, a remote one's not at all (they'd be fetched). Activity: a
  query that asks for it puts a wrapper around the backend's outermost `request` (over the stats', concurrent and
  compaction wrappers, which are made at the build), which reads the request's header and marks the ranges read
  and written; an answer carries the marks per cell and clears them, and once no query asked for 3 s (or at
  `close`) the request it wrapped is put back as it was. While nobody looks, nothing is added to the request path.
  While the wrapper is on, the overlay's per-range counts are kept and only the ranges written since are counted
  again: a whole walk of 25,600 leaves (100 GiB written) took 30 to 55 ms in Node (a cloud container, 2026-11-15:
  `tests/surface.test.ts` prints it), a range's ~1 µs. One answer every 10 s (`FULL_WALK_MS`) walks the leaves whole all the
  same: a request in flight when the wrapper went on isn't marked, and what it changed after the first two walks is
  caught up then.

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
  with several cards tells them apart (docs/networking/adapters.md §4). A lease with `routes` (`Routes`, per family: the
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
- **The page's shared folders** (`{type: '9p', tag: 'waarm64', folders, port}`, `FolderTree`): [shares.md](shares.md).

### input (ID 18)
- `{type: 'input', kind: 'keyboard' | 'tablet' | 'mouse' | 'touch', port?}`; eventq and statusq of 64. The keyboard
  has keys 1–248, the Num/Caps/Scroll Lock LEDs and `EV_REP`; the tablet `BTN_LEFT/RIGHT/MIDDLE/SIDE/EXTRA`,
  the wheels (`REL_WHEEL`, `REL_HWHEEL` and their `_HI_RES` twins) and `ABS_X/Y` over 0–32767; the mouse the same
  buttons and wheels and `REL_X/Y`; the touchscreen
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
  (the oldest whole frames, through a SYN_REPORT, dropped past 1024: only while the guest takes none, before its driver or in a stall, since a running guest
  drains its 64 at once; long text goes through the agent's TYPE, which paces itself). In deterministic mode they land
  where the device worker gets them, not at a step; the native runners inject theirs at the guest's LED, and the page's
  input test runs in realtime. LED status events go to the port (the page lights the on-screen keyboard's lock keys by them). The page's mouse lock and touches: docs/frontend.md "Input".

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
  built from the browser (`capsFromGl`). The renderer string is `waarm64`.
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
- **Video** ([graphics.md](graphics.md) "Video"): the caps' `video_caps`, and video commands in the
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
  yet"; docs/backlog.md), or a blob outlives one; the page asks first (`Gpu.refusal`), so a refused snapshot touches
  nothing (frontend.md "Snapshots").
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
  for such a fence alone while its fences go on retiring. Once a fence without its entry has retired, the next reply that
  carries no fence of its own says it (the newest such of its ring, in the reply's header: the kernel signals a reply's
  fence whatever the command was), so a guest waiting for it alone while the ring's newest waits for what the guest does
  next isn't left waiting (VK4 T36); when the guest sends nothing for 20 ms (`CARRY_MS`), the device raises the display
  event, and the kernel's GET_DISPLAY_INFO (and GET_EDID), sent from its own work, carry it (the cost a hotplug event's
  re-probe of the outputs).
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
  translated shaders persist across runs in IndexedDB `waarm64-shaders`, the origin's, deflated (`venusPipelines` in the
  render stats; vk/README.md "Pipelines made asynchronously", "The shader cache"). A render pipeline is made when its
  draw is recorded (`?gpu=vkpremake=on`: at `vkCreateGraphicsPipelines` too, a loss measured by VK4 T17).
- **The driver** (vk/README.md "The driver"): Vulkan on the GPU worker's WebGPU device (web/venus-gpu.ts; with no
  adapter it keeps the objects and draws nothing). What it advertises follows the browser's WebGPU device, its limits
  and features read at the renderer's start (vk/README.md "The driver"; VK2 L7), less what the translator can't do yet,
  formats as WebGPU has them, plus what Venus's WSI shares through (dma-buf memory with the LINEAR modifier, foreign
  queue transfers, sync-file semaphores); the adapter's subgroups (anchored where the page's check at Venus's start finds
  them wrong in divergent control flow, held where anchoring doesn't help: VK3 L5, VK4's backlog easy wins), 16-bit storage and floats, tier2's read-write formats; texel buffers,
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
  **microphone ring** (the sound ring's layout the other way round: the page's `waarm64-mic` worklet writes, the source
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
