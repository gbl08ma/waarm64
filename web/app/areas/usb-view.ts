// The page's machine's USB as its area shows it (web/app/areas/usb.svelte.ts; docs/usb.md "The page"): what is on
// the running machine's connectors, the host's game pads and the remembered devices' states, read again whenever one
// of them changes (a port's change, a plug, a grant, an edit), and the game pads' feed.
import { listPads, PadFeed } from '../gamepads.ts';
import { entryStates, type UsbLocks } from '../usb-live.ts';
import { problemText } from '../usb-problems.ts';
import { USB_CONNECTORS, type UsbEntry } from '../shape.ts';
import type { UsbIdentity, UsbVirtual } from '../../usb-device.ts';
import type { PageMachine } from '../run/page-machine.svelte.ts';
import { usb } from './usb.svelte.ts';

type Device = { device: UsbIdentity | UsbVirtual };
/** The host pad (`Gamepad.index`) the game pad of ours on a connector is fed by, if it is one. */
export const padOf = (c?: Device | null) =>
  c?.device.api === 'virtual' && c.device.kind === 'gamepad' ? c.device.index : undefined;
/** The built-in keyboard (docs/usb.md "The keyboard"). */
export const isKeyboard = (c?: Device | null) => c?.device.api === 'virtual' && c.device.kind === 'keyboard';

export class UsbView {
  readonly #machine: PageMachine;
  readonly #locks: () => UsbLocks;
  readonly #entries: () => UsbEntry[];
  /** The game pad of ours (docs/usb.md "The game pad"): the feed sends the attached ones' state to the device worker. */
  readonly pads: PadFeed;
  #reading: Promise<void> | undefined;
  #again = false;

  /** `entries`: the page's machine's remembered devices. */
  constructor(machine: PageMachine, locks: () => UsbLocks, entries: () => UsbEntry[]) {
    this.#machine = machine;
    this.#locks = locks;
    this.#entries = entries;
    this.pads = new PadFeed((connector, pad) => machine.run?.usb?.pad(connector, pad));
  }

  /** Reads the connectors, the pads and (once the read before is done) the entries' states again. */
  refresh() {
    const ports = this.#machine.run?.usb;
    usb.connectors = Array.from({ length: USB_CONNECTORS }, (_, i) => {
      const c = ports?.connectors[i];
      if (!c) return null;
      const d = c.device;
      const problems = c.problems?.length && d.api !== 'virtual' ? c.problems.map((p) => problemText(p, d)) : undefined;
      const virtual = d.api === 'virtual';
      return { name: c.name, state: c.state, entry: c.entry, virtual, builtin: isKeyboard(c), pad: padOf(c), problems };
    });
    usb.pads = listPads();
    const fed = (ports?.connectors ?? []).flatMap((c, i) => {
      const pad = padOf(c);
      return c?.state === 'attached' && pad !== undefined ? [[i, pad] as const] : [];
    });
    this.pads.set(new Map(fed));
    this.#readEntries();
  }

  #readEntries() {
    if (this.#reading) {
      this.#again = true;
      return;
    }
    const attached = this.#machine.run?.usb?.attachedEntries() ?? new Set<string>();
    this.#reading = entryStates(this.#entries(), attached, this.#locks())
      .then((e) => {
        usb.entries = e;
      })
      .finally(() => {
        this.#reading = undefined;
        if (this.#again) {
          this.#again = false;
          this.refresh();
        }
      });
  }
}
