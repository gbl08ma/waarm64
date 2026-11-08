# Review: VK4 T41–T43 (1a2fab54..e4fa81e5)

A static, out-of-context review of the device-address regions and placement, capture and replay, a descriptor sharing
the pointers' binding, the fragment-stage wrapper (depth bias, alpha to coverage, alpha to one), layered passes drawn a
layer at a time (gl_Layer), cube gathers and corners from fetches, depth views' linear filter from fetches, flat
varyings as words, and mixed signed and unsigned atomic min and max. Line numbers are at e4fa81e5. Ranked from most to
least serious.

## 1. High: the fragment wrapper keeps `@builtin` parameters on a function that isn't an entry point (invalid WGSL)

`vk/driver/wg_shader.c:2627` (`post_text`), same pattern at `:2517` (`dst_text`).

`post_text` renames `@fragment fn main(<params>)` to `fn wg_fp(<params>)` and leaves `<params>` as they are. The
printer's fragment `main` (`vk/compiler/wgsl_print.c:3625-3639`) takes `@builtin(front_facing) ff: bool`,
`@builtin(sample_index) sid: u32`, `@builtin(sample_mask) smask: u32`, and the subgroup built-ins as plain parameters.
WGSL forbids `@builtin` and `@location` on the parameters of a function that isn't an entry point. Checked with naga:
`fn wg_fp(@builtin(front_facing) ff: bool) -> Out` gives "Functions that are not entry points cannot have `@location`
or `@builtin` attributes on their arguments". Tint applies the same rule. Only an `i: In` struct parameter is legal
there (naga validates the wrapper in that form).

What triggers it:
- **Any fragment stage that reads gl_FrontFacing, gl_SampleID (and any sample-rate shading, which adds `sid`),
  gl_SampleMaskIn, or subgroup IDs**, in a pipeline whose key has posts. `key_posts` is true for:
  - Every D24 depth-biased draw with the depth test on: `native` in `wg_cmd.c:1949` is only D16_UNORM or D32, so D24
    always sets `bias_frag`. Polygon offset on D24S8 is common (decals, shadow maps).
  - Any FLOAT or FORCE_UNORM representation, a fractional constant, or `depthBiasExact`.
  - alpha-to-one with a float output.
  - alpha to coverage at more than one sample without colour target 0, or with a stage that writes `sample_mask`.
- **Any `dst` pipeline that also has posts**, whatever the shader. `dst_text` builds a new `main` with
  `@builtin(position) wg_pos` (unless the stage had `i: In` with `pos`) and maybe `@builtin(sample_index) wg_sid`, and
  `post_text` then wraps that `main`. For example: a depth bounds test (also the fragment-less "bounds" stage at
  `wg_shader.c:2880-2884`) together with a D24 depth bias, or a logic op or advanced blend together with alpha-to-one.

Result: `gpu_shader` fails and the render pipeline is refused, so the draw is lost. `dst_text` alone had the same latent
problem for front_facing, sample_mask-in and subgroups: `fn wg_fs(%s)` carries the same parameters.

Test: a wgsl/driver unit test that runs the `post_text` output through a validator for these cases: a fragment stage
reading `gl_FrontFacing` with a D24 depth bias, and a depth-bounds pipeline with a D24 bias. A dEQP case:
`dEQP-VK.draw.*depth_bias*` with a `gl_FrontFacing` shader, or any `sample_shading` case with polygon offset on D24.
Fix: give `wg_fp`/`wg_fs` the parameters' names and types only (strip the attributes); the new `main` keeps the
attributes.

## 2. Medium: a layered pass's layers past the first read layer 0 for dst copies, feedback copies and input attachments

`vk/driver/wg_cmd.c:4803` (`dst_copies`), `:4762` (`feedback_copies`), `:3717` and `:3725-3733` (`feedback_att`), also
`:4463` and `:4583` (input attachments are per view only when `!r->layered`).

All of these assume what was true before T43: a layered pass draws only in its first layer. The layer is
`base_array_layer + (r->layered ? 0 : r->view)`. Since 25a0f468 (`r->layer_draws`, `wg_cmd.c:5328-5332`), draws whose
vertex stage writes gl_Layer replay in every layer's WebGPU pass. In layer N > 0, the WebGPU pass attaches layer N, but:
- `dst_copies` copies layer 0 into the twin. So the depth bounds test, emulated logic ops and advanced blends in layer N
  read layer 0's depth or colour.
- An input attachment, or a feedback-loop sampled attachment, resolves to layer 0's copy or view.

Scenario: a 2-layer pass with a logic op (or a depth bounds test) whose vertex stage writes gl_Layer = 1 for half the
primitives. Layer 1 then gets layer 0's pixels combined with the new ones.

Test: a driver page test: a 2-layer colour target cleared to different colours per layer, a vertex shader writing
`gl_Layer = 1`, and `logicOp = XOR` (or a depth bounds test). Read back layer 1 and compare.

