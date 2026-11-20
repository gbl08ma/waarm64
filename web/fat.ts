// A small FAT12 filesystem image with files in its root directory (M8 phase B):
// the NoCloud seed disk (label CIDATA, `meta-data` and `user-data`) that
// unlocks Alpine's UEFI cloud images (docs/firmware.md). Long names get VFAT
// entries, as mkfs.fat and mcopy write them. No partition table: Linux and
// EDK2 read a FAT on the whole disk. Timestamps are 2026-09-01 00:00, so the
// bytes depend only on the files.

const SECTOR = 512;
const CLUSTER_SECTORS = 4;
const ROOT_ENTRIES = 64;
/** 2026-09-01 00:00:00 as a FAT date and time. */
const DATE = ((2026 - 1980) << 9) | (9 << 5) | 1;
const TIME = 0;

/** A FAT12 image of `size` bytes (a multiple of 512, 256 KiB to 8 MiB) labelled `label`, holding `files` in its root. */
export function fatImage(
  label: string,
  files: { name: string; data: string | Uint8Array }[],
  size = 1 << 20,
): Uint8Array {
  const sectors = size / SECTOR;
  if (!Number.isInteger(sectors) || size < 256 << 10 || size > 8 << 20) throw new Error(`fatImage: ${size} bytes`);
  if (files.length * 3 + 1 > ROOT_ENTRIES) throw new Error('fatImage: too many files');
  const img = new Uint8Array(size);
  const view = new DataView(img.buffer);
  const rootSectors = (ROOT_ENTRIES * 32) / SECTOR;
  // Clusters, then the FAT (1.5 bytes a cluster, two reserved entries) that describes them.
  let fatSectors = 1;
  const clusters = () => Math.floor((sectors - 1 - 2 * fatSectors - rootSectors) / CLUSTER_SECTORS);
  while (Math.ceil(((clusters() + 2) * 3) / 2 / SECTOR) > fatSectors) fatSectors++;
  const count = clusters();
  if (count >= 4085) throw new Error('fatImage: too many clusters for FAT12');

  // The boot sector and its BIOS parameter block.
  img.set([0xeb, 0x3c, 0x90], 0);
  img.set(ascii('WAARM64', 8), 3);
  view.setUint16(11, SECTOR, true);
  img[13] = CLUSTER_SECTORS;
  view.setUint16(14, 1, true); // reserved sectors
  img[16] = 2; // FATs
  view.setUint16(17, ROOT_ENTRIES, true);
  view.setUint16(19, sectors, true);
  img[21] = 0xf8; // fixed disk
  view.setUint16(22, fatSectors, true);
  view.setUint16(24, 32, true); // sectors per track
  view.setUint16(26, 64, true); // heads
  img[36] = 0x80; // drive number
  img[38] = 0x29; // extended boot signature
  view.setUint32(39, 0x5745_4250, true); // volume ID "WEBP"
  img.set(ascii(label.toUpperCase(), 11), 43);
  img.set(ascii('FAT12', 8), 54);
  img[510] = 0x55;
  img[511] = 0xaa;

  const fat = new Uint8Array(fatSectors * SECTOR);
  const setFat = (n: number, v: number) => {
    const o = Math.floor((n * 3) / 2);
    if (n & 1) {
      fat[o] = (fat[o] & 0x0f) | ((v << 4) & 0xf0);
      fat[o + 1] = v >> 4;
    } else {
      fat[o] = v & 0xff;
      fat[o + 1] = (fat[o + 1] & 0xf0) | ((v >> 8) & 0x0f);
    }
  };
  setFat(0, 0xff8);
  setFat(1, 0xfff);
  const rootAt = SECTOR * (1 + 2 * fatSectors);
  const dataAt = rootAt + rootSectors * SECTOR;
  const clusterBytes = CLUSTER_SECTORS * SECTOR;
  let entry = 0;
  const dirEntry = (bytes: Uint8Array) => img.set(bytes, rootAt + 32 * entry++);
  const short = (name: Uint8Array, attr: number, cluster: number, length: number) => {
    const e = new Uint8Array(32);
    const v = new DataView(e.buffer);
    e.set(name, 0);
    e[11] = attr;
    for (const o of [14, 22]) v.setUint16(o, TIME, true); // created, written
    for (const o of [16, 18, 24]) v.setUint16(o, DATE, true); // created, accessed, written
    v.setUint16(26, cluster, true);
    v.setUint32(28, length, true);
    dirEntry(e);
  };
  short(ascii(label.toUpperCase(), 11), 0x08, 0, 0);

  let next = 2;
  files.forEach(({ name, data }, i) => {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const n = Math.ceil(bytes.length / clusterBytes);
    if (next + n > count + 2) throw new Error("fatImage: the files don't fit");
    const first = n ? next : 0;
    for (let k = 0; k < n; k++) setFat(next + k, k === n - 1 ? 0xfff : next + k + 1);
    img.set(bytes, dataAt + (next - 2) * clusterBytes);
    next += n;
    const sfn = shortName(name, i);
    if (sfn.long) for (const e of longEntries(name, sfn.bytes)) dirEntry(e);
    short(sfn.bytes, 0x20, first, bytes.length);
  });
  for (const k of [0, 1]) img.set(fat, SECTOR * (1 + k * fatSectors));
  return img;
}

function ascii(s: string, n: number) {
  const b = new Uint8Array(n).fill(0x20);
  for (let i = 0; i < Math.min(n, s.length); i++) b[i] = s.charCodeAt(i);
  return b;
}

/** The 8.3 name for `name`: itself if it is one (upper case), else a `~N` alias with long entries. */
function shortName(name: string, i: number): { bytes: Uint8Array; long: boolean } {
  const m = /^([A-Z0-9_]{1,8})(?:\.([A-Z0-9_]{1,3}))?$/.exec(name);
  if (m) return { bytes: ascii(m[1].padEnd(8) + (m[2] ?? '').padEnd(3), 11), long: false };
  const [base, ext = ''] = name
    .toUpperCase()
    .replace(/[^A-Z0-9._]/g, '')
    .split(/\.(?=[^.]*$)/);
  const tail = `~${i + 1}`;
  return {
    bytes: ascii((base.slice(0, 8 - tail.length) + tail).padEnd(8) + ext.slice(0, 3).padEnd(3), 11),
    long: true,
  };
}

/** VFAT long-name entries for `name`, last part first, as they precede the short entry. */
function longEntries(name: string, sfn: Uint8Array): Uint8Array[] {
  let sum = 0;
  for (const c of sfn) sum = (((sum & 1) << 7) + (sum >> 1) + c) & 0xff;
  const units = [...name].map((c) => c.charCodeAt(0));
  units.push(0);
  while (units.length % 13) units.push(0xffff);
  const parts = units.length / 13;
  const out: Uint8Array[] = [];
  for (let p = parts - 1; p >= 0; p--) {
    const e = new Uint8Array(32);
    const v = new DataView(e.buffer);
    e[0] = (p + 1) | (p === parts - 1 ? 0x40 : 0);
    e[11] = 0x0f;
    e[13] = sum;
    const at = [1, 3, 5, 7, 9, 14, 16, 18, 20, 22, 24, 28, 30];
    at.forEach((o, k) => v.setUint16(o, units[p * 13 + k], true));
    out.push(e);
  }
  return out;
}
