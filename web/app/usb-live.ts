// The live side of a machine's USB devices on the page (docs/usb.md "The page"): the browser's
// granted devices (WebUSB's `navigator.usb`, WebHID's `navigator.hid`), the grants this browser has seen (a grant
// can't be told from a device that isn't plugged in, so the page keeps the list), the device locks (a Web Lock per
// identity, held while a machine has the device; who holds one and "let it go" go over the store's channel), and the
// running machine's ports: `usb-attach` and `usb-detach` to the device worker, `usb-state` back (web/usb-device.ts).
// The matching is web/app/usb-ports.ts's, the words web/app/usb-problems.ts's; web/app/areas/usb-*.ts drive these for
// the page's machine.
import type { PadState } from '../usb-gamepad.ts';
import type { UsbFromWorker, UsbIdentity, UsbProblem, UsbSpeed, UsbToWorker, UsbVirtual } from '../usb-device.ts';
import { fromWire, MsgError, type Params } from '../msg.ts';
import { USB_CONNECTORS, type UsbEntry } from './shape.ts';
import { Locks } from './locks.ts';
import type { Store } from './store.ts';
import { deviceName, identityAt, identityKey, matchDevices, usbLock, type SeenDevice } from './usb-ports.ts';
import { problemText, type ProblemWords } from './usb-problems.ts';

/** A `USBDevice` or a `HIDDevice`, as far as the page uses one (lib.dom has neither). */
export type HostDevice = SeenDevice & { forget?(): Promise<void>; collections?: unknown[] };
type BrowserApi = {
  getDevices(): Promise<HostDevice[]>;
  requestDevice(o: { filters: object[] }): Promise<HostDevice | HostDevice[]>;
  addEventListener(type: 'connect' | 'disconnect', f: (e: Event & { device: HostDevice }) => void): void;
};
export type Api = 'usb' | 'hid';

/** `navigator.usb` or `navigator.hid`, if this browser has it (Chromium: both; a page needs a secure context). */
export const browserApi = (api: Api) =>
  (globalThis.navigator as unknown as Record<Api, BrowserApi | undefined> | undefined)?.[api];
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
  if (!b) throw api === 'usb' ? new MsgError('usb:usb-live.noWebUsb') : new MsgError('usb:usb-live.noWebHid');
  try {
    const r = await b.requestDevice({ filters });
    return Array.isArray(r) ? r : [r];
  } catch (e) {
    if ((e as DOMException).name === 'NotFoundError' || (e as DOMException).name === 'AbortError') return [];
    throw e;
  }
}

/** The filter that finds an entry's device in the chooser: its IDs (and serial number: WebUSB's filters take one, WebHID's don't). */
export const filterFor = (e: Pick<UsbEntry, 'api' | 'vendorId' | 'productId' | 'serialNumber'>) => ({
  vendorId: e.vendorId,
  productId: e.productId,
  ...(e.api === 'usb' && e.serialNumber ? { serialNumber: e.serialNumber } : {}),
});

/** The identity of `device` among `api`'s granted devices now (its index among serial-less twins). */
export async function identityOfDevice(api: Api, device: HostDevice): Promise<UsbIdentity> {
  const all = await listDevices(api);
  const at = all.indexOf(device);
  return at < 0 ? identityAt(api, [device], 0) : identityAt(api, all, at);
}

// The grants this browser has given (identity keys): WebUSB and WebHID say only which granted devices are plugged in.
const GRANTED = 'waarm64.usbGranted';
const grants = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(GRANTED) ?? '[]') as string[];
  } catch {
    return [];
  }
};
const keepGrants = (keys: string[]) => {
  try {
    localStorage.setItem(GRANTED, JSON.stringify([...new Set(keys)]));
  } catch {
    /* not kept */
  }
};
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

/** Each entry's state; `attached`: the entries this page's machine has on a port now (its ids). */
export async function entryStates(entries: UsbEntry[], attached: Set<string>, locks: UsbLocks): Promise<EntryView[]> {
  const found = await findDevices(entries);
  const held = await locks.heldElsewhere();
  return Promise.all(
    entries.map(async (entry): Promise<EntryView> => {
      if (attached.has(entry.id)) return { entry, state: 'attached' };
      const lock = usbLock(entry);
      if (held.has(lock)) return { entry, state: 'held', holder: await locks.holder(lock) };
      if (found.has(entry.id)) return { entry, state: 'plugged' };
      return { entry, state: isGranted(identityKey(entry)) ? 'unplugged' : 'ungranted' };
    }),
  );
}

