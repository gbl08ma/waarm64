// A disk's surface (docs/plans/surface.md): what a disk and one of its overlays hold, counted per cell of a grid, and
// one 4 MiB range of them block by block. The numbers come from the block maps' leaves (web/overlay.ts `MapLeaves`)
// the device worker has in memory anyway (a running disk: `diskInspector`, built by web/devices.ts `blk`), or that a
// job worker reads from the files (web/app/surface-job.ts), and from a qcow2 image's L2 tables (web/qcow2.ts
// `Allocation`) where they can be had without asking or fetching. No DOM, no OPFS: workers, the page and Node's tests
// import it. A cell is 4 MiB (one leaf's range) times a power of two; cells are counted in 4 KiB blocks.
import type { MapLeaves } from './overlay.ts';
import type { Msg } from './msg.ts';
import type { Allocation } from './qcow2.ts';

/** A surface: something made of equal units (a disk's 4 KiB blocks, later RAM's pages), seen as `cells` cells. */
export type Surface = {
  /** Bytes spanned (the largest layer's), a cell's bytes (the last may be short) and a unit's. */
  size: number;
  cellBytes: number;
  unitBytes: number;
  layers: SurfaceLayer[];
  /** Live: per cell, bit 0 read, bit 1 written since the last answer. */
  activity?: Uint8Array;
  /** Live: the ms the answer took to make (the poll's pacing). */
  cost?: number;
};
export type SurfaceLayer = {
  /** 'disk' | 'overlay' | 'ram' … (the caller's). */
  id: string;
  /** The layer's own size: cells past it have no such layer. */
  size: number;
  /** 'counted': `held` and `zero` are block counts; 'opaque': contents not examined (held = the cell's units). */
  known: 'counted' | 'opaque';
  /** Per cell: units held with data; units held as zeros without data (an overlay's zeroed and discarded blocks). */
  held: Uint32Array;
  zero: Uint32Array;
  /** An opaque layer's: per cell, units whose bytes this browser keeps (a remote raw image's, in memory or in OPFS). */
  kept?: Uint32Array;
  /** An opaque layer's: why it isn't examined (the page says it in words). */
  why?: OpaqueWhy;
};
/**
 * Why an image isn't examined: a raw one (nothing in it says what it holds), a qcow2 whose tables aren't all here (a
 * remote image's not yet read, never fetched for this) or are too large to read, a file this browser may not read now
 * (no permission without asking), an image on a web server while its machine doesn't run here.
 */
export type OpaqueWhy = 'raw' | 'tables' | 'large' | 'permission' | 'remote';
/** One 4 MiB range, block by block. */
export type RangeDetail = {
  range: number;
  /**
   * Per 4 KiB block: 0 nothing, 1 the disk's, 2 the overlay's, 3 zeroed by the overlay, 4 past the end, 5 the disk's,
   * not examined but kept in this browser (a remote raw image's).
   */
  blocks: Uint8Array;
  /** Runs of consecutive slots the layer's held blocks take in its `data` file, per layer id. */
  runs: Record<string, number>;
  /** With `content`: held blocks read, and how many were all zeros. */
  content?: { read: number; zeros: number };
};
export type InspectQuery =
  | { kind: 'disk-surface'; disk: number; cells: number; activity?: boolean }
  | { kind: 'disk-range'; disk: number; range: number; content?: boolean };
export type InspectAnswer =
  | { kind: 'disk-surface'; surface: Surface }
  | { kind: 'disk-range'; detail: RangeDetail }
  | { kind: 'none'; why?: Msg };

/** A unit: a disk's block. */
export const UNIT = 4096;
/** A map leaf's entries (web/overlay.ts `LEAF`), and the bytes of disk one covers: a range. */
const LEAF = 1024;
export const RANGE = LEAF * UNIT;
/** A leaf's record in u32s (web/overlay.ts `REC`). */
const REC = LEAF + 2;
/** The most cells a surface is made of, whatever the window has room for. */
export const MAX_CELLS = 65536;
/** A ramdisk's chunk (web/ramdisk.ts `RAM_CHUNK`). */
const RAM_CHUNK = 1 << 20;

/** The part of a map the counts read: its top table and records (web/overlay.ts `MapLeaves`). */
export type Leaves = Pick<MapLeaves, 'top' | 'recs' | 'n'>;

/** Ranges (4 MiB) in `size` bytes. */
export const rangesOf = (size: number) => Math.ceil(size / RANGE);

