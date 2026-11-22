// The status bar (web/app/StatusBar.svelte; docs/frontend.md "The status bar"): its elements (Preferences, remembered
// as the settings' `statusBar`), and the running machine's last status, as the run gets it (web/app/run/worker-messages.ts).
import { counts, normalize, type Item } from '../statusbar.ts';
import type { Graphics } from '../statusbar-graphics.ts';
import type { Metrics } from '../statusbar-metrics.ts';
import { settings } from '../settings.ts';
import type { GuestOs } from '../../agent-frame.ts';

export const status = $state({
  /** The last status as JSON, for tools (`data-status`). */
  data: '',
  /** The last second's numbers. */
  metrics: undefined as Metrics | undefined,
  /** The names of the running machine's disks, in its order. */
  disks: [] as string[],
  /** The screen's last second, and when it came (ms). */
  gpu: undefined as { g: Graphics; at: number } | undefined,
  /** The guest's OS as the run's agent names it (web/app/areas/agent-actions.ts). */
  os: undefined as GuestOs | undefined,
  /** The elements shown, in order. */
  items: normalize(settings().statusBar),
  /** Full screen takes the status bar along (off: the machine alone, edge to edge). */
  fullscreen: settings().statusFullscreen === true,
});

/** The running machine's ear for the bar's counting (web/app/run/runner.ts: its worker's `count` message). */
let follow: ((count: boolean) => void) | undefined;
/** Has `f` told whenever the bar's elements that count every instruction come or go (`counts`); one listener. */
export function followCounting(f: (count: boolean) => void) {
  follow = f;
}
/** The elements shown, changed (the Preferences' editor): the running machine counts every instruction while one needs it. */
export function setItems(next: Item[]) {
  const was = counts(status.items);
  status.items = next;
  if (counts(next) !== was) follow?.(!was);
}
