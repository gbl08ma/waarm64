// The page's machine's USB as the toolbar's USB menu (web/app/UsbMenu.svelte) and the Machines page's USB tab show it
// (docs/usb.md "The page"): web/app/main.ts reads it again from the running machine's ports (web/app/usb-live.ts),
// the host's devices and pads whenever any of them changes. The menu opens itself when called (an offer to answer).
import { Command } from '../command.ts';
import type { EntryView } from '../usb-live.ts';
import type { ProblemWords } from '../usb-ports.ts';

/** What is on a connector while the machine runs (`problems`: what of an attached device the guest doesn't get, in words: web/app/usb-ports.ts `problemText`). */
export type ConnectorView = {
  name: string;
  state: string;
  entry?: string;
  virtual?: boolean;
  builtin?: boolean;
  pad?: number;
  problems?: ProblemWords[];
};

class Usb {
  /** The machine has a controller (the toolbar's USB menu). */
  on = $state(false);
  /** It runs here with its controller: devices attach now. */
  running = $state(false);
  /** Its remembered devices and their states, as last read (read again at every plug, attach and grant). */
  entries = $state<EntryView[]>([]);
  /** What is on each connector while it runs. */
  connectors = $state<(ConnectorView | null)[]>([]);
  /** The host's game pads the Gamepad API lists (`index`: `Gamepad.index`), for the game pad of ours (docs/usb.md "The game pad"). */
  pads = $state<{ index: number; name: string }[]>([]);
  /** The page has the Gamepad API. */
  hasPads = $state(false);
  /** The offers the menu makes: a device that just appeared, one that left, a grant to give. */
  offers = $state<{ id: string; text: string; label: string }[]>([]);
  /** `?usbzero=1`: Gadget Zero in the menu, for tests. */
  zero = $state(false);
  /** Answered by the USB menu. */
  readonly menu = new Command();
  /** Opens the USB menu (an offer was just made). */
  openMenu() {
    this.menu.call();
  }
}
export const usb = new Usb();
