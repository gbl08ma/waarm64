// The built-in USB keyboard (docs/usb.md "The keyboard"): an emulated HID boot keyboard on the machine's
// xHCI, fed from the page's key events, so that the firmware (EDK2's UsbKbDxe), its boot manager, GRUB
// and anything else before the guest's virtio-input driver has a real keyboard: every key, held
// modifiers, key-up. The page plugs it in at power-on and unplugs it once the guest's virtio keyboard
// is live (web/app/main.ts).
//
// A boot keyboard as HID 1.11 describes it (interface class 3, subclass 1, protocol 1): the boot report
// descriptor (Appendix B.1's report layout), 8-byte input reports on interrupt IN 0x81 (modifier bits,
// a reserved byte, up to six usages; ErrorRollOver in all six with more held), the LED output report by
// SET_REPORT, GET/SET_REPORT, GET/SET_IDLE and GET/SET_PROTOCOL (the boot and report protocols share the
// layout). A report goes out for every change of the keys, in order (each press and each release),
// to the IN TD the host keeps queued; the idle rate is kept but no report is repeated (EDK2 and Linux
// repeat keys themselves).

import type { Setup, UsbResult, UsbTransfer } from './usb-device.ts';
import { VirtualDevice, type ControlAnswer } from './usb-virtual.ts';

/** pid.codes' test IDs (https://pid.codes/1209/0001/). */
export const KEYBOARD_VENDOR = 0x1209;
export const KEYBOARD_PRODUCT = 0x0001;

// KeyboardEvent.code → HID usage (HID Usage Tables, page 7), a US-layout PC keyboard as web/input.ts maps for virtio-input.
const RUN = (codes: string, first: number) => codes.split(' ').map((c, k) => [c, first + k] as const);
export const USAGES = new Map<string, number>([
  ...RUN('KeyA KeyB KeyC KeyD KeyE KeyF KeyG KeyH KeyI KeyJ KeyK KeyL KeyM KeyN KeyO KeyP KeyQ KeyR KeyS KeyT KeyU KeyV KeyW KeyX KeyY KeyZ', 0x04),
  ...RUN('Digit1 Digit2 Digit3 Digit4 Digit5 Digit6 Digit7 Digit8 Digit9 Digit0 Enter Escape Backspace Tab Space Minus Equal BracketLeft BracketRight Backslash IntlHash Semicolon Quote Backquote Comma Period Slash CapsLock', 0x1e),
  ...RUN('F1 F2 F3 F4 F5 F6 F7 F8 F9 F10 F11 F12 PrintScreen ScrollLock Pause Insert Home PageUp Delete End PageDown ArrowRight ArrowLeft ArrowDown ArrowUp', 0x3a),
  ...RUN('NumLock NumpadDivide NumpadMultiply NumpadSubtract NumpadAdd NumpadEnter Numpad1 Numpad2 Numpad3 Numpad4 Numpad5 Numpad6 Numpad7 Numpad8 Numpad9 Numpad0 NumpadDecimal IntlBackslash ContextMenu', 0x53),
]);
/** The modifiers' bits in the report's first byte (usages 0xE0–0xE7). */
export const MODIFIERS = new Map<string, number>(RUN('ControlLeft ShiftLeft AltLeft MetaLeft ControlRight ShiftRight AltRight MetaRight', 0).map(([c, b]) => [c, 1 << b]));

/** HID 1.11's boot keyboard report descriptor (Appendix B.1's layout): 8 modifier bits, a reserved byte, 5 LEDs and their padding, 6 key usages 0–101. */
export const BOOT_REPORT = new Uint8Array([
  0x05, 0x01, 0x09, 0x06, 0xa1, 0x01, // Generic Desktop, Keyboard, Collection (Application)
  0x05, 0x07, 0x19, 0xe0, 0x29, 0xe7, 0x15, 0x00, 0x25, 0x01, 0x75, 0x01, 0x95, 0x08, 0x81, 0x02, // modifiers: 8 × 1 bit, Data Var Abs
  0x95, 0x01, 0x75, 0x08, 0x81, 0x01, // reserved byte: Constant
  0x95, 0x05, 0x75, 0x01, 0x05, 0x08, 0x19, 0x01, 0x29, 0x05, 0x91, 0x02, // LEDs: 5 × 1 bit, Output Data Var Abs
  0x95, 0x01, 0x75, 0x03, 0x91, 0x01, // LED padding: 3 bits, Output Constant
  0x95, 0x06, 0x75, 0x08, 0x15, 0x00, 0x25, 0x65, 0x05, 0x07, 0x19, 0x00, 0x29, 0x65, 0x81, 0x00, // 6 keys: usages 0–101, Data Array
  0xc0,
]);

const u16 = (v: number) => [v & 0xff, v >> 8];
const HID = [9, 0x21, ...u16(0x0111), 0, 1, 0x22, ...u16(BOOT_REPORT.length)];
const CONFIG = [
  9, 4, 0, 0, 1, 3, 1, 1, 0, // interface 0: HID, boot, keyboard
  ...HID,
  7, 5, 0x81, 3, ...u16(8), 10, // interrupt IN 0x81, 8 bytes, 10 ms
];
const DEVICE = new Uint8Array([18, 1, ...u16(0x0200), 0, 0, 0, 8, ...u16(KEYBOARD_VENDOR), ...u16(KEYBOARD_PRODUCT), ...u16(0x0100), 1, 2, 0, 1]);
const CONFIGURATION = new Uint8Array([9, 2, ...u16(9 + CONFIG.length), 1, 1, 0, 0xa0, 50, ...CONFIG]);
/** Reports kept for a host that isn't reading: past this, the oldest go (the newest says what is held). */
const QUEUE = 32;

