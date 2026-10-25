# M8 VK2 handover

Notes between VK2's sessions (the brief: `M8-VK2-KICKOFF.md`). Newest state first.
VK1's kickoff and handover are in git history (the commit that added this file); what VK1 built is described where it
lives: vk/README.md, docs/devices.md "Venus" and "The host-visible window", bench/vulkan/REPORT.md's VK1 sections.

## State (2026-10-25)

- **VK1 is done.** On a machine with Vulkan (`?gpu=vulkan` with 3D; Debian's tests' image with Venus is
  `images/debian-vulkan/build.sh`, the desktop guest has it too): the device, the host-visible window (256 MiB after
  RAM in memory 0) and its write-watch, and the renderer (`vk/build.sh` → `target/vk/venus.wasm`: vkr over a null
  driver on Mesa's lite runtime, instantiated on memory 0 in its 256 MiB arena at 0xF000_0000). vkcube, VK0's scene and
  GTK4 (GSK on Vulkan) run on it and draw nothing. `tests/page-venus.test.ts` (ci-debian) and
  `tests/venus-renderer.test.ts` test it.
- **The gate** (REPORT.md "VK1: the gate"): Venus costs the guest 2.2–8.7× less a frame than virgl in the scene, a third
  less in fishbowl, 11% more in GTK4's frames (the guest's submit path: docs/backlog.md). The write-watch costs nothing
  measurable a frame.
- Next: VK2 (its kickoff approved 2026-10-25). The harnesses: `bench/vulkan/guest.ts <virgl|venus|venus-nowatch>` (VK0's
  scene), `bench/vulkan/apps-load.ts` (programs under sway), `bench/gpu/gtk4-load.ts` with `VIRGL_GPU=virgl,vulkan`
  and `RENDERERS=gl,vulkan,…` (alternated rounds), all on the Mac through `bench/gpu/sway-mac.sh` (`SCRIPT=`), which
  copies the renderer there.
- How to watch a Mac run (it has no stall check of its own): its log is
  `~/webpc-gpu-bench/bench/results/local/<name>.log` on the Mac; a monitor that greps it every minute for result
  lines and errors and says when it stops growing caught VK1's one stuck run. Match local processes with a pattern
  that can't match the monitor's own command line (`pgrep -f "sway-mac.s[h] …"`).

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
- Mesa 26's Venus driver sends `vkWaitVirtqueueSeqnoMESA` on the ring; vkr's `cnd_wait` there blocked the GPU worker for
  good (the guest: a kworker in `virtio_gpu_queue_fenced_ctrl_buffer`, the page: "virgl: fence N unanswered"). The ring
  now stalls and resumes (vk/README.md). Debian's Mesa 25.0 never sends it.
- Mesa's Wayland WSI wants a modifier the device can render into: with the profile's linear features (no colour
  attachment) `vkGetPhysicalDeviceSurfaceFormatsKHR` failed; Debian's vkcube asserted (`cube.c:4582`), Arch's (release)
  went on and segfaulted on a NULL swapchain. A segfaulting Venus program's core dump then hung the guest for minutes:
  `ulimit -c 0` in experiments. Headless pixman sway offers no dma-buf at all (the WSI's CPU path, `MESA_VK_WSI_DEBUG=sw`).
- GTK's Vulkan renderer asserts `GDK_VULKAN_FEATURE_YCBCR` without `samplerYcbcrConversion` (REPORT D's "aborts on the
  profile"): the driver advertises it. fishbowl adds icons while it holds 60 frames/s, so its CPU a frame is only
  comparable at its icon count (on its screenshot).
- The ring poller stays on `setTimeout(0)`: a MessageChannel loop (to dodge the 4 ms clamp) starved the GPU worker's
  timers while a ring stayed busy, and the device's fence went unanswered (vkcube on Debian hung); it hadn't lowered
  vkcube's guest CPU either. Its guest time is kernel time spread thin (no spin in the profile).
- A blob outlives its device memory: the scene frees its 68 MB staging memory while the blob is still mapped, and the
  unmap's copy-back (and the driver's rebind) wrote into freed heap, which vkr had reused for its objects
  ("failed to look up object 149 of type 9" for a buffer just created). The memory now hands its storage to its
  resource at its free. Not covered by a test yet (it needs Venus commands encoded by hand); the scene's probe
  (`FISH=1 TOOLKIT= bench/vulkan/guest.ts venus`) is the check.
- `images/arch/desktop.sh` with `EXTRA_PACKAGES=gdb --out …` makes a debugging copy (Arch's aarch64 port has no debug
  packages: backtraces show libraries, not functions).
- The Mac's disk has ~8.5 GiB free: VK1's files there are `~/webpc-gpu-bench/vulkan-web/target/vk1` (~15 MB).
