// The status bar (web/app/StatusBar.svelte; docs/frontend.md "The status bar"): its elements (Preferences, remembered
// as the settings' `statusBar`), and the running machine's last status, as web/app/main.ts gets it.
import { normalize, type Graphics, type Metrics } from '../statusbar.ts';
import { settings } from '../settings.ts';

export const status = $state({
  /** The last status as JSON, for tools (`data-status`). */
  data: '',
  /** The last second's numbers. */
  metrics: undefined as Metrics | undefined,
  /** The names of the running machine's disks, in its order. */
  disks: [] as string[],
  /** The screen's last second, and when it came (ms). */
  gpu: undefined as { g: Graphics; at: number } | undefined,
  /** The elements shown, in order. */
  items: normalize(settings().statusBar),
  /** Full screen takes the status bar along (off: the machine alone, edge to edge). */
  fullscreen: settings().statusFullscreen === true,
});
