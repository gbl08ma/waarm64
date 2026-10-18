// The live side of a machine's USB devices on the page (docs/plans/usb.md §4a, docs/usb.md "The page"): the browser's
// granted devices (WebUSB's `navigator.usb`, WebHID's `navigator.hid`), the grants this browser has seen (a grant
// can't be told from a device that isn't plugged in, so the page keeps the list), the device locks (a Web Lock per
// identity, held while a machine has the device; who holds one and "let it go" go over the store's channel), and the
// running machine's ports: `usb-attach` and `usb-detach` to the device worker, `usb-state` back (web/usb-device.ts).
// The words and the matching are web/app/usb-ports.ts's; web/app/main.ts drives these for the page's machine.
import type { UsbFromWorker, UsbIdentity, UsbProblem, UsbSpeed, UsbToWorker, UsbVirtual } from '../usb-device.ts';
import { USB_CONNECTORS, type UsbEntry } from './shape.ts';
import type { Note, Store } from './store.ts';
import { deviceName, identityAt, identityKey, matchDevices, problemText, usbLock, type SeenDevice } from './usb-ports.ts';

/** A `USBDevice` or a `HIDDevice`, as far as the page uses one (lib.dom has neither). */
export type HostDevice = SeenDevice & { forget?(): Promise<void>; collections?: unknown[] };
type BrowserApi = {
  getDevices(): Promise<HostDevice[]>;
  requestDevice(o: { filters: object[] }): Promise<HostDevice | HostDevice[]>;
  addEventListener(type: 'connect' | 'disconnect', f: (e: Event & { device: HostDevice }) => void): void;
};
export type Api = 'usb' | 'hid';

/** `navigator.usb` or `navigator.hid`, if this browser has it (Chromium: both; a page needs a secure context). */
export const browserApi = (api: Api) => (globalThis.navigator as unknown as Record<Api, BrowserApi | undefined> | undefined)?.[api];
export const hasApi = (api: Api) => !!browserApi(api);

/** The devices of `api` this origin may use and that are plugged in, in the browser's order. */
export async function listDevices(api: Api): Promise<HostDevice[]> {
  try {
    return (await browserApi(api)?.getDevices()) ?? [];
  } catch {
    return [];
  }
}

/**
 * The browser's chooser (needs a click): every device it may show, or those `filters` match. Undefined when the user
 * cancels; a HID device may come as several `HIDDevice`s (one per interface), all returned.
 */
export async function requestDevices(api: Api, filters: object[] = []): Promise<HostDevice[]> {
  const b = browserApi(api);
  if (!b) throw new Error(api === 'usb' ? 'This browser has no WebUSB (Chromium and Chrome do).' : 'This browser has no WebHID (Chromium and Chrome do).');
  try {
    const r = await b.requestDevice({ filters });
    return Array.isArray(r) ? r : [r];
  } catch (e) {
    if ((e as DOMException).name === 'NotFoundError' || (e as DOMException).name === 'AbortError') return [];
    throw e;
  }
}

/** The filter that finds an entry's device in the chooser: its IDs (and serial number: WebUSB's filters take one, WebHID's don't). */
export const filterFor = (e: Pick<UsbEntry, 'api' | 'vendorId' | 'productId' | 'serialNumber'>) =>
  ({ vendorId: e.vendorId, productId: e.productId, ...(e.api === 'usb' && e.serialNumber ? { serialNumber: e.serialNumber } : {}) });

/** The identity of `device` among `api`'s granted devices now (its index among serial-less twins). */
export async function identityOfDevice(api: Api, device: HostDevice): Promise<UsbIdentity> {
  const all = await listDevices(api);
  const at = all.indexOf(device);
  return at < 0 ? identityAt(api, [device], 0) : identityAt(api, all, at);
}

// The grants this browser has given (identity keys): WebUSB and WebHID say only which granted devices are plugged in.
const GRANTED = 'webpc.usbGranted';
const grants = (): string[] => { try { return JSON.parse(localStorage.getItem(GRANTED) ?? '[]') as string[]; } catch { return []; } };
const keepGrants = (keys: string[]) => { try { localStorage.setItem(GRANTED, JSON.stringify([...new Set(keys)])); } catch { /* not kept */ } };
export const isGranted = (key: string) => grants().includes(key);
export const granted = (...keys: string[]) => keepGrants([...grants(), ...keys]);
export const ungranted = (key: string) => keepGrants(grants().filter((k) => k !== key));

/** What an entry is now, for the USB tab and the menu. */
export type EntryState = 'attached' | 'plugged' | 'unplugged' | 'held' | 'ungranted';
export type EntryView = { entry: UsbEntry; state: EntryState; holder?: string };

