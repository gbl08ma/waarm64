# vk/: Venus's renderer in wasm

The host side of Vulkan through Venus ([docs/plans/graphics.md](../docs/plans/graphics.md) route (b);
[docs/devices.md](../docs/devices.md) "Venus"): virglrenderer's Venus decoder (`vkr`) over a Vulkan driver of ours
on Mesa's common Vulkan runtime, built as one wasm module, `target/vk/venus.wasm` (3.2 MB, ~510 KiB gzipped), which
the GPU worker instantiates on the VM's memory 0 (web/venus-host.ts).

```sh
vk/build.sh     # -> target/vk/venus.wasm (the first run clones and builds natively, a few minutes; later ones are quick)
node --test tests/venus-renderer.test.ts   # the module in Node: its capset, a blob's map and unmap
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
  ring. The module imports `wasi.thread-spawn`, which the host answers with -1.

## The parts

- `glue.c`: the exports the GPU worker calls (`venus_init`, `venus_capset`, contexts, submits and fences, resources
  and their map and unmap, `venus_poll`, the heap), and two imports: `venus_retire` (a fence retired) and
  `venus_submitted` (a queue submit ran: the window's written pages are taken then).
- `vk/patches/vkr-wasm.patch`: the polls; device memory as vkr's own `aligned_alloc` storage, imported into the driver
  as a host pointer (`VkImportMemoryHostPointerInfoEXT`) and exported as a blob of shared memory with no fd; a blob's
  map into the window copies its storage there and rebinds the driver's memory to it (`vkr_wasi_memory_moved` →
  `wg_memory_rebind`), an unmap copies it back (wasm can't remap pages).
- `vk/driver/` (prefix `wg`): the driver. In VK1 it is null: Mesa's lite runtime (no shader compiler), what VK0's
  Mac profile advertises (`vk/profile.ts` makes C tables of `bench/vulkan/profiles/webgpu-mac.json`'s `mac_direct`)
  plus the extensions Venus's WSI shares through; two memory types (device-local; host-visible, coherent, cached and
  device-local) on a 2 GiB heap, one queue family. Every `vkCmd*` is recorded by the runtime's command queue; a submit
  runs only the commands that write memory the guest reads (buffer fills, updates and copies, queries, timestamps,
  events), then signals. One CPU sync type serves binary and timeline syncs, and sync files of -1.
- `vk/wasi/`: what wasi-libc lacks for this code (uids, signals, `mkstemps`, `syslog.h`, `libsync.h`, `ioccom.h`),
  Mesa's `os_misc` without an OS, and virglrenderer's `config.h` for wasm.

## Not yet

The driver draws nothing: VK2 translates onto WebGPU (the dirty pages the window's write-watch reports are what it
uploads at each submit). The module isn't in `npm run dist`'s copy or `npm start`'s build yet, and the page has
no per-machine setting for Vulkan (`?gpu=vulkan` only); docs/backlog.md.
