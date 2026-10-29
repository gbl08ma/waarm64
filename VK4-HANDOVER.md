# VK4 handover

Notes that carry a task from one session to the next (VK4-KICKOFF.md "How VK4 runs"). A section per open task.

## T2: blocked on T19

**State (2026-10-29).** Committed: everything that doesn't depend on memory's layout (VK4-KICKOFF.md's T2 row,
bench/vulkan/REPORT.md "VK4 T2"). Left: host-visible Vulkan memory's bytes live in the renderer's 255 MiB arena while
the device advertises one 2 GiB heap for both memory types, so a guest that allocates past the arena loses its
context (Venus's guest allocates without waiting; its later free is a CS error). `memory.allocation.random` and
`memory.mapping.suballocation.random` (300 cases, every one passing in one run) take the arena to 241 MiB and stay out
of `tests/deqp/vk.txt`.

**Tried:** a 128 MiB heap of its own for the host-visible type (`WG_HOST_HEAP_SIZE`, heapIndex 1): the random groups
peaked at 99 MiB and both dEQP-VK lists passed, but `tests/page-venus.test.ts`'s replays failed: GFXReconstruct's
`-m remap` maps a host-visible type only onto a heap ≥ 1 GiB (`kMinHeapSize`, smaller ones are a dGPU's BAR window),
and VMA and DXVK make the same distinction. Reverted by the user's call: a heap programs accept needs an arena of
~1 GiB, which memory 0 can't spare.

**Next, once T19 has landed:** give the host-visible type a heap the arena backs (≥ 1 GiB, its own or the one heap
sized to the arena), check the replays (`scripts/ci-deqp-vk.sh` runs them), add the random groups to the list, and
close T2 (its kickoff row, this section deleted). `tests/venus-renderer.test.ts` "the memory budget reports the heap
and its use" checks the heap's layout: update its expectations with it.
