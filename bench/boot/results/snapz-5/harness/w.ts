// Ad-hoc harness worker (SNAPZ loop 5): a restore's disk phase over OPFS, by arm, with the OPFS calls timed.
import { openSnapshot, diskBlocks } from '../../../../../web/snapshot-file.ts';
import { lzCodec } from '../../../../../web/lz.ts';
import { openOverlay, overlay, removeOverlay, writeMeta, type SyncFile } from '../../../../../web/overlay.ts';
import { zeroDisk } from '../../../../../web/stored.ts';
import { isZero } from '../../../../../web/qcow2-write.ts';

const SLOT = 2 ** 40, BLOCK = 4096;
type T = Record<string, { n: number; ms: number }>;
const timed = (f: SyncFile, name: string, t: T): SyncFile => {
  const wrap = <A extends unknown[], R>(op: string, g: (...a: A) => R) => (...a: A) => {
    const s = performance.now();
    try { return g(...a); } finally { const k = (t[`${name}.${op}`] ??= { n: 0, ms: 0 }); k.n++; k.ms += performance.now() - s; }
  };
  return { read: wrap('read', (b, o) => f.read(b, o)), write: wrap('write', (b, o) => f.write(b, o)), getSize: wrap('getSize', () => f.getSize()), truncate: wrap('truncate', (n) => f.truncate(n)), flush: wrap('flush', () => f.flush()) };
};
let codec: Awaited<ReturnType<typeof lzCodec>>;
self.onmessage = async (e) => {
  const { arm, file } = e.data as { arm: string; file: string };
  try {
    codec ??= await lzCodec(await (await fetch('/target/wasm32-unknown-unknown/release/waarm64_core.wasm')).arrayBuffer());
    const blob = await (await fetch(file)).blob();
    const name = 'snapz5/bench';
    const t: T = {};
    const out: Record<string, number | string> = { arm };
    let at = performance.now();
    const lap = (k: string) => { const n = performance.now(); out[k] = n - at; at = n; };
    const s = await openSnapshot(blob, { codec });
    const disk = (s.header.disks as { slot: number; size: number }[])[0];
    const frames = s.frames();
    let next = await frames.next();
    while (!next.done && next.value.tag !== 'DISK') next = await frames.next();
    lap('head');
    await removeOverlay(name).catch(() => {});
    lap('remove');
    const files = await openOverlay(name, 'x');
    if (!writeMeta(files.meta, { generation: 1, merging: '', size: disk.size })) throw new Error('meta');
    lap('open');
    const o = overlay(zeroDisk(disk.size), timed(files.data, 'data', t), timed(files.map, 'map', t), undefined, 0, { ordered: arm !== 'runu' });
    let decode = 0, zero = 0, calls = 0, iz = 0;
    for (; !next.done; ) {
      const { index, data } = next.value;
      const b0 = index % SLOT;
      if (arm === 'block') {
        for (const { block, data: bytes } of diskBlocks(b0, data)) {
          const off = block * BLOCK;
          const part = bytes.subarray(0, Math.min(BLOCK, disk.size - off));
          const z0 = performance.now(); const z = isZero(part); iz += performance.now() - z0;
          calls++;
          if (!(await (z ? o.zero(off, part.length) : o.write(off, part)))) throw new Error('write');
          if (z) zero++;
        }
      } else {
        // runs: consecutive blocks of one kind (data or zeros) in one call
        const n = data.length / BLOCK;
        const kinds: boolean[] = [];
        const z0 = performance.now();
        for (let k = 0; k < n; k++) kinds.push(isZero(data.subarray(k * BLOCK, (k + 1) * BLOCK)));
        iz += performance.now() - z0;
        for (let k = 0; k < n;) {
          let j = k + 1;
          while (j < n && kinds[j] === kinds[k]) j++;
          const off = (b0 + k) * BLOCK;
          const len = Math.min((j - k) * BLOCK, disk.size - off);
          calls++;
          if (!(await (kinds[k] ? o.zero(off, len) : o.write(off, data.subarray(k * BLOCK, k * BLOCK + len))))) throw new Error('write');
          if (kinds[k]) zero += j - k;
          k = j;
        }
      }
      const d0 = performance.now();
      next = await frames.next();
      decode += performance.now() - d0;
    }
    o.flush();
    lap('write');
    out.decode = decode; out.isZero = iz; out.calls = calls; out.zeroBlocks = zero;
    // The save's read: every block back, one at a time vs batched
    const list = [...o.written()];
    const r0 = performance.now();
    for (const b of list) if (!o.block(b)) throw new Error('read');
    out.readEach = performance.now() - r0;
    const r1 = performance.now();
    let runs = 0;
    for (let i = 0; i < list.length;) {
      let j = i + 1;
      while (j < list.length && list[j] === list[j - 1] + 1 && j - i < 256) j++;
      const off = list[i] * BLOCK;
      if (!(await o.read(off, Math.min((j - i) * BLOCK, disk.size - off)))) throw new Error('read');
      runs++;
      i = j;
    }
    out.readRuns = performance.now() - r1; out.readCalls = runs;
    files.close();
    for (const [k, v] of Object.entries(t)) { out[`${k}.n`] = v.n; out[`${k}.ms`] = v.ms; }
    out.dataSize = 0;
    self.postMessage({ ok: true, out });
  } catch (err) {
    self.postMessage({ ok: false, error: String((err as Error)?.stack ?? err) });
  }
};
