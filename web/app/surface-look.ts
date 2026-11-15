// A disk's surface as the block map draws it (the disk surface visualizer, docs/frontend.md "A disk's surface"): the
// counts of web/surface.ts turned into the looks of web/app/ui/block-grid.ts (the disk as each cell's rim, the overlay as
// its core, the guest's reads and writes as its flash), which looks a view can show (its legend), and a cell's numbers
// and a range's blocks in words. Pure (no DOM): Node's tests run it.
import { msg, type Msg } from '../msg.ts';
import { RANGE, UNIT, type RangeDetail, type Surface, type SurfaceLayer } from '../surface.ts';
import { CORE, FLASH, RIM, STEPS } from './ui/block-grid.ts';

/** The grid's arrays for a surface: per cell a rim, a core and a flash; `mark` the disk's last cell where the view goes on past it. */
export type SurfaceLook = { cells: number; rim: Uint8Array; core: Uint8Array; flash?: Uint8Array; mark?: number };

/** The step (1…`STEPS`) of `n` units of `of`: any unit at all is the first. */
export const stepOf = (n: number, of: number) => Math.max(1, Math.min(STEPS, Math.ceil((n / Math.max(1, of)) * STEPS)));

/** The units of a layer of `size` bytes in cell `c` (0 past its end; the last is short). */
const unitsIn = (size: number, cellBytes: number, c: number) =>
  Math.max(0, Math.ceil((Math.min(size, (c + 1) * cellBytes) - c * cellBytes) / UNIT));

export const diskLayer = (s: Surface) => s.layers.find((l) => l.id === 'disk');
export const overlayLayer = (s: Surface) => s.layers.find((l) => l.id === 'overlay');

/**
 * A disk's rim in cell `c` (`units`: the disk's blocks there): past its end, not examined (or, of an image not
 * examined, its blocks kept in this browser in steps), nothing, or held in steps.
 */
function rimOf(disk: SurfaceLayer | undefined, units: number, c: number) {
  if (!disk || units === 0) return RIM.absent;
  if (disk.known === 'opaque') return disk.kept?.[c] ? RIM.step(stepOf(disk.kept[c], units)) : RIM.opaque;
  return disk.held[c] ? RIM.step(stepOf(disk.held[c], units)) : RIM.empty;
}

/** The flashes of a surface's activity (bit 0 read, bit 1 written). */
function flashOf(activity: Uint8Array, cells: number) {
  const flash = new Uint8Array(cells);
  for (let c = 0; c < cells && c < activity.length; c++)
    flash[c] = (activity[c] & 1 ? FLASH.read : 0) | (activity[c] & 2 ? FLASH.write : 0);
  return flash;
}

/** The looks of surface `s`: the disk's layer as the rims, the overlay's (if any) as the cores, its activity as the flashes. */
export function lookOf(s: Surface): SurfaceLook {
  const cells = Math.ceil(s.size / s.cellBytes);
  const rim = new Uint8Array(cells);
  const core = new Uint8Array(cells);
  const disk = diskLayer(s);
  const over = overlayLayer(s);
  for (let c = 0; c < cells; c++) {
    rim[c] = rimOf(disk, disk ? unitsIn(disk.size, s.cellBytes, c) : 0, c);
    if (over) core[c] = coreOf(over, s.cellBytes, c);
  }
  const ends = disk ? Math.ceil(disk.size / s.cellBytes) : 0;
  const mark = ends > 0 && ends < cells ? ends - 1 : undefined;
  return { cells, rim, core, flash: s.activity && flashOf(s.activity, cells), mark };
}

/** An overlay's core in cell `c`: none, its changed blocks in steps, or hollow when it only zeroed blocks there. */
function coreOf(over: SurfaceLayer, cellBytes: number, c: number) {
  const [held, zero] = [over.held[c] ?? 0, over.zero[c] ?? 0];
  if (!held && !zero) return CORE.none;
  if (!held) return CORE.hollow;
  return CORE.step(stepOf(held + zero, unitsIn(over.size, cellBytes, c)));
}

/**
 * What a view is: its disk's kind as the map knows it, an overlay laid over it, the overlay larger, live, and (an
 * image not examined) whether it says which of its blocks this browser keeps.
 */
export type ViewKind = {
  disk: 'counted' | 'opaque' | 'ram';
  overlay: boolean;
  grown: boolean;
  live: boolean;
  kept?: boolean;
};

