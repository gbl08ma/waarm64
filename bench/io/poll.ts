// What `Devices.poll` costs a request (PERF loop 91; dev-only): web/devices.ts's poll over a request ring holding as
// many requests as fit, of one read segment, or two read and one write (a blk request's shape), taken by a backend that
// answers later (no completion). ns a request, ROUNDS rounds; medians and IQR; JSON on stdout. An A/B is this run on
// each tree.
//   node bench/io/poll.ts [rounds]
import { Devices } from '../../web/devices.ts';

const ROUNDS = Number(process.argv[2] ?? 11);
const WORDS = 4096; // the request ring's (docs/abi.md)
const memory = { buffer: new SharedArrayBuffer(1 << 16) };
const u32 = new Uint32Array(memory.buffer);
const ring = 280 / 4;
let sink = 0;
const backend = {
  reset() {},
  request: (r: { read: unknown[]; write: unknown[] }) => {
    sink += r.read.length + r.write.length;
    return undefined;
  },
};
const proto = Devices.prototype as unknown as Record<string, unknown>;
const self = {
  memory,
  shared: [0],
  signal: 40_000,
  wakes: [],
  stops: [],
  backends: [backend],
  epochs: [0],
  deterministic: true,
  detached: new Set(),
  ramAt: 0,
  spillViews: [],
  kickOwed: false,
  kick: proto.kick,
  views: proto.views,
  complete: proto.complete,
};
const poll = Devices.prototype.poll as (this: unknown) => Promise<void>;
const stats = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  const q = (p: number) => s[Math.floor((s.length - 1) * p)];
  return { median: q(0.5), q1: q(0.25), q3: q(0.75), rounds: a };
};
const out: Record<string, ReturnType<typeof stats>> = {};
let head = 0;
for (const [nr, nw] of [
  [1, 0],
  [2, 1],
]) {
  const per = 2 + 3 * (nr + nw);
  const n = Math.floor((WORDS - 1) / per);
  const times: number[] = [];
  for (let r = 0; r < ROUNDS + 1; r++) {
    const reps = 2000;
    let ns = 0;
    for (let i = 0; i < reps; i++) {
      for (let k = 0; k < n; k++) {
        u32[ring + 2 + (head++ % WORDS)] = k; // epoch 0, queue 0
        u32[ring + 2 + (head++ % WORDS)] = nr | (nw << 16);
        for (let s = 0; s < nr + nw; s++) {
          u32[ring + 2 + (head++ % WORDS)] = s * 4096;
          u32[ring + 2 + (head++ % WORDS)] = 4096;
          u32[ring + 2 + (head++ % WORDS)] = 0;
        }
      }
      head >>>= 0;
      Atomics.store(u32, ring, head);
      const t0 = performance.now();
      await poll.call(self);
      ns += (performance.now() - t0) * 1e6;
    }
    if (r > 0) times.push(+(ns / (reps * n)).toFixed(1)); // round 0 warms up
  }
  out[`${nr}r${nw}w`] = stats(times);
}
console.log(JSON.stringify({ node: process.version, rounds: ROUNDS, nsPerRequest: out, sink: sink & 1 }, null, 1));
