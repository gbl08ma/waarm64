// A virtual USB device's chapter 9 (USB 2.0 §9.4): the base the device worker's own devices are built
// on (Gadget Zero, web/usb-gadget-zero.ts; the WebHID device). docs/usb.md "Virtual devices".
//
// A subclass gives the descriptors and implements only what is its own:
//
//   class Thing extends VirtualDevice {
//     constructor() { super('high', { device, configs: [config], strings: ['Maker', 'Thing'] }); }
//     // Class and vendor requests on the default pipe: IN data, true (OUT accepted), or undefined (stall).
//     protected control(setup: Setup, data?: Uint8Array) { return setup.request === 0x01 ? new Uint8Array([1]) : undefined; }
//     // Bulk, interrupt and isochronous TDs of the active configuration's endpoints.
//     protected transfer(t: UsbTransfer, done: (r: UsbResult) => void) { done({ code: 'success', actual: t.data?.length ?? 0 }); }
//   }
//
// The base answers the standard requests from the descriptors, keeps the configuration, each
// interface's alternate setting and the endpoints' halts (SET_FEATURE(ENDPOINT_HALT), or `halt` from
// the subclass: a TD to a halted endpoint stalls until CLEAR_FEATURE), refuses TDs to endpoints the
// active configuration doesn't have (a transaction error, as no device answers there), and queues
// default-pipe requests so that a subclass's asynchronous answer (a promise) keeps them in order.

import type { Setup, UsbDevice, UsbEndpoint, UsbResult, UsbSpeed, UsbTransfer } from './usb-device.ts';

/** What a virtual device is, as descriptors (all in the wire format, little-endian). */
export type Descriptors = {
  /** The device descriptor (18 bytes). */
  device: Uint8Array;
  /** Each configuration descriptor with its interfaces, endpoints and class descriptors (wTotalLength bytes), for the device's speed. */
  configs: Uint8Array[];
  /** A high-speed device's device qualifier (10 bytes); without it GET_DESCRIPTOR(DEVICE_QUALIFIER) stalls, as a full-speed-only device's does. */
  qualifier?: Uint8Array;
  /** The configurations at the other speed, served as OTHER_SPEED_CONFIGURATION (their type byte is rewritten). */
  otherSpeed?: Uint8Array[];
  /** The BOS descriptor with its capabilities (bcdUSB ≥ 2.01); without it GET_DESCRIPTOR(BOS) stalls. */
  bos?: Uint8Array;
  /** String descriptor i (i ≥ 1) is `strings[i - 1]`; string 0 lists US English (0x0409). */
  strings?: string[];
  /** Other descriptors by type and index (a HID's class and report descriptors), for any recipient; undefined stalls. */
  extra?: (type: number, index: number, setup: Setup) => Uint8Array | undefined;
};

type Endpoint = { ep: number; type: 'control' | 'isoch' | 'bulk' | 'interrupt'; maxPacket: number; interval: number };
type Alt = { alt: number; endpoints: Endpoint[] };
type Config = { value: number; attributes: number; interfaces: Map<number, Alt[]> };

const TYPES = ['control', 'isoch', 'bulk', 'interrupt'] as const;

/** The configurations a configuration descriptor describes: interfaces by number, their alternate settings and endpoints. */
export function parseConfig(d: Uint8Array): Config {
  const c: Config = { value: d[5], attributes: d[7], interfaces: new Map() };
  let alt: Alt | undefined;
  const total = Math.min(d.length, d[2] | d[3] << 8);
  for (let at = 0; at + 2 <= total && d[at] >= 2;) {
    const [len, type] = [d[at], d[at + 1]];
    if (type === 4 && len >= 9) {
      alt = { alt: d[at + 3], endpoints: [] };
      const list = c.interfaces.get(d[at + 2]) ?? [];
      list.push(alt);
      c.interfaces.set(d[at + 2], list);
    } else if (type === 5 && len >= 7 && alt) {
      alt.endpoints.push({ ep: d[at + 2], type: TYPES[d[at + 3] & 3], maxPacket: (d[at + 4] | d[at + 5] << 8) & 0x7ff, interval: d[at + 6] });
    }
    at += len;
  }
  return c;
}

/** A string descriptor: UTF-16LE, at most 126 code units. */
export function stringDescriptor(s: string): Uint8Array {
  const units = Array.from({ length: Math.min(s.length, 126) }, (_, i) => s.charCodeAt(i));
  const d = new Uint8Array(2 + 2 * units.length);
  d[0] = d.length;
  d[1] = 3;
  units.forEach((u, i) => { d[2 + 2 * i] = u & 0xff; d[3 + 2 * i] = u >> 8; });
  return d;
}

/** What a subclass's `control` gives back: IN data, true (an OUT, or an IN with no data, accepted), undefined (stall); or a promise of one. */
export type ControlAnswer = Uint8Array | boolean | undefined;

