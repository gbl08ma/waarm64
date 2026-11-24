// virtio-blk's backend (docs/devices.md "blk"): a disk over its source, through its overlay, with its surface's
// answers (web/surface.ts).
import { msgOf } from './msg.ts';
import { IoStats } from './iostats.ts';
import { releaseStores } from './diskcache.ts';
import { blockList, overlay, type OverlayFiles, type WritableDisk } from './overlay.ts';
import { diskInspector, RANGE, type LiveDisk, type LiveImage } from './surface.ts';
import { openDisk, type Disk, type Inflater } from './qcow2.ts';
import { bytes, type Ram } from './ram.ts';
import { gather, scatter, type Backend, type Ctx, type Request } from './virtio.ts';
import type { Source } from './disk-sources.ts';

// virtio-blk request types and status (virtio 1.2 §5.2.6).
const T_IN = 0;
const T_OUT = 1;
const T_FLUSH = 4;
const T_GET_ID = 8;
const T_DISCARD = 11;
const T_WRITE_ZEROES = 13;
/** The most sectors one DISCARD or WRITE_ZEROES segment covers (2 GiB, whole 4 KiB blocks). */
export const BLK_MAX_UNMAP_SECTORS = 1 << 22;
const S_OK = 0;
const S_IOERR = 1;
const S_UNSUPP = 2;

/**
 * A virtio-blk device over `src` (HTTP ranges, a stored disk, a file in Node; qcow2's compressed clusters inflated a
 * request's together: web/deflate.ts, and on web/inflate-pool.ts's workers where there are workers), writable through
 * `files` (an overlay) or by `src` itself (a ramdisk); with `discard`, DISCARD and WRITE_ZEROES reach the overlay
 * (`deviceEntry` offers them). `onFull`: a write
 * the browser's storage refused (a short write, `QuotaExceededError`) failed the guest's request, told once until a
 * write lands again (a ramdisk says so through its own `onFull`). `size`: the disk's size as the guest sees it (the
 * spec's), which an overlay over a smaller image grows to (docs/machines.md §4.5; its meta's own size counts too);
 * `diskSize`: then a stored or blank source's own size (its source is opened at the guest's), for the surface alone.
 * `inflater`: where compressed clusters are inflated besides this thread (the device worker's one pool, which
 * `Devices` makes at its first disk that reads an image and closes at its own close; none: on this thread alone).
 */
