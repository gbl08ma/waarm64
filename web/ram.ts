// Guest RAM as the device backends see it (docs/spill-memories.md): memory 0's RAM, then each spill memory,
// and the segments the core posts into them; and how a machine's RAM splits into them. A small module of its own:
// the GPU worker and the page's main thread import it.

/** A guest buffer: `len` bytes at `off` in memory `mem` (0: memory 0's RAM, from its first byte; k: memory k from its first byte, ABI 40). */
export type Segment = { off: number; len: number; mem: number };
/** Guest RAM by memory: memory 0's RAM, then each spill memory (docs/spill-memories.md). */
export type Ram = Uint8Array[];
/** A segment's bytes, in place. */
export const bytes = (ram: Ram, s: Segment) => ram[s.mem].subarray(s.off, s.off + s.len);
/**
 * Where each memory's RAM is in the guest's physical address space, memory 0 first (`VmConfig::spill_layout`): `size`
 * bytes at `pa`, from `off` in the memory (memory 1's node after Venus's renderer and window, docs/spill-memories.md).
 */
export type RamLayout = { pa: number; size: number; off: number }[];
/** Guest RAM's base (`vm::RAM_BASE`). */
export const RAM_BASE = 0x4000_0000;
/** The segment of `len` bytes at guest PA `pa`, if they lie in one memory's RAM (backends handed guest PAs: virtio-gpu's backing). */
export function locate(layout: RamLayout, pa: bigint, len: bigint): Segment | undefined {
  for (const [mem, r] of layout.entries()) {
    const off = pa - BigInt(r.pa);
    if (off >= 0n && len <= BigInt(r.size) - off) return { off: r.off + Number(off), len: Number(len), mem };
  }
}
/**
 * The spill memories' layout past `ramSize` bytes of memory 0 and a host-visible window of `window` bytes after it, as
 * the core places them (1 GiB boundaries, a hole between); node 1 starts at `spillAt` in memory 1 (`VmConfig::spill_at`).
 */
export function ramLayout(ramSize: number, spill: number[] = [], window = 0, spillAt = 0): RamLayout {
  const layout = [{ pa: RAM_BASE, size: ramSize, off: 0 }];
  let end = RAM_BASE + ramSize + window;
  for (const [k, size] of spill.entries()) {
    const pa = (Math.floor(end / 2 ** 30) + 1) * 2 ** 30;
    layout.push({ pa, size, off: k ? 0 : spillAt });
    end = pa + size;
  }
  return layout;
}

/**
 * The least heap a fixed memory gets (docs/spill-memories.md "The heap floor"): the reserve is what 4 GiB leaves
 * after the scratch page, RAM and fw_cfg's files, capped at `HEAP_RESERVE` (web/vm.ts) and never under this. The
 * heap reaches ~540–600 MiB under a heavy 4-vCPU load, so 1 GiB, and the reserve is always 1 GiB.
 */
export const HEAP_FLOOR = 1 << 30;

/**
 * The most RAM memory 0 holds with the heap at its floor: 4 GiB less the floor and 1 MiB for the scratch page and
 * fw_cfg's files (up to 960 KiB: the credentials). Fixed, so that a machine's split never depends on its fw_cfg files
 * (a snapshot restores only onto the same layout); the rest of a machine's RAM goes to spill memories.
 */
export const MAX_MEMORY0_RAM = 2 ** 32 - HEAP_FLOOR - (1 << 20);

/**
 * The host-visible window a machine with a Venus GPU gets (`BootOptions.window`): Venus's rings, command streams and
 * mapped memory. Linux gives a mappable blob its place here when the blob is made (Venus makes a memory's at its first
 * map) and keeps it until the blob's end, so this caps the host-visible memory mapped at once: it holds the device's
 * whole host-visible heap (1 GiB, vk/driver/wg_device.c) and 256 MiB for Venus's own (GD G8: at 256 MiB, Godot's VMA,
 * whose blocks stay mapped, failed its third 128 MiB map with -2). Untouched pages cost nothing.
 */
