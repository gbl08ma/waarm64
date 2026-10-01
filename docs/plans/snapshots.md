# Snapshots (M8 phase C lane; done 2026-10-01)

The lane's plan, kept as the record of its design and of what each loop found; what exists is in
the topic docs ([platform.md](../platform.md) "Snapshots" and "Pausing a VM",
[abi.md](../abi.md) "M8 phase C", [frontend.md](../frontend.md) "Snapshots",
[testing.md](../testing.md)), the numbers in `bench/boot/REPORT.md` ("M8 phase C loop 4" and
"M8 phase C exit"), the loose ends in [backlog.md](../backlog.md) "Snapshots". Revisited on
2026-10-01, after phase B ("your own disk") changed what a disk is. The user decided on
2026-09-29 that snapshots are **files the user downloads and uploads**, and on 2026-10-01 to
build Suspend too.

**Goal:** the page resumes a booted machine in a few seconds instead of a ~50 s boot, and **the user
owns their snapshots as files**: the page offers the running machine's snapshot for download, and
a snapshot file given to the page (a file picker, a drop) resumes that machine, in a fresh browser
profile too.

## Design

### What a snapshot holds, and who writes it

| Part | Who | How |
|---|---|---|
| vCPUs, time, GIC, PL011 (with what the console rings hold), PL031, flash bank, fw_cfg, virtio transports | the core | `vm_snapshot_save` / `vm_snapshot_restore` (ABI 30, [abi.md](../abi.md)): an explicit little-endian serialization with its own version, not a memory dump |
| Guest RAM (the framebuffer and the DTB are in it) | the host | 1 MiB chunks, zero pages left out, each chunk compressed on its own |
| Backend state | the host | per device, only where a backend has any (the deterministic rng's position; 9p's tree later). The page's devices (rng, blk, input, net) have none: see "Buffers the backends hold" |
| The disk's changes (the OPFS overlay's blocks) | the host | the same blocks a changes file holds, compressed; the base image is never in the file |
| What the machine is | the host | a JSON header: format and core-state versions, the machine (name, vCPUs, RAM, framebuffer, device list), the disk's identity, the date, the serial terminal's last output |

**Not in it:** the JIT's code caches, the TLBs, the broadcast-maintenance queues and DSB waits
(a restored VM starts with empty TLBs and caches, so there is nothing to maintain), counters,
the firmware image (RAM has what the guest loaded).

### Quiescing

A snapshot is taken with **every vCPU out of the core and the backends done with every request
they don't hold**:
- Round-robin: between two `vm_run` calls, after `settle()`. Nothing new.
- Parallel: `pause()` raises STOP; each vCPU worker leaves `vm_run_cpu` at its next chunk boundary
  and waits (it keeps its core instance and code cache); the coordinator rings the device doorbell
  and waits for it to be served; `resume()` clears STOP and wakes the workers. A vCPU that is OUT
  is in no DSB wait, and a pending CPU_ON request is saved as one (no need to wait it out).
- The core then takes the completions the backends left (`vm_snapshot_size`), exactly as the run
  loop would at its next boundary, so in deterministic mode the machine that continues takes the
  same steps as one that was never snapshotted. (A *restored* machine has empty TLBs, which a
  guest that leans on stale entries can tell by its step count: [platform.md](../platform.md)
  "Snapshots".)

### Buffers the backends hold

A virtio backend holds chains it has nothing for yet (virtio-net's and the console's receive
buffers, virtio-input's event buffers). They are in flight when the snapshot is taken, and a
restored machine's new backends must hold them again, or the guest's network and keyboard are dead.
**The core does it, for every device:** each transport keeps its in-flight chains in order, saves
that list, and on restore posts them again to the request ring (walking the descriptors, which
the device still owns, from the restored RAM). The new backends take them as they take any request. So
backends need no code for it, and one that only holds buffers has no state to save.

### Time

- Deterministic: steps and skipped ticks are saved; the restored VM continues the count.
- Realtime: the counter continues from its saved value (the clock gets an offset), so the guest
  sees no jump in CNTVCT and timers that were due fire at once. The PL031 shows **the host's
  current time** (its base is recomputed), as a real RTC does after a suspend; the guest's own
  system clock stays behind by the time the snapshot sat in a file until something sets it
  (`hwclock -s`, timesyncd over a network).

### The disk pins the snapshot

A snapshot is valid only with the disk state it was taken with (the guest's page cache and
filesystem state are in RAM). So:
- **A snapshot file carries the disk's changes** (the overlay's blocks) and the base image's
  identity. Restoring it **replaces the local overlay** (confirmed: it says how much goes, as Reset
  disk does) with the file's blocks, then resumes. The base must be the disk on the page: the
  machine's own, or a disk the user opened first (as for a changes file).
