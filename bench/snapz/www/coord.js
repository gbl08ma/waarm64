// The coordinator (the machine worker's stand-in): today's single-threaded save, or a pool's.
import { make, crc32 } from './codec.js';

let sab, frames, wasms;
const now = () => performance.now();

async function opfsSink(name) {
  const root = await navigator.storage.getDirectory();
  const h = await (await root.getFileHandle(name, { create: true })).createSyncAccessHandle();
  h.truncate(0);
  let at = 0;
  return {
    write(b) { h.write(b, { at }); at += b.length; },
    close() { h.flush(); h.close(); },
  };
}
const nullSink = () => ({ write() {}, close() {} });

function pick(sample, tags = [0]) {
  return frames.filter((f, i) => tags.includes(f.tag) && i % sample === 0);
}

// Today's shape: one thread scans, compresses, CRCs (JS) and writes each frame, in order.
async function single(m) {
  const c = await make(m.codec, wasms[m.wasm ?? 'plain']);
  const list = pick(m.sample ?? 1, m.tags);
  const sink = m.sink === 'opfs' ? await opfsSink('bench.out') : nullSink();
  const packed = [];
  // Warm-up: the module is new, so its functions start in V8's baseline tier.
  for (const f of list.slice(0, m.warm ?? 64)) { const v = sab.subarray(f.off, f.off + f.len); const b = await c.comp(v); if (m.decomp && b.length < v.length) await c.decomp(b, f.len); }
  let raw = 0, stored = 0, compMs = 0, crcMs = 0, writeMs = 0;
  const t0 = now();
  for (const f of list) {
    const view = sab.subarray(f.off, f.off + f.len);
    let t = now();
    let b = await c.comp(view);
    compMs += now() - t;
    if (b.length >= view.length) b = view.slice();
    t = now();
    crc32(b);
    crcMs += now() - t;
    t = now();
    sink.write(b);
    writeMs += now() - t;
    raw += f.len; stored += b.length;
    if (m.decomp) packed.push(b);
  }
  sink.close();
  const wallMs = now() - t0;
  let decompMs = 0, dcrcMs = 0;
  if (m.decomp) {
    const out = new Uint8Array(1 << 21);
    const t = now();
    for (let i = 0; i < list.length; i++) {
      const s = packed[i];
      let tt = now();
      crc32(s);
      dcrcMs += now() - tt;
      const d = s.length === list[i].len ? s : await c.decomp(s, list[i].len);
      out.set(d.subarray(0, Math.min(d.length, out.length)));
      // spot check
      const o = list[i].off;
      if (d[0] !== sab[o] || d[d.length - 1] !== sab[o + d.length - 1] || d[d.length >> 1] !== sab[o + (d.length >> 1)]) throw new Error(`${m.codec}: frame ${i} differs`);
    }
    decompMs = now() - t - dcrcMs;
  }
  return { codec: m.codec, frames: list.length, raw, stored, ratio: raw / stored, wallMs, compMs, crcMs, writeMs, decompMs, dcrcMs, compMBs: raw / 1e3 / compMs, decompMBs: raw / 1e3 / decompMs };
}

// A pool: frames dealt to `n` workers (chunk c to worker c mod n), `window` in flight each, written in order.
async function pool(m) {
  const n = m.n;
  const workers = await Promise.all(Array.from({ length: n }, () => new Promise((res) => {
    const w = new Worker(new URL('./pool.js', import.meta.url), { type: 'module' });
    w.onmessage = (e) => { if (e.data.type === 'ready') res(w); };
    w.postMessage({ type: 'init', codec: m.codec, wasm: wasms[m.wasm ?? 'plain'], sab: sab.buffer });
  })));
  const list = pick(m.sample ?? 1, m.tags);
  const sink = m.sink === 'opfs' ? await opfsSink('bench.out') : nullSink();
  const window = m.window ?? 3;
  const results = new Array(list.length);
  let next = 0, written = 0, stored = 0, raw = 0;
  const packedSizes = [];
  const t0 = now();
  await new Promise((done, fail) => {
    const send = (k) => {
      const i = next++;
      if (i >= list.length) return;
      const f = list[i];
      workers[i % n].postMessage({ type: 'comp', id: i, off: f.off, len: f.len, crc: m.crc ?? 'wasm' });
    };
    const flush = () => {
      while (written < list.length && results[written]) {
        const r = results[written];
        sink.write(r.bytes);
        stored += r.bytes.length; raw += list[written].len;
        packedSizes.push(r.bytes.length);
        results[written] = true; // drop the bytes
        written++;
        send();
      }
      if (written === list.length) done();
    };
    for (const w of workers) {
      w.onmessage = (e) => { results[e.data.id] = e.data; flush(); };
      w.onerror = (e) => fail(new Error(e.message));
    }
    for (let k = 0; k < n * window; k++) send();
  });
  sink.close();
  const wallMs = now() - t0;
  for (const w of workers) w.terminate();
  return { codec: m.codec, n, window, sink: m.sink ?? 'none', frames: list.length, raw, stored, ratio: raw / stored, wallMs, MBs: raw / 1e3 / wallMs };
}

