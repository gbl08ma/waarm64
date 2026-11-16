// The RAM map as the block map draws it (docs/frontend.md "RAM's map"): the counts of web/ram-scan.ts turned into the
// looks of web/app/ui/block-grid.ts (pages with data as each cell's rim, in steps of how many; pages changed since the
// last look as its core, hollow where pages were only cleared), its legend, and a cell's and a range's numbers in words,
// with their guest physical addresses. Pure (no DOM): Node's tests run it.
import { msg, type Msg } from '../msg.ts';
import { paOf, RAM_PAGE } from '../ram-scan.ts';
import { RANGE, UNIT, type RamPlace, type RangeDetail, type Surface } from '../surface.ts';
import { CORE, RIM, STEPS } from './ui/block-grid.ts';
import { stepOf, type LegendEntry, type SurfaceLook } from './surface-look.ts';

export const ramLayer = (s: Surface) => s.layers.find((l) => l.id === 'ram');
export const changedLayer = (s: Surface) => s.layers.find((l) => l.id === 'changed');

/** The pages in cell `c` of a surface of `size` bytes (the last cell may be short). */
const pagesIn = (size: number, cellBytes: number, c: number) =>
  Math.max(0, Math.ceil((Math.min(size, (c + 1) * cellBytes) - c * cellBytes) / UNIT));

/** The looks of RAM's surface `s`: its pages with data as the rims, those changed (or cleared) since the last look as the cores. */
export function ramLookOf(s: Surface): SurfaceLook {
  const cells = Math.ceil(s.size / s.cellBytes);
  const rim = new Uint8Array(cells);
  const core = new Uint8Array(cells);
  const ram = ramLayer(s);
  const changed = changedLayer(s);
  for (let c = 0; c < cells; c++) {
    const pages = pagesIn(s.size, s.cellBytes, c);
    const data = ram?.held[c] ?? 0;
    rim[c] = data ? RIM.step(stepOf(data, pages)) : RIM.empty;
    if (!changed) continue;
    const [moved, cleared] = [changed.held[c] ?? 0, changed.zero[c] ?? 0];
    if (moved) core[c] = CORE.step(stepOf(moved + cleared, pages));
    else if (cleared) core[c] = CORE.hollow;
  }
  return { cells, rim, core };
}

/** The looks the RAM map can show (its legend): the pages' and, once a second look can tell, the changes. */
export function ramLegend(changes: boolean): LegendEntry[] {
  const out: LegendEntry[] = [];
  const add = (key: string, rim: number, core: number = CORE.none) => out.push({ key, rim, core, flash: 0, tick: 0 });
  add('machine:ram-look.legend.zero', RIM.empty);
  add('machine:ram-look.legend.some', RIM.step(1));
  add('machine:ram-look.legend.full', RIM.step(STEPS));
  if (changes) {
    add('machine:ram-look.legend.changed', RIM.step(2), CORE.step(3));
    add('machine:ram-look.legend.cleared', RIM.step(2), CORE.hollow);
  }
  return out;
}

/** A guest physical address in hex (`0x4000_0000`: groups of four digits, as the platform's docs write them). */
export function paText(pa: number) {
  const hex = pa.toString(16).padStart(8, '0');
  const groups: string[] = [];
  for (let end = hex.length; end > 0; end -= 4) groups.unshift(hex.slice(Math.max(0, end - 4), end));
  return `0x${groups.join('_')}`;
}

/** Where bytes `from` to `to` (map offsets) are, in words: their guest physical addresses, the end's exclusive. */
const whereWords = (layout: RamPlace[], from: number, to: number) =>
  msg('machine:ram-look.at', { from: paText(paOf(layout, from)), to: paText(paOf(layout, to - 1) + 1) });

/** Cell `c`'s numbers in words (the hover line): where it is, its pages with data, those changed and cleared since the last look. */
export function ramCellWords(s: Surface, layout: RamPlace[], c: number): Msg[] {
  const from = c * s.cellBytes;
  const to = Math.min(s.size, from + s.cellBytes);
  const pages = pagesIn(s.size, s.cellBytes, c);
  const data = ramLayer(s)?.held[c] ?? 0;
  const out = [
    whereWords(layout, from, to),
    data ? msg('machine:ram-look.data', { data, count: pages }) : msg('machine:ram-look.zero', { count: pages }),
  ];
  const changed = changedLayer(s);
  if (changed) out.push(...changeWords(changed.held[c] ?? 0, changed.zero[c] ?? 0));
  return out;
}

/** Pages changed and cleared since the last look, in words (none: that nothing changed). */
function changeWords(moved: number, cleared: number): Msg[] {
  if (!moved && !cleared) return [msg('machine:ram-look.unchanged')];
  const out: Msg[] = [];
  if (moved) out.push(msg('machine:ram-look.changed', { count: moved }));
  if (cleared) out.push(msg('machine:ram-look.cleared', { count: cleared }));
  return out;
}

const sum = (a: Uint32Array | undefined) => a?.reduce((n, k) => n + k, 0) ?? 0;

/**
 * What RAM holds as a whole, in words (the line under the map while no square is pointed at): how much of it holds
 * data, how much changed since the last look (or that changes show from the next look), and how to read the map.
 */
export function ramWholeWords(s: Surface): Msg[] {
  const data = sum(ramLayer(s)?.held) * UNIT;
  const changed = changedLayer(s);
  return [
    msg('machine:ram-look.whole', { size: data, total: s.size }),
    changed
      ? msg('machine:ram-look.wholeChanged', { size: sum(changed.held) * UNIT, cleared: sum(changed.zero) * UNIT })
      : msg('machine:ram-look.firstLook'),
    msg('machine:ram-look.hint'),
  ];
}

/** A range's pages as the detail's grid draws them (32 × 32): zero, data, changed, cleared, past RAM's end. */
export function ramDetailLook(d: RangeDetail): SurfaceLook {
  const n = d.blocks.length;
  const rim = new Uint8Array(n);
  const core = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const b = d.blocks[i];
    if (b === RAM_PAGE.past) rim[i] = RIM.absent;
    else if (b === RAM_PAGE.data || b === RAM_PAGE.changed) rim[i] = RIM.step(STEPS);
    if (b === RAM_PAGE.changed) core[i] = CORE.step(STEPS);
    else if (b === RAM_PAGE.gone) core[i] = CORE.hollow;
  }
  return { cells: n, rim, core };
}

/** A range's pages counted by state. */
export function ramDetailCounts(d: RangeDetail) {
  const n = [0, 0, 0, 0, 0];
  for (const b of d.blocks) n[b]++;
  return {
    zero: n[RAM_PAGE.zero],
    data: n[RAM_PAGE.data] + n[RAM_PAGE.changed],
    changed: n[RAM_PAGE.changed],
    cleared: n[RAM_PAGE.gone],
    past: n[RAM_PAGE.past],
  };
}

/** A range's detail in words: where it is, its pages with data, and (once a look can tell) those changed and cleared. */
export function ramDetailWords(d: RangeDetail, layout: RamPlace[], size: number, changes: boolean): Msg[] {
  const c = ramDetailCounts(d);
  const pages = d.blocks.length - c.past;
  const from = d.range * RANGE;
  const out = [
    whereWords(layout, from, Math.min(size, from + RANGE)),
    c.data
      ? msg('machine:ram-look.data', { data: c.data, count: pages })
      : msg('machine:ram-look.zero', { count: pages }),
  ];
  if (changes) out.push(...changeWords(c.changed, c.cleared));
  return out;
}
