// How promptly a worker can be woken in Chromium (VK4 T13, bench/vulkan/REPORT.md "VK4 T13–T14"): the Venus pump's turns
// (web/venus-host.ts `VenusPoll`) wait on `Atomics.waitAsync`'s timeout, which the Mac stretches to ~1.4 ms; each
// synchronous Venus call waits for one. In a cross-origin-isolated page's worker, for N turns each:
//   waitAsync    `Atomics.waitAsync(w, 0, 0, PERIOD)` resolving at its timeout (the pump as it is)
//   notified     `Atomics.waitAsync(w, 0, 0)` resolved by a helper worker's `Atomics.notify` after its own blocking
//                `Atomics.wait(PERIOD)` (a ticker thread); also the notify-to-resolve latency
//   ticker       the helper's own `Atomics.wait(PERIOD)` turns
//   message      a MessageChannel round to itself (no timer)
// and the gaps' median, p90, p99 and max (ms).
//   node bench/vulkan/wake.ts [period_ms=0.25] [turns=4000]    (CHROMIUM: the browser; prints JSON)
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';

const PERIOD = Number(process.argv[2] ?? 0.25), N = Number(process.argv[3] ?? 4000);
const helper = `onmessage = (e) => { const w = new Int32Array(e.data.sab, 0, 1), sleep = new Int32Array(new SharedArrayBuffer(4)); const t = []; let last = performance.now();
  for (let i = 0; i < e.data.n; i++) { Atomics.wait(sleep, 0, 0, e.data.period); const now = performance.now(); t.push(now - last); last = now; new Float64Array(e.data.sab, 8, 1)[0] = performance.timeOrigin + now; Atomics.add(w, 0, 1); Atomics.notify(w, 0); }
  postMessage(t); };`;
const worker = `const stats = (t) => { const s = [...t].sort((a, b) => a - b), q = (p) => +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(3); return { n: s.length, median: q(0.5), p90: q(0.9), p99: q(0.99), max: +s.at(-1).toFixed(3), mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(3) }; };
onmessage = async (e) => { const { period, n } = e.data, out = {};
  { const w = new Int32Array(new SharedArrayBuffer(4)); const t = []; let last = performance.now();
    for (let i = 0; i < n; i++) { await Atomics.waitAsync(w, 0, 0, period).value; const now = performance.now(); t.push(now - last); last = now; }
    out.waitAsync = stats(t); }
  { const sab = new SharedArrayBuffer(16), w = new Int32Array(sab, 0, 1), at = new Float64Array(sab, 8, 1); const h = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(helper)}], { type: 'text/javascript' })));
    const ticks = new Promise((r) => { h.onmessage = (m) => r(m.data); }); h.postMessage({ sab, n, period });
    const t = [], lat = []; let last = performance.now(), seen = 0;
    while (seen < n) { const r = Atomics.waitAsync(w, 0, seen); if (r.async) await r.value; const now = performance.now(); seen = Atomics.load(w, 0); t.push(now - last); last = now; lat.push(performance.timeOrigin + now - at[0]); }
    out.notified = stats(t); out.notifyLatency = stats(lat.filter((x) => x >= 0 && x < 1000)); out.ticker = stats(await ticks); h.terminate(); }
  { const c = new MessageChannel(); const t = []; let last = performance.now();
    for (let i = 0; i < n; i++) { await new Promise((r) => { c.port1.onmessage = r; c.port2.postMessage(0); }); const now = performance.now(); t.push(now - last); last = now; }
    out.message = stats(t); }
  postMessage(out); };`;
const page = `<!doctype html><script>const w = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(worker)}], { type: 'text/javascript' })));
w.onmessage = (e) => { window.result = e.data; }; w.postMessage({ period: ${PERIOD}, n: ${N} });</script>`;
const server = createServer((_q, res) => { res.writeHead(200, { 'content-type': 'text/html', 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' }); res.end(page); });
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
try {
  const p = await browser.newPage();
  p.on('console', (m) => console.error(`[page] ${m.text()}`));
  p.on('pageerror', (e) => console.error(`[page error] ${e}`));
  await p.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
  const h = await p.waitForFunction(() => (window as unknown as { result?: unknown }).result, null, { timeout: 120_000, polling: 200 });
  console.log(JSON.stringify({ period: PERIOD, turns: N, chromium: browser.version(), platform: process.platform, ...(await h.jsonValue() as object) }, null, 1));
} finally {
  await browser.close();
  server.close();
}