- **The base's identity:** phase B identifies a chosen file by name, size and modification time,
  a URL by its path, and a changes file's base by its SHA-256 (`hashSource`: 1.8 s for Debian's
  384 MiB). A snapshot records the cheap identity always and the hash where the writer has it; a
  restore accepts the same identity at once, and hashes the base only when the identity differs
  and the file has a hash (settled in loop 6).
- The variable store is the flash bank, which is in the core's state; the copy beside the overlay
  is rewritten from it after a restore.
- The machine is **paused while the file is written** (RAM and the overlay must not move) and
  continues afterwards.

### The file

A user-facing format, streamed both ways (RAM is up to GiBs):
- `WEBPCSNP`, a format version, a JSON header with its CRC-32.
- Frames: `{tag, index, codec, raw length, stored length, CRC-32 of the stored bytes}` then the
  bytes. Tags: `CORE` (the core's state), `DEVS` (backend state, JSON), `RAM ` (one per non-zero
  1 MiB chunk, `index` = the chunk: a bitmap of its non-zero 4 KiB pages, then those pages),
  `DISK` (runs of overlay blocks, `index` = the device slot × 2^40 + the first block), `END ` (the frame count). A file
  without its `END ` is truncated.
- Each frame is compressed on its own, so frames can be produced and consumed by several workers
  on the shared memory. **The codec is the core's LZ** (codec 2: `core/src/lz.rs`, the LZ4 block
  format), on one worker, settled by measurement in loop 4 (`bench/boot/REPORT.md` "M8 phase C
  loop 4": 6 times faster to save than `CompressionStream`'s deflate-raw for a file 1.4 times
  larger); deflate-raw is codec 1, which the reader also takes.
