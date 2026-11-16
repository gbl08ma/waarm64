// A block map's looks and layout (BlockGrid.svelte, BlockSwatch.svelte; no DOM, so Node's tests run it): the looks a
// cell's rim and core take (indices the owner puts in the grid's byte arrays), the flash bits, and where the cells go
// in a box of device pixels.

/** How many steps of "how full" a layer's look has. */
export const STEPS = 4;

/**
 * A cell's rim (the whole square: the layer under): nothing held (an empty square), no such layer here (an outline
 * only), not examined (a flat, hatched square), then held in `STEPS` steps (`RIM.step(1)`…`RIM.step(4)`, light as full).
 */
export const RIM = {
  empty: 0,
  absent: 1,
  opaque: 2,
  step: (k: number) => 2 + Math.max(1, Math.min(STEPS, k)),
} as const;
/** A cell's core (a square inset in the rim: the layer over): none, hollow (it hides what's under), then `STEPS` steps. */
export const CORE = {
  none: 0,
  hollow: 1,
  step: (k: number) => 1 + Math.max(1, Math.min(STEPS, k)),
} as const;
/** A cell's flash bits. */
export const FLASH = { read: 1, write: 2 } as const;
/**
 * A cell's tick (a thin bar along its bottom edge, inside the rim, whatever the rim's and the core's looks: a mark of
 * its own, such as "kept here"): none, part (half the width, from the left) or all (the whole width).
 */
export const TICK = { none: 0, part: 1, all: 2 } as const;

/** Cell sizes the grid may take, CSS pixels: the smallest (what its room is counted at), the largest, the gap. */
export type CellSizes = { min: number; max: number; gap: number };
export const CELL_SIZES: CellSizes = { min: 10, max: 14, gap: 1 };
/** The smallest a cell gets when there are more cells than room (device pixels): all are still drawn. */
const FLOOR = 2;

/** Where the cells go, in device pixels: `cols` per row, a cell `size` square, `pitch` from one to the next. */
export type GridLayout = { cols: number; rows: number; size: number; pitch: number; room: number };

/** How many cells of size `s` fit in `n` pixels, a gap between each two. */
const fit = (n: number, s: number, gap: number) => Math.max(0, Math.floor((n + gap) / (s + gap)));

/**
 * The layout of `cells` cells in a box of `w` × `h` device pixels at `dpr` device pixels per CSS pixel: the largest
 * cell from `sizes` with which they all fit, grown so the columns fill the width (a little past `max`, by under a
 * cell's pitch spread over the columns); smaller than `min` (down to a few pixels) only when they don't fit at `min`.
 * `room` is how many cells of `min` the box holds.
 */
export function gridLayout(
  w: number,
  h: number,
  dpr: number,
  cells: number,
  sizes: CellSizes = CELL_SIZES,
): GridLayout {
  const gap = Math.max(1, Math.round(sizes.gap * dpr));
  const [min, max] = [Math.max(1, Math.round(sizes.min * dpr)), Math.max(1, Math.round(sizes.max * dpr))];
  const room = fit(w, min, gap) * fit(h, min, gap);
  const fits = (s: number) => {
    const cols = fit(w, s, gap);
    return cols > 0 && Math.ceil(cells / cols) * (s + gap) - gap <= h;
  };
  let s = max;
  while (s > FLOOR && !fits(s)) s--;
  const cols = Math.max(1, fit(w, s, gap));
  const rows = Math.max(1, Math.ceil(cells / cols));
  // Grown to fill the width (the columns' share of it), while the rows still fit, never past `max` by over a third.
  const grown = Math.min(Math.floor((w + gap) / cols), Math.floor((h + gap) / rows)) - gap;
  const size = Math.max(s, Math.min(grown, Math.round((max * 4) / 3)));
  return { cols, rows, size, pitch: size + gap, room };
}

/** The cell at device pixel (`x`, `y`) (a gap goes with the cell before it), or undefined past the cells. */
export function cellAt(l: GridLayout, cells: number, x: number, y: number): number | undefined {
  if (x < 0 || y < 0) return undefined;
  const [col, row] = [Math.floor(x / l.pitch), Math.floor(y / l.pitch)];
  if (col >= l.cols) return undefined;
  const i = row * l.cols + col;
  return i < cells ? i : undefined;
}

/** The keyboard's move from cell `i` for `key` (arrows by a cell or a row, Home and End to the first and last), or undefined. */
export function stepCursor(key: string, i: number, cols: number, cells: number): number | undefined {
  const last = cells - 1;
  const moves: Partial<Record<string, number>> = {
    ArrowLeft: i - 1,
    ArrowRight: i + 1,
    ArrowUp: i - cols,
    ArrowDown: i + cols,
    Home: 0,
    End: last,
  };
  const to = moves[key];
  if (to === undefined || cells === 0) return undefined;
  return Math.max(0, Math.min(last, to));
}
