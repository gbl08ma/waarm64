// The on-screen keyboard's keys and what pressing them does (docs/frontend.md "The on-screen keyboard"; Osk.svelte draws
// it): a PC keyboard by `KeyboardEvent.code` (US ANSI's 104 keys, and ISO's, ABNT2's or JIS's extra keys when the
// machine's layout has them, JIS's input-method keys), the compact layout's pages of the same keys for a phone's width
// (the layout's letters beside US's), the legends and
// characters of the machine's layout (web/app/keymaps.ts), and `OskKeys`, which turns pointers on the keys into the keys' downs and ups as a real keyboard's: each pointer
// (a finger, the mouse, a pen) holds its key until it lifts, so several fingers chord; a modifier tapped alone stays
// down (latched) for the keys that follow.

import { KEYMAPS, type Keymap } from './keymaps.ts';

/** A key: its code, where it is and how big, in key widths (`u`). */
export type Key = { code: string; x: number; y: number; w: number; h: number };

/** The layout's size in key widths. */
export const WIDTH = 23,
  HEIGHT = 6.5;

/** Row `y` from `x`: a code is a key 1u wide, `[code, w]` a wider one, a number a gap. */
function row(y: number, x: number, items: (string | [string, number] | number)[], h = 1): Key[] {
  const out: Key[] = [];
  for (const it of items) {
    if (typeof it === 'number') {
      x += it;
      continue;
    }
    const [code, w] = typeof it === 'string' ? [it, 1] : it;
    out.push({ code, x, y, w, h });
    x += w;
  }
  return out;
}
const letters = (s: string) => s.split('').map((c) => `Key${c}`);

// i18n-ignore-next: KeyboardEvent.code names
const F = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, k) => `F${a + k}`);

/** The US layout's characters: the keyboard's when the machine sets none (the guest's default). */
export const US: Keymap = KEYMAPS.us;
/** Layout `id`'s characters (a `KEYBOARD_LAYOUTS` id), or the US layout's. */
export const keymapOf = (id: string | undefined): Keymap => (id && KEYMAPS[id]) || US;

/** JIS's input-method keys: Muhenkan, Henkan, Katakana/Hiragana (a JIS keyboard's, beside Space). */
export const IME_KEYS = ['NonConvert', 'Convert', 'KanaMode'];
/** Whether keymap `map` is a JIS keyboard's (its yen key): it has the input-method keys. */
const isJis = (map: Keymap) => !!map.IntlYen;
/** JIS's bottom row: Space narrowed for Muhenkan left of it, Henkan and Katakana/Hiragana right (15u, as US's). */
const JIS_BOTTOM: [string, number][] = [
  ['ControlLeft', 1.25],
  ['MetaLeft', 1],
  ['AltLeft', 1.25],
  ['NonConvert', 1.25],
  ['Space', 3.25],
  ['Convert', 1.25],
  ['KanaMode', 1.25],
  ['AltRight', 1.25],
  ['MetaRight', 1],
  ['ContextMenu', 1],
  ['ControlRight', 1.25],
];

/**
 * The full keyboard for keymap `map`: the main block (15u), the navigation block, the numeric keypad; ISO's key beside
 * the left Shift (IntlBackslash), ABNT2's and JIS's beside the right Shift (IntlRo), JIS's beside Backspace (IntlYen)
 * and its input-method keys beside Space (`IME_KEYS`) where `map` has them, the keys beside them narrower.
 */
