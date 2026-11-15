// How a block map's cell is drawn on a canvas (BlockGrid.svelte, and its legend's BlockSwatch.svelte, so the two never
// disagree): the rim as the whole square, the core as a smaller square inset in it, the tick along its bottom edge, a
// flash over them, and the rings that mark a cell (hovered, pinned, the keyboard's). Colours are the theme's `--map-*`
// tokens, read from an element.
import { CORE, FLASH, RIM, STEPS, TICK } from './block-grid.ts';

/** The tokens' colours, as CSS colour strings a canvas takes. */
export type Palette = {
  empty: string;
  absent: string;
  opaque: string;
  opaqueLine: string;
  rim: string[];
  core: string[];
  hollow: string;
  tick: string;
  read: string;
  write: string;
  end: string;
  pin: string;
  hover: string;
  cursor: string;
};

/** The palette as the theme has it at `el`. */
export function readPalette(el: Element): Palette {
  const style = getComputedStyle(el);
  const v = (name: string) => style.getPropertyValue(`--${name}`).trim();
  const steps = (kind: string) => Array.from({ length: STEPS }, (_, k) => v(`map-${kind}-${String(k + 1)}`));
  return {
    empty: v('map-empty'),
    absent: v('map-absent'),
    opaque: v('map-opaque'),
    opaqueLine: v('map-opaque-line'),
    rim: steps('rim'),
    core: steps('core'),
    hollow: v('map-hollow'),
    tick: v('map-tick'),
    read: v('map-read'),
    write: v('map-write'),
    end: v('map-end'),
    pin: v('map-pin'),
    hover: v('text-dim'),
    cursor: v('accent'),
  };
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** A line's width at cell size `s` (device pixels): one pixel at a CSS pixel's worth, more as cells get large. */
export const lineOf = (s: number) => Math.max(1, Math.round(s / 12));
/** How far the core is inset in the rim (device pixels). */
export const insetOf = (s: number) => Math.max(2, Math.round(s * 0.24));

/** A frame `w` thick just inside the square at (`x`, `y`), `s` across: four rectangles, so it stays crisp. */
export function frame(ctx: Ctx, x: number, y: number, s: number, w: number) {
  ctx.fillRect(x, y, s, w);
  ctx.fillRect(x, y + s - w, s, w);
  ctx.fillRect(x, y + w, w, s - 2 * w);
  ctx.fillRect(x + s - w, y + w, w, s - 2 * w);
}

function drawRim(ctx: Ctx, x: number, y: number, s: number, rim: number, p: Palette) {
  if (rim === RIM.absent) {
    ctx.fillStyle = p.absent;
    frame(ctx, x, y, s, lineOf(s));
    return;
  }
  if (rim === RIM.opaque) {
    ctx.fillStyle = p.opaque;
    ctx.fillRect(x, y, s, s);
    // A hatch: two diagonals across the square, the look that says "not examined" without its colour.
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, s, s);
    ctx.clip();
    ctx.strokeStyle = p.opaqueLine;
    ctx.lineWidth = lineOf(s) * 1.5;
    ctx.beginPath();
    for (const o of [0, s / 2, s]) {
      ctx.moveTo(x - s / 2 + o, y + s + 0.5);
      ctx.lineTo(x + s / 2 + o, y - 0.5);
    }
    ctx.stroke();
    ctx.restore();
    return;
  }
  ctx.fillStyle = rim >= RIM.step(1) ? p.rim[Math.min(STEPS, rim - RIM.opaque) - 1] : p.empty;
  ctx.fillRect(x, y, s, s);
}

function drawCore(ctx: Ctx, x: number, y: number, s: number, core: number, p: Palette) {
  if (core === CORE.none) return;
  const d = insetOf(s);
  const [cx, cy, cs] = [x + d, y + d, s - 2 * d];
  const w = lineOf(s);
  // A dark edge just outside the core, so it reads as sitting on the rim whatever the rim's step.
  ctx.fillStyle = p.empty;
  frame(ctx, cx - w, cy - w, cs + 2 * w, w);
  if (core === CORE.hollow) {
    ctx.fillRect(cx, cy, cs, cs);
    ctx.fillStyle = p.hollow;
    frame(ctx, cx, cy, cs, Math.max(w, Math.round(cs / 6)));
    return;
  }
  ctx.fillStyle = p.core[Math.min(STEPS, core - CORE.hollow) - 1];
  ctx.fillRect(cx, cy, cs, cs);
}

/** A tick's height at cell size `s` (device pixels): about a sixth of the cell (2 CSS pixels at the default sizes). */
export const tickOf = (s: number) => Math.max(1, Math.round(s / 6));

/**
 * The tick of a cell `s` across: a bar along its bottom edge, the whole width (`TICK.all`) or the left half
 * (`TICK.part`), with a dark line over it (on a cell of 8 device pixels or more) so it reads on every rim.
 */
function drawTick(ctx: Ctx, x: number, y: number, s: number, tick: number, p: Palette) {
  if (tick !== TICK.part && tick !== TICK.all) return;
  const h = tickOf(s);
  const w = tick === TICK.all ? s : Math.max(1, Math.round(s / 2));
  if (s >= 8) {
    const line = lineOf(s);
    ctx.fillStyle = p.empty;
    ctx.fillRect(x, y + s - h - line, w + (tick === TICK.all ? 0 : line), line);
    if (tick === TICK.part) ctx.fillRect(x + w, y + s - h, line, h);
  }
  ctx.fillStyle = p.tick;
  ctx.fillRect(x, y + s - h, w, h);
}

/** Cell (`x`, `y`), `s` across: its rim, then its core on it, then its tick. */
export function drawCell(ctx: Ctx, x: number, y: number, s: number, rim: number, core: number, p: Palette, tick = 0) {
  drawRim(ctx, x, y, s, rim, p);
  drawCore(ctx, x, y, s, core, p);
  drawTick(ctx, x, y, s, tick, p);
}

/** A flash over the cell at `alpha` (1 when it starts): a write fills it, a read rings it. */
export function drawFlash(ctx: Ctx, x: number, y: number, s: number, bits: number, alpha: number, p: Palette) {
  if (alpha <= 0) return;
  ctx.save();
  if (bits & FLASH.write) {
    ctx.globalAlpha = alpha * 0.85;
    ctx.fillStyle = p.write;
    ctx.fillRect(x, y, s, s);
  }
  if (bits & FLASH.read) {
    ctx.globalAlpha = alpha;
    const r = Math.max(1, Math.round(s / 6));
    ctx.fillStyle = p.read;
    frame(ctx, x, y, s, r);
    // A dark line inside the ring: it stands out on a light cell as on a dark one.
    ctx.fillStyle = p.empty;
    frame(ctx, x + r, y + r, s - 2 * r, lineOf(s));
  }
  ctx.restore();
}

/** A ring `w` thick hugging the cell from outside (over the gap, and over its neighbours' edges when wider). */
export function drawRing(ctx: Ctx, x: number, y: number, s: number, w: number, colour: string) {
  ctx.fillStyle = colour;
  frame(ctx, x - w, y - w, s + 2 * w, w);
}
