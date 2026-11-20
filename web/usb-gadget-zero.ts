// Gadget Zero (0525:a4a0), the device Linux's usbtest and testusb test a host controller with
// (docs/usb.md "Virtual devices"): as Linux's g_zero (f_sourcesink and f_loopback), from their
// behavior, with a native twin in core/tests/common/usb.rs that gives the guest the same bytes.
//
// - Configuration 3, source/sink (the first, so the one Linux chooses): bulk IN 0x81 sends the
//   pattern, bulk OUT 0x01 takes data and checks it (a wrong byte halts the endpoint: a stall); the
//   vendor requests 0x5b (write up to 4 KiB) and 0x5c (read it back) on the default pipe, which
//   usbtest's control-write tests use.
// - Configuration 2, loopback: what bulk OUT takes, bulk IN gives back, in order, one TD's worth
//   for each OUT TD, up to 32 buffers (then OUT waits, as a device NAKs); an IN with nothing to
//   give waits for the next OUT.
// The pattern is per packet, as usbtest checks it: byte i of a TD is 0 (pattern 0) or (i % maxpacket) % 63
// (pattern 1). No isochronous alternate setting and no interrupt endpoints (f_sourcesink has none now).

import type { UsbResult, UsbSpeed, UsbTransfer } from './usb-device.ts';
import { VirtualDevice, type ControlAnswer } from './usb-virtual.ts';
import type { Setup } from './usb-device.ts';

export const GZ_VENDOR = 0x0525;
export const GZ_PRODUCT = 0xa4a0;
const SOURCE_SINK = 3;
const LOOPBACK = 2;
const QLEN = 32;
const BUFLEN = 4096;

export type GadgetZeroOptions = { speed?: UsbSpeed; pattern?: 0 | 1; serial?: string };

const u16 = (v: number) => [v & 0xff, v >> 8];

/** The configuration descriptor `value` (3 source/sink, 2 loopback) for bulk packets of `maxp` bytes. */
function config(value: number, maxp: number, superSpeed: boolean): Uint8Array {
  const companion = superSpeed ? [6, 0x30, 0, 0, 0, 0] : [];
  const ep = (addr: number) => [7, 5, addr, 2, ...u16(maxp), 0, ...companion];
  const body = [9, 4, 0, 0, 2, 0xff, 0, 0, value === SOURCE_SINK ? 4 : 5, ...ep(0x81), ...ep(0x01)];
  const total = 9 + body.length;
  return new Uint8Array([9, 2, ...u16(total), 1, value, value === SOURCE_SINK ? 4 : 5, 0xc0, 1, ...body]);
}

/** Gadget Zero's descriptors at `speed`, as the native twin builds them. */
export function gadgetZeroDescriptors(speed: UsbSpeed, serial: string) {
  if (speed === 'low') throw new Error('Gadget Zero has bulk endpoints: not at low speed');
  const ss = speed === 'super';
  const maxp = ss ? 1024 : speed === 'high' ? 512 : 64;
  const device = new Uint8Array([
    18,
    1,
    ...u16(ss ? 0x0320 : 0x0200),
    0xff,
    0,
    0,
    ss ? 9 : 64,
    ...u16(GZ_VENDOR),
    ...u16(GZ_PRODUCT),
    ...u16(0x0100),
    1,
    2,
    3,
    2,
  ]);
  const configs = [config(SOURCE_SINK, maxp, ss), config(LOOPBACK, maxp, ss)];
  const strings = ['waarm64', 'Gadget Zero', serial, 'source and sink data', 'loop input to output'];
  if (speed === 'high') {
    // High speed: the qualifier, and the full-speed configurations as the other speed's.
    const qualifier = new Uint8Array([10, 6, ...u16(0x0200), 0xff, 0, 0, 64, 2, 0]);
    return {
      maxp,
      d: {
        device,
        configs,
        qualifier,
        otherSpeed: [config(SOURCE_SINK, 64, false), config(LOOPBACK, 64, false)],
        strings,
      },
    };
  }
  if (ss) {
    // USB 2.0 extension (no LPM) and the SuperSpeed capability (full, high and super speed; U1/U2 exit latencies).
    const bos = new Uint8Array([
      5,
      15,
      ...u16(22),
      2,
      7,
      16,
      2,
      0,
      0,
      0,
      0,
      10,
      16,
      3,
      0,
      ...u16(0x000e),
      1,
      10,
      ...u16(0x07ff),
    ]);
    return { maxp, d: { device, configs, bos, strings } };
  }
  return { maxp, d: { device, configs, strings } };
}

