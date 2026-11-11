// The status bar editor's drags (StatusEditor.svelte): a chip moved along the bar or dropped out on the palette, a
// palette item dropped on the bar. A mouse drags through HTML5 drag and drop; a finger or a pen through pointer
// events after a long press (a swipe still scrolls the page). The editor registers its elements (the bar, the
// palette, each chip's box and its button: `chip(at)`, `pick(at)` attachments) and says what a drop does (`Ops`).
import type { Attachment } from 'svelte/attachments';
import { nameOf, type Item } from './statusbar.ts';

/** What's dragged: chip `from`, or palette item `add`. */
export type Drag = { from?: number; add?: Item };

/** What a drop does to the bar. */
export type Ops = {
  items: () => Item[];
  insert: (item: Item, at: number) => void;
  move: (from: number, to: number) => void;
  remove: (at: number) => void;
};

/** A press held this long (ms) without moving more than `SLOP` px picks up what's under it. */
const HOLD = 350;
const SLOP = 8;

type Touch = { id: number; x: number; y: number; d: Drag; timer?: ReturnType<typeof setTimeout>; active: boolean };

/** A registry of elements by index, through attachments. */
function registry<E extends HTMLElement>() {
  // Not state: what's drawn doesn't follow it.
  const els: Record<number, E | undefined> = {};
  const attach =
    (at: number): Attachment<E> =>
    (el) => {
      els[at] = el;
      return () => {
        if (els[at] === el) els[at] = undefined;
      };
    };
  return { els, attach };
}

export class ChipDrag {
  /** Where the dragged thing would land: before chip `over` (the bar's length: at its end). */
  over = $state<number>();
  /** The chip a finger holds (drawn lifted). */
  lifted = $state<number>();
  /** A finger holds a chip over the palette: lifting it there removes it. */
  leaving = $state(false);
  bar: HTMLElement | undefined;
  palette: HTMLElement | undefined;
  readonly #ops: Ops;
  #drag: Drag | undefined;
  #touch: Touch | undefined;
  #swallowClick = false;
  readonly #chips = registry<HTMLElement>();
  readonly #picks = registry<HTMLElement>();
  /** Chip `at`'s box (where a drop lands is by the boxes). */
  readonly chip = this.#chips.attach;
  /** Chip `at`'s button (what the focus goes back to after a move). */
  readonly pick = this.#picks.attach;

  constructor(ops: Ops) {
    this.#ops = ops;
  }

  /** A chip (not a palette item) is being dragged. */
  get fromChip() {
    return this.#drag?.from !== undefined;
  }