// A pool's restore: every frame packed first (not timed), then dealt to `n` workers that unpack into a shared "RAM".
async function restorePool(m) {
  const c = await make(m.codec, wasms[m.wasm ?? 'plain']);
  const list = pick(m.sample ?? 1, m.tags);
  const packed = list.map((f) => { const v = sab.subarray(f.off, f.off + f.len); const b = c.comp(v); return b.length >= v.length ? v.slice() : b; });
  const total = packed.reduce((a, b) => a + b.length, 0);
  const psab = new Uint8Array(new SharedArrayBuffer(total));
  const offs = [];
  let at = 0;
  for (const p of packed) { offs.push(at); psab.set(p, at); at += p.length; }
  const rawTotal = list.reduce((a, f) => a + f.len, 0);
  const outSab = new SharedArrayBuffer(rawTotal);
  const n = m.n;
  const workers = await Promise.all(Array.from({ length: n }, () => new Promise((res) => {
    const w = new Worker(new URL('./pool.js', import.meta.url), { type: 'module' });
    w.onmessage = (e) => { if (e.data.type === 'ready') res(w); };
    w.postMessage({ type: 'init', codec: m.codec, wasm: wasms[m.wasm ?? 'plain'], sab: psab.buffer, out: outSab });
  })));
  const dsts = [];
  at = 0;
  for (const f of list) { dsts.push(at); at += f.len; }
  const window = m.window ?? 3;
  let next = 0, finished = 0;
  const t0 = now();
  await new Promise((done) => {
    const send = () => {
      const i = next++;
      if (i >= list.length) return;
      workers[i % n].postMessage({ type: 'decomp', id: i, off: offs[i], len: packed[i].length, raw: list[i].len, dst: dsts[i], crc: m.crc ?? 'wasm' });
    };
    for (const w of workers) w.onmessage = () => { finished++; if (finished === list.length) done(); else send(); };
    for (let k = 0; k < n * window; k++) send();
  });
  const wallMs = now() - t0;
  for (const w of workers) w.terminate();
  const o = new Uint8Array(outSab);
  for (let i = 0; i < list.length; i += 97) if (o[dsts[i] + 100] !== sab[list[i].off + 100]) throw new Error('restore differs');
  return { codec: m.codec, n, frames: list.length, raw: rawTotal, stored: total, wallMs, MBs: rawTotal / 1e3 / wallMs };
}

async function opfsBench() {
  const root = await navigator.storage.getDirectory();
  const h = await (await root.getFileHandle('rd.bin', { create: true })).createSyncAccessHandle();
  const N = 12288, B = 4096;
  const big = sab.slice(0, N * B);
  h.truncate(0); h.write(big, { at: 0 }); h.flush();
  const out = new Uint8Array(B);
  const r = {};
  let t = now();
  for (let i = 0; i < N; i++) h.read(out, { at: i * B });
  r.seq4kMs = now() - t;
  const perm = Array.from({ length: N }, (_, i) => i).sort(() => Math.random() - 0.5);
  t = now();
  for (const i of perm) h.read(out, { at: i * B });
  r.rand4kMs = now() - t;
  const one = new Uint8Array(N * B);
  t = now();
  h.read(one, { at: 0 });
  r.oneReadMs = now() - t;
  const mib = new Uint8Array(1 << 20);
  t = now();
  for (let o = 0; o < N * B; o += 1 << 20) h.read(mib, { at: o });
  r.mibReadsMs = now() - t;
  // writes: 4 KiB at a time, and 1 MiB
  t = now();
  for (let i = 0; i < N; i++) h.write(big.subarray(i * B, (i + 1) * B), { at: i * B });
  r.write4kMs = now() - t;
  t = now();
  for (let o = 0; o < N * B; o += 1 << 20) h.write(big.subarray(o, o + (1 << 20)), { at: o });
  h.flush();
  r.write1mMs = now() - t;
  h.close();
  await root.removeEntry('rd.bin');
  return { MB: N * B / 1e6, ...r };
}

