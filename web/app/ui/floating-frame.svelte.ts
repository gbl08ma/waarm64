// A floating window's frame (FloatingWindow.svelte): where it is and how big (CSS pixels), kept in the browser's window
// (when the window shrinks too) and remembered under its key (settings.ts `windows`); moved by its title bar and
// resized, width and height, by its grip.
import { remember, settings, type Place } from '../settings.ts';

/** A size, CSS pixels. */
export type Size = { w: number; h: number };

type Drag = { id: number; kind: 'move' | 'size'; x0: number; y0: number; at: Place };

export class FloatingFrame {
  x = $state(0);
  y = $state(0);
  w = $state(0);
  h = $state(0);
  readonly #key: string;
  readonly #min: Size;
  #drag: Drag | undefined;

  /** Where it was left, or `size` (default) centred in the window. */
  constructor(key: string, min: Size, size: Size) {
    this.#key = key;
    this.#min = min;
    const saved = settings().windows?.[key];
    this.w = saved?.w ?? size.w;
    this.h = saved?.h ?? size.h;
    this.x = saved?.x ?? (innerWidth - this.w) / 2;
    this.y = saved?.y ?? (innerHeight - this.h) / 2;
    this.clamp();
  }

  /** Keeps it in the window: no smaller than its minimum unless the window is, no larger than the window. */
  clamp() {
    this.w = Math.max(Math.min(this.#min.w, innerWidth), Math.min(this.w, innerWidth));
    this.h = Math.max(Math.min(this.#min.h, innerHeight), Math.min(this.h, innerHeight));
    this.x = Math.max(0, Math.min(this.x, innerWidth - this.w));
    this.y = Math.max(0, Math.min(this.y, innerHeight - this.h));
  }
  save() {
    const place = { x: Math.round(this.x), y: Math.round(this.y), w: Math.round(this.w), h: Math.round(this.h) };
    remember({ windows: { ...settings().windows, [this.#key]: place } });
  }
  /** The browser's window changed size. */
  fit = () => this.clamp();

  // Moving (the title bar) and resizing (the grip, by the bottom right corner): a pointer's drag, kept when it ends.
  grab = (kind: 'move' | 'size', e: PointerEvent & { currentTarget: Element }) => {
    if (e.button !== 0 || (e.target instanceof Element && e.target.closest('button, select, input, a, label'))) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const at = { x: this.x, y: this.y, w: this.w, h: this.h };
    this.#drag = { id: e.pointerId, kind, x0: e.clientX, y0: e.clientY, at };
  };
  move = (e: PointerEvent) => {
    const d = this.#drag;
    if (d?.id !== e.pointerId) return;
    const [dx, dy] = [e.clientX - d.x0, e.clientY - d.y0];
    if (d.kind === 'move') [this.x, this.y] = [d.at.x + dx, d.at.y + dy];
    else {
      // Resized from its corner: its top left stays, and it grows no further than the window's edge.
      this.w = Math.max(this.#min.w, Math.min(d.at.w + dx, innerWidth - d.at.x));
      this.h = Math.max(this.#min.h, Math.min(d.at.h + dy, innerHeight - d.at.y));
    }
    this.clamp();
  };
  end = (e: PointerEvent) => {
    if (this.#drag?.id !== e.pointerId) return;
    this.#drag = undefined;
    this.save();
  };
}
