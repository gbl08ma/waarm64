// Ad hoc: per session under a directory, the maxima of mem.jsonl's heap accounting, and the breakdown at the sample
// where the heap's live bytes were highest. MiB.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
const dir = process.argv[2];
const M = 2 ** 20;
const out: Record<string, unknown> = {};
for (const d of readdirSync(dir).sort()) {
  const f = `${dir}/${d}/mem.jsonl`;
  if (!existsSync(f)) continue;
  const rows = readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.memory);
  const max = (g: (r: any) => number) => Math.max(...rows.map(g));
  const at = rows.reduce((a, r) => (r.memory.heapLive > a.memory.heapLive ? r : a));
  const b = (r: any) => {
    const m = r.memory, j = r.jit;
    const parts = { map: m.jitKeyBytes, held: m.jitHeld, decoded: j.decBytes, known: j.knownBytes };
    const rest = m.heapLive - Object.values(parts).reduce((a: number, x: number) => a + x, 0);
    return Object.fromEntries(Object.entries({ live: m.heapLive, ...parts, rest }).map(([k, v]) => [k, Math.round((v as number) / M)]));
  };
  out[d] = {
    samples: rows.length,
    seconds: Math.round((rows[rows.length - 1].t - rows[0].t) / 1000),
    maxLive: Math.round(max((r) => r.memory.heapLive) / M),
    peak: Math.round(rows[rows.length - 1].memory.heapPeak / M),
    maxKeys: max((r) => r.memory.jitKeys),
    maxKeyMiB: Math.round(max((r) => r.memory.jitKeyBytes) / M),
    maxHeldMiB: Math.round(max((r) => r.memory.jitHeld) / M),
    maxDecMiB: Math.round(max((r) => r.jit.decBytes) / M),
    maxKnownMiB: Math.round(max((r) => r.jit.knownBytes) / M),
    flushes: rows[rows.length - 1].jit.flushes,
    prunes: rows[rows.length - 1].jit.prunes,
    rescues: rows[rows.length - 1].jit.rescues,
    lagFlushes: rows[rows.length - 1].jit.lagFlushes,
    decClears: rows[rows.length - 1].jit.decClears,
    decoded: rows[rows.length - 1].jit.decoded,
    atMaxLive: b(at),
  };
}
console.log(JSON.stringify(out, null, 1));
