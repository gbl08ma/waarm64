# Snapshots (M8 phase C lane; not started)

A plan, not a description: nothing here exists yet. It was phase B's proposed kickoff until phase B
became "your own disk" (PLAN.md §3), and is kept for when this lane starts. The user decided on
2026-09-29 that snapshots are **files the user downloads and uploads**. The rest is a proposal to
confirm at the lane's kickoff. **Revisit it after phase B:** below, a snapshot carries the page's
OPFS overlay, and phase B changes what a disk is (images by URL or file, just the changes as a
qcow2 over a backing file). A snapshot will probably pin a phase B disk the same way.

**Goal:** the page resumes a booted machine in a few seconds instead of a ~30 s boot, and **the
user owns their snapshots as files**: the page offers the running machine's snapshot for
download, and a snapshot file uploaded to the page (a file picker and drag and drop onto the
screen) resumes that machine. Proposed on top: the page also keeps the latest snapshot in OPFS
and resumes from it on reload (to confirm with the user).
- **What a snapshot holds:** every vCPU's `Cpu` (1,072 bytes each, `core/src/cpu.rs`: registers,
  system registers, timers' state) and its pending state; the platform in the core (GICv3
  distributor and redistributors, the PL011 and its rings, the PL031's offset, PSCI power states, virtio-mmio
  transports and their queue addresses and indices, reset epochs); guest RAM, **compressed**
  (1 GiB, mostly zero pages early on: page-level zero elision plus a fast compressor via
  `CompressionStream`; measure deflate vs doing it in wasm); the device worker's backend state
  (the overlay's map is on OPFS already; blk requests in flight must be drained first; input and
  rng hold nothing that matters); the DTB and command line it was booted with. **Not** the JIT's
  code caches, TLBs or jump caches: rebuilt on demand (invalidate everything on restore).
- **Quiescing:** round-robin needs nothing new. Parallel SMP stops every vCPU worker at a chunk
  boundary (STOP, every `OUT`), with each maintenance queue drained and no CPU_ON pending
  (backlog "Snapshots in parallel SMP"); the device worker finishes in-flight requests and holds
  new ones. Time: realtime counters are rebased on restore so the guest sees continuous time
  (CNTVCT offset), and timers due in the gap fire at once.
- **The overlay pins the snapshot, so a snapshot file carries the overlay.** A snapshot is valid
  only with the disk state it was taken with, and an uploaded file may land in a browser with a
  different overlay or none. Proposed: the file holds the overlay's contents (the blocks written
  over the base image, compressed) plus the base image's identity (its SHA-256, as pinned in
  `images/debian.json`); restoring an upload replaces the local overlay after a confirmation (it
  would discard the local disk's changes, like Reset disk: say how much). The base image itself is
  never in the file (it's 400 MB and every copy has it). Locally, taking a snapshot freezes the
  overlay at that point (a generation number in both, or a copy-on-write layer); Reset disk drops
  the local snapshot; a mismatch refuses to restore and says why.
- **Disk export and import are phase B's** (the whole disk, or just the changes as a qcow2 over
  the base image), not this lane's.
- **The snapshot file is a user-facing format**, so: a header with a magic, a format version and
  the core build it needs (the wasm input hash `npm start` computes is a candidate), the machine
  config (machine name, vCPUs, RAM, command line, base image hash), a checksum per section, and
  sections for CPU state, platform, devices, overlay and RAM, each compressed. An upload from
  another core build, another base image or a newer format is refused with a message a user can
  act on (loop 4's problem/actions style), never restored half-way. Streams both ways, because
  RAM is up to GiBs: download through the File System Access API's `showSaveFilePicker` (Chromium)
  with a Blob download as the fallback, upload read as a stream from the `File`, decompressed as
  it's read; measure save time, file size and restore time for Debian after login.
- **ABI:** export/import of core state (`vm_snapshot_size`, `vm_snapshot_save(ptr)`,
  `vm_snapshot_restore(ptr)` or a layout in docs/abi.md), a version in the header that refuses a
  snapshot from another core build (the wasm's input hash `npm start` already computes is a
  candidate). Design note in docs/abi.md first (pre-approved in phase A's style).
- **Where it lives:** with the user, as downloaded files (above); the local copy for resume on
  reload in OPFS next to the overlay (`webpc-debian.snap`), per origin and profile, if the user
  confirms it. Prebuilt snapshots shipped with the repo are a later question (they'd tie the page
  to one core build).
- **The page:** a Snapshot action (download) and an upload (button plus drop on the screen); a
  `resumed` power state; the worker protocol grows `snapshot` / `restore` messages (and a
  streamed transfer of the file between the page and the machine worker).
- **Tests:** a core unit test (save, restore into a fresh VM, run both in deterministic mode:
  identical console and **identical steps from the restore point**, the strongest check we have);
  Buildroot and Alpine round-trips in Node and Chromium (deterministic, exact steps); a parallel
  round-trip (litmus and stress continuing after a restore); the page: boot, write a file, download
  the snapshot, then in a **fresh browser profile** upload it and find the machine resumed, logged
  in and the file there within N seconds; an upload from another core build or base image and a
  corrupted file refused with their messages. Planted bugs: a register not saved, a queue index
  not restored, the counter not rebased, the overlay left out of the file.
- **Numbers:** time to `running` from a snapshot (target: a few seconds), snapshot size and save
  time; add the `page_debian` bench case then (backlog "The page").
- **Out of scope:** migrating snapshots between core builds, live migration, snapshots of the
  test guests' step counts (a restore must not change them).
