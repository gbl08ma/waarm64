# vk/: Venus's renderer in wasm

The host side of Vulkan through Venus ([docs/graphics.md](../docs/graphics.md) "Vulkan through Venus": route (b);
[docs/devices.md](../docs/devices.md) "Venus"): virglrenderer's Venus decoder (`vkr`) over a Vulkan driver of ours
on Mesa's common Vulkan runtime, with Mesa's `spirv_to_nir`, NIR and our NIR → WGSL backend, built as one wasm module,
`target/vk/venus.wasm` (12.05 MiB, 1.24 MiB gzipped, 0.74 MiB with brotli: most of the raw size is NIR's tables), which the GPU worker
instantiates on the VM's memory 1, its own, the host-visible window after its arena (web/venus-host.ts).

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

A failed build prints only the last lines of `target/vk/wasm-build.log`, which can be the protocol headers' warnings:
check `vk/build.sh`'s exit code (and that log), or what runs next is the last driver that built.

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
- **The link:** `--import-memory --shared-memory --max-memory=4GiB` and a 4 MiB stack, otherwise wasm-ld's defaults:
  the stack, then data at the bottom of memory 1, which is the module's own. Its `sbrk` (`vk/wasi/arena.c`) starts at
  `__heap_end`, past dlmalloc's initial region, and grows without `memory.grow` up to the arena's end
  (`VENUS_ARENA_END`, web/ram.ts `VENUS_ARENA`, passed by vk/gen.ts), where the host-visible window starts;
  `venus_arena_end` says where that is, and the host refuses a module without it or with another (docs/devices.md
  "Venus"). Until VK4 T19 the module lived in an arena at memory 0's top, linked there with `--global-base` and
  `--no-stack-first`: wasm-ld puts the stack first by default, whatever `--global-base` says, and VK1's modules wrote
  memory 0's bottom 4 MiB (the core's) with every call. Pointers past 2 GiB reach JS as negative i32s: the imports
  take `>>> 0` of them.
- **No threads.** vkr's ring, ring-monitor and queue-sync threads become polls under `__wasi__`
  (`vk/patches/vkr-wasm.patch`): `vkr_renderer_poll` runs every ring and retires fences, and a seqno wait polls its
  ring. The ring monitor's alive bits are set at each poll and also by the GPU worker's ticker ("The ring monitor").
  A ring command that waits for a virtqueue seqno not submitted yet (`vkWaitVirtqueueSeqnoMESA`, which Mesa 26's driver
  sends) can't block the only thread, since that seqno comes in a later submit: the ring stalls after it,
  keeps the rest of its batch, and its poll resumes once the seqno arrives. The module imports `wasi.thread-spawn`,
  which the host answers with -1.
- **Calls and rings** (VK4 T13). A Venus call the guest makes synchronously (a command asking for a reply: `vn_call_*`)
  waits in the guest's `vn_relax` until a poll runs it, so its cost is the poller's pace. The GPU worker's pump turns
  on a **ticker** of its own (web/venus-ticker.ts: a worker sleeping 0.05 ms in a blocking `Atomics.wait`, then
  notifying the word the pump `waitAsync`s on; ~0.08 ms a turn on the Mac, ~0.17 on Linux), because Chromium stretches
  `waitAsync`'s own 0.25 ms timeout to ~1.5 ms on the Mac (bench/vulkan/wake.ts). The ticker runs only while the pump
  does (word 1), which the pump never clears while a turn waits on a tick; that wait also times out at the pump's own
period, and a ticker that can't be made or fails to load hands back to the pump with a warning. `?gpu=vkpoll=pump`
gives the pump's own turns back, `?gpu=vktick=<ms>` another sleep (0.01–10 ms; else refused with a warning). GSK's Vulkan
  renderer makes ~65–80 synchronous `vkAllocateDescriptorSets` a frame (Mesa's Venus allocates sets synchronously
  for good once a pool made with `FREE_DESCRIPTOR_SET_BIT` has had sets of mixed layouts freed), and each waited a
  turn: iconscroll on the M4 ran at 6.5 frames/s with the pump, ~31 with the ticker (bench/vulkan/REPORT.md "VK4 T13–T14").
  A ring goes idle after the guest's idle timeout (Mesa's 1 ms) without commands, and the guest's next command then
  sends a notify (`vkNotifyRingMESA`, an execbuffer); `?gpu=vkidle=<ms>` keeps rings active longer (A/B, 0–1,000 ms;
  vkr's synchronous seqno wait keeps the guest's own timeout). vkr counts what it runs (the patch's
  `vkr_wasi_count_cmd`: by where it came from, ring, virtqueue or a nested stream, whether it asks for a reply, and its
  type, under the module's `venus_cmd_types`; each time a ring goes idle; notifies, which also count each
  `vkWaitRingSeqnoMESA`), u32s whose differences the host sums modulo 2^32, and the render
  stats carry them (`venus`'s `ringCmds`, `queueCmds`, `nestedCmds`, `replies`, `idles`, `notifies`, the pump's own
  `turnMs`, and `venusCalls`: the replied commands and the virtqueue's by name), which bench/gpu/guest-session.ts sums
  (`venus.cmds`, `venus.calls`).
- **The ring monitor** (GD G3). Venus's watchdog in the guest (Mesa's `vn_relax`) clears the instance ring's alive bit
  as a wait starts and aborts the program if its first check, ~3.5 s in, finds it still clear; vkr's monitor thread sets it at the report period the
  guest asks (Mesa's 3 s). A poll sets it, but a call that holds the GPU worker's thread for seconds (Dawn's
  `createShaderModule` of Godot's 1.3 MB Forward+ WGSL took 5–6 s in the GPU process, and the worker's next synchronous
  WebGL or WebGPU call waited behind it) left it unset, and the guest aborted Godot. So the ticker is the monitor too:
  the patch keeps a table of the monitored rings' status words (`vkr_wasi_alive`, glue.c's `venus_ring_alive`: a lock,
  the smallest period asked, the count, the addresses), rebuilt under its lock whenever a monitored ring comes or goes,
  and the ticker, every third of that period, takes the lock and sets each word's alive bit (web/venus-ticker.ts
  `setAlive`), stopped or running. A renderer stuck for good still meets Mesa's own abort (895 s), and one whose worker
  is gone takes its ticker with it. `?gpu=vkpoll=pump` and `timeout` have no ticker, so no monitor between polls.
  tests/page-venus.test.ts runs vkcube across a 6 s stall of the GPU worker (`window.__webpcStallGpu`): without the
  ticker's bits Mesa logs "aborting on expired ring alive status" and vkcube dies (134); with them it finishes.

## The shader path

