// A disk's surface as the block map draws it (the disk surface visualizer, docs/frontend.md "A disk's surface"): the
// counts of web/surface.ts turned into the looks of web/app/ui/block-grid.ts (the disk as each cell's rim, the overlay as
// its core, the guest's reads and writes as its flash, a remote image's blocks kept in this browser as its tick), which
// looks a view can show (its legend), and a cell's numbers and a range's blocks in words. Pure (no DOM): Node's tests
// run it.
import { msg, type Msg } from '../msg.ts';
import { RANGE, UNIT, type OpaqueWhy, type RangeDetail, type Surface, type SurfaceLayer } from '../surface.ts';
import { CORE, FLASH, RIM, STEPS, TICK } from './ui/block-grid.ts';

/**
 * The grid's arrays for a surface: per cell a rim, a core, a flash and a tick (a remote image's: what of it this
 * browser keeps); `mark` the disk's last cell where the view goes on past it.
 */
export type SurfaceLook = {
  cells: number;
  rim: Uint8Array;
  core: Uint8Array;
  flash?: Uint8Array;
  tick?: Uint8Array;
  mark?: number;
};

/** The step (1…`STEPS`) of `n` units of `of`: any unit at all is the first. */
export const stepOf = (n: number, of: number) => Math.max(1, Math.min(STEPS, Math.ceil((n / Math.max(1, of)) * STEPS)));

/** The units of a layer of `size` bytes in cell `c` (0 past its end; the last is short). */
const unitsIn = (size: number, cellBytes: number, c: number) =>
  Math.max(0, Math.ceil((Math.min(size, (c + 1) * cellBytes) - c * cellBytes) / UNIT));

export const diskLayer = (s: Surface) => s.layers.find((l) => l.id === 'disk');
export const overlayLayer = (s: Surface) => s.layers.find((l) => l.id === 'overlay');

/**
 * A disk's rim in cell `c` (`units`: the disk's blocks there): past its end; not examined (an image's, or every block
 * of the cell under a qcow2's table not read yet); held in steps over the blocks examined (any at all the first);
 * nothing held, where every block is examined (with some not examined, not examined: it doesn't say "no data").
 */
function rimOf(disk: SurfaceLayer | undefined, units: number, c: number) {
  if (!disk || units === 0) return RIM.absent;
  if (disk.known === 'opaque') return RIM.opaque;
  const unknown = disk.unknown?.[c] ?? 0;
  if (disk.held[c]) return RIM.step(stepOf(disk.held[c], units - unknown));
  return unknown ? RIM.opaque : RIM.empty;
}

/**
 * A remote image's tick in cell `c` (`units`: the disk's blocks there): what this browser keeps of what the cell has
 * on the server (a raw image's every block, a qcow2's blocks with data): all of it, part, or none (nothing to keep).
 */
function tickOf(disk: SurfaceLayer, units: number, c: number) {
  const kept = disk.kept?.[c] ?? 0;
  const of = disk.known === 'opaque' ? units : disk.held[c];
  if (!kept || !of) return TICK.none;
  return kept >= of ? TICK.all : TICK.part;
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
  const tick = disk?.kept ? new Uint8Array(cells) : undefined;
  for (let c = 0; c < cells; c++) {
    const units = disk ? unitsIn(disk.size, s.cellBytes, c) : 0;
    rim[c] = rimOf(disk, units, c);
    if (tick && disk && units) tick[c] = tickOf(disk, units, c);
    if (over) core[c] = coreOf(over, s.cellBytes, c);
  }
  const ends = disk ? Math.ceil(disk.size / s.cellBytes) : 0;
  const mark = ends > 0 && ends < cells ? ends - 1 : undefined;
  return { cells, rim, core, flash: s.activity && flashOf(s.activity, cells), ...(tick ? { tick } : {}), mark };
}

/** An overlay's core in cell `c`: none, its changed blocks in steps, or hollow when it only zeroed blocks there. */
function coreOf(over: SurfaceLayer, cellBytes: number, c: number) {
  const [held, zero] = [over.held[c] ?? 0, over.zero[c] ?? 0];
  if (!held && !zero) return CORE.none;
  if (!held) return CORE.hollow;
  return CORE.step(stepOf(held + zero, unitsIn(over.size, cellBytes, c)));
}

