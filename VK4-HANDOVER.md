# VK4 handover

## T50. The hosts' own failures (in progress; #119)

**State (2026-11-27; commit "VK4 T50: the M4's 16 draw_index…" passed ci.sh and ci-deqp-vk.sh).** The M4's 16 `shader_draw_parameters.draw_index` cases are fixed and in `tests/deqp/vk.txt`:
Apple's Metal compiler misreads a thread array of 33–240 u32s at word offsets not a multiple of four, and the
translator's scratch is `array<vec4<u32>>` now (bench/vulkan/REPORT.md "VK4 T50"). Not yet reported upstream
(Chromium's tracker, Dawn on Metal: `bench/vulkan/metal-scratch.ts` is the reproduction): the user's call.

**Left** (#119's other items, each still failing on the M4 with the fix, `bench/vulkan/results/vk4/t50/fix-m4.json`):
the D24S8/D32S8 `depth_stencil_resolve.*_testing_stencil_samplemask` (60 of 120 fail: stencil reads 255 where 1 is
right), the storage-image `image_robustness` cases (cube, cube array, and now a `3d.vert`, taken out of the list),
`early_fragment.discard_no_early_fragment_tests_depth`, the 3 `texture.mipmap` cases, the 11 `e5b9g9r9` copies; then
SwiftShader's compressed samples in compute and its base-level fetch, NVIDIA's `buffer_1048577` (the kickoff's T50).

**Next.** One case at a time on the M4 (`SCRIPT=deqp-run.ts VIRGL_GPU=virgl,vulkan CASES=<file> QPA=1
bench/gpu/sway-mac.sh vk target/deqp/guest-vk.qcow2 <name>`, ~75 s a run; QPA's images decode from `<name>/deqp.qpa`),
then a plain-WebGPU reduction where the driver's calls look right (as `metal-scratch.ts` was made).