`vk/compiler/` (wgsl.h has the model): SPIR-V → NIR (`spirv_to_nir`, buffers as index and offset, no physical
pointers) → `wgsl_preprocess` (KosmicKrisp's pass list: inlining, splitting, outputs through temporaries, input
attachments as 2D textures, scalarized ALU) → `wgsl_lower` against a layout (1D textures and images as 2D ones of one
row; arrays of textures, buffers and storage images indexed dynamically as a binary tree of ifs over their elements, an access copied into each leaf, an index past the array reading its last element (buffers' and images' since VK3 L7.1); descriptors to slots: slot s
of a set is WGSL `@binding(2(base + s))` of its group, a combined image-sampler's sampler `2(base + s) + 1`, where set
n is group n but sets 3 and up share group 3 one after another, WebGPU having 4 bind groups; I/O to locations;
explicit memory; NIR's optimization loop) → `wgsl_link` for a vertex and fragment pair (`nir_opt_varyings`) → `wgsl_print`, out of SSA. The
printed WGSL keeps every value as u32 or bool and bitcasts at each operation, so it needs no type inference (a scalar
float only float operations read is an f32, a vector only float operations read a `vecN<f32>` (`float_vectors`), and
the integer operations whose bits don't depend on the sign work on the u32s as they are); a scalar ALU value read once,
later in its block, is inlined into its use (`inline_value`: not past a store to a register its text names, not with
only constant sources, which could make the use a const-expression, not past 160 characters, and a use whose text
would hold it twice gets it as a `let` after all; nor into a barycentric at a sample or offset, whose source each of its loads prints, `use_deferred`); a value is a `let` where its uses stay in its scope and a function-scope `var` declared where the
scope holding its uses starts otherwise, a register a `var` outside each loop that may read it before writing it in an
iteration (`place_values`, `carry_list`), a register's load its register's name where nothing stores to it before the
load's last use (and no barycentric reads it), and a loop that runs once (its body ends in its only break: NIR's early returns) its statements in
the scope around it. Constants are `let`s too, so no const-expression can overflow or make a NaN (shader-creation
errors in WGSL); a float one only floats read is an exact hex literal. Tint's uniformity analysis visits every `var` in
scope at each loop, break, continue and if: with every value a `var` at the function's top, Godot's Forward+ fragment
stage (13,113 vars, 218 loops) took 3.7 s of `createShaderModule` on the M4 and stalled the GPU process; 65 ms since
GD G2 (bench/vulkan/REPORT.md "GD G2"); the inlining, the float vectors and a uniform buffer's words by literal indices
(a constant offset) or one vec4 swizzled (an offset aligned to 16) took Godot's 210 stages' WGSL from 7.05 to 4.39 MB
(VK4 T49). Textures and
samplers come from the tex instruction's indices; push constants are immediates (a struct of vec4s, since immediates
can't be arrays, copied into an array the shader indexes), or, past the device's immediates (64 bytes in Chromium;
Vulkan's minimum is 128), a uniform buffer of the driver's at `@group(3) @binding(998)`, bound at a dynamic offset a
draw; a compute shader's `if` around a barrier, or breaking out of a loop that holds one, takes its condition through
`workgroupUniformLoad` (WGSL's uniformity analysis can't see that Vulkan's barriers are in uniform control flow, values
reaching it through registers, vars assigned wherever; a barrier after it keeps the next write from racing the read, so one word serves every condition:
shared memory's spare word where it has one (WebGPU counts each workgroup var rounded up to 16 bytes), else a var of
its own, `wg_uc`, where the workgroup's storage has room, else shared memory's first word, saved and restored between
barriers, through atomics where shared memory is of atomics (VK3 L6c; WGSL's `workgroupUniformLoad` takes one); the device advertises WebGPU's workgroup storage
whole, VK3 L5b); a vertex shader's outputs are typed and interpolated as its
fragment shader reads them (a flat location as `u32` words: `nir_opt_varyings` packs flat ints and floats into one
location, and a float's bits through an f32 varying could be canonicalized; VK4 T42), its y is negated by the override `wg_flip_y` (-1, or 1 for a flipped viewport) and its z
mirrored (`w - z`) by `wg_flip_z` for an inverted depth range (WebGPU wants `minDepth <= maxDepth`: the range is set the
right way round);
a float's conversion to a 32-bit integer saturates exactly (VK4 T29: WGSL's clamps to the largest float under the
bound, and Metal takes an f16 infinity as 65504; the bound is compared in f32, a half's bits through
`unpack2x16float`); `packHalf2x16` and `unpackHalf2x16` stay whole for WGSL's own (NIR's lowerings of them go through 16-bit values), and a
compare-exchange is a loop over WGSL's weak one until it exchanges or sees another value (SPIR-V's is strong; in a fragment stage also after 1,024 tries in a row that saw the value they compared, and an unsigned min or max's loop after 65,536 tries: a helper invocation's atomics do nothing and return what they like, a demoted one's zeros under Tint's DemoteToHelper, which Dawn uses on Metal, where the loops lost the device: the review of VK4 T47-T49). Location
0's second source (`index = 1`) is WGSL's `@blend_src(1)` (`enable dual_source_blending`, where the device has it); a
storage buffer is `read_write` only where the stage writes it (or declares it of atomics), else `read` (a vertex stage
can then read what the fragment stage only reads, and a render pass's draws, whose scope is the whole pass, agree with
its vertex stages', which WebGPU has read-only). The driver binds every buffer of a `VkDeviceMemory` from one
GPUBuffer, and WebGPU's usage scope (a dispatch's) refuses writable storage beside any other usage of it, so a dispatch
whose read-only storage buffer shares its memory with a storage buffer it writes, apart from its range, takes a variant
of its program (`program_for` in wg_cmd.c): that binding `storage` in the layout and `read_write` in a module of the
variant's own (the program keeps its WGSL for that), which costs nothing; read-only elsewhere, and where its range
overlaps the written one (WebGPU refuses two writable bindings of one range), where the replay copies it as it does a
scope's other reads ("The driver", "Usage scopes"); shared memory's atomics are `atomic<i32>` when they compare signed (imin, imax), and on an
array (shared memory is one, every SSBO another) that needs both signed and unsigned min or max the unsigned ones are
compare-exchange loops (VK4 T42); a texture
and a sampler array indexed apart get an `if` tree each (every texture with every sampler); a terminate
(`OpTerminateInvocation`) is `discard` and a return, a demote `discard` (WGSL's demotes) and a private `wg_helper` that
`helperInvocationEXT()` and `gl_HelperInvocation` read, with an empty `sample_mask` (WGSL has no built-in: the
rasterizer's helpers cover no sample); a texture offset is printed as literals, each channel found through the vec
scalarizing left (WGSL wants a const-expression); one that isn't a constant (maintenance8's `Offset` operand, VK4 T24;
a gather's, `shaderImageGatherExtended`, T29, whose `ConstOffsets` are four gathers: `lower_tg4_offsets`)
is a fetch's sum, and a sample with one comes from fetches ("Samplers in the shader"); `gl_ClipDistance` read by a fragment stage travels at free locations,
a vec4 per slot, beside WGSL's `clip_distances` (`wgsl_varyings.clip`); a compute stage that reads workgroup or global
ids adds `override wg_base_x/y/z`, a pipeline per `vkCmdDispatchBase` base (`wg_compute_based`); a cube or cube array storage image is its faces as a 2D array (the driver binds such views through a
`2d-array` view of their own), its size counted in cubes; an explicit LOD on a depth texture without a comparison picks
the nearest level in a module without keys, which is never drawn with (the keyed variants' fetches blend the levels a
linear mipmap reads: "Samplers in the shader").

**Texel buffers** (VK3 L6b): a texel buffer at slot s is its view's words, a storage buffer of `u32` at the slot's
binding (read-only but written storage texel buffers, and as above in a dispatch that writes its memory elsewhere),
and its view's parameters, two vec4s of its group's **parameter table** (computed with the `VkBufferView`,
`wg_texel_buffer_layout` in `wg_format.c`: the format's type, texel bytes and swizzle, each channel's width and first
bit, the first texel's byte in the binding and the texel count). The table (VK4 T21) is one uniform buffer a group, at
`WGSL_TABLE_BINDING` (994), whose vec4s b and b + 1 are the parameters of the resource at binding b, texel buffers' and
storage images' as words; the driver writes a buffer of it with each bind group it makes (`param_table` in wg_cmd.c),
released with the group, and slots' bindings stay under it. A uniform buffer a parameter each passed WebGPU's 12 with 12
texel buffers in a stage (dEQP-VK's `descriptorset_random.sets4`). The format is the view's, so `texelFetch`,
`imageLoad`, `imageStore` and the size queries print as calls of functions per binding (`wg_tb_load_g_b`,
`wg_tb_store_g_b`, `wg_tb_size_g_b`) that decode and encode it from the parameters: unorm, snorm, uint, sint,
uscaled, sscaled, 16- and 32-bit floats and the unsigned 11- and 10-bit ones; a texel past the count reads 0 and isn't
written. Uniform texel buffers take every plain RGB format whose channels don't straddle a word (3-byte and 6-byte
texels too), storage ones formats of whole words or texels of 1 or 2 bytes (VK4 T38: `r8`, `rg8`, `r16`, the packed
16-bit ones; 3- and 6-byte texels would straddle words). A texel of whole words is written whole; one under a word is an
`atomicAnd` and an `atomicOr` on its word, as a 16-bit store to a storage buffer is, so a store of a format under a word
or of one the shader doesn't declare (the view's, known only when bound) makes the binding `array<atomic<u32>>`, and a
store of a declared format of a word or more keeps it plain. Atomics take R32's (`STORAGE_TEXEL_BUFFER_ATOMIC`, 1.3's:
`atomic<u32>` or `atomic<i32>` by the ops' sign). **Shared words** (VK4 T40, dEQP-VK's `descriptorset_random`, which binds a stage's
texel buffers and uniform buffers from one buffer): a texel buffer's words take a storage buffer where Vulkan counts an
image, so a stage of many, beside folded uniform buffers, passed WebGPU's storage buffers. Where a program's bindings
fit only so (`wg_bindings_fit`'s `shares`), it has no layouts of its own and each draw or dispatch takes a variant
(wg_cmd.c `shared_words`) in which the words a stage only reads of texel buffers and of uniform buffers read as storage
(`wg_shareable`) read through one binding a memory: the memory's whole (`wg_share.whole`, every group's that bind it), or,
where it's past what a binding takes or isn't one (a set's inline uniform blocks, of its own buffer), a run of one
group's places within `maxStorageBufferBindingSize`. The variant's text reads each one's `rG_B[i]` as
`rT[rG_994[B].w + (i)]` (wg_shader.c `shared_text`): its place in the binding is the `.w` of its first vec4 in its
group's parameter table (made where the group had none), written with the bind group, so the variant is keyed by who
shares with whom, not by the places; a draw whose variant still doesn't fit (words of several memories) is refused,
said once. Shared words stay read-only: a scope that writes their memory reads them from its shadows.

**Uniform buffers past WebGPU's** (VK3 L7.4, ANGLE's ES3): the device reports `maxPerStageDescriptorUniformBuffers`
two past WebGPU's less the push buffer's binding (13 of 12) and the storage buffers two fewer, or three where 8 storage
buffers are left beside them (VK4 T40: vkd3d's 14, on an adapter of 11 or more; SwiftShader and the M4 have 10); a uniform buffer past
its stage's room is read as a read-only storage buffer (`lower_ubo_storage` in wgsl_nir.c turns its loads into SSBO
loads, so it is `var<storage, read>` and its layout entry `read-only-storage`). The pipeline layout decides
(wg_shader.c `fold_uniforms`), by the stages each binding's flags name, so every stage that sees a buffer reads it the
same way: a stage's room is WebGPU's uniform buffers less one for the push buffer (counted always), one for each group
with texel buffers or storage images (their parameter table: a storage image may be words) and its dynamic uniform buffers (never folded: WebGPU's dynamic storage buffers are fewer); the rest, in
set and binding order, are storage (the set layouts' hash carries the stage flags, the shaders' keys with it).
`maxDescriptorSetUniformBuffers` and the other set-wide limits are six times a stage's, as Vulkan's table of minimums is (VK4 R7): a set may spread its descriptors over stages, what one stage of a pipeline binds being held to a stage's.

**Draw parameters** (VK3 L7.5, `shaderDrawParameters`, vkd3d's row): WGSL has no built-ins for SPIR-V's `BaseVertex`,
`BaseInstance` and `DrawIndex` (its `vertex_index` and `instance_index` include the bases, as Vulkan's `VertexIndex`
and `InstanceIndex` do, so those stay WGSL's). A vertex stage that reads them reads three words of the push buffer
at byte 256 (`WGSL_DRAW_PARAMS`, past the device's 256 bytes of push constants: `pc[16u][0u]` to `[2u]`), so its push
constants are in the push buffer too, never immediates (an indirect draw's parameters are written on the GPU); the
driver knows such a program by its push buffer's size past 256 ("Commands").

**Transform feedback** (VK3 L7.4, `VK_EXT_transform_feedback`): a vertex stage's body is a function of its own,
`wg_vs(vid, iid, i)`, which the entry point calls before it flips y and z; where the runtime gathered `nir->xfb_info`,
`nir_io_add_intrinsic_xfb_info` puts each output's buffer and offset on its store (after constant folding, which moves
a matrix's or array's slot offset into its location: the pass matches by location), and the printer copies each
captured component's bits into `var<private> wg_xo`, the vertex's record (each buffer's from `xfb_base[b]`, its stride
and written words in `wgsl_info`). The driver's compute pass ("The driver") calls `wg_vs` and writes the record out.
32-bit outputs only, records up to 512 bytes; gl_PointSize captured too (VK4 T45: kept on its store for the capture alone).

**Vertex stages that store** (VK4 T33, `vertexPipelineStoresAndAtomics`): WebGPU refuses writable storage reached from
a vertex entry point, and the module that has one, so a vertex stage that writes a storage buffer or image or does
atomics (`wgsl_info.stores`) is printed without its `@vertex` entry point: its body, `wg_vs`, runs as compute before
its draw ("The driver", "Vertex stages that store"), and its resources are the compute stage's in its program (their
visibility; `wg_bindings_fit` counts the pre-pass's binding, `WG_VS_STORAGE`). A transform feedback capture of
such a stage is dropped, said: the capture's pass would run it again.

**Subgroups** (VK3 L5): with WebGPU's `subgroups` and an adapter whose subgroups have one size (`wg_subgroup_size`:
SwiftShader's 4, Apple's and NVIDIA's 32; WGSL can't choose one, so an adapter whose sizes vary keeps subgroups of one
invocation), `wgsl_lower` lowers for that size (`nir_lower_subgroups`, ballots of 4 × 32 bits) and the printer uses
WGSL's built-ins (`enable subgroups`, `diagnostic(off, subgroup_uniformity)`: through registers, vars assigned
wherever, the uniformity the program keeps can't be seen): ballots, votes, `subgroupBroadcastFirst`, a read of one invocation as
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
(`interpolateAtOffset`, `interpolateAtSample`; VK3 L7b, which `sampleRateShading` brings in SPIR-V) is the input
where WebGPU interpolates it (the pixel's centre, or its sample at the sample rate; the centroid taken as the centre)
moved to the offset from the centre or to the sample's position along its fine derivatives (`dpdxFine`, `dpdyFine`):
exact for linear interpolation, within a pixel close for perspective (dEQP-VK's `multisample_interpolation` samples_4
cases of it pass); a flat input as it is.

Subgroups are in compute and fragment shaders only
(WGSL's), and a subgroup-scoped barrier does nothing. Without them, subgroups of one invocation: the device advertises the basic operations in compute, but every family translates, each its value on a subgroup of one (NIR lowers them for size 1, `read_invocation` printed as its value: GD G1), since programs use what the device doesn't advertise (Godot's Forward+ scene shader calls `subgroupBroadcastFirst(subgroupMin(…))` in its fragment stage unconditionally, and drew no mesh on the M4 before).

**16-bit values** (VK3 L5): kept in a u32's low half. 16-bit storage (buffers, uniform buffers, push constants; every
adapter) loads and stores halves of words, a store to a buffer or shared memory as an `atomicAnd` and an `atomicOr` on
its word (the array declared atomic: another invocation may store the other half); conversions to 16-bit floats are
NIR's integer code (`nir_lower_fp16_casts`: WGSL's own may round either way), from them `unpack2x16float`; 16-bit
integer arithmetic is done at 32 bits (`nir_lower_bit_size`). 16-bit float arithmetic (`shaderFloat16`) needs
`shader-f16`: each value is viewed as `bitcast<vec2<f16>>(t).x`. **8-bit values** (VK4 T29: `shaderInt8`, 8-bit
storage) are kept in a u32's low byte the same way: loads and stores of bytes of words (a store an `atomicAnd` and an
`atomicOr`), the arithmetic at 32 bits, a view sign-extended where the operation is signed. **16-bit inputs and
outputs** (`storageInputOutput16`) are 32-bit ones, converted where they're loaded and stored (`widen_io16`, after
`nir_lower_io`: a half's bits in a 32-bit varying would be interpolated as nonsense; vertex attributes and fragment
outputs likewise). **64-bit integers** (`shaderInt64`) are pairs of words: a 64-bit load or store of memory is one of
two words a component, packed into the value (`split_64bit_access`), so only ALU values are 64-bit, and
`nir_lower_int64`, `nir_lower_64bit_phis` and `nir_lower_alu` (its multiply's `umul_high`) lower those to 32 bits until
none is left (`lower_64bit`, again after the last optimizations; the options keep `pack_64_2x32_split` whole, which
the algebraic rules take apart, never as 64-bit shifts). No 64-bit floats and no 64-bit atomics. A function-scope array NIR moves to scratch is
addressed by its whole offset (scratch has no base: before L5 the printer read the alignment there, and the last
element's last word of an array past 32 bytes indexed dynamically went past the array). What
WGSL can't express fails the stage with a reason: 16-bit float arithmetic without `shader-f16`, 8-bit floats, 64-bit
values left (atomics, floats), 8- and 16-bit atomics, descriptors reached through pointers (variable pointers' selects), atomics on images but R32's.
A pipeline whose vertex stage reads a storage image its fragment stage writes is refused (one layout entry can't match
both modules' access, and WebGPU has no writable storage in vertex shaders), and so is one whose fragment stage writes a
storage buffer its vertex stage reads. A pipeline whose stage fails is still made, of shaders that draw and dispatch nothing: Venus's guest driver binds a
pipeline without waiting for its result, and a pipeline that failed would fail the guest's whole context.

`tests/wgsl.test.ts` runs VK0's scene's shaders (glslc) and VK1 step 1's 108 stages (`target/vk1/spirv`, dumped by
`SPIRV_DIR=target/vk1/spirv bench/vulkan/translate/programs.sh`; not committed, they're the programs'): 124 of 127
translate (0.47 ms a stage at the median in Node, 28 ms GTK4's largest) and all 124 compile in Chromium; the three
others are vkQuake's variants for a device with 16-bit floats (dumped through the Mac profile: translated for
SwiftShader, without `shader-f16`, all three stop at their 16-bit arithmetic; its screen effects' palettization, a texel buffer, translates since VK3 L6b). It checks that Tint accepts the
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
- `vk/patches/vkr-wasm.patch`: the polls; a context destroyed with objects destroys them in the driver (vkr does so
  on the render server's worker thread only, natively each context's process exits: here a killed program's devices
  stayed, and the 17th failed to be made; VK4 T2), without the idle wait before (the driver can't block: its
  `vkDestroyDevice` drops pending work); a blob of the context's own imported again (the guest's opaque-fd or dma-buf
  export of a memory, imported) names that memory's handle as an opaque fd, which the driver takes as one more
  reference to it (`wg_device_memory.aliases`; vkr's memories of one driver memory are peers, `wasi_peers`, which hand on its
  storage and blob as each is freed, so a surviving import moves with the blob), and an import that can't be made (all of
  them freed) is a memory of its own, not an error the guest would only meet at its free; device memory as vkr's own `aligned_alloc` storage, imported into the driver
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
  device's (`gpuFeatures`: a bit a feature; `gpuLimits`: 34 limits as `struct wg_limits`, WebGPU's defaults where the
  browser has none). The mapping is VK0 A's (`bench/vulkan/profiles/make.ts` `direct`) for the direct rows (docs/graphics.md "What maps, what's emulated, what isn't offered"):
  image sizes, descriptor counts, buffer ranges, vertex input, workgroups and inter-stage components from the limits;
dynamic indexing of every descriptor array and sample-rate shading (VK3 L7.1, Dawn's row: Dawn's Vulkan
backend refuses a device without the four `shader*ArrayDynamicIndexing` features, and its core WebGPU wants
`sampleRateShading`; "The shader path"); ANGLE's row (VK3 L7.4): the last vertex provoking, transform feedback and
uniform buffers past WebGPU's ("The shader path", "Commands"); vkd3d's (VK3 L7.5): draw parameters;
  depth clamp, dual-source blending, clip distances, first instance in indirect draws, the compressed families and
  from the features; `shaderStorageImageExtendedFormats` with `texture-formats-tier1` and unless held (below); `shaderFloat16` from `shader-f16`, real subgroups (size,
  stages and operations: "The shader path") from `subgroups` (VK3 L5), and 16-bit storage everywhere. Less what the
  translator can't do (8-bit and 64-bit types, 16-bit integers and inputs and outputs, YCbCr conversions with `?gpu=vkycbcr=off` (below); subgroups of one invocation with the basic
  operations where the adapter has no `subgroups` or its sizes vary), with Direct3D 12's root constants' 256 bytes of push constants (vkd3d's check, VK4 T47: past the immediates
  they're read from the push buffer) and Vulkan's minimum of bound sets (8,
  as `WGSL_MAX_SETS`), dynamically indexed arrays of every kind of descriptor (`if` trees), formats from WebGPU's tables
  (`wg_format.c`: optimal tiling as WebGPU can sample, render, blend and store them, which `wg_format_init` resolves
  from `texture-formats-tier1` (the 16-bit normalized formats, unfilterable as WebGPU has them; snorm and
  `rg11b10ufloat` attachments), `rg11b10ufloat-renderable` and `bgra8unorm-storage`; linear tiling only copies; buffers
  vertex input and texel buffers: "The shader path"), samples 1 and 4 (1 for the 32-bit integer formats and the float ones of two or four
  channels, which WebGPU doesn't multisample), views of a mutable image in any format of its size (below, "Views in another format"; WebGPU's `viewFormats` alone gives the sRGB twin: a format list naming
  another format is refused by the image-format query, and such a view warned of; a multi-planar image's list may
  name its planes' formats, VK3 L7b), no multi-planar image on external memory (its planes' textures are neither
  imported nor exported: refused by the image-format query, VK3 L7b); plus the extensions
  Venus's WSI shares through (dma-buf memory; one DRM modifier, LINEAR, with the optimal tiling's features; foreign
  queue transfers; sync-file semaphores). It reports an integrated GPU (libplacebo, GTK4 and wlroots turn CPUs away)
  whose vendor ID is the adapter's maker's (`VENDORS`: Apple's, NVIDIA's, Google's for SwiftShader; 0 for one not
  listed), as Venus on a native host passes its GPU's on, named `webpc WebGPU`. Vulkan 1.4's `maintenance5` and
`maintenance6` and `maintenance8` (VK4 T24: mostly the runtime's and host-side; their A1B5G5R5 a packed format since
VK4 T30, A8_UNORM an `r8unorm` texture since VK4 T38, "Formats a texture holds otherwise" below; `maintenance8` reaches
a guest only through Mesa 26.3's Venus on: 26.2's leaves it out). Two memory types, each on a heap of its own (device-local, 2 GiB;
  host-visible, coherent, cached and device-local, 1 GiB: the least GFXReconstruct, VMA and DXVK take as general memory
  rather than a discrete GPU's BAR window), whose budget reports what's allocated from each (VK4 T2). Host-visible
  memory's bytes are in the arena (1,280 MiB of memory 1 with the module's own heap), which backs its heap (VK4 T19). An allocation past
  its heap, the largest GPUBuffer or the arena is refused; Venus's guest doesn't wait for that answer, imports' included, and an object vkr
  didn't make would end the context at its first use, so through vkr it is an empty memory (`memory_refused`, VK4 R6;
  docs/backlog.md "Memory"), while host-visible memory past its heap with the arena's room is simply had. Three queue
  families (VK4 T22; `wg_queue_families`, `?gpu=vkqueues=1` for the first alone): graphics, compute and transfer;
  compute and transfer; transfer, a queue each, every queue the WebGPU device's one: one order of submits, so
  ownership transfers between families are no-ops (barriers ignore family indices) and a semaphore between queues is
  met by that order. A held submit (below, "Waits before their signal") holds the ones after it on its own queue only, so another
  queue may signal what it waits for; a wait on a binary semaphore whose signalling submit is held is held with it
  (`held_signals`: Vulkan only has the signal submitted first, and one queue's order no longer keeps it). `tests/venus-renderer.test.ts` checks it against the Mac's and
  SwiftShader's recorded adapters.
- **libplacebo's advanced path** (VK2 L7, VK3 L4–L4e; web/venus-gpu.ts `HELD_FEATURES`): `float32-blendable` and
  tier1's storage formats (bit 14 of `venus_init`'s flags, `WG_FEATURE_TIER1_STORAGE`, which also says
  `shaderStorageImageExtendedFormats`; set on every adapter unless held). Either gives mpv's libplacebo a family of FBO formats (32-bit floats, or
  16-bit floats with tier1's storage), and with them its advanced rendering (scalers, debanding, its frame cache). The
  driver takes both where the adapter has them, by default since VK3 L4e. They were held while mpv's VA-API chroma
  read as zeros on the M4 in about a third of fresh sessions (the window's pages lost between devices, fixed in VK3
  L4c-A: bench/vulkan/REPORT.md "VK3 L4b–L4c"; 0 of 58 sessions since), then while a cold mpv's window froze (Mesa's
  async present, "The guest's Mesa" below; REPORT.md "VK3 L4d", "VK3 L4e"). `?gpu=vkformats=held` holds them again
  (libplacebo then has no FBOs and mpv renders as in VK2 L6: "Failed creating FBO texture", its VA-API frames byte for
  byte its software ones); `?gpu=vkhold=<feature>` holds one (`tier1-storage` is tier1's storage alone).
- **YCbCr conversions** (VK3 L7.2; `WG_FEATURE_YCBCR`), on by default since L7.3 (`?gpu=vkycbcr=off` holds them): GTK
  4.24 asserts them on a device with dma-buf modifiers (`gdk_display_create_vulkan_device`), so without them every GTK4
  program aborted at its start on a machine with Vulkan; with them GTK still takes GL by default, since it counts only
  modifiers other than LINEAR as dma-buf formats its Vulkan renderer can import (`gdk_vulkan_init_dmabuf`: "Not using
  Vulkan: no dmabuf support"), and Chromium's own Vulkan device refuses a device without them (L7.1b). GSK's Vulkan
  renderer, forced (`GSK_RENDERER=vulkan`), draws right but misses GTK4's bar (bench/vulkan/REPORT.md "VK3 L7.3"). With
  them:
  `samplerYcbcrConversion`, `KHR_sampler_ycbcr_conversion`, `EXT_ycbcr_image_arrays`, and the multi-planar formats
  whose planes WebGPU samples and filters (`wg_ycbcr_format`: the 8-bit 2- and 3-plane 420, 422 and 444), optimal
  tiling, with sampling, linear filtering, transfers, midpoint and cosited chroma, a linear chroma filter and
  disjoint planes. A multi-planar image is a texture per plane (`wg_image.planes`: its format and subsampled extent,
  its bytes after the plane before, or in a memory of its own when disjoint); copies and views of a plane aspect use
  its texture, and a view of the whole image is a view of each plane. A set layout binding whose immutable samplers
  have a conversion gets two slots more an element after the set's others (its view's other planes, mirrored at each
  write: `wg_descriptor_set_layout.planes`, `owner`), and its conversions go into the layout's hash (the shaders'
  keys). The translator runs Mesa's `nir_vk_lower_ycbcr_tex` first (`wgsl_lower_ycbcr`): a sample through such a
  sampler becomes one sample of each plane (a cosited chroma's coordinate moved half a chroma texel, the sampler
  filtering it: implicit reconstruction), the plane's swizzle, the conversion's mapping, range and model; a plane past
  the first is the binding's plane slot. Gaps: docs/backlog.md "YCbCr's gaps". The modifiers stay: Venus's WSI needs
  them.
- **Memory**: a `VkDeviceMemory` is one `GPUBuffer` with every buffer usage (made at its first buffer bind; buffers
  are ranges of it, so they alias); an image is a `GPUTexture` of its own (its memory only says where its bytes would
  be; a compressed one's size rounded up to whole blocks, as WebGPU wants, and its copies with it, the shader sampling
  the corner that's the image ("Samplers in the shader"); a 1D one 2D),
  with views made as Vulkan made them (a depth or stencil aspect's with the image's format and the aspect) and, for
  attachments, as one 2D level and layer, or a 3D image's level and the slice its 2D view starts at (`depthSlice`).
  WebGPU has no 2D view of a 3D texture, so one sampled or bound as a storage image (`VK_EXT_image_2d_view_of_3d`,
  `image2DViewOf3D` and `sampler2DViewOf3D`, VK4 T38) is the level's 3D view, and the draw's variant takes a key of the
  slice (`WGSL_SLICE_KEY`, `program_keys` in wg_cmd.c, once a device has made such a view): its binding declared 3D and
  every op on it given the slice as its third coordinate (wgsl_sampler.c `lower_slice`: `(slice + 0.5) / depth`
  normalized, the slice fetched or stored, size queries their first two); a pipeline a slice bound. Host-visible memory's bytes
  are in the module's memory (vkr's storage in the arena, or the window while its blob is mapped); at each submit the driver uploads the
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
  destroyed). A storage binding is a whole number of words (WebGPU's): an odd size is rounded up within its memory,
  which is whole words.
- **Usage scopes** (VK4 T3, `scope_pass` and `scope_dispatch` in wg_cmd.c): WebGPU's usage scope (a dispatch; a whole
  render pass) refuses a GPUBuffer bound as writable storage beside any other usage of it, and a memory is one GPUBuffer,
  so a pass or dispatch that wrote storage of a memory it also read through another binding (a uniform or read-only
  storage buffer, a texel buffer, a vertex or index buffer, indirect arguments) was dropped with its submit; every
  sub-allocating program (VMA, DXVK, vkd3d) meets it once its shaders write storage. The replay scans each scope before
  it begins (a render pass's commands up to its end, secondaries included: the binds, buffers and indirect arguments in
  force at each draw; a dispatch's bound groups), and where it reads a GPUBuffer it binds writable, it copies those
  reads into the device's shadow buffer (`shadow_place`: 256-aligned places taken in order within a submit, the buffer
  grown by replacement) and binds them from there: bind groups of the scope's own (their dynamic offsets 0), vertex,
  index and indirect buffers at their places; at the scope's end the groups are bound again without. Each buffer's read
  ranges are merged into spans copied once (from 256 bytes below the first, so offsets keep their alignment). A scope
  reads what such a range held at its start, so a draw doesn't see what an earlier draw of its pass wrote there, until a
  barrier inside the pass: a pass with shadows ends its WebGPU pass there, what shadows took goes back, and the rest of
  the pass is a scope of its own (`scope_cut`; not a barrier of a secondary command buffer, which the scan can't go on
  from). Two writable bindings whose ranges overlap become one, by a variant of the program (`storage_aliases`,
  `wg_storage_alias`, wg_shader.c `aliased_text`): the lowest binds the whole run, the others' accesses go through it at
  their distance, their `arrayLength`s the bound size as text, and their own bindings hold a small buffer of the device's
  no shader reads. A run of atomic and plain arrays can't be one (their arrays' types differ) and past
  `maxStorageBufferBindingSize` neither: its draw or dispatch is refused, said once (`aliases_refused`; VK4 T37, WebGPU
  dropped the submit before). A subresource read as a texture and written through a storage binding in one scope
  (`scope_reads`; a 3D image's level is one WebGPU subresource) reads a copy of the image taken at the scope's start
  (`wg_view_loop`'s, a feedback loop's texture: VK4 T37): WebGPU refuses a texture bound both ways. A uniform block
  declared past its range and what its memory's GPUBuffer has past it (`WG_MEMORY_PAD`, cut short near
  `maxBufferSize`) reads a shadow of the block's size, the range's bytes copied in (`scope_use.need`, VK4 T37). A storage buffer beside a pointers' binding in one
  draw or dispatch goes through that binding (below, "Device addresses"); other writable descriptors of address memory in
  such a scope go to a shadow written back at the scope's end; shadows a scope writes are in a GPUBuffer
  of their own, apart from those it only reads. A scope without such a conflict costs the scan alone.
