// PERF loop 89's micro-benchmarks in headless Chromium: (1) a JIT install's table.grow, per install against the table
// pre-grown once; (2) a busy vCPU worker's periodic return to its event loop (web/idle-wait.ts yieldTurn) every
// 50/100/250 ms against never. Usage: node micro.ts [rounds]
import { chromium } from 'playwright-core';

const worker = String.raw`
const u = (n) => { const o = []; do { let b = n & 127; n >>>= 7; if (n) b |= 128; o.push(b); } while (n); return o; };
const str = (s) => [...u(s.length), ...new TextEncoder().encode(s)];
const sec = (id, body) => [id, ...u(body.length), ...body];
const vec = (items) => [...u(items.length), ...items.flat()];
const TYPE = sec(1, vec([[0x60, 0, 1, 0x7f]]));
function coreModule(b) {
  return new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, ...TYPE, ...sec(4, vec([[0x70, 0, ...u(b)]])), ...sec(7, vec([[...str('table'), 1, 0]]))]);
}
function jitModule(k) {
  const fns = Array.from({ length: k }, (_, i) => i);
  const body = [0, 0x41, 0, 0x11, 0, 0, 0x0b];
  return new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, ...TYPE,
    ...sec(2, vec([[...str('env'), ...str('table'), 1, 0x70, 0, 0]])),
    ...sec(3, vec(fns.map(() => [0]))),
    ...sec(7, vec(fns.map((i) => [...str('f' + i), 0, i]))),
    ...sec(10, vec(fns.map(() => [...u(body.length), ...body]))),
  ]);
}
function tableRun(arm, base, m, k, cap) {
  const table = new WebAssembly.Instance(new WebAssembly.Module(coreModule(base))).exports.table;
  const mod = new WebAssembly.Module(jitModule(k));
  let growMs = 0, totalMs = 0, preMs = 0;
  if (arm === 'pre') { const t = performance.now(); table.grow(cap); preMs = performance.now() - t; }
  let at = base;
  const keep = [];
  for (let i = 0; i < m; i++) {
    const t0 = performance.now();
    const f = new WebAssembly.Instance(mod, { env: { table } }).exports;
    const t1 = performance.now();
    if (table.length < at + k) table.grow(at + k - table.length);
    const t2 = performance.now();
    for (let j = 0; j < k; j++) table.set(at + j, f['f' + j]);
    at += k;
    totalMs += performance.now() - t0;
    growMs += t2 - t1;
  }
  return { arm, m, k, growMs, totalMs, preMs, length: table.length };
}
async function yieldRun(ms, durMs) {
  const word = new Int32Array(new SharedArrayBuffer(4));
  let work = 0, yields = 0, last = performance.now();
  const lat = [];
  const end = performance.now() + durMs;
  let x = 1;
  for (;;) {
    for (let i = 0; i < 20000; i++) x = (x * 1103515245 + 12345) | 0;
    work++;
    const now = performance.now();
    if (now >= end) break;
    if (ms > 0 && now - last >= ms) {
      const w = Atomics.waitAsync(word, 0, 0, 0.001);
      if (w.async) await w.value;
      last = performance.now();
      lat.push(last - now);
      yields++;
    }
  }
  lat.sort((a, b) => a - b);
  const q = (p) => lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] : 0;
  return { ms, work, yields, x: x & 1, p50: q(0.5), p99: q(0.99), max: lat.at(-1) ?? 0, sum: lat.reduce((a, b) => a + b, 0) };
}
onmessage = async (e) => {
  const { rounds } = e.data;
  const out = { table: [], yield: [] };
  const shapes = [['node', 1461, 13], ['hour', 4744, 16]];
  for (let r = 0; r < rounds; r++) {
    for (const [name, m, k] of shapes) {
      const arms = r % 2 ? ['pre', 'grow'] : ['grow', 'pre'];
      for (const arm of arms) out.table.push({ shape: name, round: r, ...tableRun(arm, 2048, m, k, 262144) });
    }
    const ys = [0, 50, 100, 250];
    for (let i = 0; i < ys.length; i++) out.yield.push({ round: r, ...(await yieldRun(ys[(i + r) % ys.length], 3000)) });
  }
  postMessage(out);
};
`;
const rounds = Number(process.argv[2] ?? 5);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
try {
  const page = await browser.newPage();
  const hdr = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };
  await page.route('https://bench.test/**', (r) =>
    r.request().url().endsWith('/w.js')
      ? r.fulfill({ body: worker, contentType: 'text/javascript', headers: hdr })
      : r.fulfill({ body: '<!doctype html><title>m</title>', contentType: 'text/html', headers: hdr }),
  );
  await page.goto('https://bench.test/');
  const res = await page.evaluate(
    (rounds) =>
      new Promise((ok, bad) => {
        if (!crossOriginIsolated) bad(new Error('not isolated'));
        const w = new Worker('/w.js');
        w.onmessage = (e) => ok(e.data);
        w.onerror = (e) => bad(new Error(e.message));
        w.postMessage({ rounds });
      }),
    rounds,
  );
  console.log(JSON.stringify({ browser: browser.version(), ...(res as object) }));
} finally {
  await browser.close();
}