export function fullKeys(map: Keymap = US): Key[] {
  const iso = !!map.IntlBackslash,
    ro = !!map.IntlRo,
    yen = !!map.IntlYen,
    jis = isJis(map);
  return [
    ...row(0, 0, [
      'Escape',
      1,
      ...F(1, 4),
      0.5,
      ...F(5, 8),
      0.5,
      ...F(9, 12),
      0.5,
      'PrintScreen',
      'ScrollLock',
      'Pause',
    ]),
    ...row(1.5, 0, [
      'Backquote',
      ...'1234567890'.split('').map((d) => `Digit${d}`),
      'Minus',
      'Equal',
      ...(yen ? ['IntlYen', ['Backspace', 1] as [string, number]] : [['Backspace', 2] as [string, number]]),
      0.5,
      'Insert',
      'Home',
      'PageUp',
      0.5,
      'NumLock',
      'NumpadDivide',
      'NumpadMultiply',
      'NumpadSubtract',
    ]),
    ...row(2.5, 0, [
      ['Tab', 1.5],
      ...letters('QWERTYUIOP'),
      'BracketLeft',
      'BracketRight',
      ['Backslash', 1.5],
      0.5,
      'Delete',
      'End',
      'PageDown',
      0.5,
      'Numpad7',
      'Numpad8',
      'Numpad9',
    ]),
    ...row(2.5, 22, ['NumpadAdd'], 2),
    ...row(3.5, 0, [
      ['CapsLock', 1.75],
      ...letters('ASDFGHJKL'),
      'Semicolon',
      'Quote',
      ['Enter', 2.25],
      4,
      'Numpad4',
      'Numpad5',
      'Numpad6',
    ]),
    ...row(4.5, 0, [
      ...(iso ? [['ShiftLeft', 1.25] as [string, number], 'IntlBackslash'] : [['ShiftLeft', 2.25] as [string, number]]),
      ...letters('ZXCVBNM'),
      'Comma',
      'Period',
      'Slash',
      ...(ro ? ['IntlRo', ['ShiftRight', 1.75] as [string, number]] : [['ShiftRight', 2.75] as [string, number]]),
      1.5,
      'ArrowUp',
      1.5,
      'Numpad1',
      'Numpad2',
      'Numpad3',
    ]),
    ...row(4.5, 22, ['NumpadEnter'], 2),
    ...row(5.5, 0, [
      ...(jis
        ? JIS_BOTTOM
        : ([
            ['ControlLeft', 1.25],
            ['MetaLeft', 1.25],
            ['AltLeft', 1.25],
            ['Space', 6.25],
            ['AltRight', 1.25],
            ['MetaRight', 1.25],
            ['ContextMenu', 1.25],
            ['ControlRight', 1.25],
          ] as [string, number][])),
      0.5,
      'ArrowLeft',
      'ArrowDown',
      'ArrowRight',
      0.5,
      ['Numpad0', 2],
      'NumpadDecimal',
    ]),
  ];
}
/** The US keyboard's 104 keys. */
export const KEYS: Key[] = fullKeys();

/** The two layouts: the full keyboard (`KEYS`), or the compact one's pages (`PAGES`) for a phone's width. */
export type Layout = 'full' | 'compact';

/** The compact layout's size in key widths: ten keys across, as a phone's keyboard. */
export const COMPACT_WIDTH = 10,
  COMPACT_HEIGHT = 5;

/** A page of the compact layout: its id (its tab's words are the catalog's `osk:Osk.page.<id>`) and its keys. */
export type Page = { id: string; keys: Key[] };

/** The bottom row of the letters' and the symbols' pages: Esc, Tab, the left modifiers but Shift, Space, Enter. */
const bottom = () => row(4, 0, ['Escape', 'Tab', 'ControlLeft', 'MetaLeft', 'AltLeft', ['Space', 3], ['Enter', 2]]);
/** The keypad's column width on its page (four in 6.5u, the arrows' block beside). */
const NUM = 1.625;

/** A lowercase letter with a capital (not ß, µ or º: no capital of their own), as a letter key's unshifted character. */
const cased = (c: string | undefined) => !!c && c.toUpperCase() !== c && c.toUpperCase().toLowerCase() === c;

/**
 * The compact letters' page's rows for keymap `map`: US's letter block (with `;`), and beside it, in the full
 * keyboard's order, the keys of the same row whose character is a letter on `map` (German's Ü left of the letters'
 * end, Ö and Ä after L; Turkish's Ö and Ç after M). Backslash is on the home row on an ISO keyboard, on Q's on ANSI.
 */
export function letterRows(map: Keymap = US): string[][] {
  const iso = !!map.IntlBackslash;
  const pick = (codes: string[]) => codes.filter((c) => map[c] && cased(map[c][0]));
  return [
    [...pick(['Backquote']), ...'1234567890'.split('').map((d) => `Digit${d}`), ...pick(['Minus', 'Equal'])],
    [...letters('QWERTYUIOP'), ...pick(['BracketLeft', 'BracketRight', ...(iso ? [] : ['Backslash'])])],
    [...letters('ASDFGHJKL'), 'Semicolon', ...pick(['Quote', ...(iso ? ['Backslash'] : [])])],
    [...pick(['IntlBackslash']), ...letters('ZXCVBNM'), ...pick(['Comma', 'Period', 'Slash', 'IntlRo'])],
  ];
}