/**
 * A cell's bytes for a surface of `size` bytes seen in at most `cells` cells (and at most `MAX_CELLS`): 4 MiB times the
 * smallest power of two for which every range fits.
 */
export function cellBytesFor(size: number, cells: number) {
  const max = Math.max(1, Math.min(MAX_CELLS, Math.floor(cells) || 1));
  const ranges = Math.max(1, rangesOf(size));
  let k = 1;
  while (Math.ceil(ranges / k) > max) k *= 2;
  return k * RANGE;
}

/** The cells of a surface of `size` bytes at `cellBytes` a cell (the last may be short). */
export const cellCount = (size: number, cellBytes: number) => Math.ceil(size / cellBytes);

/** Per range of a map: its blocks held with a slot, and held as zeros without one (each at most 1,024). */
export type RangeCounts = { held: Uint16Array; zero: Uint16Array };

/** Counts range `r`'s leaf of map `m` into `out` (blocks past `blocks` not counted). */
export function countRange(m: Leaves, r: number, blocks: number, out: RangeCounts) {
  const t = r < m.top.length ? m.top[r] : 0;
  if (!t) {
    out.held[r] = out.zero[r] = 0;
    return;
  }
  // An Int32 view: ZERO (0xffffffff) is -1 there, and V8 keeps the loop in small integers (twice as fast).
  const s = new Int32Array(m.recs.buffer, m.recs.byteOffset, m.recs.length);
  const q = (t - 1) * REC;
  const end = q + Math.min(LEAF, blocks - r * LEAF);
  let held = 0;
  let zero = 0;
  for (let i = q; i < end; i++) {
    const e = s[i];
    if (e === -1) zero++;
    else if (e !== 0) held++;
  }
  out.held[r] = held;
  out.zero[r] = zero;
}

/** Every range's counts of map `m` for a layer of `size` bytes: a walk of its leaves. */
export function rangeCounts(m: Leaves, size: number): RangeCounts {
  const ranges = rangesOf(size);
  const blocks = Math.ceil(size / UNIT);
  const out = { held: new Uint16Array(ranges), zero: new Uint16Array(ranges) };
  for (let r = 0; r < ranges; r++) if (r < m.top.length && m.top[r]) countRange(m, r, blocks, out);
  return out;
}

/** A layer of `size` bytes from its per-range counts, at `cellBytes` a cell. */
export function layerOf(id: string, size: number, counts: RangeCounts, cellBytes: number): SurfaceLayer {
  const per = cellBytes / RANGE;
  const cells = cellCount(size, cellBytes);
  const held = new Uint32Array(cells);
  const zero = new Uint32Array(cells);
  for (let r = 0; r < counts.held.length; r++) {
    const c = Math.floor(r / per);
    held[c] += counts.held[r];
    zero[c] += counts.zero[r];
  }
  return { id, size, known: 'counted', held, zero };
}

/** Map `m`'s layer, of `size` bytes, at `cellBytes` a cell: what its blocks hold, counted. */
export const summarize = (m: Leaves, id: string, size: number, cellBytes: number) => layerOf(id, size, rangeCounts(m, size), cellBytes);

/** A layer that holds nothing (a blank disk). */
export function blankLayer(id: string, size: number, cellBytes: number): SurfaceLayer {
  const cells = cellCount(size, cellBytes);
  return { id, size, known: 'counted', held: new Uint32Array(cells), zero: new Uint32Array(cells) };
}

/** The units of `size` bytes in each of its cells (the last one's short). */
function unitsPerCell(size: number, cellBytes: number) {
  const cells = cellCount(size, cellBytes);
  const out = new Uint32Array(cells);
  for (let c = 0; c < cells; c++) out[c] = Math.ceil((Math.min(size, (c + 1) * cellBytes) - c * cellBytes) / UNIT);
  return out;
}

/** A layer whose contents aren't examined (a file's or a URL's image): every unit counts as held. */
export function opaqueLayer(id: string, size: number, cellBytes: number, why?: OpaqueWhy): SurfaceLayer {
  return { id, size, known: 'opaque', held: unitsPerCell(size, cellBytes), zero: new Uint32Array(cellCount(size, cellBytes)), ...(why ? { why } : {}) };
}

/** Which of an image file's blocks this browser keeps (web/devices.ts `Source.kept`). */
export type Kept = { block: number; has(k: number): boolean };