/**
 * What a view is: its disk's kind as the map knows it, an overlay laid over it, the overlay larger, live, whether some
 * of a counted disk isn't examined yet (`unknown`: a qcow2's tables not all read), and (a remote image's) whether it
 * says which of its blocks this browser keeps.
 */
export type ViewKind = {
  disk: 'counted' | 'opaque' | 'ram';
  overlay: boolean;
  grown: boolean;
  live: boolean;
  unknown?: boolean;
  kept?: boolean;
};

/** What a view of surface `s` is (`record`: the disk's record kind; `overlay`: one is chosen; `live`: the poll's). */
export function viewOf(s: Surface | undefined, record: string | undefined, overlay: boolean, live: boolean): ViewKind {
  const d = s && diskLayer(s);
  const look = s && lookOf(s);
  return {
    disk: diskKindOf(s, record),
    overlay,
    grown: look?.mark !== undefined,
    live,
    unknown: !!d?.unknown?.some((n) => n > 0),
    kept: !!d?.kept,
  };
}

/** A view's disk kind from its surface (what its disk layer says), else from the disk's record kind. */
export function diskKindOf(s: Surface | undefined, record: string | undefined): ViewKind['disk'] {
  if (record === 'ramdisk') return 'ram';
  const d = s && diskLayer(s);
  if (d) return d.known;
  return record === 'file' || record === 'url' ? 'opaque' : 'counted';
}

/** A legend's entry: its look and its words' key. */
export type LegendEntry = { rim: number; core: number; flash: number; tick: number; key: string };

/**
 * The looks a view can show (its legend), in the grid's order: the disk's, past its end, what this browser keeps of a
 * remote image (ticks over the disk's look), the overlay's, the activity.
 */