/** A view's disk kind from its surface (what its disk layer says), else from the disk's record kind. */
export function diskKindOf(s: Surface | undefined, record: string | undefined): ViewKind['disk'] {
  if (record === 'ramdisk') return 'ram';
  const d = s && diskLayer(s);
  if (d) return d.known;
  return record === 'file' || record === 'url' ? 'opaque' : 'counted';
}

/** A legend's entry: its look and its words' key. */
export type LegendEntry = { rim: number; core: number; flash: number; key: string };

/** The looks a view can show (its legend), in the grid's order: the disk's, past its end, the overlay's, the activity. */
export function legendOf(v: ViewKind): LegendEntry[] {
  const out: LegendEntry[] = [];
  const add = (key: string, rim: number, core: number = CORE.none, flash = 0) => out.push({ key, rim, core, flash });
  if (v.disk === 'opaque') {
    add('disks:surface-look.legend.opaque', RIM.opaque);
    if (v.kept) {
      add('disks:surface-look.legend.keptSome', RIM.step(1));
      add('disks:surface-look.legend.kept', RIM.step(STEPS));
    }
  } else {
    add('disks:surface-look.legend.empty', RIM.empty);
    add(v.disk === 'ram' ? 'disks:surface-look.legend.ram' : 'disks:surface-look.legend.some', RIM.step(1));
    add('disks:surface-look.legend.full', RIM.step(STEPS));
  }
  if (v.grown) add('disks:surface-look.legend.absent', RIM.absent);
  const under = v.disk === 'opaque' ? RIM.opaque : RIM.step(2);
  if (v.overlay) {
    add('disks:surface-look.legend.changed', under, CORE.step(3));
    add('disks:surface-look.legend.zeroed', under, CORE.hollow);
  }
  if (v.live) {
    add('disks:surface-look.legend.read', under, CORE.none, FLASH.read);
    add('disks:surface-look.legend.written', under, CORE.none, FLASH.write);
  }
  return out;
}

const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;
const TiB = 1024 * GiB;
/** A size or an offset as exactly as a cell's (whole MiB, GiB or TiB where it is one; else to two decimals). */
export function sizeText(n: number) {
  for (const [u, name] of [
    [TiB, 'TiB'],
    [GiB, 'GiB'],
    [MiB, 'MiB'],
    [KiB, 'KiB'],
  ] as const)
    if (n >= u) return `${n % u === 0 ? String(n / u) : (n / u).toFixed(2)} ${name}`;
  return `${String(n)} B`;
}

/** What the disk holds in cell `c`, in words. */
function diskWords(s: Surface, c: number, ram: boolean): Msg {
  const disk = diskLayer(s);
  const units = disk ? unitsIn(disk.size, s.cellBytes, c) : 0;
  if (!disk || units === 0) return msg('disks:surface-look.disk.past');
  if (disk.known === 'opaque')
    return disk.kept?.[c]
      ? msg('disks:surface-look.disk.kept', { kept: disk.kept[c], of: units })
      : msg('disks:surface-look.disk.opaque');
  if (!disk.held[c]) return msg(ram ? 'disks:surface-look.ram.empty' : 'disks:surface-look.disk.empty');
  return msg(ram ? 'disks:surface-look.ram.held' : 'disks:surface-look.disk.held', {
    held: disk.held[c],
    count: units,
  });
}

/** Why an image isn't examined, in words (the line under the map while no square is pointed at). */
const WHY_WORDS = {
  raw: 'disks:surface-look.why.raw',
  tables: 'disks:surface-look.why.tables',
  large: 'disks:surface-look.why.large',
  permission: 'disks:surface-look.why.permission',
  remote: 'disks:surface-look.why.remote',
} as const;

/**
 * What a view of an image not examined holds as a whole, in words: why it isn't, how much of it this browser keeps
 * (a remote raw image's), and the overlay's changes over it.
 */
export function opaqueWords(disk: SurfaceLayer, overlay: boolean): Msg[] {
  const out = [disk.why ? msg(WHY_WORDS[disk.why]) : msg('disks:surface-look.why.unknown')];
  if (disk.kept) {
    const kept = disk.kept.reduce((n, k) => n + k, 0);
    out.push(
      kept ? msg('disks:surface-look.keptAll', { size: sizeText(kept * UNIT) }) : msg('disks:surface-look.keptNone'),
    );
  }
  if (overlay) out.push(msg('disks:surface-look.overOpaque'));
  return out;
}