/** Finds each entry's device among the granted ones now; the entries found are remembered as granted. */
export async function findDevices(entries: UsbEntry[]): Promise<Map<string, HostDevice>> {
  const out = new Map<string, HostDevice>();
  for (const api of ['usb', 'hid'] as const) {
    if (!entries.some((e) => e.api === api)) continue;
    const all = await listDevices(api);
    for (const [id, at] of matchDevices(entries, api, all)) out.set(id, all[at]);
  }
  granted(...entries.filter((e) => out.has(e.id)).map((e) => identityKey(e)));
  return out;
}

/** The locks held now by anyone (every tab of this origin). */
async function heldLocks(): Promise<Set<string>> {
  if (!globalThis.navigator?.locks) return new Set();
  const q = await navigator.locks.query();
  return new Set((q.held ?? []).map((l) => l.name!).filter(Boolean));
}

/** Each entry's state; `attached`: the entries this page's machine has on a port now (its ids). */
export async function entryStates(entries: UsbEntry[], attached: Set<string>, locks: UsbLocks): Promise<EntryView[]> {
  const found = await findDevices(entries);
  const held = await heldLocks();
  return Promise.all(entries.map(async (entry): Promise<EntryView> => {
    if (attached.has(entry.id)) return { entry, state: 'attached' };
    const lock = usbLock(entry);
    if (held.has(lock) && !locks.mine(lock)) return { entry, state: 'held', holder: await locks.holder(lock) };
    if (found.has(entry.id)) return { entry, state: 'plugged' };
    return { entry, state: isGranted(identityKey(entry)) ? 'unplugged' : 'ungranted' };
  }));
}

/**
 * The device locks of this page (docs/plans/usb.md §4a: one machine at a time per device). A lock is held while its
 * device is attached here. Another tab asks who holds one (`usb-who`, answered `usb-held` with the machine's name) and
 * asks the holder to detach it (`usb-release`), over the store's channel.
 */
export class UsbLocks {
  private held = new Map<string, () => void>();
  private store: Store;
  private me: () => string;
  private release: (lock: string) => void;
  private answers = new Map<string, (name: string) => void>();
  private off: () => void;

  /** `me`: the name of this page's machine; `release`: detaches the device whose lock another tab asks for. */
  constructor(store: Store, me: () => string, release: (lock: string) => void) {
    [this.store, this.me, this.release] = [store, me, release];
    this.off = store.onNote((n: Note) => {
      const lock = String(n.lock ?? '');
      if (n.topic === 'usb-who' && this.held.has(lock)) store.tell({ topic: 'usb-held', lock, name: this.me() });
      else if (n.topic === 'usb-held') this.answers.get(lock)?.(String(n.name));
      else if (n.topic === 'usb-release' && this.held.has(lock)) this.release(lock);
    });
  }

  mine(lock: string) { return this.held.has(lock); }

  /** Takes `lock` if no one holds it: false if another machine does. */
  async take(lock: string): Promise<boolean> {
    if (this.held.has(lock)) return true;
    if (!globalThis.navigator?.locks) return true;
    let release!: () => void;
    const kept = new Promise<void>((resolve) => { release = resolve; });
    const got = await new Promise<boolean>((resolve) => {
      void navigator.locks.request(lock, { ifAvailable: true }, (l) => {
        resolve(!!l);
        return l ? kept : undefined;
      });
    });
    if (got) this.held.set(lock, release);
    return got;
  }

  drop(lock: string) {
    this.held.get(lock)?.();
    this.held.delete(lock);
  }
  dropAll() { for (const l of [...this.held.keys()]) this.drop(l); }

  /** The name of the machine that holds `lock` in another tab (undefined if none answers in time). */
  holder(lock: string, ms = 400): Promise<string | undefined> {
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.answers.delete(lock); resolve(undefined); }, ms);
      this.answers.set(lock, (name) => { clearTimeout(t); this.answers.delete(lock); resolve(name); });
      this.store.tell({ topic: 'usb-who', lock });
    });
  }

  /** Asks the tab that holds `lock` to detach its device, then takes the lock (false if it isn't let go within `ms`). */
  async takeFrom(lock: string, ms = 8000): Promise<boolean> {
    this.store.tell({ topic: 'usb-release', lock });
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await this.take(lock)) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  }

  close() {
    this.dropAll();
    this.off();
  }
}

/** A connector of the running machine. */
export type Connector = { device: UsbIdentity | UsbVirtual; name: string; entry?: string; state: 'attaching' | 'attached' | 'detaching'; speed?: UsbSpeed; problems?: UsbProblem[] };

/** Why an attach failed, in words (the device worker's message and its problems'). */
export class UsbError extends Error {
  readonly problems: UsbProblem[];
  constructor(message: string, problems: UsbProblem[] = []) {
    super(message);
    this.problems = problems;
  }
}

/**
 * The running machine's ports: what is attached where, and the requests to the device worker (one at a time per
 * connector). A device the worker reports gone by itself (unplugged, the guest) is `onGone`'s; any change is `onChange`'s.
 */
