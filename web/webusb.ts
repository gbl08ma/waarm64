// The WebUSB passthrough (docs/usb.md "The WebUSB passthrough"): a
// device the browser opened, served to the guest as itself. Its raw descriptors are read once at
// attach and answered from a cache, with the interfaces WebUSB can't claim filtered out of the
// configuration descriptors; the standard OUT requests WebUSB refuses are interpreted
// (selectConfiguration, selectAlternateInterface, clearHalt); class and vendor requests and the
// transfers pass through. A cancelled IN transfer can't be withdrawn from WebUSB, so its data is
// carried over to the endpoint's next TD.
//
// The WebUSB surface is typed locally (`WebUsbDeviceLike`): Node's tests pass a scripted fake, and a
// MessagePort proxy from the page could stand in for a worker without `navigator.usb`.

import { MsgError, type Params } from './msg.ts';
import type { Setup, UsbCode, UsbDevice, UsbEndpoint, UsbIdentity, UsbProblem, UsbResult, UsbSpeed, UsbTransfer } from './usb-device.ts';

// ---- The WebUSB surface we use -------------------------------------------------------------------

export type WebUsbSetup = {
  requestType: 'standard' | 'class' | 'vendor';
  recipient: 'device' | 'interface' | 'endpoint' | 'other';
  request: number;
  value: number;
  index: number;
};
export type WebUsbStatus = 'ok' | 'stall' | 'babble';
export type WebUsbInResult = { data?: DataView; status: WebUsbStatus };
export type WebUsbOutResult = { bytesWritten: number; status: WebUsbStatus };

export interface WebUsbDeviceLike {
  readonly vendorId: number;
  readonly productId: number;
  readonly serialNumber?: string | null;
  readonly productName?: string | null;
  readonly opened: boolean;
  readonly configuration: { configurationValue: number; interfaces: readonly { interfaceNumber: number; claimed: boolean }[] } | null;
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(value: number): Promise<void>;
  claimInterface(n: number): Promise<void>;
  releaseInterface(n: number): Promise<void>;
  selectAlternateInterface(n: number, alt: number): Promise<void>;
  controlTransferIn(setup: WebUsbSetup, length: number): Promise<WebUsbInResult>;
  controlTransferOut(setup: WebUsbSetup, data?: BufferSource): Promise<WebUsbOutResult>;
  transferIn(endpointNumber: number, length: number): Promise<WebUsbInResult>;
  transferOut(endpointNumber: number, data: BufferSource): Promise<WebUsbOutResult>;
  clearHalt(direction: 'in' | 'out', endpointNumber: number): Promise<void>;
  reset(): Promise<void>;
}

/** `navigator.usb`, as much of it as the opener uses. */
export interface WebUsbLike {
  getDevices(): Promise<WebUsbDeviceLike[]>;
  addEventListener(type: 'disconnect', listener: (e: { device: WebUsbDeviceLike }) => void): void;
  removeEventListener(type: 'disconnect', listener: (e: { device: WebUsbDeviceLike }) => void): void;
}

// ---- Descriptors ---------------------------------------------------------------------------------

export const DT_DEVICE = 1;
export const DT_CONFIG = 2;
export const DT_STRING = 3;
export const DT_INTERFACE = 4;
export const DT_ENDPOINT = 5;
export const DT_DEVICE_QUALIFIER = 6;
export const DT_OTHER_SPEED = 7;
export const DT_IAD = 0x0b;
export const DT_BOS = 0x0f;
export const DT_SS_EP_COMPANION = 0x30;
export const DT_SSP_ISOC_EP_COMPANION = 0x31;

/** WebUSB's protected interface classes (docs/usb.md "What the browser allows"). */
export const PROTECTED_CLASSES: ReadonlySet<number> = new Set([0x01, 0x03, 0x08, 0x09, 0x0b, 0x0e, 0x10, 0xe0]);


/** One descriptor of a configuration's chain. */
export type Desc = { type: number; bytes: Uint8Array };

/** Splits a configuration descriptor (with what follows it) into its descriptors; a malformed tail is dropped. */
export function splitDescriptors(b: Uint8Array): Desc[] {
  const out: Desc[] = [];
  for (let o = 0; o + 2 <= b.length; ) {
    const len = b[o];
    if (len < 2 || o + len > b.length) break;
    out.push({ type: b[o + 1], bytes: b.subarray(o, o + len) });
    o += len;
  }
  return out;
}