const STALL: UsbResult = { code: 'stall', actual: 0 };
const UNKNOWN = Symbol('unknown');

/** The device side of chapter 9 for a device of ours; subclasses add the class or vendor part (see the top of this file). */
export abstract class VirtualDevice implements UsbDevice {
  readonly speed: UsbSpeed;
  protected readonly descriptors: Descriptors;
  private readonly configs: Config[];
  /** The bConfigurationValue set (0: unconfigured, the address state). */
  protected configuration = 0;
  /** Each interface's alternate setting in the active configuration. */
  protected alts = new Map<number, number>();
  private halted = new Set<number>();
  private remoteWakeup = false;
  /** Default-pipe requests not answered yet, oldest first (only an asynchronous answer leaves one waiting). */
  private ep0: { t: UsbTransfer; done: (r: UsbResult) => void; live: boolean }[] = [];
  protected gone = false;

  constructor(speed: UsbSpeed, descriptors: Descriptors) {
    this.speed = speed;
    this.descriptors = descriptors;
    this.configs = descriptors.configs.map(parseConfig);
  }

  /** Class and vendor requests on the default pipe (and standard ones the base doesn't know); undefined stalls. */
  protected control(_setup: Setup, _data?: Uint8Array): ControlAnswer | Promise<ControlAnswer> {
    return undefined;
  }

  /** A TD to an endpoint of the active configuration that isn't halted. */
  protected transfer(_t: UsbTransfer, done: (r: UsbResult) => void): void {
    done({ code: 'error', actual: 0 });
  }

  /** The guest stopped these TDs (their `done` is dropped by the glue: a subclass that holds TDs forgets them). */
  protected cancelled(_ep: number, _tags: number[]): void {}

  /** SET_CONFIGURATION or SET_INTERFACE changed what is active (also a reset, to unconfigured). */
  protected changed(): void {}

  /** CLEAR_FEATURE(ENDPOINT_HALT) on `ep`, halted or not (the data toggle's reset, for a device that keeps a stream position). */
  protected cleared(_ep: number): void {}

  /** Halts `ep` (a functional stall): its TDs stall until the guest clears it. */
  protected halt(ep: number) {
    this.halted.add(ep);
  }

  protected isHalted(ep: number) {
    return this.halted.has(ep);
  }

  /** The active configuration's endpoint `ep` (in the interfaces' current alternate settings), if it has one. */
  protected endpoint(ep: number): Endpoint | undefined {
    const c = this.active();
    if (!c) return undefined;
    for (const [n, alts] of c.interfaces) {
      const a = alts.find((x) => x.alt === (this.alts.get(n) ?? 0));
      const e = a?.endpoints.find((x) => x.ep === ep);
      if (e) return e;
    }
    return undefined;
  }

  private active() {
    return this.configs.find((c) => c.value === this.configuration && c.value !== 0);
  }

  submit(t: UsbTransfer, done: (r: UsbResult) => void): void {
    if (this.gone) return;
    if (t.ep === 0) {
      const entry = { t, done, live: true };
      this.ep0.push(entry);
      if (this.ep0.length === 1) this.runEp0();
      return;
    }
    if (!this.endpoint(t.ep)) return done({ code: 'error', actual: 0 });
    if (this.halted.has(t.ep)) return done(STALL);
    this.transfer(t, done);
  }

  /** Answers default-pipe requests in order until one waits on a promise. */
  private runEp0() {
    while (this.ep0.length) {
      const head = this.ep0[0];
      const r = this.setup(head.t);
      if (r instanceof Promise) {
        r.then((x) => this.finishEp0(head, x), () => this.finishEp0(head, STALL));
        return;
      }
      this.ep0.shift();
      if (head.live) head.done(r);
    }
  }

  private finishEp0(head: { t: UsbTransfer; done: (r: UsbResult) => void; live: boolean }, r: UsbResult) {
    if (this.ep0[0] !== head || this.gone) return;
    this.ep0.shift();
    if (head.live) head.done(r);
    this.runEp0();
  }

  /** One request on the default pipe: a standard one here, the rest from `control`. */
  private setup(t: UsbTransfer): UsbResult | Promise<UsbResult> {
    const s = t.setup;
    if (!s) return STALL;
    const into = s.requestType & 0x80 ? s.length : 0;
    const answer = (a: ControlAnswer): UsbResult => {
      if (a === undefined || a === false) return STALL;
      if (a === true) return { code: 'success', actual: into ? 0 : t.data?.length ?? 0 };
      const data = a.subarray(0, into);
      return { code: data.length < into ? 'short' : 'success', actual: data.length, data };
    };
    const std = (s.requestType & 0x60) === 0 ? this.standard(s) : UNKNOWN;
    if (std !== UNKNOWN) return answer(std);
    const a = this.control(s, t.data);
    return a instanceof Promise ? a.then(answer) : answer(a);
  }

