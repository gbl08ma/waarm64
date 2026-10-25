# M8 VK1 handover

Notes between VK1's sessions (the brief: `M8-VK1-KICKOFF.md`). Newest state first.

## State (2026-10-25)

- **Step 1, route (b)'s premise: passed** (bench/vulkan/REPORT.md "VK1 step 1", `bench/vulkan/results/vk1/step1/`):
  `spirv_to_nir` + NIR's passes + KosmicKrisp's `nir_to_msl` in wasm, 0.42 MiB brotli, 0.27 ms a stage at the median in
  Chromium on the M4, 108/108 stages, NIR identical to native. Toolchain: **wasi-sdk 34** (beat Emscripten 6.0.13 cold
  by 11–17%, equal warm). `bench/vulkan/nir/build.sh` rebuilds it all from `target/venus-oracle/mesa`.
- Next: THIRD_PARTY.md's audit of the Vulkan work (its own loop), then the device.

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
- The Mac's disk has ~8.5 GiB free: VK1's files there are `~/webpc-gpu-bench/vulkan-web/target/vk1` (~15 MB).