async function clusters(m) {
  // Disk-like and RAM-like bytes cut into clusters; zero-ish ones skipped (qemu-img stores those as zero clusters).
  const C = m.size;
  const all = [];
  for (const f of frames) {
    if (f.tag === 2) continue;
    for (let o = 0; o + C <= f.len && all.length < m.count; o += C * 3) {
      const v = sab.subarray(f.off + o, f.off + o + C);
      let nz = 0; for (let i = 0; i < C; i += 64) nz |= v[i];
      if (nz) all.push(v.slice());
    }
    if (all.length >= m.count) break;
  }
  const { deflateSync, inflateSync } = await import('./fflate.js');
  const res = { size: C, clusters: all.length };
  const mz = await make('miniz6', wasms.plain);
  const mz1 = await make('miniz1', wasms.plain);
  if (m.op === 'inflate') {
    const packed = all.map((v) => deflateSync(v, { level: 6 }));
    res.ratio = all.length * C / packed.reduce((a, b) => a + b.length, 0);
    const runs = {
      dstream: async () => { for (const p of packed) await collect(new Blob([p]).stream().pipeThrough(new DecompressionStream('deflate-raw'))); },
      fflate: async () => { for (const p of packed) inflateSync(p, { out: new Uint8Array(C) }); },
      miniz: async () => { for (const p of packed) mz.decomp(p, C); },
    };
    for (const [k, f] of Object.entries(runs)) { await f(); const t = now(); await f(); res[k + 'UsPer'] = (now() - t) * 1000 / packed.length; }
  } else {
    const runs = {
      cstream: async () => { let n = 0; for (const v of all) n += (await collect(new Blob([v]).stream().pipeThrough(new CompressionStream('deflate-raw')))).length; return n; },
      fflate6: async () => { let n = 0; for (const v of all) n += deflateSync(v, { level: 6 }).length; return n; },
      fflate1: async () => { let n = 0; for (const v of all) n += deflateSync(v, { level: 1 }).length; return n; },
      miniz6: async () => { let n = 0; for (const v of all) n += mz.comp(v).length; return n; },
      miniz1: async () => { let n = 0; for (const v of all) n += mz1.comp(v).length; return n; },
    };
    for (const [k, f] of Object.entries(runs)) { await f(); const t = now(); const n = await f(); res[k + 'UsPer'] = (now() - t) * 1000 / all.length; res[k + 'Ratio'] = all.length * C / n; }
  }
  return res;
}
async function collect(stream) {
  const r = stream.getReader(); const parts = []; let n = 0;
  for (;;) { const { done, value } = await r.read(); if (done) break; parts.push(value); n += value.length; }
  const out = new Uint8Array(n); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out;
}
async function writable(m) {
  // The picked file's stream (FileSystemWritableFileStream; here on an OPFS file, as on a picked one), frames of `chunk` bytes awaited in turn.
  const root = await navigator.storage.getDirectory();
  const fh = await root.getFileHandle('w.bin', { create: true });
  const total = m.mb * 1e6, chunk = m.chunk;
  const res = {};
  for (const mode of ['await', 'pipelined']) {
    const w = await fh.createWritable();
    const t = now();
    let pend = [];
    for (let o = 0; o < total; o += chunk) {
      const b = sab.slice(o, o + chunk);
      if (mode === 'await') await w.write(b);
      else { pend.push(w.write(b)); if (pend.length > 8) await pend.shift(); }
    }
    await Promise.all(pend);
    const wrote = now() - t;
    await w.close();
    res[mode + 'WriteMs'] = wrote; res[mode + 'CloseMs'] = now() - t - wrote;
  }
  await root.removeEntry('w.bin');
  return { MB: m.mb, chunk, ...res };
}

async function crcBench() {
  const c = await make('core', wasms.plain);
  const v = sab.subarray(0, Math.min(sab.length, 256 << 20));
  let t = now(); crc32(v); const js = now() - t;
  // wasm: in 1 MiB pieces (it copies into its memory first, as a frame would be there already)
  t = now();
  for (let o = 0; o < v.length; o += 1 << 20) c.crc(v.subarray(o, o + (1 << 20)));
  const wasm = now() - t;
  return { MB: v.length / 1e6, jsMBs: v.length / 1e3 / js, wasmMBs: v.length / 1e3 / wasm };
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') { sab = new Uint8Array(m.sab); frames = m.frames; wasms = m.wasms; self.postMessage({ ok: true }); return; }
    const r = m.type === 'single' ? await single(m) : m.type === 'pool' ? await pool(m) : m.type === 'restore' ? await restorePool(m) : m.type === 'opfs' ? await opfsBench() : m.type === 'clusters' ? await clusters(m) : m.type === 'writable' ? await writable(m) : await crcBench();
    self.postMessage({ ok: true, r });
  } catch (err) {
    self.postMessage({ ok: false, error: String(err?.stack ?? err) });
  }
};
