// What a join of a virgl backing's entries costs (PERF loop 91; dev-only): web/virgl-renderer.ts `readBacking` copies
// a transfer's range that spans entries into one buffer, a fresh one before the loop, its kept one since. The same
// loop in Node and in headless Chromium (a blank page: guest RAM a plain ArrayBuffer there, a shared one in Node), over
// a backing of 4 KiB pages and one of 64 KiB runs in random order; µs a join, ROUNDS rounds alternating the arms,
// medians and IQR; JSON on stdout.
//   node bench/gpu/join.ts [bytes] [rounds]
import { chromium } from 'playwright-core';

const LEN = Number(process.argv[2] ?? 911_000); // Firefox's scroll: 61.8 MB/s in 69.5 joins a second
const ROUNDS = Number(process.argv[3] ?? 15);

function bench(len: number, rounds: number, shared: boolean) {
  type Seg = { off: number; len: number; mem: number };
  const RAM = 256 << 20;
  const ram = [new Uint8Array(shared ? new SharedArrayBuffer(RAM) : new ArrayBuffer(RAM))];
  for (let i = 0; i < RAM; i += 4096) ram[0][i] = i;
  const bytes = (s: Seg) => ram[s.mem].subarray(s.off, s.off + s.len);
  const backing = (run: number) => {
    const out: Seg[] = [];
    let seed = 12345;
    for (let n = 0; n < len; n += run) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      out.push({ off: (seed % (RAM / run)) * run, len: run, mem: 0 });
    }
    return out;
  };
  let joined = new Uint8Array(0);
  const join = (b: Seg[], kept: boolean) => {
    let out: Uint8Array;
    if (kept) {
      if (joined.length < len) joined = new Uint8Array(len);
      out = joined.subarray(0, len);
    } else out = new Uint8Array(len);
    let at = 0;
    for (let j = 0; j < b.length && at < len; j++) {
      const n = Math.min(b[j].len, len - at);
      out.set(bytes(b[j]).subarray(0, n), at);
      at += n;
    }
    return out;
  };
  const stats = (a: number[]) => {
    const s = [...a].sort((x, y) => x - y);
    const q = (p: number) => s[Math.floor((s.length - 1) * p)];
    return { median: q(0.5), q1: q(0.25), q3: q(0.75), rounds: a };
  };
  const res: Record<string, ReturnType<typeof stats>> = {};
  let sink = 0;
  for (const run of [4096, 65536]) {
    const b = backing(run);
    const t: Record<string, number[]> = { fresh: [], kept: [] };
    for (let r = 0; r < rounds + 2; r++)
      for (const kept of r % 2 ? [true, false] : [false, true]) {
        const reps = 400;
        const t0 = performance.now();
        for (let i = 0; i < reps; i++) sink += join(b, kept)[i & 1023];
        if (r > 1) t[kept ? 'kept' : 'fresh'].push(+(((performance.now() - t0) * 1000) / reps).toFixed(2));
      }
    for (const [k, v] of Object.entries(t)) res[`${run}-${k}`] = stats(v);
  }
  return { usPerJoin: res, sink: sink & 1 };
}

const node = bench(LEN, ROUNDS, true);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: true });
const version = browser.version();
let chromiumResult;
try {
  const page = await browser.newPage();
  chromiumResult = await page.evaluate(`(${bench.toString()})(${LEN}, ${ROUNDS}, false)`);
} finally {
  await browser.close();
}
console.log(
  JSON.stringify({ bytes: LEN, rounds: ROUNDS, node: { version: process.version, ...node }, chromium: { version, ...(chromiumResult as object) } }, null, 1),
);
