// The mouse lock (docs/frontend.md "Mouse lock"): the toolbar's setting and its mode (remembered), and whether the
// screen holds the mouse now. web/app/main.ts writes it.
import type { LockMode } from '../../input.ts';
import { settings } from '../settings.ts';

export const mouse = $state<{ lock: boolean; mode: LockMode; locked: boolean }>({
  /** A click on the screen takes the mouse. */
  lock: settings().mouseLock ?? false,
  /** How the locked mouse moves the guest (web/input.ts `LockMode`): `pointer` by default. */
  mode: settings().mouseLockMode === 'raw' ? 'raw' : 'pointer',
  /** The screen holds the mouse now. */
  locked: false,
});