/** The device locks of this page (docs/usb.md "The page": one machine at a time per device), held while a device is attached here. */
export class UsbLocks extends Locks {
  /** `me`: the name of this page's machine; `release`: detaches the device whose lock another tab asks for. */
  constructor(store: Store, me: () => string, release: (lock: string) => void) {
    super(store, 'usb', me, release);
  }
}

/** A connector of the running machine. */
export type Connector = {
  device: UsbIdentity | UsbVirtual;
  name: string;
  entry?: string;
  state: 'attaching' | 'attached' | 'detaching';
  speed?: UsbSpeed;
  problems?: UsbProblem[];
};

/**
 * Why an attach failed: its message (the headline), and, where the device worker said which problems, their `words` for
 * the page to show under it with their remedies folded (UsbProblems.svelte; usb-problems.ts `errorView`).
 */
export class UsbError extends MsgError {
  readonly problems: UsbProblem[];
  readonly words: ProblemWords[];
  constructor(key: string, params?: Params, problems: UsbProblem[] = [], words: ProblemWords[] = []) {
    super(key, params);
    this.name = 'UsbError';
    this.problems = problems;
    this.words = words;
  }
}

/** Another machine (in another tab) holds the device's lock: the page asks to take it (web/app/areas/usb-attach.ts `attach`). */
export class UsbHeldError extends Error {
  constructor() {
    super('held');
    this.name = 'UsbHeldError';
  }
}

/** A request to the device worker waiting for its connector's state. */
type Pending = { resolve(): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> };

/**
 * The running machine's ports: what is attached where, and the requests to the device worker (one at a time per
 * connector). A device the worker reports gone by itself (unplugged, the guest) is `onGone`'s; any change is `onChange`'s.
 */
export class UsbPorts {
  readonly connectors: (Connector | undefined)[] = Array.from({ length: USB_CONNECTORS }, () => undefined);
  private port: MessagePort;
  private locks: UsbLocks;
  private pending = new Map<number, Pending>();
  onChange: () => void = () => undefined;
  /** The guest set the LEDs of the keyboard on connector `c` (the built-in one's: bit 0 Num, 1 Caps, 2 Scroll Lock). */
  onLeds: (c: number, leds: number) => void = () => undefined;
  /** The guest's rumble on the game pad of ours on connector `c` (each motor 0–1; web/usb-gamepad.ts). */
  onRumble: (c: number, strong: number, weak: number) => void = () => undefined;
  /** `reason`: why it went (`usb-state` detached); `error`: the device worker's error, when it failed by itself. */
  onGone: (c: number, was: Connector, reason?: 'unplugged' | 'guest' | 'page', error?: Error) => void = () => undefined;

  constructor(port: MessagePort, locks: UsbLocks) {
    [this.port, this.locks] = [port, locks];
    port.onmessage = (e: MessageEvent<UsbFromWorker>) => this.heard(e.data);
  }

  private heard(m: UsbFromWorker) {
    switch (m.type) {
      case 'usb-leds':
        return this.onLeds(m.connector, m.leds);
      case 'usb-rumble':
        return this.onRumble(m.connector, m.strong, m.weak);
      case 'usb-state':
        return this.stateHeard(m);
    }
  }

  /** A connector's state: attached, detached or failed, a request waiting on it settled. */
  private stateHeard(m: Extract<UsbFromWorker, { type: 'usb-state' }>) {
    const c = this.connectors[m.connector];
    const p = this.pending.get(m.connector);
    if (p) {
      clearTimeout(p.timer);
      this.pending.delete(m.connector);
    }
    if (m.state === 'attached') {
      if (c) Object.assign(c, { state: 'attached', speed: m.speed, problems: m.problems });
      p?.resolve();
    } else {
      this.free(m.connector);
      if (m.state === 'error') this.failed(m, c, p);
      else {
        p?.resolve();
        if (!p && c) this.onGone(m.connector, c, m.reason);
      }
    }
    this.onChange();
  }