/**
 * The compact layout's pages for keymap `map`, each 10u by 5: the letters and digits (the layout's letters beside them,
 * `letterRows`); the symbols (the punctuation keys the letters' page hasn't, the layout's extra keys, JIS's
 * input-method keys), the right-hand modifiers and the arrows; the F keys and the navigation block; the numeric keypad.
 * Every key of `fullKeys(map)` is on one at least (Shift, Ctrl, Alt and the editing keys on several), so latched
 * modifiers carry from one page to the next.
 */
export function pages(map: Keymap = US): Page[] {
  const [digits, top, home, low] = letterRows(map);
  const onMain = new Set([digits, top, home, low].flat());
  // The symbols' page: the punctuation keys the letters' page hasn't, the layout's extra keys and JIS's input-method keys, in two rows.
  const punct = [
    'Backquote',
    'Minus',
    'Equal',
    'BracketLeft',
    'BracketRight',
    'Backslash',
    'Quote',
    'Comma',
    'Period',
    'Slash',
    ...['IntlBackslash', 'IntlRo', 'IntlYen'].filter((c) => map[c]),
    ...(isJis(map) ? IME_KEYS : []),
  ].filter((c) => !onMain.has(c));
  const half = Math.ceil(punct.length / 2);
  const spread = (y: number, codes: string[]) =>
    row(
      y,
      0,
      codes.map((c) => [c, COMPACT_WIDTH / Math.max(codes.length, 1)] as [string, number]),
    );
  /** A row of keys 1u wide, narrower when more than ten. */
  const fit = (y: number, codes: string[]) => (codes.length > COMPACT_WIDTH ? spread(y, codes) : row(y, 0, codes));
  // Shift and Backspace beside the bottom letters: 1.5u each beside seven, 1.25u beside more (the letters narrower).
  const side = Math.max(1.25, (COMPACT_WIDTH - low.length) / 2),
    lw = Math.min(1, (COMPACT_WIDTH - 2 * side) / low.length);
  return [
    {
      id: 'main',
      keys: [
        ...fit(0, digits),
        ...fit(1, top),
        ...fit(2, home),
        ...row(3, 0, [['ShiftLeft', side], ...low.map((c) => [c, lw] as [string, number]), ['Backspace', side]]),
        ...bottom(),
      ],
    },
    {
      id: 'symbols',
      keys: [
        ...spread(0, punct.slice(0, half)),
        ...spread(1, punct.slice(half)),
        ...row(2, 0, [
          ['CapsLock', 1.5],
          ['ShiftRight', 1.75],
          ['AltRight', 1.75],
          ['MetaRight', 1.75],
          ['ContextMenu', 1.5],
          ['ControlRight', 1.75],
        ]),
        ...row(3, 0, [
          ['ShiftLeft', 1.5],
          ['ArrowLeft', 1.75],
          ['ArrowDown', 1.75],
          ['ArrowUp', 1.75],
          ['ArrowRight', 1.75],
          ['Backspace', 1.5],
        ]),
        ...bottom(),
      ],
    },
    {
      id: 'fn',
      keys: [
        ...row(0, 0, F(1, 10)),
        ...row(1, 0, [...F(11, 12), 1, 'PrintScreen', 'ScrollLock', 'Pause', 1, 'Insert', 'Home', 'PageUp']),
        ...row(2, 0, [
          ['Escape', 1.5],
          ['Tab', 1.5],
          ['Backspace', 1.75],
          ['Enter', 1.75],
          0.5,
          'Delete',
          'End',
          'PageDown',
        ]),
        ...row(3, 0, [['ShiftLeft', 2.5], ['ControlLeft', 2], ['AltLeft', 2], 1.5, 'ArrowUp']),
        ...row(4, 0, [['MetaLeft', 2], ['Space', 4.5], 0.5, 'ArrowLeft', 'ArrowDown', 'ArrowRight']),
      ],
    },
    {
      id: 'keypad',
      keys: [
        ...row(0, 0, [
          ['NumLock', NUM],
          ['NumpadDivide', NUM],
          ['NumpadMultiply', NUM],
          ['NumpadSubtract', NUM],
          0.5,
          ['Backspace', 3],
        ]),
        ...row(1, 0, [['Numpad7', NUM], ['Numpad8', NUM], ['Numpad9', NUM], NUM + 0.5, ['Escape', 1.5], ['Tab', 1.5]]),
        ...row(1, 3 * NUM, [['NumpadAdd', NUM]], 2),
        ...row(2, 0, [
          ['Numpad4', NUM],
          ['Numpad5', NUM],
          ['Numpad6', NUM],
          NUM + 0.5,
          ['ShiftLeft', 1.5],
          ['ControlLeft', 1.5],
        ]),
        ...row(3, 0, [['Numpad1', NUM], ['Numpad2', NUM], ['Numpad3', NUM], NUM + 1.5, 'ArrowUp']),
        ...row(3, 3 * NUM, [['NumpadEnter', NUM]], 2),
        ...row(4, 0, [['Numpad0', 2 * NUM], ['NumpadDecimal', NUM], NUM + 0.5, 'ArrowLeft', 'ArrowDown', 'ArrowRight']),
      ],
    },
  ];
}
/** The US layout's pages. */
export const PAGES: Page[] = pages();

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
export const MODIFIERS = new Set([
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
]);

