// The full compaction after a trim (web/overlay.ts `compact`, as Devices.compact asks for it: docs/devices.md "Disk
// space handed back"), timed over OPFS at a GiB: an overlay with every block of a 1 GiB disk written, then 4 MiB of
// every 10 discarded (40%: under half free, so the discards compact nothing themselves), then `compact()`, which moves
// the blocks above the free slots down. It runs in one synchronous loop on the device worker, holding its other
// devices meanwhile (#263). A round each; the bytes the overlay's data took before and after are checked.
//   node bench/run.ts --page bench/io/index.html --input target/bench/io-raw.img --only io_compact
import type { Options, Sample } from '../spike/benchmarks.ts';
import { openOverlay, overlay, removeOverlay, type SyncFile } from '../../web/overlay.ts';
import { zeroDisk } from '../../web/stored.ts';

const NAME = 'bench-compact';
const ID = 'bench-compact';
const SIZE = 1 << 30;
const MiB = 1 << 20;

/** `f` with each call's count and time kept in `t` under `name.call` (`on`: only while it is true). */
function timed(f: SyncFile, name: string, t: Record<string, [number, number]>, on: () => boolean): SyncFile {
  const wrap = <A extends unknown[], R>(k: string, fn: (...a: A) => R) => (...a: A): R => {
    if (!on()) return fn(...a);
    const s = performance.now();
    const r = fn(...a);
    const e = (t[`${name}.${k}`] ??= [0, 0]);
    e[0]++;
    e[1] += performance.now() - s;
    return r;
  };
  return {
    read: wrap('read', (b: Uint8Array, o: { at: number }) => f.read(b, o)),
    write: wrap('write', (b: Uint8Array, o: { at: number }) => f.write(b, o)),
    getSize: () => f.getSize(),
    truncate: wrap('truncate', (n: number) => f.truncate(n)),
    flush: wrap('flush', () => f.flush()),
  };
}

export async function ioCompact(o: Options): Promise<Sample[]> {
  const rounds = o.quick ? 1 : 3;
  const ms: number[] = [];
  const moved: number[] = [];
  const buf = new Uint8Array(MiB);
  for (let i = 0; i < buf.length; i += 4) new DataView(buf.buffer).setUint32(i, Math.imul(i, 2654435761));
  for (let r = 0; r < rounds; r++) {
    await removeOverlay(NAME).catch(() => {});
    const files = await openOverlay(NAME, ID);
    try {
      const calls: Record<string, [number, number]> = {};
      let on = false;
      const d = overlay(zeroDisk(SIZE), timed(files.data, 'data', calls, () => on), timed(files.map, 'map', calls, () => on), files.meta);
      for (let off = 0; off < SIZE; off += MiB) {
        buf[0] = off / MiB;
        if (!(await d.write(off, buf))) throw new Error(`the write at MiB ${off / MiB} failed (quota: ${JSON.stringify(await navigator.storage.estimate())})`);
      }
      for (let off = 0; off < SIZE; off += 10 * MiB) if (!d.discard(off, Math.min(4 * MiB, SIZE - off))) throw new Error('a discard failed');
      d.flush();
      const before = files.data.getSize();
      const t = performance.now();
      on = true;
      if (!d.compact?.()) throw new Error('the compaction failed');
      on = false;
      ms.push(performance.now() - t);
      o.log?.(`compact calls: ${Object.entries(calls).map(([k, [n, ms]]) => `${k} ${n}× ${ms.toFixed(0)} ms`).join(', ')}`);
      const after = files.data.getSize();
      if (after >= before || after > 0.61 * SIZE) throw new Error(`the data file went from ${before} to ${after} bytes`);
      // The blocks moved: what was above the end (`after`) and held.
      moved.push((before - after) / MiB);
      for (const off of [6 * MiB, 1019 * MiB]) {
        const got = await d.read(off, MiB);
        if (!got || got[0] !== (off / MiB) % 256) throw new Error(`MiB ${off / MiB} differs after the compaction`);
      }
      o.log?.(`compact round ${r + 1}/${rounds}: ${ms[r].toFixed(0)} ms, the data file ${before / MiB} → ${after / MiB} MiB`);
    } finally {
      files.close();
    }
  }
  await removeOverlay(NAME).catch(() => {});
  const params = { disk: '1 GiB, every block written', discarded: '4 MiB of every 10 (40%)', opfs: 'an overlay' };
  return [
    { name: 'compact_full_ms', unit: 'ms', params, samples: ms },
    { name: 'compact_freed_mib', unit: 'MiB', params, samples: moved },
  ];
}
