// The on-screen keyboard's keys and what pressing them does (docs/frontend.md "The on-screen keyboard"; Osk.svelte draws
// it): a US ANSI layout of 104 keys by `KeyboardEvent.code`, the compact layout's pages of the same keys for a phone's
// width, and `OskKeys`, which turns pointers on the keys into the keys' downs and ups as a real keyboard's: each pointer
// (a finger, the mouse, a pen) holds its key until it lifts, so several fingers chord; a modifier tapped alone stays
// down (latched) for the keys that follow.

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

/** The two layouts: the full keyboard (`KEYS`), or the compact one's pages (`PAGES`) for a phone's width. */
export type Layout = 'full' | 'compact';

/** The compact layout's size in key widths: ten keys across, as a phone's keyboard. */
export const COMPACT_WIDTH = 10, COMPACT_HEIGHT = 5;

/** A page of the compact layout: its id (its tab's words are the catalog's `osk:Osk.page.<id>`) and its keys. */
export type Page = { id: string; keys: Key[] };

/** The bottom row of the letters' and the symbols' pages: Esc, Tab, the left modifiers but Shift, Space, Enter. */
const bottom = () => row(4, 0, ['Escape', 'Tab', 'ControlLeft', 'MetaLeft', 'AltLeft', ['Space', 3], ['Enter', 2]]);
/** The keypad's column width on its page (four in 6.5u, the arrows' block beside). */
const NUM = 1.625;

/**
 * The compact layout's pages, each 10u by 5: the letters and digits; the symbols, the right-hand modifiers and the
 * arrows; the F keys and the navigation block; the numeric keypad. Every key of the full layout is on one at least
 * (Shift, Ctrl, Alt and the editing keys on several), so latched modifiers carry from one page to the next.
 */
export const PAGES: Page[] = [
  { id: 'main', keys: [
    ...row(0, 0, '1234567890'.split('').map((d) => `Digit${d}`)),
    ...row(1, 0, letters('QWERTYUIOP')),
    ...row(2, 0, [...letters('ASDFGHJKL'), 'Semicolon']),
    ...row(3, 0, [['ShiftLeft', 1.5], ...letters('ZXCVBNM'), ['Backspace', 1.5]]),
    ...bottom(),
  ] },
  { id: 'symbols', keys: [
    ...row(0, 0, [['Backquote', 2], ['Minus', 2], ['Equal', 2], ['BracketLeft', 2], ['BracketRight', 2]]),
    ...row(1, 0, [['Backslash', 2], ['Quote', 2], ['Comma', 2], ['Period', 2], ['Slash', 2]]),
    ...row(2, 0, [['CapsLock', 1.5], ['ShiftRight', 1.75], ['AltRight', 1.75], ['MetaRight', 1.75], ['ContextMenu', 1.5], ['ControlRight', 1.75]]),
    ...row(3, 0, [['ShiftLeft', 1.5], ['ArrowLeft', 1.75], ['ArrowDown', 1.75], ['ArrowUp', 1.75], ['ArrowRight', 1.75], ['Backspace', 1.5]]),
    ...bottom(),
  ] },
  { id: 'fn', keys: [
    ...row(0, 0, F(1, 10)),
    ...row(1, 0, [...F(11, 12), 1, 'PrintScreen', 'ScrollLock', 'Pause', 1, 'Insert', 'Home', 'PageUp']),
    ...row(2, 0, [['Escape', 1.5], ['Tab', 1.5], ['Backspace', 1.75], ['Enter', 1.75], 0.5, 'Delete', 'End', 'PageDown']),
    ...row(3, 0, [['ShiftLeft', 2.5], ['ControlLeft', 2], ['AltLeft', 2], 1.5, 'ArrowUp']),
    ...row(4, 0, [['MetaLeft', 2], ['Space', 4.5], 0.5, 'ArrowLeft', 'ArrowDown', 'ArrowRight']),
  ] },
  { id: 'keypad', keys: [
    ...row(0, 0, [['NumLock', NUM], ['NumpadDivide', NUM], ['NumpadMultiply', NUM], ['NumpadSubtract', NUM], 0.5, ['Backspace', 3]]),
    ...row(1, 0, [['Numpad7', NUM], ['Numpad8', NUM], ['Numpad9', NUM], NUM + 0.5, ['Escape', 1.5], ['Tab', 1.5]]),
    ...row(1, 3 * NUM, [['NumpadAdd', NUM]], 2),
    ...row(2, 0, [['Numpad4', NUM], ['Numpad5', NUM], ['Numpad6', NUM], NUM + 0.5, ['ShiftLeft', 1.5], ['ControlLeft', 1.5]]),
    ...row(3, 0, [['Numpad1', NUM], ['Numpad2', NUM], ['Numpad3', NUM], NUM + 1.5, 'ArrowUp']),
    ...row(3, 3 * NUM, [['NumpadEnter', NUM]], 2),
    ...row(4, 0, [['Numpad0', 2 * NUM], ['NumpadDecimal', NUM], NUM + 0.5, 'ArrowLeft', 'ArrowDown', 'ArrowRight']),
  ] },
];

/** The window width (CSS pixels) below which the keyboard is compact unless forced full (the full one's keys are ~25 px there). */
export const COMPACT_BELOW = 600;

/** The layout a window `width` wide gets on its own. */
export const autoLayout = (width: number): Layout => (width < COMPACT_BELOW ? 'compact' : 'full');

/**
 * The layout shown: the one forced by the bar's button, while the window's width hasn't crossed `COMPACT_BELOW` since
 * (`forced` is only kept while it differs from `autoLayout`), else the automatic one.
 */
export const layoutOf = (width: number, forced: Layout | undefined): Layout => forced ?? autoLayout(width);

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
 * A latched modifier tapped again is released at once. A modifier pressed while another key is held is held with it.
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
    // A modifier pressed while another key is held is held with it: released when let go, never latched.
    const withKey = MODIFIERS.has(code) && [...this.held.keys()].some((c) => !MODIFIERS.has(c));
    this.held.set(code, n + 1);
    this.pointers.set(id, { code, at: this.now(), chorded: withKey });
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

  /** Something else was pressed (a click on the screen) while modifiers are held: they were used, as with a key. */
  used() {
    for (const p of this.pointers.values()) if (MODIFIERS.has(p.code)) p.chorded = true;
  }

  /** Key `code` was typed elsewhere (the physical keyboard): a key other than a modifier ends the latches (`next`). */
  typed(code: string) {
    if (MODIFIERS.has(code) || this.mode !== 'next' || !this.latched.size) return;
    if ([...this.held.keys()].some((c) => !MODIFIERS.has(c))) return;
    this.unlatch();
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
