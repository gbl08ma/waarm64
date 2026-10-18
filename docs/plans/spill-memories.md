# More guest RAM: spill memories as NUMA nodes (proposed 2026-10-18; under way)

Guest RAM lives in memory 0 beside the core (layout A, docs/architecture.md), which caps it at what 4 GiB leaves
after the core's heap reserve: the page offers up to 2560 MiB (`MAX_RAM_MIB`, web/app/machine.ts). This plan adds
**spill memories**: extra shared wasm32 memories (up to 4 GiB each) that hold the guest RAM past memory 0, described
to the guest as **CPU-less NUMA nodes**. Memory 0 keeps the code it runs today, byte for byte. Why NUMA and not swap
in a memory, or tiering by the guest: docs/backlog.md "More guest RAM than memory 0 holds" (the user's discussion,
2026-10-18: NUMA runs no extra guest code; guest code is the slowest thing we have).

## 1. Decisions

1. **The guest sees one RAM range per memory**, each its own `/memory` node in the DT with `numa-node-id` = the
   memory's index; memory 0 is node 0 and every `cpu` node is in node 0; a `distance-map` gives 10 locally and 20
   between nodes (the default "remote"; the distance only orders the guest's fallback, decision 5 of the backlog
   entry). Spill RAM starts at the next 1 GiB boundary after memory 0's RAM, so each node is aligned.
2. **The memory index rides in the TLB tag** (bits 11:3, stored inverted: mmu.rs). Every inline compare (the JIT's
   `emit::access`, `xmiss`, the interpreter's `Mmu::host` and `fast`) expects memory 0's all-ones and misses on a
   spill entry, so memory-0 code is unchanged. The interpreter's miss path recognises an entry that differs only in
   those bits and does the access through the spill accessor without a walk. The JIT's miss already re-runs the
   instruction in the interpreter (`jit_exec_mmu`), so **the JIT needs no change for correctness**; an inline second
   path for spill pages is a later step, only if the guest is shown to keep hot pages there (§3, S4).
3. **A host address names its memory:** the core's RAM pointers become a 64-bit host address whose bits 63:56 are
   the memory index (0: a plain pointer into memory 0, as today) and whose low bits are the offset in that memory.
   The access primitives (`mem::load`, `store`, the atomics, the pair ops) take it and branch once on the index; the
   fast paths that hold a TLB hit never see a spill address.
4. **The core reaches spill memories through an accessor:** Rust on wasm32 can't address memory 1. Natively the
   accessor is a pointer per memory (so `cargo test` and the native runners test the same paths); on wasm it is a
   small module the host generates, importing the spill memories and exporting loads, stores, compare-and-swap and
   copies by (memory, offset), which the core imports as `ram.*` (the M0.5 spike's `helper` shape,
   bench/spike/memory/REPORT.md §2).
5. **Devices address RAM by (memory, offset).** The virtio transport and the xHCI split a guest buffer at a memory's
   edge and post each piece with its memory index; the backends (web/devices.ts `Ctx.ram`, web/usb.ts, the GPU
   worker) get one view per memory. The record format changes with an ABI bump (docs/abi.md).
6. **NUMA balancing off without the user:** when a machine has spill memory, SMBIOS gains a type 11 string
   `io.systemd.credential:sysctl.extra=kernel.numa_balancing=0` (systemd 252+; the backlog entry says why and what
   ignores it).
7. **Sizes:** memory 0 takes what it holds today; the rest goes to spill memories of up to 4 GiB each. The page's
   host-memory check (`hostMemoryGiB`) counts all of it; `navigator.deviceMemory` reports at most 8, so the page can't
   confirm more than that and says so instead of refusing.

## 2. What doesn't change

- Machines with no spill memory: the DTB, SMBIOS, step counts and generated code are as today (checked by the
  existing DTB test and `tests/steps.txt`).
- The framebuffer, the DTB space, the firmware and the kernel image stay in memory 0.
- Snapshots keep memory 0's RAM as today and add the spill memories' (S3).

## 3. Steps

- **S0, the core (native):** `Mem` holds memory 0 and the spill memories; `Mem::read`/`write` and the host-address
  primitives handle both; the TLB fill stores the memory index; the interpreter's slow paths, page walks, DC ZVA,
  exclusives and the atomics work on spill pages; `VmConfig` names the spill sizes (ABI bump); the DTB and SMBIOS
  describe the nodes. Tests: unit tests (the tag, the accessor, `Mem` across memories, the DTB with two nodes against
  `dtc`), and a native VM run with spill RAM that touches it under the interpreter.
- **S1, wasm and the host:** the generated accessor module; `bootVm` makes the spill memories and hands them to the
  vCPU, device, compile and GPU workers; the virtio and xHCI records carry the memory; every backend uses a view per
  memory. Tests: the JIT and interpreter on spill pages in Node (`tests/jit.test.ts`-style), a Chromium boot with
  spill RAM.
- **S2, the page** (the user, 2026-10-18): **one RAM value**, as today (a drop-down or slider), with a warning
  when it is past what memory 0 holds (the rest goes to NUMA nodes, slower to reach); the split is automatic
  (memory 0 as large as it goes, then spill memories of up to 4 GiB). An **advanced section, hidden by default**,
  lets a user set the split: memory 0's size, how many spill memories and each one's size. Also the host memory
  check and docs/frontend.md.
- **S3, snapshots:** spill RAM in the snapshot file (web/snapshot-file.ts), a round trip in the page tests.
- **S4, on the dev VM** (a handover): Debian with spill RAM: the nodes (`numactl -H`), `numa_balancing` read as 0
  and the credential listed, where the kernel puts hot pages (`numastat` during a desktop workload), and what spill
  accesses cost against memory 0 (bench/boot). Then decide the JIT's inline second path.

## 4. Open

- Whether EDK2 (ArmVirtQemuKernel) maps the second `/memory` node as system memory (its `HighMemDxe` does for
  QEMU), and whether Debian's EFI stub keeps the nodes for `of_numa` (Linux ignores DT memory nodes under UEFI but
  keeps them for NUMA). Checked in S1's Chromium boot.
- Early memblock allocations go top-down, so some of the kernel's boot-time data lands in the top node. Measured in
  S4 before anything is done about it.
