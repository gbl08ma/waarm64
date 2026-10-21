# Guest RAM past memory 0: spill memories as NUMA nodes

Guest RAM lives in memory 0, beside the core (layout A, [architecture.md](architecture.md)), and a wasm32 memory holds
at most 4 GiB, less the core's heap reserve. RAM past what memory 0 holds goes to **spill memories**: more shared
wasm32 memories (up to 4 GiB each) that the guest sees as **CPU-less NUMA nodes**. Memory 0 runs the code it ran
before, byte for byte. A machine without spill memory has the same DTB, SMBIOS, step counts and generated code as
before (the DTB test and `tests/steps.txt` check it).

## Why NUMA, and not swap or tiers

What costs most here is guest code (the user's discussion, 2026-10-18).
- **NUMA runs no extra guest code.** A spill page is reached by the same load or store as any other page, so its cost
  is ours, per access. Swap would run the guest kernel's fault, swap-cache, block and reclaim paths, and TLB
  shootdowns, for every page that moves: ~10k+ instructions each way natively, all JIT-compiled here. It only pays
  for pages that stay cold almost forever. A synchronous swap device served by the core would cut the I/O latency,
  not that guest code. A ramdisk as swap for users who want the kernel's LRU to decide is a separate backlog item.
- **A second memory for all of RAM** measured +12–40% (M0.5's layout B, `bench/spike/memory/REPORT.md`), which is
  why only the pages past memory 0 go there.
- **Marking node 1 slower doesn't help by itself.** Memory tiers come from ACPI's HMAT (or dax/kmem, CXL), and the DT
  has no binding for them: the kernel prints "Demotion targets for Node 0: null". The DT's `distance-map` only sets
  the fallback order and scheduler hints. Even in a lower tier, demotion and promotion (`kernel.numa_balancing=2`) are
  off by default and run as guest code (page migration: a 4 KiB copy through our slow path).
- **NUMA balancing must be off.** Its scanner makes every task's pages inaccessible and faults them back, which is
  guest code, on node-0 pages too. Distro kernels turn it on by themselves with more than one node
  (`CONFIG_NUMA_BALANCING_DEFAULT_ENABLED`: "Enabling automatic NUMA balancing" at boot), and under UEFI the command
  line is the guest's GRUB's. So a machine with spill memory gets a **systemd credential in SMBIOS type 11** (OEM
  strings, `core/src/smbios.rs` `NUMA_CREDENTIAL`): `io.systemd.credential:sysctl.extra=kernel.numa_balancing=0`,
  read by `systemd-sysctl` (systemd 252+: Debian 12 and 13, Arch). systemd imports SMBIOS credentials only in a VM,
  and our type 0 sets the "virtual machine" bit its detection checks. Alpine (OpenRC) ignores it.

## How it works

- **The guest's view.** Each memory is one RAM range: its own `/memory` node in the DT with `numa-node-id` = the
  memory's index. Memory 0 is node 0, and every `cpu` node is in node 0. A `distance-map` gives 10 locally and 20
  between nodes. Spill RAM starts at the 1 GiB boundary after the RAM before it, so each node is aligned
  ([platform.md](platform.md) "Memory map"; `VmConfig::spill_layout`). EDK2 passes the nodes on, and Linux's
  `of_numa` reads them ("OF: NUMA: parsing numa-distance-map-v1", "Fallback order for Node 1: 1 0").
- **Sizes.** Memory 0 holds at most `MAX_MEMORY0_RAM` (web/ram.ts): 4 GiB less `HEAP_FLOOR` (1 GiB, [The heap
  floor](#the-heap-floor)) and 1 MiB for the scratch page and fw_cfg's files, so 3 GiB less 1 MiB. It is fixed, not
  what fw_cfg's files leave, so a machine's layout never moves between boots. The rest goes to up to 8 spill
  memories (`MAX_SPILL`) of up to 4 GiB each (`splitRam`).
- **The TLB tag carries the memory index**, in bits 11:3, stored inverted (core/src/mmu.rs). Every inline compare
  (the JIT's `emit::access`, `xmiss`, the interpreter's `Mmu::host` and `fast`) expects memory 0's all-ones, so it
  misses on a spill entry. `Mmu::miss` recognises an entry that differs only in those bits and does the access
  through the spill accessor without a walk. The JIT's miss already re-runs the instruction in the interpreter
  (`jit_exec_mmu`), so the JIT needed no change for correctness. That re-run is what a spill access costs
  ([Measurements](#what-a-spill-access-costs)).
- **A host address names its memory.** The core's RAM pointers are a 64-bit `Host`: bits 63:56 are the memory index
  (0: a plain pointer into memory 0), and the low bits are the offset in that memory. The access primitives
  (`mem::load`, `store`, the atomics, the pair ops) branch once on the index. Fast paths that hold a TLB hit never see
  a spill address.
- **The core reaches spill memories through an accessor**, because Rust on wasm32 can't address memory 1. Natively
  the accessor is a pointer per memory, so `cargo test` and the native runners test the same paths. On wasm it is a
  small module that web/spill.ts generates: it imports the spill memories and exports loads, stores,
  compare-and-swap and copies by (memory, offset). The core imports these as `ram.*` (the M0.5 spike's `helper`
  shape; [abi.md](abi.md)).
- **Devices address RAM by (memory, offset)** (ABI 40). The virtio transport and the xHCI split a guest buffer at a
  memory's edge and post each piece with its memory index ([devices.md](devices.md), [usb.md](usb.md)). The
  backends hold one view per memory (web/ram.ts `Ram`, `Segment`). virtio-gpu, which is handed guest PAs, finds the
  memory with `locate`. The vCPU and device workers get the spill memories; the compile worker reads no guest RAM.
- **The page** ([frontend.md](frontend.md) "Settings") offers one RAM value, up to 16 GiB. Past memory 0, a note says
  that the rest goes to NUMA nodes and is slower to reach. 3 GiB isn't offered: it would spill 1 MiB. A stored
  machine's Settings has an advanced section, hidden by default, for the split (`ramSplit`, part of its shape and
  definition); a transient machine takes `?split=`. The host-memory check counts all of the RAM.
  `navigator.deviceMemory` reports at most 8, so the page can't confirm more than that and says so instead of
  refusing.
- **Snapshots** ([plans/snapshots.md](plans/snapshots.md)): the spill memories' `RAM ` chunks follow memory 0's in
  the file, each memory from a whole chunk (web/snapshot.ts `ramStarts`). The header's `spill` lists their sizes
  (it is absent without them, so other files are unchanged), and so do the core's configuration words. A snapshot
  therefore restores only onto the same split; another machine's is refused.

## Measurements

The dev VM, headless Chromium 153, 2026-10-19. The JSON and tools are in `bench/boot/results/m8-spill/`
(`tools/numa-debian.ts`, `tools/numa-desktop.ts` with its memory-load page `tools/mem.html`, `tools/heap-go.ts`).

### Where the guest puts its pages

- **After boot** (Debian, `?ram=6144`: memory 0's 3071 MiB and a 3073 MiB node): node 1 has 29 MB used (Slab 5 MB,
  the rest the node's own structures) and no anonymous or file pages. Node 0 has 188 MB. Early memblock allocations
  going top-down put nothing that matters on node 1.
- **The kernel fills node 0 first and leaves its page cache there.** All CPUs are on node 0, so allocations are
  local first. With `zone_reclaim_mode` at 0 (the default), once node 0 is at its watermark new pages go to node 1
  rather than evicting node 0's clean page cache. Balancing is off, so they stay there.
  - The desktop guest (6 GiB, 4 vCPUs, sway and Firefox) runs with 1.7 GB used on node 0 (1.1 GB of it page cache)
    and nothing on node 1.
  - Memory-load tabs then pushed the active set past memory 0. tools/mem.html holds 384 MB per tab and reads every
    64-byte line of it every 5 s, in a worker. The first three tabs filled node 0, and the other five went entirely
    to node 1: 1.9 GB of Firefox's anonymous memory on node 1. The 1.1 GB of page cache stayed on node 0 throughout.
- **`vm.zone_reclaim_mode=1` doesn't change that much.** It reclaims only unmapped clean cache: node 0's page cache
  went from 1.1 to 0.9 GB, and node 0 took ~200 MB more of the tabs (`desktop-reclaim/`). It is not worth a
  credential.

### What a spill access costs

Every access to a spill page leaves JIT code for the interpreter, so the cost scales with the accesses, not with the
pages.

Debian, `?ram=6144`, 2 vCPUs. Each workload is bound to node 0, then to node 1 (systemd-run's
`NUMAPolicy=bind`; its input is on a tmpfs bound to the same node). Five rounds, alternating 0,1 and 1,0; ms in the
guest, median (IQR):

| Workload | Node 0 | Node 1 | Node 1 / node 0 |
|---|---|---|---|
| `dd` 512 MiB from /dev/zero (the kernel's `clear_user`) | 326 (37) | 2446 (88) | 7.5× |
| `cat` of a 32 MiB tmpfs file | 224 (31) | 483 (36) | 2.2× |
| `sha256sum`, 32 MiB | 352 (27) | 1488 (177) | 4.2× |
| `gzip -1`, 32 MiB | 3540 (18) | 67723 (2853) | 19× |
| `sort`, 16 MiB | 753 (44) | 5725 (262) | 7.6× |
| perl, a 300k-key hash | 1191 (75) | 13210 (290) | 11× |

On the desktop guest, a memory tab's sweep of 384 MB (6M loads) took a median of 170 ms (quartiles 146–330) on
node 0 and 1083 ms (863–1203) on node 1: 6.4×. The dd row suggests roughly 60–250 ns per spill access beyond a
memory-0 access, depending on whether the kernel clears with `stp` or DC ZVA.

**What the user felt was small.** On the desktop, with 1.9 GB of active memory tabs on node 1:
- The WebGL 2 window (bench/gpu/firefox/webgl.html) kept 20–26 frames a second, against 21 before the fill. The
  video window (VA-API, decoded by the host) kept 24.
- The guest ran more steps a second (MIPS 194 → 386), because the node-1 sweeps were working harder.
- With the WebGL and video windows closed and opened again after the fill (their new memory can only come from
  node 1), they ran at 18–31 and 24 frames a second.

Their hot data and work are mostly elsewhere (node 0, and the host's GPU and decoder). The slowdown lands on what
reads node-1 memory itself.

Once in each busy-tab run (`desktop/` and `desktop-reclaim/`), the reopened video stopped presenting after ~40 s.
With the same placement and idle tabs (`desktop-idle-tabs/`: node 0 full, 1.2 GB on node 1), it played on for
2.5 minutes, and with nothing on node 1 (`desktop-control/`) too. So it isn't the spill path's data. It is open in
[backlog.md](backlog.md) "Spill memories".

### The JIT's inline second path: not built

A second path in `emit::access` would turn a spill access from an interpreter round trip into a few instructions:
on a tag that differs only in the memory bits, a `br_table` on the index into the access's body with the memarg
naming that memory. JIT modules would import the spill memories (multi-memory), and each access would carry a copy of
its body per spill memory. It is not built because the measurements above show the guest keeps spill pages cold
until its active set really outgrows memory 0, and even then what the user watched held its rate. The numbers and
the design are in [backlog.md](backlog.md) "Spill memories", as is the alternative of tiering on the host.

### The heap floor

`HEAP_FLOOR` (web/ram.ts) is the least heap a fixed memory gets. It caps memory 0's RAM, so lowering it would move the
automatic split, and snapshots of machines at the old ceiling would then load only onto a split set by hand. It stays
at **1 GiB**: the core's heap is much larger than the ~150 MB once seen (`jit.md` "Memory").

The bench-only hook `heapUse` (web/vm.ts; the page's `window.__webpcHeap()` with `?displaystats`) counts the
reserve's non-zero pages in 32 MiB buckets. The allocator carves the reserve from its start, and freed memory keeps
its bytes, so the extent of touched pages is the heap's high-water mark.
- Debian on 4 vCPUs with two `go build` loops and a `find | sha256sum` churn (`heap-go/`, 7 minutes, one JIT flush)
  reached ~540 MiB.
- The desktop guest's session with Firefox reached ~600 MiB.

A floor under ~768 MiB would leave no margin, and the 256 MiB the backlog once proposed is far too small. What fills
it is broken down in [jit.md](jit.md) "The core's heap" (2026-10-21): mostly the tables' decoded blocks (~360 MiB on 4
vCPUs), then the JIT's block map (bounded at ~60 MiB since: unbounded, it ran the desktop guest's heap out).

## Tests

[testing.md](testing.md) "Guest RAM past memory 0" lists them:
- Unit tests of the host address, the TLB tag and miss, the DT against `dtc`, SMBIOS and the split.
- Native and Node runs with code and data in a spill memory.
- The page's split and Settings.
- `tests/page-spill.test.ts`: Debian with `?split=2560,1024,512` (three nodes, balancing off, data and direct disk
  I/O through nodes 1 and 2, and a snapshot loaded in a fresh profile).
- The snapshot file's spill RAM round trip.
