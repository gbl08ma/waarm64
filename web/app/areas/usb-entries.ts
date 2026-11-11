// The machines' remembered USB devices (docs/usb.md "The page"): a stored machine's in its record, a transient one's
// this page's only, for its session; edited one at a time (each reads the record the one before wrote). And the
// devices' Web Locks (web/app/usb-live.ts `UsbLocks`).
import { MsgError } from '../../i18n.ts';
import type { UsbEntry } from '../shape.ts';
import { UsbLocks } from '../usb-live.ts';
import { machineTitle } from '../run/page-disks.ts';
import type { PageMachine } from '../run/page-machine.svelte.ts';

export class UsbEntries {
  readonly #m: PageMachine;
  /** A transient machine's remembered devices. */
  transient: UsbEntry[] = [];
  #edits: Promise<unknown> = Promise.resolve();
  readonly locks: UsbLocks;
  /** After each edit: the area reads its entries again. */
  readonly #changed: () => void;

  /** `letGo`: another tab wants the device of a lock this page holds. */
  constructor(m: PageMachine, changed: () => void, letGo: (lock: string) => void) {
    this.#m = m;
    this.#changed = changed;
    this.locks = new UsbLocks(m.store, () => machineTitle(m), letGo);
  }

  /** The page's machine's. */
  list(): UsbEntry[] {
    const s = this.#m.stored;
    return s ? (s.record.usbDevices ?? []) : this.transient;
  }
  /** Machine `machine`'s (undefined: the page's transient one). */
  async of(machine: string | undefined) {
    return machine ? ((await this.#m.store.get('machines', machine))?.usbDevices ?? []) : this.transient;
  }

  /** Changes machine `id`'s remembered devices (undefined: the page's transient machine's), in the store and here. */
  edit(id: string | undefined, f: (e: UsbEntry[]) => UsbEntry[]): Promise<void> {
    const next = this.#edits.then(() => this.#editNow(id, f));
    this.#edits = next.catch(() => undefined); // the next edit goes on: this one's caller has its error
    return next;
  }
  async #editNow(id: string | undefined, f: (e: UsbEntry[]) => UsbEntry[]) {
    if (!id) this.transient = f(this.transient);
    else {
      const m = await this.#m.store.get('machines', id);
      if (!m) throw new MsgError('usb:usb-entries.machineGone');
      m.usbDevices = f(m.usbDevices ?? []);
      if (!m.usbDevices.length) delete m.usbDevices;
      await this.#m.store.put('machines', m);
      const s = this.#m.stored;
      if (s?.record.id === id) s.record = { ...s.record, usbDevices: m.usbDevices };
    }
    this.#changed();
  }
}
