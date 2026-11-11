// The on-screen keyboard's layouts (docs/frontend.md "The on-screen keyboard"; web/app/osk.ts has what its keys do): a
// PC keyboard by `KeyboardEvent.code` (US ANSI's 104 keys, and ISO's, ABNT2's or JIS's extra keys when the machine's
// layout has them, JIS's input-method keys), and the compact layout's pages of the same keys for a phone's width (the
// layout's letters beside US's); which of the two a window gets.
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
// eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- no layout ('') is US
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
// eslint-disable-next-line max-lines-per-function -- a layout table: the keys row by row, each layout's extra keys in place
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
// eslint-disable-next-line max-lines-per-function -- a layout table: each page's keys row by row
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
