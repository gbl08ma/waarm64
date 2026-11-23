// The machine's power state as the page shows it (docs/frontend.md "The page's code"): the state and its words, and
// whether a stop, start or snapshot runs (the actions that would overlap it wait). The run writes it (web/app/run/messages.ts).
import type { PowerState } from '../protocol.ts';
import { t } from '../../i18n.ts';

/** The machine's power state, plus the page's own `idle`: no machine yet (waiting for a disk, or for "Start anyway"). */
export type PageState = PowerState | 'idle';

/** The machine runs (or boots): what a stop would cut. */
export const isLive = (s: PageState) => s === 'running' || s === 'booting';
/** Stopped with no start to follow (or none yet): nothing runs, whether the page or the guest stopped it. */
export const isStopped = (s: PageState) =>
  s === 'off' || s === 'suspended' || s === 'crashed' || s === 'failed' || s === 'idle';

/**
 * How the screen and the serial terminal show a machine that doesn't run (web/app/StateVeil.svelte): held still for a
 * snapshot (`paused`), or stopped in one of `isStopped`'s states.
 */
export type Veil = 'paused' | 'suspended' | 'off' | 'crashed' | 'failed' | 'idle';
const STOPPED_VEIL: Partial<Record<PageState, Veil>> = {
  suspended: 'suspended',
  off: 'off',
  crashed: 'crashed',
  failed: 'failed',
  idle: 'idle',
};

class Power {
  state = $state<PageState>('loading');
  /** The state's words (a phase or a progress while loading or saving). */
  stateText = $state(t('statusbar:power.loading'));
  /** A stop and start in progress (web/app/run/power-actions.ts `exclusively`). */
  switching = $state(false);
  /** A snapshot being written. */
  saving = $state(false);
  /** The guest is held still for a save (its input held, then its cores paused), until it runs again or has stopped. */
  paused = $state(false);
  /** The veil over the screen and the terminal: none while the machine loads, boots or runs unheld. */
  readonly veil = $derived(this.paused && isLive(this.state) ? 'paused' : STOPPED_VEIL[this.state]);
  /** One of them runs: the actions that would overlap it wait. */
  readonly busy = $derived(this.switching || this.saving);
  /** The page can't run here (no cross-origin isolation): no Start. */
  cantRun = $state(false);
  /** The run's agent powers the guest off or reboots it when asked (web/app/run/soft-power.ts): the toolbar says so. */
  canSoft = $state(false);
  /** A power-off or reboot asked of the guest, pending (the run's end clears it): the toolbar's sign. */
  soft = $state<'off' | 'reboot' | undefined>();
}
export const power = new Power();
