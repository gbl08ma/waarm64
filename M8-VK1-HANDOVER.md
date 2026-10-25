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
- **The renderer (L6)** is built (vk/README.md; docs/devices.md "Venus"): `vk/build.sh` → `target/vk/venus.wasm`
  (3.2 MB, 510 KiB gzipped), vkr over our null driver, on memory 0 at the arena; `?gpu=vulkan` on the page.
  `images/debian-vulkan/build.sh` (on demand, ~10 min) makes the tests' Debian with Mesa 25.0.7's Venus ICD, vulkan-tools
  and sway; `tests/page-venus.test.ts` (ci-debian) runs vkcube there: ~50 frames/s on 2 vCPUs, and `vulkaninfo` names the
  device `Virtio-GPU Venus (webpc null renderer (VK1))`. `bench/vulkan/venus-run.ts` runs any guest commands on it.
- Next: **L7**, the desktop guest (Arch, `vulkan-virtio`) with Venus, and whether Mesa keeps virgl for GL beside it;
  then **the gate** on the Mac (vkcube, the S scene, GTK4: the guest's CPU on Venus against virgl; B's encoding
  estimate; the watch's cost a frame), then the docs and plan §6/§7.

## Open: one guest oops, not reproduced

- 2026-10-25, the first ci.sh with `tests/page-venus.test.ts` (it ran inside `npm test` then, beside every other file;
  now it's ci-debian's only): Debian's kernel oopsed as vkcube started, `kthreadd` returning through a zeroed frame (pc,
  lr and x29 0, an instruction abort at 0). Not reproduced since: three runs alone, two under six CPU burners
  (~54 frames/s each). Ruled out by reading: the arena can't overlap the core's heap or RAM (the reserve stops below
  0xF000_0000 and a larger one throws), and the device's held replies are written once, as virgl's are. If it recurs,
  keep the run's directory (`/tmp/webpc-venus-*`: serial log, results.json). The renderer's stale pointers (a blob's
  storage after its unref, vkr's ring after the guest unmapped it) write the arena or the window, not RAM, so they
  can't zero a kernel stack. Left to suspect: something else writing guest RAM late, the write-watch's TLB drops
  under contention, or an SMP race under load that isn't Venus's at all.

## Designs decided, not built yet

- (L6's plan was built as planned; what changed is in vk/README.md: vkr uses virglrenderer's own util copy, renamed.)

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
- Venus's guest driver (Mesa 25.0.7) offers `VK_KHR_swapchain` only if the renderer has dma-buf external memory with
  `EXT_image_drm_format_modifier`, `EXT_queue_family_foreign` and a sync-file semaphore it can import (Mesa 26.2 no
  longer asks): vkcube said "failed to find the VK_KHR_swapchain extension" until the null driver advertised them.
- vk/'s two utils: vkr against Mesa 26.2.4's util fails to compile (API drift); it builds against virglrenderer's own
  copy with its symbols renamed (gen.ts). The module's `sbrk` must start at `__heap_end`: from `__heap_base` it
  overlapped dlmalloc's first region ("function signature mismatch" traps far away).
- The Mac's disk has ~8.5 GiB free: VK1's files there are `~/webpc-gpu-bench/vulkan-web/target/vk1` (~15 MB).
