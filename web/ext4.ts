// A read-only ext2/3/4 reader (M8 loop 5): enough to take a kernel and an
// initrd out of a distribution's /boot, in Node (tools/debian.ts) and in the
// browser (no Node APIs: all I/O goes through `read`, e.g. a web/qcow2.ts
// Disk). Written from the kernel's Documentation/filesystems/ext4 (the on-disk
// format), no code copied. Reads: extent trees of any depth, ext2/3 block
// maps (direct, single, double and triple indirect), holes and uninitialized
// extents (zeros), linear and htree directories (read linearly), fast and
// slow symlinks, 32- and 64-bit group descriptors, meta_bg. Checksums and the
// journal are ignored (a filesystem that needs recovery is read as it is on
// disk). Refused: compression, a separate journal device, dirdata (at open);
// inline data and encrypted files (when read).

/** Exactly `len` bytes at byte `off` of the device, or undefined (past the end, a read error). */
export type ReadFn = (off: number, len: number) => Promise<Uint8Array | undefined>;

export type Inode = {
  ino: number;
  /** i_mode: the type (S_IFMT bits) and the permissions. */
  mode: number;
  size: number;
  flags: number;
  /** i_block, the 60 bytes of extent root, block map or fast symlink. */
  block: Uint8Array;
};

export type DirEntry = { name: string; ino: number };

export type Ext4 = {
  blockSize: number;
  /** The volume label (s_volume_name). */
  label: string;
  inode(ino: number): Promise<Inode>;
  /** Resolves `path` from the root, following symlinks (the last component's too unless `nofollow`). */
  lookup(path: string, nofollow?: boolean): Promise<Inode | undefined>;
  readdir(path: string): Promise<DirEntry[]>;
  readFile(path: string): Promise<Uint8Array>;
  readlink(path: string): Promise<string>;
  /** A file's bytes, from its inode. */
  read(inode: Inode): Promise<Uint8Array>;
};

export const S_IFMT = 0o170000, S_IFDIR = 0o040000, S_IFREG = 0o100000, S_IFLNK = 0o120000;
export const isDir = (i: Inode) => (i.mode & S_IFMT) === S_IFDIR;
export const isFile = (i: Inode) => (i.mode & S_IFMT) === S_IFREG;
export const isLink = (i: Inode) => (i.mode & S_IFMT) === S_IFLNK;

const MAGIC = 0xef53;
const ROOT = 2;
// Incompatible features.
const INCOMPAT_COMPRESSION = 0x1, INCOMPAT_FILETYPE = 0x2, INCOMPAT_JOURNAL_DEV = 0x8, INCOMPAT_META_BG = 0x10;
const INCOMPAT_64BIT = 0x80, INCOMPAT_DIRDATA = 0x1000;
const REFUSED: [number, string][] = [[INCOMPAT_COMPRESSION, 'compression'], [INCOMPAT_JOURNAL_DEV, 'a journal device'], [INCOMPAT_DIRDATA, 'dirdata']];
const RO_COMPAT_SPARSE_SUPER = 0x1;
// Inode flags.
const FL_ENCRYPT = 0x800, FL_EXTENTS = 0x80000, FL_INLINE_DATA = 0x10000000;
const EXTENT_MAGIC = 0xf30a;
const UNINIT = 32768; // ee_len above this: an uninitialized extent of ee_len - 32768 blocks

const u16 = (b: Uint8Array, o: number) => b[o] | b[o + 1] << 8;
const u32 = (b: Uint8Array, o: number) => (b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24) >>> 0;

/** A run of a file: `count` blocks from logical block `logical` at physical block `physical` (0: a hole, zeros). */
type Run = { logical: number; physical: number; count: number };