## 3. Medium: layered draws aren't counted per layer, so the push buffer wraps

`vk/driver/wg_cmd.c:226`, `:2210`, `:2721` (`cmd->draws += … * MAX2(util_bitcount(cmd->pass.view_mask), 1)`), with
`:706` (`pass.view_mask = info->viewMask`, which is 0 for a layered non-multiview pass) and `push_reserve(dev, draws * 256)`
at `:6173`.

A layered pass now replays its gl_Layer draws once per layer. Each layer's OP_PASS sets `RD_ALL`, so `apply`
takes a new `push_place` for each one (`:5207-5210`). But the pass counts its draws once, because `view_mask` is 0 for
a layered pass (the layer mask exists only in OP_VIEWS). With more than ~4096/layers draws in a submit (default 1 MiB
buffer), `push_place` hits "overflow" and wraps to 0. The places of earlier draws are rewritten before the GPU reads
them, so those draws get later draws' push constants or draw parameters.

Scenario: cube shadow maps drawn through gl_Layer, 6 layers × ~700 draws with per-draw push constants in one submit.

Test: a unit test (or page test) that records N layered draws with distinct push constants in a 6-layer pass and checks
`dev->push_size` ≥ 6·N·256 after `push_reserve`, or checks the stderr "overflow" line.

Related, minor: `record_draw` and `wg_pipeline_premake` premake the per-layer pipelines only when `cmd->pass.view_mask`
is set (`:2123`, `:2368`), so a layered pass's layer pipelines are never premade. Each one is compiled the first time
it's needed, while the submit waits.

## 4. Medium-low: draws through indices of their own (OP_PROVOKE) and occlusion queries are dropped in layers past the first

`vk/driver/wg_cmd.c:5328-5332`.

The skip list keeps OP_DRAW, OP_DRAW_INDEXED and OP_DRAW_INDIRECT for `layer_draws`, but still drops OP_PROVOKE and
OP_QUERY. OP_PROVOKE carries every triangle fan, every strip with last-vertex provoking, and every restart that needs
its own indices (`provoke`, `:2388-2412`). So a gl_Layer-writing fan or strip draws only layer 0, with no warning. (The
indirect case at least warns, at `:5335-5345`.)

Occlusion queries miss the samples of every layer past the first: `r->qpool` is NULL when `!draws` (`:5373-5375`), and
OP_QUERY is skipped. Vulkan counts every layer.

Test: a page test drawing a gl_Layer = 1 triangle fan in a 2-layer pass (layer 1 must be covered), and an occlusion
query around a draw that lands only in layer 1 (it must be non-zero).

## 5. Medium-low: an address share reads and writes the whole region with no bound, breaking robustBufferAccess

`vk/driver/wg_shader.c:406-432` (`shared_text`, WG_SHARE_ADDRESS), `vk/driver/wg_cmd.c:1693-1730` (`address_shares`),
`:4345-4355` (`param_table`).

A storage buffer descriptor beside the pointers' binding becomes `rA[table.w + (i)]` on the region's whole GPUBuffer.
`arrayLength` is replaced by the descriptor's length (`.z`), but nothing bounds `i`. The printer emits no bounds checks
of its own (it relied on WebGPU clamping each binding to its range). The device advertises `robustBufferAccess`
(`wg_caps.c:199`). So an out-of-range index now reads other allocations' bytes and **writes into other memories** in
the region, which Vulkan forbids ("must not modify any other memory"). Programs on VMA give every memory the
device-address flag (GD G8), so every storage descriptor in a stage that also reads pointers qualifies.

Scenario: `dEQP-VK.robustness.buffer_access.*`-style out-of-range stores, in a shader that also dereferences a
`buffer_reference`, on memory allocated with DEVICE_ADDRESS. A neighbouring buffer changes.

Test: a compute test with two adjacent buffers in device-address memory. Shader A writes `ssbo[len + 4]` and also reads
through a pointer. Check that buffer B is unchanged. Fix: clamp or guard the index against `.z` in the share's
rewrite (as WebGPU's robustness would).

## 6. Low (adapter-dependent): the address regions take up to four storage bindings per stage that the limits don't reserve

`vk/driver/wg_device.c:761-766` (`wg_address_regions`), `vk/compiler/wgsl_nir.c:120-147` (`global_regions` declares
every region), `vk/driver/wg_caps.c:353-363` (`maxPerStageDescriptorStorageBuffers = storage - folded`).

On an adapter whose storage binding is WebGPU's least (128 MiB), four regions are bound in every pointer-reading
stage. `maxPerStageDescriptorStorageBuffers` doesn't subtract them (it didn't subtract the single binding before, but
that was one over at most, and is now up to four over). A program that uses the advertised storage buffers and also
dereferences a pointer goes past `maxStorageBuffersPerShaderStage`, and the pipeline is refused. The M4, NVIDIA and
SwiftShader have one region, so the test machines don't see this.

