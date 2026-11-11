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

class Power {
  state = $state<PageState>('loading');
  /** The state's words (a phase or a progress while loading or saving). */
  stateText = $state(t('statusbar:power.loading'));
  /** A stop and start in progress (web/app/run/power-actions.ts `exclusively`). */
  switching = $state(false);
  /** A snapshot being written. */
  saving = $state(false);
  /** One of them runs: the actions that would overlap it wait. */
  readonly busy = $derived(this.switching || this.saving);
  /** The page can't run here (no cross-origin isolation): no Start. */
  cantRun = $state(false);
}
export const power = new Power();