export type EpInfo = { address: number; attributes: number; maxPacket: number; interval: number; companion: boolean };
export type AltInfo = { number: number; alternate: number; cls: number; subclass: number; protocol: number; iInterface: number; endpoints: EpInfo[] };
export type ConfigInfo = {
  value: number;
  iConfiguration: number;
  interfaces: Map<number, AltInfo[]>;
  iads: { first: number; count: number; iFunction: number }[];
};

export function parseConfig(raw: Uint8Array): ConfigInfo {
  const ds = splitDescriptors(raw);
  const c: ConfigInfo = { value: raw[5] ?? 0, iConfiguration: raw[6] ?? 0, interfaces: new Map(), iads: [] };
  let alt: AltInfo | null = null;
  for (const d of ds) {
    const b = d.bytes;
    if (d.type === DT_INTERFACE && b.length >= 9) {
      alt = { number: b[2], alternate: b[3], cls: b[5], subclass: b[6], protocol: b[7], iInterface: b[8], endpoints: [] };
      const list = c.interfaces.get(alt.number) ?? [];
      list.push(alt);
      c.interfaces.set(alt.number, list);
    } else if (d.type === DT_ENDPOINT && b.length >= 7 && alt) {
      alt.endpoints.push({ address: b[2], attributes: b[3], maxPacket: b[4] | (b[5] << 8), interval: b[6], companion: false });
    } else if (d.type === DT_SS_EP_COMPANION && alt && alt.endpoints.length) {
      alt.endpoints[alt.endpoints.length - 1].companion = true;
    } else if (d.type === DT_IAD && b.length >= 8) {
      c.iads.push({ first: b[2], count: b[3], iFunction: b[7] });
    }
  }
  return c;
}

/** An interface is protected when any of its alternate settings has a protected class (Chromium refuses the claim). */
export const isProtected = (alts: AltInfo[]) => alts.some((a) => PROTECTED_CLASSES.has(a.cls));

/**
 * The configuration descriptor without the interfaces in `drop`: their interface descriptors and
 * everything up to the next interface or IAD go; `bNumInterfaces` and `wTotalLength` are rewritten;
 * an IAD loses the dropped interfaces from its range (first and count over what's left), and goes
 * when none is left. Interface numbers stay as they are (the guest addresses requests by them), so
 * the numbers may have gaps: Linux notes that and binds the rest.
 */
export function filterConfig(raw: Uint8Array, drop: ReadonlySet<number>): Uint8Array {
  if (drop.size === 0) return raw.slice();
  const ds = splitDescriptors(raw);
  const kept: Uint8Array[] = [];
  const present = new Set<number>();
  for (const d of ds) if (d.type === DT_INTERFACE && !drop.has(d.bytes[2])) present.add(d.bytes[2]);
  let skipping = false;
  for (let i = 0; i < ds.length; i++) {
    const d = ds[i];
    if (i === 0) { kept.push(d.bytes.slice()); continue; }
    if (d.type === DT_INTERFACE) skipping = drop.has(d.bytes[2]);
    else if (d.type === DT_IAD) {
      skipping = false;
      const first = d.bytes[2], count = d.bytes[3];
      const left = [...present].filter((n) => n >= first && n < first + count).sort((a, b) => a - b);
      if (left.length === 0) continue;
      const iad = d.bytes.slice();
      iad[2] = left[0];
      iad[3] = left[left.length - 1] - left[0] + 1;
      kept.push(iad);
      continue;
    }
    if (!skipping) kept.push(d.bytes.slice());
  }
  const total = kept.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const b of kept) { out.set(b, o); o += b.length; }
  out[2] = total & 0xff;
  out[3] = total >> 8;
  out[4] = present.size;
  return out;
}

/**
 * The speed a device runs at, from its descriptors (docs/usb.md): SuperSpeed companions or
 * a 512-byte endpoint 0 → super; what only high speed allows → high: a 512-byte bulk endpoint, an
 * interrupt one over 64 bytes, an isochronous one over 1023 (full speed allows isochronous packets up
 * to 1023 bytes: a wired Xbox controller's audio interface has 228-byte ones), or high-bandwidth
 * transactions (bits 11–12 of wMaxPacketSize); an 8-byte endpoint 0 with no bulk or isochronous
 * endpoints and interrupt ones of at most 8 bytes → low; otherwise full.
 */
export function inferSpeed(device: Uint8Array, configs: ConfigInfo[]): UsbSpeed {
  const eps = configs.flatMap((c) => [...c.interfaces.values()].flat().flatMap((a) => a.endpoints));
  if (device[7] === 9 || eps.some((e) => e.companion)) return 'super';
  const size = (e: EpInfo) => e.maxPacket & 0x7ff;
  const type = (e: EpInfo) => e.attributes & 3;
  const highOnly = (e: EpInfo) => (type(e) === 2 && size(e) === 512) || (type(e) === 3 && size(e) > 64) || (type(e) === 1 && size(e) > 1023)
    || ((type(e) === 1 || type(e) === 3) && (e.maxPacket & 0x1800) !== 0);
  if (eps.some(highOnly)) return 'high';
  if (device[7] === 8 && eps.every((e) => type(e) === 3 && size(e) <= 8)) return 'low';
  return 'full';
}