/** Per cell, the units of a raw image of `size` bytes whose bytes are kept (`kept`: its file's blocks; the file is the disk). */
export function keptUnits(size: number, kept: Kept, cellBytes: number) {
  const out = new Uint32Array(cellCount(size, cellBytes));
  const blocks = Math.ceil(size / kept.block);
  for (let k = 0; k < blocks; k++) {
    if (!kept.has(k)) continue;
    // A block within one cell when it's at most a cell (both powers of two); a larger one spread over its cells.
    for (let at = k * kept.block, end = Math.min(size, (k + 1) * kept.block); at < end;) {
      const c = Math.floor(at / cellBytes);
      const to = Math.min(end, (c + 1) * cellBytes);
      out[c] += Math.ceil(to / UNIT) - Math.ceil(at / UNIT);
      at = to;
    }
  }
  return out;
}

/** Whether unit (block) `b` of a raw image is kept. */
const keptUnit = (kept: Kept, b: number) => kept.has(Math.floor((b * UNIT) / kept.block));

/**
 * Every range's counts of a qcow2's allocation for a layer of `size` bytes: its units with data (a unit is the disk's
 * if any cluster in it is: clusters of under 4 KiB share one). Clusters (at most 2 MiB) never cross a range.
 */
export function allocationCounts(a: Allocation, size: number): RangeCounts {
  const ranges = rangesOf(size);
  const out = { held: new Uint16Array(ranges), zero: new Uint16Array(ranges) };
  const units = Math.ceil(size / UNIT);
  for (let u = 0; u < units;) {
    if (a.clusterBytes >= UNIT) {
      const per = a.clusterBytes / UNIT;
      const n = Math.min(per, units - u);
      if (a.allocated(u / per)) out.held[Math.floor(u / LEAF)] += n;
      u += n;
    } else {
      if (unitAllocated(a, u)) out.held[Math.floor(u / LEAF)]++;
      u++;
    }
  }
  return out;
}

/** Whether unit `u` (4 KiB) of a qcow2 has data: any of its clusters does. */
function unitAllocated(a: Allocation, u: number) {
  if (a.clusterBytes >= UNIT) return a.allocated(Math.floor((u * UNIT) / a.clusterBytes));
  const per = UNIT / a.clusterBytes;
  for (let c = u * per; c < (u + 1) * per; c++) if (a.allocated(c)) return true;
  return false;
}

/** A ramdisk's layer from the 1 MiB chunks it has in memory (their indices): their blocks are held. */
export function ramLayer(id: string, size: number, chunks: Iterable<number>, cellBytes: number): SurfaceLayer {
  const cells = cellCount(size, cellBytes);
  const held = new Uint32Array(cells);
  for (const k of chunks) {
    const at = k * RAM_CHUNK;
    if (at >= size) continue;
    held[Math.floor(at / cellBytes)] += Math.ceil((Math.min(size, at + RAM_CHUNK) - at) / UNIT);
  }
  return { id, size, known: 'counted', held, zero: new Uint32Array(cells) };
}

/** `a` with `cells` entries (zeros past its own). */
const widen = (a: Uint32Array, cells: number) => {
  if (a.length === cells) return a;
  const out = new Uint32Array(cells);
  out.set(a.subarray(0, cells));
  return out;
};

/**
 * A surface of `layers` (made at `cellBytes`, each at its own size): it spans the largest, and every layer's arrays
 * cover all its cells, zeros past the layer's own end.
 */
export function surfaceOf(cellBytes: number, layers: SurfaceLayer[]): Surface {
  const size = Math.max(0, ...layers.map((l) => l.size));
  const cells = cellCount(size, cellBytes);
  return { size, cellBytes, unitBytes: UNIT, layers: layers.map((l) => ({ ...l, held: widen(l.held, cells), zero: widen(l.zero, cells), ...(l.kept ? { kept: widen(l.kept, cells) } : {}) })) };
}

/** A layer of a range's detail: what its blocks are. */
export type DetailLayer =
  | { kind: 'map'; id: string; size: number; leaves: Leaves }
  | { kind: 'blank'; id: string; size: number }
  /** An image not examined (`kept`: which of its file's blocks are here, a raw remote image's). */
  | { kind: 'opaque'; id: string; size: number; why?: OpaqueWhy; kept?: Kept }
  /** A qcow2's clusters (web/qcow2.ts `Allocation`). */
  | { kind: 'clusters'; id: string; size: number; allocation: Allocation }
  | { kind: 'ram'; id: string; size: number; chunks: Iterable<number> };

