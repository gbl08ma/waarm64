// The RAM map's window (docs/frontend.md "RAM's map"): whether it's open; App.svelte mounts web/app/RamWindow.svelte
// while it is, so it stays as the user goes between the machine and the Machines page. `ramHost` is the machine that
// runs on this page, to ask about its RAM (its run says how to reach it: web/app/run/runner.ts writes
// `current.inspect`), from its boot to its stop.
import { current } from './current.svelte.ts';
import { power } from './power.svelte.ts';
import type { LiveHost } from '../surface-source.ts';

/** The machine on this page while it has RAM (booting, running, rebooting), and how to ask it. */
export const ramHost = (): LiveHost | undefined => {
  const r = current.inspect;
  const s = power.state;
  return r && (s === 'booting' || s === 'running' || s === 'rebooting') ? r : undefined;
};

class RamWindowArea {
  open = $state(false);
  show() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
}
export const ramWindow = new RamWindowArea();
