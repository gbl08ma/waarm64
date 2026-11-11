// The on-screen keyboard's frame (Osk.svelte): its layout (the one the window's width gets, or the one the bar's
// button forced, kept until the window's width crosses to where the automatic one is the same), where it is and how
// wide (CSS pixels; a width per layout), kept in the window and remembered; moved by its bar and resized by its grip.
import { autoLayout, COMPACT_HEIGHT, COMPACT_WIDTH, HEIGHT, layoutOf, WIDTH, type Layout } from './osk.ts';
import { remember, settings } from './settings.ts';

/** Its padding (no top one: the bar) and its border, CSS pixels; the padding is the style's too (`--pad`). */
export const PAD = 8;
const BORDER = 1;
const DIMS = {
  full: { cols: WIDTH, rows: HEIGHT, bar: 22, min: 320 },
  compact: { cols: COMPACT_WIDTH, rows: COMPACT_HEIGHT, bar: 28, min: 240 },
};
const unitIn = (l: Layout, w: number) => (w - 2 * PAD - 2 * BORDER) / DIMS[l].cols;
const heightIn = (l: Layout, w: number) => unitIn(l, w) * DIMS[l].rows + DIMS[l].bar + PAD + 2 * BORDER;

type Drag = { id: number; kind: 'move' | 'size'; x0: number; y0: number; x: number; y: number; w: number };

export class OskFrame {
  forced = $state<Layout>();
  winWidth = $state(innerWidth);
  readonly layout = $derived(layoutOf(this.winWidth, this.forced));
  readonly dims = $derived(DIMS[this.layout]);
  widths = $state({ full: 0, compact: 0 });
  x = $state(0);
  y = $state(0);
  /** Its width now, and a key unit's. */
  readonly w = $derived(this.widths[this.layout]);
  readonly u = $derived(unitIn(this.layout, this.w));
  #drag: Drag | undefined;

  /** Where it was left, or centered at the bottom. */
  constructor() {
    const saved = settings().osk;
    this.forced = saved?.layout;
    this.widths = {
      full: saved?.w ?? Math.min(960, innerWidth - 16),
      compact: saved?.wc ?? Math.min(480, innerWidth - 16),
    };
    const first = layoutOf(innerWidth, saved?.layout);
    this.x = saved?.x ?? (innerWidth - this.widths[first]) / 2;
    this.y = saved?.y ?? innerHeight - heightIn(first, this.widths[first]) - 40;
  }

  /** The widest it can be: the window's width, and the width whose height is the window's. */
  #widest() {
    const d = this.dims;
    return Math.min(innerWidth, ((innerHeight - d.bar - PAD - 2 * BORDER) / d.rows) * d.cols + 2 * PAD + 2 * BORDER);
  }
  /** Keeps it in the window (a layout shown anew too: the compact one is taller for its width). */
  clamp() {
    const l = this.layout;
    this.widths[l] = Math.max(Math.min(this.dims.min, this.#widest()), Math.min(this.widths[l], this.#widest()));
    this.x = Math.max(0, Math.min(this.x, innerWidth - this.widths[l]));
    this.y = Math.max(0, Math.min(this.y, innerHeight - heightIn(l, this.widths[l])));
  }
  save() {
    remember({
      osk: {
        x: Math.round(this.x),
        y: Math.round(this.y),
        w: Math.round(this.widths.full),
        wc: Math.round(this.widths.compact),
        layout: this.forced,
      },
    });
  }
  /** The window's size changed: a forced layout the width now gets anyway is no longer forced. */
  fit = () => {
    this.winWidth = innerWidth;
    if (this.forced && this.forced === autoLayout(innerWidth)) {
      this.forced = undefined;
      this.save();
    }
    this.clamp();
  };
  /** The bar's button: the other layout, forced while the window's width keeps the automatic one the same. */
  switchLayout() {
    const next: Layout = this.layout === 'compact' ? 'full' : 'compact';
    this.forced = next === autoLayout(innerWidth) ? undefined : next;
    this.clamp();
    this.save();
  }

  // Moving (the bar) and resizing (the grip, by its left edge): a pointer's drag, kept when it ends.
  grab = (kind: 'move' | 'size', e: PointerEvent & { currentTarget: Element }) => {
    if (e.button !== 0 || (e.target instanceof Element && e.target.closest('button'))) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    this.#drag = { id: e.pointerId, kind, x0: e.clientX, y0: e.clientY, x: this.x, y: this.y, w: this.w };
  };
  move = (e: PointerEvent) => {
    const d = this.#drag;
    if (d?.id !== e.pointerId) return;
    const [dx, dy] = [e.clientX - d.x0, e.clientY - d.y0];
    if (d.kind === 'move') [this.x, this.y] = [d.x + dx, d.y + dy];
    else this.widths[this.layout] = d.w + dx;
    this.clamp();
  };
  end = (e: PointerEvent) => {
    if (this.#drag?.id !== e.pointerId) return;
    this.#drag = undefined;
    this.save();
  };
}
