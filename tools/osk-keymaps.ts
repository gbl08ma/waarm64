// Writes web/app/keymaps.ts: the characters each layout of the machines' keyboard setting (web/app/keyboard.ts) puts on
// the keys, for the on-screen keyboard's legends and what it types into the serial console (docs/frontend.md "The
// on-screen keyboard"). From xkeyboard-config (THIRD_PARTY.json): `xkbcomp` compiles `pc+<layout>(<variant>)` as the
// guest's XKB does, and X11's keysymdef.h names the characters. Needs xkbcomp, xkb-data's symbols and keysymdef.h
// (Ubuntu: x11-xkb-utils, xkb-data, x11proto-dev; openSUSE: xkbcomp, xkeyboard-config, xorgproto-devel).
//
//   node tools/osk-keymaps.ts [--xkb /usr/share/X11/xkb] [--keysyms /usr/include/X11/keysymdef.h]
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { codeOf } from '../web/input.ts';
import { KEYBOARD_LAYOUTS } from '../web/app/keyboard.ts';

const { values } = parseArgs({ options: { xkb: { type: 'string', default: '/usr/share/X11/xkb' }, keysyms: { type: 'string', default: '/usr/include/X11/keysymdef.h' } } });

// i18n-ignore-next: KeyboardEvent.code names
const CODES = ['Backquote', ...'1234567890'.split('').map((d) => `Digit${d}`), 'Minus', 'Equal', ...'QWERTYUIOPASDFGHJKLZXCVBNM'.split('').map((c) => `Key${c}`),
  'BracketLeft', 'BracketRight', 'Backslash', 'Semicolon', 'Quote', 'Comma', 'Period', 'Slash', 'IntlBackslash', 'IntlRo', 'IntlYen', 'NumpadDecimal'];
/** The keys past a US keyboard's, on the layouts whose keyboards have them: ISO's beside the left Shift, ABNT2's and JIS's. */
const ANSI = new Set(['us', 'us-intl', 'us-dvorak', 'us-colemak']);
const has = (id: string, code: string) =>
  code === 'IntlBackslash' ? !ANSI.has(id) && id !== 'jp' : code === 'IntlRo' ? id === 'br' || id === 'jp' : code === 'IntlYen' ? id === 'jp' : true;

/** A dead key's character: the spacing accent it types alone. */
const DEAD: Record<string, string> = {
  dead_grave: '`', dead_acute: '´', dead_circumflex: '^', dead_tilde: '~', dead_macron: '¯', dead_breve: '˘',
  dead_abovedot: '˙', dead_diaeresis: '¨', dead_abovering: '°', dead_doubleacute: '˝', dead_caron: 'ˇ', dead_cedilla: '¸',
  dead_ogonek: '˛', dead_iota: 'ͺ', dead_belowdot: '.', dead_hook: '̉', dead_horn: '̛', dead_stroke: '/', dead_greek: 'µ',
  dead_currency: '¤', dead_belowcomma: ',', dead_belowmacron: '_', dead_doublegrave: '̏', dead_invertedbreve: '̑',
};

// keysymdef.h: `#define XK_name 0xvalue  /* U+XXXX NAME */`; Latin-1's keysyms are their code points.
const SYMS = new Map<string, string>();
for (const line of readFileSync(values.keysyms!, 'utf8').split('\n')) {
  const m = /^#define XK_(\w+)\s+0x([0-9a-f]+)\s*(?:\/\*\s*U\+([0-9A-F]+))?/.exec(line);
  if (!m) continue;
  const v = parseInt(m[2], 16);
  const cp = m[3] ? parseInt(m[3], 16) : (v >= 0x20 && v <= 0x7e) || (v >= 0xa0 && v <= 0xff) ? v : v >= 0x1000000 ? v - 0x1000000 : undefined;
  if (cp !== undefined && !SYMS.has(m[1])) SYMS.set(m[1], String.fromCodePoint(cp));
}
/** A keysym's character, or '' for none (a function keysym, NoSymbol). */
function char(sym: string): string {
  if (DEAD[sym]) return DEAD[sym];
  if (sym === 'KP_Decimal') return '.';
  if (sym === 'KP_Separator') return ',';
  const u = /^U([0-9A-Fa-f]{4,6})$/.exec(sym);
  if (u) return String.fromCodePoint(parseInt(u[1], 16));
  if (/^0x1[0-9a-f]{6}$/.test(sym)) return String.fromCodePoint(parseInt(sym, 16) - 0x1000000);
  const c = SYMS.get(sym) ?? '';
  return /^[\p{L}\p{N}\p{P}\p{S}\p{Zs}\p{M}]$/u.test(c) ? c : '';
}