- **Shaders** (`wg_shader.c`): the runtime's `vk_shader` path. A pipeline's stages are compiled together
  (`wgsl_lower` against its set layouts, `wgsl_link`, the fragment shader printed first), with what they share
  (`wg_program`: bind group layouts from both stages' resources, a pipeline layout with the immediates). Render
  pipelines are made at the first draw needing one, keyed by the state WebGPU bakes in (`wg_pipeline_key`: vertex
  layout, topology, rasterization, depth and stencil, blend, attachment formats, samples, the viewport's flip); an
  attribute past its binding's stride (Vulkan allows it, WebGPU doesn't) reads a vertex buffer slot of its own, the
  same buffer further on (`wg_vertex_slots`). A binding WebGPU's vertex buffers refuse is pulled instead (below,
  "Pulled vertices"). A texture the shader declared filterable float but bound to a view
  WebGPU can't filter (a depth view, `r32float` without `float32-filterable`) draws with a variant of the program
  (`wg_program_variant`, by a mask of such bindings): those bindings unfilterable, the samplers they're sampled with
  non-filtering and given the sampler's nearest twin. A render pipeline is made when a draw needing it is recorded
  (the replay finds it by its key), so that it is likely ready by the submit (below, "Pipelines made asynchronously").
  Shaders are serialized (`wg_serialize`: a stage's WGSL and info, its program's data and link), so pipeline caches
  carry them (a guest program's own, and the store across runs: "The shader cache"). A program is shared by the stages
  of one link (`program_link`: a hash of its data and its stages' WGSL), however each stage came (compiled, or found in a
  cache while its partner was compiled): a draw needs its vertex and fragment shaders on one program. The link hashes
  the resources field by field (a struct's padding is indeterminate). Stages that still come with different programs
  (a cache whose entries disagree) draw with a program of both's bindings (`wg_program_merge`, said once on stderr;
  stages that disagree on a resource as `wg_shader_compile` refuses, `stages_agree`, refuse their draws: VK4 T37),
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
  **Mutable descriptors** (VK4 T34, `VK_EXT_mutable_descriptor_type`): a slot takes any type of its binding's list
  (`types`, a bit a type), keeping nothing of the type written before; since bind groups are made of the program's
  declarations, each slot's descriptor as written, a mutable binding needs nothing more (a declaration of another type
  than the one written is undefined in Vulkan). Vulkan's per-stage limits count only the types, so the layout's support
  query says no to one that could take more of a kind of WebGPU binding than a stage has, a mutable descriptor counting
  in every kind its list names (`wg_mutable_layout_fits`). Declarations of several types aliasing one binding need
  `descriptorBindingPartiallyBound`, which isn't advertised (no descriptor indexing).
- **Commands** (`wg_cmd.c`): recorded into a list of our own; each draw or dispatch records the state it needs where
  it changed. A submit replays the list into one encoder (passes opened and closed as the commands need; render passes
  from the runtime's dynamic rendering, with legacy passes through its emulation; clears as load ops, or draws for a
  partial render area and `vkCmdClearAttachments`; LOAD and NONE load, DONT_CARE clears but loads for a partial render
  area, whose outside Vulkan keeps; a pass that resumes a suspended one (`VK_RENDERING_RESUMING_BIT`) loads and clears
  nothing, one that suspends stores whatever its store op, since its WebGPU pass ends there (VK3 L4c-D); a depth or
  stencil attachment in a read-only layout is WebGPU's `depthReadOnly`/`stencilReadOnly` (so the pass may sample it; its
  pipelines then write neither); blits, resolves and image clears as the worker's draws, depth and stencil resolves too
  (at the end of the pass instance, within its render area: a draw writing the pixel's resolved value as `frag_depth`,
  and for stencil, which no shader writes, a draw zeroing it and eight draws, one a bit, each keeping the pixels whose
  resolved value has it; VK3 L4f; the attachment is stored whatever its store op, since Vulkan resolves before the
  store op and the draws read it after the pass: L5b). Every mode is advertised (VK4 T27): SAMPLE_ZERO, MIN and MAX of
  both aspects, AVERAGE of depth (the samples' mean, which the attachment's format rounds), each aspect on its own
  (`independentResolve`, `independentResolveNone`: the draws are each aspect's);
  `CONSTANT_ALPHA` colour factors as WebGPU's one constant set to the constant's alpha (a draw mixing it with
  `CONSTANT_COLOR` in its colour can't be expressed: warned, the colour kept);
  pipelines as WebGPU takes them: an indexed strip always has its index format, depth bias only for polygons, and a
  pipeline without a fragment shader in a pass with colour gets an empty one, its targets unwritten); every draw's
  pipeline is keyed by the state it draws with (`draw_key`, from the runtime's dynamic state), so what WebGPU's
  pipelines hold can be dynamic, each value a variant (VK4 T28): extended dynamic state 1 and 2, the vertex input
  (`VK_EXT_vertex_input_dynamic_state`), and of the third set the depth clamp and clip, sample mask, alpha to coverage,
  colour blend enables, equations and write masks, alpha to one and the provoking vertex; alpha to coverage at one
  sample, which WebGPU's pipelines refuse, is the fragment stage's (`wg_a2c`, an override: a fragment whose location
  0's alpha is under a half discarded). **What the fragment stage does past its outputs** (VK4 T43, wg_shader.c
  `post_text`: the stage's `main` becomes `wg_fp`, its parameters without their `@builtin` attributes (WGSL allows
  them on an entry point's alone; `dst_text`'s `wg_fs` likewise), which a new `main` calls, and the members it adds to
  `Out` it sets; a key whose stage can't be printed so is refused, its draws dropped and said once, not drawn without
  what it asks: dual-source outputs a location map moves):
  a depth bias WebGPU's integer `depthBias` (a whole number of its texture's least step) can't give is the rasterized
  depth moved by `m · slope + r · constant`, clamped, written as `frag_depth` (`bias_frag` in the key, the slope `m`
  from the depth's derivatives before the stage runs): every one but the format's representation's whole constants on
  `D16_UNORM` and the float formats, so `VK_EXT_depth_bias_control`'s FLOAT (r 1) and FORCE_UNORM (2^-24 on a float
  format) representations, fractions of a step, constants past an int32, `depthBiasExact` (SwiftShader's own isn't),
  and every bias on D24 (a depth24plus texture may be a float one: Dawn's on SwiftShader; r 2^-24 there, the depth and
  the bias added as whole words, each `round(x · (2^n − 1))`, so a step of one is one word whatever the depth and the
  attachment holds what reads back as its word); a float format's r 2^(e − 23) from the fragment's own depth's
  exponent (Vulkan's is the primitive's largest). Such a draw's fragments take no early depth test, and a pipeline
  without a fragment stage gets one writing the depth. Alpha to coverage WebGPU can't take (no colour target at
  location 0, target 0 not location 0's under a location map, a stage writing `sample_mask`, or alpha to one, whose
  alpha 1 its coverage would see) is the stage's `sample_mask`, the first `round(alpha · samples)` samples of location
  0's alpha wherever the map puts it (and the stage's own mask); alpha to one sets the float
  outputs' alpha to 1 after the coverage is taken. Stencil state per
  face (WebGPU has one reference and one pair of masks, Vulkan a set a face): a draw whose faces both use one of them
  with different values (a reference compared or replaced, a compare mask compared, a write mask written), both faces
  drawn, is two draws, its front faces with the front's (the back culled) and then its back faces with the back's, so
  the order between its front and back primitives is lost where they overlap (stencil ops, blending, depth ties) and
  its vertex stage runs twice; faces differing only in what they don't use draw once (VK3 L6c); with one face culled
  the other's is used (VK3 L6a); occlusion queries on the GPU (VK3 L6a; VK4 T46's shape): a pool is a buffer of each
  query's last value (8 bytes a query, any number of queries); a render pass whose commands begin a query takes the
  device's occlusion set (`query_set`: WebGPU's pass takes one set, at its start), each of its counts the next of its
  4,096 slots whatever the query's pool and index (`query_count`), and a query begun outside a pass counts each pass it
  spans, added up (none: 0). A `vkCmdClearAttachments` inside a query (the worker's draw, which Vulkan doesn't count) and
  every cut of the WebGPU pass inside Vulkan's (a feedback loop's or a draw's attachment copies, a scope's barrier, a
  vertex stage's pre-pass, a byte count) end the WebGPU query and carry it on in the next slot (VK3 L6c), as a layered
  pass's later layers count theirs (VK4 T43). At the pass's end its slots are resolved at once into the device's scratch
  buffer, each query's own count copied to its place (runs of consecutive slots to consecutive queries in one copy), and
  the later slots' counts added to their queries' by one dispatch a pool (`gpu_query_add`, in their order); past 4,096
  counts in a pass a query is reported as passing, said once. `vkCmdCopyQueryPoolResults` is one dispatch (VK4 T46,
  `gpu_copy_queries`): each query's values from its pool's buffer and its availability (the queue's order: what the
  replay has seen ended and not reset since, passed as bits) where Vulkan puts them, the bytes between results
  untouched and an unavailable query's values unwritten without `PARTIAL_BIT`; a submit reads the values its queries
  ended back for `vkGetQueryPoolResults`, which reports a query available once that submit completed (`VK_NOT_READY`
  before, `WAIT_BIT` too: the host can't wait for a completion; Venus's guest driver reads its feedback buffers, which
  the copies fill, instead). **Timestamps** are the GPU's where the adapter has `timestamp-query` (VK4 T46; the device
  asks for it), but on Apple's GPUs, where they are held (web/venus-host.ts: with them the M4 lost its device in 3 of
  6 runs of dEQP's query cases, docs/backlog.md "Queries"): outside a render pass the end write of a compute pass of one invocation that does nothing (Metal writes none
  for an empty pass) into the device's timestamp set; inside one the
  end of the WebGPU pass's part it is in (each part of a Vulkan pass whose commands write timestamps ends with a write:
  `begin_pass`), so every timestamp of a part reads its end, later than the commands before it, as Vulkan allows. A
  timestamp right after a render pass (no work between) reads that pass's end write, unless the worker runs the pass's
  own work after it (its captures at `endPass`, its shadows' write-backs: `ts_tail`; a write of its own then, after
  them), and one at the top of the pipe right before a pass its beginning write (`ts_after`, `ts_before`), unless the worker
  runs work for the pass before it begins (`prepasses`' indices and indirect arguments, `scope_pass`' copies:
  `timestamps_lead`, a write of its own before that work): on Metal a compute pass's write ran beside the
  render pass before it (VK0's scene read 0.04 ms for a pass the GPU took 0.5 ms over); a pass that carries the
  driver's writes isn't timed by `?gpu=vkgputime` (WebGPU's pass takes one set of writes). The
  slots are copied to their pools' buffers at the submit's end, before a copy of results, and when the set's 256 run
  out (`timestamps_flush`: free again whether or not a timestamp reads them, a pass's end and beginning slots taken
  together, so a flush never resolves a slot before its write). Chromium may quantize them (Dawn's `timestamp_quantization`, which
  `timestampPeriod` 1 doesn't say; the tests' `--enable-unsafe-webgpu` gets them to the nanosecond). Without the feature they are the CPU's at the replay), copies
  what the GPU wrote to host-visible memory into staging buffers, and submits. Buffer copies WebGPU can't make (an
  offset or size not 4-aligned) go through a compute pass of the worker's: the source's words copied to a temporary
  buffer, then each destination word the copy touches written, its other bytes kept; on the GPU in the encoder's
  order, so device-local sources and what earlier commands wrote are copied too (VK3 L4c-F; they used to be copied
  from the CPU's bytes at the destination's unaligned offset, which invalidated the submit). A copy within one
  GPUBuffer (two VkBuffers of one memory, or one's disjoint ranges: WebGPU refuses a buffer as its own source) goes
  through a temporary buffer, and a copy or blit within one subresource of an image (WebGPU refuses overlapping
  subresources, and sampling one it renders to) copies the region, or the blit's whole source subresource, into a
  temporary texture first (VK3 L8a; the invalid copy lost the submit). An image clear of a
  format WebGPU can't render to (`rgb9e5ufloat`, the snorm8 formats without tier1, `rg11b10ufloat` without its
  feature) is its clear colour encoded in the worker (`encodeTexel`) and copied in; a 3D image's clear covers every
  slice; a blit from a 3D image samples it as one, at the slice each destination slice maps to (VK3 L4c-F), and between an
array's layers and a 3D image's slices (maintenance8) a layer a slice, a draw each (VK4 T24); a nearest blit finds its
  texel by Vulkan's sum from the fragment's position (an interpolated coordinate came a hair short of whole texels on Metal:
  VK4 T12, `generate_mipmaps.from_previous_level`); Buffer ↔ image copies whose rows
  aren't 256 bytes apart go a row of blocks at a time, but for depth and stencil, which WebGPU copies only whole
  (the worker realigns their rows through a temporary buffer); depth WebGPU won't copy (into depth32float's or
  depth24plus's depth, out of depth24plus's, part of a subresource, and image copies of part of one or of depth24plus,
  whose textures have no copy usages) goes through the worker's passes (VK3 L6b, web/venus-gpu.ts `depthByShader`):
  into a texture a draw over the region writes `frag_depth` from the buffer's words, out of one a compute pass loads
  the depth into them (D24 as a word's low 24 bits, Vulkan's X8_D24 layout; an image copy through a temporary buffer);
  stencil WebGPU won't copy (part of a subresource, an offset not 4-aligned) is read out through a whole subresource's
  copy and written by draws over the region, one zeroing it and one a bit (`stencilByDraws`: each discards the texels
  whose byte lacks its bit and replaces that bit), and depth16unorm's part the same way, its half words read by the
  draw (VK4 T10). Whole depth and stencil subresources take WebGPU's own copy where the textures have the copy usages and
  every aspect is copied. A copy between depth or stencil and a colour image of the texels' size (maintenance8:
