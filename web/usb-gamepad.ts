// The game pad of ours (docs/usb.md "The game pad"): an emulated wired Xbox 360 controller fed from the page's Gamepad
// API, for a host's game pad that neither WebUSB nor WebHID can reach (a wired Xbox controller the host's driver keeps,
// any pad the browser only offers as a `Gamepad`). The page polls `navigator.getGamepads()` (Window only) and sends
// each change of the pad's state as a `usb-pad` message; the guest's rumble comes back as `usb-rumble`.
//
// Why an Xbox 360 controller and not a HID game pad of our own: what a guest's software makes of a pad goes by its
// vendor and product. A HID pad with IDs of ours gets the right evdev codes from hid-generic, but Chromium in the guest
// then gives it no standard mapping (its mappings and its XInput list are by ID, or by the xpad driver), so a web page
// there sees joydev's raw order: the triggers where the right stick should be, the D-pad nowhere. The wired Xbox 360
// controller (045e:028e) is the pad every guest knows: Linux's xpad drives it (BTN_A…BTN_THUMBR, the D-pad as
// ABS_HAT0X/Y, the sticks as X/Y/RX/RY, the triggers as Z/RZ: Documentation/input/gamepad.rst), Chromium and Firefox
// map it to the standard layout, SDL and Steam have it in their databases, and xpad's force feedback gives rumble.
//
// What the guest sees: a full-speed vendor-class device (interface ff/5d/01, as xpad matches it) with interrupt IN
// 0x81 (the 20-byte input report) and interrupt OUT 0x02 (the host's LED and rumble commands). The input report:
// - byte 0 type 0x00, byte 1 length 0x14;
// - byte 2: D-pad up, down, left, right, start, back, left stick, right stick (bits 0–7);
// - byte 3: LB, RB, guide, (none), A, B, X, Y (bits 0–7);
// - bytes 4 and 5: the left and right triggers (0–255);
// - bytes 6–13: left X, left Y, right X, right Y (int16; Y up positive: xpad reports ABS_Y as its complement).
// The OUT commands: `00 08 00 <strong> <weak> 00 00 00` rumble (the left, low-frequency motor and the right one);
// `01 03 <pattern>` the ring's LEDs (kept, not shown).
// A pad without the standard mapping is read as if it had it (its first buttons and axes in that order).

import type { Setup, UsbResult, UsbTransfer } from './usb-device.ts';
import { VirtualDevice, type ControlAnswer } from './usb-virtual.ts';

/** The wired Xbox 360 controller's IDs: the ones xpad, Chromium, Firefox and SDL know it by. */
export const GAMEPAD_VENDOR = 0x045e;
export const GAMEPAD_PRODUCT = 0x028e;

/** A pad's state as the page reads it from a `Gamepad`: the buttons pressed (bit i: button i), their values (0–1), the axes (−1–1). */
export type PadState = { pressed: number; values: number[]; axes: number[] };

/** The bit of the report (byte 2's bits 0–7, byte 3's 8–15) each standard-mapping button (0–16) is; −1: none (6 and 7, the triggers, are bytes of their own). */
export const BUTTONS = [12, 13, 14, 15, 8, 9, -1, -1, 5, 4, 6, 7, 0, 1, 2, 3, 10];
/** The input report's length. */
export const REPORT_LENGTH = 20;
/** The OUT endpoint's commands. */
const RUMBLE = 0x08,
  LED = 0x03;

const u16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];
const CONFIG = [
  9,
  4,
  0,
  0,
  2,
  0xff,
  0x5d,
  0x01,
  0, // interface 0: vendor class, subclass 0x5d, protocol 1 (a wired controller's)
  7,
  5,
  0x81,
  3,
  ...u16(32),
  4, // interrupt IN 0x81, 32 bytes, 4 ms
  7,
  5,
  0x02,
  3,
  ...u16(32),
  8, // interrupt OUT 0x02, 32 bytes, 8 ms
];
const DEVICE = new Uint8Array([
  18,
  1,
  ...u16(0x0200),
  0xff,
  0xff,
  0xff,
  8,
  ...u16(GAMEPAD_VENDOR),
  ...u16(GAMEPAD_PRODUCT),
  ...u16(0x0114),
  1,
  2,
  3,
  1,
]);
const CONFIGURATION = new Uint8Array([9, 2, ...u16(9 + CONFIG.length), 1, 1, 0, 0x80, 250, ...CONFIG]);
/** Reports kept for a host that isn't reading: past this, the oldest go (the newest says where the pad is). */
const QUEUE = 32;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
/** −1–1 → ±32767 (NaN and missing axes are centred). */
const axis = (v: number | undefined) => Math.round(clamp(Number.isFinite(v) ? v! : 0, -1, 1) * 32767);
/** 0–1 → 0–255. */
const trigger = (v: number | undefined) => Math.round(clamp(Number.isFinite(v) ? v! : 0, 0, 1) * 255);