  /** A standard request, or UNKNOWN for `control` (SET_DESCRIPTOR, SYNCH_FRAME, anything new). */
  private standard(s: Setup): ControlAnswer | typeof UNKNOWN {
    const recipient = s.requestType & 0x1f;
    const c = this.active();
    switch (s.request) {
      case 0: { // GET_STATUS
        if (recipient === 0) return new Uint8Array([(this.selfPowered() ? 1 : 0) | (this.remoteWakeup ? 2 : 0), 0]);
        if (recipient === 1) return c?.interfaces.has(s.index & 0xff) ? new Uint8Array(2) : undefined;
        if (recipient === 2) return (s.index & 0x7f) === 0 || this.endpoint(s.index & 0xff) ? new Uint8Array([this.halted.has(s.index & 0xff) ? 1 : 0, 0]) : undefined;
        return undefined;
      }
      case 1: case 3: { // CLEAR_FEATURE, SET_FEATURE
        const set = s.request === 3;
        if (recipient === 0) {
          if (s.value === 1) this.remoteWakeup = set; // DEVICE_REMOTE_WAKEUP; TEST_MODE, U1/U2_ENABLE, LTM: accepted
          return true;
        }
        if (recipient === 1) return c?.interfaces.has(s.index & 0xff) ? true : undefined; // FUNCTION_SUSPEND
        if (recipient === 2 && s.value === 0) { // ENDPOINT_HALT
          const ep = s.index & 0xff;
          if ((ep & 0x7f) === 0) return true; // the default pipe never halts
          if (!this.endpoint(ep)) return undefined;
          if (set) this.halted.add(ep);
          else {
            this.halted.delete(ep);
            this.cleared(ep);
          }
          return true;
        }
        return undefined;
      }
      case 5: return true; // SET_ADDRESS: the controller's (Address Device); accepted if it ever comes
      case 6: return this.descriptor(s); // GET_DESCRIPTOR
      case 8: return new Uint8Array([this.configuration]); // GET_CONFIGURATION
      case 9: { // SET_CONFIGURATION
        const v = s.value & 0xff;
        if (v !== 0 && !this.configs.some((x) => x.value === v)) return undefined;
        this.configuration = v;
        this.alts.clear();
        this.halted.clear();
        this.changed();
        return true;
      }
      case 10: { // GET_INTERFACE
        if (!c?.interfaces.has(s.index & 0xff)) return undefined;
        return new Uint8Array([this.alts.get(s.index & 0xff) ?? 0]);
      }
      case 11: { // SET_INTERFACE
        const alts = c?.interfaces.get(s.index & 0xff);
        if (!alts?.some((a) => a.alt === s.value)) return undefined;
        this.alts.set(s.index & 0xff, s.value);
        for (const a of alts) for (const e of a.endpoints) this.halted.delete(e.ep);
        this.changed();
        return true;
      }
      case 48: case 49: return true; // SET_SEL, SET_ISOCH_DELAY
      default: return UNKNOWN;
    }
  }

  private selfPowered() {
    const c = this.active() ?? this.configs[0];
    return !!c && (c.attributes & 0x40) !== 0;
  }

  private descriptor(s: Setup): ControlAnswer {
    const [type, index] = [s.value >> 8, s.value & 0xff];
    const d = this.descriptors;
    if ((s.requestType & 0x1f) === 0) {
      switch (type) {
        case 1: return d.device;
        case 2: return d.configs[index];
        case 3: {
          if (index === 0) return new Uint8Array([4, 3, 0x09, 0x04]);
          const str = d.strings?.[index - 1];
          return str === undefined ? undefined : stringDescriptor(str);
        }
        case 6: return d.qualifier;
        case 7: {
          const o = d.otherSpeed?.[index];
          if (!o) return undefined;
          const copy = o.slice();
          copy[1] = 7;
          return copy;
        }
        case 15: return d.bos;
        case 4: case 5: return undefined; // never by themselves (chapter 9)
      }
    }
    return d.extra?.(type, index, s);
  }

  cancel(ep: number, tags: number[]): void {
    if (ep === 0) {
      for (const e of this.ep0) if (tags.includes(e.t.tag)) e.live = false;
      return;
    }
    this.cancelled(ep, tags);
  }

  configured(_endpoints: UsbEndpoint[]): void {}

  reset(): void {
    this.configuration = 0;
    this.alts.clear();
    this.halted.clear();
    this.remoteWakeup = false;
    for (const e of this.ep0) e.live = false;
    this.ep0 = [];
    this.changed();
  }

  detach(): void {
    this.gone = true;
    this.ep0 = [];
  }
}