// ---- The backend ---------------------------------------------------------------------------------

const RT_IN = 0x80;
const REQ_GET_STATUS = 0, REQ_CLEAR_FEATURE = 1, REQ_SET_FEATURE = 3, REQ_GET_DESCRIPTOR = 6;
const REQ_GET_CONFIGURATION = 8, REQ_SET_CONFIGURATION = 9, REQ_GET_INTERFACE = 10, REQ_SET_INTERFACE = 11;
const REQ_SET_SEL = 48, REQ_SET_ISOCH_DELAY = 49;
const FEATURE_ENDPOINT_HALT = 0;

const TYPES = ['standard', 'class', 'vendor'] as const;
const RECIPIENTS = ['device', 'interface', 'endpoint', 'other'] as const;

export function webUsbSetup(s: Setup): WebUsbSetup | null {
  const type = TYPES[(s.requestType >> 5) & 3];
  const recipient = RECIPIENTS[s.requestType & 0x1f];
  if (!type || !recipient) return null;
  return { requestType: type, recipient, request: s.request, value: s.value, index: s.index };
}

const bytesOf = (dv: DataView | undefined): Uint8Array => (dv ? new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength).slice() : new Uint8Array(0));
const statusCode = (s: WebUsbStatus): UsbCode => (s === 'stall' ? 'stall' : s === 'babble' ? 'babble' : 'success');

/** An IN result of `data` for a TD of `length` bytes: Short Packet when fewer. */
function inResult(data: Uint8Array, length: number, code: UsbCode = 'success'): UsbResult {
  const d = data.length > length ? data.subarray(0, length) : data;
  return { code: code === 'success' && d.length < length ? 'short' : code, actual: d.length, data: d };
}

type Td = { tag: number; length: number; result?: UsbResult; done: (r: UsbResult) => void };

/** TDs of one endpoint, completed in submit order whatever order their results come in. */
class Order {
  q: Td[] = [];
  add(td: Td) { this.q.push(td); }
  finish(td: Td, r: UsbResult) {
    if (!this.q.includes(td)) return;
    td.result = r;
    while (this.q.length && this.q[0].result) {
      const t = this.q.shift()!;
      t.done(t.result!);
    }
  }
  drop(tags: ReadonlySet<number>) { this.q = this.q.filter((t) => !tags.has(t.tag)); }
}

type Chunk = { data: Uint8Array; code: UsbCode };

/**
 * An IN endpoint as a stream: WebUSB transfers in flight in order, the guest's TDs waiting in order,
 * and what arrived for no TD (a cancelled TD's transfer) carried over. Each arriving result goes to
 * the oldest waiting TD, or to the carry-over when none waits; a TD is served from the carry-over
 * first. A new transfer is issued only when there are fewer in flight than TDs waiting, so a
 * cancelled TD's transfer serves the next TD's bytes (docs/usb.md, "IN data outlives a
 * cancel"): nothing is lost or reordered.
 */
class InEndpoint {
  inflight = 0;
  waiting: Td[] = [];
  carry: Chunk[] = [];
  readonly order: Order;
  constructor(order: Order) {
    this.order = order;
  }
}

export type WebUsbOptions = {
  /** Called once when the device turns out to be gone (a transfer's NotFoundError, a failed reset). */
  gone?: () => void;
};

/** An open failed, or left nothing the guest could use; `problems` says why, for the page. */
export class UsbOpenError extends MsgError {
  readonly problems: UsbProblem[];
  constructor(key: string, params: Params | undefined, problems: UsbProblem[], options?: { cause?: unknown }) {
    super(key, params, options);
    this.name = 'UsbOpenError';
    this.problems = problems;
  }
}

/** The browser couldn't open the device (`e`: its error, whose words are the browser's). WebHID's opener says it too. */
export const openFailed = (e: unknown) => new UsbOpenError('usb:webusb.openFailed', undefined, [{ kind: 'open-failed', message: (e as Error).message }], { cause: e });
/** The granted device isn't among those the browser lists now. WebHID's opener says it too. */
export const notFound = () => new UsbOpenError('usb:webusb.notFound', undefined, [{ kind: 'open-failed', message: 'not found' }]); // i18n-ignore: stands for the browser's own error

