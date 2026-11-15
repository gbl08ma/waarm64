// BlockGrid.svelte's canvas: the cells drawn once into a picture of their own (again when the data, the size or the
// theme change), then the page's canvas composed from it with what moves over it: the flashes fading (a frame each
// only while one fades: no idle loop), the end of the layer under, and the rings of the hovered, pinned and
// keyboard's cells.
import { drawCell, drawFlash, drawRing, readPalette, type Palette } from './block-draw.ts';
import { CELL_SIZES, gridLayout, type CellSizes, type GridLayout } from './block-grid.ts';

/** How long a flash fades, ms. */
export const FADE_MS = 600;

/** What the grid shows. Arrays are taken as they are: a new picture is new arrays (their insides aren't watched). */
export type GridData = { cells: number; rim: Uint8Array; core: Uint8Array; tick?: Uint8Array };
/** The cells marked over the picture. */
export type GridMarks = { mark?: number; pinned?: number; hover?: number; cursor?: number };

export class GridPainter {
  readonly #canvas: HTMLCanvasElement;
  #base: OffscreenCanvas | undefined;
  #palette: Palette;
  #data: GridData = { cells: 0, rim: new Uint8Array(), core: new Uint8Array() };
  #marks: GridMarks = {};
  /** The flashes fading: per cell its bits and when it started (`performance.now()`). */
  #fades = new Map<number, { bits: number; t0: number }>();
  #frame = 0;
  #sizes = CELL_SIZES;
  /** With `prefers-reduced-motion`: flashes are marks that stay until the next flash array. */
  reduced = false;
  layout: GridLayout = { cols: 1, rows: 0, size: 1, pitch: 2, room: 0 };
  /** Device pixels per CSS pixel, and the margin round the cells (a ring's width) in device pixels. */
  dpr = 1;
  pad = 2;

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas;
    this.#palette = readPalette(canvas);
  }

  /** The canvas is `w` × `h` device pixels now: the cells laid out again (the room counted), and drawn. */
  resize(w: number, h: number, dpr: number, sizes: CellSizes = CELL_SIZES) {
    this.dpr = dpr;
    this.pad = Math.max(2, Math.round(2 * dpr));
    [this.#canvas.width, this.#canvas.height] = [w, h];
    this.layout = gridLayout(w - 2 * this.pad, h - 2 * this.pad, dpr, this.#data.cells, sizes);
    this.#sizes = sizes;
    this.#paint();
  }
  /** The theme's colours read again. */
  retheme() {
    this.#palette = readPalette(this.#canvas);
    this.#paint();
  }
  data(d: GridData) {
    const relayout = d.cells !== this.#data.cells;
    this.#data = d;
    if (relayout) this.resize(this.#canvas.width, this.#canvas.height, this.dpr, this.#sizes);
    else this.#paint();
  }
  marks(m: GridMarks) {
    this.#marks = m;
    this.#compose();
  }
  /** A flash array: its cells start to fade now (reduced motion: they replace the marks shown). */
  flash(flash: Uint8Array | undefined) {
    const now = performance.now();
    if (this.reduced) this.#fades.clear();
    if (flash)
      for (let i = 0; i < Math.min(flash.length, this.#data.cells); i++) {
        if (flash[i]) this.#fades.set(i, { bits: flash[i], t0: now });
      }
    this.#compose();
  }
  /** The top left of cell `i`, device pixels. */
  at(i: number): [number, number] {
    const l = this.layout;
    return [this.pad + (i % l.cols) * l.pitch, this.pad + Math.floor(i / l.cols) * l.pitch];
  }
  stop() {
    cancelAnimationFrame(this.#frame);
    this.#frame = 0;
  }

  #paint() {
    const { width, height } = this.#canvas;
    if (!width || !height) return;
    if (this.#base?.width !== width || this.#base.height !== height) this.#base = new OffscreenCanvas(width, height);
    const ctx = this.#base.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    const { cells, rim, core, tick } = this.#data;
    const s = this.layout.size;
    for (let i = 0; i < cells; i++) {
      const [x, y] = this.at(i);
      drawCell(ctx, x, y, s, rim[i] ?? 0, core[i] ?? 0, this.#palette, tick?.[i] ?? 0);
    }
    this.#compose();
  }

  #compose = () => {
    this.#frame = 0;
    const ctx = this.#canvas.getContext('2d');
    if (!ctx || !this.#base) return;
    ctx.clearRect(0, 0, this.#canvas.width, this.#canvas.height);
    ctx.drawImage(this.#base, 0, 0);
    const fading = this.#drawFades(ctx);
    this.#drawMarks(ctx);
    if (fading && !this.#frame) this.#frame = requestAnimationFrame(this.#compose);
  };

  /** The flashes at their fade now; whether one still fades (for the next frame). */
  #drawFades(ctx: CanvasRenderingContext2D) {
    const now = performance.now();
    const s = this.layout.size;
    for (const [i, f] of this.#fades) {
      const alpha = this.reduced ? 1 : 1 - (now - f.t0) / FADE_MS;
      if (alpha <= 0 || i >= this.#data.cells) {
        this.#fades.delete(i);
        continue;
      }
      const [x, y] = this.at(i);
      drawFlash(ctx, x, y, s, f.bits, alpha, this.#palette);
    }
    return !this.reduced && this.#fades.size > 0;
  }

  #drawMarks(ctx: CanvasRenderingContext2D) {
    const { mark, pinned, hover, cursor } = this.#marks;
    const p = this.#palette;
    if (mark !== undefined) this.#drawEnd(ctx, mark);
    const s = this.layout.size;
    const ring = (i: number | undefined, w: number, colour: string) => {
      if (i === undefined || i < 0 || i >= this.#data.cells) return;
      const [x, y] = this.at(i);
      drawRing(ctx, x, y, s, w, colour);
    };
    const w = this.pad;
    ring(hover, Math.max(1, Math.round(this.dpr)), p.hover);
    ring(pinned, w, p.pin);
    ring(cursor, w, p.cursor);
  }

  /**
   * The end of the layer under, after cell `m`: the boundary between the cells up to it and those past it, a step
   * across its row (over the cells past it in its row, down their left, under the row's cells up to it).
   */
  #drawEnd(ctx: CanvasRenderingContext2D, m: number) {
    const l = this.layout;
    if (m < 0 || m >= this.#data.cells - 1) return;
    const w = Math.max(2, Math.round(2 * this.dpr));
    const g = l.pitch - l.size;
    const col = (m % l.cols) + 1;
    const [, top] = this.at(m);
    const xs = (c: number) => this.pad + c * l.pitch - g / 2 - w / 2;
    const right = this.pad + l.cols * l.pitch - g;
    const edge = (y: number) => y - g / 2 - w / 2;
    ctx.fillStyle = this.#palette.end;
    if (col < l.cols) {
      const x = xs(col);
      ctx.fillRect(x, edge(top), right - x, w);
      ctx.fillRect(x, edge(top), w, l.pitch + w);
      ctx.fillRect(this.pad, edge(top + l.pitch), x - this.pad + w, w);
    } else ctx.fillRect(this.pad, edge(top + l.pitch), right - this.pad, w);
  }
}