/**
 * Range `range`'s blocks in a surface of `size` bytes over `disk` and, if there is one, `overlay` (a map): per block
 * whose it is (the overlay's first), and per map layer the runs of consecutive slots its held blocks take in its
 * `data` (block after block: a run is the blocks one read gets).
 */
export function rangeDetail(range: number, size: number, disk: DetailLayer, overlay?: Extract<DetailLayer, { kind: 'map' }>): RangeDetail {
  const blocks = new Uint8Array(LEAF);
  const first = range * LEAF;
  const ram = disk.kind === 'ram' ? new Set(disk.chunks) : undefined;
  const entry = (l: Extract<DetailLayer, { kind: 'map' }>, b: number) => {
    if (b * UNIT >= l.size) return 0;
    const t = range < l.leaves.top.length ? l.leaves.top[range] : 0;
    return t ? l.leaves.recs[(t - 1) * REC + (b - first)] : 0;
  };
  for (let i = 0; i < LEAF; i++) {
    const b = first + i;
    if (b * UNIT >= size) { blocks[i] = 4; continue; }
    const o = overlay ? entry(overlay, b) : 0;
    if (o === 0xffffffff) blocks[i] = 3;
    else if (o) blocks[i] = 2;
    else if (b * UNIT < disk.size) {
      if (disk.kind === 'map') { const e = entry(disk, b); blocks[i] = e && e !== 0xffffffff ? 1 : 0; }
      else if (disk.kind === 'opaque') blocks[i] = disk.kept && keptUnit(disk.kept, b) ? 5 : 1;
      else if (disk.kind === 'clusters') blocks[i] = unitAllocated(disk.allocation, b) ? 1 : 0;
      else if (ram) blocks[i] = ram.has(Math.floor((b * UNIT) / RAM_CHUNK)) ? 1 : 0;
    }
  }
  const runs: Record<string, number> = {};
  for (const l of [disk, overlay]) {
    if (l?.kind !== 'map') continue;
    let n = 0;
    let prev = -1; // the slot of the block before, -1 for none held
    for (let i = 0; i < LEAF; i++) {
      const e = entry(l, first + i);
      const slot = e !== 0 && e !== 0xffffffff ? e - 1 : -1;
      if (slot >= 0 && (prev < 0 || slot !== prev + 1)) n++;
      prev = slot;
    }
    runs[l.id] = n;
  }
  return { range, blocks, runs };
}

/**
 * The content check of a range's detail: its held blocks (the disk's, 1 and 5, and the overlay's, 2) read with `read`
 * (block number, its state), and how many are all zeros. A block that can't be read isn't counted.
 */
export async function contentOf(d: RangeDetail, read: (b: number, state: number) => Uint8Array | undefined | Promise<Uint8Array | undefined>) {
  let [n, zeros] = [0, 0];
  for (let i = 0; i < d.blocks.length; i++) {
    const s = d.blocks[i] === 5 ? 1 : d.blocks[i];
    if (s !== 1 && s !== 2) continue;
    const bytes = await read(d.range * LEAF + i, s);
    if (!bytes) continue;
    n++;
    if (allZero(bytes)) zeros++;
  }
  return { read: n, zeros };
}

const allZero = (b: Uint8Array) => {
  const w = b.byteOffset % 4 === 0 && b.length % 4 === 0 ? new Uint32Array(b.buffer, b.byteOffset, b.length / 4) : b;
  for (let i = 0; i < w.length; i++) if (w[i]) return false;
  return true;
};

/** The buffers of an answer's arrays, to transfer it to another thread (each its own buffer). */
export function answerBuffers(a: InspectAnswer): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  const add = (x: Uint8Array | Uint32Array | undefined) => { if (x && x.buffer instanceof ArrayBuffer && x.byteLength === x.buffer.byteLength) out.add(x.buffer); };
  if (a.kind === 'disk-surface') {
    add(a.surface.activity);
    for (const l of a.surface.layers) [l.held, l.zero, l.kept].forEach(add);
  } else if (a.kind === 'disk-range') add(a.detail.blocks);
  return [...out];
}

// ---------------------------------------------------------------------------------------------------------------------
// A running disk's answers (the device worker's: web/devices.ts `blk`).