const GET = (type: number, index: number, lang: number, length: number): [WebUsbSetup, number] => [
  { requestType: 'standard', recipient: 'device', request: REQ_GET_DESCRIPTOR, value: (type << 8) | index, index: lang },
  length,
];

/**
 * Opens `dev` for the guest (docs/usb.md "The WebUSB passthrough"): opens it, selects its first
 * configuration if it has none, reads its raw descriptors, claims what it can and infers the speed.
 * Throws a `UsbOpenError` when the device can't be opened or no interface is left for the guest.
 */
export async function openWebUsb(dev: WebUsbDeviceLike, opts: WebUsbOptions = {}): Promise<WebUsbPassthrough> {
  try {
    if (!dev.opened) await dev.open();
  } catch (e) {
    throw openFailed(e);
  }
  const p = new WebUsbPassthrough(dev, opts);
  try {
    await p.init();
  } catch (e) {
    await dev.close().catch(() => {});
    if (e instanceof UsbOpenError) throw e;
    throw new UsbOpenError('usb:webusb.readFailed', undefined, [{ kind: 'open-failed', message: (e as Error).message }], { cause: e });
  }
  return p;
}

export class WebUsbPassthrough implements UsbDevice {
  speed: UsbSpeed = 'full';
  /** What can't reach the guest (protected interfaces, failed claims), for the page's notes. */
  problems: UsbProblem[] = [];
  deviceDesc: Uint8Array = new Uint8Array(0);
  /** Raw configuration descriptors, by index. */
  configsRaw: Uint8Array[] = [];
  configs: ConfigInfo[] = [];
  /** What the guest gets for GET_DESCRIPTOR(CONFIGURATION, i). */
  served: Uint8Array[] = [];
  bos: Uint8Array | null = null;
  strings = new Map<string, Uint8Array>();
  /** Interfaces of the active configuration we hold, and their current alternate settings. */
  claimed = new Set<number>();
  /**
   * Endpoints the guest halted with SET_FEATURE(ENDPOINT_HALT). WebUSB refuses that request (a standard
   * OUT), so the halt is ours: TDs to the endpoint stall here and GET_STATUS says halted, until the
   * guest's CLEAR_FEATURE (which also clears the device's side, resetting its data toggle).
   */
  halted = new Set<number>();
  alternates = new Map<number, number>();
  /** The configuration the guest set (0 after SET_CONFIGURATION 0, when we released everything). */
  guestConfig = 0;
  private ins = new Map<number, InEndpoint>();
  private outs = new Map<number, Order>();
  private ctrl = new Order();
  /** Device-wide changes (configuration, alternates, reset) run in order, and transfers wait behind them. */
  private chain: Promise<unknown> = Promise.resolve();
  private gen = 0;
  private dead = false;
  private goneCalled = false;

  readonly dev: WebUsbDeviceLike;
  readonly opts: WebUsbOptions;

  constructor(dev: WebUsbDeviceLike, opts: WebUsbOptions = {}) {
    this.dev = dev;
    this.opts = opts;
  }

  // -- Attach --

  private async get(type: number, index: number, lang: number, length: number): Promise<Uint8Array | null> {
    const r = await this.dev.controlTransferIn(...GET(type, index, lang, length));
    return r.status === 'ok' ? bytesOf(r.data) : null;
  }

  async init() {
    const dd = await this.get(DT_DEVICE, 0, 0, 18);
    if (!dd || dd.length < 18 || dd[1] !== DT_DEVICE) throw new Error('no device descriptor');
    this.deviceDesc = dd;
    for (let i = 0; i < dd[17]; i++) {
      const head = await this.get(DT_CONFIG, i, 0, 9);
      if (!head || head.length < 9) throw new Error(`no configuration descriptor ${i}`);
      const total = head[2] | (head[3] << 8);
      const full = total > 9 ? await this.get(DT_CONFIG, i, 0, total) : head;
      if (!full) throw new Error(`no configuration descriptor ${i}`);
      this.configsRaw.push(full);
      this.configs.push(parseConfig(full));
    }
    const bcd = dd[2] | (dd[3] << 8);
    if (bcd >= 0x0201) {
      const head = await this.get(DT_BOS, 0, 0, 5).catch(() => null);
      if (head && head.length >= 5) {
        const total = head[2] | (head[3] << 8);
        this.bos = total > 5 ? await this.get(DT_BOS, 0, 0, total).catch(() => null) : head;
      }
    }
    await this.readStrings();
    if (!this.dev.configuration && this.configs.length) await this.dev.selectConfiguration(this.configs[0].value);
    this.speed = inferSpeed(this.deviceDesc, this.configs);
    await this.claimActive();
    // A configuration without interfaces is the guest's to use (control requests only); one whose every interface is out of reach isn't.
    const ifaces = this.active()?.interfaces.size ?? 0;
    if (ifaces > 0 && this.claimed.size === 0) throw new UsbOpenError('usb:webusb.noInterface', undefined, this.problems);
  }

