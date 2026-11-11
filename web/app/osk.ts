// The on-screen keyboard's keys and what pressing them does (docs/frontend.md "The on-screen keyboard"; Osk.svelte draws
// it; its layouts are web/app/osk-layout.ts's): the legends and characters of the machine's layout (web/app/keymaps.ts),
// and `OskKeys`, which turns pointers on the keys into the keys' downs and ups as a real keyboard's: each pointer (a
// finger, the mouse, a pen) holds its key until it lifts, so several fingers chord; a modifier tapped alone stays down
// (latched) for the keys that follow.

import { Changes } from './changes.ts';
import type { Keymap } from './keymaps.ts';
import { US } from './osk-layout.ts';

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
const FIXED: Partial<Record<string, string>> = {
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
  return l && characterLegends(l);
}

/** A character key's legends: its character, or a shifted one over the unshifted, and the AltGr one where it differs. */
function characterLegends(l: string[]): { top?: string; main: string; alt?: string } {
  const alt = l[2] && l[2] !== l[0] && l[2] !== l[1] ? { alt: l[2] } : {};
  if (isLetter(l)) return { main: l[1], ...alt };
  if (!l[1] || l[1] === l[0]) return { main: l[0], ...alt };
  return { top: l[1], main: l[0], ...alt };
}

/**
 * What a terminal makes of a key (web/input.ts `terminalBytes`): its `KeyboardEvent.key` on keymap `map` with Shift down
 * or not, and AltGr (`third`: the third level, or the fourth with Shift).
 */
export function keyOf(code: string, shift: boolean, map: Keymap = US, third = false): string {
  const l = map[code];
  if (code.startsWith('Numpad') || code === 'Space') return fixedKey(code, l);
  if (!l) return code;
  if (third && l[2]) return (shift && l[3]) || l[2];
  return (shift && l[1]) || l[0];
}

/** The keypad's and Space's key: the keymap's character, else the fixed one (the keypad's Enter is Enter). */
const fixedKey = (code: string, l: string[] | undefined) =>
  code === 'NumpadEnter' ? 'Enter' : (l?.[0] ?? FIXED[code] ?? code);

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
  /** The keys' states changed (web/app/changes.ts): `state` tracks it, so the keyboard redraws. */
  readonly #changes = new Changes();

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
    this.#changes.track();
    return this.held.has(code) ? 'held' : this.latched.has(code) ? 'latched' : undefined;
  }

  /** The modifiers down, held or latched (for a terminal's characters). */
  mods(): Mods {
    const on = (side: string) => !!(this.state(`${side}Left`) ?? this.state(`${side}Right`));
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
      return this.#changes.notify();
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
    this.#changes.notify();
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
    this.#changes.notify();
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
    this.#changes.notify();
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
    this.#changes.notify();
  }

  /** Forgets everything without sending (the guest's keys were released elsewhere: a blur). */
  forget() {
    this.stopRepeat();
    this.held.clear();
    this.pointers.clear();
    this.latched.clear();
    this.#changes.notify();
  }
}