/** A live disk's layers as `diskInspector` reads them. */
export type LiveDisk = {
  /**
   * The disk (the base): a stored disk's map (it doesn't change under its machines), a blank, a ramdisk, or an image
   * (`examine`: its clusters where they can be known, else opaque, asked again at each query until they can).
   */
  disk: (DetailLayer | LiveImage) & { read?(b: number): Uint8Array | undefined | Promise<Uint8Array | undefined> };
  /** Its overlay: its map, read when asked (`leaves()` gives its current arrays), and a block's bytes. */
  overlay?: { id: string; size: number; leaves(): Leaves; read(b: number): Uint8Array | undefined };
};

/** A running disk's image: what can be known of it now (a qcow2's clusters once its tables are all here). */
export type LiveImage = { kind: 'image'; id: string; size: number; examine(): Extract<DetailLayer, { kind: 'clusters' | 'opaque' }> };

/** An image's layer at `cellBytes` a cell: its clusters counted (`counts`, made once by the caller), else opaque with what is kept. */
export function imageLayer(d: Extract<DetailLayer, { kind: 'clusters' | 'opaque' }>, cellBytes: number, counts?: RangeCounts): SurfaceLayer {
  if (d.kind === 'clusters') return layerOf(d.id, d.size, counts ?? allocationCounts(d.allocation, d.size), cellBytes);
  const l = opaqueLayer(d.id, d.size, cellBytes, d.why);
  if (d.kept) l.kept = keptUnits(d.size, d.kept, cellBytes);
  return l;
}

/** How long the activity wrapper stays without a query that asks for it (ms). */
export const ACTIVITY_IDLE_MS = 3000;
/**
 * How often, while the wrapper is on, an answer walks the overlay's leaves whole instead of counting again only the
 * ranges written since (ms): what a request in flight when the wrapper went on changed after the walks that followed
 * is caught up then (a hole the marks can't see).
 */
export const FULL_WALK_MS = 10_000;

/** Bits of an activity mark (a byte per range): read, written, and changed since the overlay's counts were taken. */
const READ = 1;
const WRITTEN = 2;
const DIRTY = 4;

/**
 * Answers `InspectQuery`s about a running disk (`live`). Activity: a query that asks for it has `install` put a
 * wrapper around the disk's requests (`watch` marks the ranges a request reads or writes), and once no query asked
 * for `idleMs` (or at `close`) `uninstall` takes it away: while nobody looks, nothing is added to the request path.
 * While the wrapper is on, the overlay's per-range counts are kept and only the ranges written since are counted
 * again (a whole walk of a large overlay's leaves takes tens of ms), and one answer every `fullMs` (`FULL_WALK_MS`)
 * walks it whole all the same.
 */