export const VENUS_WINDOW = 1280 << 20;

/**
 * The renderer's arena on such a machine: memory 1's first bytes, the module's data, stack and heap (vk/wasi/arena.c
 * stops its heap here, vk/gen.ts). Untouched pages cost nothing. It backs host-visible Vulkan memory, whose heap
 * programs take as general memory only from 1 GiB (VK4 T2), beside the renderer's own (dEQP-VK's pass list: 137 MiB).
 */
export const VENUS_ARENA = 1280 << 20;

/**
 * What memory 1 holds before node 1's RAM on a Venus machine (docs/devices.md "The host-visible window"): the arena,
 * then the window (`VmConfig.window_at` is the arena's size). `splitRam`'s `reserve` there.
 */
export const VENUS_RESERVE = VENUS_ARENA + VENUS_WINDOW;

/** The largest spill memory (a whole wasm32 memory) and how many a machine has at most (core/src/mem.rs `MAX_SPILL`). */
export const MAX_SPILL_BYTES = 2 ** 32;
export const MAX_SPILL = 8;

/**
 * The automatic split of `total` bytes of guest RAM (a 64 KiB multiple): memory 0 as large as it goes
 * ({@link MAX_MEMORY0_RAM}), then spill memories of up to 4 GiB (docs/spill-memories.md), the first less `reserve`
 * bytes memory 1 holds before its RAM (a Venus machine's renderer and window: {@link VENUS_RESERVE}).
 */
export function splitRam(total: number, reserve = 0): { ramSize: number; spill: number[] } {
  const ramSize = Math.min(total, MAX_MEMORY0_RAM);
  const spill: number[] = [];
  for (let left = total - ramSize; left > 0; left -= spill.at(-1)!) spill.push(Math.min(left, MAX_SPILL_BYTES - (spill.length ? 0 : reserve)));
  if (spill.length > MAX_SPILL) throw new RangeError(`${total} bytes of RAM need more than ${MAX_SPILL} spill memories`);
  return { ramSize, spill };
}

/**
 * Why a split isn't one a machine can have (`splitError`), as a code and its numbers in MiB: memory 0 under 64 MiB
 * (`memory0-min`) or over `max` (`memory0-max`), more than `max` NUMA nodes past it (`nodes`), a node of `mib` outside 1
 * to `max` (`node`), or a first node over `max` with Vulkan's reserve before it (`vulkan`). The page says it
 * (web/app/machine.ts `splitMsg`).
 */
export type SplitProblem =
  | { code: 'memory0-min' }
  | { code: 'memory0-max'; max: number }
  | { code: 'nodes'; max: number }
  | { code: 'node'; max: number; mib: number }
  | { code: 'vulkan'; max: number };

/**
 * Why memory 0's `ramSize` and the spill memories' sizes (bytes) aren't a split a machine can have; undefined when they
 * are. Memory 1 holds `reserve` bytes before node 1 ({@link splitRam}).
 */
export function splitError(ramSize: number, spill: number[], reserve = 0): SplitProblem | undefined {
  const mib = (n: number) => n / 2 ** 20;
  if (!Number.isSafeInteger(ramSize) || ramSize < 64 << 20 || ramSize % 65536) return { code: 'memory0-min' };
  if (ramSize > MAX_MEMORY0_RAM) return { code: 'memory0-max', max: mib(MAX_MEMORY0_RAM) };
  if (spill.length > MAX_SPILL) return { code: 'nodes', max: MAX_SPILL };
  const bad = spill.find((s) => !Number.isSafeInteger(s) || s < 65536 || s % 65536 || s > MAX_SPILL_BYTES);
  if (bad !== undefined) return { code: 'node', max: mib(MAX_SPILL_BYTES), mib: mib(bad) };
  if (spill.length && spill[0] > MAX_SPILL_BYTES - reserve) return { code: 'vulkan', max: mib(MAX_SPILL_BYTES - reserve) };
  return undefined;
}