/** The keypad's and Space's characters (the same on every layout but the keypad's decimal key, the keymap's). */
const FIXED: Record<string, string> = {
  ...Object.fromEntries('0123456789'.split('').map((d) => [`Numpad${d}`, d])),
  NumpadDivide: '/',
  NumpadMultiply: '*',
  NumpadSubtract: '-',
  NumpadAdd: '+',
  NumpadDecimal: '.',
  Space: ' ',
};

/** A letter key's: unshifted, a lowercase letter whose capital is the shifted one (shown alone, as a keyboard does). */
const isLetter = (l: string[]) => l[0] !== l[1] && l[0]?.toUpperCase() === l[1];

/**
 * A key's legends on keymap `map`: its character, or a shifted one over the unshifted (`top`), and the AltGr one
 * (`alt`); undefined for a named key (the catalog's words).
 */
export function legends(code: string, map: Keymap = US): { top?: string; main: string; alt?: string } | undefined {
  if (code === 'Space') return { main: '' };
  if (/^F\d+$/.test(code)) return { main: code };
  const l = map[code];
  if (code.startsWith('Numpad')) return FIXED[code] === undefined ? undefined : { main: l?.[0] ?? FIXED[code] };
  if (!l) return undefined;
  const alt = l[2] && l[2] !== l[0] && l[2] !== l[1] ? l[2] : undefined;
  if (isLetter(l) || !l[1] || l[1] === l[0]) return { main: isLetter(l) ? l[1] : l[0], ...(alt ? { alt } : {}) };
  return { top: l[1], main: l[0], ...(alt ? { alt } : {}) };
}

/**
 * What a terminal makes of a key (web/input.ts `terminalBytes`): its `KeyboardEvent.key` on keymap `map` with Shift down
 * or not, and AltGr (`third`: the third level, or the fourth with Shift).
 */
export function keyOf(code: string, shift: boolean, map: Keymap = US, third = false): string {
  const l = map[code];
  if (code.startsWith('Numpad') || code === 'Space')
    return code === 'NumpadEnter' ? 'Enter' : (l?.[0] ?? FIXED[code] ?? code);
  if (l) {
    if (third && l[2]) return (shift && l[3]) || l[2];
    return (shift && l[1]) || l[0];
  }
  return code;
}

/** The modifiers down with a key: `alt` the left Alt, `altGr` the right one (Alt on a layout without a third level). */
export type Mods = { shift: boolean; ctrl: boolean; alt: boolean; meta: boolean; altGr: boolean };

/** Key `code` with modifiers `m` as a key event says it, on keymap `map`: the right Alt is AltGr where the key has a third level. */
export function eventOf(
  code: string,
  m: Mods,
  map: Keymap = US,
): { key: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean } {
  const third = m.altGr && !!map[code]?.[2];
  return {
    key: keyOf(code, m.shift, map, third),
    ctrlKey: m.ctrl,
    altKey: m.alt || (m.altGr && !third),
    metaKey: m.meta,
  };
}

/** How a tapped modifier is let go: after the next key (`next`), or when it's tapped again (`toggle`). */
export type ModifierMode = 'next' | 'toggle';

/** A modifier held this long alone (ms) is a hold, not a tap: released when let go, not latched. */
export const HOLD_MS = 500;

/** A key held this long (ms) repeats, every `REPEAT_MS` after (a PC's typematic defaults: 500 ms, ~30 a second). */
export const REPEAT_DELAY_MS = 500,
  REPEAT_MS = 33;

