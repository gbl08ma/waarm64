# vk/: Venus's renderer in wasm

The host side of Vulkan through Venus ([docs/plans/graphics.md](../docs/plans/graphics.md) route (b);
[docs/devices.md](../docs/devices.md) "Venus"): virglrenderer's Venus decoder (`vkr`) over a Vulkan driver of ours
on Mesa's common Vulkan runtime, with Mesa's `spirv_to_nir`, NIR and our NIR → WGSL backend, built as one wasm module,
`target/vk/venus.wasm` (12.4 MB, 1.18 MB gzipped: most of the raw size is NIR's tables), which the GPU worker
instantiates on the VM's memory 0 (web/venus-host.ts).

```sh
vk/build.sh     # -> target/vk/venus.wasm (the first run clones and builds natively, a few minutes; later ones are quick)
vk/build.sh native   # also target/vk/wgsl: the translator natively with ASan (`target/vk/wgsl <0|4|5> stage.spv`)
node --test tests/venus-renderer.test.ts   # the module in Node: its capset, a blob's map and unmap
node --test tests/wgsl.test.ts             # the translator: SPIR-V stages to WGSL in Node, compiled by Chromium's WebGPU
node --test tests/page-venus.test.ts       # vkcube on the page (needs images/debian-vulkan/build.sh's image)
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
- **The link:** `--import-memory --shared-memory --max-memory=4GiB`, `--global-base=0xF0000000` and a 4 MiB stack:
  the module's data, stack and heap live in the arena at memory 0's top (256 MiB at 0xF000_0000, web/devices.ts
  `VENUS_ARENA`), which web/vm.ts keeps free on a Venus machine. Its `sbrk` (`vk/wasi/arena.c`) starts at
  `__heap_end`, past dlmalloc's initial region, and grows up to 4 GiB without `memory.grow`.
- **No threads.** vkr's ring, ring-monitor and queue-sync threads become polls under `__wasi__`
  (`vk/patches/vkr-wasm.patch`): `vkr_renderer_poll` runs every ring and retires fences, and a seqno wait polls its
  ring. A ring command that waits for a virtqueue seqno not submitted yet (`vkWaitVirtqueueSeqnoMESA`, which Mesa
  26's driver sends) can't block the only thread, since that seqno comes in a later submit: the ring stalls after it,
  keeps the rest of its batch, and its poll resumes once the seqno arrives. The module imports `wasi.thread-spawn`,
  which the host answers with -1.

## The shader path

`vk/compiler/` (wgsl.h has the model): SPIR-V → NIR (`spirv_to_nir`, buffers as index and offset, no physical
pointers) → `wgsl_preprocess` (KosmicKrisp's pass list: inlining, splitting, outputs through temporaries, input
attachments as 2D textures, scalarized ALU) → `wgsl_lower` against a layout (descriptors to slots: slot s of a set is
WGSL `@binding(2s)`, a combined image-sampler's sampler `2s + 1`; I/O to locations; explicit memory; NIR's
optimization loop) → `wgsl_link` for a vertex and fragment pair (`nir_opt_varyings`) → `wgsl_print`, out of SSA. The
printed WGSL keeps every value in a function-scope `var` of u32 or bool and bitcasts at each operation, so it needs no
type inference and no const-expression can overflow or make a NaN (shader-creation errors in WGSL); textures and
samplers come from the tex instruction's indices; push constants are immediates (a struct of vec4s, since immediates
can't be arrays, copied into an array the shader indexes); a vertex shader's outputs are typed and interpolated as its
fragment shader reads them, and its y is negated by the override `wg_flip_y` (-1, or 1 for a flipped viewport). What
WGSL can't express fails the stage with a reason: 16-bit values, a fifth descriptor set, texel buffers, dynamically
indexed descriptors, image atomics, interpolation at an offset, `textureQueryLod`.

`tests/wgsl.test.ts` runs VK0's scene's shaders (glslc) and VK1 step 1's 108 stages (`target/vk1/spirv`, dumped by
`SPIRV_DIR=target/vk1/spirv bench/vulkan/translate/programs.sh`; not committed, they're the programs'): 118 of 127
translate (0.4 ms a stage at the median in Node, 25 ms GTK4's largest) and all 118 compile in Chromium; the nine
others are vkQuake's and use what the direct set doesn't offer (fp16, set 4, texel buffers, dynamic indexing). It
checks that Tint accepts the WGSL, not what it computes: that is the driver's tests' and dEQP-VK's.

## The parts

- `glue.c`: the exports the GPU worker calls (`venus_init`, `venus_capset`, contexts, submits and fences, resources
  and their map and unmap, `venus_poll`, the heap), and two imports: `venus_retire` (a fence retired) and
  `venus_submitted` (a queue submit ran: the window's written pages are taken then).
- `vk/patches/vkr-wasm.patch`: the polls; device memory as vkr's own `aligned_alloc` storage, imported into the driver
  as a host pointer (`VkImportMemoryHostPointerInfoEXT`) and exported as a blob of shared memory with no fd; a blob's
  map into the window copies its storage there and rebinds the driver's memory to it (`vkr_wasi_memory_moved` →
  `wg_memory_rebind`), an unmap copies it back (wasm can't remap pages). A memory freed while its blob lives hands the
  blob its storage.
- `vk/driver/` (prefix `wg`): the driver. In VK1 it is null: Mesa's lite runtime (no shader compiler), what VK0's
  Mac profile advertises (`vk/profile.ts` makes C tables of `bench/vulkan/profiles/webgpu-mac.json`'s `mac_direct`)
  plus the extensions Venus's WSI shares through (dma-buf memory; one DRM modifier, LINEAR, with the optimal tiling's
  features, since the WSI renders into its images; foreign queue transfers; sync-file semaphores) and YCbCr conversions
  (GTK's Vulkan renderer won't start without them); a device-local memory exports as a blob with no storage (a WSI
  image shared as a dma-buf); two memory types (device-local; host-visible, coherent, cached and
  device-local) on a 2 GiB heap, one queue family. Every `vkCmd*` is recorded by the runtime's command queue; a submit
  runs only the commands that write memory the guest reads (buffer fills, updates and copies, queries, timestamps,
  events), then signals. One CPU sync type serves binary and timeline syncs, and sync files of -1.
- `vk/wasi/`: what wasi-libc lacks for this code (uids, signals, `mkstemps`, `syslog.h`, `libsync.h`, `ioccom.h`),
  Mesa's `os_misc` without an OS, and virglrenderer's `config.h` for wasm.

## Not yet

The driver draws nothing: VK2 translates onto WebGPU (the dirty pages the window's write-watch reports are what it
uploads at each submit). The module isn't in `npm run dist`'s copy or `npm start`'s build yet, and the page has
no per-machine setting for Vulkan (`?gpu=vulkan` only); docs/backlog.md.
