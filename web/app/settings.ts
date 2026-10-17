// Settings remembered per browser (the view, the network, whether saved disks are compressed, the sound's volume, a
// transient machine's size). Storage can be off or throw: then nothing is remembered.
import type { NetworkSettings } from './network.ts';
import type { View } from './ui.svelte.ts';

export type Settings = { ncpus?: number; ramMiB?: number; view?: View; net?: NetworkSettings; compress?: boolean; screen?: string; hidpi?: boolean; gpu?: '3d' | '2d'; muted?: boolean; volume?: number; mic?: boolean; micRaw?: boolean };
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
