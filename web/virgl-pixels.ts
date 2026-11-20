// Pixel data between the guest's bytes and WebGL for the virgl renderer (web/virgl-renderer.ts): the typed views
// WebGL takes, how each format is read back (and how a snapshot reads those the guest can't), and float bits.
import { E } from './gl-enums.ts';
import { FORMATS, GL, type Format } from './virgl-formats.ts';

const f32 = new Float32Array(1),
  u32 = new Uint32Array(f32.buffer);

export const uif = (b: number) => {
  u32[0] = b;
  return f32[0];
};

/** The typed-array view WebGL wants for pixel data of a GL type. */
export function viewFor(type: number, bytes: Uint8Array): ArrayBufferView | null {
  const size =
    type === E.UNSIGNED_BYTE || type === E.BYTE
      ? 1
      : [E.UNSIGNED_SHORT, E.SHORT, E.HALF_FLOAT, 0x8363, 0x8033, 0x8034].includes(type)
        ? 2
        : 4;
  if (bytes.byteOffset % size) bytes = bytes.slice();
  const buf = bytes.buffer,
    off = bytes.byteOffset,
    n = Math.floor(bytes.byteLength / size);
  switch (type) {
    case E.UNSIGNED_BYTE:
      return bytes;
    case E.BYTE:
      return new Int8Array(buf, off, n);
    case E.SHORT:
      return new Int16Array(buf, off, n);
    case E.INT:
      return new Int32Array(buf, off, n);
    case E.FLOAT:
      return new Float32Array(buf, off, n);
    case 0x8dad:
      return null; // FLOAT_32_UNSIGNED_INT_24_8_REV: WebGL takes no data for it
    default:
      return size === 2 ? new Uint16Array(buf, off, n) : new Uint32Array(buf, off, n);
  }
}

/** How a format's texels are read back: the readPixels format and type, bytes a pixel read, and the packer. */
export function readbackOf(
  f: Format,
  floats: boolean,
): { format: number; type: number; bytes: number; pack: (src: Uint8Array, dst: Uint8Array, w: number) => void } | null {
  if (f.kind === 'depth' || f.kind === 'depthstencil' || f.kind === 'stencil' || f.block > 1) return null;
  const take = (comps: number[], size: number) => (src: Uint8Array, dst: Uint8Array, w: number) => {
    for (let x = 0; x < w; x++)
      for (let k = 0; k < comps.length; k++)
        for (let b = 0; b < size; b++)
          dst[x * comps.length * size + k * size + b] = src[x * 4 * size + comps[k] * size + b];
  };
  if (f.internal === E.RGBA8 || f.internal === 0x8c43)
    return { format: E.RGBA, type: E.UNSIGNED_BYTE, bytes: 4, pack: (s, d, w) => d.set(s.subarray(0, w * 4)) };
  if (f.type === E.UNSIGNED_BYTE && f.kind === 'unorm' && f.bpp <= 2)
    return { format: E.RGBA, type: E.UNSIGNED_BYTE, bytes: 4, pack: take(f.bpp === 1 ? [0] : [0, 1], 1) };
  if (f.type === E.UNSIGNED_INT_2_10_10_10_REV && f.kind === 'unorm')
    return {
      format: E.RGBA,
      type: E.UNSIGNED_INT_2_10_10_10_REV,
      bytes: 4,
      pack: (s, d, w) => d.set(s.subarray(0, w * 4)),
    };
  if (f.type === 0x8363) {
    // RGB565: read as RGBA8 and packed again (8 → 5/6 bits round-trips).
    return {
      format: E.RGBA,
      type: E.UNSIGNED_BYTE,
      bytes: 4,
      pack: (s, d, w) => {
        for (let x = 0; x < w; x++) {
          const v =
            (Math.round((s[4 * x] * 31) / 255) << 11) |
            (Math.round((s[4 * x + 1] * 63) / 255) << 5) |
            Math.round((s[4 * x + 2] * 31) / 255);
          d[2 * x] = v & 0xff;
          d[2 * x + 1] = v >> 8;
        }
      },
    };
  }
  if (f.kind === 'uint' && f.type === E.UNSIGNED_INT_2_10_10_10_REV) {
    // RGB10_A2UI: read as four integers, packed again into 10, 10, 10 and 2 bits.
    return {
      format: E.RGBA_INTEGER,
      type: E.UNSIGNED_INT,
      bytes: 16,
      pack: (s, d, w) => {
        const sv = new DataView(s.buffer, s.byteOffset, w * 16),
          dv = new DataView(d.buffer, d.byteOffset, w * 4);
        for (let x = 0; x < w; x++) {
          const c = (k: number) => sv.getUint32(x * 16 + k * 4, true);
          dv.setUint32(
            x * 4,
            ((c(0) & 0x3ff) | ((c(1) & 0x3ff) << 10) | ((c(2) & 0x3ff) << 20) | ((c(3) & 3) << 30)) >>> 0,
            true,
          );
        }
      },
    };
  }
  if (f.kind === 'uint' || f.kind === 'sint') {
    const comps =
      f.bpp /
      (([E.UNSIGNED_BYTE, E.BYTE] as number[]).includes(f.type)
        ? 1
        : ([E.UNSIGNED_SHORT, E.SHORT] as number[]).includes(f.type)
          ? 2
          : 4);
    const size = f.bpp / comps;
    return {
      format: E.RGBA_INTEGER,
      type: f.kind === 'uint' ? E.UNSIGNED_INT : E.INT,
      bytes: 16,
      pack: (s, d, w) => {
        for (let x = 0; x < w; x++)
          for (let k = 0; k < comps; k++)
            for (let b = 0; b < size; b++) d[x * f.bpp + k * size + b] = s[x * 16 + k * 4 + b];
      },
    };
  }
  if (f.kind === 'float' && floats && (f.type === E.FLOAT || f.type === E.HALF_FLOAT)) {
    const comps = f.bpp / (f.type === E.FLOAT ? 4 : 2);
    return {
      format: E.RGBA,
      type: E.FLOAT,
      bytes: 16,
      pack: (s, d, w) => {
        const fv = new Float32Array(s.buffer, s.byteOffset, w * 4);
        const dv = new DataView(d.buffer, d.byteOffset, d.length);
        for (let x = 0; x < w; x++)
          for (let k = 0; k < comps; k++) {
            if (f.type === E.FLOAT) dv.setFloat32((x * comps + k) * 4, fv[x * 4 + k], true);
            else dv.setUint16((x * comps + k) * 2, toHalf(fv[x * 4 + k]), true);
          }
      },
    };
  }
  return null;
}