export function diskInspector(live: LiveDisk, hooks: {
  /**
   * Puts the wrapper on: `mark(first, last, write)` is to be called with the ranges (4 MiB) a request reads or changes
   * (a write, a zeroing, a discard), and again with a change's once it ended.
   */
  install(mark: (first: number, last: number, write: boolean) => void): void;
  uninstall(): void;
  idleMs?: number;
  fullMs?: number;
  /** The clock the full walks go by (ms; tests). */
  now?: () => number;
}) {
  const size = Math.max(live.disk.size, live.overlay?.size ?? 0);
  const ranges = rangesOf(size);
  /** The disk's per-range counts (a map's or an image's clusters: they don't change), made at the first query. */
  let diskCounts: RangeCounts | undefined;
  /** An image's clusters, once known (they don't change while it's open). */
  let clusters: Extract<DetailLayer, { kind: 'clusters' }> | undefined;
  /** The disk as a range's detail and the layer read it now (an image examined). */
  const base = (): DetailLayer => {
    const d = live.disk;
    if (d.kind !== 'image') return d;
    if (clusters) return clusters;
    const e = d.examine();
    if (e.kind === 'clusters') clusters = e;
    return e;
  };
  /** Per range: `READ`, `WRITTEN`, `DIRTY`; undefined while the wrapper is off. */
  let marks: Uint8Array | undefined;
  /** The overlay's per-range counts while the wrapper is on; `warm`: taken with the wrapper on (and every request since marked). */
  let counts: RangeCounts | undefined;
  let warm = false;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const idleMs = hooks.idleMs ?? ACTIVITY_IDLE_MS;
  const fullMs = hooks.fullMs ?? FULL_WALK_MS;
  const now = hooks.now ?? (() => performance.now());
  /** When the overlay's leaves were last walked whole with the wrapper on. */
  let walked = 0;

  const mark = (first: number, last: number, write: boolean) => {
    const m = marks;
    if (!m) return;
    const bits = write ? WRITTEN | DIRTY : READ;
    for (let r = Math.max(0, first); r <= last && r < m.length; r++) m[r] |= bits;
  };
  const stop = () => {
    if (idle !== undefined) clearTimeout(idle);
    idle = undefined;
    if (!marks) return;
    marks = undefined;
    counts = undefined;
    warm = false;
    hooks.uninstall();
  };
  const watch = () => {
    if (!marks) {
      marks = new Uint8Array(ranges);
      hooks.install(mark);
    }
    if (idle !== undefined) clearTimeout(idle);
    idle = setTimeout(stop, idleMs);
    (idle as { unref?(): void }).unref?.(); // Node: a test's process doesn't wait for it
  };

  const diskLayer = (cellBytes: number): SurfaceLayer => {
    const d = base();
    if (d.kind === 'map') return layerOf(d.id, d.size, (diskCounts ??= rangeCounts(d.leaves, d.size)), cellBytes);
    if (d.kind === 'clusters') return imageLayer(d, cellBytes, (diskCounts ??= allocationCounts(d.allocation, d.size)));
    if (d.kind === 'opaque') return imageLayer(d, cellBytes);
    if (d.kind === 'ram') return ramLayer(d.id, d.size, d.chunks, cellBytes);
    return blankLayer(d.id, d.size, cellBytes);
  };
  const overlayCounts = (o: NonNullable<LiveDisk['overlay']>): RangeCounts => {
    const m = o.leaves();
    if (!marks) return rangeCounts(m, o.size);
    if (!counts || !warm || now() - walked >= fullMs) {
      // The first walk with the wrapper on: a request that was running when it went on wasn't marked, so the next
      // answer walks again, and only after it do the marks say all that changed. A walk every `fullMs` catches up what
      // such a request changed after both.
      warm = counts !== undefined;
      for (let r = 0; r < marks.length; r++) marks[r] &= ~DIRTY;
      counts = rangeCounts(m, o.size);
      walked = now();
      return counts;
    }
    const blocks = Math.ceil(o.size / UNIT);
    for (let r = 0; r < counts.held.length; r++) {
      if (!(marks[r] & DIRTY)) continue;
      marks[r] &= ~DIRTY;
      countRange(m, r, blocks, counts);
    }
    return counts;
  };

  const surface = (q: Extract<InspectQuery, { kind: 'disk-surface' }>): Surface => {
    const cellBytes = cellBytesFor(size, q.cells);
    const layers = [diskLayer(cellBytes)];
    if (live.overlay) layers.push(layerOf(live.overlay.id, live.overlay.size, overlayCounts(live.overlay), cellBytes));
    const s = surfaceOf(cellBytes, layers);
    if (q.activity && marks) {
      const per = cellBytes / RANGE;
      const act = new Uint8Array(cellCount(s.size, cellBytes));
      for (let r = 0; r < marks.length; r++) {
        if (!(marks[r] & (READ | WRITTEN))) continue;
        act[Math.floor(r / per)] |= marks[r] & (READ | WRITTEN);
        marks[r] &= DIRTY;
      }
      s.activity = act;
    }
    return s;
  };

  const range = async (q: Extract<InspectQuery, { kind: 'disk-range' }>): Promise<RangeDetail> => {
    const o = live.overlay;
    const detail = rangeDetail(q.range, size, base(), o && { kind: 'map', id: o.id, size: o.size, leaves: o.leaves() });
    if (q.content) detail.content = await contentOf(detail, (b, s) => (s === 2 ? o?.read(b) : live.disk.read?.(b)));
    return detail;
  };

  return {
    async inspect(q: InspectQuery): Promise<InspectAnswer> {
      const t = performance.now();
      if (q.kind === 'disk-surface') {
        // The wrapper goes on before the walk, so what changes after the walk is marked.
        if (q.activity) watch();
        const s = surface(q);
        s.cost = performance.now() - t;
        return { kind: 'disk-surface', surface: s };
      }
      if (q.kind === 'disk-range') {
        if (q.range < 0 || q.range >= ranges || !Number.isInteger(q.range)) return { kind: 'none' };
        return { kind: 'disk-range', detail: await range(q) };
      }
      return { kind: 'none' };
    },
    /** Whether the activity wrapper is on (tests). */
    watching: () => marks !== undefined,
    close: stop,
  };
}