D32_SFLOAT and R32_SFLOAT, X8_D24 and R32_UINT, S8_UINT and R8_UINT, ...) goes through a temporary buffer, the depth or
stencil side's copy as a buffer copy's above (`colorDepthStencil`, VK4 T24). `D16_UNORM_S8_UINT`, which WebGPU hasn't, is a depth24plus-stencil8 texture
whose depth is 16-bit unorm in buffers (`WG_FMT_D16`, the worker's `depth16`): into it the draw reads half words, out of it a
compute pass writes `round(depth · 65535)` as halves, so a texel uploaded comes back with its bits; what's drawn keeps
24 bits (32 on Metal) until it is copied out, and a depth bias's constant is scaled by 256 to D16's units (VK4 T30). A copy between size-compatible formats, which WebGPU's texture copies refuse, is the blocks'
  bytes through a temporary buffer (`copyBetweenFormats`: a compressed block is one texel of an uncompressed format, and
  no bytes change on the way). A multisampled copy is WebGPU's own of a whole subresource, else draws shaded per sample
  (`sample_index`) reading the source's same sample, stencil by a draw a bit (`copyMultisampled`; multisampled images
  are sampled for it, so they carry `TEXTURE_BINDING`); within one image through a temporary texture. A resolve is
  WebGPU's own of a whole level of one size, into a 2D texture, of a format it resolves (not the integer ones, the 32-bit
  floats or texture-formats-tier1's 16-bit normalized ones, which render and multisample but don't resolve); one into an
  `rgba8unorm` or `bgra8unorm` view of a texture of 6 layers or more, a pass's resolve target too, goes into a texture of
  the worker's and is copied into its layer (`shortResolve`, VK4 T39: SwiftShader's WebGPU leaves the level's last
  2 · width − 4 texels unwritten, which dEQP-VK's layered multisampled clears read as zeros or old bytes; Metal's is
  right; every adapter takes the copy); one through a view that is its texture's sRGB twin, the source's or the
  destination's, a pass's resolve target too, is drawn after it (`twinResolve`: SwiftShader's WebGPU averages an sRGB
  texture's samples through a UNORM view decoded, 0.5 coming out 55, which image.mutable's
  `*_draw_copy_resolve_mutable_{color,resolve}_att` twins met; every adapter draws them); else a draw over the region
  (`resolveByDraw`: the samples' average, or sample 0 of an integer format), for `vkCmdResolveImage` and for a render
  pass's attachment, which the pass's end resolves that way within its render area, stored whatever its store op, as
  depth's. A multisampled copy between formats moves bits, not values: twins through their linear views, packed
  layouts of one size by a swizzle, any other two layouts of a texel's size through a shader that takes the source's
  channels apart into bits and puts them together as the destination's (`bitsBetween` over `texelFields`: the plain
  formats, `rgb10a2`, a packed format by its key; VK4 T39 added the last two); SNORM layouts aren't taken apart, and
  such a copy is skipped with a warning, since one invalid command invalidates the whole submit. A fragment stage writing depth
  into a pass without a depth aspect (Vulkan drops the write, WebGPU refuses the pipeline) gets a module without that
  output, or, if it was the stage's only one, with it at a location no target takes (`fragment_without_depth`). Barriers and events wait for nothing (WebGPU orders
  a queue). The worker's imports catch what WebGPU's API throws (a warning, the command dropped): an exception through
  the module would leave its state half updated.