export function blk(
  ctx: Ctx,
  src: Source | WritableDisk,
  files?: OverlayFiles,
  discard = false,
  st?: IoStats,
  serial = 'waarm64-blk',
  concurrent = false,
  onFull?: () => void,
  size?: number,
  diskSize?: number,
  inflater?: () => Inflater | undefined,
): Backend {
  let rw: WritableDisk | undefined;
  let base: Disk;
  const plain = src; // before the stats' wrapping: the surface's reads aren't the guest's
  if ('write' in src) {
    base = rw = src; // a disk that takes writes in itself (a ramdisk)
  } else {
    if (st) {
      const { read, readAsync } = src;
      src = {
        ...src,
        read: (off, len) => st.read(off, len, () => read(off, len)),
        readAsync: readAsync && ((off, len) => st.readAsync(off, len, () => readAsync(off, len))),
      };
      if (files) files = { ...files, data: st.file('data', files.data), map: st.file('map', files.map) };
    }
    const s = src;
    concurrent &&= !!s.readAsync;
    base = openDisk(
      (off, len) => (len === 0 ? new Uint8Array(0) : s.read(off, len)),
      s.size,
      inflater?.(),
      concurrent ? (off, len) => (len === 0 ? Promise.resolve(new Uint8Array(0)) : s.readAsync!(off, len)) : undefined,
    );
    rw = files && overlay(base, files.data, files.map, files.meta, size);
  }
  const disk: Disk = rw ?? base;
  const io = ctx.io ?? new Float64Array(2); // bytes read, written (completed requests)
  /** Whether the user was told the storage is full (since the last write that landed). */
  let told = false;
  /**
   * A write: true when it landed; false when it failed, with `onFull` told when the storage refused it (a write that
   * returns false is a short write or a refused one; `QuotaExceededError` is thrown by some sync handles).
   */
  const attempt = async (w: () => Promise<boolean>): Promise<boolean | 'full'> => {
    let full: boolean;
    try {
      if (await w()) return true;
      full = true;
    } catch (e) {
      full = (e as DOMException)?.name === 'QuotaExceededError' || msgOf(e)?.key === 'disks:overlay.storageFull';
    }
    return full ? 'full' : false;
  };
  /**
   * A change to the overlay (a write, a zeroing, a discard): true when it landed. One the storage refused (most likely
   * OPFS over the quota) gets the remote disks' kept blocks out of the way and is tried once more; still refused, the
   * user is told (`outcome`).
   */
  const change = async (w: () => Promise<boolean>) => {
    let tried = await attempt(w);
    if (tried !== true && releaseStores()) tried = await attempt(w);
    return outcome(tried);
  };
  const outcome = (r: boolean | 'full') => {
    if (r === true) told = false;
    else if (r === 'full' && onFull && !told) {
      told = true;
      onFull();
    }
    return r === true;
  };
  const backend: Backend = {
    async request(r) {
      const ram = ctx.ram();
      const last = r.write.at(-1);
      if (!last || last.len === 0) return 0; // no status byte: nothing to answer with
      // Data: every writable byte but the status byte at the end.
      const data = [...r.write.slice(0, -1), { ...last, len: last.len - 1 }];
      const room = data.reduce((n, s) => n + s.len, 0);
      const h = new DataView(gather(ram, r.read, 16).slice().buffer);
      const op = h.byteLength === 16 ? h.getUint32(0, true) : -1;
      if (st)
        st.size(
          ({ 0: 'read', 1: 'write', 4: 'flush' } as Record<number, string>)[op] ?? `op${op}`,
          op === T_OUT ? r.read.reduce((k, x) => k + x.len, 0) - 16 : room,
        );
      let [status, n] = [S_UNSUPP, 0];
      if (h.byteLength === 16 && h.getUint32(0, true) === T_IN) {
        const bytes = await disk.read(Number(h.getBigUint64(8, true)) * 512, room).catch(() => undefined); // IOERR, not a failed device
        if (bytes) st ? st.time('scatter', bytes.length, () => scatter(ram, data, bytes)) : scatter(ram, data, bytes);
        [status, n] = bytes ? [S_OK, room] : [S_IOERR, 0];
        if (bytes) io[0] += room;
      } else if (h.byteLength === 16 && h.getUint32(0, true) === T_GET_ID) {
        const id = new Uint8Array(20);
        id.set(new TextEncoder().encode(serial).subarray(0, 20));
        scatter(ram, data, id.subarray(0, room));
        [status, n] = [S_OK, Math.min(room, 20)];
      } else if (h.byteLength === 16 && h.getUint32(0, true) === T_OUT) {
        // The data follows the header in the readable buffers. Read-only: IOERR.
        const len = r.read.reduce((k, s) => k + s.len, 0);
        const payload = st ? st.time('gather', len, () => gather(ram, r.read, len)) : gather(ram, r.read, len);
        const ok = rw
          ? await change(() => rw.write(Number(h.getBigUint64(8, true)) * 512, payload.subarray(16)))
          : false;
        status = ok ? S_OK : S_IOERR;
        if (ok) io[1] += len - 16;
      } else if (h.byteLength === 16 && h.getUint32(0, true) === T_FLUSH && rw) {
        st ? st.time('flush', 0, () => rw.flush()) : rw.flush();
        status = S_OK;
      } else if (
        h.byteLength === 16 &&
        (h.getUint32(0, true) === T_DISCARD || h.getUint32(0, true) === T_WRITE_ZEROES) &&
        rw &&
        discard
      ) {
        // One segment after the header (max_*_seg is 1): sector (u64), sectors (u32), flags (u32; bit 0: unmap,
        // which a WRITE_ZEROES may set and we always do, and a DISCARD must not: UNSUPP, as for unknown flags).
        const zeroes = h.getUint32(0, true) === T_WRITE_ZEROES;
        const len = r.read.reduce((k, s) => k + s.len, 0);
        const seg = new DataView(gather(ram, r.read, len).slice(16).buffer);
        if (seg.byteLength !== 16) status = S_IOERR;
        else if (seg.getUint32(12, true) & (zeroes ? ~1 : ~0)) status = S_UNSUPP;
        else {
          const [off, bytes] = [Number(seg.getBigUint64(0, true)) * 512, seg.getUint32(8, true) * 512];
          const ok =
            bytes <= BLK_MAX_UNMAP_SECTORS * 512 &&
            off + bytes <= disk.size &&
            (await change(zeroes ? () => rw.zero(off, bytes) : async () => rw.discard(off, bytes)));
          status = ok ? S_OK : S_IOERR;
        }
      }
      bytes(ram, last)[last.len - 1] = status;
      return n + 1;
    },
    reset() {},
    // For a snapshot, the VM paused: the blocks, and the generation it pins, with the next change set to move it on.
    written:
      rw &&
      (() => {
        const generation = rw.generation?.();
        rw.epoch?.();
        return { blocks: blockList(rw), generation };
      }),
    blocks:
      rw &&
      ((blocks) => {
        if (rw.blocks) {
          // An overlay's: runs of slots in one read each.
          const out = rw.blocks(blocks);
          if (!out)
            throw new Error(
              `the disk's changes can't be read from the browser's storage (blocks ${blocks[0]} to ${blocks[blocks.length - 1]})`,
            );
          return out;
        }
        const out = new Uint8Array(blocks.length * 4096);
        blocks.forEach((b, k) => {
          const bytes = rw.block(b);
          if (!bytes) throw new Error(`the disk's changes can't be read from the browser's storage (block ${b})`);
          out.set(bytes, k * 4096);
        });
        return out;
      }),
    close() {
      if (!('write' in src)) src.close?.();
      files?.close();
    },
  };
  if (st) {
    const request = backend.request;
    backend.request = async (r) => {
      const t = performance.now();
      const n = (await request.call(backend, r)) as number;
      st.add('request', 0, performance.now() - t);
      return n;
    };
  }
  if (concurrent) {
    // Several requests at once (`Devices.poll` completes them as they resolve, realtime only): a read starts once the
    // last write, flush or discard before it ended; any other request waits for every request before it (the overlay
    // changes one request at a time, and a FLUSH covers the writes completed before it).
    const request = backend.request;
    let barrier: Promise<unknown> = Promise.resolve();
    const inflight = new Set<Promise<number>>();
    backend.concurrent = true;
    backend.request = (r) => {
      const h = gather(ctx.ram(), r.read, 16);
      const read = h.byteLength === 16 && new DataView(h.slice().buffer).getUint32(0, true) === T_IN;
      const p = (read ? barrier : Promise.all(inflight)).then(() => request.call(backend, r)) as Promise<number>;
      inflight.add(p);
      const settled = p.then(
        () => {},
        () => {},
      );
      void settled.then(() => inflight.delete(p));
      if (!read) barrier = settled;
      return p;
    };
  }
  if (rw?.compact && rw.bytes) {
    // The compaction moves blocks between slots: it runs with none of the disk's requests in flight (one may wait on
    // the base's bytes with slots taken), and whole, synchronously, so none starts meanwhile.
    const [request, compact, size] = [backend.request, rw.compact, rw.bytes];
    const running = new Set<Promise<unknown>>();
    backend.request = (r) => {
      const p = request.call(backend, r);
      if (p instanceof Promise) {
        running.add(p);
        void p.then(
          () => running.delete(p),
          () => running.delete(p),
        );
      }
      return p;
    };
    backend.compact = async (measure) => {
      const before = size();
      if (measure) return { before, after: before };
      while (running.size) await Promise.allSettled(running);
      compact(); // a failed move leaves the block where it was (copied before its map entry moves)
      return { before, after: size() };
    };
  }
  const inspector = blkInspector(ctx, backend, plain, base, files ? rw : undefined, diskSize);
  backend.inspect = inspector.inspect;
  const close = backend.close!;
  backend.close = () => {
    inspector.close(); // the activity wrapper off, its timer gone
    close();
  };
  return backend;
}