/** Timers (`setTimeout`'s; a test's clock). */
export type Timers = { set(f: () => void, ms: number): unknown; clear(id: unknown): void };
const TIMERS: Timers = {
  set: (f, ms) => setTimeout(f, ms),
  clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

/**
 * Pointers on the keys to the keys' downs and ups (`send`). A key goes down when the first pointer presses it and up
 * when the last lets it go. A modifier let go is released if it was held with another key, or held alone for
 * `HOLD_MS`; tapped alone, it's latched: down until the next key's release (`next`) or its own next tap (`toggle`).
 * A latched modifier tapped again is released at once. A modifier pressed while another key is held is held with it.
 * The last key pressed, but a modifier, repeats while held (`send`'s `repeat`: after `REPEAT_DELAY_MS`, every
 * `REPEAT_MS`), as a keyboard's typematic repeat does; the guest's keyboard drops them (its kernel repeats), the serial
 * console types them (web/input.ts).
 */
export class OskKeys {
  mode: ModifierMode;
  private readonly send: (code: string, down: boolean, repeat?: boolean) => void;
  private readonly now: () => number;
  private readonly timers: Timers;
  /** The key repeating, and its timer. */
  private repeating?: { code: string; timer: unknown };
  /** The pointers on keys: the key, when it was pressed, whether another key was pressed meanwhile; `undo` for a tap that released a latch. */
  private readonly pointers = new Map<number, { code: string; at: number; chorded: boolean; undo?: boolean }>();
  /** The keys down by pointers, with how many hold each. */
  private readonly held = new Map<string, number>();
  /** The modifiers latched down. */
  private readonly latched = new Set<string>();
  /** Called after any change (to redraw). */
  onChange: () => void = () => {};

  constructor(
    send: (code: string, down: boolean, repeat?: boolean) => void,
    mode: ModifierMode = 'next',
    now: () => number = () => performance.now(),
    timers: Timers = TIMERS,
  ) {
    this.send = send;
    this.mode = mode;
    this.now = now;
    this.timers = timers;
  }

  /** Key `code` repeats while held: its first repeat after `REPEAT_DELAY_MS`. */
  private repeat(code: string) {
    this.stopRepeat();
    const tick = (ms: number) =>
      this.timers.set(() => {
        if (this.repeating?.code !== code || !this.held.has(code)) return;
        this.send(code, true, true);
        this.repeating.timer = tick(REPEAT_MS);
      }, ms);
    this.repeating = { code, timer: undefined };
    this.repeating.timer = tick(REPEAT_DELAY_MS);
  }
  private stopRepeat(code?: string) {
    if (!this.repeating || (code !== undefined && this.repeating.code !== code)) return;
    this.timers.clear(this.repeating.timer);
    this.repeating = undefined;
  }

  /** Whether key `code` is down: `held` by a pointer, `latched`, or not. */
  state(code: string): 'held' | 'latched' | undefined {
    return this.held.has(code) ? 'held' : this.latched.has(code) ? 'latched' : undefined;
  }

  /** The modifiers down, held or latched (for a terminal's characters). */
  mods(): Mods {
    const on = (side: string) => !!(this.state(`${side}Left`) || this.state(`${side}Right`));
    return {
      shift: on('Shift'),
      ctrl: on('Control'),
      alt: !!this.state('AltLeft'),
      meta: on('Meta'),
      altGr: !!this.state('AltRight'),
    };
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
    if (n === 0) {
      this.send(code, true);
      if (!MODIFIERS.has(code)) this.repeat(code);
    }
    this.onChange();
  }

  /** Pointer `id` lets its key go (lifted, or cancelled by the browser). */
  release(id: number) {
    const p = this.pointers.get(id);
    if (!p) return;
    this.pointers.delete(id);
    if (p.undo) return;
    const n = (this.held.get(p.code) ?? 1) - 1;
    if (n > 0) {
      this.held.set(p.code, n);
      return;
    }
    this.held.delete(p.code);
    this.stopRepeat(p.code);
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
    this.stopRepeat();
    for (const c of [...this.held.keys()].reverse()) this.send(c, false);
    this.held.clear();
    this.pointers.clear();
    this.unlatch();
    this.onChange();
  }

  /** Forgets everything without sending (the guest's keys were released elsewhere: a blur). */
  forget() {
    this.stopRepeat();
    this.held.clear();
    this.pointers.clear();
    this.latched.clear();
    this.onChange();
  }
}
