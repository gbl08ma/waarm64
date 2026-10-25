# M8 VK1 handover

Notes between VK1's sessions (the brief: `M8-VK1-KICKOFF.md`). Newest state first.

## State (2026-10-25)

- **Step 1, route (b)'s premise: passed** (bench/vulkan/REPORT.md "VK1 step 1", `bench/vulkan/results/vk1/step1/`):
  `spirv_to_nir` + NIR's passes + KosmicKrisp's `nir_to_msl` in wasm, 0.42 MiB brotli, 0.27 ms a stage at the median in
  Chromium on the M4, 108/108 stages, NIR identical to native. Toolchain: **wasi-sdk 34** (beat Emscripten 6.0.13 cold
  by 11–17%, equal warm). `bench/vulkan/nir/build.sh` rebuilds it all from `target/venus-oracle/mesa`.
- THIRD_PARTY.md audited (its own commit). **The window (L3, ABI 53)**: `VmConfig.window` puts the host-visible window
  in memory 0 right after RAM (outside `/memory`; spill memories past it), and a transport whose `DeviceEntry.shm` is 1
  reports it as SHM region 1. Why memory 0: Venus writes its whole command stream into host-visible blobs, so the window
  must be on the JIT's inline path (memories past 1 go through the interpreter: spill-memories.md).
- **The write-watch (L4)** is built (docs/devices.md "The host-visible window"; tests in docs/testing.md): records of
  watched write fills, marked when dropped; the host's look (`web/window.ts` `WindowWatch.take`) bumps a generation
  and waits only for running vCPUs. No measurable cost without a window (REPORT.md "VK1: the write-watch costs…").
  Marking at the fill turned out redundant (a planted bug there was caught by nothing): the drop's mark is the one.
- **The device (L5)** is built (docs/devices.md "Venus"): `GpuOptions.venus` (with `virgl`), features, the VENUS
  capset, Venus contexts, blobs created/mapped/unmapped by the host (`VenusCall`), Venus submits handed on, snapshots
  refused. Linux's driver takes it (`tests/venus.test.ts`). Found on the way: `vm_boot` sized `/memory` from `Mem`, which
  includes the window (fixed: RAM is `Mem` less the window).
- Next: **L6, the renderer** (plan below).

## Designs decided, not built yet

- **L6's plan (the renderer):** a top-level `vk/` (C for wasm, like `net/ts`): `vk/build.sh` fetches virglrenderer at
  the oracle's commit and builds into `target/vk/venus.wasm`, with wasi-sdk and step 1's `gen.ts` approach for Mesa
  (the native build's compile commands and generated sources): (1) `vkr` (`src/venus/*.c`, its codegen, venus-protocol
  1.1.3's headers, the bits of virglrenderer's util it needs) with patches (`vk/patches/`): the ring, ring monitor and
  queue sync threads become polls; resources are pointers, not fds (shmem from the arena; a device memory's storage
  from our driver); a map moves a resource's storage into the window and an unmap out; the library loader points at
  our driver's `vk_icdGetInstanceProcAddr`. (2) Our null driver on Mesa's *lite* runtime (`libvulkan_lite_runtime`,
  `libvulkan_util`, as Venus links them: no NIR yet; VK2 moves to the full runtime): a physical device advertising
  VK0's direct set as a GPU, memory types (host-visible ones' storage in the window once mapped), objects as runtime
  structs, command buffers recorded through `vk_cmd_queue` and replayed at submit for their transfers only
  (fill/update/copy buffer, timestamps, queries, events: Venus's feedback slots), fences and semaphores signalled at
  submit, draws dropped; at each submit it calls `env.window_dirty()` (the GPU worker's `WindowWatch.take`) and counts
  the pages. (3) The GPU worker instantiates it on memory 0 at a fixed arena at memory 0's top (256 MiB at 0xF000_0000:
  `--global-base`, its stack and an `sbrk` inside it; a Venus machine's memory is fixed at 4 GiB, the core's heap
  reserve stopping below the arena), routes `VenusCall`s to `vkr_renderer_*`, and polls the ring (awake across frames,
  idle after vkr's timeout). Memory 0 then holds RAM, the window (256 MiB) and the arena (256 MiB): RAM past that
  spills.
- **The renderer module (L6):** `vkr` + a null Mesa driver in one wasm module instantiated **on memory 0** (the ring,
  reply and command-stream blobs and feedback memory are all window pointers), linked at a fixed arena at the top of
  memory 0 (`--global-base`, its own stack, an `sbrk` confined to the arena); `vkr`'s threads (ring, ring monitor,
  queue sync) become polls the GPU worker drives. The capset is `vkr_get_capset`'s (`use_guest_vram` 0: our driver
  allocates mappable memory in the window, so MAP_BLOB is an offset).

## Things worth not re-discovering

- Mesa builds NIR as headers only when no driver that compiles is enabled: the native build enables the Venus ICD
  (`-Dvulkan-drivers=virtio`) just to get libnir whole. Mesa 26.2.4's `spirv2nir` target doesn't link (libnir missing
  from its link line); the harness links the static libraries itself.
- gdb can't run in the dev VM (it fails on the M4's SME/SVE registers under Lima): use the ASan build
  (`bench/vulkan/nir/build.sh native-asan`) for stack traces, valgrind for the rest.
- `nir_to_msl` needs textures as handles (the driver's descriptor lowering) and subpass dims lowered to 2D, or it
  crashes / warns; spike.c has small passes of ours for both.
- The SPIR-V dumps: `SPIRV_DIR=target/vk1/spirv bench/vulkan/translate/programs.sh target/vk1/d` (~8 min, 108 stages;
  GTK4's demo compiles 14 in 15 s, not VK0's 16).
- `tests/usb-glue.test.ts` hung CI again (2026-10-25): a 10 ms wait for port messages failed under load, and the
  ports left open kept the file alive; fixed (bounded wait, `t.after` closes them).
- Don't name a local `window` in `web/vm.ts`'s `bootVm`: `typeof window` decides there whether the thread can block
  (realtime boots in a page worker went idle at virtio probing).
- The Mac's disk has ~8.5 GiB free: VK1's files there are `~/webpc-gpu-bench/vulkan-web/target/vk1` (~15 MB).