  private async readStrings() {
    const langs = await this.get(DT_STRING, 0, 0, 255).catch(() => null);
    if (!langs || langs.length < 4) return;
    this.strings.set('0:0', langs);
    const ids = new Set<number>([this.deviceDesc[14], this.deviceDesc[15], this.deviceDesc[16]]);
    for (const c of this.configs) {
      ids.add(c.iConfiguration);
      for (const alts of c.interfaces.values()) for (const a of alts) ids.add(a.iInterface);
      for (const iad of c.iads) ids.add(iad.iFunction);
    }
    ids.delete(0);
    for (let o = 2; o + 1 < langs.length; o += 2) {
      const lang = langs[o] | (langs[o + 1] << 8);
      for (const i of [...ids].sort((a, b) => a - b)) {
        const s = await this.get(DT_STRING, i, lang, 255).catch(() => null);
        if (s && s.length >= 2) this.strings.set(`${i}:${lang}`, s);
      }
    }
  }

  private active(): ConfigInfo | undefined {
    const v = this.dev.configuration?.configurationValue;
    return this.configs.find((c) => c.value === v);
  }

  /** Claims the active configuration's interfaces that aren't protected, and rebuilds the served descriptors. */
  private async claimActive() {
    this.problems = [];
    this.claimed.clear();
    this.alternates.clear();
    const act = this.active();
    const failed = new Set<number>();
    if (act) {
      for (const [n, alts] of act.interfaces) {
        if (isProtected(alts)) {
          const cls = alts.find((a) => PROTECTED_CLASSES.has(a.cls))!.cls;
          this.problems.push({ kind: 'protected-interface', interface: n, class: cls });
          continue;
        }
        const was = this.dev.configuration?.interfaces.find((i) => i.interfaceNumber === n)?.claimed;
        try {
          if (!was) await this.dev.claimInterface(n);
          this.claimed.add(n);
          this.alternates.set(n, 0);
        } catch (e) {
          failed.add(n);
          // The browser's words; the remedy for the host's OS is the page's (web/app/usb-ports.ts `problemText`).
          this.problems.push({ kind: 'claim-failed', interface: n, message: (e as Error).message ?? String(e) });
        }
      }
    }
    this.served = this.configsRaw.map((raw, i) => {
      const c = this.configs[i];
      const drop = new Set<number>();
      for (const [n, alts] of c.interfaces) if (isProtected(alts) || (c === act && failed.has(n))) drop.add(n);
      return filterConfig(raw, drop);
    });
    this.guestConfig = act?.value ?? 0;
  }

  // -- Transfers --

  submit(t: UsbTransfer, done: (r: UsbResult) => void): void {
    if (this.dead) return;
    const td: Td = { tag: t.tag, length: t.length, done };
    if (t.ep === 0) {
      this.ctrl.add(td);
      this.control(t, td);
      return;
    }
    if (t.type === 'isoch') {
      // Isochronous transfers aren't passed through (docs/backlog.md "USB").
      const o = this.outOrder(t.ep);
      o.add(td);
      o.finish(td, { code: 'error', actual: 0 });
      return;
    }
    if (this.halted.has(t.ep)) {
      const o = t.ep & 0x80 ? this.inEp(t.ep).order : this.outOrder(t.ep);
      o.add(td);
      o.finish(td, { code: 'stall', actual: 0 });
      return;
    }
    if (t.ep & 0x80) {
      const e = this.inEp(t.ep);
      e.order.add(td);
      e.waiting.push(td);
      this.pump(t.ep, e);
    } else {
      const o = this.outOrder(t.ep);
      o.add(td);
      this.out(t, td, o);
    }
  }

  private inEp(ep: number): InEndpoint {
    let e = this.ins.get(ep);
    if (!e) { e = new InEndpoint(new Order()); this.ins.set(ep, e); }
    return e;
  }

  private outOrder(ep: number): Order {
    let o = this.outs.get(ep);
    if (!o) { o = new Order(); this.outs.set(ep, o); }
    return o;
  }

  /**
   * Starts a WebUSB call once the device-wide changes queued before it are done. Only its start is
   * ordered: transfers on different endpoints run side by side, and several on one endpoint queue in
   * WebUSB, which completes them in order.
   */
  private issue<T>(f: () => Promise<T>): Promise<T> {
    const started = this.chain.then(() => ({ p: f() }));
    this.chain = started.catch(() => {});
    return started.then((x) => x.p);
  }