/**
 * How a snapshot reads the formats `readbackOf` doesn't (the guest isn't told it can read them back; a snapshot must
 * keep them all the same): A4B4G4R4 as RGBA8 packed again into 4 bits a channel, R11G11B10_FLOAT as floats packed
 * into 11, 11 and 10-bit floats (both exact for the values the formats hold).
 */
export function snapshotReader(f: Format, floats: boolean): ReturnType<typeof readbackOf> {
  if (f.type === GL.UNSIGNED_SHORT_4_4_4_4 && f.kind === 'unorm') {
    return {
      format: E.RGBA,
      type: E.UNSIGNED_BYTE,
      bytes: 4,
      pack: (s, d, w) => {
        const four = (x: number) => Math.round((x * 15) / 255);
        for (let x = 0; x < w; x++) {
          const v = (four(s[4 * x]) << 12) | (four(s[4 * x + 1]) << 8) | (four(s[4 * x + 2]) << 4) | four(s[4 * x + 3]);
          d[2 * x] = v & 0xff;
          d[2 * x + 1] = v >> 8;
        }
      },
    };
  }
  if (f.type === GL.UNSIGNED_INT_10F_11F_11F_REV && floats) {
    return {
      format: E.RGBA,
      type: E.FLOAT,
      bytes: 16,
      pack: (s, d, w) => {
        const fv = new Float32Array(s.buffer, s.byteOffset, w * 4),
          dv = new DataView(d.buffer, d.byteOffset, d.length);
        // A half's sign dropped and its mantissa cut to 6 (or 5) bits: the unsigned small floats.
        const small = (v: number, shift: number) => (toHalf(v) & 0x7fff) >> shift;
        for (let x = 0; x < w; x++)
          dv.setUint32(
            4 * x,
            (small(fv[4 * x], 4) | (small(fv[4 * x + 1], 4) << 11) | (small(fv[4 * x + 2], 5) << 22)) >>> 0,
            true,
          );
      },
    };
  }
  return null;
}

/** Float32 to IEEE half (round to nearest even). */
export function toHalf(v: number) {
  f32[0] = v;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = ((x >>> 23) & 0xff) - 127 + 15;
  let mant = x & 0x7fffff;
  if (((x >>> 23) & 0xff) === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
  if (exp >= 0x1f) return sign | 0x7c00;
  if (exp <= 0) {
    if (exp < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - exp;
    let h = mant >>> shift;
    const rem = mant & ((1 << shift) - 1),
      half = 1 << (shift - 1);
    if (rem > half || (rem === half && h & 1)) h++;
    return sign | h;
  }
  let h = (exp << 10) | (mant >>> 13);
  const rem = mant & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && h & 1)) h++;
  return sign | h;
}

/** The formats `readbackOf` can read (what the caps advertise as `supported_readback_formats`). */
export function readbackFormats(floats: boolean) {
  return [...FORMATS.values()].filter((f) => readbackOf(f, floats)).map((f) => f.id);
}
