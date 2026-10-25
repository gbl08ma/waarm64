// Guest RAM as the device backends see it (docs/spill-memories.md): memory 0's RAM, then each spill memory,
// and the segments the core posts into them; and how a machine's RAM splits into them. A small module of its own:
// the GPU worker and the page's main thread import it.

/** A guest buffer: `len` bytes at `off` in memory `mem` (0: memory 0's RAM, from its first byte; k: spill memory k, ABI 40). */
export type Segment = { off: number; len: number; mem: number };
/** Guest RAM by memory: memory 0's RAM, then each spill memory (docs/spill-memories.md). */
export type Ram = Uint8Array[];
/** A segment's bytes, in place. */
export const bytes = (ram: Ram, s: Segment) => ram[s.mem].subarray(s.off, s.off + s.len);
/** Where each memory's RAM is in the guest's physical address space, memory 0 first (`VmConfig::spill_layout`). */
export type RamLayout = { pa: number; size: number }[];
/** Guest RAM's base (`vm::RAM_BASE`). */
export const RAM_BASE = 0x4000_0000;
/** The segment of `len` bytes at guest PA `pa`, if they lie in one memory's RAM (backends handed guest PAs: virtio-gpu's backing). */
export function locate(layout: RamLayout, pa: bigint, len: bigint): Segment | undefined {
  for (const [mem, r] of layout.entries()) {
    const off = pa - BigInt(r.pa);
    if (off >= 0n && len <= BigInt(r.size) - off) return { off: Number(off), len: Number(len), mem };
  }
}
/** The spill memories' layout past `ramSize` bytes of memory 0, as the core places them (1 GiB boundaries, a hole between). */
export function ramLayout(ramSize: number, spill: number[] = []): RamLayout {
  const layout = [{ pa: RAM_BASE, size: ramSize }];
  let end = RAM_BASE + ramSize;
  for (const size of spill) {
    const pa = (Math.floor(end / 2 ** 30) + 1) * 2 ** 30;
    layout.push({ pa, size });
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

/** The largest spill memory (a whole wasm32 memory) and how many a machine has at most (core/src/mem.rs `MAX_SPILL`). */
export const MAX_SPILL_BYTES = 2 ** 32;
export const MAX_SPILL = 8;

/**
 * The automatic split of `total` bytes of guest RAM (a 64 KiB multiple): memory 0 as large as it goes
 * ({@link MAX_MEMORY0_RAM}, less `reserve` bytes memory 0 must also hold: a Venus machine's window and renderer,
 * web/devices.ts), then spill memories of up to 4 GiB (docs/spill-memories.md).
 */
export function splitRam(total: number, reserve = 0): { ramSize: number; spill: number[] } {
  const ramSize = Math.min(total, MAX_MEMORY0_RAM - reserve);
  const spill: number[] = [];
  for (let left = total - ramSize; left > 0; left -= MAX_SPILL_BYTES) spill.push(Math.min(left, MAX_SPILL_BYTES));
  if (spill.length > MAX_SPILL) throw new RangeError(`${total} bytes of RAM need more than ${MAX_SPILL} spill memories`);
  return { ramSize, spill };
}

/** Why memory 0's `ramSize` and the spill memories' sizes (bytes) aren't a split a machine can have, in words for the user; undefined when they are. */
export function splitError(ramSize: number, spill: number[]): string | undefined {
  const mib = (n: number) => `${n / 2 ** 20} MiB`;
  if (!Number.isSafeInteger(ramSize) || ramSize < 64 << 20 || ramSize % 65536) return 'memory 0 needs at least 64 MiB';
  if (ramSize > MAX_MEMORY0_RAM) return `memory 0 holds at most ${mib(MAX_MEMORY0_RAM)}`;
  if (spill.length > MAX_SPILL) return `at most ${MAX_SPILL} NUMA nodes past memory 0`;
  const bad = spill.find((s) => !Number.isSafeInteger(s) || s < 65536 || s % 65536 || s > MAX_SPILL_BYTES);
  if (bad !== undefined) return `a NUMA node holds 1 to ${mib(MAX_SPILL_BYTES)} (not ${bad / 2 ** 20})`;
  return undefined;
}