/**
 * What a blk request reads or changes, as ranges (4 MiB): the first, the last, and whether it changes them (a write, a
 * zeroing, a discard); undefined for any other request. Its 16-byte header as `blk` reads it (a DISCARD's or a
 * WRITE_ZEROES' segment after it).
 */
function rangesOfRequest(ram: Ram, r: Request): [number, number, boolean] | undefined {
  const h = gather(ram, r.read, 32).slice();
  if (h.byteLength < 16) return undefined;
  const v = new DataView(h.buffer);
  const op = v.getUint32(0, true);
  let [off, len] = [Number(v.getBigUint64(8, true)) * 512, 0];
  if (op === T_IN) len = r.write.reduce((k, x) => k + x.len, 0) - 1;
  else if (op === T_OUT) len = r.read.reduce((k, x) => k + x.len, 0) - 16;
  else if ((op === T_DISCARD || op === T_WRITE_ZEROES) && h.byteLength === 32)
    [off, len] = [Number(v.getBigUint64(16, true)) * 512, v.getUint32(24, true) * 512];
  else return undefined;
  if (len <= 0) return undefined;
  return [Math.floor(off / RANGE), Math.floor((off + len - 1) / RANGE), op !== T_IN];
}

/**
 * A blk device's answers about its surface (web/surface.ts `diskInspector`): its disk (`src`: a ramdisk's chunks, a
 * stored or blank disk's map, an image's size alone) and its overlay (`ov`). The activity wrapper goes around the
 * outermost `backend.request` (the stats', concurrent and compaction wrappers are made before it, at the build, and
 * `Devices` calls `request` from the backend at each request), and the request it wrapped is put back as it was.
 */