/** The input report for a pad's state. */
export function padReport(s: PadState): Uint8Array {
  const r = new Uint8Array(REPORT_LENGTH);
  r[1] = REPORT_LENGTH;
  const down = (i: number) => ((s.pressed >>> i) & 1) === 1;
  let bits = 0;
  BUTTONS.forEach((b, i) => {
    if (b >= 0 && down(i)) bits |= 1 << b;
  });
  r[2] = bits & 0xff;
  r[3] = bits >> 8;
  // A trigger that says it's pressed without a value (a digital one) is all the way in.
  r[4] = trigger(s.values[6]) || (down(6) ? 255 : 0);
  r[5] = trigger(s.values[7]) || (down(7) ? 255 : 0);
  const v = new DataView(r.buffer);
  // Y up positive on the wire, as xpad reads it (ABS_Y is its complement, so ABS_Y is the Gamepad API's value scaled).
  [axis(s.axes[0]), ~axis(s.axes[1]), axis(s.axes[2]), ~axis(s.axes[3])].forEach((a, i) =>
    v.setInt16(6 + 2 * i, a, true),
  );
  return r;
}

type Held = { t: UsbTransfer; done: (r: UsbResult) => void };

export class UsbGamepad extends VirtualDevice {
  /** The report now (the pad at rest before the first state). */
  private now = padReport({ pressed: 0, values: [], axes: [] });
  /** Reports not yet taken, and the IN TDs waiting for one. */
  private queue: Uint8Array[] = [];
  private waiting: Held[] = [];
  /** The motors' strengths the host set last (0–255: the left, low-frequency one and the right one). */
  private motors: [number, number] = [0, 0];
  /** The LED pattern the host set last (xpad's: 2–5 the player's ring quarter lit). */
  led = 0;
  /** The host's rumble, on a change: each motor 0–1 (strong: the left, low-frequency motor; weak: the right one). */
  onRumble: (strong: number, weak: number) => void = () => {};

  /** `name`: the product string (the host's pad's name). */
  constructor(o: { name?: string; serial?: string } = {}) {
    super('full', {
      device: DEVICE,
      configs: [CONFIGURATION],
      strings: ['waarm64', o.name?.trim() || 'waarm64 game pad', o.serial || 'waarm64-pad'],
    });
  }

  /** The current input report. */
  report(): Uint8Array {
    return this.now.slice();
  }

  /** The pad's state now: a report when it changed what the guest sees. */
  pad(s: PadState) {
    const r = padReport(s);
    if (r.every((b, i) => b === this.now[i])) return;
    this.now = r;
    if (!this.endpoint(0x81)) return; // not configured: nothing reads it (the state is kept)
    const w = this.waiting.shift();
    if (w)
      return w.done({ code: 'success', actual: Math.min(REPORT_LENGTH, w.t.length), data: r.slice(0, w.t.length) });
    this.queue.push(r);
    if (this.queue.length > QUEUE) this.queue.shift();
  }

  protected control(s: Setup): ControlAnswer {
    // The vendor request xpad sends when its input starts (some third-party pads need it to start reporting): the report now.
    if (s.requestType === 0xc1 && s.request === 0x01 && s.value === 0x0100) return this.report();
    return undefined;
  }

  protected transfer(t: UsbTransfer, done: (r: UsbResult) => void) {
    if (t.ep === 0x02) {
      this.command(t.data ?? new Uint8Array());
      return done({ code: 'success', actual: t.data?.length ?? 0 });
    }
    if (t.ep !== 0x81) return done({ code: 'stall', actual: 0 });
    const r = this.queue.shift();
    if (r) return done({ code: 'success', actual: Math.min(REPORT_LENGTH, t.length), data: r.subarray(0, t.length) });
    this.waiting.push({ t, done });
  }

  /** A command on the OUT endpoint: rumble or the LEDs; others are ignored, as the pad does. */
  private command(d: Uint8Array) {
    if (d[0] === 0x00 && d[1] === RUMBLE && d.length >= 5) this.rumble(d[3], d[4]);
    else if (d[0] === 0x01 && d[1] === LED && d.length >= 3) this.led = d[2];
  }

  private rumble(strong: number, weak: number) {
    if (strong === this.motors[0] && weak === this.motors[1]) return;
    this.motors = [strong, weak];
    this.onRumble(strong / 255, weak / 255);
  }

  protected cancelled(ep: number, tags: number[]) {
    this.waiting = this.waiting.filter((w) => !(w.t.ep === ep && tags.includes(w.t.tag)));
  }

  protected changed() {
    // Configured again or reset: what was queued is the old configuration's; the host asks again. The motors stop.
    this.queue = [];
    this.waiting = [];
    this.rumble(0, 0);
    if (this.configuration === 0) this.led = 0;
  }

  detach() {
    super.detach();
    this.queue = [];
    this.waiting = [];
    this.rumble(0, 0);
  }
}
