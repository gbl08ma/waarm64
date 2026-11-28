# VK4 handover

## T50. The hosts' own failures (in progress; #119 closed, split into #323–#326)

**State (2026-11-28; 96946fc1 and 9350e777 passed ci.sh and ci-deqp-vk.sh).** Fixed and in `tests/deqp/vk.txt`: the M4's 16 `shader_draw_parameters.draw_index` cases
(Apple's Metal compiler misreads a thread array of 33–240 u32s at word offsets not a multiple of four: scratch is
`array<vec4<u32>>`; upstream report #321) and its `depth_stencil_resolve.*_testing_stencil_samplemask` (Metal loses the
pipeline's sample mask for stencil where the stage writes depth, and for both aspects without a stage: the stage
discards the samples itself, an empty stage where there's none; `gl_SampleMaskIn` ANDed with the mask). Both in
bench/vulkan/REPORT.md "VK4 T50"; `bench/vulkan/metal-scratch.ts` and `metal-mask.ts` reproduce them in plain WebGPU.

**Left** (each still failing on the M4, `bench/vulkan/results/vk4/t50/fix-m4.json`): the storage-image
`image_robustness` cases of cube, cube-array and 3D views (#323), `early_fragment.discard_no_early_fragment_tests_depth`
(#324), the 3 `texture.mipmap` cases (#325), the 11 `e5b9g9r9` copies (#326); then
SwiftShader's compressed samples in compute and its base-level fetch, NVIDIA's `buffer_1048577` (the kickoff's T50).

**Next.** One case at a time on the M4 (`SCRIPT=deqp-run.ts VIRGL_GPU=virgl,vulkan CASES=<file> QPA=1
bench/gpu/sway-mac.sh vk target/deqp/guest-vk.qcow2 <name>`, ~75 s a run; QPA's images decode from `<name>/deqp.qpa`),
then a plain-WebGPU reduction where the driver's calls look right (as `metal-scratch.ts` was made).