type Held = { t: UsbTransfer; done: (r: UsbResult) => void };

export class GadgetZero extends VirtualDevice {
  private readonly maxp: number;
  private readonly pattern: 0 | 1;
  /** What 0x5b wrote (0x5c reads it). */
  private ep0buf = new Uint8Array(BUFLEN);
  /** Loopback: OUT TDs' data waiting for IN, and the TDs that wait for the other side. */
  private queue: Uint8Array[] = [];
  private waitingIn: Held[] = [];
  private waitingOut: Held[] = [];

  constructor({ speed = 'high', pattern = 0, serial = '0123456789' }: GadgetZeroOptions = {}) {
    const { maxp, d } = gadgetZeroDescriptors(speed, serial);
    super(speed, d);
    this.maxp = maxp;
    this.pattern = pattern;
  }

  /** The pattern's byte `i` of a TD. */
  private byte(i: number) {
    return this.pattern === 0 ? 0 : (i % this.maxp) % 63;
  }

  protected control(s: Setup, data?: Uint8Array): ControlAnswer {
    if (
      this.configuration !== SOURCE_SINK ||
      (s.requestType & 0x60) !== 0x40 ||
      s.value !== 0 ||
      s.index !== 0 ||
      s.length > BUFLEN
    )
      return undefined;
    if (s.request === 0x5b && (s.requestType & 0x80) === 0) {
      this.ep0buf.set(data ?? new Uint8Array(0));
      return true;
    }
    if (s.request === 0x5c && (s.requestType & 0x80) !== 0) return this.ep0buf.slice(0, s.length);
    return undefined;
  }

  protected transfer(t: UsbTransfer, done: (r: UsbResult) => void) {
    if (t.type !== 'bulk') return done({ code: 'error', actual: 0 });
    if (this.configuration === SOURCE_SINK) {
      if (t.ep & 0x80) {
        const data = new Uint8Array(t.length);
        if (this.pattern) for (let i = 0; i < data.length; i++) data[i] = this.byte(i);
        return done({ code: 'success', actual: t.length, data });
      }
      const d = t.data ?? new Uint8Array(0);
      for (let i = 0; i < d.length; i++) {
        if (d[i] !== this.byte(i)) {
          this.halt(t.ep);
          return done({ code: 'stall', actual: 0 });
        }
      }
      return done({ code: 'success', actual: d.length });
    }
    // Loopback.
    if (t.ep & 0x80) this.waitingIn.push({ t, done });
    else this.waitingOut.push({ t, done });
    this.loop();
  }

  /** Moves loopback data while both sides can. */
  private loop() {
    for (let moved = true; moved;) {
      moved = false;
      if (this.waitingOut.length && this.queue.length < QLEN) {
        const o = this.waitingOut.shift()!;
        const d = o.t.data ?? new Uint8Array(0);
        this.queue.push(d.slice());
        o.done({ code: 'success', actual: d.length });
        moved = true;
      }
      if (this.waitingIn.length && this.queue.length) {
        const i = this.waitingIn.shift()!;
        const d = this.queue.shift()!.subarray(0, i.t.length);
        i.done({ code: d.length < i.t.length ? 'short' : 'success', actual: d.length, data: d });
        moved = true;
      }
    }
  }

  protected cancelled(ep: number, tags: number[]) {
    const keep = (h: Held) => !(h.t.ep === ep && tags.includes(h.t.tag));
    this.waitingIn = this.waitingIn.filter(keep);
    this.waitingOut = this.waitingOut.filter(keep);
  }

  protected changed() {
    this.queue = [];
    this.waitingIn = [];
    this.waitingOut = [];
  }

  detach() {
    super.detach();
    this.changed();
  }
}