type Held = { t: UsbTransfer; done: (r: UsbResult) => void };

export class UsbKeyboard extends VirtualDevice {
  /** Held modifier bits and keys (usages, in the order pressed). */
  private mods = 0;
  private keys: number[] = [];
  /** Reports not yet taken, and the IN TDs waiting for one. */
  private queue: Uint8Array[] = [];
  private waiting: Held[] = [];
  /** What the host set: the LEDs (num, caps, scroll, compose, kana bits), the protocol (0 boot, 1 report), the idle rate. */
  leds = 0;
  /** Told the LEDs when the host changes them. */
  onLeds?: (leds: number) => void;
  protocol = 1;
  idle = 0;

  constructor() {
    super('full', { device: DEVICE, configs: [CONFIGURATION], strings: ['waarm64', 'waarm64 keyboard'], extra: (type, index, s) => this.classDescriptor(type, index, s) });
  }

  /** The report now: modifiers, 0, six keys (or six ErrorRollOver with more held). */
  report(): Uint8Array {
    const r = new Uint8Array(8);
    r[0] = this.mods;
    if (this.keys.length > 6) r.fill(0x01, 2);
    else r.set(this.keys, 2);
    return r;
  }

  /** A key of the page's (a `KeyboardEvent.code`) went down or up; false if the keyboard has no such key. */
  key(code: string, down: boolean): boolean {
    const bit = MODIFIERS.get(code);
    const usage = USAGES.get(code);
    if (bit === undefined && usage === undefined) return false;
    const before = this.report();
    if (bit !== undefined) this.mods = down ? this.mods | bit : this.mods & ~bit;
    else if (down && !this.keys.includes(usage!)) this.keys.push(usage!);
    else if (!down) this.keys = this.keys.filter((k) => k !== usage);
    const now = this.report();
    if (now.some((b, i) => b !== before[i])) this.send(now);
    return true;
  }

  /** Releases every key (the page lost the focus). */
  releaseAll() {
    if (!this.mods && !this.keys.length) return;
    this.mods = 0;
    this.keys = [];
    this.send(this.report());
  }

  private send(r: Uint8Array) {
    if (!this.endpoint(0x81)) return; // not configured: nothing reads it (the state is kept)
    const w = this.waiting.shift();
    if (w) return w.done({ code: 'success', actual: 8, data: r.subarray(0, w.t.length) });
    this.queue.push(r);
    if (this.queue.length > QUEUE) this.queue.shift();
  }

  private classDescriptor(type: number, index: number, s: Setup): Uint8Array | undefined {
    if ((s.requestType & 0x1f) !== 1 || (s.index & 0xff) !== 0 || index !== 0) return undefined;
    if (type === 0x21) return new Uint8Array(HID);
    if (type === 0x22) return BOOT_REPORT;
    return undefined;
  }

  protected control(s: Setup, data?: Uint8Array): ControlAnswer {
    // HID class requests to interface 0 (HID 1.11 §7.2).
    if ((s.requestType & 0x7f) !== 0x21 || (s.index & 0xff) !== 0) return undefined;
    const reportType = s.value >> 8;
    switch (s.request) {
      case 0x01: // GET_REPORT
        if (reportType === 1) return this.report();
        if (reportType === 2) return new Uint8Array([this.leds]);
        return undefined;
      case 0x09: // SET_REPORT
        if (reportType !== 2 || !data?.length) return undefined;
        if ((data[0] & 0x1f) !== this.leds) {
          this.leds = data[0] & 0x1f;
          this.onLeds?.(this.leds);
        }
        return true;
      case 0x02: return new Uint8Array([this.idle]); // GET_IDLE
      case 0x0a: this.idle = s.value >> 8; return true; // SET_IDLE (kept: no report is repeated)
      case 0x03: return new Uint8Array([this.protocol]); // GET_PROTOCOL
      case 0x0b: // SET_PROTOCOL
        if (s.value > 1) return undefined;
        this.protocol = s.value;
        return true;
    }
    return undefined;
  }

  protected transfer(t: UsbTransfer, done: (r: UsbResult) => void) {
    if (t.ep !== 0x81) return done({ code: 'stall', actual: 0 });
    const r = this.queue.shift();
    if (r) return done({ code: 'success', actual: Math.min(8, t.length), data: r.subarray(0, t.length) });
    this.waiting.push({ t, done });
  }

  protected cancelled(ep: number, tags: number[]) {
    this.waiting = this.waiting.filter((w) => !(w.t.ep === ep && tags.includes(w.t.tag)));
  }

  protected changed() {
    // Configured again or reset: what was queued is the old configuration's; the host asks again.
    this.queue = [];
    this.waiting = [];
    if (this.configuration === 0) {
      this.protocol = 1;
      this.idle = 0;
    }
  }

  detach() {
    super.detach();
    this.queue = [];
    this.waiting = [];
  }
}
