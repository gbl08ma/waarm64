// Raw USB descriptors of real device types, for the WebUSB passthrough's tests (web/webusb.ts).
//
// `source` says where each one comes from. RECORDED: read from the user's devices through WebUSB
// (docs/usb.md "Findings"). TRANSCRIBED: written from the device's public documentation and
// its well-known `lsusb -v` layout (field values as such dumps show them; serial numbers and a few
// endpoint numbers are illustrative), until a real dump replaces it.

export type Fixture = {
  name: string;
  source: 'transcribed' | 'recorded';
  device: Uint8Array;
  configs: Uint8Array[];
  bos?: Uint8Array;
  /** String descriptors by `${index}:${langid}`; '0:0' is the language-ID list. */
  strings: Map<string, Uint8Array>;
  /** What the tests expect of it. */
  expect: { speed: 'low' | 'full' | 'high' | 'super'; protected: number[]; kept: number[] };
};

const u16 = (v: number) => [v & 0xff, v >> 8];
/** Recorded bytes, as hex. */
const hex = (s: string) => Uint8Array.from(s.match(/../g)!, (b) => parseInt(b, 16));

export function device(o: {
  bcdUSB: number; cls?: number; sub?: number; proto?: number; mps0: number; vid: number; pid: number; bcdDevice: number;
  iManufacturer?: number; iProduct?: number; iSerial?: number; configs?: number;
}): Uint8Array {
  return Uint8Array.from([18, 1, ...u16(o.bcdUSB), o.cls ?? 0, o.sub ?? 0, o.proto ?? 0, o.mps0, ...u16(o.vid), ...u16(o.pid), ...u16(o.bcdDevice),
    o.iManufacturer ?? 0, o.iProduct ?? 0, o.iSerial ?? 0, o.configs ?? 1]);
}

type Part = number[];
export const iface = (n: number, alt: number, eps: number, cls: number, sub: number, proto: number, iInterface = 0): Part =>
  [9, 4, n, alt, eps, cls, sub, proto, iInterface];
export const ep = (address: number, attrs: number, mps: number, interval: number): Part => [7, 5, address, attrs, ...u16(mps), interval];
export const bulk = (address: number, mps: number) => ep(address, 2, mps, 0);
export const intr = (address: number, mps: number, interval: number) => ep(address, 3, mps, interval);
export const iad = (first: number, count: number, cls: number, sub: number, proto: number, iFunction = 0): Part =>
  [8, 0x0b, first, count, cls, sub, proto, iFunction];
export const ssCompanion = (maxBurst: number, attrs = 0, bytesPerInterval = 0): Part => [6, 0x30, maxBurst, attrs, ...u16(bytesPerInterval)];
export const hidDesc = (reportLength: number): Part => [9, 0x21, ...u16(0x0111), 0, 1, 0x22, ...u16(reportLength)];
/** CDC-ACM's functional descriptors: header, call management, ACM, union. */
export const cdcAcm = (control: number, data: number): Part => [
  5, 0x24, 0x00, ...u16(0x0120),
  5, 0x24, 0x01, 0x00, data,
  4, 0x24, 0x02, 0x02,
  5, 0x24, 0x06, control, data,
];

/** A configuration descriptor around `parts`, with wTotalLength and bNumInterfaces filled in. */
export function config(value: number, attrs: number, maxPower: number, ...parts: Part[]): Uint8Array {
  const body = parts.flat();
  const ifs = new Set<number>();
  for (let o = 0; o < body.length; o += body[o]) if (body[o + 1] === 4) ifs.add(body[o + 2]);
  const total = 9 + body.length;
  return Uint8Array.from([9, 2, ...u16(total), ifs.size, value, 0, attrs, maxPower, ...body]);
}

export function bos(...caps: Part[]): Uint8Array {
  const body = caps.flat();
  return Uint8Array.from([5, 0x0f, ...u16(5 + body.length), caps.length, ...body]);
}

export function str(s: string): Uint8Array {
  const b = [2 + 2 * s.length, 3];
  for (const ch of s) b.push(...u16(ch.charCodeAt(0)));
  return Uint8Array.from(b);
}

function strings(list: string[], lang = 0x0409): Map<string, Uint8Array> {
  const m = new Map<string, Uint8Array>([['0:0', Uint8Array.from([4, 3, ...u16(lang)])]]);
  list.forEach((s, i) => m.set(`${i + 1}:${lang}`, str(s)));
  return m;
}

const usb2ext = (attrs: number): Part => [7, 0x10, 0x02, attrs, 0, 0, 0];
const ssCap = (): Part => [10, 0x10, 0x03, 0x00, ...u16(0x000e), 0x01, 0x0a, ...u16(0x07ff)];

