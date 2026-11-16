// SNAPZ loop 3: how fast a picked File reads in Chromium: its stream, slices one at a time or several in flight, and
// slices read by workers in parallel. Usage: PROFILE=<dir> node readbench.ts <file>
import { chromium } from 'playwright-core';
import { chromiumEnv } from '../../../../tools/nosme.ts';

const [file] = process.argv.slice(2);
const ctx = await chromium.launchPersistentContext(process.env.PROFILE!, { executablePath: '/usr/bin/chromium', headless: true, env: chromiumEnv() });
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.route('http://bench.local/**', (r) => r.fulfill({ contentType: 'text/html', body: '<input type=file id=f>' }));
await page.goto('http://bench.local/');
await page.setInputFiles('#f', file);
const worker = `onmessage = async (e) => { const { f, parts } = e.data; const t = performance.now(); let n = 0;
  for (const [a, b] of parts) n += (await f.slice(a, b).arrayBuffer()).byteLength; postMessage({ n, ms: performance.now() - t }); };`;
for (let round = 0; round < 3; round++) {
  const r = await page.evaluate(async (src) => {
    const f = (document.getElementById('f') as HTMLInputElement).files![0];
    const out: Record<string, number> = {};
    let t = performance.now();
    const rd = f.stream().getReader();
    let n = 0, chunks = 0;
    for (;;) { const { done, value } = await rd.read(); if (done) break; n += value.length; chunks++; }
    out.stream = performance.now() - t;
    out.chunkKiB = n / chunks / 1024;
    for (const [mib, inflight] of [[1, 1], [4, 1], [16, 1], [4, 4], [16, 4], [1, 8]]) {
      t = performance.now();
      const size = mib << 20;
      let at = 0;
      const next = async () => { while (at < f.size) { const a = at; at += size; await f.slice(a, Math.min(a + size, f.size)).arrayBuffer(); } };
      await Promise.all(Array.from({ length: inflight }, next));
      out[`slice${mib}x${inflight}`] = performance.now() - t;
    }
    for (const nw of [3, 6]) {
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      const ws = Array.from({ length: nw }, () => new Worker(url));
      const size = 1 << 20;
      const parts: [number, number][][] = ws.map(() => []);
      for (let a = 0, k = 0; a < f.size; a += size, k++) parts[k % nw].push([a, Math.min(a + size, f.size)]);
      t = performance.now();
      await Promise.all(ws.map((w, k) => new Promise((res) => { w.onmessage = res; w.postMessage({ f, parts: parts[k] }); })));
      out[`workers${nw}`] = performance.now() - t;
      ws.forEach((w) => w.terminate());
    }
    return out;
  }, worker);
  console.log(JSON.stringify(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Math.round(v)]))));
}
await ctx.close();
