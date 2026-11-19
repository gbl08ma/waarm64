// Settings remembered per browser (the view, the sound's volume, a transient
// machine's size and the connection its network adapter has, the mouse lock, the Preferences: the status bar's elements and Vulkan's shader store's budget among them). Storage can be off or throw: then nothing is remembered.
import type { NetworkSettings } from './network.ts';
import type { Split, View } from './areas/screen.svelte.ts';
import type { LockMode } from '../input.ts';
import type { Item } from './statusbar.ts';
import type { ModifierMode } from './osk.ts';
import type { Layout } from './osk-layout.ts';

/**
 * `net`: the network before connections (docs/networking/adapters.md §2.2), read once by the migration, which drops it;
 * `transientNet`: the connection attached to a transient machine's adapter (a stored machine's is in its record).
 */
export type Settings = {
  ncpus?: number;
  ramMiB?: number;
  view?: View;
  /** Both's divider, where the user last put it (web/app/areas/screen.svelte.ts `Split`). */
  split?: Split;
  net?: NetworkSettings;
  transientNet?: string;
  screen?: string;
  hidpi?: boolean;
  gpu?: '3d' | '2d';
  muted?: boolean;
  volume?: number;
  mic?: boolean;
  micRaw?: boolean;
  jitMiB?: number;
  mouseLock?: boolean;
  mouseLockMode?: LockMode;
  leaveWarning?: boolean;
  clockSync?: boolean;
  dropCaches?: boolean;
  statusBar?: Item[];
  statusFullscreen?: boolean;
  /** The on-screen keyboard's place before it was a floating window's (`windows.osk`): read once, moved, dropped. */
  osk?: { x: number; y: number; w: number; wc?: number; layout?: Layout };
  /** The on-screen keyboard's layout, when its bar's button forced one (web/app/osk-shape.svelte.ts). */
  oskLayout?: Layout;
  oskModifiers?: ModifierMode;
  /** Floating windows' places and sizes (web/app/ui/floating-frame.svelte.ts), CSS pixels, by the key each is given. */
  windows?: Record<string, Place>;
  /** Preferences: the budget of Vulkan's shader store (web/venus-cache.ts; MiB, its default `CACHE_BUDGET` when unset). */ shaderMiB?: number;
};
/**
 * Where a floating window is and how big, CSS pixels; a window of several shapes (the on-screen keyboard's layouts)
 * keeps each one's size in `sizes`, by shape, and `w`, `h` are the one it had last.
 */
export type Place = { x: number; y: number; w: number; h: number; sizes?: Record<string, { w: number; h: number }> };
/** Preferences: ask before the page is left while a machine runs (on unless turned off). */
export const leaveWarning = () => settings().leaveWarning !== false;
/**
 * Preferences: the guest agent sets the guest's clock to the browser's (on unless turned off; `?clocksync=1` or `0`
 * decides for the page, the last one if there are several) whenever it may have fallen behind: a restore, a save's
 * pause, the host's own sleep (docs/frontend.md "The guest's clock"). Off, a snapshot is a pause the guest can hardly
 * tell.
 */
export const clockSync = () => {
  const q = new URLSearchParams(location.search).getAll('clocksync').at(-1);
  return q !== undefined ? q !== '0' : settings().clockSync !== false;
};
/**
 * Preferences: the guest agent has the guest drop its clean caches right before a snapshot or Suspend (on unless turned
 * off; `?dropcaches=1` or `0` decides for the page, the last one if there are several), so the memory they held is free
 * and the snapshot leaves it out (docs/frontend.md "Snapshots"). The guest reads its files from its disk again after.
 */
export const dropCaches = () => {
  const q = new URLSearchParams(location.search).getAll('dropcaches').at(-1);
  return q !== undefined ? q !== '0' : settings().dropCaches !== false;
};
const SETTINGS = 'waarm64.settings';
export const settings = (): Settings => {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS) ?? '{}') as Settings;
  } catch {
    return {};
  }
};
export const remember = (s: Settings) => {
  try {
    localStorage.setItem(SETTINGS, JSON.stringify({ ...settings(), ...s }));
  } catch {
    /* not remembered */
  }
};