- **Refusals** name what the user can do (phase A's problem/action style), before anything is
  touched: not a snapshot; a newer format; a core state version this core doesn't read; another
  machine configuration; another base disk; a checksum that fails; a truncated file.
- Out: `showSaveFilePicker` (called on the click) with a Blob download as the fallback, as Save
  disk does. In: a `File` read as a stream.

### Versions

The core's state has a **format version** (`SNAPSHOT_VERSION`), bumped when a saved field changes;
a unit test pins the saved bytes of a fixed machine so a forgotten bump fails CI. Not the wasm's
input hash: that would void every snapshot at every core change, including the JIT's, which never
changes what is saved. A snapshot from another version is refused; migrating is out of scope.

### The page

- **Save snapshot** (the header, beside Save disk): pauses, writes, resumes.
- **Load snapshot…**, or a snapshot file dropped or chosen with Open disk (told by its magic):
  confirms what it replaces, stops the machine, starts a new one from the file. The machine goes
  from `loading` straight to `running` (there is no login prompt to wait for), with the serial
  terminal showing the saved output's tail.
- The worker protocol grows `snapshot` (page → worker, with the file handle or none) and
  `start.snapshot` (a `File`); progress and errors as the disk export's.
- **Suspend** (the user, 2026-10-01: build it): the snapshot kept in OPFS beside the overlay,
  without the overlay's blocks (they are there already), and the machine stopped; the next page
  load resumes from it instead of booting. As built, an invariant voids it instead of the
  generation number first proposed: the copy exists only while no machine has written the disk
  since (dropped before any machine runs on the overlay; [frontend.md](../frontend.md)
  "Snapshots"); Reset disk drops it. Resuming a machine that kept running after its snapshot would need a copy-on-write
  layer per snapshot: not in this lane.

## Loops

One slice, one commit, a short report each. `scripts/ci.sh` at every commit; `scripts/ci-long.sh`
for the loops that touch parallel SMP.

1. **Core, round-robin: done.** What was built: [platform.md](../platform.md) "Snapshots" and
   [abi.md](../abi.md) "M8 phase C". Beyond the plan: both console rings are in the state (the
   host needn't drain TX first), RAM goes in before the restore (the transports read their
   chains from it), a save is refused while the held chains couldn't be posted again, and the
   per-vCPU state of both run modes is already saved in one form (loop 2 tests it in parallel).
   The plan was: `core/src/snapshot.rs` (writer, reader), save and restore of every part
   above, the in-flight lists and the re-post, the clock offset, ABI 30. Tests: unit (a program
   with a timer and a device: saved mid-run and restored into a fresh VM, both run on to the same
   state and steps; refusals; truncations and bit flips never panic; the pinned bytes), natively
   Buildroot (1, 2 and 4 vCPUs), the device test and Alpine restored at several steps with the
   console and total steps of an unbroken run. Planted: a register not saved, a queue index not
   restored, an in-flight chain not posted again.
2. **Core, parallel: done** (the tests: [testing.md](../testing.md) "Snapshots"; the native
   runner needs no pause of its own: a run of the vCPU threads ends, the VM is saved, the next
   run is the restored VM's). The plan was: save and restore in parallel mode (power states, pending CPU_ON, timer
   lines, the published IRQ lines), the native thread runner's pause; the bare-metal SMP tests,
   litmus and the atomics stress continuing in a restored VM; ThreadSanitizer. Planted: the counter
   not rebased.
3. **Host, round-robin: done** ([platform.md](../platform.md) "Snapshots": the host's half, and
   the finding that a restore is a TLB flush to a guest, which Alpine's userspace benchmark can
   tell). The plan was: `web/vm.ts`: `snapshot()` and `bootVm`'s `restore`; backend state
   (`Backend.save`/`restore`: the deterministic rng); Buildroot and Alpine round trips under the
   JIT in Node and Chromium with exact steps.
4. **The file and the RAM codec: done** (the container and the codec; the LZ is wired into
   the writer as codec 2 in loop 3, with the core instance it needs). `web/snapshot-file.ts` and its tests (round trip, every
   refusal, truncation, corruption); the codec measured in Chromium on real RAM images (ratio,
   save and restore throughput, one and several workers); the report in `bench/boot/REPORT.md`.
5. **Host, parallel: done** (the round trips are in `tests/snapshot.test.ts` and
   `tests/browser.test.ts`). The pause is **done** ([platform.md](../platform.md) "Pausing a VM",
   `tests/pause.test.ts`: the coordinator's `pause`/`resume`, the vCPU workers parked). Left: parallel
   round trips in Node and Chromium (Buildroot, litmus and stress on 4).
6. **The disk in the file: done** ([platform.md](../platform.md) "Snapshots"). The base's
   identity, measured: the SHA-256 of Debian's 384 MiB image takes 1.8 s (217 MiB/s), so a
   restore checks the cheap identity and asks for the hash only when that differs and the file
   has one; the page decides when to compute the hash it writes (loop 7: not while the machine is
   paused). The flash copy beside the overlay is the page worker's to rewrite after a restore
   (the restore deletes it with the overlay). The plan was: the overlay's blocks out and in through the device worker's handles,
   the base's identity (measured), the flash copy.
7. **The page: done** ([frontend.md](../frontend.md) "Snapshots"; Debian: a 175 MB file, the
   machine paused 1.4 s, loaded in a fresh profile in 2.1 s). The plan was: Save snapshot, Load snapshot, the drop, the messages; `tests/page-snapshot.test.ts`
   (Buildroot always; Debian: boot, write a file, download the snapshot, then in a **fresh
   profile** upload it and find the machine running, logged in, the file there, within N seconds;
   refusals). Planted: the overlay left out of the file.
8. **Suspend: done** (Debian: suspended in 1.3 s, resumed 0.8 s after a reload).
9. **Exit: done.** The numbers are the page tests' own timings (`bench/boot/REPORT.md` "M8 phase
   C exit"), not a `bench/run.ts` case: the tracked `page_debian` case is still in the backlog.
   The plan was: numbers (the `page_debian` bench case: page load to `running`; time to `running`
   from a snapshot; file size; save time), docs (abi, platform, devices, frontend, testing), the
   backlog, PLAN.md.

## Decisions

The user's (2026-10-01): **Suspend** is built; **the version policy** stands (a state format
version of its own, not the core build's hash); **the wall clock after a resume** is fine as it is
(the RTC is right, the guest's system time lags until something sets it).

Settled by measurement: the codec (loop 4), the base's identity check (loop 6).

Later, not this lane: the network across a snapshot (the guest keeps its lease; a link-down/up
on restore would make it ask again), 9p's tree, prebuilt snapshots shipped with the repo,
snapshots between core versions, live migration.