/** What the overlay changed in cell `c`, in words. */
function overlayWords(over: SurfaceLayer, c: number): Msg {
  const [held, zero] = [over.held[c] ?? 0, over.zero[c] ?? 0];
  if (held && zero) return msg('disks:surface-look.overlay.both', { count: held, zero });
  if (held) return msg('disks:surface-look.overlay.changed', { count: held });
  if (zero) return msg('disks:surface-look.overlay.zeroed', { count: zero });
  return msg('disks:surface-look.overlay.none');
}

/** Cell `c`'s numbers in words (the hover line): where it is, what the disk holds there, what the overlay changed, the activity. */
export function cellWords(s: Surface, c: number, ram = false): Msg[] {
  const from = c * s.cellBytes;
  const to = Math.min(s.size, from + s.cellBytes);
  const out = [msg('disks:surface-look.at', { from: sizeText(from), to: sizeText(to) }), diskWords(s, c, ram)];
  const over = overlayLayer(s);
  if (over) out.push(overlayWords(over, c));
  const a = s.activity?.[c] ?? 0;
  if (a & 2) out.push(msg(a & 1 ? 'disks:surface-look.readWritten' : 'disks:surface-look.written'));
  else if (a & 1) out.push(msg('disks:surface-look.read'));
  return out;
}

/** How many ranges (4 MiB) cell `c` of surface `s` covers: the first, and how many (the last cell's may be fewer). */
export function rangesOfCell(s: Surface, c: number) {
  const per = s.cellBytes / RANGE;
  const first = c * per;
  return { first, count: Math.max(0, Math.min(per, Math.ceil(s.size / RANGE) - first)) };
}

/**
 * A range's blocks as the detail's grid draws them (32 × 32): the disk's (not examined, or kept in this browser), the
 * overlay's, zeroed, past the end.
 */
export function detailLook(d: RangeDetail, opaque: boolean): SurfaceLook {
  const n = d.blocks.length;
  const rim = new Uint8Array(n);
  const core = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const b = d.blocks[i];
    if (b === 4) rim[i] = RIM.absent;
    else if (b === 1) rim[i] = opaque ? RIM.opaque : RIM.step(STEPS);
    else if (b === 5) rim[i] = RIM.step(STEPS);
    else if (b === 2) core[i] = CORE.step(STEPS);
    else if (b === 3) core[i] = CORE.hollow;
  }
  return { cells: n, rim, core };
}

/** A range's blocks counted by whose they are. */
export function detailCounts(d: RangeDetail) {
  const n = [0, 0, 0, 0, 0, 0];
  for (const b of d.blocks) n[b]++;
  return { disk: n[1] + n[5], overlay: n[2], zeroed: n[3], past: n[4], kept: n[5] };
}

/** A range's detail in words: where it is, what it holds and in how many runs (fragments) its store keeps it. */
export function detailWords(d: RangeDetail, v: Pick<ViewKind, 'disk' | 'overlay'>, diskSize = Infinity): Msg[] {
  const c = detailCounts(d);
  const out = [
    msg('disks:surface-look.range', { from: sizeText(d.range * RANGE), to: sizeText((d.range + 1) * RANGE) }),
  ];
  if (d.range * RANGE >= diskSize) out.push(msg('disks:surface-look.range.past'));
  else if (v.disk === 'opaque') {
    out.push(msg('disks:surface-look.range.opaque'));
    if (c.kept) out.push(msg('disks:surface-look.range.kept', { blocks: c.kept }));
  } else if (!c.disk) out.push(msg('disks:surface-look.range.diskEmpty'));
  else if ('disk' in d.runs) out.push(msg('disks:surface-look.range.diskRuns', { blocks: c.disk, count: d.runs.disk }));
  else out.push(msg('disks:surface-look.range.disk', { count: c.disk }));
  if (v.overlay) {
    if (c.overlay) out.push(msg('disks:surface-look.range.overlayRuns', { blocks: c.overlay, count: d.runs.overlay }));
    else out.push(msg('disks:surface-look.range.overlayNone'));
    if (c.zeroed) out.push(msg('disks:surface-look.range.zeroed', { count: c.zeroed }));
  }
  if (d.content) out.push(msg('disks:surface-look.range.content', { count: d.content.read, zeros: d.content.zeros }));
  return out;
}
