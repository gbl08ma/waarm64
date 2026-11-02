// The on-screen keyboard's keys and what pressing them does (docs/frontend.md "The on-screen keyboard"; Osk.svelte draws
// it): a US ANSI layout of 104 keys by `KeyboardEvent.code`, and `OskKeys`, which turns pointers on the keys into the
// keys' downs and ups as a real keyboard's: each pointer (a finger, the mouse, a pen) holds its key until it lifts, so
// several fingers chord; a modifier tapped alone stays down (latched) for the keys that follow.

/** A key: its code, where it is and how big, in key widths (`u`). */
export type Key = { code: string; x: number; y: number; w: number; h: number };

/** The layout's size in key widths. */
export const WIDTH = 23, HEIGHT = 6.5;

/** Row `y` from `x`: a code is a key 1u wide, `[code, w]` a wider one, a number a gap. */
function row(y: number, x: number, items: (string | [string, number] | number)[], h = 1): Key[] {
  const out: Key[] = [];
  for (const it of items) {
    if (typeof it === 'number') { x += it; continue; }
    const [code, w] = typeof it === 'string' ? [it, 1] : it;
    out.push({ code, x, y, w, h });
    x += w;
  }
  return out;
}
const letters = (s: string) => s.split('').map((c) => `Key${c}`);

// i18n-ignore-next: KeyboardEvent.code names
const F = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, k) => `F${a + k}`);

/** The keys: the main block (15u), the navigation block, the numeric keypad. */
export const KEYS: Key[] = [
  ...row(0, 0, ['Escape', 1, ...F(1, 4), 0.5, ...F(5, 8), 0.5, ...F(9, 12), 0.5, 'PrintScreen', 'ScrollLock', 'Pause']),
  ...row(1.5, 0, ['Backquote', ...'1234567890'.split('').map((d) => `Digit${d}`), 'Minus', 'Equal', ['Backspace', 2], 0.5, 'Insert', 'Home', 'PageUp', 0.5, 'NumLock', 'NumpadDivide', 'NumpadMultiply', 'NumpadSubtract']),
  ...row(2.5, 0, [['Tab', 1.5], ...letters('QWERTYUIOP'), 'BracketLeft', 'BracketRight', ['Backslash', 1.5], 0.5, 'Delete', 'End', 'PageDown', 0.5, 'Numpad7', 'Numpad8', 'Numpad9']),
  ...row(2.5, 22, ['NumpadAdd'], 2),
  ...row(3.5, 0, [['CapsLock', 1.75], ...letters('ASDFGHJKL'), 'Semicolon', 'Quote', ['Enter', 2.25], 4, 'Numpad4', 'Numpad5', 'Numpad6']),
  ...row(4.5, 0, [['ShiftLeft', 2.25], ...letters('ZXCVBNM'), 'Comma', 'Period', 'Slash', ['ShiftRight', 2.75], 1.5, 'ArrowUp', 1.5, 'Numpad1', 'Numpad2', 'Numpad3']),
  ...row(4.5, 22, ['NumpadEnter'], 2),
  ...row(5.5, 0, [['ControlLeft', 1.25], ['MetaLeft', 1.25], ['AltLeft', 1.25], ['Space', 6.25], ['AltRight', 1.25], ['MetaRight', 1.25], ['ContextMenu', 1.25], ['ControlRight', 1.25], 0.5, 'ArrowLeft', 'ArrowDown', 'ArrowRight', 0.5, ['Numpad0', 2], 'NumpadDecimal']),
];

/** The keys that modify others: tapped alone, they stay down for the next key. */
export const MODIFIERS = new Set(['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight']);

