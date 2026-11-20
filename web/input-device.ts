// virtio-input's backend (docs/devices.md): a keyboard, a tablet, a mouse or a touchscreen, its config space and its
// events.
import { busy } from './gpu.ts';
import { gather, scatter, type Backend, type Ctx, type Request } from './virtio.ts';
import type { InputSpec } from './devices.ts';

// virtio-input config selectors (virtio 1.2 §5.8.2) and the event types we use.
const CFG_ID_NAME = 1;
const CFG_ID_DEVIDS = 3;
const CFG_PROP_BITS = 0x10;
const CFG_EV_BITS = 0x11;
const CFG_ABS_INFO = 0x12;
const EV_KEY = 1;
const EV_REL = 2;
const EV_ABS = 3;
const EV_LED = 0x11;
const EV_REP = 0x14;
const INPUT_PROP_DIRECT = 1;
const ABS_MT_SLOT = 0x2f,
  ABS_MT_POSITION_X = 0x35,
  ABS_MT_POSITION_Y = 0x36,
  ABS_MT_TRACKING_ID = 0x39;
/** The touchscreen's slots (fingers at once). */
export const TOUCH_SLOTS = 10;
/** BTN_LEFT, RIGHT, MIDDLE, SIDE, EXTRA (a mouse's back and forward). */
const POINTER_BUTTONS = [0x110, 0x111, 0x112, 0x113, 0x114];

/** A bitmap with `bits` set, as the config space carries it. */
function bitmap(bits: number[]) {
  const b = new Uint8Array((Math.max(...bits) >> 3) + 1);
  for (const k of bits) b[k >> 3] |= 1 << (k & 7);
  return b;
}

/** An axis's range as ABS_INFO carries it: min, max, fuzz, flat, res. */
const absInfo = (min: number, max: number) => new Uint8Array(new Int32Array([min, max, 0, 0, 0]).buffer);

/** What each kind is called and its product id (BUS_VIRTUAL, vendor 0). */
const INPUT_IDS = {
  keyboard: ['waarm64 keyboard', 1],
  tablet: ['waarm64 tablet', 2],
  mouse: ['waarm64 mouse', 3],
  touch: ['waarm64 touchscreen', 4],
} as const;

/** The answer to a config query (select, subsel) about an input device of `kind`. */
export function inputConfig(kind: InputSpec['kind'], select: number, subsel: number): Uint8Array {
  const none = new Uint8Array(0);
  switch (select) {
    case CFG_ID_NAME:
      return new TextEncoder().encode(INPUT_IDS[kind][0]);
    case CFG_ID_DEVIDS:
      return new Uint8Array(new Uint16Array([6, 0, INPUT_IDS[kind][1], 1]).buffer); // BUS_VIRTUAL, vendor, product, version
    case CFG_PROP_BITS:
      return kind === 'touch' && subsel === 0 ? bitmap([INPUT_PROP_DIRECT]) : none;
    case CFG_EV_BITS:
      switch (kind) {
        case 'keyboard':
          if (subsel === EV_KEY) return bitmap(Array.from({ length: 248 }, (_, k) => k + 1)); // KEY_ESC to KEY_MICMUTE
          if (subsel === EV_LED) return bitmap([0, 1, 2]); // Num, Caps, Scroll Lock
          if (subsel === EV_REP) return new Uint8Array(1); // autorepeat (the kernel's)
          return none;
        case 'tablet':
          if (subsel === EV_KEY) return bitmap(POINTER_BUTTONS);
          if (subsel === EV_REL) return bitmap([6, 8, 11, 12]); // REL_HWHEEL, REL_WHEEL, REL_WHEEL_HI_RES, REL_HWHEEL_HI_RES
          if (subsel === EV_ABS) return bitmap([0, 1]); // ABS_X, ABS_Y
          return none;
        case 'mouse':
          if (subsel === EV_KEY) return bitmap(POINTER_BUTTONS);
          if (subsel === EV_REL) return bitmap([0, 1, 6, 8, 11, 12]); // REL_X, REL_Y and the tablet's wheels
          return none;
        case 'touch':
          if (subsel === EV_KEY) return bitmap([0x14a]); // BTN_TOUCH
          if (subsel === EV_ABS)
            return bitmap([0, 1, ABS_MT_SLOT, ABS_MT_POSITION_X, ABS_MT_POSITION_Y, ABS_MT_TRACKING_ID]);
          return none;
      }
      return none;
    case CFG_ABS_INFO:
      if ((kind === 'tablet' || kind === 'touch') && subsel <= 1) return absInfo(0, 32767);
      if (kind !== 'touch') return none;
      if (subsel === ABS_MT_POSITION_X || subsel === ABS_MT_POSITION_Y) return absInfo(0, 32767);
      if (subsel === ABS_MT_SLOT) return absInfo(0, TOUCH_SLOTS - 1);
      if (subsel === ABS_MT_TRACKING_ID) return absInfo(0, 65535);
      return none;
    default:
      return none;
  }
}

const INPUT_QUEUE = 1024; // events held while the guest has posted no event buffer

/**
 * Trims queued virtio-input events to at most `max` by dropping the oldest whole frames (through a SYN_REPORT), so the
 * guest never gets a frame without its head; a frame cut with no SYN_REPORT after the cut goes whole.
 */
export function trimInput(events: number[][], max = INPUT_QUEUE): void {
  const excess = events.length - max;
  if (excess <= 0) return;
  let end = events.findIndex((e, i) => i >= excess - 1 && e[0] === 0 && e[1] === 0);
  if (end < 0) end = events.length - 1;
  events.splice(0, end + 1);
}

/**
 * virtio-input: events from `port` fill the guest's event buffers, 8 bytes
 * each (type u16, code u16, value s32), the oldest frames dropped past INPUT_QUEUE (`trimInput`);
 * status events from the guest go to `port`.
 */
export function input(ctx: Ctx, d: InputSpec): Backend {
  const bufs: Request[] = [];
  const events: number[][] = [];
  const deliver = () => {
    while (bufs.length && events.length) {
      const r = bufs.shift()!;
      const b = new DataView(new ArrayBuffer(8));
      const [type, code, value] = events.shift()!;
      b.setUint16(0, type, true);
      b.setUint16(2, code, true);
      b.setInt32(4, value, true);
      scatter(ctx.ram(), r.write, new Uint8Array(b.buffer));
      ctx.complete(r.w0, 8);
    }
  };
  const inject = (e: number[][]) => {
    if (e.some((x) => x[0] === 1)) busy.events?.push(performance.timeOrigin + performance.now(), 1);
    events.push(...e);
    trimInput(events);
    deliver();
  };
  if (d.port) d.port.onmessage = (e: MessageEvent) => inject(e.data);
  return {
    request(r) {
      if (r.queue === 0) {
        bufs.push(r);
        deliver();
        return undefined;
      }
      const b = new DataView(gather(ctx.ram(), r.read, 8).slice().buffer);
      if (b.byteLength === 8) {
        d.port?.postMessage([b.getUint16(0, true), b.getUint16(2, true), b.getInt32(4, true)]);
      }
      return 0;
    },
    config() {
      const c = ctx.config();
      const a = inputConfig(d.kind, c[0], c[1]).subarray(0, 128);
      c[2] = a.length;
      c.fill(0, 8, 136);
      c.set(a, 8);
    },
    reset() {
      bufs.length = 0;
      events.length = 0;
    },
    close: () => d.port?.close(),
  };
}