export class UsbPorts {
  readonly connectors: (Connector | undefined)[] = Array.from({ length: USB_CONNECTORS }, () => undefined);
  private port: MessagePort;
  private locks: UsbLocks;
  private pending = new Map<number, { resolve(): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }>();
  onChange = () => {};
  onGone: (c: number, was: Connector, reason?: string) => void = () => {};

  constructor(port: MessagePort, locks: UsbLocks) {
    [this.port, this.locks] = [port, locks];
    port.onmessage = (e: MessageEvent<UsbFromWorker>) => this.heard(e.data);
  }

  private heard(m: UsbFromWorker) {
    if (m.type !== 'usb-state') return;
    const c = this.connectors[m.connector];
    const p = this.pending.get(m.connector);
    if (p) { clearTimeout(p.timer); this.pending.delete(m.connector); }
    if (m.state === 'attached') {
      if (c) Object.assign(c, { state: 'attached', speed: m.speed, problems: m.problems });
      p?.resolve();
    } else {
      this.free(m.connector);
      if (m.state === 'error') {
        const d = c && 'vendorId' in c.device ? c.device : undefined;
        const words = d ? (m.detail ?? []).map((x) => problemText(x, d)) : [];
        p?.reject(new UsbError([m.message, ...words].join('\n'), m.detail));
        if (!p && c) this.onGone(m.connector, c, m.message);
      } else {
        p?.resolve();
        if (!p && c) this.onGone(m.connector, c, m.reason);
      }
    }
    this.onChange();
  }

  private free(connector: number) {
    const c = this.connectors[connector];
    if (c && 'vendorId' in c.device) this.locks.drop(usbLock(c.device));
    this.connectors[connector] = undefined;
  }

  private request(connector: number, m: UsbToWorker, ms: number) {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(connector);
        if (m.type === 'usb-attach') this.free(connector);
        this.onChange();
        reject(new UsbError("The machine's USB controller didn't answer: is it still running?"));
      }, ms);
      this.pending.set(connector, { resolve, reject, timer });
      this.port.postMessage(m satisfies UsbToWorker);
    });
  }

  /** The connector entry `id` is attached on (or being attached), if any. */
  connectorOf(entry: string) { return this.connectors.findIndex((c) => c?.entry === entry); }
  /** The entries attached now. */
  attachedEntries() { return new Set(this.connectors.flatMap((c) => (c?.entry && c.state === 'attached' ? [c.entry] : []))); }
  /** What is on the ports now, named (for Snapshot's question). */
  attached() { return this.connectors.flatMap((c, i) => (c ? [{ connector: i, ...c }] : [])); }

  /**
   * Attaches `device` on `connector` (taking its lock first: a `held` error when another machine has it). Rejects with
   * the device worker's reason, in words.
   */
  async attach(connector: number, device: UsbIdentity | UsbVirtual, entry?: string, ms = 30_000): Promise<void> {
    const busy = this.connectors[connector];
    if (busy) throw new UsbError(`Connector ${connector + 1} has ${busy.name}: detach it first.`);
    if (device.api !== 'virtual' && !(await this.locks.take(usbLock(device)))) throw new UsbError('held');
    if (this.connectors[connector]) { if (device.api !== 'virtual') this.locks.drop(usbLock(device)); throw new UsbError(`Connector ${connector + 1} is in use.`); }
    this.connectors[connector] = { device, name: deviceName(device), entry, state: 'attaching' };
    this.onChange();
    await this.request(connector, { type: 'usb-attach', connector, device }, ms);
  }

  /** Detaches what is on `connector` (the guest sees an unplug); resolves once the worker says it's off. */
  async detach(connector: number, ms = 10_000): Promise<void> {
    const c = this.connectors[connector];
    if (!c) return;
    c.state = 'detaching';
    this.onChange();
    try {
      await this.request(connector, { type: 'usb-detach', connector }, ms);
    } finally {
      this.free(connector);
      this.onChange();
    }
  }

  /** Detaches everything (Snapshot, Suspend: docs/plans/usb.md §4a); returns what was attached, to attach it again. */
  async detachAll(): Promise<{ connector: number; device: UsbIdentity | UsbVirtual; entry?: string }[]> {
    const was = this.attached().filter((c) => c.state === 'attached').map((c) => ({ connector: c.connector, device: c.device, entry: c.entry }));
    await Promise.all(this.connectors.map((c, i) => (c ? this.detach(i).catch(() => {}) : undefined)));
    return was;
  }

  /** The machine stopped: nothing is attached any more; the locks go. */
  close() {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new UsbError('The machine stopped.')); }
    this.pending.clear();
    for (let i = 0; i < USB_CONNECTORS; i++) this.free(i);
    this.port.onmessage = null;
    this.port.close();
    this.onChange();
  }
}
