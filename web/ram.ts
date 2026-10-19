// Guest RAM as the device backends see it (docs/plans/spill-memories.md): memory 0's RAM, then each spill memory,
// and the segments the core posts into them. A small module of its own: the GPU worker imports it.

/** A guest buffer: `len` bytes at `off` in memory `mem` (0: memory 0's RAM, from its first byte; k: spill memory k, ABI 40). */
export type Segment = { off: number; len: number; mem: number };
/** Guest RAM by memory: memory 0's RAM, then each spill memory (docs/plans/spill-memories.md). */
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
