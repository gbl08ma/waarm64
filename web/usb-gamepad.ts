// The game pad of ours (docs/usb.md "The game pad"): an emulated USB HID game pad with a fixed report descriptor,
// fed from the page's Gamepad API, for a host's game pad that neither WebUSB nor WebHID can reach (a wired Xbox
// controller the host's driver keeps, any pad the browser only offers as a `Gamepad`). The page polls
// `navigator.getGamepads()` (Window only) and sends each change of the pad's state as a `usb-pad` message.
//
// What the guest sees: a full-speed HID device (interface class 3, no boot protocol) whose one input report is the
// Gamepad API's standard mapping, laid out so that Linux's hid-generic gives the evdev codes of its game pad
// convention (Documentation/input/gamepad.rst), the codes `xpad` gives an Xbox controller:
// - 15 buttons on the Button page. hid-input maps button n of a Game Pad application to BTN_GAMEPAD + n - 1 (BTN_A,
//   BTN_B, BTN_C, BTN_X, BTN_Y, BTN_Z, BTN_TL, BTN_TR, BTN_TL2, BTN_TR2, BTN_SELECT, BTN_START, BTN_MODE, BTN_THUMBL,
//   BTN_THUMBR), so the standard buttons go where those codes are and BTN_C and BTN_Z stay unused (`BUTTONS`).
// - The D-pad as a hat switch (ABS_HAT0X/Y), 8 directions and a null state.
// - The sticks as X, Y, Rx, Ry (16-bit, ±32767; up and left negative, as the Gamepad API has them).
// - The triggers as Z and Rz (0–255), and also as buttons TL2 and TR2 while pressed.
// A pad without the standard mapping is read as if it had it (its first buttons and axes in that order).
// No output report: rumble would need a driver of the guest's for it (docs/backlog.md "USB").

import type { Setup, UsbResult, UsbTransfer } from './usb-device.ts';
import { VirtualDevice, type ControlAnswer } from './usb-virtual.ts';

/** pid.codes' test IDs (https://pid.codes/1209/0002/): not a real pad's, so no guest driver for one binds to it. */
export const GAMEPAD_VENDOR = 0x1209;
export const GAMEPAD_PRODUCT = 0x0002;

/** A pad's state as the page reads it from a `Gamepad`: the buttons pressed (bit i: button i), their values (0–1), the axes (−1–1). */
export type PadState = { pressed: number; values: number[]; axes: number[] };

/** The HID button (1–15) each standard-mapping button (0–16) is; 0: none (12–15 are the D-pad, the hat switch). */
export const BUTTONS = [1, 2, 4, 5, 7, 8, 9, 10, 11, 12, 14, 15, 0, 0, 0, 0, 13];
/** The standard mapping's D-pad buttons. */
const UP = 12, DOWN = 13, LEFT = 14, RIGHT = 15;
/** The report's length: 2 bytes of buttons, the hat's byte, four 16-bit sticks' axes, two 8-bit triggers. */
export const REPORT_LENGTH = 13;

const u16 = (v: number) => [v & 0xff, v >> 8 & 0xff];
/** The report descriptor: one Game Pad application collection, one input report (no report ID). */
export const PAD_REPORT = new Uint8Array([
  0x05, 0x01, 0x09, 0x05, 0xa1, 0x01, // Generic Desktop, Game Pad, Collection (Application)
  0x05, 0x09, 0x19, 0x01, 0x29, 0x0f, 0x15, 0x00, 0x25, 0x01, 0x75, 0x01, 0x95, 0x0f, 0x81, 0x02, // buttons 1–15: 15 × 1 bit, Data Var Abs
  0x95, 0x01, 0x81, 0x03, // 1 bit of padding: Constant
  0x05, 0x01, 0x09, 0x39, 0x25, 0x07, 0x35, 0x00, 0x46, ...u16(315), 0x65, 0x14, 0x75, 0x04, 0x81, 0x42, // hat switch: 0–7 as 0–315°, Null state
  0x45, 0x00, 0x65, 0x00, 0x81, 0x03, // 4 bits of padding (the physical range and the unit cleared)
  0x09, 0x30, 0x09, 0x31, 0x09, 0x33, 0x09, 0x34, 0x16, ...u16(-32767), 0x26, ...u16(32767), 0x75, 0x10, 0x95, 0x04, 0x81, 0x02, // X, Y, Rx, Ry: 4 × 16 bits
  0x09, 0x32, 0x09, 0x35, 0x15, 0x00, 0x26, ...u16(255), 0x75, 0x08, 0x95, 0x02, 0x81, 0x02, // Z, Rz: 2 × 8 bits
  0xc0,
]);

