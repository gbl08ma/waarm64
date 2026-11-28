// The ones'-complement sum's cost (PERF loop 91; dev-only): web/offload.ts `csumSum`, which every byte the guest sends
// or receives through virtio-net's offloads crosses once (a segment's or a frame's TCP/UDP checksum, a received
// frame's check for DATA_VALID), against the two-bytes-a-step loop it replaced. ns a byte over frames of 1,514 and
// 65,226 bytes at even and odd offsets, in Node and in headless Chromium (a blank page, the same functions), ROUNDS
// rounds alternating the arms; medians and IQR; JSON on stdout.
//   node bench/net/csum.ts [rounds]
import { chromium } from 'playwright-core';
import { csumSum } from '../../web/offload.ts';

/** The loop before PERF loop 91: two bytes a step. */
function pairs(b: Uint8Array, start: number, end: number, s = 0) {
  let k = start;
  for (; k + 1 < end; k += 2) s += (b[k] << 8) | b[k + 1];
  if (k < end) s += b[k] << 8;
  return s;
}

// web/offload.ts's, which csumSum calls (in the page too).
const fold = (s: number) => {
  while (s > 0xffff) s = (s & 0xffff) + Math.floor(s / 0x10000);
  return s;
};

type Sum = (b: Uint8Array, start: number, end: number, s?: number) => number;
function bench(arms: Record<string, Sum>, rounds: number) {
  const buf = new Uint8Array(1 << 17);
  for (let i = 0; i < buf.length; i++) buf[i] = (i * 2654435761) >>> 24;
  const cases = [
    { name: '1514', len: 1514, start: 34 },
    { name: '1514-odd', len: 1514, start: 35 },
    { name: '65226', len: 65226, start: 34 },
    { name: '65226-odd', len: 65226, start: 35 },
  ];
  const f16 = (s: number) => {
    while (s > 0xffff) s = (s & 0xffff) + Math.floor(s / 0x10000);
    return s;
  };
  for (const c of cases)
    for (const [n, f] of Object.entries(arms))
      if (f16(f(buf, c.start, c.start + c.len, 7)) !== f16(arms.pairs(buf, c.start, c.start + c.len, 7)))
        throw new Error(`${n} disagrees on ${c.name}`);
  const stats = (a: number[]) => {
    const s = [...a].sort((x, y) => x - y);
    const q = (p: number) => s[Math.floor((s.length - 1) * p)];
    return { median: q(0.5), q1: q(0.25), q3: q(0.75), rounds: a };
  };
  const out: Record<string, Record<string, ReturnType<typeof stats>>> = {};
  let sink = 0;
  for (const c of cases) {
    const times: Record<string, number[]> = {};
    const reps = Math.ceil((64 << 20) / c.len); // 64 MiB summed a measure
    for (let r = 0; r < rounds + 1; r++) {
      const order = r % 2 ? Object.keys(arms).reverse() : Object.keys(arms);
      for (const n of order) {
        const f = arms[n];
        const t0 = performance.now();
        for (let i = 0; i < reps; i++) sink += f(buf, c.start + (i & 63) * 2, c.start + (i & 63) * 2 + c.len);
        const ns = ((performance.now() - t0) * 1e6) / (reps * c.len);
        if (r > 0) (times[n] ??= []).push(+ns.toFixed(4)); // round 0 warms up
      }
    }
    out[c.name] = Object.fromEntries(Object.entries(times).map(([n, t]) => [n, stats(t)]));
  }
  return { nsPerByte: out, sink: sink & 1 };
}

const ROUNDS = Number(process.argv[2] ?? 11);
const node = bench({ pairs, words: csumSum }, ROUNDS);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: true });
const version = browser.version();
let inPage;
try {
  const page = await browser.newPage();
  inPage = await page.evaluate(
    `(() => { const fold = ${fold.toString()}; const csumSum = ${csumSum.toString()}; const pairs = ${pairs.toString()};` +
      ` return (${bench.toString()})({ pairs, words: csumSum }, ${ROUNDS}); })()`,
  );
} finally {
  await browser.close();
}
console.log(
  JSON.stringify({ rounds: ROUNDS, node: { version: process.version, ...node }, chromium: { version, ...(inPage as object) } }, null, 1),
);