  /** A device-wide change (configuration, alternate setting, halt, reset, close): what is issued after it waits for it to finish. */
  private serial<T>(f: () => Promise<T>): Promise<T> {
    const p = this.chain.then(f);
    this.chain = p.catch(() => {});
    return p;
  }

  private pump(ep: number, e: InEndpoint) {
    while (e.waiting.length && e.carry.length) {
      const td = e.waiting.shift()!;
      const c = e.carry[0];
      if (c.data.length > td.length && (c.code === 'success' || c.code === 'short')) {
        e.carry[0] = { data: c.data.subarray(td.length), code: c.code };
        e.order.finish(td, inResult(c.data.subarray(0, td.length), td.length));
      } else {
        e.carry.shift();
        e.order.finish(td, c.code === 'stall' || c.code === 'error' ? { code: c.code, actual: 0 } : inResult(c.data, td.length, c.code));
      }
    }
    while (e.inflight < e.waiting.length) {
      const length = e.waiting[e.inflight].length;
      e.inflight++;
      this.issue(() => this.dev.transferIn(ep & 0x0f, length)).then(
        (r) => this.arrived(ep, e, { data: bytesOf(r.data), code: statusCode(r.status) }),
        (err) => { this.lost(err); this.arrived(ep, e, { data: new Uint8Array(0), code: 'error' }); },
      );
    }
  }

  private arrived(ep: number, e: InEndpoint, c: Chunk) {
    if (this.dead || this.ins.get(ep) !== e) return;
    e.inflight--;
    if (e.waiting.length === 0) {
      // A cancelled TD's transfer: keep its data (and a stall, which a real endpoint would keep) for the next TD.
      if (c.code === 'error' || (c.data.length === 0 && c.code !== 'stall')) return;
    }
    e.carry.push(c);
    this.pump(ep, e);
  }

  private out(t: UsbTransfer, td: Td, o: Order) {
    const n = t.ep & 0x0f;
    const data = t.data ?? new Uint8Array(0);
    const gen = this.gen;
    // Linux's zero-length packet (URB_ZERO_PACKET) is a TD of its own: an empty transferOut here.
    const first = this.issue(() => this.dev.transferOut(n, data as Uint8Array<ArrayBuffer>));
    (async () => {
      let r: UsbResult;
      try {
        const a = await first;
        r = { code: statusCode(a.status), actual: a.bytesWritten };
      } catch (err) {
        this.lost(err);
        r = { code: 'error', actual: 0 };
      }
      if (!this.dead && gen === this.gen && this.outs.get(t.ep) === o) o.finish(td, r);
    })();
  }

  cancel(ep: number, tags: number[]): void {
    const set = new Set(tags);
    if (ep === 0) { this.ctrl.drop(set); return; }
    if (ep & 0x80) {
      const e = this.ins.get(ep);
      if (!e) return;
      e.order.drop(set);
      e.waiting = e.waiting.filter((t) => !set.has(t.tag));
    } else {
      this.outs.get(ep)?.drop(set);
    }
  }

  configured(endpoints: UsbEndpoint[]): void {
    const live = new Set(endpoints.map((e) => e.ep));
    for (const ep of [...this.ins.keys()]) if (!live.has(ep)) this.ins.delete(ep);
    for (const ep of [...this.outs.keys()]) if (!live.has(ep)) this.outs.delete(ep);
  }

  /** The controller's Reset Endpoint after a stall: the device side is cleared by the guest's CLEAR_FEATURE(HALT), which follows. */
  clearHalt(_ep: number): void {}

  reset(): void {
    if (this.dead) return;
    this.dropAll();
    this.serial(async () => {
      // The interfaces go first, and are claimed again after. A reset with them claimed leaves Chromium's claims
      // stale on Linux: it still says claimed, but releasing them fails, and so does claiming them in another
      // configuration (a guest's SET_CONFIGURATION after the reset), so the guest's first transfer found no endpoint.
      for (const n of this.claimed) await this.dev.releaseInterface(n).catch(() => {});
      this.claimed.clear();
      try {
        await this.dev.reset();
      } catch (err) {
        this.lost(err, true);
        return;
      }
      // The host keeps the device's configuration across the reset; the guest's SET_CONFIGURATION, if any, follows.
      await this.claimActive().catch(() => {});
    });
  }

  detach(): void {
    if (this.dead) return;
    this.dead = true;
    this.dropAll();
    const dev = this.dev;
    const held = [...this.claimed];
    this.serial(async () => {
      for (const n of held) await dev.releaseInterface(n).catch(() => {});
      await dev.close().catch(() => {});
    });
  }

