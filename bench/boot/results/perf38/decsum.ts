// Ad hoc (PERF loop 38; `node decsum.ts <dir>`): per session under a directory, from mem.jsonl (MEMLOG) the heap's live bytes and mark, and
// per vCPU (the diagnostic build's `cpus`) the decoded blocks' bytes at most, its clears (and those by the keys: the
// diagnostic's `rescues`), blocks decoded and steps interpreted. MiB.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
const dir = process.argv[2];
const M = 2 ** 20;
const out: Record<string, unknown> = {};
for (const d of readdirSync(dir).sort()) {
  const f = `${dir}/${d}/mem.jsonl`;
  if (!existsSync(f)) continue;
  const rows = readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.memory);
  const last = rows[rows.length - 1];
  const max = (g: (r: any) => number) => Math.max(...rows.map(g));
  const ncpu = last.cpus?.length ?? 0;
  const cpus = [];
  for (let i = 0; i < ncpu; i++) {
    const c = last.cpus[i];
    cpus.push({
      maxDecMiB: Math.round(max((r) => r.cpus?.[i]?.decBytes ?? 0) / M),
      clears: c.decClears,
      byKeys: c.rescues,
      decodedM: +(c.decoded / 1e6).toFixed(2),
      decG: +(c.decSteps / 1e9).toFixed(2),
    });
  }
  out[d] = {
    samples: rows.length,
    seconds: Math.round((last.t - rows[0].t) / 1000),
    maxLive: Math.round(max((r) => r.memory.heapLive) / M),
    mark: Math.round(last.memory.heapPeak / M),
    maxDecMiB: Math.round(max((r) => r.jit.decBytes) / M),
    maxMapMiB: Math.round(max((r) => r.memory.jitKeyBytes) / M),
    maxKnownMiB: Math.round(max((r) => r.jit.knownBytes) / M),
    flushes: last.jit.flushes,
    decClears: last.jit.decClears,
    decodedM: +(last.jit.decoded / 1e6).toFixed(2),
    cpus,
  };
}
console.log(JSON.stringify(out, null, 1));