- **Samplers in the shader** (VK4 T8; `wgsl_sampler.c`, `pair_key` in wg_cmd.c): a Vulkan sampler says more than
  WebGPU's, and only the bound sampler knows it, while the shader was compiled long before. The stage that samples keeps
  its lowered NIR, serialized (`wg_stage_nir`, in caches too: `stage_nir_keep`), and `wgsl_print` starts by lowering
  sampling (`wgsl_lower_samplers`) against a list of keys (`wgsl_sampler_key`), one per (texture, sampler) pair WebGPU's
  sampler can't serve: its address modes, filters, unnormalized flag, compare op, bias, LOD clamps, the view's levels
  and the border as the shader reads it. A stage's own module has no keys, so a program whose samplers WebGPU can
  express costs nothing: its module is what it was. `program_for` makes the pairs' keys at each draw and dispatch, and
  any key gives the program a variant (`wg_program_variant`, by mask and keys), whose stages print again from their NIR;
  a stage no key touches keeps its module. In the shader:
  - **Integer textures** (WGSL samples them with no sampler at all) are fetched: the texel the coordinate falls in, its
    level from Vulkan's LOD (λ from the coordinate's derivatives in a fragment stage, the sampler's bias, its clamps,
    Vulkan's nearest within the view's levels), each axis wrapped by Vulkan's address operation, the border where one
    is out. With no key that is clamp-to-edge over the whole view (a key is made where the sampler says more); their
    samplers aren't bindings, so the program lists them apart (`int_pairs`). An integer **cube** binds its faces as a 2D
    array (`faces` on the view, the size and level queries rewritten with it): its face and place come from Vulkan's
    table, its λ from derivatives of the place on the face this invocation is on, which seams don't disturb. A
    **gather** of an integer texture is WGSL's own, through a non-filtering sampler; a cube's that is also sampled
    comes from its faces' fetches, as below.
  - **Border colours**: the sampler's clamp-to-edge sample, blended towards the border by how much of the filter's
    footprint fell past the edge (per axis, nearest in or out, linear `clamp(u + 0.5)`·`clamp(size - u + 0.5)` in
    texels), which is exact: past the edge a linear filter reads the edge texel and the border, and clamp-to-edge has
    the former. A view of several levels picks them here (each has its size), so anisotropy doesn't survive; a shadow
    sample of one level stays WebGPU's, blended by its weights, the border compared with its reference. The border as the
    shader reads it is Vulkan's colour with what the format lacks replaced (`sampler_border`, dEQP's read), through
    the view's mapping, since the shader blends past the view's swizzle. A cube has no border (Vulkan ignores its
    address modes). A gather that needs one goes through four fetches.
  - **Mirror-once**: the coordinate clamped to one reflection on the sampler's mirror-repeat, the op given the
    coordinate's own derivatives (`textureSampleGrad`) so the clamp doesn't move the LOD. `samplerMirrorClampToEdge`
    and `VK_KHR_sampler_mirror_clamp_to_edge` are advertised.
  - **Unnormalized coordinates**: divided by the view's size (Vulkan allows them only at one level, clamped).
  - **The sampler's LOD bias**: a shader bias, added to an explicit LOD, or the derivatives scaled by 2^bias.
    `maxSamplerLodBias` is 15, which bounds the sampler's and the shader's together where the shader works out the LOD.
  - **Shadow samples past level 0** (VK4 T9): WGSL's compare has an implicit LOD or level 0, so a bias, an explicit LOD
    or gradients on a view of several levels go through the fetches below, each texel compared and the results
    filtered, as Vulkan does, the reference clamped for fixed-point formats (`clamp_dref`). Their pairs ask for a key
    where the sampler wouldn't (`wgsl_info.key_pairs`, `WGSL_KEY_LEVELS`). A view of one level, the usual shadow map,
    and a constant LOD of 0 stay WGSL's and make no variant. A shadow cube of several levels with a key is bound as its
    faces (`key.faces`, every op on it fetched, a gather too: below). A key on a multi-level shadow sample takes
    this path too: borders, mirror-once and bias all come with it. Every pair of a cube bound so has a key of its own, its
    sampler's, and a stage that only asks its size or levels is printed against the keys too (VK4 R5).
  - **A depth texture also sampled without a comparison** (VK4 R5): WGSL declares a binding one way, and on
    `texture_depth_*` has no bias and no gradients, and WebGPU takes no filtering sampler with it. So a stage's plain
    samples of a texture it compares go through the fetches below, as their own sampler says (`WGSL_KEY_ALWAYS`; a cube's
    bound as its faces, `WGSL_KEY_FACES`; a gather of one stays WGSL's, the sampler non-filtering). What any stage of a
    pipeline compares is depth in all of them (`wgsl_print_options.depths`).
  - **A sampler shared by an integer or depth texture and a float one** (VK4 R5): the former want it non-filtering, so the
    program's variants split it as they do for unfilterable textures (`wg_program_mixed`, the twin at the binding
    before): the float textures keep their filters.
  - **A cube bound as its faces, gathered** (VK4 T42: a shadow cube past level 0, a non-seamless or reduced sampler's, a
    padded image, an integer cube also sampled; each refused before): the footprint's four texels at the view's first
    level from the faces' fetches (`cube_gather_fetch`), a neighbour past an edge on the next face, by its own pair's key
    (compared for a shadow gather). **A seamless cube's corner**, where a linear footprint's or a gather's texel is past
    both of its face's edges and no face has it, is the other three texels' average (OpenGL's recommendation, which
    Vulkan leaves to the implementation, and llvmpipe's; fetched, it was one face's texel), in every sample from the
    faces' fetches; an integer's keeps the face's texel.
  - **A depth view's linear filter without a comparison** (VK4 T42): WebGPU filters depth only by comparing, so such a
    pair's key is `fetched` (`pair_key`), the binding takes the sampler's nearest twin and the sample comes from the
    fetches below (a cube's of its faces); depth formats report `SAMPLED_IMAGE_FILTER_LINEAR` for it. A gather stays
    WebGPU's. Its cost against WebGPU's own sample is a reduction's (above: ~3.5× on the pair alone), unmeasured in a
    program.
  - **A variant that can't be printed** (VK4 R5): its draws and dispatches are dropped, said once (`draw_refused`), not
    drawn with a module that doesn't match its layout.
  - **`textureQueryLod`** (VK4 T9): λ from the coordinate's derivatives and the view's size, x the level or levels the
    sampler's mode reads after its clamps, y the LOD before them (dEQP's reading). WGSL has no query, so such a pair
    always takes a key (`WGSL_KEY_ALWAYS`), its sampler known by no binding. The coordinate has no layer (SPIR-V's).
    Anisotropy's lengthening of the footprint isn't kept.
  - **Offsets past a mirror-once reflection** (VK4 T9): in texels of the level before the wrap, so such a sample goes
    through the fetches.
  - **Offsets that aren't constants** (VK4 T24, maintenance8's `Offset` operand; WGSL takes const-expressions only):
    every float sample, gather and shadow sample with one comes from the fetches, the offset in texels of each level
    read (`dynamic_offset`); a fetch adds it. They always want a key (`WGSL_KEY_ALWAYS`); without one a shadow sample
    compares LESS_OR_EQUAL rather than NEVER, so the stage's own module, whose bindings make the program's layout, keeps
    its texture (a NEVER one folded it away: the layout lacked the group its variants bind). An integer gather with
    one takes them too. The fetches' cost, against WGSL's own sample, is unmeasured: no program replayed here has one.
  - **Min/max reductions** (VK4 T25, `VK_EXT_sampler_filter_minmax`, core 1.2's `samplerFilterMinmax`): WebGPU's
    samplers only average, so a sampler with a MIN or MAX reduction and a linear filter (a nearest one reads its texel
    whatever the reduction: no key) gives its pairs a key (`reduction`), and every sample through it comes from the
    fetches below, which take the component-wise min or max of the footprint's texels with non-zero weights (a texel of
    no weight is the type's extreme, finite) within a level, and of the two levels a linear mipmap reads where the second
    has any (`reduce`). Integer textures too, with integer min and max: Vulkan's linear filter of one is a reduction's
    only, and the format's `FILTER_MINMAX` bit doesn't ask for `FILTER_LINEAR`. A cube's are fetched from its faces (the
    key's `faces`; every sampled cube view has the 2D array twin for it); a gather is WebGPU's (a reduction filters, a
    gather doesn't). Every format sampled has `SAMPLED_IMAGE_FILTER_MINMAX`, depth (`filterMinmaxSingleComponentFormats`)
    and integers among them; `filterMinmaxImageComponentMapping` is the browser's `texture-component-swizzle`, which the
    fetches see. The cost, against WebGPU's own linear-mipmapped sample (8 fetches and the LOD's arithmetic for one):
    3.5× on the M4, 3.2× on SwiftShader, on that pair alone (bench/vulkan/REPORT.md "VK4 T25").
  - **Non-seamless cubes** (VK4 T28, `VK_EXT_non_seamless_cube_map`): a sampler with the flag and a linear filter keys
    its cubes' pairs (`non_seamless`, the cube bound as its faces), and their samples come from the fetches, each texel
    on the sample's face, wrapped by the sampler's U and V (the border's colour too); a nearest filter never leaves
    the face (WebGPU's sample). A comparison through such a sampler is the fetches' too, each texel compared, then
    filtered (VK4 T38: seamless before, unseen while depth formats reported no comparison); a gather of such a cube
    comes from its faces' fetches (VK4 T42), each texel on the face, wrapped.
  - Key LODs are clamped to ±1,000 at the sampler: `VK_LOD_CLAMP_NONE` and programs' infinities are indeterminate in
    WGSL's `min` and `max` (a `maxLod` of `inf` read the last level).
  - **Compressed images that aren't whole blocks** (VK4 T18): WebGPU wants a compressed texture's first level in whole
    blocks, so such an image is a corner of a larger texture (13×13 of ASTC 8×5 in 16×20), whose levels aren't even in
    proportion to the image's (level 1 is 6 of 8), and padding lies past its edges: no scaled coordinate would serve. A
    view of one is `padded`, which gives every pair a key with the view's size: the shader does Vulkan's LOD and
    the whole filter itself (`padded_sample`: 4 fetches for each level a linear filter reads, 8 in 3D, wrapped by the
    address modes at the image's size), so such an image alone pays, and loses anisotropy. Size and level queries
    answer the image's, a key with no sampler (`WGSL_NO_SAMPLER`) for a texture a stage only asks. A cube of one is bound
    as its faces (its texture needn't be square), a linear filter past a face's edge finding the neighbour by the texel's
    centre as a direction; the variant's layout says `2d-array`. A size is part of the key, so each size of such image
    a program samples is a variant. `texture-compression-unaligned` would do without all this, but Chromium offers it
    only behind `--enable-unsafe-webgpu`: tests would pass on it and users wouldn't.
  **A 2D array view bound where the shader declares a 2D texture** (Vulkan wants the view's type to be the shader's;
  Godot binds its 2D array default texture, one layer, to SDFGI's 2D samplers, and in the GI demo an 8-layer view,
  which native drivers read as the view's base layer) is bound by a 2D view of its base layer (`wg_image_view.flat`,
  made with every sampled such view; driver tests 85 and, GD G7, 90 with two layers). Likewise bound as a storage image
  the stage declares 2D, or reads as a texture: `flat_storage`, one level in the view's format (VK4 T37, driver test 102).
  **Component swizzles** are WebGPU's (`texture-component-swizzle`): such a view has a twin with the mapping (`sampled`,
  allowed only on a view that's just sampled), which sampled bindings take. Without the feature they are ignored and
  said once: it is in Chromium on every backend, and a fallback in the shader would need texel fetches too.
- **Storage images a stage only reads** (GD G4; `texture_images` in wgsl_print.c): a storage image a stage only loads
  and asks the size of (no store, no atomic, not multisampled) can be a texture in that stage (`texture_2d<u32>` and so
  on, its sample type the type its loads return, a float one `unfilterable-float`), read by `textureLoad` at the view's
  first level. It is one where it must be (loaded without a format: Godot reads such images; or of a format with no
  storage texture) and where the stage's storage textures would pass WebGPU's for the stage (8 at most, 4 by default,
  `wgsl_print_options.max_storage_textures`; Godot's SDFGI stages bind 15 storage images, 12 only read): those it only
  reads, in order, until the rest fit. Not before: textures have a limit of their own (16), which a stage sampling 16
  would pass. One only asked its size without a format stays a storage image (its sample type unknown; the view's since G5, below). The
  resource says so (`image_texture`); the driver binds the storage image's view as for a storage binding (a cube's faces
  as a 2D array, `wg_image_view.storage`), the image's texture made with `TEXTURE_BINDING` beside `STORAGE_BINDING`
  wherever its format samples, and the scope's scan counts it as a read. A pipeline whose stages disagree on its kind or
  sample type is refused, as one whose stages' storage access differed was before.
- **Storage images without a format** (GD G5; `image_format` in wgsl_print.c, `program_keys` in wg_cmd.c):
  `shaderStorageImageReadWithoutFormat` and `shaderStorageImageWriteWithoutFormat` are offered, with their format
  features (`VK_FORMAT_FEATURE_2_STORAGE_*_WITHOUT_FORMAT_BIT`) wherever there is storage. A storage image declared
  without a format that a stage only loads is a texture (above: its loads' type is its sample type). One it writes or
  only asks the size of is the bound view's: the stage's own module takes `r32uint` (`formatless` on the resource),
  and every draw and dispatch takes a variant keyed by the view's format (a `wgsl_sampler_key` with `WGSL_IMAGE_KEY`,
  the image's index and the format), printed from the stage's kept NIR as if declared with it, a storage texture or
  words as a declared format would be (`wg_program_variant` gives the variant's layout the same, words' parameters in
  the group's table). Godot's post-processing writes such an image; vkd3d's UAV clears do too. One declared with a
  format bound to a view of another takes the view's the same way, written (GD G7) or read (VK4 T37: dEQP-VK's
  `image.mismatched_formats`; WebGPU refused the bind group, the submit lost).
- **Storage images as words** (VK4 T7, T11; `image_words` and `declare_word_images` in wgsl_print.c, `image_use` in
  wg_cmd.c). WGSL has no atomics on textures, and WebGPU's storage textures come one way for most formats: read-only and
  write-only in core or with `texture-formats-tier1`, read-write only for r32's and, with tier2, tier2's list; no format at all
  of tier1's without it. So a storage image a stage reaches by an atomic, or by an access its format has no texture for
  (`wgsl_image_as_words`: a load and a store in one stage, any access of a tier1 format without tier1, or any store of a
  format WebGPU has no storage texture of in any tier, `wgsl_image_words_only`: four-channel 8-bit sRGB, encoded and
  decoded in the shader by Vulkan's transfer functions, and the packed 16-bit normalized formats, VK4 T38), is in that
  stage its view's words: a storage buffer at its binding and the view's parameters (`view_words`: size, words
  between rows and slices) in its group's parameter table (above, "Texel buffers"), every load, store and size of that binding going through them
  (`wg_im_*`; a texel past the view is left alone and reads 0). A view past `maxStorageBufferBindingSize` binds that
  much, and its draws and dispatches are refused, said once (`words_past`, VK4 T37: an invalid bind group lost the
  submit). The buffer holds the texels as Vulkan lays them out, and
  the format's encoding is printed from its `util_format_description`: normalized values clamped and rounded, integers cut
  to the channel, 16-bit and packed floats by hand from their bits (WGSL's `pack2x16float` is indeterminate past its range;
  a NaN keeps being a NaN). It is `array<atomic<u32>>` where the stage writes it: a texel under a word shares it with other
  invocations' texels, so such a store is an `atomicAnd` and an `atomicOr`, as a 16-bit store to a storage buffer is; a texel of
  several words isn't atomic, nor need it be. A stage that only reads it (a tier1 format without tier1) binds it read-only,
  plain `u32`s, which a vertex stage can too.
  The buffer is the image's own (`wg_image_words`, made at the first such binding: every level and layer, rows 256-aligned
  as WebGPU's copies want them) and one more place `wg_image.valid` tracks, alongside the alias textures (below): the scan
  of a scope's descriptors copies a subresource from its texture before a word binding uses it, and a later use elsewhere
  copies it back, in the encoder's order, so a program whose images stay words pays one copy. An image of a format that
  can go by words (`wg_storage_words`) with storage usage is tracked from its making (a mutable image from such a view),
  and has the copy usages; with tier2, tier2's formats aren't, and r32float never is. A shared image's words go back to its
  texture at each submit's end, what the other renderer reads (`shared_words`; no test of its own: nothing in the tests
  reads such a texture without going through the replay). Tier1's formats are offered for storage on every adapter
  (`WG_FMT_STORAGE`; `WG_FMT_STORAGE_TEXTURE` is what WebGPU binds), which is also how SwiftShader, without tier1, runs
  every encoding in dEQP-VK. Only R32 takes atomics (`wg_atomic_format`, what Vulkan requires; no float or 64-bit atomics);
  optimal tiling, no sparse images, no planes of multi-planar images. A pipeline with an image as words in one stage and
  a texture in another is refused. Within one scope a binding of the words and a binding of the texture don't see each other's
  writes (as T4's views). libplacebo's compute path on `rg16f`: `bench/vulkan/t11-rw.hook`, bench/vulkan/REPORT.md "VK4 T11".
- **Inline uniform blocks** (VK4 T7, `wg_descriptor.c`): the binding is one slot, a uniform buffer to the translator and
  to `fold_uniforms`. A set with blocks has their bytes (`inline_data`) and a buffer of its own, each block 256-aligned;
  writes, template updates and copies go into both at once (`gpu_write`, the queue's order: Vulkan forbids updating a set
  a pending command buffer uses), rolling on into the next binding past a block's end. 1.3's minimums of four blocks a
  stage and a set, 4,096 bytes each, no update-after-bind (`wg_bindings_fit` counts each as a uniform buffer). The buffer
  has 64 KiB past the blocks: a binding is widened to the block its shader declares, as a memory's is.
- **Attachments of different sizes** (VK4 R3; `wg_view_crop` in wg_device.c, `crop_copies` in wg_cmd.c): WebGPU wants a
  pass's attachments of one size, Vulkan only that the render area fits each. The pass takes the smallest width and
  height, and an attachment larger than that is drawn in a texture of that size, copied from it before the pass and back
  after (its resolves drawn, from the image). A draw reading such an attachment as an input attachment reads what it held
  before the pass.
- **Layered passes** (VK4 T12; `OP_VIEWS`, `OP_CLEAR_LAYERS` in wg_cmd.c): a pass of several layers without multiview (a
  framebuffer's layers, dynamic rendering's `layerCount`) reaches its later layers by its load and store ops, by
  `vkCmdClearAttachments`, which names layers, and by draws whose vertex stage writes `gl_Layer`, so it replays a layer
  at a time as multiview does (up to `WG_MAX_LAYERS`, 32): the later layers see the clears whose range holds them and
  those draws alone (drawn through indices of their own too, `OP_PROVOKE`, by the first layer's tickets), with the
  occlusion queries around them (a later layer's count in a slot of the device's set, added to the first layer's);
  resolves cover every layer (`layer_mask`). A draw's places in the push buffer are reserved for each layer
  (`pass_replays`), and what a draw reads of the attachments (`dst_copies`' and `feedback_copies`' copies, an input
  attachment's view) is of the layer being replayed (the review of T41–T43). **`gl_Layer`** (VK4 T43:
  `shaderOutputLayer`, `VK_EXT_shader_viewport_index_layer`, one viewport so the index's writes go): the vertex stage's
  write is kept in `wg_lo`, and its entry point puts a vertex whose layer isn't the pipeline's (`wg_layer`, an override:
  the key's `view`, a pipeline per layer as per view) outside the clip volume (x = 2w), so each layer's draw keeps that
  layer's primitives; a fragment stage reads `gl_Layer` as `wg_layer`. In the later layers an indirect draw that needs
  what only the first layer's pass prepares (a count's or a fan's tickets, draw parameters' places) isn't drawn (said
  once), nor is a storing vertex stage's (its pre-pass ignores `gl_Layer`: docs/backlog.md "Rendering").
- **Feedback loops** (VK4 T12; `feedback_copies` in wg_cmd.c): Vulkan lets an input attachment read an attachment of its
  own pass, and WebGPU refuses a texture written and sampled in one pass. Where a pass's attachment can be an input
  attachment (`OP_PASS_ATTS`, none otherwise: ordinary passes pay nothing), a draw reading one reads a copy (the input view's
  `twin`, same format and samples, made at the first such read; its bind group the scope's own). The copy is made in a
  cut of the WebGPU pass (`begin_pass`'s `keep`: 1 the parts store whatever the store op, 2 later parts load) at the
  pass's first such draw and after a barrier or clear inside it (`OP_PASS_READ`; without one, reading what the pass
  wrote is undefined), through `gpu_copy_tt`, so multisampled and depth images take their usual paths. An occlusion
  query carries on across a cut as across a clear. **Sampled** (VK4 T32, `VK_EXT_attachment_feedback_loop_layout` and
  its dynamic state, which needs nothing: WebGPU's pipelines hold no such state): an image with
  `VK_IMAGE_USAGE_ATTACHMENT_FEEDBACK_LOOP_BIT_EXT` is an attachment a draw may sample, through any view of it whose
  levels and layers cover the attachment's (`feedback_att`). Such a draw samples the view's `loop`
  (`wg_view_loop` in wg_device.c): the same view made by the same code over a copy of the image's texture
  (`wg_image.loop_tex`, the image's shape, sampled and copied into), so its type, swizzle, faces and flat views are the
  view's; at the same points as the input attachments' copies, every level and layer of the view's range is copied
  into it, past the attachment's too. Not a view of another texture (an alias, RGB9E5's words). Layouts are nothing
  to WebGPU, so `GENERAL` would do as well, but `VK_KHR_unified_image_layouts` isn't in the tests' guest's Venus (Mesa
  26.2), and the stencil cases want stencil export, which WebGPU lacks.
- **Reading the attachments** (VK4 T32; `fragment_dst` in wg_shader.c, `dst_copies` in wg_cmd.c): the depth bounds test
  (`depthBounds`), logic ops (`logicOp`) and advanced blends (`VK_EXT_blend_operation_advanced`) read what the attachment
  holds, which WebGPU's pipelines can't. A draw whose key has them (`depth_bounds`, `logic_op`, `adv`: the dynamic state's)
  reads a copy of each attachment it needs (its twin, as `feedback_copies`'), made in a cut of the WebGPU pass before
  **every** such draw, since these see each earlier draw's writes; a pass with one is begun storing (`pass_reads_dst`).
  The copies are a bind group of their own (`wg_dst`: binding i colour attachment i, 8 depth), the first group free past
  the program's and the pull's (none free: the draw is refused, said once). The fragment stage is printed for the key:
  its `main` becomes `wg_fs`, and a new `main` tests the attachment's depth against the bounds (discarding), calls it,
  and makes each output the logic op's or the blend's of it and the attachment's texel (`dst_text`); WebGPU's blend is off
  on those targets. Depth bounds without a fragment shader take a stage of the test alone; a range of [0, 1] on a fixed-point
  format can't fail and reads nothing. Logic ops work on the format's bits (normalized channels converted to and from
  them, widths from the Vulkan format, so a packed format's 5 bits are 5) and turn blending off on every attachment, sRGB
  and float ones written as they are. Advanced blends follow the extension's equations (dEQP-VK's reference: a
  destination not premultiplied gets the result divided by its alpha), every op, overlap and premultiplication, each
  attachment its own (`advancedBlendMaxColorAttachments` 8, independent); not coherent, though they are between draws:
  overlapping primitives of one draw read what was there before the draw, for all three. Mesa's runtime drops a
  pipeline's advanced state unless coherent blends are enabled, so the device enables that flag without advertising it
  (wg_device.c). A copy costs a pass cut and a texture copy: ~0.1 ms a draw on the M4, at 256² and 1080p alike
  (bench/vulkan/REPORT.md "VK4 T32").
- **Colour attachment locations** (VK4 T32; `VK_KHR_dynamic_rendering_local_read`; `mapped_text` in wg_shader.c): a pass's
  draws may send output L to attachment i (`vkCmdSetRenderingAttachmentLocationsKHR`, Mesa's `cal`, reset to the identity
  at each vkCmdBeginRendering); WebGPU's target i is @location(i), so the key holds the map and the stage is printed with
  its outputs moved (an output no attachment takes goes to a private variable). Input attachments read through their
  descriptors as before (`feedback_copies`), so the input attachment map isn't read; a barrier inside the pass renews
  their copies. Dual-source outputs aren't moved: a map that moves them refuses the draw (WebGPU's dual-source blending
  takes one target, so only a single attachment at no location gets there).
- **Multisampled rendering to single-sampled attachments** (VK4 T32; `VK_EXT_multisampled_render_to_single_sampled`,
  `ms_attachment` in wg_cmd.c, `wg_view_ms` in wg_device.c): a pass (dynamic rendering's
  `VkMultisampledRenderToSingleSampledInfoEXT`; a subpass's comes to it through the runtime) renders each
  single-sampled attachment in a multisampled image of the view's format and level's size (4 samples, WebGPU's one
  count; made at the first such pass, kept with the view), the rendering info rewritten so the attachment resolves into
  the view: colour by WebGPU's resolve target (average, or sample zero for integers, as the runtime sets), depth and
  stencil by the drawn resolves with the pass's modes (sample zero where it gives none). A LOAD fills every sample with
  the attachment's texel first (the worker's `copyMultisampled` from a single-sampled source: a draw a sample), not on a
  resumed part; the multisampled image is stored, so a suspended pass's parts carry it. One layer, no 3D slices; the
  resolve performance query says optimal.
- **Multisampled arrays** (VK4 T12; `MsLayers` in web/venus-gpu.ts): WebGPU's multisampled textures have one layer, so the
  worker makes a texture a layer behind one object, which the driver sees as one texture; every path takes a layer at a
  time (views, `texCopy`), so passes, resolves, clears and copies work as they do for any array. A view of several
  layers shows its first: WGSL has no multisampled arrays to sample, so a shader's `sampler2DMSArray` is that layer, its
  texel fetches and size of it (one layer; VK4 T47: Tint refused such a stage).
  Formats WebGPU doesn't multisample stay out, also as a view's format where a format list says so (one sample then).
- **Packed formats** (VK4 T12, T30; `WG_FMT_PACKED`, `packPass` in web/venus-gpu.ts): `R5G6B5`, `A1R5G5B5` and `B4G4R4A4`,
  which Vulkan requires, and their four orders, 1.3's `A4R4G4B4` and `A4B4G4R4` (`VK_EXT_4444_formats`) and
  maintenance5's `A1B5G5R5` are `rgba8unorm` textures; `R4G4` is `rg8unorm`, `A2R10G10B10`'s UNORM and UINT are
  `rgb10a2unorm` and `rgb10a2uint` (WebGPU's order is A2B10G10R10's); optimal tiling only. A texture holds the format's
  channels, so sampling, rendering and blending need nothing; buffer ↔ image copies are the format's own texels (1, 2
  or 4 bytes: the `packed` key's ninth number) and the worker moves each channel's bits between the two layouts in a
  compute pass in the encoder's order, through a temporary buffer, scaled where their widths differ; copies with a
  size-compatible format (`r16_uint`, `r8g8_unorm`, `r8_unorm`, `r32_uint`) keep their bits the same way. So a 16-bit
  format holds 8 bits a channel: sampling what was rendered reads it unrounded (4 `self_dep` cases of `r5g6b5` out of
  the list) and blends run at 8 bits. Formats without alpha (`WG_FMT_OPAQUE`) keep it 1: masked in the pipeline, 1 in
  clears, a swizzle on reads. A view of another format of the texel's size is a texture of that format copied the same
  way (`image_alias`); a multisampled copy between a packed format and another moves the bits by a draw ("Commands",
  `bitsBetween`; a 10-bit SNORM order's is skipped). Mesa has no pipe format of `R4G4`: its key and border are written out.
  **Formats WebGPU has no texture of** (VK4 T31) are packed formats the same way, in a wider texture: the three-channel
  ones (`R8G8B8` and `B8G8R8` of every type in `rgba8*`, `R16G16B16` in `rgba16*`, `R32G32B32` in `rgba32*`; alpha kept 1,
  `WG_FMT_OPAQUE`), BGRA's integer and snorm orders (`rgba8uint`, `rgba8sint`, `rgba8snorm`), `R8_SRGB` and `R8G8_SRGB` in
  `rgba8unorm-srgb`, the 10-bit SINT orders in `rgba16sint`, and (VK4 T38) the 10-bit SNORM orders in `rgba16float`
  (every adapter renders, blends and filters it, where `rgba16snorm` needs tier1 and doesn't filter; a 10-bit value is
  within an eighth of a step there and comes back with its bits, the most negative code as -1 − 2⁻¹⁰; clears clamped to
  [-1, 1], `wg_clear_color`; what's rendered is kept unclamped until copied out; what a shader reads of such a view is
  clamped to [-1, 1], a variant's key, `WGSL_SNORM_KEY`: its fetches before the shader's filter, WebGPU's filtered
  samples after). `R32G32B32_SFLOAT` isn't offered as a colour attachment (`WG_FMT_NO_ATTACHMENT`): Vulkan wants a colour attachment format at `framebufferColorSampleCounts`, and WebGPU multisamples no `rgba32float`; its texture is drawn to by the worker's clears and blits all the same. The scaled formats are their integer twins' textures
  (`rgba8uint`, `rgb10a2uint`, `rg16sint`…, packed where the order or the channels differ) and offer **transfers only**:
  the spec samples them as floats and clears them with `float32`, dEQP-VK samples them through integer samplers and
  clears them with integers (its reference treats them as UINT and SINT), so no sampling is offered, and a clear takes
  the integers, dEQP's way (no program clears one). The key's last four numbers are each channel's kind (unorm, snorm,
  unsigned or signed integer, float), and `packPass` (an invocation a texel, texels of up to 16 bytes at any byte,
  channels straddling words; a pass a slab of slices or rows whose bindings fit `maxStorageBufferBindingSize`, VK4
  T37) converts between the two: unorm widths scaled, signed integers extended, integers and normalized values to and
  from floats where the kinds differ. What a format lacks of its texture's channels (`wg_format_lacks`: R8_SRGB's G and
  B, an RGB format's alpha) is kept 0, alpha 1: filled by the copies, set by clears (`wg_clear_color`), masked out of
  pipelines' writes, and read so through the view's swizzle. A view of another format is an alias as above (`R8_SRGB`
  and `R8_UNORM` aren't twins: their textures differ). Linear tiling isn't offered, storage only of the 16-bit packed
  ones (by words, "Storage images as words"); RGB16's unorm and
  snorm only with `texture-formats-tier1`. A copy costs the compute pass and a copy through a temporary buffer
  (bench/vulkan/REPORT.md "VK4 T31").
- **Formats a texture holds otherwise** (VK4 T38; `WG_FMT_ALPHA8`): `A8_UNORM` (maintenance5) is an `r8unorm` texture
  whose red holds alpha, offered with `texture-component-swizzle`: sampled through its view's swizzle (the colour 0, alpha
  red: composed with the view's mapping), cleared with alpha in red (`wg_clear_color`), written as an attachment by the
  fragment stage moving its output's alpha to red (`override wg_ar`, the pipeline's bits of its A8 targets; every
  stage with float outputs declares it) under the alpha bit of its write mask. Not blended (WebGPU's red would blend by
  the colour factors, `DST_ALPHA` reading 1), blitted (the worker's blit draws know no swizzle) nor storage; its twin
  view (an attachment sampled in its own pass) swizzled the same way. Copies are its bytes. **Depth comparison**: every depth
  format WebGPU samples reports `SAMPLED_IMAGE_DEPTH_COMPARISON` in `VkFormatProperties3` (a comparison sampler on a
  depth texture); colour formats don't (a comparison of one would be the shader's).
- **Integer outputs past their attachment's range** (VK4 T48): an integer output is clamped to its attachment format's
  range, as Direct3D has it (Vulkan leaves such a write undefined; SwiftShader stores 0xffffffff into `rgba8uint` as 0,
  which vkd3d's `test_output_merger_logic_op` met): every stage with integer outputs declares `override wg_ic`, two
  bits an attachment for its range (8 bits, 16, or 10-10-10-2; signed ones from one below their negated top), which the
  pipeline sets only for its targets narrower than 32 bits (0 leaves the outputs alone). Before a logic op, which reads
  the clamped value.
- **Multiview** (VK4 T7; `begin_rendering` and `OP_VIEWS` in wg_cmd.c): WebGPU has no layered rendering, so a pass with a
  view mask (dynamic rendering's `viewMask`; legacy passes through the runtime's emulation, secondaries through their
  inheritance) is replayed once a view: `OP_PASS` holds each view's JSON one after another, each attachment that view's
  layer (`wg_view_att`, a 3D image's slice as `depthSlice`), and `OP_PASS_END` jumps back to it. A pass's commands hold all
  they need since `forget`, so each view repeats them whole (load ops, clears, prepasses, draws); the push buffer is
  counted for it (`cmd->draws`). A stage that reads `gl_ViewIndex` declares `override wg_view`, the key's `view`: a pipeline
  per view, only for such stages. A query is one a view, consecutive, as Vulkan allows (`q->first + view_order`). An input
  attachment binds its view's layer, 2D as declared, in a group per view. Eight views. Multisampled multiview passes
  go by "Multisampled arrays"; dEQP-VK's 48 ask for `r32g32b32a32_sfloat`, which WebGPU doesn't multisample.
- **Device addresses** (VK4 T7, T41; `address_place` in wg_device.c, `lower_global` in wgsl_nir.c): WGSL has no pointers,
  and a stage could reach more memories than WebGPU binds, so memory allocated with `VK_MEMORY_ALLOCATE_DEVICE_ADDRESS_BIT`
  is in the device's address buffer (`util_vma_heap`, each memory 256-aligned with 64 KiB past it for widened uniform
  blocks; `wg_device_memory.gpu_at`, and `wg_buffer.offset` is GPU-relative while `mem_offset` is the CPU's), and an
  address is a byte of it, 0 never. A memory is placed there when its GPUBuffer is made (`wg_memory_buffer`: its first
  buffer's bind, or a linear image's use), so memory only images use takes no room (VMA and DXVK give every allocation
  the flag; Godot's GI demo's editor grew the buffer to 512 MiB, mostly images', which SwiftShader refused: GD G8). It
  can't move there later, as commands name its GPUBuffer and offsets: a memory with no room left, or past a region, has
  buffers whose address is 0 (said once), and is had all the same. The address buffer is **regions**, an address's high
  word (`wg_address_regions`: as many as reach 1 GiB together at one storage binding's reach, at most 4: one on the M4,
  NVIDIA and SwiftShader, four of 128 MiB on an adapter of WebGPU's least; at three regions SwiftShader's compiles of
  dEQP-VK's deepest pointer stages ran past its 30 s watchdog; those past the first come out of
  `maxPerStageDescriptorStorageBuffers`, as each is a storage binding in a stage reading pointers, which keeps Vulkan's
  least 4: three regions at WebGPU's least 8 storage bindings a stage), each a GPUBuffer at a binding of group 3 (region 0 at 996, then 990 up:
  wgsl.h `wgsl_address_binding`, a set's slots under 990) that starts at 64 KiB and grows in place (`gpu_grow`: a new
  buffer under the same id, in the queue's order, so recorded commands stay right and only bind groups are made again,
  `address_gen`), doubling from 64 MiB, up to `maxStorageBufferBindingSize`; the regions' places are one heap, each
  region's end to the next's start held. SPIR-V's pointers are two 32-bit words (`nir_address_format_2x32bit_global`: no
  64-bit integers, so they keep their 8 bytes in memory), and a global access is a storage buffer's at the low word, of
  the region's binding: with more than one region an `if` tree on the high word, the last taking what's past them (the
  stage's hash keys the count). So 16-bit accesses and atomics work as they do. What a shader writes through pointers is
  read back from every host-visible memory of that region. Usage scopes see each region's binding as its whole buffer:
  other reads of address memory go to shadows when the pointers write. A storage buffer of address memory in a draw or
  dispatch with its region's pointers' binding (writable, or read beside pointers that write) is read and written
  through that binding (`address_shares` in wg_cmd.c, a `wg_share` of `WG_SHARE_ADDRESS`: its place and length in its
  group's parameter table, so one variant serves every place), where WebGPU's aliasing rule refuses the two bindings:
  each sees what the other wrote. Its index is held to its length (`min(i, length − 1)`), as WebGPU's robustness held it
  to its own binding's, so a store past it stays in it (robustBufferAccess). Where it can't be (a dynamic one, atomics that differ, pointers a vertex stage sees
  read-only, a descriptor in another draw of the pass) it goes to a shadow copied back at the scope's end (bytes reached
  both ways in one scope don't see each other, and the copy back undoes what pointers wrote in its range). A pointer converted to and from a 64-bit integer (`OpConvertUToPtr`, since `shaderInt64`:
  VK4 T29) is its two words packed. **Capture and replay** (`bufferDeviceAddressCaptureReplay`): a memory allocated with
  `VK_MEMORY_ALLOCATE_DEVICE_ADDRESS_CAPTURE_REPLAY_BIT` is placed at its allocation, at its
  `VkMemoryOpaqueCaptureAddressAllocateInfo` address if it has one (`VK_ERROR_INVALID_OPAQUE_CAPTURE_ADDRESS` if that's
  taken), its address the opaque value; a buffer's is 0, its address being its memory's and its offset. Replays aren't
  kept apart from other allocations (that would place them at the top of a region, grown whole), so a replay whose other
  allocations come in another order than the capture's can find its places taken.
- **Views in another format** (VK4 T4): WebGPU's views differ only in sRGB-ness, and Vulkan's mutable images take any
  format of their class. A view it refuses is of a texture of that format (`image_alias`, at the first such view, the
  image's size and levels; a plane's too; and a storage view of an sRGB image's linear twin, sRGB having no storage).
  `wg_image.valid` says, for each plane, level and layer, which textures hold its bytes; the replay keeps it in
  queue order, and copies a subresource between textures, bytes for bytes, where it is used in one that doesn't hold
  it (`image_use`, through the copy between formats). Transfers and attachments say what they use by `OP_IMAGE_USE`
  (an attachment's old bytes aren't copied if the pass can't read them); descriptors are found by the scope's scan
  (`scope_images`: a render pass's before it begins, each dispatch's, read first, then what's written held alone).
  Only images with such a view pay: `wg_device.aliased` skips the scan, an image without an alias has no `valid`. A
  packed format's view (16 bits a texel, in an rgba8unorm texture) of another 16-bit format's image, or the other way, is
  an alias too, copied through a buffer the worker packs and unpacks (`copyPacked`; GD G4: Godot's SDFGI writes an
  R16_UINT image and samples it as R4G4B4A4).
  **An E5B9G9R9 view of a 32-bit integer image** (VK4 T23; `wg_image_view.rgb9e5`) is the exception: Godot's SDFGI
  writes R32_UINT volumes and samples them as E5B9G9R9, and their copies were ~34 MB a frame (left out, the GI demo ran 12% faster on
  NVIDIA; decoded, about even on the M4: bench/vulkan/REPORT.md "VK4 T23"). Such a view (not a cube, not swizzled) is a view of the image's own texture in its own format,
  every pair through it keyed (`key.rgb9e5`, the texture's binding `uint` in the variant): the translator fetches its
  words and decodes them (`rgb9e5_decode`: each 9-bit mantissa times 2^(e − 24), alpha 1), the filter from the fetches
  as for a padded image ("Compressed images that aren't whole blocks"); its own fetches are decoded too. Nothing is
  copied. `?gpu=vkskip=rgb9e5` makes views made after it the old way (A/B).
  `VK_IMAGE_CREATE_EXTENDED_USAGE_BIT`'s usage comes from the formats its views can have (`wg_view_formats_features`), and a
  sampled image takes samples where its format renders. Not backed (docs/backlog.md "Views in another format's
  leftovers"): shared and linear images, a block-size change, a multisampled copy between formats, a view format
  WebGPU can't multisample, and within one render pass a write in one texture read in another.
- **What Vulkan requires and isn't offered** (VK4 R7; `api.info.*`): `R32G32_SFLOAT` and `R32G32B32A32_SFLOAT` multisampled
  (WebGPU multisamples neither, and they're mandatory attachments: docs/backlog.md "Sample counts Vulkan wants but WebGPU
  lacks"); `textureCompressionBC` needs `texture-component-swizzle` (BC1's RGB formats read alpha 1 through a view's swizzle)
  and `shaderStorageImageExtendedFormats` needs `texture-formats-tier1` (its list has the 16-bit normalized formats): each
  off without them. `maxMemoryAllocationSize` is the adapter's `maxBufferSize` (a memory that large has what room is left
  for its pad): under Vulkan 1.3's 1 GiB on an adapter of WebGPU's default 256 MiB, as nothing can back more. Multi-planar
  formats list copies for linear tiling, as dEQP asks, but the image query refuses a linear image of one.
- **Vertex bindings past WebGPU's** (VK4 R7): Vulkan's minimum is 16, WebGPU's vertex buffers commonly 8, so bindings 8 and
  up are always pulled, below, and never set as vertex buffers. Each takes a storage binding of the vertex stage: a draw
  past WebGPU's limit on those, or with no bind group left, is refused, said once (`wg_pipeline_pull_ok`).
- **Pulled vertices** (VK4 T5): WebGPU wants strides and bound offsets in multiples of 4 and an attribute's offset in
  multiples of its size up to 4, and Vulkan doesn't. A binding that breaks one (`wg_vertex_pull`, at each draw: the
  bound offset is part of the key, `vb[b].pull`), or with an attribute past its stride that no slot serves, or that a
  direct draw reads past its buffer's end (WebGPU checks a non-indexed draw's vertices and any draw's instances against
  the bound size and refuses the draw; Vulkan's robust buffer access reads in range or zeros: `cmd->reach`, VK4 T37), is
  read by the vertex stage from a read-only storage binding, its loads past the bound range 0. Its pipeline is the worker's variant of the stage
  (`pulledCode`): the entry point takes the bindings left as vertex buffers in a struct of their own, and fetches the
  rest from `vertex_index` or `instance_index`, the stride and the offset with `vertexDecode`, as transform feedback's
  compute pass does, the same modules kept per layout. Those bindings' bind group (`wg_pipeline_pull`: a storage buffer
  per slot and a uniform of each range's bytes past a storage offset, which needs no pipeline per offset) takes the
  first group without resources: past the program's, or an empty one below its push buffer's group 3. The replay
  (`apply`) gives the worker the ranges (`gpu_pull_buffer`, also for any bound offset no vertex buffer can take, unread
  or not) and has it set the group after the program's groups, which may have set an empty one there (`gpu_pull_bind`,
  a bind group per change of the ranges); a pipeline after a pulling one sets its groups again. A program with no
  group free (four groups) pulls in its group 3 (VK4 T44): the bindings from 976 on (`WG_PULL_BASE`, past the
  program's, below the driver's 994–999) in a layout of group 3's entries and these (the BGL JSON's `with`), the bind
  group made of the program's group 3 entries and the pull's at each bind (`pullBind`, the program's dynamic offsets
  kept). Usage scopes see a
  vertex read as before, so shadows serve it. Transform feedback reads the same ranges. Refused still: a program whose
  group 3 bindings reach 976, and more pulled bindings than the vertex stage has storage buffers
  left. The pull's one or two parameters (the bindings' places, the divisors' first instance) are uniform bindings, or
  read-only storage ones where the vertex stage's uniform buffers leave no room for them (a layout at
  `maxPerStageDescriptorUniformBuffers`' edge, ANGLE's 13 with a divisor: `storage_params`, `pullStorage` in the
  pipeline's JSON; refused before, the review of T44–T46), counted among its storage buffers then. A range past `maxStorageBufferBindingSize` is cut there. **Divisors** (VK4 T44, `VK_KHR_vertex_attribute_divisor`
  and the EXT, `vertexAttributeInstanceRateZeroDivisor`, `maxVertexAttribDivisor` 2³²−1): an instance binding whose
  divisor isn't 1 is pulled, its record Vulkan's `first + (iid - first) / divisor` (the first instance's for 0;
  `recordIndex`), the first instance read from a place of the push buffer as draw parameters are (`WGSL_DRAW_PARAMS`,
  bound in the pull's group at binding 17, `gpu_pull_bind`'s `dp_place`): a direct draw's written where it changes, an
  indirect draw's copied from its arguments before the pass (`prepasses`, a place a record); a storing stage's
  pre-pass and a capture take it from their parameters. **`VK_EXT_legacy_vertex_attributes`** (VK4 T44): unaligned
  strides and offsets already pull; a format of another numeric type than the shader's input
  (`wgsl_info.input_base`) pulls too, its decoded values' bits as the input's type (`vertexDecode`'s `bitcast`;
  `nativeUnalignedPerformance` false). Formats WebGPU's vertex buffers lack (VK4 T31: three
  channels of 8 or 16 bits, the scaled ones, BGRA's and the 10-bit packed ones of every type) always pull their binding
  (`wg_vertex_format_pulled`), decoded by `vertexDecode` from names of the fetch's own (`uscaled8x3`, `snorm10-10-10-2-bgra`).
- **Draws through indices of their own** (VK3 L7.4): the provoking vertex's last (`VK_EXT_provoking_vertex`,
  `provokingVertexLast`, per pipeline: ANGLE's ES3, GL's convention) where the fragment shader reads a flat input
  (WebGPU's flat interpolation takes the first vertex), and indexed fans (WebGPU has none). Such a draw is an
  `OP_PROVOKE`: before its render pass begins (the render-pass rule, docs/graphics.md: `prepasses` scans the pass's commands,
  secondaries' too, numbering them as tickets), the worker's compute pass writes the draw's primitives as a list of
  32-bit indices, each one's vertices rotated so that Vulkan's provoking vertex comes first and the winding kept
  (`provoke`: triangle lists, strips and fans, line lists and strips; a strip or fan with primitive restart walked by
  256 invocations, a part each, each from the run its part's predecessors leave (VK3 L7b: one walked it all, long
  enough at millions of indices for the browser's GPU watchdog), a primitive where Vulkan's ends, degenerate where a
  restart leaves none; a 16-bit range bound rounded up to a word, VK3 L7b: rounded down, it lost an odd range's last
  index; the range the draw reads only, VK3 L8a: to the bound range's end, a big buffer's went past
  `maxStorageBufferBindingSize`), into a scratch buffer of the worker's whose places start
  again at each encoder (the queue's order keeps an earlier submit's reads before a later one's writes); in the pass
  the draw is an indexed list draw of its ticket's indices (`gpu_draw_ticket`). Non-indexed fans take the device's fan
  indices, (i + 1, i + 2, 0) for triangle i (Vulkan's order; they used to be (0, i + 1, i + 2), each triangle provoked
  by the fan's centre). An indirect fan's draws are worked out on the GPU, whose arguments they are (VK4 T12, `fanIndirect`,
  `gpu_draw_ticket_indirect`): a compute pass before the render pass writes arguments for the device's fan indices or, with
  an index buffer, a list of its triangles (one invocation walks it; a restart ends a fan), and each draw is an indexed
  indirect draw of those. Other indirect draws with the last vertex provoking are drawn as they are, warned once.
- **Draw parameters** (VK3 L7.5): a draw whose vertex stage reads them (its program's push buffer past 256 bytes,
  "The shader path") has its base vertex (the first vertex, or an indexed draw's vertex offset), first instance and
  draw index in its place of the push buffer after the push constants; a draw whose parameters differ from its place's
  takes a new place (512 bytes, past the push constants' 256: a place without them is 256; and group 3 bound again at its offset: a draw each where the bases change). An indirect
  draw's place is its own, given before its render pass begins (`prepasses`, the render-pass rule: a copy, no break)
  with a copy of its arguments' base vertex and first instance (8 bytes from offset 8, or 12 for an indexed one) into
  it on the GPU, after the commands before the pass and after the queue's write of the push buffer; its draw index the
  CPU's. A draw the capture records alone (transform feedback with rasterization discarded) keeps the last draw's
  parameters.
- **Multi-draw** (VK4 T26): `VK_EXT_multi_draw`'s draws are a draw per element, each with its draw index
  (`cmd->draw_index`, in the op: `gl_DrawIndex` in the push buffer's draw parameters); a multi-draw indirect
  (`multiDrawIndirect`) is one op replayed a draw per record, each with its index (and, with draw parameters, a place of
  its own: the reservation counts them); `maxDrawIndirectCount` and `maxMultiDrawCount` are 65,536. A draw-indirect-count
  (`drawIndirectCount`, `VK_KHR_draw_indirect_count`) is drawn as `maxDrawCount` records from a ticket of the worker's:
  a compute pass before the render pass copies them packed and zeroes those past the count (`gpu_indirect_count`,
  web/venus-gpu.ts `indirectCount`; a record the binding can't reach is zeros too), and each is an indirect draw of
  its copy (`gpu_draw_indirect_ticket`). One of a triangle fan isn't drawn (said once); one under transform feedback is
  captured a record at a time, each record's capture reading the count and capturing nothing past it (VK4 T45).
- **Transform feedback** (VK3 L7.4; one stream; queries and draws by a byte count since VK4 T45): Vulkan
  reads no vertex captured in a render pass before the pass ends, and a capture's begin and end are inside one, so the
  capture runs after its pass (`gpu_xfb`'s jobs, run at the worker's pass end, `runXfb`): no break, no pre-pass. A
  begin copies its counters (bytes written a buffer) and each bound buffer's range into one buffer of the worker's (a
  dispatch then never binds a guest memory writable beside its other uses); a draw copies its index range (a direct
  draw's indices only, VK3 L8a: the bound range's rest of a big buffer went past `maxStorageBufferBindingSize`) and each
  vertex binding's reachable range (past its last vertex or instance where it isn't indexed) into another, after the
  draw's parameters (its first 128 bytes, `wgx_p`: a uniform binding before VK4 T40, 112 bytes before T45), so the capture's bindings are two
  whatever its buffers (VK3 L7a, the binding review's finding 1: one a buffer and a vertex binding went past WebGPU's
  storage buffers a stage, and lost the submit); a draw runs the
  vertex stage as compute (`xfbPipeline`: the module's WGSL with a vertex fetch made from its render pipeline's vertex
  buffers, each WebGPU vertex format decoded from storage words, `vertexDecode`, and a loop over the draw's primitives'
  vertices in Vulkan's order, as many whole primitives as every buffer has room for) on the bind groups, vertex
  buffers and immediates the worker last set in the pass (the vertex stage's resources are visible to compute too:
  `program_create`), its own group after the program's, or, where it has four (sets 3 and up, the push buffer or device
  addresses there: vkd3d's draw parameters), at bindings 997 and 999 of a copy of group 3's (`group3With`; refused at the
  pipeline's creation before VK4 T40, as one whose stage's bindings and the capture's don't fit still is, "Bindings past
  WebGPU's"); then one
  invocation advances the state; an end copies the ranges back and the state into its counters. A draw that
  rasterizes nothing (rasterizer discard, both faces culled) records its state for the capture alone (`xfb_record`).
  An indirect draw is captured too (VK3 L7b: it wasn't): its arguments copied over the capture's parameters on the GPU,
  its index buffer and vertex bindings taken whole, its primitives counted in the shader (`wgx_prims`), 1,024
  workgroups looping over them. Host-visible buffers and counters are read back after the submit. A captured indexed
  draw with primitive restart (VK4 T45) is walked by one invocation, segment by segment (`wgx_serial`: restarts are
  rare in captures, and the walk is what knows each primitive's place); a strip's or fan's records follow the provoking
  vertex where the last provokes (`wgx_j`: `transformFeedbackPreservesProvokingVertex`, fans' too), and gl_PointSize,
  which WebGPU has no place for, is kept for its capture alone (wgsl_nir.c `remove_unsupported_outputs`).
  **Queries** (VK4 T45, `transformFeedbackQueries`: `VK_QUERY_TYPE_TRANSFORM_FEEDBACK_STREAM_EXT`, ES3's
  `TRANSFORM_FEEDBACK_PRIMITIVES_WRITTEN` through ANGLE): each capture's advance dispatch adds the primitives it wrote
  and needed to two words of the worker's (`xfbCounts`, the session's words 4 and 5 while it's open); a query's begin
  and end are jobs among the captures' in the queue's order (outside a render pass, at once): the begin copies the two
  words to the pool's buffer (past its results, 8 bytes a query), the end writes their difference since as its two
  64-bit values (`xfbQuery`, a dispatch), which copies, readbacks and vkGetQueryPoolResults take as an occlusion
  query's (the pool's `vals`: two values a query). **Draws by a byte count** (VK4 T45, `transformFeedbackDraw`,
  vkCmdDrawIndirectByteCountEXT): their arguments, (counter - offset) / stride vertices, written by a dispatch before
  the render pass (`gpu_byte_count`: a ticket, as a draw-indirect-count's), or, where a capture earlier in the pass
  ended writing a counter (Vulkan's barrier inside the pass), in a cut of the pass at the draw (`byte_count_cut`: the
  WebGPU pass ended runs the captures closed so far, `endPass`, then the arguments, then the pass begun again; the pass
  begun storing its attachments for it, `pass_byte_count_cut`); a captured one reads the counter in its capture
  (`wgx_load`). A triangle fan drawn by a byte count isn't drawn (said once: its indices would come from arguments).
- **Vertex stages that store** (VK4 T33; "The shader path"): a draw whose program's vertex stage writes storage cuts its
  render pass (begun storing every attachment, as for `dst_copies`: `pass_vs_stores`, secondaries' too). After the
  draw's state is applied, `vs_prepass` ends the WebGPU pass and the worker runs the stage as compute for the draw's
  vertices on the bind groups, vertex and index buffers and immediates last set (web/venus-gpu.ts `vsPrepass`): the
  draw's vertex bindings and indices copied into one buffer first, after the draw's parameters and its records (one
  storage binding, VK4 T40: three before, which a vertex stage of the advertised storage buffers, or of WebGPU's 12
  uniform buffers, had no room for; the inputs last, so that a read past them, an index out of bounds, stays in them
  as WebGPU keeps a binding's reads, as `robustness.vertex_access` wants); an invocation a
  vertex in the draw's order, an index each (an index met twice runs twice, as Vulkan runs it where it can't tell the
  results are the same; the indices of an `OP_PROVOKE`'s ticket likewise), with no loop around the stage's body
  (SwiftShader compiling one around a large body took its GPU process past 4 GiB); each vertex's outputs (`struct
  Out`, before the flips) a record of words, and an indexed draw's indices a list of the records' places, a restart
  kept. The pass begins again loading, the state is applied there, and the draw reads the records as one vertex buffer
  through the pipeline's pass-through vertex stage (the worker's, `passThrough`: four words an attribute, flipped as
  the stage's own entry point would), an instance at a time. The pre-pass's binding takes a group after the program's,
  or, where it has four (sets 3 and up, the push buffer or device addresses there), joins a copy of group 3's at
  binding 995 (`group3With`, from the driver's layouts' and groups' entries). Vulkan orders a draw's vertex
  stage after the commands before it, so the cut is exact where a pre-pass before the pass wouldn't be (an earlier
  draw's stores, a barrier, then this one's reads). A draw that rasterizes nothing (rasterizer discard, both faces
  culled) still runs its stage (`OP_VS_ONLY`), and a draw split by face (`draw_faces`) runs it once, its later face
  drawing the first's records (`OP_VS_AGAIN`). Not drawn: an indirect draw of such a stage (its counts are on the GPU;
  said once). Refused: outputs past WebGPU's 16 vertex attributes (said), and what "Bindings past WebGPU's" refuses.
  A cut, the pre-pass and its draw cost ~0.12 ms a draw more on the M4, 0.07–0.14 on SwiftShader with ~0.3 µs a
  vertex on top (bench/vulkan/REPORT.md "VK4 T33").
- **Bindings past WebGPU's** (VK3 L7a, the reviews after L7; `wg_caps.c` "The bindings WebGPU takes", the one place
  that counts them): besides a descriptor's own binding, WebGPU binds the push buffer (a uniform buffer every stage
  counts, dynamic in its layout), a texel buffer's words (a storage buffer, where Vulkan counts an image), a group's
  parameter table (a uniform buffer, for its texel buffers and storage images as words), uniform buffers past a stage's room as storage, a YCbCr binding's other planes and an input attachment as
  textures, a capture's compute pass's two (a storing vertex stage's pre-pass's one), and a split sampler's twin
  (below). The device advertises what fits whatever the program: each stage's uniform buffers less the push buffer's,
  all of WebGPU's dynamic uniform buffers (a layout with them all puts the push buffer on a dynamic storage binding,
  `wgsl_print_options.push_storage`; VK4 R7; a dynamic buffer past WebGPU's dynamic ones, with the push buffer's or
  past them, as dEQP-VK's `descriptor_copy` counts Vulkan's limit by the set, is a plain binding at the offset bound,
  its bind group's, a group for each offset: `baked`, `wg_bake_dynamic`, VK4 T40),
  storage buffers less the folded ones, every stage's least (the vertex and fragment stages' own limits too), the
  uniform offset alignment the larger of the uniform and storage ones (a folded buffer is bound at it). What can't be
  advertised apart from what Vulkan counts with it (texel buffers beside a full count of storage buffers, input
  attachments beside 16 sampled images, more folded uniform buffers than the advertised two, binding numbers past
  WebGPU's or on the driver's, the parameter table's 994 and up) is counted when a pipeline is made (`wg_bindings_fit`, after `program_create`):
  a program that doesn't fit is refused, its stages drawing and dispatching nothing, the cause said ("wg: a shader
  didn't translate: the compute stage binds 11 storage buffers, past WebGPU's 10 (of them: 3 texel buffers'
  words)"), never an invalid submit (a `try/catch` can't catch WebGPU's validation, which is asynchronous); one that
  fits with the words of one memory shared ("The shader path", "Texel buffers") draws through its variants, each refused
  where it doesn't fit. A captured vertex stage whose capture doesn't fit keeps its draw and loses its capture, said too. Variants
  (`wg_program_variant`) see all of a program's resources (a mask of 128); a sampler that samples an unfilterable
  texture and a filterable one is split (VK3 L7a, the binding review's finding 2: its nearest twin made every
  texture it sampled nearest): its twin at the even binding of its slot (a separate sampler's is free) for the
  unfilterable ones, in modules of the variant's own (render stages' too, `wg_variant_modules`); and a group's
  layout uid tells the storage its shaders write (a widened variant's group isn't a writer's, whose readback its
  replay registers). A uniform block is declared at most `maxUniformBufferBindingSize` and bound widened to it, and
  a memory's GPUBuffer has that many bytes past its end for it (`WG_MEMORY_PAD`, `maxMemoryAllocationSize` that
  much less): a block declared past its buffer's memory or its range is valid. A binding with immutable samplers
  keeps them whatever a write passes or a copy brings (VK3 L8a: copies overwrote them).
- **Attachment-less passes** (VK3 L7.4: transform feedback's passes have none): WebGPU's passes need an attachment, so
  such a pass gets one of the device's (an R8 texture of the render area's size, kept by size and samples,
  `dummy_attachment`), which no pipeline writes; at the place of the last of eight null colour attachments (VK3 L7b: a
  ninth overran `pass.colors`). Its samples are the pipelines' `rasterizationSamples` (`framebufferNoAttachmentsSampleCounts`
  1 and 4, Vulkan's minimum; all of a pass's pipelines alike without `variableMultisampleRate`): the pass is recorded
  with a 1-sample one, its view's id in ten digits, and the pass's first draw, or a secondary's inherited samples at
  `vkCmdExecuteCommands`, puts in one of its samples (`dummy_samples`; VK3 L8a: it stayed at 1, so per-sample shading,
  `gl_SampleID` and sample counts were a pixel's). A secondary inheriting no attachments has the device's in the same
  place. It is counted (`wg_dummy`): the device keeps 16 by size and samples, and each command buffer whose passes name
  one holds it until it is reset or freed (VK3 L7b: a 17th size released one under a recorded pass, its id another's).
- **Completion**: submits are numbered across devices (a completion finds its submit by number alone; at most 16
  devices at once, a 17th fails to be made). The worker calls `venus_complete(serial)` in submit order once the work is done and its staging
  buffers are mapped; the readbacks are copied into the module's memory, fills and updates of host-visible memory (Venus's
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
  passes and draws, and the done of the submits with a pass. `?gpu=vkl9=<suspect>` (repeatable; `all`) puts one of
  VK3 L9a's suspects back as it was at 4fdc69fb, for the NVIDIA run's A/B only (web/venus-gpu.ts `L9_SUSPECTS`):
  `features` (no `subgroups`, `shader-f16`), `limits` (not the vertex stage's storage limits nor
  `maxBindingsPerBindGroup`), `bindgroups` (each pipeline's layouts their own uids), `pad` (no WG_MEMORY_PAD).
  On NVIDIA a frame's `Queue::Submit` in the GPU process took 2.5 ms of its CPU at c8087cb0 against 1.6 at 4fdc69fb,
  with the same WebGPU calls; SwiftShader's take ~0.1 ms either way (bench/vulkan/REPORT.md "VK3 L9a").
- **What the emulated paths do** (VK4 T23): the driver counts each path's work since the start (`wg_emul`,
  `enum wg_emul`; glue.c's `venus_emul_counts`): a usage scope's shadow copies and their bytes, the bytes written back,
  the passes its barriers cut; copies between view formats' textures and to and from an image's words, and their
  bytes; a feedback loop's copies; draws whose vertices are pulled; variants made, and draws and dispatches through a
  keyed one (samplers, padded images, formatless storage); passes made before a render pass (provoking vertices,
  indirect fans). The worker counts its own (web/venus-gpu.ts `VenusEmulStats`): blits, resolves WebGPU makes and
  those drawn, depth resolves, clears and those copied in, transform feedback's draws, storing vertex stages'
  pre-passes (the driver's `vsPrepasses` too: VK4 T33). The render stats' `venusEmul`
  has both, a second's. `?gpu=vkskip=<path>` (repeatable; the bench hook `window.__webpcVkSkip` changes it in a run)
  leaves a path's work out, for A/B only: `views`, `words` and `feedback` (the driver's copies: the place is taken as
  up to date) and `meta` (the worker's blits and resolves); what it leaves is wrong pixels, never a command WebGPU
  refuses, which is why the shadows, pulled vertices and keyed variants have no skip (WebGPU would refuse their draws).
  `bench/vulkan/t23.ts` measures them in Godot's GI demo (bench/vulkan/REPORT.md "VK4 T23").
- **Shared images** (Venus's WSI): see "Presentation".
- **Semaphores' exports** (VK3 L7.1b): a semaphore is made whatever handle types its `VkExportSemaphoreCreateInfo`
  names; those other than sync files are dropped (`wg_CreateSemaphore`). Venus's guest driver creates semaphores
  asynchronously and backs sync-file ones itself, so a semaphore vkr's create refused would be a handle vkr never had,
  and the guest's next submit naming it killed its context ("failed to look up object … of type 5"). Chromium's own
  Vulkan device exports opaque fds though Venus offers none (its properties say 0): the guest's Mesa then hands back
  fd 0, then -1 (`bench/vulkan/semfd.ts`; docs/backlog.md "Dawn in the guest's Chromium on Venus").
- **Waits before their signal** (VK3 L6a): syncs are advertised as waiting before their signal, so Mesa's runtime
  hands every submit to the driver at once (no submit thread: vkr has one); a submit with a timeline wait that isn't
  met, by the value or by a submit already replayed that will signal it, is held, with every later submit of its
  queue, and each queue's replayed in order once their waits are met: at the host's signal (`vkSignalSemaphore`), after
  a submit that ran (it may signal another queue's wait: VK4 T22) or at the end of a completion. Binary waits are met in
  the queues' order, or held with a held submit that signals them. A submit of signals alone is held with the rest of its queue: Mesa's
  vkQueueWaitIdle and vkDeviceWaitIdle are such submits, and so is vkr's fence that retires a guest's ring fence, through
  which Venus's guest driver signals its timeline semaphores (a semaphore is a DRM syncobj in the guest, its point
  signalled by the fence of the execbuffer sent after each batch; a fence that went ahead said a batch's value was
  reached before the batch ran, VK4 T6). Held fences wait in the guest's control queue, so the device answers them out
  of line (docs/devices.md "Venus"). A sync destroyed while a pending or held submit names it (a context's teardown, a guest
  that doesn't wait) is dropped from the submit's signals and waits (`wg_sync_finish`; VK4 T2): its completion called
  the freed sync's type through a stale pointer, a trap (`tests/venus-renderer.test.ts`: "function signature
  mismatch"; NVIDIA's "table index is out of bounds" in `wg_complete`, VK3 L9b, was likely it).
- **Not yet** (docs/backlog.md "The Vulkan driver's gaps", with what dEQP-VK found): depth blits.

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

**Made at creation, off by default** (VK4 T17): the driver makes a render pipeline when a draw is recorded (its key: the
draw's state, the pass's attachments, the program's variant); with `?gpu=vkpremake=on` it also makes one at
`vkCreateGraphicsPipelines` (`wg_pipeline_premake`, vk/driver/wg_cmd.c). That loses: programs make many pipelines they
never draw with (vkQuake's capture: 100 made so, 8 of them drawn), and their compiles, queued on Dawn's workers, delay
the ones the first frames wait for (cold vkQuake 269 → 26 frames/s on the M4, 11 → 4.8 on SwiftShader;
bench/vulkan/REPORT.md "VK4 T17"). The new pipeline is bound into a command buffer of the
device's own, which gives its stages and the state it holds (Mesa's `dyn->set`), and the pass is the one it was made
for (its rendering formats or subpass); the key is then `draw_key`'s, as a draw's. Guessed: a dynamic viewport's flips
(the device's last draw's), not indexed (a strip's index format is the draw's), nothing pulled for offsets, the
program's variant without bound sets. A pipeline whose key a draw's dynamic state decides (extended dynamic state:
topology, cull, depth and stencil tests, blending or vertex strides dynamic, as DXVK's, Zink's), or of tessellation or
geometry, is made at its draw only. A draw that differs makes its own, as before; the worker counts those made so and
those a draw set (`premade`, `premadeUsed` in `venusPipelines`).

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
under a byte budget (least recently used out first), written back a second after a change. Entries are stored deflated
(CompressionStream's deflate-raw at the write-back; one that doesn't shrink as it is, VK4 T17) and held so, inflated at
each lookup by fflate's synchronous `inflateSync` (the lookups are synchronous; an entry is held as the renderer gave it
only until its write-back): Godot's editor's 499 entries take 3.8 MB held where they took 19 MB inflated, and its warm
start's 499 lookups inflate in ~66 ms in all (Node; vkQuake's second replay's 753 in 28 ms in Chrome on the M4), the
largest entry (0.86 MB) in ~3 ms. So the budget counts what is held too. LZ4 (the core's codec in JavaScript) held 60%
more and inflated no faster; zstd through fzstd decoded 3× slower and has no encoder without a wasm build
(bench/vulkan/REPORT.md "VK4 T49 follow-up"). The budget is the page's Preferences'
("[Space for Vulkan's shaders](ui:machines:MachinesPage.shaderBudget)", 8 to 64 MiB, 32 by default, `webpc.settings`
`shaderMiB`), taken at a machine's start; the Machines page's storage line shows the store and clears it
(`shaderStoreSize`, `clearShaderStore`; a machine running with Vulkan keeps what it holds and stores it again as it
changes). Entries carry the
renderer's build ID (`venus_build_id`), and those of another build are dropped at the load. So a program's second run
on a machine (or on another machine of the page) translates nothing its first did. What remains is the browser's own
pipeline compile, which Chromium caches itself (bench/vulkan/REPORT.md "VK3 L3"). `?gpu=vkcache=off` keeps nothing, for
cold runs and A/B. tests/venus-cache.test.ts checks the store (its entries held deflated and round-tripping too), tests/page-modal.test.ts the
Machines page's line and budget; tests/venus-driver.test.ts a second run of the driver's
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
rasterization. **It is lavapipe's reading of anisotropy** (VK4 T12): vkQuake's textures use samplers of `NEAREST` filters with
`anisotropyEnable`, which lavapipe filters linearly. WebGPU's anisotropy needs linear filters, and with them forced in a trial
build the frames differ by 109 bytes over 24 (`results/vk4/t12/vkquake-forced.json`). The driver keeps the program's nearest
filters and drops anisotropy instead: Vulkan leaves this to the implementation, and radv keeps point sampling here, so the
3% tolerance stands. The replay
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
  and storage textures a pass sets a bind group writable to: VK3 L4c-F, so a swapchain image a compute pass alone draws
  counts, `t48ComputeShared` in tests/venus-driver.test.ts): an image is copied only when it was written since its last
  copy.
- **Which formats** (VK4 T48): the desktop guest's WSI offers under sway what the device renders and virgl imports
  (`bench/vulkan/results/vk4/t48/surface-formats.txt`): B8G8R8A8 and R8G8B8A8 (and their sRGB), A2B10G10R10,
  A2R10G10B10, R16G16B16A16_SFLOAT and R5G6B5. What the virgl texture stores follows the virgl format the compositor
  typed the import with (web/venus-share.ts `stored`: its `sample` swizzle inverted, so B8G8R8A8's and B10G10R10A2's
  stored red is the image's blue), whatever the image's texture is: A2R10G10B10's packed texture (`rgb10a2unorm` with R
  in red) and R5G6B5's (`rgba8unorm`) hold colours, not virgl's bytes. Where the texture's bytes aren't virgl's, the
  readback way and the check first draw the image into a texture of virgl's bytes (`storedOf`: `rgb10a2unorm` swizzled,
  5-6-5 packed into `r16uint`); the GPU ways draw it swizzled into their canvas as before, and WebGL converts.
- **Not NVIDIA's vendor ID:** the device reports the adapter's maker as its vendor (web/venus-gpu.ts `VENDORS`), but
  never NVIDIA's 0x10de: Venus's guest driver (Mesa 26's `vn_wsi_init`) then takes the device for Venus on NVIDIA's own
  driver, which can't render to linear images, and its WSI renders into an optimal image and copies each frame into a
  buffer it exports instead (the prime blit), which every Vulkan window on the user's NVIDIA desktop took before the
  buffers were shared (bench/vulkan/REPORT.md "VK3 L1"; reproduced on SwiftShader with `?gpu=vkvendor=nvidia` and the
  desktop guest's Mesa 26.2; Debian's 25.0 has no such branch). An external resource that is neither an image's memory
  nor a buffer's is warned of (`venus-share: resource N … isn't (or no longer) a Vulkan image's or buffer's memory`;
  vkcube's first 500×500 swapchain is one, gone before it shows) and counted (`unshared` in the render stats).
- **The prime blit's buffers** (GD G7): every X11 client takes the prime blit in our guest, whatever the vendor. Mesa's
  X11 WSI renders directly only for a device the X server's DRI3 device matches (`wsi_device_matches_drm_fd`), which
  compares PCI bus info alone (Venus doesn't override `can_present_on_device`, as Mesa asks of drivers for GPUs off
  PCI), and our virtio-gpu is on virtio-mmio: so through Xwayland an optimal image is copied each frame
  (`vkCmdCopyImageToBuffer`) into a linear buffer on dedicated memory exported as a dma-buf, rows 256-byte aligned.
  The driver names that memory's GPUBuffer when no image is bound to it (`venus_resource_buffer`,
  `wg_memory_shared_buffer`), web/venus-gpu.ts records the submit whose transfer (a copy, a fill) last wrote each
  buffer as it does textures, and web/venus-share.ts copies the buffer, once each time it's written, into a texture of
  the resource's own (`fromBuffer`: `rgba8unorm`, `rgb10a2unorm` or `rgba16float`, so its texels are virgl's stored
  bytes; rows as far apart as the import's stride, `PIPE_RESOURCE_SET_TYPE`'s first plane), which then goes the
  chosen way. Godot's editor on the user's NVIDIA desktop picked X11 and was black before (`prime_blit=1` with
  `VN_DEBUG=wsi` on Mesa 26).
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

`tests/venus-share.test.ts` checks the bytes every way, R5G6B5's and A2R10G10B10's packed textures among them (the GPU ways only where the page doesn't render in software:
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
- **The texture** (web/venus-import.ts `VenusImport`, VK4 T16): each resource has a WebGPU texture of its own, one per
  texture description (an image of another format or size on the same memory gets another), made at its first import
  and destroyed at the resource's end (`unref`, a reset); an image bound to the resource's memory takes it in place of
  its own under its id (web/venus-gpu.ts `onImport`; an image's end leaves the resource's). A shared image's texture is
  made at its bind (VK4 T48: the driver's `gpu_create` names the resource, `"import"`), so an imported one makes none of
  its own: mpv's two a frame, made at `vkCreateImage` and destroyed at the bind before, are gone (`venusTextures` in the
  render stats: 22.7 a second → 0 at mpv's 11.5 frames a second on SwiftShader, bench/vulkan/REPORT.md "VK4 T48").
- **A multi-planar image** (VK4 T48) is imported disjoint, each plane bound to memory imported from a dma-buf of its
  own (a resource a plane, as VA-API's surfaces are: an R8 luma and an RG8 chroma), the plane's texture the resource's
  (`gpu_texture_import` of the plane's texture at its bind); the image-format query offers it importable only, with
  `DISJOINT`, optimal tiling (no DRM modifier for multi-planar formats). One memory holding several planes isn't
  offered: a resource is one plane's texture. A surface imported again (libplacebo imports it at every frame it shows) is a bind that writes
  nothing, and what Vulkan draws into a resource stays in it across imports. `?gpu=vkimport=rewrite` gives each image
  its own texture, written at its bind, as before T16 (A/B).
- **The bytes**: `queue.writeTexture` into the resource's texture, so in the queue's order before the submits that
  sample it. When it's made, the last picture written into the resource (kept for every resource imported before), or
  the virgl texture read back (its first import); and every picture the video path writes into a plane afterwards goes
  to the resource's textures too (`VirglRenderer.onPlane`, the decoded bytes the host has anyway). mpv writes each
  picture once either way (it imports a surface once a picture); T16 took the import's GPU-worker time a frame from
  0.22 to 0.18 ms on the M4 (bench/vulkan/REPORT.md "VK4 T16").
- **The order:** nothing makes the guest wait for a picture before it imports and samples its surface. Mesa's virgl VA
  driver makes no fence for a decode, so mpv's `vaSyncSurface` returns at once (docs/plans/video.md), and Venus's ring
  is polled, past the GPU worker's call queue, which holds calls behind pending pictures. A bind while the resource's
  picture is still decoding (`videoPending.res`) reads nothing back and leaves the texture to the picture, written when
  it lands; a draw already submitted samples the texture's earlier bytes (a reused surface's last picture, or zeros for
  a fresh one) and the next one the picture. Binds, pictures and a resource's end (`unref`) all go through the queue's
  order (`VenusGpu.later`, behind submits held for their pipelines), and a texture's first write held past its
  resource's end, its id perhaps reused, is dropped (counted at the call); which textures a resource has is known at
  once, and its end takes them out at once, destroying them in the queue's order. A virtio reset or a snapshot's load forgets every resource. The
  call queue runs Venus's calls that make things (a context, a blob, its map, a resource's attach, a submit) past the
  calls waiting for pictures, so a resource is imported in vkr before the ring names it; those that end things wait in
  order as an unref does. The kernel's attach and the ring are still two paths: the device worker hands the attach
  over as soon as it reads the virtqueue, while the ring is read from shared memory, so a ring polled in that gap
  would miss the resource (never seen).

`tests/venus-driver.test.ts` imports a resource in the driver's test program (`wgt_import`: an R8G8 image with the
LINEAR modifier on imported memory, copied to a buffer) through `VenusImport` with a fake renderer, before and after a
picture, the image on the resource's own texture and none of its own made, and a disjoint NV12 image's planes on two
(`wgt_import_planes`); `tests/venus-import.test.ts` checks the order (pending pictures, held
binds and pictures across a resource's end, resets) and the resources' textures (kept across imports, one per
description, destroyed at the end in order), `tests/virgl-video.test.ts` the call queue's; `tests/gpu.test.ts` checks the device's hand-over. mpv's playback is measured by
`bench/audio/avsync.ts` (`MPV_VARIANTS`): bench/vulkan/REPORT.md "VK2 L6".

## On the page

A machine has Vulkan when its Machines page setting is on (`MachineRecord.vulkan`, beside 3D: docs/machines.md)
or the page's `?gpu=vulkan` asks; only then does the GPU worker fetch the module. `npm run dist` puts it in the
static copy as a hashed asset with its licences beside it (`VENUS-LICENSES.txt`, made by vk/build.sh from
`vk/LICENSES.head`, the sources' licence files and `vk/LLVM-exception.txt`); `npm start` and `npm run dist --
--no-vulkan` include it only when built (vk/build.sh isn't part of their preparation: it builds Mesa and
virglrenderer natively first). The module is 12.05 MiB, 1.24 MiB gzipped, 0.74 MiB with brotli (bench/vulkan/REPORT.md "VK3: the summary"; how
it's measured: "VK2: the module, a pipeline, a submit").