/** Opens the ext2/3/4 filesystem that starts at byte `offset` of the device. Throws if it isn't one, or uses what we refuse. */
export async function openExt4(read: ReadFn, offset = 0): Promise<Ext4> {
  const at = async (off: number, len: number) => {
    const b = await read(offset + off, len);
    if (!b) throw new Error(`ext4: can't read ${len} bytes at ${offset + off}`);
    return b;
  };
  const sb = await at(1024, 1024);
  if (u16(sb, 0x38) !== MAGIC) throw new Error('ext4: no ext2/3/4 superblock');
  const logBlock = u32(sb, 0x18);
  if (logBlock > 6) throw new Error(`ext4: block size 2^${10 + logBlock}`);
  const bs = 1024 << logBlock;
  const firstDataBlock = u32(sb, 0x14);
  const blocksPerGroup = u32(sb, 0x20);
  const inodesPerGroup = u32(sb, 0x28);
  const rev = u32(sb, 0x4c);
  const inodeSize = rev === 0 ? 128 : u16(sb, 0x58);
  const incompat = u32(sb, 0x60);
  const roCompat = u32(sb, 0x64);
  for (const [bit, what] of REFUSED) if (incompat & bit) throw new Error(`ext4: ${what} is not supported`);
  const descSize = incompat & INCOMPAT_64BIT ? Math.max(32, u16(sb, 0xfe)) : 32;
  const firstMetaBg = u32(sb, 0x104);
  const filetype = (incompat & INCOMPAT_FILETYPE) !== 0;
  const label = new TextDecoder().decode(sb.subarray(0x78, 0x88)).replace(/\0.*$/s, '');
  const descPerBlock = bs / descSize;

  const block = (n: number, count = 1) => at(n * bs, count * bs);

  // Whether group g has a superblock backup (and so, before meta_bg, the descriptors after it).
  const pow = (g: number, b: number) => { let n = 1; while (n < g) n *= b; return n === g; };
  const hasSuper = (g: number) => !(roCompat & RO_COMPAT_SPARSE_SUPER) || g <= 1 || pow(g, 3) || pow(g, 5) || pow(g, 7);

  // Group descriptor blocks, read once each: before meta_bg, right after the superblock;
  // with meta_bg, from s_first_meta_bg on, in the first group of each meta group.
  const descBlocks = new Map<number, Promise<Uint8Array>>();
  const desc = async (g: number) => {
    const i = Math.floor(g / descPerBlock);
    let p = descBlocks.get(i);
    if (!p) {
      let n: number;
      if (!(incompat & INCOMPAT_META_BG) || i < firstMetaBg) n = firstDataBlock + 1 + i;
      else { const first = i * descPerBlock; n = firstDataBlock + first * blocksPerGroup + (hasSuper(first) ? 1 : 0); }
      descBlocks.set(i, (p = block(n)));
    }
    const b = await p;
    return b.subarray((g % descPerBlock) * descSize, (g % descPerBlock + 1) * descSize);
  };

  const inode = async (ino: number): Promise<Inode> => {
    if (ino < 1 || ino > u32(sb, 0)) throw new Error(`ext4: inode ${ino} out of range`);
    const g = Math.floor((ino - 1) / inodesPerGroup);
    const d = await desc(g);
    const table = u32(d, 0x8) + (descSize >= 64 ? u32(d, 0x28) * 2 ** 32 : 0);
    const b = await at(table * bs + ((ino - 1) % inodesPerGroup) * inodeSize, 128);
    return { ino, mode: u16(b, 0), size: u32(b, 0x4) + u32(b, 0x6c) * 2 ** 32, flags: u32(b, 0x20), block: b.slice(0x28, 0x28 + 60) };
  };

  // The runs of a file whose inode maps blocks with an extent tree.
  const extents = async (node: Uint8Array, runs: Run[], depthLeft = 8) => {
    if (u16(node, 0) !== EXTENT_MAGIC) throw new Error('ext4: bad extent header');
    const entries = u16(node, 2);
    const depth = u16(node, 6);
    if (depth > 0 && depthLeft === 0) throw new Error('ext4: extent tree too deep');
    for (let k = 0; k < entries; k++) {
      const e = 12 + k * 12;
      if (depth > 0) {
        await extents(await block(u32(node, e + 4) + u16(node, e + 8) * 2 ** 32), runs, depthLeft - 1);
      } else {
        const len = u16(node, e + 4);
        const physical = u32(node, e + 8) + u16(node, e + 6) * 2 ** 32;
        // Uninitialized extents read as zeros, as holes do.
        runs.push(len > UNINIT ? { logical: u32(node, e), physical: 0, count: len - UNINIT } : { logical: u32(node, e), physical, count: len });
      }
    }
  };

  // The runs of a file mapped by ext2/3's block map: 12 direct pointers, then single, double and triple indirect.
  const blockMap = async (ib: Uint8Array, nblocks: number, runs: Run[]) => {
    const per = bs / 4;
    let logical = 0;
    const add = (physical: number) => {
      const last = runs.at(-1);
      if (last && physical && last.physical && last.physical + last.count === physical && last.logical + last.count === logical) last.count++;
      else if (physical) runs.push({ logical, physical, count: 1 });
      logical++;
    };
    // Pointers to `level`-indirect blocks (level 0: data blocks); a 0 pointer skips all it would have mapped.
    const walk = async (ptr: number, level: number): Promise<void> => {
      if (logical >= nblocks) return;
      if (level === 0) return add(ptr);
      if (!ptr) { logical += per ** level; return; }
      const b = await block(ptr);
      for (let k = 0; k < per && logical < nblocks; k++) await walk(u32(b, k * 4), level - 1);
    };
    for (let k = 0; k < 12; k++) await walk(u32(ib, k * 4), 0);
    for (let level = 1; level <= 3; level++) await walk(u32(ib, (11 + level) * 4), level);
  };

  const readInode = async (i: Inode) => {
    if (i.flags & FL_INLINE_DATA) throw new Error(`ext4: inode ${i.ino} has inline data (not supported)`);
    if (i.flags & FL_ENCRYPT) throw new Error(`ext4: inode ${i.ino} is encrypted`);
    const nblocks = Math.ceil(i.size / bs);
    const runs: Run[] = [];
    if (i.flags & FL_EXTENTS) await extents(i.block, runs);
    else await blockMap(i.block, nblocks, runs);
    const out = new Uint8Array(i.size);
    for (const r of runs) {
      if (!r.physical || r.logical >= nblocks) continue;
      const count = Math.min(r.count, nblocks - r.logical);
      const start = r.logical * bs;
      const data = await block(r.physical, count);
      out.set(data.subarray(0, Math.min(count * bs, i.size - start)), start);
    }
    return out;
  };

  const entries = async (dir: Inode) => {
    const b = await readInode(dir);
    const out: DirEntry[] = [];
    for (let o = 0; o < b.length;) {
      const ino = u32(b, o);
      let rec = u16(b, o + 4);
      if (rec === 0 || rec === 65535) rec = Math.min(65536, bs); // 64 KiB blocks
      if (rec < 8 || o + rec > b.length) throw new Error(`ext4: bad directory entry in inode ${dir.ino}`);
      const nameLen = filetype ? b[o + 6] : u16(b, o + 6);
      // Inode 0: an unused entry, an htree node's fake entry, or a checksum tail.
      if (ino) out.push({ name: new TextDecoder().decode(b.subarray(o + 8, o + 8 + nameLen)), ino });
      o += rec;
    }
    return out;
  };

  const linkTarget = async (i: Inode) =>
    new TextDecoder().decode(i.size < 60 && !(i.flags & (FL_EXTENTS | FL_INLINE_DATA)) ? i.block.subarray(0, i.size) : await readInode(i));

  const lookup = async (path: string, nofollow = false) => {
    let parts = path.split('/').filter((p) => p && p !== '.');
    let cur = await inode(ROOT);
    let links = 0;
    while (parts.length) {
      const name = parts.shift()!;
      if (!isDir(cur)) return undefined;
      const e = (await entries(cur)).find((x) => x.name === name);
      if (!e) return undefined;
      const next = await inode(e.ino);
      if (isLink(next) && (parts.length || !nofollow)) {
        if (++links > 40) throw new Error(`ext4: too many symlinks in ${path}`);
        const target = await linkTarget(next);
        parts = [...target.split('/').filter((p) => p && p !== '.'), ...parts];
        if (target.startsWith('/')) cur = await inode(ROOT); // else relative to the link's directory, cur
        continue;
      }
      cur = next; // '..' is a directory entry like any other
    }
    return cur;
  };

  const need = async (path: string, nofollow = false) => {
    const i = await lookup(path, nofollow);
    if (!i) throw new Error(`ext4: no ${path}`);
    return i;
  };

  return {
    blockSize: bs,
    label,
    inode,
    lookup,
    read: readInode,
    async readdir(path) {
      const d = await need(path);
      if (!isDir(d)) throw new Error(`ext4: ${path} is not a directory`);
      return (await entries(d)).filter((e) => e.name !== '.' && e.name !== '..');
    },
    async readFile(path) {
      const f = await need(path);
      if (!isFile(f)) throw new Error(`ext4: ${path} is not a regular file`);
      return readInode(f);
    },
    async readlink(path) {
      const l = await need(path, true);
      if (!isLink(l)) throw new Error(`ext4: ${path} is not a symlink`);
      return linkTarget(l);
    },
  };
}
