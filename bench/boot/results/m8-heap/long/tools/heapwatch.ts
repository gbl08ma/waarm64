// Ad hoc: the last mem.jsonl sample of each session under a directory (heap, block map, held bytes, decoded blocks).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
const dir = process.argv[2];
const M = 2 ** 20;
for (const d of readdirSync(dir)) {
  const f = `${dir}/${d}/mem.jsonl`;
  if (!existsSync(f)) continue;
  const lines = readFileSync(f, 'utf8').trim().split('\n');
  const j = JSON.parse(lines[lines.length - 1]);
  const m = j.memory;
  const w = existsSync(`${dir}/${d}/wall.txt`) ? readFileSync(`${dir}/${d}/wall.txt`, 'utf8').trim() : 'running';
  console.log(d, `n=${lines.length} live=${(m.heapLive / M) | 0} peak=${(m.heapPeak / M) | 0} keys=${m.jitKeys} keyMiB=${(m.jitKeyBytes / M) | 0} held=${(m.jitHeld / M) | 0} dec=${(j.jit.decBytes / M) | 0} known=${(j.jit.knownBytes / M) | 0} prunes=${j.jit.prunes} flushes=${j.jit.flushes} rescues=${j.jit.rescues} lag=${j.jit.lagFlushes} wasm=${(m.jitLiveBytes / M) | 0} | ${w}`);
}
