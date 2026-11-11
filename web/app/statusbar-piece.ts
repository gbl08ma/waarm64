// What a status bar element draws (docs/frontend.md "The status bar"): the page's facts beside the statuses, the
// pieces, and the helpers the renderers share (web/app/statusbar-render.ts, statusbar-graphics.ts, statusbar-traffic.ts).
// DOM-free, for tests/statusbar.test.ts.
import { t } from '../i18n.ts';
import { bytesText } from './bytes.ts';
import type { IconName } from './icons.ts';
import { firstIndex, deviceOf, type Item } from './statusbar.ts';
import type { Graphics } from './statusbar-graphics.ts';
import type { PageState } from './areas/power.svelte.ts';

/** What the page knows besides the statuses. */
export type Live = {
  state: PageState;
  stateText: string;
  /** This computer's time, ms since the epoch. */
  now: number;
  mouseLock: boolean;
  mouseLocked: boolean;
  keyboardLocked: boolean;
  /** The screen or the terminal has the focus, in a focused window: keys go to the machine (no "Click to type"). */
  keysFocused: boolean;
  /** The microphone (web/audio.ts `micState`). */
  mic: string;
  /** The machine's disks' and adapters' names, in its order; an adapter's connection phase (web/app/network.ts) and words. */
  disks: string[];
  /** `details`: lines under its words in the tooltip (why a connection failed; a room's active connections). */
  nets: { name: string; phase: string; text: string; details?: string[] }[];
  /** The screen's last second (none yet, or no screen). */
  gpu?: Graphics;
};

/** A colour the bar has words for. */
export type Tone = 'ok' | 'busy' | 'off' | 'bad' | 'dim';
/**
 * What an element draws: its words (`text`), or with an icon its short value (`short`, the words in `title`), a dot
 * before them (the power state), a tone, bars (each from 0 to 1, per vCPU), or parts with icons of their own.
 */
export type Piece = {
  text: string;
  short?: string;
  icon?: IconName;
  tone?: Tone;
  dot?: boolean;
  bars?: number[];
  title: string;
  label?: string;
  parts?: Part[];
};
/** A value drawn with an icon of its own (received, sent): `label` (words only) and `parts` stand for `text` and `short` then. */
export type Part = { icon: IconName; text: string };

/** An element's one piece, with the kind's icon. */
export const piece = (
  icon: IconName | undefined,
  text: string,
  short: string,
  title: string,
  extra: Partial<Piece> = {},
): Piece[] => [{ text, short, icon, title, ...extra }];

export const count = (n: number) => Math.round(n).toLocaleString('en');
export const size = (n: number) => (n < 1024 ? `${Math.round(n)} B` : bytesText(n)); // i18n-ignore: a size and its unit
export const perSec = (n: number | undefined) => (n === undefined ? '…' : `${size(n)}/s`); // i18n-ignore: a rate's unit
/** A total's size; not known yet, an ellipsis. */
export const amount = (n: number | undefined) => (n === undefined ? '…' : size(n));
/** The sum of `f` over `list`, undefined if one of them is. */
export function sumOf<T>(list: T[], f: (x: T) => number | undefined) {
  let sum = 0;
  for (const x of list) {
    const v = f(x);
    if (v === undefined) return undefined;
    sum += v;
  }
  return sum;
}
export const hms = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/** An adapter's name, by its number from 1 (as the machine's Network tab lists them). */
export const adapterName = (n: number) => t('statusbar:statusbar-piece.adapter', { number: n });

/**
 * The devices a per-device element shows: all (`undefined`: summed), each, or the one numbered `index`; none when the
 * machine hasn't it (the element disappears).
 */
export function devices<T>(i: Item, list: T[] | undefined): { at: number; v: T }[] | undefined {
  if (!list) return [];
  if (i.scope === 'all') return undefined;
  const all = list.map((v, at) => ({ at, v }));
  if (i.scope === 'each') return all;
  const first = firstIndex(deviceOf(i.kind));
  const at = (i.index ?? first) - first;
  return all.filter((d) => d.at === at);
}