  private dropAll() {
    this.gen++;
    this.halted.clear();
    this.ins.clear();
    this.outs.clear();
    this.ctrl = new Order();
  }

  /**
   * A call failed: the device is gone when WebUSB says it was disconnected (a NotFoundError that says so; WebUSB also
   * throws NotFoundError for an endpoint that isn't in a claimed interface, which is the transfer's error only).
   */
  private lost(err: unknown, always = false) {
    const e = err as Error | undefined;
    if ((always || (e?.name === 'NotFoundError' && /disconnected/i.test(e.message ?? ''))) && !this.goneCalled) {
      this.goneCalled = true;
      this.opts.gone?.();
    }
  }

  // -- Control --

  private control(t: UsbTransfer, td: Td) {
    const s = t.setup!;
    const ctrl = this.ctrl;
    const finish = (r: UsbResult) => { if (!this.dead && this.ctrl === ctrl) ctrl.finish(td, r); };
    const local = this.standard(s, t);
    if (local) {
      local.then(finish, (err) => { this.lost(err); finish({ code: 'error', actual: 0 }); });
      return;
    }
    const ws = webUsbSetup(s);
    if (!ws) { finish({ code: 'stall', actual: 0 }); return; }
    // An interface we don't hold (a filtered one) can't be reached: stall as a device without it would.
    if (ws.recipient === 'interface' && !this.claimed.has(s.index & 0xff)) { finish({ code: 'stall', actual: 0 }); return; }
    if (s.requestType & RT_IN) {
      this.issue(() => this.dev.controlTransferIn(ws, s.length)).then(
        (r) => finish(r.status === 'stall' ? { code: 'stall', actual: 0 } : inResult(bytesOf(r.data), s.length, statusCode(r.status))),
        (err) => { this.lost(err); finish({ code: 'error', actual: 0 }); },
      );
    } else {
      const data = (t.data ?? new Uint8Array(0)).subarray(0, s.length);
      this.issue(() => this.dev.controlTransferOut(ws, data as Uint8Array<ArrayBuffer>)).then(
        (r) => finish({ code: statusCode(r.status), actual: r.status === 'ok' ? r.bytesWritten : 0 }),
        (err) => { this.lost(err); finish({ code: 'error', actual: 0 }); },
      );
    }
  }

  /** The standard requests the backend answers or interprets itself (docs/usb.md "The WebUSB passthrough"'s table); null passes it through. */
  private standard(s: Setup, t: UsbTransfer): Promise<UsbResult> | null {
    if (((s.requestType >> 5) & 3) !== 0) return null;
    const recipient = s.requestType & 0x1f;
    const ok = (): Promise<UsbResult> => Promise.resolve({ code: 'success', actual: 0 });
    const reply = (b: Uint8Array): Promise<UsbResult> => Promise.resolve(inResult(b, s.length));
    switch (s.request) {
      case REQ_GET_DESCRIPTOR: {
        if (recipient !== 0) return null;
        const type = s.value >> 8, index = s.value & 0xff;
        if (type === DT_DEVICE) return reply(this.deviceDesc);
        if (type === DT_CONFIG) return index < this.served.length ? reply(this.served[index]) : Promise.resolve({ code: 'stall', actual: 0 });
        if (type === DT_BOS) return this.bos ? reply(this.bos) : Promise.resolve({ code: 'stall', actual: 0 });
        if (type === DT_STRING) {
          const c = this.strings.get(index === 0 ? '0:0' : `${index}:${s.index}`);
          return c ? reply(c) : null;
        }
        return null;
      }
      case REQ_SET_CONFIGURATION:
        return this.serial(() => this.setConfiguration(s.value & 0xff));
      case REQ_GET_CONFIGURATION:
        return this.guestConfig === 0 ? reply(new Uint8Array([0])) : null;
      case REQ_SET_INTERFACE:
        return this.serial(() => this.setInterface(s.index & 0xff, s.value & 0xff));
      case REQ_GET_INTERFACE:
        return this.claimed.has(s.index & 0xff) ? null : Promise.resolve({ code: 'stall', actual: 0 });
      case REQ_CLEAR_FEATURE:
        if (recipient === 2 && s.value === FEATURE_ENDPOINT_HALT) {
          const ep = s.index & 0xff;
          if ((ep & 0x7f) === 0) return ok(); // the default pipe never halts (and isn't WebUSB's to clear)
          this.halted.delete(ep);
          // The guest knows the endpoint stalled: a stall carried over from a cancelled TD is spent.
          const e = this.ins.get(ep);
          if (e) e.carry = e.carry.filter((c) => c.code !== 'stall');
          return this.serial(async (): Promise<UsbResult> => {
            await this.dev.clearHalt(ep & 0x80 ? 'in' : 'out', ep & 0x0f);
            return { code: 'success', actual: 0 };
          });
        }
        return ok();
      case REQ_SET_FEATURE:
        // ENDPOINT_HALT is ours (see `halted`); the rest (remote wakeup, U1/U2, LTM) is the controller's to hide.
        if (recipient === 2 && s.value === FEATURE_ENDPOINT_HALT && (s.index & 0x7f) !== 0) this.halted.add(s.index & 0xff);
        return ok();
      case REQ_SET_SEL:
      case REQ_SET_ISOCH_DELAY:
        return ok();
      case REQ_GET_STATUS:
        // An endpoint's: halted by us, or endpoint 0 (WebUSB names only a claimed interface's endpoints); the rest pass through.
        if (recipient === 2 && ((s.index & 0x7f) === 0 || this.halted.has(s.index & 0xff))) return reply(Uint8Array.of(this.halted.has(s.index & 0xff) ? 1 : 0, 0));
        return null;
      default:
        void t;
        return null;
    }
  }