/** Layout `l`'s characters: code → its levels' characters (unshifted, shifted, AltGr, AltGr+Shift), trailing empties dropped. */
function keymap(layout: string, variant: string | undefined, dir: string): Record<string, string[]> {
  const src = join(dir, 'in.xkb'), out = join(dir, 'out.xkb');
  writeFileSync(src, `xkb_keymap {
  xkb_keycodes { include "evdev+aliases(qwerty)" };
  xkb_types { include "complete" };
  xkb_compat { include "complete" };
  xkb_symbols { include "pc+${layout}${variant ? `(${variant})` : ''}" };
};
`);
  execFileSync('xkbcomp', ['-w0', `-I${values.xkb}`, '-xkb', src, out]);
  const text = readFileSync(out, 'utf8');
  const number = new Map<string, number>();
  for (const m of text.matchAll(/^\s*<(\w+)>\s*=\s*(\d+);/gm)) number.set(m[1], Number(m[2]));
  for (const m of text.matchAll(/^\s*alias\s*<(\w+)>\s*=\s*<(\w+)>;/gm)) if (number.has(m[2])) number.set(m[1], number.get(m[2])!);
  const byLinux = new Map(CODES.map((c) => [codeOf(c)!, c]));
  const map: Record<string, string[]> = {};
  for (const m of text.matchAll(/key\s+<(\w+)>\s*\{([^}]*)\}/g)) {
    const code = byLinux.get((number.get(m[1]) ?? 0) - 8);
    if (!code) continue;
    const syms = /(?:symbols\[Group1\]\s*=\s*)?\[([^\]]*)\]/.exec(m[2]);
    if (!syms) continue;
    const levels = syms[1].split(',').map((s) => char(s.trim())).slice(0, 4);
    while (levels.length && !levels.at(-1)) levels.pop();
    // The keypad's: the character with Num Lock on (its first level is KP_Delete).
    if (code === 'NumpadDecimal') levels.splice(0, levels.length, ...levels.filter(Boolean).slice(0, 1));
    if (levels.length) map[code] = levels;
  }
  return map;
}

const dir = mkdtempSync(join(tmpdir(), 'osk-keymaps-'));
const maps: Record<string, Record<string, string[]>> = {};
try {
  for (const l of KEYBOARD_LAYOUTS) {
    const m = keymap(l.layout, l.variant, dir);
    maps[l.id] = Object.fromEntries(CODES.filter((c) => m[c] && has(l.id, c)).map((c) => [c, m[c]]));
    const missing = CODES.filter((c) => has(l.id, c) && !m[c]);
    if (missing.length) console.log(`${l.id}: no characters on ${missing.join(' ')}`); // JIS's Backquote is Hankaku/Zenkaku
  }
} finally {
  rmSync(dir, { recursive: true });
}
const q = (s: string) => JSON.stringify(s);
const body = Object.entries(maps).map(([id, m]) =>
  `  ${q(id)}: {\n${Object.entries(m).map(([c, lv]) => `    ${c}: [${lv.map(q).join(', ')}],`).join('\n')}\n  },`).join('\n');
writeFileSync(new URL('../web/app/keymaps.ts', import.meta.url), `// Generated by tools/osk-keymaps.ts from xkeyboard-config (THIRD_PARTY.json); don't edit. The characters each layout of
// the machines' keyboard setting (web/app/keyboard.ts) puts on the keys, by \`KeyboardEvent.code\`: unshifted, shifted,
// AltGr, AltGr with Shift (a dead key's is its spacing accent). Only the keys its keyboard has: ISO's IntlBackslash,
// ABNT2's IntlRo, JIS's IntlRo and IntlYen.
/* eslint-disable max-lines -- a generated table of data, not code to split */

/** A layout's characters: code → its levels'. */
export type Keymap = Partial<Record<string, string[]>>;

export const KEYMAPS: Record<string, Keymap> = {
${body}
};
`);
console.log(`web/app/keymaps.ts: ${Object.keys(maps).length} layouts`);