export const fixtures: Fixture[] = [
  {
    // FTDI FT232R (0403:6001), the user's, read through WebUSB on macOS (docs/usb.md "Findings"): one vendor
    // interface, two 64-byte bulk endpoints, an 8-byte EP0, full speed. Its strings as macOS reported them.
    name: 'FTDI FT232R',
    source: 'recorded',
    device: hex('120100020000000803040160000601020301'),
    configs: [hex('09022000010100a02d0904000002ffffff020705810240000007050202400000')],
    strings: strings(['FTDI', 'FT232R USB UART', 'A50285BI']),
    expect: { speed: 'full', protected: [], kept: [0] },
  },
  {
    // Silicon Labs CP2102 (AN571; lsusb -v of 10c4:ea60): USB 1.1, one vendor interface.
    name: 'Silicon Labs CP2102',
    source: 'transcribed',
    device: device({ bcdUSB: 0x0110, mps0: 64, vid: 0x10c4, pid: 0xea60, bcdDevice: 0x0100, iManufacturer: 1, iProduct: 2, iSerial: 3 }),
    configs: [config(1, 0x80, 50, iface(0, 0, 2, 0xff, 0x00, 0x00, 2), bulk(0x81, 64), bulk(0x01, 64))],
    strings: strings(['Silicon Labs', 'CP2102 USB to UART Bridge Controller', '0001']),
    expect: { speed: 'full', protected: [], kept: [0] },
  },
  {
    // A Nooelec NESDR SMArt v5 (RTL2832U, 0bda:2838), the user's, read through WebUSB on macOS: a 512-byte bulk IN,
    // a second interface without endpoints, high speed.
    name: 'Nooelec NESDR SMArt v5 (RTL2832U)',
    source: 'recorded',
    device: hex('1201000200000040da0b3828000101020301'),
    configs: [hex('0902220002010480fa0904000001ffffff05070581020002000904010000ffffff05')],
    strings: strings(['Nooelec', 'NESDR SMArt v5', '00000001', 'USB2.0-Bulk&Iso', 'Bulk-In, Interface']),
    expect: { speed: 'high', protected: [], kept: [0, 1] },
  },
  {
    // A PowerA wired Xbox Series X controller (20d6:2001), the user's, read through WebUSB on macOS: Xbox One's GIP
    // (class ff/47/d0) on interrupt endpoints of 64 bytes, and an audio interface whose alternate setting has 228-byte
    // isochronous endpoints, at full speed (full speed allows isochronous packets up to 1023 bytes).
    name: 'PowerA Xbox Series X wired controller',
    source: 'recorded',
    device: hex('12010002ff47d040d6200120010101020301'),
    configs: [hex('09024000020100a0fa0904000002ff47d00007050103400004070581034000040904010000ff47d0000904010102ff47d00007050801e4000107058701400001')],
    strings: strings(['BDA', 'Xbox Series X En Wired Controller Black Inline', '000001017ECFF361']),
    expect: { speed: 'full', protected: [], kept: [0, 1] },
  },
  {
    // Raspberry Pi Pico running pico-sdk's stdio_usb (2e8a:000a): CDC-ACM under an IAD, the vendor reset interface, and a BOS
    // with the Microsoft OS 2.0 platform capability (bcdUSB 2.10).
    name: 'Raspberry Pi Pico (CDC + reset)',
    source: 'transcribed',
    device: device({ bcdUSB: 0x0210, cls: 0xef, sub: 0x02, proto: 0x01, mps0: 64, vid: 0x2e8a, pid: 0x000a, bcdDevice: 0x0100, iManufacturer: 1, iProduct: 2, iSerial: 3 }),
    configs: [config(1, 0x80, 125,
      iad(0, 2, 0x02, 0x02, 0x00, 4),
      iface(0, 0, 1, 0x02, 0x02, 0x00, 4), cdcAcm(0, 1), intr(0x81, 8, 16),
      iface(1, 0, 2, 0x0a, 0x00, 0x00, 0), bulk(0x02, 64), bulk(0x82, 64),
      iface(2, 0, 0, 0xff, 0x00, 0x01, 5))],
    bos: bos([0x1c, 0x10, 0x05, 0x00, 0xd8, 0xdd, 0x60, 0xdf, 0x45, 0x89, 0x4c, 0xc7, 0x9c, 0xd2, 0x65, 0x9d, 0x9e, 0x64, 0x8a, 0x9f,
      0x00, 0x00, 0x03, 0x06, 0xa6, 0x00, 0x01, 0x00]),
    strings: strings(['Raspberry Pi', 'Pico', 'E6614103E73B8E2A', 'Board CDC', 'Reset']),
    expect: { speed: 'full', protected: [], kept: [0, 1, 2] },
  },
  {
    // An Android phone in MTP + adb (Google 18d1:4ee2, Linux's composite gadget): high speed, a BOS with USB 2.0 LPM and
    // SuperSpeed capabilities (capable is not attached: its endpoints say high speed).
    name: 'Android MTP + adb',
    source: 'transcribed',
    device: device({ bcdUSB: 0x0210, mps0: 64, vid: 0x18d1, pid: 0x4ee2, bcdDevice: 0x0440, iManufacturer: 1, iProduct: 2, iSerial: 3 }),
    configs: [config(1, 0x80, 250,
      iface(0, 0, 3, 0x06, 0x01, 0x01, 4), bulk(0x81, 512), bulk(0x01, 512), intr(0x82, 28, 6),
      iface(1, 0, 2, 0xff, 0x42, 0x01, 5), bulk(0x02, 512), bulk(0x83, 512))],
    bos: bos(usb2ext(0x06), ssCap()),
    strings: strings(['Google', 'Pixel 7', '28241FDH2000PR', 'MTP', 'ADB Interface']),
    expect: { speed: 'high', protected: [], kept: [0, 1] },
  },
  {
    // Arm Mbed DAPLink (0d28:0204, as on a micro:bit): mass storage, CDC-ACM under an IAD, CMSIS-DAP v1 over HID and v2 over
    // vendor bulk. Mass storage and HID are protected; the guest gets CDC and CMSIS-DAP v2.
    name: 'DAPLink (MSC + CDC + HID + vendor)',
    source: 'transcribed',
    device: device({ bcdUSB: 0x0210, cls: 0xef, sub: 0x02, proto: 0x01, mps0: 64, vid: 0x0d28, pid: 0x0204, bcdDevice: 0x1000, iManufacturer: 1, iProduct: 2, iSerial: 3 }),
    configs: [config(1, 0x80, 250,
      iface(0, 0, 2, 0x08, 0x06, 0x50, 0), bulk(0x81, 64), bulk(0x02, 64),
      iad(1, 2, 0x02, 0x02, 0x01, 0),
      iface(1, 0, 1, 0x02, 0x02, 0x01, 0), cdcAcm(1, 2), intr(0x83, 16, 32),
      iface(2, 0, 2, 0x0a, 0x00, 0x00, 0), bulk(0x04, 64), bulk(0x84, 64),
      iface(3, 0, 2, 0x03, 0x00, 0x00, 4), hidDesc(0x21), intr(0x85, 64, 1), intr(0x05, 64, 1),
      iface(4, 0, 2, 0xff, 0x00, 0x00, 5), bulk(0x06, 64), bulk(0x86, 64))],
    bos: bos([0x18, 0x10, 0x05, 0x00, 0x38, 0xb6, 0x08, 0x34, 0xa9, 0x09, 0xa0, 0x47, 0x8b, 0xfd, 0xa0, 0x76, 0x88, 0x15, 0xb6, 0x65,
      0x00, 0x01, 0x01, 0x01]),
    strings: strings(['ARM', 'DAPLink CMSIS-DAP', '9904360258994e45002c00169000003f0000000097969900', 'CMSIS-DAP', 'CMSIS-DAP v2']),
    expect: { speed: 'full', protected: [0, 3], kept: [1, 2, 4] },
  },
  {
    // Cypress EZ-USB FX3 running its bulk streamer example (04b4:00f1): USB 3.0, a 512-byte EP0 (bMaxPacketSize0 9),
    // 1024-byte bulk endpoints with SuperSpeed companions.
    name: 'Cypress FX3 (SuperSpeed)',
    source: 'transcribed',
    device: device({ bcdUSB: 0x0300, mps0: 9, vid: 0x04b4, pid: 0x00f1, bcdDevice: 0x0000, iManufacturer: 1, iProduct: 2 }),
    configs: [config(1, 0x80, 0x32, iface(0, 0, 2, 0xff, 0x00, 0x00, 0), bulk(0x01, 1024), ssCompanion(15), bulk(0x81, 1024), ssCompanion(15))],
    bos: bos(usb2ext(0x02), [10, 0x10, 0x03, 0x00, ...u16(0x000e), 0x03, 0x00, 0x00, 0x00]),
    strings: strings(['Cypress', 'FX3']),
    expect: { speed: 'super', protected: [], kept: [0] },
  },
  {
    // USBasp (16c0:05dc, V-USB on an AVR): low speed, an 8-byte EP0 and control transfers only.
    name: 'USBasp (low speed)',
    source: 'transcribed',
    device: device({ bcdUSB: 0x0110, cls: 0xff, mps0: 8, vid: 0x16c0, pid: 0x05dc, bcdDevice: 0x0104, iManufacturer: 1, iProduct: 2 }),
    configs: [config(1, 0x80, 25, iface(0, 0, 0, 0x00, 0x00, 0x00, 0))],
    strings: strings(['www.fischl.de', 'USBasp']),
    expect: { speed: 'low', protected: [], kept: [0] },
  },
];
