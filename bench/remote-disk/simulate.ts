// A read cache replayed on a run's base-read trace (bench/remote-disk/boot.ts): aligned blocks of B bytes, an LRU of
// C bytes, read-ahead of the next A blocks when a read continues the last one; adjacent missing blocks are one
// request. Counts the requests and bytes each policy would fetch, and their time at a round trip of RTT ms and BW MB/s
// (no overlap: one request at a time, as the device worker reads). The guest's timing would move with the disk's, so
// this ranks policies, it doesn't predict a boot.
//   node bench/remote-disk/simulate.ts <run.json> [RTT=47] [BW=25]
import { readFileSync } from 'node:fs';

type Policy = { block: number; cache: number; ahead: number };

export function simulate(trace: number[], p: Policy) {
  const lru = new Map<number, true>(); // insertion order: least recent first
  const max = Math.max(1, Math.floor(p.cache / p.block));
  let requests = 0, bytes = 0, lastEnd = -1;
  const touch = (b: number) => { lru.delete(b); lru.set(b, true); if (lru.size > max) lru.delete(lru.keys().next().value!); };
  for (let i = 0; i < trace.length; i += 4) {
    const [off, len] = [trace[i + 1], trace[i + 2]];
    const first = Math.floor(off / p.block), last = Math.floor((off + len - 1) / p.block);
    const sequential = off === lastEnd || (lastEnd >= 0 && Math.floor(off / p.block) === Math.floor((lastEnd - 1) / p.block) + 1);
    lastEnd = off + len;
    const end = last + (sequential ? p.ahead : 0);
    let run = 0;
    for (let b = first; b <= end + 1; b++) {
      const missing = b <= end && !lru.has(b);
      if (missing) run++;
      else if (run) { requests++; bytes += run * p.block; run = 0; }
      if (b <= end) touch(b);
    }
  }
  return { requests, bytes };
}

if (import.meta.main) {
  const [file, rttArg, bwArg] = process.argv.slice(2);
  const r = JSON.parse(readFileSync(file, 'utf8')) as { io: { trace: number[] }; server?: { method: string; start: number; end: number }[] };
  const [rtt, bw] = [Number(rttArg ?? 47), Number(bwArg ?? 25) * 1e6];
  const est = (requests: number, bytes: number) => +((requests * rtt) / 1000 + bytes / bw).toFixed(1);
  const t = r.io.trace;
  let reads = 0, readBytes = 0;
  for (let i = 0; i < t.length; i += 4) { reads++; readBytes += t[i + 2]; }
  const rows: Record<string, unknown>[] = [{ policy: 'none (each read a request)', requests: reads, MB: +(readBytes / 1e6).toFixed(1), estS: est(reads, readBytes) }];
  for (const block of [64 << 10, 256 << 10, 1 << 20, 2 << 20, 4 << 20])
    for (const cache of [64 << 20, 256 << 20])
      for (const ahead of [0, 1, 4]) {
        const s = simulate(t, { block, cache, ahead });
        rows.push({ policy: `B ${block >> 10} KiB, C ${cache >> 20} MiB, ahead ${ahead}`, requests: s.requests, MB: +(s.bytes / 1e6).toFixed(1), estS: est(s.requests, s.bytes) });
      }
  console.table(rows);
}
