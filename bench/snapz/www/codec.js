// Ad-hoc codec bench: one loader for every candidate. make(name, wasmBytes) -> { comp(u8): Uint8Array|Promise, decomp(u8, rawLen) }.
import { deflateSync, inflateSync } from './fflate.js';

const KIND = { core: 0, lz4flex: 1, 'lz4flex-safe': 1, snap: 2, miniz1: 3, miniz2: 4, miniz3: 5, miniz6: 6, ruzstd: 7, 'zstd-1': 8, zstd1: 9, zstd3: 10, 'zstd-4': 11 };
export const MAX = (1 << 20) + 32;

async function collect(stream) {
  const r = stream.getReader();
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    parts.push(value);
    n += value.length;
  }
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

export async function make(name, wasm) {
  if (name.startsWith('fflate')) {
    const level = +name.slice(6);
    return { sync: true, comp: (raw) => deflateSync(raw, { level }), decomp: (s, n) => inflateSync(s, { out: new Uint8Array(n) }) };
  }
  if (name === 'cstream') {
    return {
      sync: false,
      comp: (raw) => collect(new Blob([raw.slice()]).stream().pipeThrough(new CompressionStream('deflate-raw'))),
      decomp: (s) => collect(new Blob([s]).stream().pipeThrough(new DecompressionStream('deflate-raw'))),
    };
  }
  const kind = KIND[name];
  if (kind === undefined) throw new Error(`no codec ${name}`);
  const inst = await WebAssembly.instantiate(await WebAssembly.compile(wasm), {});
  const ex = inst.exports;
  const cap = MAX * 2 + 4096;
  const src = ex.buf(cap), dst = ex.buf(cap);
  const mem = () => new Uint8Array(ex.memory.buffer);
  return {
    sync: true,
    crc: (u8) => { mem().set(u8, src); return ex.crc(src, u8.length) >>> 0; },
    // Straight from a (shared) view: copy in, compress, the frame's CRC in wasm, copy out.
    comp(raw) {
      mem().set(raw, src);
      const n = ex.comp(kind, src, raw.length, dst, cap);
      if (n < 0) throw new Error(`${name}: compress failed`);
      return mem().slice(dst, dst + n);
    },
    compCrc(raw) {
      mem().set(raw, src);
      const n = ex.comp(kind, src, raw.length, dst, cap);
      if (n < 0) throw new Error(`${name}: compress failed`);
      const crc = ex.crc(dst, n) >>> 0;
      return { bytes: mem().slice(dst, dst + n), crc };
    },
    decomp(s, rawLen) {
      mem().set(s, src);
      const n = ex.decomp(kind, src, s.length, dst, rawLen);
      if (n !== rawLen) throw new Error(`${name}: decompress gave ${n}, not ${rawLen}`);
      return mem().slice(dst, dst + n);
    },
  };
}

// The page's JS CRC (web/snapshot-file.ts), slicing-by-8.
const TABLE = (() => {
  const t = new Int32Array(8 * 256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    t[n] = c;
  }
  for (let n = 0; n < 256; n++) for (let k = 1; k < 8; k++) { const p = t[(k - 1) * 256 + n]; t[k * 256 + n] = (p >>> 8) ^ t[p & 255]; }
  return t;
})();
export function crc32(bytes, seed = 0) {
  const t = TABLE, n = bytes.length;
  let c = ~seed, i = 0;
  for (; i + 8 <= n; i += 8) {
    const a = c ^ (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24));
    c = t[1792 + (a & 255)] ^ t[1536 + ((a >>> 8) & 255)] ^ t[1280 + ((a >>> 16) & 255)] ^ t[1024 + (a >>> 24)] ^ t[768 + bytes[i + 4]] ^ t[512 + bytes[i + 5]] ^ t[256 + bytes[i + 6]] ^ t[bytes[i + 7]];
  }
  for (; i < n; i++) c = (c >>> 8) ^ t[(c ^ bytes[i]) & 255];
  return ~c >>> 0;
}
