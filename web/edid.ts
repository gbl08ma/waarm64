// The EDID virtio-gpu answers GET_EDID with (docs/devices.md "virtio-gpu"): a 128-byte base
// block for EDID 1.4 whose preferred mode is the page's size, so the guest's KMS picks it.
// The timings are CVT with reduced blanking (v1), which a 4095-pixel side still fits in the
// detailed timing's 16-bit pixel clock (10 kHz units) at 60 Hz or, for the largest sizes, at the
// highest refresh rate that does.
//
// The physical size comes from `dpi` (the guest's DPI is what a desktop scales by), the name is
// "waarm64", and everything is deterministic: no date but a fixed week and year.

/** The largest side a detailed timing can describe (12 bits), and the smallest size whose pixel clock (10 MHz) a descriptor takes. */
export const EDID_MAX = 4095;
export const EDID_MIN = { width: 480, height: 300 };

export type EdidOptions = {
  /** Pixels per inch, for the physical size (default 96: CSS pixels). */
  dpi?: number;
  /** More modes as detailed timings after the preferred one (at most two, all at 60 Hz or less). */
  extra?: { width: number; height: number }[];
};

/** CVT reduced blanking v1 timings for `w`×`h` at `hz` (an integer): what the detailed timing holds. */
export function cvtRb(w: number, h: number, hz: number) {
  const hBlank = 160, hFront = 48, hSync = 32;
  const vFront = 3, minBack = 6;
  // The vertical sync width by aspect ratio (CVT 1.2 table).
  const r = w * 100 / h;
  const vSync = Math.abs(r - 400 / 3) < 1 ? 4 : Math.abs(r - 1600 / 9) < 1 ? 5 : Math.abs(r - 160) < 1 ? 6 : Math.abs(r - 125) < 1 ? 7 : Math.abs(r - 500 / 3) < 1 ? 7 : 10;
  // Lines of vertical blank: at least 460 µs of them, and the minimum for the porches and sync.
  const hPeriodUs = (1e6 / hz - 460) / h;
  const vbi = Math.max(Math.floor(460 / hPeriodUs) + 1, vFront + vSync + minBack);
  const vTotal = h + vbi;
  const hTotal = w + hBlank;
  const clockKhz = Math.floor(hz * vTotal * hTotal / 250_000) * 250; // 0.25 MHz steps
  return { clockKhz, hActive: w, hBlank, hFront, hSync, vActive: h, vBlank: vbi, vFront, vSync, hz };
}

/** The timings for a size: 60 Hz, or the highest rate (down to 24) whose pixel clock the descriptor holds. */
function timings(w: number, h: number) {
  for (let hz = 60; hz > 24; hz--) {
    const t = cvtRb(w, h, hz);
    if (t.clockKhz / 10 <= 0xffff) return t;
  }
  return cvtRb(w, h, 24);
}

type Timing = ReturnType<typeof cvtRb>;

/** An 18-byte detailed timing descriptor (EDID 1.4 §3.10.2), image size in mm. */
function dtd(t: Timing, mmW: number, mmH: number) {
  const d = new Uint8Array(18);
  const px = t.clockKhz / 10;
  d[0] = px & 0xff;
  d[1] = px >> 8;
  d[2] = t.hActive & 0xff;
  d[3] = t.hBlank & 0xff;
  d[4] = (t.hActive >> 8) << 4 | t.hBlank >> 8;
  d[5] = t.vActive & 0xff;
  d[6] = t.vBlank & 0xff;
  d[7] = (t.vActive >> 8) << 4 | t.vBlank >> 8;
  d[8] = t.hFront & 0xff;
  d[9] = t.hSync & 0xff;
  d[10] = (t.vFront & 0xf) << 4 | t.vSync & 0xf;
  d[11] = (t.hFront >> 8) << 6 | (t.hSync >> 8) << 4 | (t.vFront >> 4) << 2 | t.vSync >> 4;
  d[12] = mmW & 0xff;
  d[13] = mmH & 0xff;
  d[14] = (mmW >> 8) << 4 | mmH >> 8;
  d[17] = 0x1a; // digital separate sync, vertical negative, horizontal positive (reduced blanking)
  return d;
}

/** A display descriptor: tag, then 13 bytes of data. */
function descriptor(tag: number, data: number[]) {
  const d = new Uint8Array(18);
  d[3] = tag;
  d.set(data.slice(0, 13), 5);
  return d;
}

const text = (s: string) => {
  const b = [...new TextEncoder().encode(s), 0x0a];
  while (b.length < 13) b.push(0x20);
  return b;
};

/** The base block for a screen of `width`×`height` pixels (EDID_MIN to EDID_MAX a side). */
export function edid(width: number, height: number, { dpi = 96, extra = [] }: EdidOptions = {}): Uint8Array {
  if (!(width >= EDID_MIN.width && width <= EDID_MAX && height >= EDID_MIN.height && height <= EDID_MAX)) throw new RangeError(`EDID size ${width}x${height}`);
  const e = new Uint8Array(128);
  e.set([0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00]);
  // Manufacturer "WAM" (three letters, five bits each), product 1, no serial number.
  const id = (87 - 64) << 10 | (65 - 64) << 5 | (77 - 64);
  e[8] = id >> 8;
  e[9] = id & 0xff;
  e[10] = 1;
  e[16] = 1; // week
  e[17] = 2026 - 1990;
  e[18] = 1; // EDID 1.4
  e[19] = 4;
  e[20] = 0xa5; // digital, 8 bits per color, DisplayPort
  const mmW = Math.max(1, Math.round(width * 25.4 / dpi)), mmH = Math.max(1, Math.round(height * 25.4 / dpi));
  e[21] = Math.min(255, Math.max(1, Math.round(mmW / 10))); // centimeters
  e[22] = Math.min(255, Math.max(1, Math.round(mmH / 10)));
  e[23] = 120; // gamma 2.2
  e[24] = 0x06; // sRGB, the preferred timing is the first descriptor
  e.set([0xee, 0x91, 0xa3, 0x54, 0x4c, 0x99, 0x26, 0x0f, 0x50, 0x54], 25); // sRGB primaries and white point
  e.fill(0x01, 38, 54); // no established or standard timings: they'd widen the range limits, and the guest picks the preferred mode
  const t = timings(width, height);
  e.set(dtd(t, mmW, mmH), 54);
  const more = extra.slice(0, 2).map((m) => dtd(timings(m.width, m.height), mmW, mmH));
  const modes = [t, ...extra.slice(0, 2).map((m) => timings(m.width, m.height))];
  const clock = Math.max(...modes.map((m) => m.clockKhz));
  const hMax = Math.max(...modes.map((m) => Math.ceil(m.clockKhz / (m.hActive + m.hBlank))));
  const range = descriptor(0xfd, [24, 75, 15, Math.min(255, Math.max(hMax, 15)), Math.min(255, Math.ceil(clock / 10_000)), 0x01, 0x0a, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20]);
  const name = descriptor(0xfc, text('waarm64'));
  // After the preferred timing: the extra ones, then the range limits and the name, then dummies.
  const order = [...more, range, name].slice(0, 3);
  while (order.length < 3) order.push(descriptor(0x10, []));
  order.forEach((d, k) => e.set(d, 72 + 18 * k));
  e[127] = (256 - e.slice(0, 127).reduce((a, b) => a + b, 0) % 256) % 256;
  return e;
}
