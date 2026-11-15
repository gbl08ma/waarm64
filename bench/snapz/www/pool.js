// A pool worker: compresses (or decompresses) frames read straight from the shared corpus.
import { make, crc32 } from './codec.js';

let c, sab, out;
self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    c = await make(m.codec, m.wasm);
    sab = new Uint8Array(m.sab);
    out = m.out && new Uint8Array(m.out);
    self.postMessage({ type: 'ready' });
    return;
  }
  if (m.type === 'comp') {
    const raw = sab.subarray(m.off, m.off + m.len);
    let bytes, crc;
    if (c.compCrc && m.crc === 'wasm') ({ bytes, crc } = c.compCrc(raw));
    else { bytes = await c.comp(raw); crc = crc32(bytes); }
    if (bytes.length >= raw.length) { bytes = raw.slice(); crc = crc32(bytes); }
    self.postMessage({ type: 'done', id: m.id, bytes, crc }, [bytes.buffer]);
    return;
  }
  if (m.type === 'decomp') {
    // A restore's frame: unpacked straight into the shared output (guest RAM's stand-in).
    const s = sab.subarray(m.off, m.off + m.len);
    const d = m.len === m.raw ? s : await c.decomp(s, m.raw);
    if (m.crc === 'wasm' && c.crc) c.crc(s); else crc32(s);
    out.set(d, m.dst);
    self.postMessage({ type: 'done', id: m.id });
  }
};