/** A character key's legends on a US keyboard: unshifted, shifted. */
const CHARS: Record<string, [string, string]> = Object.fromEntries([
  // i18n-ignore-next: a US keyboard's legends
  ...'`~ 1! 2@ 3# 4$ 5% 6^ 7& 8* 9( 0) -_ =+ [{ ]} \\| ;: \'" ,< .> /?'.split(' ').map((p, i) => [
    ['Backquote', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0', 'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash', 'Semicolon', 'Quote', 'Comma', 'Period', 'Slash'][i],
    [p[0], p[1]] as [string, string],
  ]),
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((c) => [`Key${c}`, [c.toLowerCase(), c] as [string, string]]),
  ...'0123456789'.split('').map((d) => [`Numpad${d}`, [d, d] as [string, string]]),
  ['NumpadDivide', ['/', '/']], ['NumpadMultiply', ['*', '*']], ['NumpadSubtract', ['-', '-']], ['NumpadAdd', ['+', '+']],
  ['NumpadDecimal', ['.', '.']], ['Space', [' ', ' ']],
]);

/** A key's legends: one or two characters (a shifted one over the other), or undefined for a named key (the catalog's). */
export function legends(code: string): { top?: string; main: string } | undefined {
  if (code === 'Space') return { main: '' };
  if (/^F\d+$/.test(code)) return { main: code };
  const c = CHARS[code];
  if (!c) return undefined;
  if (code.startsWith('Key') || code.startsWith('Numpad')) return { main: c[1] };
  return { top: c[1], main: c[0] };
}

/** What a terminal makes of a key (web/input.ts `terminalBytes`): its `KeyboardEvent.key` with Shift down or not. */
export function keyOf(code: string, shift: boolean): string {
  const c = CHARS[code];
  if (c) return c[shift ? 1 : 0];
  if (code === 'NumpadEnter') return 'Enter';
  return code;
}

/** The modifiers down with a key. */
export type Mods = { shift: boolean; ctrl: boolean; alt: boolean; meta: boolean };

/** How a tapped modifier is let go: after the next key (`next`), or when it's tapped again (`toggle`). */
export type ModifierMode = 'next' | 'toggle';

/** A modifier held this long alone (ms) is a hold, not a tap: released when let go, not latched. */
export const HOLD_MS = 500;

/**
 * Pointers on the keys to the keys' downs and ups (`send`). A key goes down when the first pointer presses it and up
 * when the last lets it go. A modifier let go is released if it was held with another key, or held alone for
 * `HOLD_MS`; tapped alone, it's latched: down until the next key's release (`next`) or its own next tap (`toggle`).
 * A latched modifier tapped again is released at once.
 */
export class OskKeys {
  mode: ModifierMode;
  private readonly send: (code: string, down: boolean) => void;
  private readonly now: () => number;
  /** The pointers on keys: the key, when it was pressed, whether another key was pressed meanwhile; `undo` for a tap that released a latch. */
  private readonly pointers = new Map<number, { code: string; at: number; chorded: boolean; undo?: boolean }>();
  /** The keys down by pointers, with how many hold each. */
  private readonly held = new Map<string, number>();
  /** The modifiers latched down. */
  private readonly latched = new Set<string>();
  /** Called after any change (to redraw). */
  onChange: () => void = () => {};

  constructor(send: (code: string, down: boolean) => void, mode: ModifierMode = 'next', now: () => number = () => performance.now()) {
    this.send = send;
    this.mode = mode;
    this.now = now;
  }

  /** Whether key `code` is down: `held` by a pointer, `latched`, or not. */
  state(code: string): 'held' | 'latched' | undefined {
    return this.held.has(code) ? 'held' : this.latched.has(code) ? 'latched' : undefined;
  }

  /** The modifiers down, held or latched (for a terminal's characters). */
  mods(): Mods {
    const on = (side: string) => !!(this.state(`${side}Left`) || this.state(`${side}Right`));
    return { shift: on('Shift'), ctrl: on('Control'), alt: on('Alt'), meta: on('Meta') };
  }

  /** Pointer `id` presses key `code`. */
  press(id: number, code: string) {
    if (this.pointers.has(id)) this.release(id);
    if (MODIFIERS.has(code) && this.latched.has(code) && !this.held.has(code)) {
      this.latched.delete(code);
      this.send(code, false);
      this.pointers.set(id, { code, at: this.now(), chorded: false, undo: true });
      return this.onChange();
    }
    const n = this.held.get(code) ?? 0;
    this.held.set(code, n + 1);
    this.pointers.set(id, { code, at: this.now(), chorded: false });
    if (!MODIFIERS.has(code)) for (const p of this.pointers.values()) if (MODIFIERS.has(p.code)) p.chorded = true;
    if (n === 0) this.send(code, true);
    this.onChange();
  }

  /** Pointer `id` lets its key go (lifted, or cancelled by the browser). */
  release(id: number) {
    const p = this.pointers.get(id);
    if (!p) return;
    this.pointers.delete(id);
    if (p.undo) return;
    const n = (this.held.get(p.code) ?? 1) - 1;
    if (n > 0) { this.held.set(p.code, n); return; }
    this.held.delete(p.code);
    if (MODIFIERS.has(p.code)) {
      if (!p.chorded && this.now() - p.at < HOLD_MS) this.latched.add(p.code);
      else this.send(p.code, false);
    } else {
      this.send(p.code, false);
      if (this.mode === 'next' && ![...this.held.keys()].some((c) => !MODIFIERS.has(c))) this.unlatch();
    }
    this.onChange();
  }

  /** Releases the latched modifiers. */
  private unlatch() {
    for (const c of [...this.latched].reverse()) this.send(c, false);
    this.latched.clear();
  }

  /** Releases everything: the keys held, then the latched modifiers. */
  releaseAll() {
    for (const c of [...this.held.keys()].reverse()) this.send(c, false);
    this.held.clear();
    this.pointers.clear();
    this.unlatch();
    this.onChange();
  }

  /** Forgets everything without sending (the guest's keys were released elsewhere: a blur). */
  forget() {
    this.held.clear();
    this.pointers.clear();
    this.latched.clear();
    this.onChange();
  }
}
