// What other codecs would make of a snapshot's frames (bench/demo/REPORT.md "DEMO loop 1": ranking what would shrink
// a template's download). Each frame is unpacked (LZ4's block format, the snapshot's codec 2: web/lz.ts) and packed
// again alone, as the file packs it, with zstd and brotli at a few levels; and the file as it is (LZ4 frames) packed
// whole, as a host's Content-Encoding would send its pieces. Prints bytes by tag and codec.
//   node bench/demo/ramcodec.ts <snapshot>
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { brotliCompressSync, constants, deflateRawSync, zstdCompressSync } from 'node:zlib';

/** LZ4's block format, unpacked into `n` bytes. */
function unlz4(src: Uint8Array, n: number): Uint8Array {
  const out = new Uint8Array(n);
  let i = 0;
  let o = 0;
  while (i < src.length) {
    const token = src[i++];
    let lit = token >> 4;
    if (lit === 15) for (let b = 255; b === 255; ) lit += b = src[i++];
    out.set(src.subarray(i, i + lit), o);
    i += lit;
    o += lit;
    if (i >= src.length) break;
    const off = src[i] | (src[i + 1] << 8);
    i += 2;
    let len = token & 15;
    if (len === 15) for (let b = 255; b === 255; ) len += b = src[i++];
    len += 4;
    for (let k = 0; k < len; k++, o++) out[o] = out[o - off];
  }
  if (o !== n) throw new Error(`unpacked ${o} bytes, not ${n}`);
  return out;
}

const CODECS: Record<string, (b: Uint8Array) => number> = {
  // What the browser unpacks natively (DecompressionStream: gzip, deflate, deflate-raw in Chromium 155; no brotli, no zstd).
  'deflate-9': (b) => deflateRawSync(b, { level: 9 }).length,
  'zstd-3': (b) => zstdCompressSync(b, { params: { [constants.ZSTD_c_compressionLevel]: 3 } }).length,
  'zstd-19': (b) => zstdCompressSync(b, { params: { [constants.ZSTD_c_compressionLevel]: 19 } }).length,
  'brotli-5': (b) => brotliCompressSync(b, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }).length,
  'brotli-9': (b) => brotliCompressSync(b, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } }).length,
};

export function codecs(path: string) {
  const fd = openSync(path, 'r');
  const bytes = statSync(path).size;
  const read = (at: number, n: number) => {
    const b = Buffer.alloc(n);
    readSync(fd, b, 0, n, at);
    return b;
  };
  const by: Record<string, Record<string, number>> = {};
  try {
    const len = read(12, 4).readUInt32LE(0);
    for (let at = 20 + len; at + 32 <= bytes; ) {
      const h = read(at, 32);
      const tag = h.subarray(0, 4).toString('latin1');
      const codec = h.readUInt32LE(4);
      const raw = h.readUInt32LE(16);
      const stored = h.readUInt32LE(20);
      const body = read(at + 32, stored);
      at += 32 + stored;
      if (tag === 'END ') break;
      const plain = codec === 2 ? unlz4(body, raw) : body;
      const t = (by[tag] ??= { raw: 0, lz4: 0 });
      t.raw += raw;
      t.lz4 += stored;
      for (const [k, f] of Object.entries(CODECS)) t[k] = (t[k] ?? 0) + f(plain);
    }
    // The file as stored, cut into 2 MiB pieces each packed alone (a host compressing each piece it serves).
    const whole: Record<string, number> = { bytes };
    for (let at = 0; at < bytes; at += 2 << 20) {
      const piece = read(at, Math.min(2 << 20, bytes - at));
      for (const k of ['zstd-3', 'brotli-5']) whole[k] = (whole[k] ?? 0) + CODECS[k](piece);
    }
    return { frames: by, pieces: whole };
  } finally {
    closeSync(fd);
  }
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) throw new Error('usage: node bench/demo/ramcodec.ts <snapshot>');
  console.log(JSON.stringify(codecs(path), null, 1));
}
