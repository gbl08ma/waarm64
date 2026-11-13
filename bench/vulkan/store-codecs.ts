// VK4 T49's follow-up (bench/vulkan/REPORT.md "VK4 T49 follow-up"): the codecs a shader store held compressed could use,
// on real programs' stores (bench/vulkan/store-dump.ts: Godot's editor's, vkQuake's). For each codec: what the entries
// take held, each entry's encode (a put) and decode (a lookup, synchronous) in ms, medians of REPS, and their totals.
//   node bench/vulkan/store-codecs.ts <out.json> <name>=<shader-store.json>...   (REPS, default 7; FZSTD: fzstd's
//   entry file, e.g. node_modules/fzstd/esm/index.mjs of an `npm i fzstd` in a scratch directory: not a dependency;
//   FFLATE likewise, the repository's fflate otherwise)
import { readFileSync, writeFileSync } from 'node:fs';
import { constants, deflateRawSync, inflateRawSync, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { lzCodec } from '../../web/lz.ts';
import type { DumpedEntry } from './store-dump.ts';

const [out, ...inputs] = process.argv.slice(2);
if (!out || !inputs.length) throw new Error('usage: store-codecs.ts <out.json> <name>=<shader-store.json>...');
const REPS = Number(process.env.REPS ?? 7);
type Sync = (b: Uint8Array) => Uint8Array;
const fflate = await import(process.env.FFLATE ?? 'fflate') as { deflateSync(b: Uint8Array, o?: { level?: number }): Uint8Array; inflateSync(b: Uint8Array, o?: { out?: Uint8Array }): Uint8Array };
const fzstd = await import(process.env.FZSTD ?? 'fzstd') as { decompress(b: Uint8Array, out?: Uint8Array): Uint8Array };
const lz = await lzCodec(readFileSync(new URL('../../target/wasm32-unknown-unknown/release/waarm64_core.wasm', import.meta.url)));

/** The LZ4 block format's decoder in JavaScript (core/src/lz.rs's format), into `out` of the raw length. */
function lz4Decode(src: Uint8Array, out: Uint8Array): Uint8Array {
  let s = 0, d = 0;
  while (s < src.length) {
    const t = src[s++];
    let l = t >> 4;
    if (l === 15) { let b; do { b = src[s++]; l += b; } while (b === 255); }
    out.set(src.subarray(s, s + l), d);
    s += l; d += l;
    if (s >= src.length) break;
    const off = src[s] | (src[s + 1] << 8);
    s += 2;
    let m = t & 15;
    if (m === 15) { let b; do { b = src[s++]; m += b; } while (b === 255); }
    m += 4;
    let p = d - off;
    if (off >= m && m > 32) { out.copyWithin(d, p, p + m); d += m; } else { const e = d + m; while (d < e) out[d++] = out[p++]; }
  }
  if (d !== out.length) throw new Error('lz4: short');
  return out;
}

type Codec = { name: string; encode: Sync; decode: (packed: Uint8Array, rawLen: number) => Uint8Array; note: string };
const sync = <T>(p: Promise<T>) => p as unknown as T; // lzCodec's calls are synchronous under their async face: awaited below
const codecs: Codec[] = [
  { name: 'deflate-raw, fflate 6', encode: (b) => fflate.deflateSync(b, { level: 6 }), decode: (p, n) => fflate.inflateSync(p, { out: new Uint8Array(n) }), note: 'fflate inflateSync' },
  { name: 'deflate-raw, fflate 9', encode: (b) => fflate.deflateSync(b, { level: 9 }), decode: (p, n) => fflate.inflateSync(p, { out: new Uint8Array(n) }), note: 'fflate inflateSync' },
  { name: 'deflate-raw, zlib 6 (native, reference)', encode: (b) => deflateRawSync(b), decode: (p) => inflateRawSync(p), note: "Node's zlib: not in a browser" },
  { name: 'lz4 block, the core\'s LZ (wasm)', encode: () => new Uint8Array(), decode: () => new Uint8Array(), note: 'web/lz.ts' },
  { name: 'lz4 block, the core\'s LZ, decoded in JS', encode: () => new Uint8Array(), decode: (p, n) => lz4Decode(p, new Uint8Array(n)), note: 'a JS decoder' },
  { name: 'zstd 3, decoded by fzstd', encode: (b) => zstdCompressSync(b, { params: { [constants.ZSTD_c_compressionLevel]: 3 } }), decode: (p, n) => fzstd.decompress(p, new Uint8Array(n)), note: "encoded by Node's zstd (a browser would need a wasm build)" },
  { name: 'zstd 19, decoded by fzstd', encode: (b) => zstdCompressSync(b, { params: { [constants.ZSTD_c_compressionLevel]: 19 } }), decode: (p, n) => fzstd.decompress(p, new Uint8Array(n)), note: "encoded by Node's zstd" },
  { name: 'zstd 3, native (reference)', encode: (b) => zstdCompressSync(b, { params: { [constants.ZSTD_c_compressionLevel]: 3 } }), decode: (p) => zstdDecompressSync(p), note: "Node's zstd: not in a browser" },
];

const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
const ms = (f: () => unknown) => { const t = performance.now(); f(); return performance.now() - t; };
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const results: Record<string, unknown> = { node: process.version, reps: REPS, stores: {} };

for (const arg of inputs) {
  const i = arg.indexOf('='), name = arg.slice(0, i), file = arg.slice(i + 1);
  const dumped = JSON.parse(readFileSync(file, 'utf8')) as DumpedEntry[];
  const entries = dumped.map((e) => {
    const stored = new Uint8Array(Buffer.from(e.b64, 'base64'));
    return { stored, raw: new Uint8Array(e.packed ? inflateRawSync(stored) : stored) };
  });
  const raw = entries.reduce((n, e) => n + e.raw.length, 0);
  const store: Record<string, unknown> = {
    entries: entries.length, raw, stored: entries.reduce((n, e) => n + e.stored.length, 0),
    largest: Math.max(...entries.map((e) => e.raw.length)), rawMedian: median(entries.map((e) => e.raw.length)), codecs: {},
  };
  (results.stores as Record<string, unknown>)[name] = store;
  for (const c of codecs) {
    const enc: number[] = [], dec: number[] = [];
    let held = 0;
    for (const e of entries) {
      let packed: Uint8Array;
      if (c.name.startsWith('lz4')) {
        const t = performance.now();
        packed = await lz.compress(e.raw);
        enc.push(performance.now() - t);
      } else {
        const times: number[] = [];
        packed = c.encode(e.raw);
        for (let r = 0; r < Math.min(REPS, 3); r++) times.push(ms(() => c.encode(e.raw)));
        enc.push(median(times));
      }
      // One that doesn't shrink is held as it is (as the store does).
      const kept = packed.length < e.raw.length;
      held += kept ? packed.length : e.raw.length;
      if (!kept) { dec.push(0); continue; }
      const back = c.name === "lz4 block, the core's LZ (wasm)" ? await lz.decompress(packed, e.raw.length) : c.decode(packed, e.raw.length);
      if (Buffer.compare(back, e.raw)) throw new Error(`${c.name}: an entry doesn't come back whole`);
      const times: number[] = [];
      for (let r = 0; r < REPS; r++) {
        if (c.name === "lz4 block, the core's LZ (wasm)") { const t = performance.now(); sync(lz.decompress(packed, e.raw.length)); times.push(performance.now() - t); }
        else times.push(ms(() => c.decode(packed, e.raw.length)));
      }
      dec.push(median(times));
    }
    const worst = dec.indexOf(Math.max(...dec));
    (store.codecs as Record<string, unknown>)[c.name] = {
      note: c.note, held, ratio: r3(raw / held),
      decodeMs: { median: r3(median(dec)), worst: r3(dec[worst]), worstRaw: entries[worst].raw.length, total: r3(dec.reduce((a, b) => a + b, 0)) },
      encodeMs: { median: r3(median(enc)), worst: r3(Math.max(...enc)), total: r3(enc.reduce((a, b) => a + b, 0)) },
      decodeMBps: r3(raw / 1e3 / dec.reduce((a, b) => a + b, 0)),
    };
    const x = (store.codecs as Record<string, { held: number; ratio: number; decodeMs: { median: number; worst: number; total: number }; encodeMs: { total: number } }>)[c.name];
    console.log(`${name.padEnd(8)} ${c.name.padEnd(42)} held ${(held / 1e6).toFixed(2)} MB (${x.ratio}x)  decode median ${x.decodeMs.median} worst ${x.decodeMs.worst} total ${x.decodeMs.total.toFixed(1)} ms  encode total ${x.encodeMs.total.toFixed(0)} ms`);
  }
  console.log(`${name}: ${entries.length} entries, ${(raw / 1e6).toFixed(2)} MB raw, ${((store.stored as number) / 1e6).toFixed(2)} MB stored, largest ${store.largest}`);
}
writeFileSync(out, JSON.stringify(results, null, 1) + '\n');
