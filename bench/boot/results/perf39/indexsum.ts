// PERF loop 39: the block map's page index in a session's mem.jsonl(.gz) from diag.patch (gauge words 8-15 as
// `memory.pi`): at the heap's live maximum and at its mark's last rise, the index's parts in bytes.
//   node bench/boot/results/perf39/indexsum.ts <mem.jsonl[.gz]>...
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

type Row = { memory: { heapLive: number; heapPeak: number; jitKeys: number; jitKeyBytes: number; pi: number[] }; jit: { prunes: number; invalidations: number } };
const MiB = (b: number) => Math.round((b / 2 ** 20) * 100) / 100;
const out: Record<string, unknown> = {};
for (const f of process.argv.slice(2)) {
  const raw = readFileSync(f);
  const rows: Row[] = (f.endsWith('.gz') ? gunzipSync(raw) : raw).toString().trim().split('\n').map((l) => JSON.parse(l) as Row);
  const at = (r: Row) => {
    const m = r.memory;
    const [pages, table, lists, keys, one, few, headPages, headBytes] = m.pi;
    const index = table + lists + 8 * pages + headBytes;
    return {
      liveMiB: MiB(m.heapLive), markMiB: MiB(m.heapPeak), keys: m.jitKeys, mapAndIndexMiB: MiB(m.jitKeyBytes),
      indexMiB: MiB(index), ownPages: pages, keysPerPage: Math.round((keys / pages) * 10) / 10,
      pagesWith1: one, pagesWith2to4: few, ownTableMiB: MiB(table), ownListsMiB: MiB(lists),
      listBytesPerKey: Math.round((lists / keys) * 100) / 100, allocatorMiB: MiB(8 * pages),
      headPages, headsMiB: MiB(headBytes), prunes: r.jit.prunes, invalidations: r.jit.invalidations,
    };
  };
  const live = rows.reduce((a, r) => (r.memory.heapLive > a.memory.heapLive ? r : a));
  const markAt = rows.findIndex((r) => r.memory.heapPeak === rows[rows.length - 1].memory.heapPeak);
  out[f] = { samples: rows.length, atMaxLive: at(live), atMarkRise: at(rows[markAt]), beforeMarkRise: markAt > 0 ? at(rows[markAt - 1]) : undefined };
}
console.log(JSON.stringify(out, null, 1));
