// A floating window's frame (FloatingWindow.svelte): where it is and how big (CSS pixels), kept in the browser's window
// (when the window shrinks too) and remembered under its key (settings.ts `windows`); moved by its title bar and
// resized by its grip: width and height, or, a window whose height follows its width (`aspect`: the on-screen
// keyboard's), its width alone. A window whose shape changes (the keyboard's layouts) keeps a size per shape (`sizeKey`).
import { remember, settings, type Place } from '../settings.ts';

/** A `tool` window's padding around its content (none at the top: the bar) and its border, CSS pixels. */
export const TOOL_PAD = 8;
export const BORDER = 1;
/** A size, CSS pixels. */
export type Size = { w: number; h: number };
/** A point, CSS pixels. */
export type Point = { x: number; y: number };
/** What the window gives its frame; read again as it changes (its props). */
export type Shape = {
  /** Its smallest size, unless the browser's window is smaller (with `aspect`, `w` alone counts). */
  min: Size;
  /** Its size the first time (with `aspect`, `w` alone counts). */
  size: Size;
  /** Its height for a width: set, the height follows the width and the grip resizes the width alone. */
  aspect?: (w: number) => number;
  /** The shape it has now: a size is remembered for each ('' for a window of one shape). */
  sizeKey?: string;
  /** Where it opens the first time, for its size (read once; centred if not given). */
  at?: (s: Size) => Point;
  /** Its size is its content's (`measured`): only its place is kept in the window, and `min` doesn't count. */
  fit?: boolean;
};

type Drag = { id: number; kind: 'move' | 'size'; x0: number; y0: number; at: Place };

/** The widest a window whose height follows its width (growing with it) can be in `room`. */
export function widest(aspect: (w: number) => number, room: Size) {
  if (aspect(room.w) <= room.h) return room.w;
  let [lo, hi] = [0, room.w];
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (aspect(mid) <= room.h) lo = mid;
    else hi = mid;
  }
  return lo;
}

export class FloatingFrame {
  x = $state(0);
  y = $state(0);
  /** Its sizes, by shape. */
  sizes = $state<Partial<Record<string, Size>>>({});
  readonly #key: string | undefined;
  readonly #shape: () => Shape;
  readonly shape = $derived.by(() => this.#shape());
  readonly sizeKey = $derived(this.shape.sizeKey ?? '');
  /** Its size now: its shape's, or that shape's first. */
  readonly w = $derived(this.sizes[this.sizeKey]?.w ?? this.shape.size.w);
  readonly h = $derived(this.shape.aspect?.(this.w) ?? this.sizes[this.sizeKey]?.h ?? this.shape.size.h);
  #drag: Drag | undefined;

  /** Where it was left (remembered under `key`; none: never), or where `shape.at` says (default: centred). */
  constructor(key: string | undefined, shape: () => Shape) {
    this.#key = key;
    this.#shape = shape;
    const saved = key === undefined ? undefined : settings().windows?.[key];
    if (saved) this.sizes = saved.sizes ?? { [this.sizeKey]: { w: saved.w, h: saved.h } };
    const at = this.shape.at?.({ w: this.w, h: this.h }) ?? {
      x: (innerWidth - this.w) / 2,
      y: (innerHeight - this.h) / 2,
    };
    this.x = saved?.x ?? at.x;
    this.y = saved?.y ?? at.y;
    this.clamp();
  }

  /** Keeps it in the window: no smaller than its minimum unless the window is, no larger than the window. */
  clamp() {
    const { min, aspect, fit } = this.shape;
    if (fit) {
      // Its content's size: nothing to change but its place.
    } else if (aspect) {
      const most = widest(aspect, { w: innerWidth, h: innerHeight });
      const w = Math.max(Math.min(min.w, most), Math.min(this.w, most));
      this.sizes[this.sizeKey] = { w, h: aspect(w) };
    } else {
      const w = Math.max(Math.min(min.w, innerWidth), Math.min(this.w, innerWidth));
      const h = Math.max(Math.min(min.h, innerHeight), Math.min(this.h, innerHeight));
      this.sizes[this.sizeKey] = { w, h };
    }
    this.x = Math.max(0, Math.min(this.x, innerWidth - this.w));
    this.y = Math.max(0, Math.min(this.y, innerHeight - this.h));
  }
  /** A `fit` window's content measured `s` (it moves to stay in the window). */
  measured(s: Size) {
    this.sizes[this.sizeKey] = s;
    this.clamp();
  }
  save() {
    if (this.#key === undefined) return;
    const r = Math.round;
    const kept = Object.entries(this.sizes).flatMap(([k, s]) => (s ? [[k, { w: r(s.w), h: r(s.h) }] as const] : []));
    // One shape's window keeps its size in `w` and `h` alone.
    const sizes = kept.some(([k]) => k !== '') ? { sizes: Object.fromEntries(kept) } : {};
    const place = {
      x: r(this.x),
      y: r(this.y),
      w: r(this.w),
      h: r(this.h),
      ...sizes,
    };
    remember({ windows: { ...settings().windows, [this.#key]: place } });
  }
  /** The browser's window changed size. */
  fit = () => this.clamp();

  // Moving (the title bar) and resizing (the grip): a pointer's drag, kept when it ends.
  grab = (kind: 'move' | 'size', e: PointerEvent & { currentTarget: Element }) => {
    if (e.button !== 0 || (e.target instanceof Element && e.target.closest('button, select, input, a, label'))) return;
    e.preventDefault();
    e.stopPropagation(); // a grip in the bar doesn't move it too
    e.currentTarget.setPointerCapture(e.pointerId);
    const at = { x: this.x, y: this.y, w: this.w, h: this.h };
    this.#drag = { id: e.pointerId, kind, x0: e.clientX, y0: e.clientY, at };
  };
  move = (e: PointerEvent) => {
    const d = this.#drag;
    if (d?.id !== e.pointerId) return;
    const [dx, dy] = [e.clientX - d.x0, e.clientY - d.y0];
    const { min, aspect } = this.shape;
    if (d.kind === 'move') [this.x, this.y] = [d.at.x + dx, d.at.y + dy];
    else if (aspect) {
      // Its width alone, its left edge kept: grown past the window's edge, `clamp` moves it back in.
      this.sizes[this.sizeKey] = { w: d.at.w + dx, h: aspect(d.at.w + dx) };
    } else {
      // Resized from its corner: its top left stays, and it grows no further than the window's edge.
      const w = Math.max(min.w, Math.min(d.at.w + dx, innerWidth - d.at.x));
      const h = Math.max(min.h, Math.min(d.at.h + dy, innerHeight - d.at.y));
      this.sizes[this.sizeKey] = { w, h };
    }
    this.clamp();
  };
  end = (e: PointerEvent) => {
    if (this.#drag?.id !== e.pointerId) return;
    this.#drag = undefined;
    this.save();
  };
}