  private async setConfiguration(value: number): Promise<UsbResult> {
    if (value === 0) {
      for (const n of this.claimed) await this.dev.releaseInterface(n).catch(() => {});
      this.claimed.clear();
      this.guestConfig = 0;
      return { code: 'success', actual: 0 };
    }
    if (!this.configs.some((c) => c.value === value)) return { code: 'stall', actual: 0 };
    this.halted.clear();
    this.ins.clear();
    this.outs.clear();
    if (this.dev.configuration?.configurationValue !== value) {
      for (const n of this.claimed) await this.dev.releaseInterface(n).catch(() => {});
      this.claimed.clear();
      await this.dev.selectConfiguration(value);
    } else {
      // The same configuration again (every enumeration sends it): alternates go back to 0, as SET_CONFIGURATION does.
      for (const [n, alt] of this.alternates) if (alt !== 0) await this.dev.selectAlternateInterface(n, 0).catch(() => {});
    }
    await this.claimActive();
    return { code: 'success', actual: 0 };
  }

  private async setInterface(n: number, alt: number): Promise<UsbResult> {
    if (!this.claimed.has(n)) return { code: 'stall', actual: 0 };
    const act = this.active();
    const alts = act?.interfaces.get(n) ?? [];
    if (!alts.some((a) => a.alternate === alt)) return { code: 'stall', actual: 0 };
    for (const a of alts) for (const e of a.endpoints) {
      this.halted.delete(e.address);
      if (e.address & 0x80) this.ins.delete(e.address);
      else this.outs.delete(e.address);
    }
    await this.dev.selectAlternateInterface(n, alt);
    this.alternates.set(n, alt);
    return { code: 'success', actual: 0 };
  }
}

// ---- The opener ----------------------------------------------------------------------------------

/** The device `getDevices()` lists for an identity: vendor, product and serial, `index` among identical serial-less ones. */
export function pickDevice<D extends { vendorId: number; productId: number; serialNumber?: string | null }>(devices: readonly D[], id: UsbIdentity): D | undefined {
  const same = devices.filter((d) => d.vendorId === id.vendorId && d.productId === id.productId && (id.serialNumber ? d.serialNumber === id.serialNumber : !d.serialNumber));
  return same[id.serialNumber ? 0 : (id.index ?? 0)];
}

/**
 * The device worker's opener for `api: 'usb'` identities: finds the granted device, opens it, and
 * calls `gone` when WebUSB reports it disconnected (or a transfer finds it gone).
 */
export function webUsbOpener(usb: WebUsbLike) {
  return async (id: UsbIdentity, ctx: { gone?: () => void } = {}): Promise<WebUsbPassthrough> => {
    const dev = pickDevice(await usb.getDevices(), id);
    if (!dev) throw notFound();
    let p: WebUsbPassthrough | null = null;
    const onDisconnect = (e: { device: WebUsbDeviceLike }) => {
      if (e.device !== dev) return;
      usb.removeEventListener('disconnect', onDisconnect);
      gone();
    };
    let fired = false;
    const gone = () => { if (!fired) { fired = true; usb.removeEventListener('disconnect', onDisconnect); ctx.gone?.(); } };
    usb.addEventListener('disconnect', onDisconnect);
    try {
      p = await openWebUsb(dev, { gone });
    } catch (e) {
      usb.removeEventListener('disconnect', onDisconnect);
      throw e;
    }
    return p;
  };
}
