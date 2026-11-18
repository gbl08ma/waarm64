// The page's machine's USB as the toolbar's USB menu (web/app/UsbMenu.svelte) and the Home page's USB tab show it
// (docs/usb.md "The page"): web/app/areas/usb-view.ts reads it again from the running machine's ports
// (web/app/usb-live.ts), the host's devices and pads whenever any of them changes. The menu opens itself when called (an offer to answer).
import { Command } from '../command.ts';
import type { EntryView } from '../usb-live.ts';
import type { ProblemWords } from '../usb-problems.ts';

/** What is on a connector while the machine runs (`problems`: what of an attached device the guest doesn't get, in words: web/app/usb-problems.ts `problemText`). */
export type ConnectorView = {
  name: string;
  state: string;
  entry?: string;
  virtual?: boolean;
  builtin?: boolean;
  pad?: number;
  problems?: ProblemWords[];
};

/** An offer the menu makes: a device that just appeared, one that left, a grant to give; `run` takes it. */
export type Offer = { id: string; text: string; label: string; run: () => Promise<void> };

class Usb {
  #source = $state.raw<{ on(): boolean; running(): boolean }>();
  /** The machine has a controller (the toolbar's USB menu). Written only by tools/screens.ts, which fakes it. */
  on = $derived(this.#source?.on() ?? false);
  /** It runs here with its controller: devices attach now. */
  running = $derived(this.#source?.running() ?? false);
  /** Its remembered devices and their states, as last read (read again at every plug, attach and grant). */
  entries = $state<EntryView[]>([]);
  /** What is on each connector while it runs. */
  connectors = $state<(ConnectorView | null)[]>([]);
  /** The host's game pads the Gamepad API lists (`index`: `Gamepad.index`), for the game pad of ours (docs/usb.md "The game pad"). */
  pads = $state<{ index: number; name: string }[]>([]);
  /** The page has the Gamepad API. */
  readonly hasPads = typeof navigator.getGamepads === 'function';
  /** The offers the menu makes, by id (a new one with an id replaces the old). */
  offers = $state.raw<Offer[]>([]);
  /** `?usbzero=1`: Gadget Zero in the menu, for tests. */
  readonly zero = new URLSearchParams(location.search).get('usbzero') === '1';
  /** Answered by the USB menu. */
  readonly menu = new Command();

  /** Follows the page's machine: whether it has a controller, and runs. */
  follow(source: { on(): boolean; running(): boolean }) {
    this.#source = source;
  }
  /** Makes an offer and opens the menu on it. */
  offer(o: Offer) {
    this.offers = [...this.offers.filter((x) => x.id !== o.id), o];
    this.menu.call();
  }
  /** Takes offer `id` back, and returns it. */
  takeOffer(id: string) {
    const o = this.offers.find((x) => x.id === id);
    this.offers = this.offers.filter((x) => x.id !== id);
    return o;
  }
}
export const usb = new Usb();