  /** Puts the focus on chip `at`'s button (after the keyboard moved it). */
  focus(at: number | undefined) {
    if (at !== undefined) queueMicrotask(() => this.#picks.els[at]?.focus());
  }

  // The mouse: HTML5 drag and drop.
  start = (e: DragEvent, d: Drag) => {
    // A long press's own drag (Chromium on a touchscreen): the pointer's.
    if (this.#touch) return e.preventDefault();
    this.#drag = d;
    if (!e.dataTransfer) return;
    e.dataTransfer.effectAllowed = 'move';
    const item = d.add ?? (d.from === undefined ? undefined : this.#ops.items()[d.from]);
    if (item) e.dataTransfer.setData('text/plain', nameOf(item));
  };
  overChip = (e: DragEvent & { currentTarget: HTMLElement }, at: number) => {
    if (!this.#drag) return;
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    this.over = e.clientX > r.left + r.width / 2 ? at + 1 : at;
  };
  overEnd = (e: DragEvent) => {
    if (!this.#drag) return;
    e.preventDefault();
    if (e.target === e.currentTarget) this.over = this.#ops.items().length;
  };
  drop = (e: DragEvent) => {
    e.preventDefault();
    const d = this.#drag;
    const to = this.over ?? this.#ops.items().length;
    this.end();
    if (d?.add) this.#ops.insert(d.add, to);
    else if (d?.from !== undefined) this.#ops.move(d.from, to);
  };
  /** A chip dropped on the palette goes away. */
  dropOut = (e: DragEvent) => {
    e.preventDefault();
    const d = this.#drag;
    this.end();
    if (d?.from !== undefined) this.#ops.remove(d.from);
  };
  end = () => {
    this.#drag = undefined;
    this.over = undefined;
  };

  // A finger or a pen: pressed and held still for `HOLD` ms, it picks up the chip or palette item, then follows the
  // pointer through hit tests until it's lifted. Moving first is a scroll (the browser's: touch-action stays auto, and
  // the drag's touchmoves are what's cancelled).
  press = (e: PointerEvent, d: Drag) => {
    if (e.pointerType === 'mouse' || !e.isPrimary || this.#touch) return;
    const touch: Touch = { id: e.pointerId, x: e.clientX, y: e.clientY, d, active: false };
    this.#touch = touch;
    touch.timer = setTimeout(() => {
      if (this.#touch !== touch) return;
      touch.active = true;
      this.#drag = touch.d;
      this.lifted = touch.d.from;
      if ('vibrate' in navigator) navigator.vibrate(10);
    }, HOLD);
    addEventListener('pointermove', this.#follow);
    addEventListener('pointerup', this.#lift);
    addEventListener('pointercancel', this.cancel);
    addEventListener('touchmove', this.#still, { passive: false });
    addEventListener('contextmenu', this.#still);
  };
  /**
   * Where the pointer is: before which chip (by the chips' boxes in its row, so the drop mark that shifts them doesn't
   * change the answer), at the bar's end, or over the palette (leaving).
   */
  #aim(x: number, y: number) {
    const el = document.elementFromPoint(x, y);
    this.leaving = false;
    if (el && this.bar?.contains(el)) {
      const row = Object.entries(this.#chips.els)
        .flatMap(([at, c]): [number, HTMLElement][] => (c ? [[Number(at), c]] : []))
        .filter(([, c]) => {
          const r = c.getBoundingClientRect();
          return y >= r.top && y < r.bottom;
        })
        .sort(([a], [b]) => a - b);
      const next = row.find(([, c]) => {
        const r = c.getBoundingClientRect();
        return x < r.left + r.width / 2;
      });
      const last = row.at(-1);
      this.over = next ? next[0] : last ? last[0] + 1 : this.#ops.items().length;
    } else {
      this.over = undefined;
      this.leaving = this.fromChip && !!el && !!this.palette?.contains(el);
    }
  }
  #follow = (e: PointerEvent) => {
    const touch = this.#touch;
    if (touch?.id !== e.pointerId) return;
    if (!touch.active) {
      if (Math.hypot(e.clientX - touch.x, e.clientY - touch.y) > SLOP) this.cancel(e);
      return;
    }
    this.#aim(e.clientX, e.clientY);
  };
  #lift = (e: PointerEvent) => {
    const held = this.#touch;
    if (held?.id !== e.pointerId) return;
    if (!held.active) return this.cancel(e);
    this.#aim(e.clientX, e.clientY);
    const to = this.over;
    const out = this.leaving;
    this.cancel(e);
    this.#swallowClick = true;
    setTimeout(() => (this.#swallowClick = false), 0);
    if (held.d.add) {
      if (to !== undefined) this.#ops.insert(held.d.add, to);
    } else if (held.d.from !== undefined) {
      if (out) this.#ops.remove(held.d.from);
      else if (to !== undefined) this.#ops.move(held.d.from, to);
    }
  };
  /** Ends a finger's drag (`e`: its pointer's, or any other event: the editor going away). */
  cancel = (e?: Event) => {
    if (this.#touch && e instanceof PointerEvent && e.pointerId !== this.#touch.id) return;
    clearTimeout(this.#touch?.timer);
    this.#touch = undefined;
    this.lifted = undefined;
    this.leaving = false;
    this.end();
    removeEventListener('pointermove', this.#follow);
    removeEventListener('pointerup', this.#lift);
    removeEventListener('pointercancel', this.cancel);
    removeEventListener('touchmove', this.#still);
    removeEventListener('contextmenu', this.#still);
  };
  /** While a finger drags, the page doesn't scroll under it and the long press opens no menu. */
  #still = (e: Event) => {
    if (this.#touch?.active || (e.type === 'contextmenu' && this.#touch)) e.preventDefault();
  };
  /** The click a lifted finger may end with isn't a choice or an add. */
  guard = (e: MouseEvent) => {
    if (this.#swallowClick) {
      e.stopPropagation();
      e.preventDefault();
    }
  };
}
