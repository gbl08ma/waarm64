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
  not that guest code. A ramdisk as swap, for users who want the kernel's LRU to decide, is a box on the Home page ([machines.md](machines.md) §4.3 "As swap").
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
  floor](#the-heap-floor)), so 3 GiB. The scratch page and fw_cfg's files come out of the heap's reserve, as the core's
  static data and stack do, so the ceiling doesn't depend on them and a machine's layout never moves between boots.
  (Until 2026-11-21 they were kept outside the reserve and the ceiling was 3 GiB less 1 MiB: a machine past it on the
  automatic split got the new layout then, and its older snapshots refuse to restore, [machines.md](machines.md) §5.1.) The rest goes to up to 8 spill
  memories (`MAX_SPILL`) of up to 4 GiB each (`splitRam`).
- **The TLB tag carries the memory index**, in bits 11:3, stored inverted (core/src/mmu.rs). Every inline compare
  (the JIT's `emit::access`, `xmiss`, the interpreter's `Mmu::host` and `fast`) expects memory 0's all-ones, so it
  misses on a spill entry. `Mmu::miss` recognises an entry that differs only in those bits and does the access
  through the spill accessor without a walk. JIT code reaches spill memory 1 in a second arm of each load and store
  ([The JIT's spill arm](#the-jits-spill-arm)); for the other spill memories its miss re-runs the instruction in the
  interpreter (`jit_exec_mmu`).
- **Memory 1 on a machine with Vulkan** (VK4 T19) holds Venus's renderer first (its arena, web/ram.ts
  `VENUS_ARENA`), then the host-visible window (`VmConfig.window_at`, [devices.md](devices.md) "The host-visible
  window"), then node 1's RAM, if any: a region is a guest-physical range at an offset in its memory (`mem::Spill`'s
  `off`), and node 1 holds at most 4 GiB less the arena and the window (1,536 MiB; `splitRam`'s `reserve`). Such a
  machine has memory 1 even without a NUMA node, and its JIT code the memory-1 arm, so the window's pages are reached
  as node 1's. Memory 0 is then as large as without Vulkan.
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
  memory with `locate`. The vCPU and device workers get the spill memories, and JIT modules import memory 1
  (`env.ram1`); the compile worker reads no guest RAM.
- **The page** ([frontend.md](frontend.md) "Settings") offers one RAM value, up to 16 GiB. Past memory 0, a note says
  that the rest goes to NUMA nodes and is slower to reach. 3 GiB isn't offered: it would spill 1 MiB. A stored
  machine's Settings has a box beside the RAM slider, unticked by default, that shows fields for the split
  (`ramSplit`, part of its shape and definition); a transient machine takes `?split=`. The host-memory check counts all of the RAM.
  `navigator.deviceMemory` reports at most 8, so the page can't confirm more than that and says so instead of
  refusing.
- **Snapshots** ([platform.md](platform.md) "The snapshot file"): the spill memories' `RAM ` chunks follow memory 0's in
  the file, each memory from a whole chunk (web/snapshot.ts `ramStarts`). The header's `spill` lists their sizes
  (it is absent without them, so other files are unchanged), and so do the core's configuration words. A snapshot
  therefore restores only onto the same split; another machine's is refused.

## Measurements

The dev VM, headless Chromium 153, 2026-10-19. The JSON and tools are in `bench/boot/results/m8-spill/`
(`tools/numa-debian.ts`, `tools/numa-desktop.ts` with its memory-load page `tools/mem.html`, `tools/heap-go.ts`).

### Where the guest puts its pages

- **After boot** (Debian, `?ram=6144`: then memory 0's 3071 MiB and a 3073 MiB node): node 1 has 29 MB used (Slab 5 MB,
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

With the JIT's spill arm, an access to spill memory 1 costs a little more than one to memory 0: node 1 runs Debian's
workloads at 1.0–1.6× node 0's time. Before it, every spill access left JIT code for the interpreter (2.1–17×), which
is still what an access to spill memory 2 and up costs.

Debian, `?ram=6144` (then memory 0's 3071 MiB and a 3073 MiB node), 2 vCPUs. Each workload is bound to node 0, then to
node 1 (systemd-run's `NUMAPolicy=bind`; its input is on a tmpfs bound to the same node). 2026-10-24, the dev VM,
Chromium 153: the arm off and on alternated twice (`base, arm, base, arm`), three rounds each alternating 0,1 and 1,0;
ms in the guest, median of the six [range] (`bench/boot/results/m8-spill/debian-arm/`):

| Workload | Node 0, no arm | Node 1, no arm | Node 0, arm | Node 1, arm | Node 1 / node 0: no arm → arm |
|---|---|---|---|---|---|
| `dd` 512 MiB from /dev/zero (the kernel's `clear_user`) | 404 [317–493] | 2490 [2362–2560] | 364 [336–382] | 430 [425–442] | 6.2× → 1.18× |
| `cat` of a 32 MiB tmpfs file | 234 [164–341] | 482 [402–580] | 196 [176–215] | 208 [198–221] | 2.1× → 1.06× |
| `sha256sum`, 32 MiB | 318 [276–407] | 1378 [1267–1463] | 318 [290–334] | 322 [314–343] | 4.3× → 1.01× |
| `gzip -1`, 32 MiB | 3685 [3606–3774] | 63606 [63258–64403] | 3720 [3638–3747] | 6020 [6014–6058] | 17× → 1.62× |
| `sort`, 16 MiB | 744 [636–897] | 5232 [5132–5427] | 704 [663–758] | 828 [816–921] | 7.0× → 1.18× |
| perl, a 300k-key hash | 1258 [1153–1351] | 12418 [11954–12637] | 1241 [1174–1255] | 1730 [1691–1775] | 9.9× → 1.39× |

Node 0's times are the same either way (the arm is in the access's cold path). The 2026-10-19 run without the arm
(`debian/`, five rounds) had the same shape: 2.2–19×.

On the desktop guest without the arm, a memory tab's sweep of 384 MB (6M loads) took a median of 170 ms (quartiles
146–330) on node 0 and 1083 ms (863–1203) on node 1: 6.4×. The dd row suggested roughly 60–250 ns per spill access
beyond a memory-0 access then, depending on whether the kernel clears with `stp` or DC ZVA.

**On the desktop** (`tools/numa-desktop.ts`: 6 GiB, 4 vCPUs, memory tabs of 384 MB each opened until 2 GB of
Firefox's anonymous memory is on node 1, a WebGL 2 window and a VA-API video window beside them, both closed and
opened again after the fill so their new memory can only come from node 1):
- **With the arm** (2026-10-24, `desktop-arm/`): the node-1 tabs' sweeps took a median of 161 ms (quartiles
  140–178) against the node-0 tabs' 123 ms (111–141), 1.3×; the WebGL window ran 24–28 frames a second through the
  fill and 29–33 reopened; the video kept 24 throughout, 2.3 minutes reopened.
- **Without the arm** (2026-10-19, `desktop/`): the node-1 tabs' sweeps took ~1083 ms, 6.4×; what the user watched still
  held its rate (WebGL 20–26 frames a second, 18–31 reopened; video 24), because those windows' hot data and work are
  mostly in node 0 and on the host's GPU and decoder.

In each 2026-10-19 busy-tab run (`desktop/` and `desktop-reclaim/`) the reopened video once stopped presenting
after ~40 s (24 → 0.1 frames a second, the WebGL window beside it on at 31); not with idle tabs on node 1, not without
the fill, and not in the arm's run. A review of the host's video path (the clip is VP9, decoded in software: one
picture in, one out) found no mechanism: every failure there drops pictures without making the guest wait, the
command queue holds calls for at most 1–3 s, and a held queue would have held the WebGL window's fences too. If it
comes back, the GPU worker's video counters (`render-stats`) tell guest from host: `frames` (the guest's END_FRAMEs)
stopping means the guest stopped decoding; `frames` growing while `decoded` stalls means ours.

### The heap floor

`HEAP_FLOOR` (web/ram.ts) is the least heap a fixed memory gets. It caps memory 0's RAM, so lowering it would move the
automatic split, and snapshots of machines at the old ceiling would then load only onto a split set by hand. It stays
at **1 GiB**: the core's heap is much larger than the ~150 MB once seen (`jit.md` "Memory").

The bench-only hook `heapUse` (web/vm.ts; the page's `window.__waarm64Heap()` with `?displaystats`) counts the
reserve's non-zero pages in 32 MiB buckets. The allocator carves the reserve from its start, and freed memory keeps
its bytes, so the extent of touched pages is the heap's high-water mark.
- Debian on 4 vCPUs with two `go build` loops and a `find | sha256sum` churn (`heap-go/`, 7 minutes, one JIT flush)
  reached ~540 MiB.
- The desktop guest's session with Firefox reached ~600 MiB.

A floor under ~768 MiB would leave no margin, and the 256 MiB the backlog once proposed is far too small. What fills
it is broken down in [jit.md](jit.md) "The core's heap" (2026-10-21): mostly the tables' decoded blocks (~360 MiB on 4
vCPUs), then the JIT's block map (bounded at ~60 MiB since: unbounded, it ran the desktop guest's heap out).

## The JIT's spill arm

A load or store in JIT code (`emit::access`) checks its TLB entry against memory 0's tag, and its fast path runs on a
hit. With the MMU on and spill memory, the failure side (deferred code: V8 keeps it off the hot path) first checks
the same entry for spill memory 1: `tag ^ ((va + len - 1) | 0xfff) == 1 << 3`, the memory index's bit alone, and the
access's guards again. On a match, the access's body runs again with the host offset from the entry's addend, its
guest RAM accesses naming memory 1. Everything else (a miss, another spill memory, a failed guard) goes to the helper
as before.
- **Multi-memory.** JIT modules of a machine with spill memory import memory 1 as `env.ram1`, with exact limits
  (`jit::Config::spill`, from `VmConfig.spill`; web/jit-host.ts's `jitHost` passes it, ABI 52). The bodies write their RAM
  accesses through `Code::ram`, `ram_atomic` and `ram_simd`, which add the memory index to the memarg while
  `Code::ram_mem` is set; `Vcpu` fields, the pair locks and the clock stay on memory 0. V8 reaches memory 1 through
  its guard region, as memory 0 (no bounds check), with its base loaded from the instance.
- **The body twice.** The arm starts from the registers as they were at the access's `if` and leaves them as the fast
  path does (a debug assertion checks it), and the masks of what the block reads count the fast path's reads alone.
  A CASP or exclusive pair takes the same pair lock, which hashes the address's offset, as the interpreter's
  `Mem::pair_op` does for any memory.
- **Code.** Without spill memory, a block's code is byte for byte what it was. With it, each load and store carries
  one more copy of its body in its cold path: Alpine's userspace benchmark on a spill machine (`alpine_user_spill_jit`)
  compiled the same blocks into 15% more wasm bytes, in the same compile time (bench/boot/REPORT.md "M8: the JIT's
  spill arm"). The JIT cache's budget counts them, so a spill machine's cache holds ~13% fewer blocks.
- **Only memory 1** (`jit::INLINE_SPILL`). The guest fills node 0, then node 1 (the zonelist's order at equal
  distance), so node 2 holds active pages only past 7 GiB of them. Each more memory inline would add another copy to
  every access.

**Why not tier on the host.** The alternative was to give the guest one flat RAM and move hot pages into memory 0
behind its back. With the arm, node 1 runs at 1.0–1.6× node 0's time, which is all a tier could win back, and a tier
costs on every path: a physical-to-host table for `Mem` and every DMA, finding cold memory-0 pages, and a stop of every
vCPU for each move in parallel SMP.

**Tests.** `tests/jit-diff-suite.ts` runs the load and store classes with the MMU on, at EL1, on data in spill memory 1
(the arm) and 2 (the helper), an interpreter VM against a JIT-check VM, and checks that a warm load on memory 1 makes
no helper call while one on memory 2 makes one each time. Planted: the arm naming memory 0 (every class touching
spill data fails), and one access each left on memory 0 (LD1's lane load, STXP's W pair: those classes fail). The
emitted bytes: `jit::emit::tests::loads_and_stores`.

## Tests

[testing.md](testing.md) "Guest RAM past memory 0" lists them:
- Unit tests of the host address, the TLB tag and miss, the DT against `dtc`, SMBIOS and the split.
- Native and Node runs with code and data in a spill memory.
- The page's split and Settings.
- `tests/page-spill.test.ts`: Debian with `?split=2560,1024,512` (three nodes, balancing off, data and direct disk
  I/O through nodes 1 and 2, and a snapshot loaded in a fresh profile).
- The snapshot file's spill RAM round trip.
