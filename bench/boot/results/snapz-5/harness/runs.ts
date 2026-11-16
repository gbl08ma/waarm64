// Ad-hoc: a snapshot's DISK frames: how many, their lengths, zero blocks, and runs after merging adjacent frames.
import { openReadStream } from '../../../../snapz/fsread.ts';
import { openSnapshot } from '../../../../../web/snapshot-file.ts';
import { lzCodec } from '../../../../../web/lz.ts';
import { readFileSync } from 'node:fs';
const codec = await lzCodec(readFileSync(new URL('../../../../../target/wasm32-unknown-unknown/release/waarm64_core.wasm', import.meta.url)));
const s = await openSnapshot(openReadStream(process.argv[2]), { codec });
let frames = 0, blocks = 0, zeros = 0, runs = 0, zeroRuns = 0, dataRuns = 0;
let prevEnd = -1, prevZero: boolean | undefined;
const hist: Record<number, number> = {};
for await (const f of s.frames()) {
  if (f.tag !== 'DISK') continue;
  frames++;
  const n = f.data.length / 4096;
  hist[n] = (hist[n] ?? 0) + 1;
  if (f.index !== prevEnd) runs++;
  for (let k = 0; k < n; k++) {
    const b = f.data.subarray(k * 4096, (k + 1) * 4096);
    const z = b.every((x) => x === 0);
    if (z) zeros++;
    const contiguous = k > 0 || f.index === prevEnd;
    if (!contiguous || z !== prevZero) { if (z) zeroRuns++; else dataRuns++; }
    prevZero = z;
  }
  blocks += n;
  prevEnd = f.index + n;
}
const top = Object.entries(hist).sort((a, b) => b[1] - a[1]).slice(0, 12);
console.log(JSON.stringify({ frames, blocks, zeros, runs, zeroRuns, dataRuns, top }));
