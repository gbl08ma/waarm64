// A disk's surface while no machine on this page runs it (docs/plans/surface.md §2): the questions of web/surface.ts
// answered from the files, read whole and closed at once: a stored disk's `map`, an overlay's `map` and `meta` (its own
// size), and for a range's content check the held blocks of that range from `data`. Read-only handles under the shared
// lock (web/overlay.ts `openOverlay`'s `readOnly`): a machine in another tab that has the overlay open holds its lock
// exclusively, and after a short wait the answer says so; the page's checks of whether a machine has the files open
// leave the job's holds out (`SURFACE_READER_LOCK`). A stored disk whose merge was interrupted is said so, not drawn. A file's qcow2 image the page may read without asking (its
// handle's permission granted) has its L2 tables read (web/qcow2.ts `readAllocation`, bounded) for its clusters.
// web/app/surface-worker.ts runs it; Node's tests call it.
import { msg, msgOf } from '../msg.ts';
import { openOverlay, readMap, readMeta, SURFACE_READER_LOCK, type MapLeaves, type OverlayFiles } from '../overlay.ts';
import { openDisk, readAllocation } from '../qcow2.ts';
import {
  cellBytesFor,
  contentOf,
  rangeDetail,
  rangesOf,
  summarize,
  surfaceOf,
  blankLayer,
  imageLayer,
  type DetailLayer,
  type InspectAnswer,
  type InspectQuery,
  type OpaqueWhy,
  type SurfaceLayer,
} from '../surface.ts';

/** A question about a disk's surface from its files: its stored disk's (`baseKind` stored) and an overlay's directories. */
export type SurfaceJob = {
  /** The stored disk's directory (`disks/<id>`), for `baseKind` stored. */
  stored?: string;
  /** The overlay's directory (`overlays/<id>`), if one is laid over the disk. */
  overlay?: string;
  /** The disk's size (its record's). */
  size: number;
  /** The overlay's own size (its record's, where larger than the disk's: grown), which its files say too once written. */
  overlaySize?: number;
  /**
   * What the disk is: a block store, nothing (a blank disk), an image file to examine (`file`: a qcow2's clusters, else
   * not examined), or an image not examined (`why`).
   */
  baseKind: 'stored' | 'blank' | 'image' | 'opaque';
  /** `image`: the image's file (the page got it from a handle whose read permission was granted: never asked for). */
  file?: Blob;
  /** `opaque`: why it isn't examined. */
  why?: OpaqueWhy;
  query: InspectQuery;
};

/** How long the job waits for an overlay's lock that a machine holds (another tab's), ms. */
export const SURFACE_WAIT_MS = 1000;

const BLOCK = 4096;
const ZERO = 0xffffffff;
type Open = { files: OverlayFiles; map: MapLeaves; size: number };

/** Opens `path` read-only and reads its map at `size` (an overlay's own size, from its meta, where larger); undefined: no such files (nothing written). */
async function openRead(path: string, size: number, own: boolean, waitMs: number): Promise<Open | undefined> {
  let files: OverlayFiles;
  try {
    files = await openOverlay(path, undefined, waitMs, { readOnly: true });
  } catch (e) {
    if ((e as DOMException).name === 'NotFoundError') return undefined;
    throw e;
  }
  try {
    const at = own ? Math.max(size, readMeta(files.meta).size) : size;
    return { files, map: readMap(files.map, Math.ceil(at / BLOCK)), size: at };
  } catch (e) {
    files.close();
    throw e;
  }
}

/** Block `b`'s bytes from an opening's `data` (a held block's slot). */
function slotBytes(o: Open, b: number) {
  const t = o.map.top[Math.floor(b / 1024)];
  const e = t ? o.map.recs[(t - 1) * 1026 + (b % 1024)] : 0;
  if (!e || e === ZERO) return undefined;
  const out = new Uint8Array(BLOCK);
  return o.files.data.read(out, { at: (e - 1) * BLOCK }) === BLOCK ? out : undefined;
}

const NO_LEAVES = { top: new Uint32Array(0), recs: new Uint32Array(0), n: 0 };

/** An image file's bytes, without blocking. */
const blobRead = (file: Blob) => async (off: number, len: number) => {
  if (off < 0 || off + len > file.size) return undefined;
  const b = new Uint8Array(await file.slice(off, off + len).arrayBuffer());
  return b.length === len ? b : undefined;
};

/** An image file's layer: a qcow2's clusters where its tables can be read, else not examined (a raw image, or tables too large). */
async function imageOf(job: SurfaceJob): Promise<DetailLayer> {
  const file = job.file;
  if (!file) return { kind: 'opaque', id: 'disk', size: job.size, why: 'permission' };
  const read = blobRead(file);
  const head = await read(0, 4);
  const allocation = await readAllocation(read, file.size);
  if (allocation) return { kind: 'clusters', id: 'disk', size: allocation.size, allocation };
  const qcow2 = !!head && head[0] === 0x51 && head[1] === 0x46 && head[2] === 0x49 && head[3] === 0xfb;
  return { kind: 'opaque', id: 'disk', size: job.size, why: qcow2 ? 'large' : 'raw' };
}

