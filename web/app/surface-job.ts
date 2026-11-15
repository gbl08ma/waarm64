// A disk's surface while no machine on this page runs it (docs/plans/surface.md §2): the questions of web/surface.ts
// answered from the files, read whole and closed at once: a stored disk's `map`, an overlay's `map` and `meta` (its own
// size), and for a range's content check the held blocks of that range from `data`. Read-only handles under the shared
// lock (web/overlay.ts `openOverlay`'s `readOnly`): a machine in another tab that has the overlay open holds its lock
// exclusively, and after a short wait the answer says so. web/app/surface-worker.ts runs it; Node's tests call it.
import { msg, msgOf } from '../msg.ts';
import { openOverlay, readMap, readMeta, type MapLeaves, type OverlayFiles } from '../overlay.ts';
import {
  cellBytesFor,
  contentOf,
  rangeDetail,
  rangesOf,
  summarize,
  surfaceOf,
  blankLayer,
  opaqueLayer,
  type DetailLayer,
  type InspectAnswer,
  type InspectQuery,
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
  /** What the disk is: a block store, nothing (a blank disk), or an image not examined (a file's, a URL's). */
  baseKind: 'stored' | 'blank' | 'opaque';
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

/** The disk's layer: its store's map, nothing, or an image not examined. */
function diskOf(job: SurfaceJob, stored: Open | undefined): DetailLayer {
  if (job.baseKind === 'opaque') return { kind: 'opaque', id: 'disk', size: job.size };
  return stored
    ? { kind: 'map', id: 'disk', size: job.size, leaves: stored.map }
    : { kind: 'blank', id: 'disk', size: job.size };
}

/** The disk's layer at `cellBytes` a cell. */
function layerOf(disk: DetailLayer, cellBytes: number): SurfaceLayer {
  if (disk.kind === 'map') return summarize(disk.leaves, 'disk', disk.size, cellBytes);
  return disk.kind === 'opaque' ? opaqueLayer('disk', disk.size, cellBytes) : blankLayer('disk', disk.size, cellBytes);
}

/** The answer from the files opened (`over` undefined with `job.overlay`: an overlay without files, nothing changed). */
async function answer(job: SurfaceJob, stored: Open | undefined, over: Open | undefined): Promise<InspectAnswer> {
  const disk = diskOf(job, stored);
  const ov = job.overlay
    ? {
        kind: 'map' as const,
        id: 'overlay',
        size: Math.max(over?.size ?? job.size, job.overlaySize ?? 0),
        leaves: over?.map ?? NO_LEAVES,
      }
    : undefined;
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
  if (q.content)
    detail.content = await contentOf(detail, (b, s) =>
      s === 2 ? over && slotBytes(over, b) : stored && slotBytes(stored, b),
    );
  return { kind: 'disk-range', detail };
}

/** `job`'s answer from the files; `{kind: 'none', why}` when they are in use elsewhere or can't be read. */
export async function surfaceJob(job: SurfaceJob, waitMs = SURFACE_WAIT_MS): Promise<InspectAnswer> {
  let stored: Open | undefined;
  let over: Open | undefined;
  try {
    if (job.baseKind === 'stored' && job.stored) stored = await openRead(job.stored, job.size, false, waitMs);
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