Test: a unit test with `wg_limits.max_storage_buffer_binding_size = 128 MiB`: a stage that has the advertised number
of SSBOs and a pointer access should fit WebGPU's per-stage storage limit.

## 7. Low: capture and replay places normal memories in the same low-first heap as captured addresses

`vk/driver/wg_device.c:807-835` (`address_place`), `:937-946`.

Memories with CAPTURE_REPLAY are placed at allocation. All others are placed at their first buffer bind, low-first
from the same heap. In a replay, the non-captured memories' placements (lazy, at bind, in the replayer's order) can
take the addresses that a later replayed `opaqueCaptureAddress` needs. That allocation then fails with
`VK_ERROR_INVALID_OPAQUE_CAPTURE_ADDRESS`. Drivers usually keep replayable allocations in a separate range (for example
top-down) for this reason.

Test: device A allocates capture memories M1 and M2 and records their addresses. Device B allocates and binds an
ordinary address memory first, then replays M1 and M2 at their addresses. That should succeed.

## 8. Low: alpha-to-one with a remapped output uses WebGPU's alpha to coverage, which sees alpha 1

`vk/driver/wg_cmd.c:2063-2067`.

`a2c_mask` (the stage's own coverage, taken before alpha-to-one) is only considered when `!k.mapped`. With
`vkCmdSetRenderingAttachmentLocationsKHR` remapping outputs (`k.mapped`), plus alpha to coverage and alpha-to-one, the
pipeline uses WebGPU's `alphaToCoverageEnabled`. But `post_text` has already set the outputs' alpha to 1, so every
sample is covered.

Test: an MSAA draw with alpha 0.25, a2c and alpha-to-one, and a non-identity attachment location map. Expect a
quarter coverage.

## 9. Low: a failed wrapper silently drops the bias or coverage instead of refusing

`vk/driver/wg_shader.c:2811-2814`. `fragment_dst` returns 0 when `post_text` fails (no `main` line, or no `Out` struct).
The pipeline then falls back to the stage's own module. With `bias_frag` the native `depthBias` was already dropped
(`:2795`), so the draw has no bias at all, or no alpha-to-one or coverage. It isn't refused or reported. Finding 1 makes
this reachable: today the module is created and fails at compile instead, but any parse miss in `fs_main` (for example
parameters longer than 1024 bytes) takes this path.

## Checked and found fine

- **Address heap**: each region's tail `[most, 4 GiB)` is reserved, so no memory straddles regions. The last region's
  reservation ends exactly at the heap's end. `address_free` rebuilds the full address. `GetBufferDeviceAddress` and
  `memory_address` agree (`region << 32 | gpu_at + offset`).
- **Lazy placement**: `BindBufferMemory2` now reads `gpu_at` after `wg_memory_buffer`. The linear images' memory gets
  its buffer before the upload (`wg_cmd.c:6165`). `upload` skips memories with no GPUBuffer and keeps them dirty.
  `wg_memory_shared_buffer` refuses unplaced address memories.
- **Region selection in NIR**: `src[store]` is the address for loads, stores and atomics. The `if` tree's phis are
  built only for value-returning intrinsics. The last region takes every higher word.
- **Bind groups and scopes** use the per-region buffer and size. `conflicts` recognises any region. The pointers'
  readback is per region. The shared descriptor is removed from the variant, so `bind_uses` makes no shadow for it.
- **Mixed atomics**: the array becomes `atomic<i32>` once any signed op is seen, and `umin`/`umax` become CAS loops
  with bitcasts. This holds for shared memory too (`shm_signed`). Address shares require equal atomic signedness.
- **Flat varyings as u32**: the vertex stage takes the fragment stage's `vary` (`declare_io`). Stores and loads go
  through `as_base`/`to_storage` bitcasts. The vertex-only fallback widens to u32 when any store is an integer.
- **Cube gather from fetches**: OpImageGather's component order is (i0,j1),(i1,j1),(i1,j0),(i0,j0), which the
  `texels[2],[3],[1],[0]` order gives. The layer is clamped. The corner test uses the level's extent, which is
  per-level in `fetched_sample`.
- **Depth linear from fetches**: only for sampling ops (`samples()` gate). Cubes are always bound as faces
  (`faces |= fetched && cube`). Comparisons and reductions are excluded.
- **gl_Layer culling**: Vulkan requires the same Layer for all vertices of a primitive, so moving every vertex of
  another layer past x = w culls the whole primitive. `OP_PIPELINE` is always re-emitted inside the pass after `forget`,
  so each layer's replay picks its layer's pipeline.
- **post_text ordering**: the slope is taken in uniform control flow before the stage. Coverage is taken before
  alpha-to-one. The coverage mask is ANDed with the stage's own `sample_mask`. The depth-bias constant is clamped into
  an int32 for the native path.
