// Settings remembered per browser (the view, whether saved disks are compressed, the sound's volume, a transient
// machine's size and the connection its network adapter has, the mouse lock, the Preferences). Storage can be off or throw: then nothing is remembered.
import type { NetworkSettings } from './network.ts';
import type { View } from './ui.svelte.ts';
import type { LockMode } from '../input.ts';

/**
 * `net`: the network before connections (docs/network-adapters.md §2.2), read once by the migration, which drops it;
 * `transientNet`: the connection attached to a transient machine's adapter (a stored machine's is in its record).
 */
export type Settings = { ncpus?: number; ramMiB?: number; view?: View; net?: NetworkSettings; transientNet?: string; compress?: boolean; screen?: string; hidpi?: boolean; gpu?: '3d' | '2d'; muted?: boolean; volume?: number; mic?: boolean; micRaw?: boolean; jitMiB?: number; mouseLock?: boolean; mouseLockMode?: LockMode; leaveWarning?: boolean };
/** Preferences: ask before the page is left while a machine runs (on unless turned off). */
export const leaveWarning = () => settings().leaveWarning !== false;
const SETTINGS = 'webpc.settings';
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
  } catch { /* not remembered */ }
};