/**
 * An image file's blocks for the content check, read synchronously (`FileReaderSync`: a worker's; none in Node, where
 * the check reads none of the image's).
 */
function imageBlocks(file: Blob) {
  if (typeof FileReaderSync === 'undefined') return undefined;
  const r = new FileReaderSync();
  const disk = openDisk((off, len) => {
    if (off + len > file.size) return undefined;
    const b = new Uint8Array(r.readAsArrayBuffer(file.slice(off, off + len)));
    return b.length === len ? b : undefined;
  }, file.size);
  return (b: number) => disk.read(b * BLOCK, Math.min(BLOCK, disk.size - b * BLOCK));
}

/** The disk's layer: its store's map, nothing, or an image not examined. */
function diskOf(job: SurfaceJob, stored: Open | undefined): DetailLayer {
  if (job.baseKind === 'opaque' || job.baseKind === 'image')
    return { kind: 'opaque', id: 'disk', size: job.size, ...(job.why ? { why: job.why } : {}) };
  return stored
    ? { kind: 'map', id: 'disk', size: job.size, leaves: stored.map }
    : { kind: 'blank', id: 'disk', size: job.size };
}

/** The disk's layer at `cellBytes` a cell. */
function layerOf(disk: DetailLayer, cellBytes: number): SurfaceLayer {
  if (disk.kind === 'map') return summarize(disk.leaves, 'disk', disk.size, cellBytes);
  if (disk.kind === 'clusters' || disk.kind === 'opaque') return imageLayer(disk, cellBytes);
  return blankLayer('disk', disk.size, cellBytes);
}

/** The overlay's layer as a map (`over` undefined: no files yet, nothing changed), if the job has one. */
function overlayOf(job: SurfaceJob, over: Open | undefined) {
  if (!job.overlay) return undefined;
  const size = Math.max(over?.size ?? job.size, job.overlaySize ?? 0);
  return { kind: 'map' as const, id: 'overlay', size, leaves: over?.map ?? NO_LEAVES };
}

/** A held block's bytes for the content check: the overlay's, the stored disk's, or a qcow2 file's (a raw one's aren't examined). */
function blockReader(job: SurfaceJob, disk: DetailLayer, stored: Open | undefined, over: Open | undefined) {
  const image = disk.kind === 'clusters' && job.file ? imageBlocks(job.file) : undefined;
  return (b: number, s: number) => (s === 2 ? over && slotBytes(over, b) : stored ? slotBytes(stored, b) : image?.(b));
}

/** The answer from the files opened (`over` undefined with `job.overlay`: an overlay without files, nothing changed). */
async function answer(job: SurfaceJob, stored: Open | undefined, over: Open | undefined): Promise<InspectAnswer> {
  const disk = job.baseKind === 'image' ? await imageOf(job) : diskOf(job, stored);
  const ov = overlayOf(job, over);
  const size = Math.max(job.size, ov?.size ?? 0);
  const q = job.query;
  if (q.kind === 'disk-surface') {
    const cellBytes = cellBytesFor(size, q.cells);
    const layers = [layerOf(disk, cellBytes)];
    if (ov) layers.push(summarize(ov.leaves, 'overlay', ov.size, cellBytes));
    return { kind: 'disk-surface', surface: surfaceOf(cellBytes, layers) };
  }
  if (!Number.isInteger(q.range) || q.range < 0 || q.range >= rangesOf(size)) return { kind: 'none' };
  const detail = rangeDetail(q.range, size, disk, ov);
  if (q.content) detail.content = await contentOf(detail, blockReader(job, disk, stored, over));
  return { kind: 'disk-range', detail };
}

/**
 * `job`'s answer from the files; `{kind: 'none', why}` when they are in use elsewhere, a merge into the stored disk was
 * interrupted (its blocks half copied: the disk's next opening finishes it), or they can't be read. The files' locks
 * are taken under `SURFACE_READER_LOCK` (their holds aren't a machine's to the page's checks: web/overlay.ts
 * `locksInUse`), so it runs in a worker of its own (Node's tests call it in theirs).
 */
export function surfaceJob(job: SurfaceJob, waitMs = SURFACE_WAIT_MS): Promise<InspectAnswer> {
  return navigator.locks.request(SURFACE_READER_LOCK, { mode: 'shared' }, () => read(job, waitMs));
}

async function read(job: SurfaceJob, waitMs: number): Promise<InspectAnswer> {
  let stored: Open | undefined;
  let over: Open | undefined;
  try {
    if (job.baseKind === 'stored' && job.stored) stored = await openRead(job.stored, job.size, false, waitMs);
    if (stored && readMeta(stored.files.meta).merging) return { kind: 'none', why: msg('disks:surface-job.merging') };
    if (job.overlay) over = await openRead(job.overlay, Math.max(job.size, job.overlaySize ?? 0), true, waitMs);
    return await answer(job, stored, over);
  } catch (e) {
    if ((e as { problem?: string }).problem === 'overlay-in-use')
      return { kind: 'none', why: msg('disks:surface-job.inUse') };
    return { kind: 'none', why: msgOf(e) ?? msg('disks:surface-job.unreadable') };
  } finally {
    stored?.files.close();
    over?.files.close();
  }
}
