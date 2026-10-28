# vk/: Venus's renderer in wasm

The host side of Vulkan through Venus ([docs/plans/graphics.md](../docs/plans/graphics.md) route (b);
[docs/devices.md](../docs/devices.md) "Venus"): virglrenderer's Venus decoder (`vkr`) over a Vulkan driver of ours
on Mesa's common Vulkan runtime, with Mesa's `spirv_to_nir`, NIR and our NIR → WGSL backend, built as one wasm module,
`target/vk/venus.wasm` (11.9 MiB, 1.18 MiB gzipped, 0.69 MiB with brotli: most of the raw size is NIR's tables), which the GPU worker
instantiates on the VM's memory 0 (web/venus-host.ts).

```sh
vk/build.sh     # -> target/vk/venus.wasm (the first run clones and builds natively, a few minutes; later ones are quick)
vk/build.sh native   # also target/vk/wgsl: the translator natively with ASan (`target/vk/wgsl <0|4|5> stage.spv`)
node --test tests/venus-renderer.test.ts   # the module in Node: its capset, a blob's map and unmap
node --test tests/wgsl.test.ts             # the translator: SPIR-V stages to WGSL in Node, compiled by Chromium's WebGPU
node --test tests/venus-driver.test.ts     # the driver: a Vulkan program of ours (driver/wg_test.c) drawn on Chromium's WebGPU
node bench/vulkan/costs.ts                 # a submit's and a pipeline's costs (the same program; bench/vulkan/mac-costs.sh on the Mac)
node --test tests/venus-share.test.ts      # presentation: a WebGPU texture into the virgl renderer's (Chromium)
                                           # (imports, the reverse: tests/venus-driver.test.ts's second test)
node --test tests/page-venus.test.ts       # vkcube on the page, and the captures' frames (images/debian-vulkan/build.sh, images/vkframes/build.sh)
scripts/ci-deqp-vk.sh                      # dEQP-VK's pass list on the page (images/deqp/build.sh vk)
node bench/vulkan/dawn-frames.ts guest     # WebGPU samples in the desktop guest's Chromium (Dawn; not yet on Venus: docs/backlog.md)
```

## The build

`vk/build.sh` fetches wasi-sdk 34 (sha256-pinned), clones Mesa `mesa-26.2.4` and virglrenderer `e0a1caf3b147` (the
Venus oracle's) into `target/vk/`, applies `vk/patches/`, and builds both natively with meson: that gives the compile
commands and the generated sources (vk.xml's tables, venus-protocol's decoder), which are the same for any target.
`vk/gen.ts` then writes `target/vk/wasm.ninja`, which compiles the same sources for `wasm32-wasip1-threads` (flags
that only make sense natively dropped, `vk/wasi/` ahead on the include path) and links them with ours.

- **Two utils.** vkr is compiled against virglrenderer's own copy of Mesa's util (`src/mesa/`), not Mesa's, whose API
  has moved since; its symbols are renamed (`vkr_util_*`, a generated header of `#define`s from the native objects'
  `nm`) so both link into one module. So `glue.c` declares the driver's two symbols itself instead of including the
  driver's headers.
- **The link:** `--import-memory --shared-memory --max-memory=4GiB`, `--global-base=0xF0000000`, `--no-stack-first`
  and a 4 MiB stack: the module's data, stack and heap live in the arena at memory 0's top (256 MiB at 0xF000_0000, web/devices.ts
  `VENUS_ARENA`), which web/vm.ts keeps free on a Venus machine. Its `sbrk` (`vk/wasi/arena.c`) starts at
  `__heap_end`, past dlmalloc's initial region, and grows up to 4 GiB without `memory.grow`. wasm-ld puts the stack
  first by default (memory 0's bottom 4 MiB, whatever `--global-base` says): VK1's and L1's modules wrote memory 0
  there with every call, and the guest's kernel oopsed (zeroed AppArmor objects, a zeroed stack frame) once the
  compiler's deep calls ran in vkcube's start. Pointers past 2 GiB reach JS as negative i32s: the imports take
  `>>> 0` of them.
- **No threads.** vkr's ring, ring-monitor and queue-sync threads become polls under `__wasi__`
  (`vk/patches/vkr-wasm.patch`): `vkr_renderer_poll` runs every ring and retires fences, and a seqno wait polls its
  ring. A ring command that waits for a virtqueue seqno not submitted yet (`vkWaitVirtqueueSeqnoMESA`, which Mesa
  26's driver sends) can't block the only thread, since that seqno comes in a later submit: the ring stalls after it,
  keeps the rest of its batch, and its poll resumes once the seqno arrives. The module imports `wasi.thread-spawn`,
  which the host answers with -1.

## The shader path

`vk/compiler/` (wgsl.h has the model): SPIR-V → NIR (`spirv_to_nir`, buffers as index and offset, no physical
pointers) → `wgsl_preprocess` (KosmicKrisp's pass list: inlining, splitting, outputs through temporaries, input
attachments as 2D textures, scalarized ALU) → `wgsl_lower` against a layout (1D textures and images as 2D ones of one
row; arrays of textures, buffers and storage images indexed dynamically as a binary tree of ifs over their elements, an access copied into each leaf, an index past the array reading its last element (buffers' and images' since VK3 L7.1); descriptors to slots: slot s
of a set is WGSL `@binding(2(base + s))` of its group, a combined image-sampler's sampler `2(base + s) + 1`, where set
n is group n but sets 3 and up share group 3 one after another, WebGPU having 4 bind groups; I/O to locations;
explicit memory; NIR's optimization loop) → `wgsl_link` for a vertex and fragment pair (`nir_opt_varyings`) → `wgsl_print`, out of SSA. The
printed WGSL keeps every value in a function-scope `var` of u32 or bool and bitcasts at each operation, so it needs no
type inference and no const-expression can overflow or make a NaN (shader-creation errors in WGSL); textures and
samplers come from the tex instruction's indices; push constants are immediates (a struct of vec4s, since immediates
can't be arrays, copied into an array the shader indexes), or, past the device's immediates (64 bytes in Chromium;
Vulkan's minimum is 128), a uniform buffer of the driver's at `@group(3) @binding(998)`, bound at a dynamic offset a
draw; a compute shader's `if` around a barrier, or breaking out of a loop that holds one, takes its condition through
`workgroupUniformLoad` (WGSL's uniformity analysis can't see that Vulkan's barriers are in uniform control flow, every
value being a `var`; a barrier after it keeps the next write from racing the read, so one word serves every condition:
shared memory's spare word where it has one (WebGPU counts each workgroup var rounded up to 16 bytes), else a var of
its own, `wg_uc`, where the workgroup's storage has room, else shared memory's first word, saved and restored between
barriers, through atomics where shared memory is of atomics (VK3 L6c; WGSL's `workgroupUniformLoad` takes one); the device advertises WebGPU's workgroup storage
whole, VK3 L5b); a vertex shader's outputs are typed and interpolated as its
fragment shader reads them, its y is negated by the override `wg_flip_y` (-1, or 1 for a flipped viewport) and its z
mirrored (`w - z`) by `wg_flip_z` for an inverted depth range (WebGPU wants `minDepth <= maxDepth`: the range is set the
right way round);
`packHalf2x16` and `unpackHalf2x16` stay whole for WGSL's own (NIR's lowerings of them go through 16-bit values), and a
compare-exchange is a loop over WGSL's weak one until it exchanges or sees another value (SPIR-V's is strong). Location
0's second source (`index = 1`) is WGSL's `@blend_src(1)` (`enable dual_source_blending`, where the device has it); a
storage buffer is `read_write` only where the stage writes it (or declares it of atomics), else `read` (a vertex stage
can then read what the fragment stage only reads, and a render pass's draws, whose scope is the whole pass, agree with
its vertex stages', which WebGPU has read-only). The driver binds every buffer of a `VkDeviceMemory` from one
GPUBuffer, and WebGPU's usage scope (a dispatch's) refuses writable storage beside any other usage of it, so a dispatch
whose read-only storage buffer shares its memory with a storage buffer it writes takes a variant of its program
(`program_for` in wg_cmd.c): that binding `storage` in the layout and `read_write` in a module of the variant's own
(the program keeps its WGSL for that); read-only elsewhere, it shares a memory with uniform buffers and indirect
arguments (VK3 L6c: L5b made every compute storage buffer `read_write`, and vkQuake's first frame, whose dispatch reads
a uniform and a read-only storage buffer of one memory, lost its submit); shared memory's atomics are `atomic<i32>` when they compare signed (imin, imax), and an
array (shared memory is one, every SSBO another) that needs both signed and unsigned min or max is refused; a texture
and a sampler array indexed apart get an `if` tree each (every texture with every sampler); a terminate
(`OpTerminateInvocation`) is `discard` and a return, a demote `discard` (WGSL's demotes) and a private `wg_helper` that
`helperInvocationEXT()` and `gl_HelperInvocation` read (true only after a demote: WGSL can't see the rasterizer's
helpers); a cube or cube array storage image is its faces as a 2D array (the driver binds such views through a
`2d-array` view of their own), its size counted in cubes; an explicit LOD on a depth texture without a comparison picks
the nearest level.

**Texel buffers** (VK3 L6b): a texel buffer at slot s is its view's words, a storage buffer of `u32` at the slot's
binding (read-only but written storage texel buffers, and as above in a dispatch that writes its memory elsewhere),
and its view's parameters, a uniform buffer of two vec4s at the next binding (made with the `VkBufferView`,
`wg_texel_buffer_layout` in `wg_format.c`: the format's type, texel bytes and swizzle, each channel's width and first
bit, the first texel's byte in the binding and the texel count). The format is the view's, so `texelFetch`,
`imageLoad`, `imageStore` and the size queries print as calls of functions per binding (`wg_tb_load_g_b`,
`wg_tb_store_g_b`, `wg_tb_size_g_b`) that decode and encode it from the parameters: unorm, snorm, uint, sint,
uscaled, sscaled, 16- and 32-bit floats and the unsigned 11- and 10-bit ones; a texel past the count reads 0 and isn't
written. Uniform texel buffers take every plain RGB format whose channels don't straddle a word (3-byte and 6-byte
texels too), storage ones formats of whole words (a texel's words are written whole, so invocations never share one);
no atomics (image atomics are refused).

**Subgroups** (VK3 L5): with WebGPU's `subgroups` and an adapter whose subgroups have one size (`wg_subgroup_size`:
SwiftShader's 4, Apple's and NVIDIA's 32; WGSL can't choose one, so an adapter whose sizes vary keeps subgroups of one
invocation), `wgsl_lower` lowers for that size (`nir_lower_subgroups`, ballots of 4 × 32 bits) and the printer uses
WGSL's built-ins (`enable subgroups`, `diagnostic(off, subgroup_uniformity)`: every value being a var, the uniformity
the program keeps can't be seen): ballots, votes, `subgroupBroadcastFirst`, a read of one invocation as
`subgroupShuffle` (WGSL's `subgroupBroadcast` wants a constant lane), the shuffles, quad broadcasts by a constant and
swaps, elect, and the reductions and add or mul scans WGSL has; NIR lowers the rest (masks, ballot queries, equality
votes, clustered reductions, the other scans, quad votes). A bool goes through them as 0 or 1. WGSL has no subgroup
ids: `gl_SubgroupID` is `local_invocation_index / subgroup_size` and `gl_NumSubgroups` from the workgroup's size
(subgroups taken as runs of the index, as on SwiftShader and Metal). **Sample-rate shading** (VK3 L7.1, `sampleRateShading`): a fragment stage runs per sample where its pipeline asks for
more than one invocation a pixel (`sampleShadingEnable`, its minimum times the samples over 1: WebGPU has no minimum,
so per sample), or where it reads `gl_SampleID` or `gl_SamplePosition` or has an input per sample (Vulkan's minimum of
1). Then every input not at the centroid is `@interpolate(…, sample)` (the vertex stage's outputs follow), the entry
point reads `@builtin(sample_index)` (WGSL runs a fragment shader per sample where it reads it, inputs or not), and
`gl_FragCoord.xy` is the pixel's corner plus the sample's position (WGSL's `position` is the pixel's centre; Vulkan's
`FragCoord` is at the sample), as is `gl_SamplePosition`: Vulkan's standard locations by the pipeline's sample count
(`override wg_samples`, the render pipeline's constant). The pipeline's state reaches the WGSL through `hash_state`
(the shaders' keys), so a stage made for both kinds of pipeline is two. Interpolation at an offset or a sample
(`interpolateAt*`) still fails the stage.

Subgroups are in compute and fragment shaders only
(WGSL's), and a subgroup-scoped barrier does nothing. Without them, the basic operations of subgroups of one invocation.

**16-bit values** (VK3 L5): kept in a u32's low half. 16-bit storage (buffers, uniform buffers, push constants; every
adapter) loads and stores halves of words, a store to a buffer or shared memory as an `atomicAnd` and an `atomicOr` on
its word (the array declared atomic: another invocation may store the other half); conversions to 16-bit floats are
NIR's integer code (`nir_lower_fp16_casts`: WGSL's own may round either way), from them `unpack2x16float`; 16-bit
integer arithmetic is done at 32 bits (`nir_lower_bit_size`). 16-bit float arithmetic (`shaderFloat16`) needs
`shader-f16`: each value is viewed as `bitcast<vec2<f16>>(t).x`. A function-scope array NIR moves to scratch is
addressed by its whole offset (scratch has no base: before L5 the printer read the alignment there, and the last
element's last word of an array past 32 bytes indexed dynamically went past the array). What
WGSL can't express fails the stage with a reason: 16-bit float arithmetic without `shader-f16`, 8- and 64-bit values,
16-bit inputs and outputs, descriptors reached through pointers (variable pointers' selects), integer textures sampled with a sampler, image atomics, interpolation at an offset, `textureQueryLod`, and
storage images with an access WebGPU doesn't give their format: loaded and stored (`read_write`) but r32's (in core)
and, with `texture-formats-tier2`, tier2's; `bgra8unorm` but write-only (VK3 L4c-F: the module used to be invalid and
its submits dropped; the formats stay advertised as storage images, their write-only and read-only uses being right).
A pipeline whose stages access one storage image differently is refused the same way (one layout entry can't match
both modules' access), and so is one whose fragment stage writes a storage buffer its vertex stage reads (WebGPU has no
writable storage in vertex shaders). A pipeline whose stage fails is still made, of shaders that draw and dispatch nothing: Venus's guest driver binds a
pipeline without waiting for its result, and a pipeline that failed would fail the guest's whole context.

`tests/wgsl.test.ts` runs VK0's scene's shaders (glslc) and VK1 step 1's 108 stages (`target/vk1/spirv`, dumped by
`SPIRV_DIR=target/vk1/spirv bench/vulkan/translate/programs.sh`; not committed, they're the programs'): 124 of 127
translate (0.47 ms a stage at the median in Node, 28 ms GTK4's largest) and all 124 compile in Chromium; the three
others are vkQuake's variants for a device with 16-bit floats (dumped through the Mac profile: translated for
SwiftShader, without `shader-f16`, one stops at its 16-bit arithmetic, the others at an image atomic and a texture
offset that isn't a constant; its screen effects' palettization, a texel buffer, translates since VK3 L6b). It checks that Tint accepts the
WGSL, not what it computes: that is the driver's tests' and dEQP-VK's, and L5's runs of translated compute shaders
(`runCompute`: subgroup operations against each subgroup's members, 16-bit storage, scratch arrays).
**Subgroups on Metal** (Chromium 153 on the M4): a ballot that is an `if`'s only subgroup operation is computed with
every invocation (hoisted out of the `if`), which failed 89 of the Mac's 503 sampled subgroup cases; the GPU worker
checks that case at Venus's start (web/venus-gpu.ts `subgroupsRight`) and, where it's wrong, the device has subgroups
of one invocation (bench/vulkan/REPORT.md "VK3 L5").

## The parts

- `glue.c`: the exports the GPU worker calls (`venus_init`, `venus_capset`, contexts, submits and fences, resources
  and their map and unmap, `venus_poll`, the heap), and two imports: `venus_retire` (a fence retired) and
  `venus_submitted` (a queue submit ran: the window's written pages are taken then).
- `vk/patches/vkr-wasm.patch`: the polls; device memory as vkr's own `aligned_alloc` storage, imported into the driver
  as a host pointer (`VkImportMemoryHostPointerInfoEXT`) and exported as a blob of shared memory with no fd; a blob's
  map into the window copies its storage there and rebinds the driver's memory to it (`vkr_wasi_memory_moved` →
  `wg_memory_rebind`), an unmap copies it back (wasm can't remap pages). A memory freed while its blob lives hands the
  blob its storage.
- `vk/driver/` (prefix `wg`): the driver, below.
- `vk/wasi/`: what wasi-libc lacks for this code (uids, signals, `mkstemps`, `syslog.h`, `libsync.h`, `ioccom.h`),
  Mesa's `os_misc` without an OS, and virglrenderer's `config.h` for wasm.

## The driver

`vk/driver/` on Mesa's full runtime, KosmicKrisp's structure (MIT; our code): its hardware is the GPU worker's WebGPU
device, reached through the module's `wg` imports (`wg_gpu.h`, implemented by web/venus-gpu.ts). WebGPU objects are
named by ids the driver assigns; the rarely made ones are described as JSON, a submit's commands are calls with
plain numbers. Without a device (Node) the imports keep nothing and every submit completes at once.

- **What it advertises follows the browser's WebGPU device** (`wg_caps.c`, VK2 L7): the GPU worker asks the adapter
  for every limit and optional feature the driver uses (web/venus-gpu.ts `deviceRequest`), and `venus_init` gets the
  device's (`gpuFeatures`: a bit a feature; `gpuLimits`: 31 limits as `struct wg_limits`, WebGPU's defaults where the
  browser has none). The mapping is VK0 A's (`bench/vulkan/profiles/make.ts` `direct`) for the direct rows of plan §4:
  image sizes, descriptor counts, buffer ranges, vertex input, workgroups and inter-stage components from the limits;
dynamic indexing of every descriptor array and sample-rate shading (VK3 L7.1, Dawn's row of plan §4: Dawn's Vulkan
backend refuses a device without the four `shader*ArrayDynamicIndexing` features, and its core WebGPU wants
`sampleRateShading`; "The shader path");
  depth clamp, dual-source blending, clip distances, first instance in indirect draws, the compressed families and
  `shaderStorageImageExtendedFormats` from the features; `shaderFloat16` from `shader-f16`, real subgroups (size,
  stages and operations: "The shader path") from `subgroups` (VK3 L5), and 16-bit storage everywhere. Less what the
  translator can't do (8-bit and 64-bit types, 16-bit integers and inputs and outputs, interpolation at an offset,
  inline uniform blocks, YCbCr conversions; subgroups of one invocation with the basic
  operations where the adapter has no `subgroups` or its sizes vary), with Vulkan's minimums of push constants (128 bytes) and bound sets (8,
  as `WGSL_MAX_SETS`), dynamically indexed arrays of every kind of descriptor (`if` trees), formats from WebGPU's tables
  (`wg_format.c`: optimal tiling as WebGPU can sample, render, blend and store them, which `wg_format_init` resolves
  from `texture-formats-tier1` (the 16-bit normalized formats, unfilterable as WebGPU has them; snorm and
  `rg11b10ufloat` attachments), `rg11b10ufloat-renderable` and `bgra8unorm-storage`; linear tiling only copies; buffers
  vertex input and texel buffers: "The shader path"), samples 1 and 4 (1 for the 32-bit integer formats and the float ones of two or four
  channels, which WebGPU doesn't multisample), views of a mutable image in its format's sRGB twin only (WebGPU's `viewFormats`: a format list naming
  another format is refused by the image-format query, and such a view warned of); plus the extensions
  Venus's WSI shares through (dma-buf memory; one DRM modifier, LINEAR, with the optimal tiling's features; foreign
  queue transfers; sync-file semaphores). It reports an integrated GPU (libplacebo, GTK4 and wlroots turn CPUs away)
  whose vendor ID is the adapter's maker's (`VENDORS`: Apple's, NVIDIA's, Google's for SwiftShader; 0 for one not
  listed), as Venus on a native host passes its GPU's on, named `webpc WebGPU`. Two memory types (device-local; host-visible, coherent, cached and
  device-local) on a 2 GiB heap, one queue family. `tests/venus-renderer.test.ts` checks it against the Mac's and
  SwiftShader's recorded adapters.
- **libplacebo's advanced path** (VK2 L7, VK3 L4–L4e; web/venus-gpu.ts `HELD_FEATURES`): `float32-blendable` and
  tier1's storage formats (bit 14 of `venus_init`'s flags, `WG_FEATURE_TIER1_STORAGE`, which also says
  `shaderStorageImageExtendedFormats`). Either gives mpv's libplacebo a family of FBO formats (32-bit floats, or
  16-bit floats with tier1's storage), and with them its advanced rendering (scalers, debanding, its frame cache). The
  driver takes both where the adapter has them, by default since VK3 L4e. They were held while mpv's VA-API chroma
  read as zeros on the M4 in about a third of fresh sessions (the window's pages lost between devices, fixed in VK3
  L4c-A: bench/vulkan/REPORT.md "VK3 L4b–L4c"; 0 of 58 sessions since), then while a cold mpv's window froze (Mesa's
  async present, "The guest's Mesa" below; REPORT.md "VK3 L4d", "VK3 L4e"). `?gpu=vkformats=held` holds them again
  (libplacebo then has no FBOs and mpv renders as in VK2 L6: "Failed creating FBO texture", its VA-API frames byte for
  byte its software ones); `?gpu=vkhold=<feature>` holds one (`tier1-storage` is tier1's storage alone).
- **YCbCr conversions aren't advertised** (VK2 L7's choice, by measurement): advertised and not honoured, GTK4's
  Vulkan renderer (`GSK_RENDERER=vulkan`) drew black or near-empty frames for more CPU than its GL one (REPORT.md "VK2
  L7"); without them GTK4 stays on GL, its default here anyway (forced onto Vulkan it aborts on its own assertion).
  The modifiers stay: Venus's WSI needs them.
- **Memory**: a `VkDeviceMemory` is one `GPUBuffer` with every buffer usage (made at its first buffer bind; buffers
  are ranges of it, so they alias); an image is a `GPUTexture` of its own (its memory only says where its bytes would
  be; a compressed one's size rounded up to whole blocks, as WebGPU wants, and its copies with it; a 1D one 2D),
  with views made as Vulkan made them (a depth or stencil aspect's with the image's format and the aspect) and, for
  attachments, as one 2D level and layer, or a 3D image's level and the slice its 2D view starts at (`depthSlice`). Host-visible memory's bytes
  are in memory 0 (vkr's storage, or the window while its blob is mapped); at each submit the driver uploads the
  window's written pages of the memories mapped there, and the whole of those that moved or are new, each to its
  4-aligned size (an odd-sized memory's last bytes too). The write-watch is the window's, one for every device (each
  Venus context has its own): each submit's look at it gives the pages to every device (`wg_device.pages`, a bit a
  page), and a device's submit uploads those over its own memories and clears its own bits; so one device's look
  never drops another's pages (VK3 L4c-A). What an in-flight submit writes to host-visible memory on the GPU (a
  copy, a storage binding, a fill) isn't in the CPU's bytes until it completes, so each such range keeps its base (the
  CPU's bytes before its submit's look at the watch): a later upload leaves out the range's words the guest hasn't
  written since (they'd put stale bytes over the GPU's; a word with both goes up), and the range's pages go up again
  once it completes (VK3 L4c-B). A linear image in host-visible memory is loaded from it before each submit and stored
  back after; freeing that memory takes the image off that list (Vulkan lets the image outlive it, only to be
  destroyed). A storage binding is a whole number of words (WebGPU's): a buffer of an odd size bound whole loses its
  last bytes' word.
- **Shaders** (`wg_shader.c`): the runtime's `vk_shader` path. A pipeline's stages are compiled together
  (`wgsl_lower` against its set layouts, `wgsl_link`, the fragment shader printed first), with what they share
  (`wg_program`: bind group layouts from both stages' resources, a pipeline layout with the immediates). Render
  pipelines are made at the first draw needing one, keyed by the state WebGPU bakes in (`wg_pipeline_key`: vertex
  layout, topology, rasterization, depth and stencil, blend, attachment formats, samples, the viewport's flip); an
  attribute past its binding's stride (Vulkan allows it, WebGPU doesn't) reads a vertex buffer slot of its own, the
  same buffer further on (`wg_vertex_slots`). A texture the shader declared filterable float but bound to a view
  WebGPU can't filter (a depth view, `r32float` without `float32-filterable`) draws with a variant of the program
  (`wg_program_variant`, by a mask of such bindings): those bindings unfilterable, the samplers they're sampled with
  non-filtering and given the sampler's nearest twin. A render pipeline is made when a draw needing it is recorded
  (the replay finds it by its key), so that it is likely ready by the submit (below, "Pipelines made asynchronously").
  Shaders are serialized (`wg_serialize`: a stage's WGSL and info, its program's data and link), so pipeline caches
  carry them (a guest program's own, and the store across runs: "The shader cache"). A program is shared by the stages
  of one link (`program_link`: a hash of its data and its stages' WGSL), however each stage came (compiled, or found in a
  cache while its partner was compiled): a draw needs its vertex and fragment shaders on one program. The link hashes
  the resources field by field (a struct's padding is indeterminate). Stages that still come with different programs
  (a cache whose entries disagree) draw with a program of both's bindings (`wg_program_merge`, said once on stderr),
  where a draw used to lose its fragment shader silently (VK3 L4c-D).
- **Descriptors** (`wg_descriptor.c`): a set's slots hold buffers, views, texel buffer views and samplers; bind groups
  are made at a replay, for the program's layout and the set's version (group 3's for its sets' uids and versions
  hashed), and kept on the group's first set (4 at most), keyed by the layout's uid (ids are reused: a stale bind group
  of a freed layout's id once bound group 2's layout at index 3). A layout's uid is one per content (its description
  and its uniform bindings' sizes, `bgl_uid` in `wg_shader.c`; VK3 L6b): WebGPU takes a bind group with any
  group-equivalent layout, so pipelines of equal layouts share a set's groups (VK0's scene made ~14 a frame when each
  pipeline's layouts were their own, ~6 since: bench/vulkan/REPORT.md "VK3 L6b"). Groups a set lets go are released after the submit is encoded. Push
  descriptors are sets of the command buffer's own. Push constants past the immediates go to the device's push buffer
  (a uniform buffer written with `queue.writeBuffer` before each submit, ordered after the work before it), a
  256-byte-aligned place each time they change, its offset the last dynamic offset of group 3. Written once a submit,
  its places can't be reused within one: it is 1 MiB, and a submit whose draws and dispatches could fill it (256 bytes
  each, a command buffer counts them) first replaces it with one large enough, up to 256 MiB (VK3 L4c-F: past 4,096
  changes it used to wrap, and earlier draws read later ones' constants). Bind groups of it are kept by the push
  buffer they name (`push_gen`); the replacement is made at once, so that the submit's first binds, before any draw,
  don't find groups of the old one (which invalidated that submit).
- **Commands** (`wg_cmd.c`): recorded into a list of our own; each draw or dispatch records the state it needs where
  it changed. A submit replays the list into one encoder (passes opened and closed as the commands need; render passes
  from the runtime's dynamic rendering, with legacy passes through its emulation; clears as load ops, or draws for a
  partial render area and `vkCmdClearAttachments`; LOAD and NONE load, DONT_CARE clears but loads for a partial render
  area, whose outside Vulkan keeps; a pass that resumes a suspended one (`VK_RENDERING_RESUMING_BIT`) loads and clears
  nothing, one that suspends stores whatever its store op, since its WebGPU pass ends there (VK3 L4c-D); a depth or
  stencil attachment in a read-only layout is WebGPU's `depthReadOnly`/`stencilReadOnly` (so the pass may sample it; its
  pipelines then write neither); blits, resolves and image clears as the worker's draws, depth and stencil resolves too
  (SAMPLE_ZERO, the modes advertised, at the end of the pass instance, within its render area: a draw writing sample 0
  as `frag_depth`, and for stencil, which no shader writes, a draw zeroing it and eight draws, one a bit, each keeping
  the pixels whose sample 0 has it; VK3 L4f; the attachment is stored whatever its store op, since Vulkan resolves
  before the store op and the draws read it after the pass: L5b);
  `CONSTANT_ALPHA` colour factors as WebGPU's one constant set to the constant's alpha (a draw mixing it with
  `CONSTANT_COLOR` in its colour can't be expressed: warned, the colour kept);
  pipelines as WebGPU takes them: an indexed strip always has its index format, depth bias only for polygons, and a
  pipeline without a fragment shader in a pass with colour gets an empty one, its targets unwritten); stencil state per
  face (WebGPU has one reference and one pair of masks, Vulkan a set a face): a draw whose faces both use one of them
  with different values (a reference compared or replaced, a compare mask compared, a write mask written), both faces
  drawn, is two draws, its front faces with the front's (the back culled) and then its back faces with the back's, so
  the order between its front and back primitives is lost where they overlap (stencil ops, blending, depth ties) and
  its vertex stage runs twice; faces differing only in what they don't use draw once (VK3 L6c); with one face culled
  the other's is used (VK3 L6a); occlusion queries on the GPU (VK3 L6a): a pool is a WebGPU query set and a buffer of each query's last value;
  a render pass whose commands begin a query takes the pool's set (the first pool's: a query of another pool, or one
  begun outside a pass, is reported as passing, warned once), its queries are resolved into the buffer at the pass's
  end (consecutive ones together, through the device's scratch buffer); a `vkCmdClearAttachments` inside a query (the
  worker's draw, which Vulkan doesn't count) ends the WebGPU query and carries it on in one of the set's 64 spare slots,
  whose count the worker adds to the query's on the GPU at the resolve (VK3 L6c; past the spares, passing), and `vkCmdCopyQueryPoolResults` copies each value
  from it on the GPU, with each availability (the queue's order: what the replay has seen ended and not reset since),
  leaving the bytes between results untouched and an unavailable query's value unwritten without `PARTIAL_BIT`; a
  submit reads the values its queries ended back for `vkGetQueryPoolResults`, which reports a query available once that
  submit completed (`VK_NOT_READY` before, `WAIT_BIT` too: the host can't wait for a completion; Venus's guest driver
  reads its feedback buffers, which the copies fill, instead); timestamps are the CPU's at the replay), copies
  what the GPU wrote to host-visible memory into staging buffers, and submits. Buffer copies WebGPU can't make (an
  offset or size not 4-aligned) go through a compute pass of the worker's: the source's words copied to a temporary
  buffer, then each destination word the copy touches written, its other bytes kept; on the GPU in the encoder's
  order, so device-local sources and what earlier commands wrote are copied too (VK3 L4c-F; they used to be copied
  from the CPU's bytes at the destination's unaligned offset, which invalidated the submit). An image clear of a
  format WebGPU can't render to (`rgb9e5ufloat`, the snorm8 formats without tier1, `rg11b10ufloat` without its
  feature) is its clear colour encoded in the worker (`encodeTexel`) and copied in; a 3D image's clear covers every
  slice; a blit from a 3D image samples it as one, at the slice each destination slice maps to (VK3 L4c-F). Buffer ↔ image copies whose rows
  aren't 256 bytes apart go a row of blocks at a time, but for depth and stencil, which WebGPU copies only whole
  (the worker realigns their rows through a temporary buffer); depth WebGPU won't copy (into depth32float's or
  depth24plus's depth, out of depth24plus's, part of a subresource, and image copies of part of one or of depth24plus,
  whose textures have no copy usages) goes through the worker's passes (VK3 L6b, web/venus-gpu.ts `depthByShader`):
  into a texture a draw over the region writes `frag_depth` from the buffer's words, out of one a compute pass loads
  the depth into them (D24 as a word's low 24 bits, Vulkan's X8_D24 layout; an image copy through a temporary buffer);
  stencil WebGPU won't copy (part of a subresource, an offset not 4-aligned) is read out through a whole subresource's
  copy and written by draws over the region, one zeroing it and one a bit (`stencilByDraws`: each discards the texels
  whose byte lacks its bit and replaces that bit); what's left (multisampled textures, depth16unorm's part) or what
  WebGPU can't resolve (integer formats) is skipped with a warning, since one invalid command invalidates the whole submit. Barriers and events wait for nothing (WebGPU orders
  a queue). The worker's imports catch what WebGPU's API throws (a warning, the command dropped): an exception through
  the module would leave its state half updated.
- **Completion**: submits are numbered across devices (a completion finds its submit by number alone; at most 16
  devices at once, a 17th fails to be made). The worker calls `venus_complete(serial)` in submit order once the work is done and its staging
  buffers are mapped; the readbacks are copied into memory 0, fills and updates of host-visible memory (Venus's
  feedback slots) applied there too (outside the readbacks, which have the GPU's last word), each only where the CPU
  still has the range's base: a range read back is wider than what the GPU wrote (a copy's row gaps, a whole storage
  binding at its dynamic offset, 4-byte rounding), and what the guest wrote there since its submit stays; a byte that changes moves a later
  in-flight range's base with it (VK3 L4c-B). The submit's occlusion values land in their pools. Then the submit's syncs signal; vkr's fences retire at the next poll, which the
  completion runs at once. Only the window and the arena are written then (anything else is logged and dropped).
  While a submit is in flight the host's poller sends an empty submit at most every 1 ms (web/venus-gpu.ts `nudge`):
  Chromium looks at a Dawn device on Vulkan whose work is pending only on a slow timer, but at once when commands
  arrive, so a submit's done came ~3 ms after its work on SwiftShader (1 ms nudged; the same on Metal either way,
  whose completions come by callback: bench/vulkan/REPORT.md "VK3 L2"). A submit with nothing to read back still
  completes only when its work is done: completing it early would let the guest queue frames without limit.
  `?gpu=vknudge=<ms>` changes the nudges' period (0: none) and `?gpu=vkgputime` times each submit's first 8 passes on
  the GPU with timestamp queries (the device then asks for `timestamp-query`); both for A/B and diagnosis (VK3 L2b).
  The render stats' `venus` carries a submit's parts too: the worker's encoding, `queue.submit`'s call, its writes,
  passes and draws, and the done of the submits with a pass.
- **Shared images** (Venus's WSI): see "Presentation".
- **Waits before their signal** (VK3 L6a): syncs are advertised as waiting before their signal, so Mesa's runtime
  hands every submit to the driver at once (no submit thread: vkr has one); a submit with a timeline wait that isn't
  met, by the value or by a submit already replayed that will signal it, is held, with every later submit of its
  device, and replayed in order once its waits are met: at the host's signal (`vkSignalSemaphore`) or at the end of a
  completion. Binary waits are met in the queue's order. A submit of signals alone (no command buffers, no waits) goes
  at once, ahead of held ones: vkr retires the guest's ring fences with such submits, and the guest's driver waits for
  them before it reuses its command streams, so holding them held the guest before it could send the host's signal
  (`synchronization*.timeline_semaphore.wait.host_wait_before_signal` hung the guest so); such a submit signals early,
  as every submit did before.
- **Not yet** (docs/backlog.md "The Vulkan driver's gaps", with what dEQP-VK found): timestamps on the GPU, depth blits, border colours and mirror-once, triangle fans, component
  swizzles, sampling 3D images through 2D views, integer textures sampled with a sampler, copies
  between formats, multi-view.

## Pipelines made asynchronously

WebGPU's `createRenderPipeline` returns at once, but Chromium's GPU process then compiles the pipeline on its main
thread (Tint, then the GPU's compiler: Metal's ~75 ms the first time, SwiftShader's ~27 ms), and everything behind it
on that thread waits: Venus's later submits and the page's WebGL (virgl's screen) alike. So the worker
(web/venus-gpu.ts) makes the driver's pipelines with `createRenderPipelineAsync` and `createComputePipelineAsync`
(Dawn compiles them on its workers), keeping a stand-in (`Later`) under the pipeline's id. Venus's ring never waits for
one. A submit that sets a pipeline not yet ready is recorded instead of encoded (each command with its ids resolved and
the memory it reads copied at its call: ids are reused and memory rewritten meanwhile) and held, with everything after
it in the queue's order (later submits, `queue.writeBuffer`s, buffers destroyed, web/venus-import.ts's writes:
`VenusGpu.later`), until its pipelines are; then it goes, in order (`drain`), and completions stay in submit order. A
compositor's submit that samples a Vulkan image waits until no submit is held (web/venus-share.ts `prepare`, through
`VenusGpu.idle`), so a frame isn't copied before the submits that draw it. A pipeline WebGPU refuses is made again
at once for its error (an invalid pipeline, as before); one a command needs before it's ready without a held submit
(made after its submit's encoder began: the driver never does) is made at once (`syncPipelines` counts them; 0 in the
tests). `?gpu=vkpipelines=sync` makes them at once, as before, for A/B; `?gpu=vkpipedelay=<ms>` makes each one ready that much
later than WebGPU says (VK3 L4e: a cold compile on a host whose GPU cache is warm, e.g. the M4's Metal, whose cache
outlives Chrome's profiles). tests/venus-gpu.test.ts checks the order on a
stand-in device; tests/venus-driver.test.ts that the driver's program draws right with them held.

## The shader cache

What makes a pipeline in the module (SPIR-V to NIR, NIR's passes, the WGSL: 0.6 ms a pipeline, 25 ms GTK4's largest
stage) is kept across runs. Mesa's pipeline caches look up what they miss in a disk cache (`pdev->vk.disk_cache`), and
ours (`vk/wasi/disk_cache.c`, in place of util/disk_cache.c, which needs files and threads; `vk_pipeline_cache.c` built
with `ENABLE_SHADER_CACHE`) hands lookups and stores to the worker as `wg` imports (`gpu_cache_get`, `gpu_cache_read`,
`gpu_cache_put`). The runtime stores two kinds of entry: a stage's NIR after `spirv_to_nir` (keyed by its SPIR-V,
specialization and robustness) and a pipeline's shaders (keyed by its stages and layouts). The keys are BLAKE3 of the
cache's identity, which is the driver's build ID (`WG_BUILD_ID`, vk/gen.ts: a hash of vk/'s sources and build script)
and a hash of the device's caps, then the runtime's key. Both also make `pipelineCacheUUID` and `shaderBinaryUUID`, so
a guest program's saved cache from another build or other caps (its WGSL made for those) is refused (its header), not
misread.

The worker's store (web/venus-cache.ts) holds them in memory, loaded from IndexedDB `webpc-shaders` when Vulkan starts.
It is the origin's, shared by every machine (an entry depends on the shader and the device, not the machine), and kept
under a byte budget (32 MiB, least recently used out first), written back a second after a change. Entries carry the
renderer's build ID (`venus_build_id`), and those of another build are dropped at the load. So a program's second run
on a machine (or on another machine of the page) translates nothing its first did. What remains is the browser's own
pipeline compile, which Chromium caches itself (bench/vulkan/REPORT.md "VK3 L3"). `?gpu=vkcache=off` keeps nothing, for
cold runs and A/B. tests/venus-cache.test.ts checks the store; tests/venus-driver.test.ts a second run of the driver's
program on a new renderer (no lookup missed, nothing new stored, the same pixels).

## Checking frames

A program draws right when its frames match lavapipe's. `images/vkframes/build.sh` captures each program of its list
natively with GFXReconstruct on the dev VM's lavapipe, through the Profiles layer with the Venus device's own profile
(`images/vkframes/venus-profile.json`: `vulkaninfo --json` in the tests' guest on SwiftShader, made by
`PROFILE=images/vkframes/venus-profile.json bench/vulkan/venus-run.ts` whenever what the device advertises changes,
then the disk rebuilt), so a program takes the
paths it takes on our device (vkQuake its shaders without 16-bit floats, its five descriptor sets and 128 bytes of push
constants), and replays the chosen frames there offscreen as the references. The programs: vkcube (with
`--use_staging`), vkmark's 13 scenes (a capture each, half a second at `fifo`: ~30 frames) and vkQuake (LibreQuake's
data: frames 200 to 230 of `+map start`, a trimmed capture whose replay first rebuilds the state). Its disk carries the
captures, the references, each program's tolerance and GFXReconstruct's replay built for Debian. In the guest,
`run.sh` replays a capture on the Venus device offscreen (`--swapchain offscreen`: no WSI, the frames read back through
the driver's image-to-buffer copies; `-m remap`, since lavapipe's first memory type is host-visible and ours isn't) and
compares each frame byte by byte (`cmp -l`): how many bytes differ, how many by more than 24, the largest difference,
with the replay's frames a second. `bench/vulkan/venus-run.ts` runs it with `REPLAY=<names>` or `all` (on the Mac's
GPU too: `SCRIPT=../vulkan/venus-run.ts REPLAY=all bench/gpu/sway-mac.sh - target/images/debian-vulkan/disk.qcow2
<name>`), and `tests/page-venus.test.ts` asserts every program's frames within its tolerance: the share of a frame's
bytes that may be off by more than 24 (vkcube 0.2%, vkmark 0.3%, vkQuake 3%).

| Frames' bytes off by more than 24, of a frame (SwiftShader, dev VM, Chromium 153) | | largest difference |
| --- | --- | --- |
| vkcube, frames 5, 15, 30 | 198–252 of 864 K (0.03%) | 198–210 |
| vkmark's scenes, frames 10 and 25 | 0–910 of 922 K (≤ 0.1%; texture and desktop the most, clear none) | ≤ 217 |
| vkQuake, frames 5, 15, 30 | 15.4–15.5 K of 922 K (1.7%) | 217 |
| Apple M4 (Metal, Chrome for Testing 153): vkcube | 3–6 | 56–136 |
| the M4: vkmark's scenes | 0–804 (≤ 0.09%) | ≤ 94 |
| the M4: vkQuake | 15.3–15.5 K (1.7%) | 176 |
| vkcube, its front face inverted (a planted bug, SwiftShader) | 95–111 K (12%) | 242–244 |

(`bench/vulkan/results/vk2/l3/`, `l5/`.) What differs is edges and texture filtering, but for vkQuake: its frames
match lavapipe's to the eye with no bias (the mean signed difference per channel under 0.2), yet 78% of their bytes
differ by a little and 1.7% by more than 24, the same on SwiftShader and Metal, so it is systematic, not the GPU's
rasterization: not identified (its text and grid edges hold the large ones; candidates are its screen effects'
dithering and a conversion's rounding). The replay
checks the driver; vkcube's own frames in the guest also pass through Mesa's WSI, whose CPU path
(`MESA_VK_WSI_DEBUG=sw`) copies each image to a host-visible buffer on the same driver.

## Presentation

A Vulkan program's frames reach the page's screen through the guest's compositor: Mesa's Wayland WSI renders into
images with dma-buf memory (the LINEAR modifier), Venus's guest driver exports each image's memory as a blob, and sway
(on GLES, virgl) imports it into its virgl context and types it (`PIPE_RESOURCE_SET_TYPE`). Both renderers run in the
GPU worker, the driver on WebGPU and virgl on WebGL2, which share nothing directly; web/venus-share.ts copies the
image into the virgl texture made at the import (web/virgl-renderer.ts `ExternalResource`):

- **Which texture:** the driver keeps the shared image bound to each memory (`wg_device_memory.image`, for images with
  dma-buf memory or a modifier), vkr the memory a resource was exported from, so `venus_resource_texture(ctx, res)`
  names the WebGPU texture. Shared images are made with `COPY_SRC` and `TEXTURE_BINDING` and their sRGB twin as a view
  format. web/venus-gpu.ts records the submit that last wrote each texture (attachments, copies and blits into it,
  and storage textures a pass sets a bind group writable to: VK3 L4c-F): an image is copied only when it was written
  since its last copy.
- **Not NVIDIA's vendor ID:** the device reports the adapter's maker as its vendor (web/venus-gpu.ts `VENDORS`), but
  never NVIDIA's 0x10de: Venus's guest driver (Mesa 26's `vn_wsi_init`) then takes the device for Venus on NVIDIA's own
  driver, which can't render to linear images, and its WSI renders into an optimal image and copies each frame into a
  buffer it exports instead (the prime blit). That buffer has no texture to share, so every Vulkan window was black
  on the user's NVIDIA desktop (bench/vulkan/REPORT.md "VK3 L1"; reproduced on SwiftShader with `?gpu=vkvendor=nvidia`
  and the desktop guest's Mesa 26.2; Debian's 25.0 has no such branch). An external resource that isn't an image's
  memory is warned of (`venus-share: resource N … isn't (or no longer) a Vulkan image's memory`; vkcube's first 500×500
  swapchain is one, gone before it shows) and counted (`unshared` in the render stats).
- **Three ways** (bench/vulkan/REPORT.md "VK2 L4"):
  - **bitmap** (where the page doesn't render in software): at the start of the compositor's submit, the image is
    drawn into a WebGPU canvas context's texture (an OffscreenCanvas of its size, `bgra8unorm`), its colours the virgl
    texture's stored channels (virgl keeps B8G8R8A8 as its bytes in an RGBA8 texture, so a `bgra8unorm` image is drawn
    `.bgra`; an X format's alpha written as 1), then `transferToImageBitmap` and `texSubImage2D` from the bitmap
    (premultiplied alpha passed as it is). A float image (`rgba16float`: vkcube's choice, Mesa's WSI offers every
    renderable format) goes through the canvas's 8 bits, as the compositor's output does anyway.
  - **canvas:** the same draw, then `texSubImage2D` from the canvas itself.
  - **readback** (SwiftShader, llvmpipe): when the compositor's submit reaches the worker, `copyTextureToBuffer` and
    `mapAsync`, and the submit is held in the call queue until the bytes are uploaded (as a pending video picture holds
    what may see it), so a frame is never stale. Each resource keeps its readback buffer: one made and destroyed a
    frame grew Chromium's GPU process by about its size a frame on SwiftShader (6.8 MB at 60 a second for vkcube's
    window: out of memory in seconds).
- **The check of the first copies:** a GPU way's copies are held, as the readback way's are, while 8 rows of the image
  are read back from WebGPU and compared with the same rows of the virgl texture (`readExternalRows`; within 1.5/255 a
  channel, colour where the image is opaque, alpha unless an X format). A frame whose sampled texels are all dark
  decides nothing; three right frames settle the way; a wrong one drops it for the next (bitmap, canvas, readback),
  and that frame gets the next way's copy before the submit runs, so a way that copies black never shows. The readback
  way is the reference and isn't checked. Where it stands is in the render stats (`share`: the way, `checking`,
  `right` or `reference`, the ways dropped and why) and on the console (`venus-share: the bitmap way checked right`).
- **Switches** (`?gpu=`): `vkbitmap`, `vkcanvas`, `vkreadback` force a way (still checked, never dropped: a wrong copy
  is only warned of); `vkbreak=<way>` (tests) makes that way's copies black without a WebGPU canvas and starts at the
  bitmap way even where the page renders in software; `vkvendor=<maker>` gives the device another maker (tests:
  `nvidia`).
- **Why not try a GPU way where the page renders in software:** a WebGPU canvas whose swap chain can't be made
  (SwiftShader's, in headless Chromium: "Could not find SharedImageBackingFactory … WebgpuSwapChainTexture") loses the
  GPU channel, and with it every WebGPU device and WebGL context of the page; a probe in a worker of its own took the
  page's down too. So the first way is chosen by the adapter and WebGL's renderer (`shareMode`), and the check only
  drops ways that work but copy wrong.

**The guest's Mesa** (VK3 L4e; bench/vulkan/REPORT.md "VK3 L4e"): Venus's guest driver (Mesa 26.x) presents on a
thread of its own when the renderer has no implicit fencing (virtio-gpu's never has), and `vn_wsi_present_async`
returns the previous present's result: an error there (`VK_ERROR_OUT_OF_DATE_KHR` from a swapchain retired while its
last present waited for slow GPU work, e.g. a resize during a first pipeline compile) is returned for the next present,
of any swapchain, and that present is dropped unsubmitted: its frame never shows and its present fence never signals,
so the app's window freezes and it can't tear its swapchain down (mpv: the pre-fullscreen frame, `vo` waiting in
`drmSyncobjTimelineWait` at quit). Unfixed upstream as of Mesa main 8598bb5c (2026-10-23). The desktop image sets
`VN_PERF=no_async_present` (images/arch/desktop-setup.sh: `/etc/environment`, `/etc/environment.d/`): presents on the
app's thread, as Venus did before 26.0 and Debian's Mesa 25.0 does; mpv keeps its bar with it. The check:
`CHECK=1 node bench/vulkan/mpv-frames.ts` on SwiftShader (the session's first mpv on Vulkan freezes there every time
without it; `GUEST_ENV=VN_PERF=no_async_present` sets it on a disk built before).

Per frame at 1920×1080 (`bench/vulkan/share.ts`: an app's frame, the copy, a compositor's draw sampling it; medians
of 5 rounds, IQR ≤ 0.07 ms; `bench/vulkan/results/vk2/l4/`):

| | bitmap | canvas (`texSubImage2D` from the canvas) | readback |
| --- | --- | --- | --- |
| Apple M4 (Metal, Chrome for Testing 153), `bgra8unorm` | **0.80 ms** | 0.93 ms | 1.89 ms |
| the same, `rgba16float` | **0.96 ms** | 1.09 ms | 3.57 ms |
| SwiftShader (dev VM, Chromium 153), `bgra8unorm` / `rgba16float` | n/a | n/a | 6.97 / 10.47 ms |

(The frame without a copy: 0.05 ms on the M4, 2.1 ms on SwiftShader.) In place, vkcube filling the desktop guest's
1080p screen on the M4 holds 60 frames/s both ways; the bitmap way takes ~0.08 ms of the GPU worker's thread a frame,
the readback way ~0.7 ms and holds the compositor's submit up to 8 ms (bench/vulkan/REPORT.md "VK2 L4").

`tests/venus-share.test.ts` checks the bytes every way (the GPU ways only where the page doesn't render in software:
on the Mac, not in the dev VM), the check's fallback with the GPU ways broken (everywhere) and its verdicts (Node);
`tests/page-venus.test.ts` checks vkcube's frames on a GLES sway with grim, the page's GPU ways broken so its check
falls back to the readback way. `bench/vulkan/present.ts` compares the page's screen (`window.__webpcGrab`: the
screen canvas as drawn, read back in the GPU worker) with the guest's own frames in the desktop guest, way by way
(vkcube's window; mpv's paused frame against its own screenshot), and runs in `bench/vulkan/nvidia.sh page`.

## Imports

The reverse of presentation: a guest program imports a virgl resource into Vulkan as a dma-buf. mpv on Vulkan
(`--vo=gpu-next --gpu-api=vulkan --hwdec=vaapi`) maps each VA-API surface it shows, whose planes (NV12: an R8 luma and
an RG8 chroma) are virgl textures the host's WebCodecs pictures are written into (docs/plans/video.md), and libplacebo
makes an image of each plane on memory imported from its dma-buf. Every frame: `vaExportSurfaceHandle`, two imports,
two images, a draw, and the images and memories freed again.

- **The guest's side:** Venus's driver resolves the dma-buf to its resource (a classic virgl resource, not a blob), the
  kernel attaches the resource to the Venus context, and `vkAllocateMemory` names it (`VkImportMemoryResourceInfoMESA`).
  Mesa's virgl VA driver says an exported surface's objects are their dma-bufs' size, a page for a decoder's host-only
  resources, and libplacebo refuses an image larger than its object ("Imported object requires 16384 bytes, larger than
  the provided size 4096"): our VA driver (webpc-va 3, images/arch/webpc-va/) says what the planes span instead.
- **The device and the renderer:** the device hands a virgl resource attached to a Venus context to Venus's renderer
  with its size (`blob-ctx` with `size`: its pages, or its texels at 4 bytes each, whichever is more) instead of to the
  virgl renderer; `venus_resource_import` makes it a dma-buf resource in vkr whose "fd" is its id (wasm has no fds:
  vkr's patch passes it on undup'ed), and `GetMemoryResourcePropertiesMESA` answers device-local memory
  (`wg_GetMemoryFdPropertiesKHR`).
- **The driver:** memory imported from such a dma-buf keeps the resource's id (`wg_device_memory.import_res`, no storage
  of its own); an image bound to it is shared, made with `COPY_DST`, and the worker is told its texture is the
  resource's (`gpu_texture_import`). A dma-buf image's layout has tight rows (an external or DRM-modifier image's:
  `wg_image_dma_buf`), so the plane's own dma-buf is as large as the image needs; others keep rows 256 bytes apart.
- **The bytes** (web/venus-import.ts `VenusImport`): `queue.writeTexture` into the image's texture, so in the queue's
  order before the submits that sample it. At the bind, the last picture written into the resource (kept for every
  resource imported before; a surface is imported again at every frame it shows), or the virgl texture read back (its
  first import); and every picture the video path writes into a plane afterwards goes to the textures imported from it
  too (`VirglRenderer.onPlane`, the decoded bytes the host has anyway).
- **The order:** nothing makes the guest wait for a picture before it imports and samples its surface. Mesa's virgl VA
  driver makes no fence for a decode, so mpv's `vaSyncSurface` returns at once (docs/plans/video.md), and Venus's ring
  is polled, past the GPU worker's call queue, which holds calls behind pending pictures. A bind while the resource's
  picture is still decoding (`videoPending.res`) reads nothing back and leaves the texture to the picture, written when
  it lands; a draw already submitted samples the texture's earlier bytes (a reused surface's last picture, or zeros for
  a fresh one) and the next one the picture. Binds, pictures and a resource's end (`unref`) all go through the queue's
  order (`VenusGpu.later`, behind submits held for their pipelines), and a bind held past its resource's end, its id
  perhaps reused, is dropped (counted at the call). A virtio reset or a snapshot's load forgets every resource. The
  call queue runs Venus's calls that make things (a context, a blob, its map, a resource's attach, a submit) past the
  calls waiting for pictures, so a resource is imported in vkr before the ring names it; those that end things wait in
  order as an unref does. The kernel's attach and the ring are still two paths: the device worker hands the attach
  over as soon as it reads the virtqueue, while the ring is read from shared memory, so a ring polled in that gap
  would miss the resource (never seen).

`tests/venus-driver.test.ts` imports a resource in the driver's test program (`wgt_import`: an R8G8 image with the
LINEAR modifier on imported memory, copied to a buffer) through `VenusImport` with a fake renderer, before and after a
picture; `tests/venus-import.test.ts` checks the order (pending pictures, held binds and pictures across a resource's
end, resets), `tests/virgl-video.test.ts` the call queue's; `tests/gpu.test.ts` checks the device's hand-over. mpv's playback is measured by
`bench/audio/avsync.ts` (`MPV_VARIANTS`): bench/vulkan/REPORT.md "VK2 L6".

## On the page

A machine has Vulkan when its Machines page setting is on (`MachineRecord.vulkan`, beside 3D: docs/plans/machines.md)
or the page's `?gpu=vulkan` asks; only then does the GPU worker fetch the module. `npm run dist` puts it in the
static copy as a hashed asset with its licences beside it (`VENUS-LICENSES.txt`, made by vk/build.sh from
`vk/LICENSES.head`, the sources' licence files and `vk/LLVM-exception.txt`); `npm start` and `npm run dist --
--no-vulkan` include it only when built (vk/build.sh isn't part of their preparation: it builds Mesa and
virglrenderer natively first). The module is 11.9 MiB, 1.18 MiB gzipped, 0.69 MiB with brotli (bench/vulkan/REPORT.md "VK2: the module, a
pipeline, a submit").