function blkInspector(
  ctx: Ctx,
  backend: Backend,
  src: Source | WritableDisk,
  base: Disk,
  ov: WritableDisk | undefined,
  diskSize?: number,
) {
  let disk: LiveDisk['disk'];
  if ('write' in src) {
    const ram = src;
    disk = {
      kind: 'ram',
      id: 'disk',
      size: ram.size,
      get chunks() {
        return ram.chunkKeys?.() ?? [];
      },
      read: (b) => ram.block(b),
    };
  } else if (src.leaves) {
    // A stored or blank disk under a grown overlay is opened at the guest's size: its own is the spec's `diskSize`.
    const [s, own] = [src, Math.min(src.size, diskSize ?? src.size)];
    disk = {
      kind: 'map',
      id: 'disk',
      size: own,
      leaves: s.leaves!(),
      read: (b) => (b * 4096 < own ? s.read(b * 4096, Math.min(4096, own - b * 4096)) : undefined),
    };
  } else disk = liveImage(src, base);
  const o = ov?.leaves && ov;
  let inner: Backend['request'] | undefined;
  return diskInspector(
    {
      disk,
      overlay: o ? { id: 'overlay', size: o.size, leaves: () => o.leaves!(), read: (b) => o.block(b) } : undefined,
    },
    {
      install(mark) {
        const request = (inner = backend.request);
        backend.request = (r) => {
          const span = rangesOfRequest(ctx.ram(), r);
          if (span) mark(...span);
          const p = request.call(backend, r);
          // A change counted again once it ended (an answer between its start and its end saw it half made).
          if (span?.[2] && p instanceof Promise)
            void p.then(
              () => mark(...span),
              () => {},
            );
          return p;
        };
      },
      uninstall() {
        if (inner) backend.request = inner;
        inner = undefined;
      },
    },
  );
}

/**
 * A running image's disk layer (web/surface.ts `LiveImage`), examined at an inspect, never on a request's path: a
 * qcow2's clusters from its L2 tables, those not read yet read once from a local file (a bounded read: qcow2.ts
 * `ALLOCATION_MAX`; past it, the tables the guest has read) but from a remote image only where the block cache or OPFS
 * holds them (nothing is fetched for the map): what's under the others isn't examined yet; a raw image not examined. A
 * remote image's with the blocks this browser keeps. The content check reads a local qcow2's blocks of data (through
 * the image), no raw image's and no remote one's.
 */
function liveImage(src: Source, base: Disk): LiveDisk['disk'] {
  const kept = src.kept;
  const here = (off: number, len: number) => {
    if (!kept) return true;
    for (let k = Math.floor(off / kept.block); k <= Math.floor((off + len - 1) / kept.block); k++)
      if (!kept.has(k)) return false;
    return true;
  };
  const size = base.size;
  const examine = (): ReturnType<LiveImage['examine']> => {
    if (base.format === 'raw' || !base.allocation)
      return { kind: 'opaque', id: 'disk', size, why: 'raw', ...(kept ? { kept } : {}) };
    const allocation = base.allocation((off, n) => (here(off, n) ? src.read(off, n) : undefined));
    return {
      kind: 'clusters',
      id: 'disk',
      size,
      allocation,
      why: kept ? 'tables' : 'large',
      ...(kept ? { kept } : {}),
    };
  };
  // A raw image's blocks aren't examined (nor read); a remote qcow2's would be fetched.
  const read = (b: number) =>
    base.format === 'raw' || kept ? undefined : base.read(b * 4096, Math.min(4096, size - b * 4096));
  return { kind: 'image', id: 'disk', size, examine, read };
}
