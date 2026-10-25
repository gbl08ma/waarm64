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
- Next: **L4, the write-watch** (design below), then L5 the device, L6 `vkr` + a null driver in wasm.

## Designs decided, not built yet

- **The write-watch (L4):** in `Mmu::miss`, a write fill of a window page marks its bit in a shared bitmap first and
  records (slot, tag, PA) in the vCPU's TLB (≤ 64; full: drop them all). The renderer bumps a generation word, waits
  for every vCPU whose running word is set to ack it, then swaps the bitmap words out. A vCPU checks the generation in
  `drain` (every chunk boundary) and, when it changed, drops its recorded write entries (marking their pages: they may
  have been written through them since) and acks; on leaving `run_cpu`/`run` it drops them the same way before
  clearing its running word, so an idle vCPU is never waited for and adds no stale pages. Draft host side and test
  program parked in `target/vk1/tmp/` (`window.ts`, `watch.c`: phases {1,2,3}, {5}, {1}, a page-crossing store, atomics).
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