  /** A connector that failed by itself: a request waiting on it rejected (with the problems' words where known), or it's gone. */
  private failed(m: Extract<UsbFromWorker, { state: 'error' }>, c: Connector | undefined, p: Pending | undefined) {
    const d = c && 'vendorId' in c.device ? c.device : undefined;
    const words = d ? (m.detail ?? []).map((x) => problemText(x, d)) : [];
    const err = m.error ? fromWire(m.error) : new Error(m.message);
    p?.reject(c && words.length ? new UsbError('usb:usb-live.notAttached', { name: c.name }, m.detail, words) : err);
    if (!p && c) this.onGone(m.connector, c, undefined, err);
  }

  private free(connector: number) {
    const c = this.connectors[connector];
    if (c && 'vendorId' in c.device) this.locks.drop(usbLock(c.device));
    this.connectors[connector] = undefined;
  }

  private request(connector: number, m: UsbToWorker, ms: number) {
    // A detach while the attach is still opening: the attach is settled now, as the worker forgets it (it lets the
    // device go when it opens; its late answer finds the connector freed and is dropped).
    const was = this.pending.get(connector);
    if (was) {
      clearTimeout(was.timer);
      was.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.get(connector)?.timer !== timer) return;
        this.pending.delete(connector);
        if (m.type === 'usb-attach') this.free(connector);
        this.onChange();
        reject(new UsbError('usb:usb-live.noAnswer'));
      }, ms);
      this.pending.set(connector, { resolve, reject, timer });
      this.port.postMessage(m satisfies UsbToWorker);
    });
  }

  /** The connector entry `id` is attached on (or being attached), if any. */
  connectorOf(entry: string) {
    return this.connectors.findIndex((c) => c?.entry === entry);
  }
  /** The entries attached now. */
  attachedEntries() {
    return new Set(this.connectors.flatMap((c) => (c?.entry && c.state === 'attached' ? [c.entry] : [])));
  }
  /** What is on the ports now, named (for Snapshot's question). */
  attached() {
    return this.connectors.flatMap((c, i) => (c ? [{ connector: i, ...c }] : []));
  }

  /**
   * Attaches `device` on `connector` (taking its lock first: a `UsbHeldError` when another machine has it). Rejects with
   * the device worker's reason, in words.
   */
  async attach(connector: number, device: UsbIdentity | UsbVirtual, entry?: string, ms = 30_000): Promise<void> {
    const busy = this.connectors[connector];
    if (busy) throw new UsbError('usb:usb-live.connectorTaken', { connector: connector + 1, name: busy.name });
    if (device.api !== 'virtual' && !(await this.locks.take(usbLock(device)))) throw new UsbHeldError();
    if (this.connectors[connector]) {
      if (device.api !== 'virtual') this.locks.drop(usbLock(device));
      throw new UsbError('usb:usb-live.connectorInUse', { connector: connector + 1 });
    }
    this.connectors[connector] = { device, name: deviceName(device), entry, state: 'attaching' };
    this.onChange();
    await this.request(connector, { type: 'usb-attach', connector, device }, ms);
  }

  /** A key of the page's for the built-in keyboard on `connector` (`code` '': release them all); no answer. */
  key(connector: number, code: string, down: boolean) {
    this.port.postMessage({ type: 'usb-key', connector, code, down } satisfies UsbToWorker);
  }

  /** The page's game pad's state for the game pad of ours on `connector` (web/app/gamepads.ts); no answer. */
  pad(connector: number, pad: PadState) {
    this.port.postMessage({ type: 'usb-pad', connector, pad } satisfies UsbToWorker);
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

  /** Detaches everything (Snapshot, Suspend: docs/usb.md "The page"); returns what was attached, to attach it again. */
  async detachAll(): Promise<{ connector: number; device: UsbIdentity | UsbVirtual; entry?: string }[]> {
    const was = this.attached()
      .filter((c) => c.state === 'attached')
      .map((c) => ({ connector: c.connector, device: c.device, entry: c.entry }));
    // A device that fails to detach is let go of anyway (the run stops or resumes without it): nothing to report.
    await Promise.all(this.connectors.flatMap((c, i) => (c ? [this.detach(i).catch(() => undefined)] : [])));
    return was;
  }

  /** The machine stopped: nothing is attached any more; the locks go. */
  close() {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new UsbError('usb:usb-live.stopped'));
    }
    this.pending.clear();
    for (let i = 0; i < USB_CONNECTORS; i++) this.free(i);
    this.port.onmessage = null;
    this.port.close();
    this.onChange();
  }
}