const HID = [9, 0x21, ...u16(0x0111), 0, 1, 0x22, ...u16(PAD_REPORT.length)];
const CONFIG = [
  9, 4, 0, 0, 1, 3, 0, 0, 0, // interface 0: HID, no boot protocol
  ...HID,
  7, 5, 0x81, 3, ...u16(16), 4, // interrupt IN 0x81, 16 bytes, 4 ms
];
const DEVICE = new Uint8Array([18, 1, ...u16(0x0200), 0, 0, 0, 8, ...u16(GAMEPAD_VENDOR), ...u16(GAMEPAD_PRODUCT), ...u16(0x0100), 1, 2, 3, 1]);
const CONFIGURATION = new Uint8Array([9, 2, ...u16(9 + CONFIG.length), 1, 1, 0, 0x80, 50, ...CONFIG]);
/** Reports kept for a host that isn't reading: past this, the oldest go (the newest says where the pad is). */
const QUEUE = 32;

/** The hat switch's value for the D-pad's buttons: 0 up, then clockwise in eighths; 8 (out of range: the null state) for none, or for opposite buttons alone. */
export function hat(up: boolean, down: boolean, left: boolean, right: boolean): number {
  const y = up === down ? 0 : up ? -1 : 1;
  const x = left === right ? 0 : left ? -1 : 1;
  if (!x && !y) return 8;
  return [[7, 0, 1], [6, 8, 2], [5, 4, 3]][y + 1][x + 1];
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
/** −1–1 → ±32767 (NaN and missing axes are centred). */
const axis = (v: number | undefined) => Math.round(clamp(Number.isFinite(v) ? v! : 0, -1, 1) * 32767);
/** 0–1 → 0–255. */
const trigger = (v: number | undefined) => Math.round(clamp(Number.isFinite(v) ? v! : 0, 0, 1) * 255);

/** The input report for a pad's state. */
export function padReport(s: PadState): Uint8Array {
  const r = new Uint8Array(REPORT_LENGTH);
  const down = (i: number) => (s.pressed >>> i & 1) === 1;
  let bits = 0;
  BUTTONS.forEach((b, i) => { if (b && down(i)) bits |= 1 << (b - 1); });
  r[0] = bits & 0xff;
  r[1] = bits >> 8;
  r[2] = hat(down(UP), down(DOWN), down(LEFT), down(RIGHT));
  const v = new DataView(r.buffer);
  for (let i = 0; i < 4; i++) v.setInt16(3 + 2 * i, axis(s.axes[i]), true);
  r[11] = trigger(s.values[6]);
  r[12] = trigger(s.values[7]);
  return r;
}

type Held = { t: UsbTransfer; done: (r: UsbResult) => void };

export class UsbGamepad extends VirtualDevice {
  /** The report now (the pad at rest before the first state). */
  private now = padReport({ pressed: 0, values: [], axes: [] });
  /** Reports not yet taken, and the IN TDs waiting for one. */
  private queue: Uint8Array[] = [];
  private waiting: Held[] = [];
  idle = 0;

  /** `name`: the product string (the host's pad's name). */
  constructor(o: { name?: string; serial?: string } = {}) {
    super('full', { device: DEVICE, configs: [CONFIGURATION], strings: ['webpc', o.name?.trim() || 'webpc game pad', o.serial || 'webpc-pad'], extra: (type, index, s) => this.classDescriptor(type, index, s) });
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
    if (w) return w.done({ code: 'success', actual: Math.min(REPORT_LENGTH, w.t.length), data: r.slice(0, w.t.length) });
    this.queue.push(r);
    if (this.queue.length > QUEUE) this.queue.shift();
  }

  private classDescriptor(type: number, index: number, s: Setup): Uint8Array | undefined {
    if ((s.requestType & 0x1f) !== 1 || (s.index & 0xff) !== 0 || index !== 0) return undefined;
    if (type === 0x21) return new Uint8Array(HID);
    if (type === 0x22) return PAD_REPORT;
    return undefined;
  }

  protected control(s: Setup): ControlAnswer {
    // HID class requests to interface 0 (HID 1.11 §7.2); no boot protocol, so no GET/SET_PROTOCOL.
    if ((s.requestType & 0x7f) !== 0x21 || (s.index & 0xff) !== 0) return undefined;
    switch (s.request) {
      case 0x01: // GET_REPORT: the one input report (ID 0)
        return s.value === 0x0100 ? this.report() : undefined;
      case 0x02: return new Uint8Array([this.idle]); // GET_IDLE
      case 0x0a: this.idle = s.value >> 8; return true; // SET_IDLE (kept: a report goes out on a change only)
    }
    return undefined;
  }

  protected transfer(t: UsbTransfer, done: (r: UsbResult) => void) {
    if (t.ep !== 0x81) return done({ code: 'stall', actual: 0 });
    const r = this.queue.shift();
    if (r) return done({ code: 'success', actual: Math.min(REPORT_LENGTH, t.length), data: r.subarray(0, t.length) });
    this.waiting.push({ t, done });
  }

  protected cancelled(ep: number, tags: number[]) {
    this.waiting = this.waiting.filter((w) => !(w.t.ep === ep && tags.includes(w.t.tag)));
  }

  protected changed() {
    // Configured again or reset: what was queued is the old configuration's; the host asks again.
    this.queue = [];
    this.waiting = [];
    if (this.configuration === 0) this.idle = 0;
  }

  detach() {
    super.detach();
    this.queue = [];
    this.waiting = [];
  }
}