export function legendOf(v: ViewKind): LegendEntry[] {
  const out: LegendEntry[] = [];
  const add = (key: string, rim: number, core: number = CORE.none, flash = 0, tick: number = TICK.none) =>
    out.push({ key, rim, core, flash, tick });
  if (v.disk === 'opaque') add('disks:surface-look.legend.opaque', RIM.opaque);
  else {
    add('disks:surface-look.legend.empty', RIM.empty);
    add(v.disk === 'ram' ? 'disks:surface-look.legend.ram' : 'disks:surface-look.legend.some', RIM.step(1));
    add('disks:surface-look.legend.full', RIM.step(STEPS));
    if (v.unknown) add('disks:surface-look.legend.opaque', RIM.opaque);
  }
  if (v.grown) add('disks:surface-look.legend.absent', RIM.absent);
  const under = v.disk === 'opaque' ? RIM.opaque : RIM.step(2);
  if (v.kept) {
    add('disks:surface-look.legend.keptSome', under, CORE.none, 0, TICK.part);
    add('disks:surface-look.legend.kept', under, CORE.none, 0, TICK.all);
  }
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

/**
 * What the disk holds in cell `c`, in words: of its blocks examined (all of them but a qcow2's under a table not read
 * yet, said after), and what this browser keeps of a remote image's.
 */
function diskWords(s: Surface, c: number, ram: boolean): Msg[] {
  const disk = diskLayer(s);
  const units = disk ? unitsIn(disk.size, s.cellBytes, c) : 0;
  if (!disk || units === 0) return [msg('disks:surface-look.disk.past')];
  if (disk.known === 'opaque')
    return [
      disk.kept?.[c]
        ? msg('disks:surface-look.disk.kept', { kept: disk.kept[c], of: units })
        : msg('disks:surface-look.disk.opaque'),
    ];
  const unknown = Math.min(units, disk.unknown?.[c] ?? 0);
  if (unknown === units) return [msg('disks:surface-look.disk.unknownAll')];
  const held = disk.held[c];
  const out = unknown ? partWords(held, units - unknown, unknown) : [heldWords(held, units, ram)];
  if (disk.kept && held)
    out.push(
      disk.kept[c]
        ? msg('disks:surface-look.disk.keptData', { kept: disk.kept[c] })
        : msg('disks:surface-look.disk.keptNone'),
    );
  return out;
}

/** What the disk holds in a cell of `units` blocks, all examined, in words (a ramdisk's in memory). */
const heldWords = (held: number, units: number, ram: boolean) =>
  held
    ? msg(ram ? 'disks:surface-look.ram.held' : 'disks:surface-look.disk.held', { held, count: units })
    : msg(ram ? 'disks:surface-look.ram.empty' : 'disks:surface-look.disk.empty');

/** What a qcow2 holds in a cell of which `known` blocks are examined and `unknown` not yet, in words. */
const partWords = (held: number, known: number, unknown: number) => [
  held
    ? msg('disks:surface-look.disk.heldKnown', { held, count: known })
    : msg('disks:surface-look.disk.emptyKnown', { count: known }),
  msg('disks:surface-look.disk.unknown', { count: unknown }),
];

/** Why an image isn't examined, in words (the line under the map while no square is pointed at). */
const WHY_WORDS = {
  raw: 'disks:surface-look.why.raw',
  tables: 'disks:surface-look.why.tables',
  large: 'disks:surface-look.why.large',
  permission: 'disks:surface-look.why.permission',
  remote: 'disks:surface-look.why.remote',
} as const;

/** Why part of a qcow2's map isn't examined yet, in words (its tables not all read: a remote image's, or too large to read whole). */
const SOME_WORDS: Partial<Record<OpaqueWhy, string>> = {
  tables: 'disks:surface-look.why.tablesSome',
  large: 'disks:surface-look.why.largeSome',
};

/** How much of a remote image this browser keeps, in words. */
const keptWords = (disk: SurfaceLayer) => {
  const kept = disk.kept?.reduce((n, k) => n + k, 0) ?? 0;
  return kept ? msg('disks:surface-look.keptAll', { size: sizeText(kept * UNIT) }) : msg('disks:surface-look.keptNone');
};

/**
 * What a view of an image not examined holds as a whole, in words: why it isn't, how much of it this browser keeps
 * (a remote image's), and the overlay's changes over it.
 */
export function opaqueWords(disk: SurfaceLayer, overlay: boolean): Msg[] {
  const out = [disk.why ? msg(WHY_WORDS[disk.why]) : msg('disks:surface-look.why.unknown')];
  if (disk.kept) out.push(keptWords(disk));
  if (overlay) out.push(msg('disks:surface-look.overOpaque'));
  return out;
}

/**
 * What view `s` holds as a whole, in words (the line under the map while no square is pointed at): why an image isn't
 * examined, or why part of a qcow2 isn't yet; that it holds nothing; else how to read it; and how much of a remote
 * image this browser keeps.
 */
export function wholeWords(s: Surface, overlay: boolean, ram = false): Msg[] {
  const d = diskLayer(s);
  if (d?.known === 'opaque') return opaqueWords(d, overlay);
  const unknown = d?.unknown?.reduce((n, k) => n + k, 0) ?? 0;
  let first: Msg;
  if (d && unknown) first = unknownWords(d, unknown);
  else if (holdsNothing(s)) return [msg(ram ? 'disks:surface-look.ramEmpty' : 'disks:surface-look.empty')];
  else first = msg('disks:surface-look.hint');
  return d?.kept ? [first, keptWords(d)] : [first];
}

/** Why a qcow2's `unknown` blocks (of its layer `d`) aren't examined yet: none of it is, or part. */
function unknownWords(d: SurfaceLayer, unknown: number) {
  const why = d.why ?? 'tables';
  if (unknown >= Math.ceil(d.size / UNIT)) return msg(WHY_WORDS[why]);
  return msg(SOME_WORDS[why] ?? 'disks:surface-look.why.tablesSome');
}

/** Whether a view holds nothing at all: no data in the disk, no change in the overlay. */
function holdsNothing(s: Surface) {
  const [d, o] = [diskLayer(s), overlayLayer(s)];
  const none = (l: SurfaceLayer | undefined) => !l || l.held.every((x) => x === 0);
  return none(d) && (!o || (none(o) && o.zero.every((x) => x === 0)));
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
  const out = [msg('disks:surface-look.at', { from: sizeText(from), to: sizeText(to) }), ...diskWords(s, c, ram)];
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
 * A range's blocks as the detail's grid draws them (32 × 32): the disk's (with data, or not examined), the overlay's,
 * zeroed, past the end, and a tick on those of a remote image this browser keeps.
 */
export function detailLook(d: RangeDetail): SurfaceLook {
  const n = d.blocks.length;
  const rim = new Uint8Array(n);
  const core = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const b = d.blocks[i];
    if (b === 4) rim[i] = RIM.absent;
    else if (b === 1) rim[i] = RIM.step(STEPS);
    else if (b === 5) rim[i] = RIM.opaque;
    else if (b === 2) core[i] = CORE.step(STEPS);
    else if (b === 3) core[i] = CORE.hollow;
  }
  const tick = d.kept?.map((k) => (k ? TICK.all : TICK.none));
  return { cells: n, rim, core, ...(tick ? { tick } : {}) };
}

/** A range's blocks counted by whose they are (`kept`: the disk's this browser keeps). */
export function detailCounts(d: RangeDetail) {
  const n = [0, 0, 0, 0, 0, 0];
  for (const b of d.blocks) n[b]++;
  const kept = d.kept?.reduce((k, x) => k + (x ? 1 : 0), 0) ?? 0;
  return { disk: n[1], overlay: n[2], zeroed: n[3], past: n[4], unknown: n[5], kept };
}

/** What the disk holds in a range's detail `d` (its counts `c`), in words: not examined, or its blocks of data, those not examined yet, and those kept. */
function rangeDiskWords(d: RangeDetail, c: ReturnType<typeof detailCounts>, v: Pick<ViewKind, 'disk' | 'kept'>): Msg[] {
  if (v.disk === 'opaque')
    return [
      msg('disks:surface-look.range.opaque'),
      ...(c.kept ? [msg('disks:surface-look.range.kept', { blocks: c.kept })] : []),
    ];
  // The disk's blocks of the range (those the overlay doesn't cover).
  const own = d.blocks.length - c.past - c.overlay - c.zeroed;
  if (c.unknown && c.unknown >= own) return [msg('disks:surface-look.range.unknownAll')];
  const out: Msg[] = [];
  if (!c.disk)
    out.push(msg(c.unknown ? 'disks:surface-look.range.diskEmptyKnown' : 'disks:surface-look.range.diskEmpty'));
  else if ('disk' in d.runs) out.push(msg('disks:surface-look.range.diskRuns', { blocks: c.disk, count: d.runs.disk }));
  else out.push(msg('disks:surface-look.range.disk', { count: c.disk }));
  if (c.unknown) out.push(msg('disks:surface-look.range.unknown', { count: c.unknown }));
  if (v.kept && c.disk) out.push(msg('disks:surface-look.range.keptData', { count: c.kept }));
  return out;
}

/** A range's detail in words: where it is, what it holds and in how many runs (fragments) its store keeps it. */
export function detailWords(
  d: RangeDetail,
  v: Pick<ViewKind, 'disk' | 'overlay' | 'kept'>,
  diskSize = Infinity,
): Msg[] {
  const c = detailCounts(d);
  const out = [
    msg('disks:surface-look.range', { from: sizeText(d.range * RANGE), to: sizeText((d.range + 1) * RANGE) }),
  ];
  if (d.range * RANGE >= diskSize) out.push(msg('disks:surface-look.range.past'));
  else out.push(...rangeDiskWords(d, c, v));
  if (v.overlay) {
    if (c.overlay) out.push(msg('disks:surface-look.range.overlayRuns', { blocks: c.overlay, count: d.runs.overlay }));
    else out.push(msg('disks:surface-look.range.overlayNone'));
    if (c.zeroed) out.push(msg('disks:surface-look.range.zeroed', { count: c.zeroed }));
  }
  if (d.content?.read === 0 && c.disk + c.overlay > 0) out.push(msg('disks:surface-look.range.uncheckable'));
  else if (d.content)
    out.push(msg('disks:surface-look.range.content', { count: d.content.read, zeros: d.content.zeros }));
  return out;
}

/**
 * Whether Check contents could read a block of range `d`: the overlay's (always read), or the disk's when its image
 * is examined (an image not examined, `opaque`, has its blocks read by no check).
 */
export function checkable(d: RangeDetail, v: Pick<ViewKind, 'disk'>) {
  const c = detailCounts(d);
  return c.overlay > 0 || (v.disk !== 'opaque' && c.disk > 0);
}
