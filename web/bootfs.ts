// Partition tables and a distribution's kernel and initrd (M8 loop 5): the GPT
// or MBR of a disk, then the /boot of the first ext2/3/4 partition that has a
// kernel (web/ext4.ts). No Node APIs, like ext4.ts: tools/debian.ts uses it to
// prepare Debian, and the page may later read /boot at start time
// (docs/backlog.md "Booting conventional arm64 disk images unmodified").
import { openExt4, type Ext4, type ReadFn } from './ext4.ts';

export type Partition = {
  /** 1-based, as Linux numbers them (vda1). */
  number: number;
  /** Bytes from the start of the disk. */
  start: number;
  size: number;
  /** GPT: the type GUID (upper case); MBR: the type byte in hex (e.g. "83"). */
  type: string;
  /** GPT: the partition's name. */
  name?: string;
};

const u32 = (b: Uint8Array, o: number) => (b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24) >>> 0;
const u64 = (b: Uint8Array, o: number) => u32(b, o) + u32(b, o + 4) * 2 ** 32;
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
/** A GUID as written: the first three fields are little-endian. */
const guid = (b: Uint8Array) => [hex(b.slice(0, 4).reverse()), hex(b.slice(4, 6).reverse()), hex(b.slice(6, 8).reverse()), hex(b.slice(8, 10)), hex(b.slice(10, 16))].join('-');

/** The disk's partitions: GPT (512-byte sectors) or MBR primaries; [] when it has neither (e.g. a bare filesystem). */
export async function partitions(read: ReadFn): Promise<Partition[]> {
  const mbr = await read(0, 512);
  if (!mbr || mbr[510] !== 0x55 || mbr[511] !== 0xaa) return [];
  const primaries = [0, 1, 2, 3].map((k) => mbr.subarray(446 + k * 16, 462 + k * 16));
  if (primaries.some((e) => e[4] === 0xee)) {
    const h = await read(512, 92);
    if (!h || new TextDecoder().decode(h.subarray(0, 8)) !== 'EFI PART') throw new Error('gpt: a protective MBR without a GPT header');
    const count = u32(h, 0x50), size = u32(h, 0x54);
    if (size < 128 || count > 1024) throw new Error(`gpt: ${count} entries of ${size} bytes`);
    const t = await read(u64(h, 0x48) * 512, count * size);
    if (!t) throw new Error('gpt: the partition entries are past the end of the disk');
    const out: Partition[] = [];
    for (let k = 0; k < count; k++) {
      const e = t.subarray(k * size, (k + 1) * size);
      if (e.subarray(0, 16).every((x) => x === 0)) continue; // unused
      const first = u64(e, 32), last = u64(e, 40);
      const name = new TextDecoder('utf-16le').decode(e.subarray(56, 128)).replace(/\0.*$/s, '');
      out.push({ number: k + 1, start: first * 512, size: (last - first + 1) * 512, type: guid(e.subarray(0, 16)), name });
    }
    return out;
  }
  // MBR: primaries only (logical partitions inside an extended one aren't listed).
  return primaries.flatMap((e, k) => e[4] && u32(e, 12) ? [{ number: k + 1, start: u32(e, 8) * 512, size: u32(e, 12) * 512, type: e[4].toString(16).padStart(2, '0') }] : []);
}

export type BootFiles = {
  partition?: Partition;
  fs: Ext4;
  /** The kernel's version, from /boot/vmlinuz-<version>. */
  version: string;
  kernel: string;
  initrd?: string;
};

/**
 * The kernel and initrd a distribution installed: the first partition (or the bare disk) with an
 * ext2/3/4 filesystem whose /boot has `vmlinuz-<version>`, with `initrd.img-<version>` if present.
 * Several kernels: the highest version (as `sort -V` would order them). Undefined if none.
 */
export async function findBootFiles(read: ReadFn): Promise<BootFiles | undefined> {
  const parts = await partitions(read);
  for (const partition of parts.length ? parts : [undefined]) {
    const fs = await openExt4(read, partition?.start ?? 0).catch(() => undefined);
    const boot = fs && await fs.readdir('/boot').catch(() => undefined);
    if (!fs || !boot) continue;
    const names = new Set(boot.map((e) => e.name));
    const versions = [...names].flatMap((n) => n.startsWith('vmlinuz-') ? [n.slice(8)] : []).sort(compareVersions);
    const version = versions.at(-1);
    if (version === undefined) continue;
    const initrd = names.has(`initrd.img-${version}`) ? `/boot/initrd.img-${version}` : undefined;
    return { partition, fs, version, kernel: `/boot/vmlinuz-${version}`, initrd };
  }
  return undefined;
}

/** Version order: runs of digits compare as numbers, the rest as text. */
export function compareVersions(a: string, b: string) {
  const split = (s: string) => s.match(/\d+|\D+/g) ?? [];
  const x = split(a), y = split(b);
  for (let k = 0; k < Math.min(x.length, y.length); k++) {
    if (x[k] === y[k]) continue;
    const nx = /^\d/.test(x[k]), ny = /^\d/.test(y[k]);
    if (nx && ny) return Number(x[k]) - Number(y[k]) || x[k].localeCompare(y[k]);
    return x[k] < y[k] ? -1 : 1;
  }
  return x.length - y.length;
}
