// PERF loop 85: what a plain remote disk's two HEADs cost in the browser (a worker's fetch HEAD, then a sync XHR
// HEAD as the device worker's), several times, in a fresh profile at the dev server's origin. Dev-only.
import { rmSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { startServer } from '../../../../../tools/serve.ts';
import { chromiumEnv } from '../../../../../tools/nosme.ts';
const dir = 'target/perf85-heads-profile';
rmSync(dir, { recursive: true, force: true });
const server = await startServer(8231);
const ctx = await chromium.launchPersistentContext(dir, { executablePath: '/usr/bin/chromium', headless: true, env: chromiumEnv() });
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto('http://127.0.0.1:8231/web/app/?clocksync=0');
const url = process.argv[2];
const r = await page.evaluate(async (url) => {
  const src = `onmessage = async (e) => { const out = []; for (let k = 0; k < 6; k++) { const u = e.data + '?k=' + (k >> 1);
    let t = performance.now(); const a = await fetch(u, { method: 'HEAD' }); const f = performance.now() - t;
    t = performance.now(); const x = new XMLHttpRequest(); x.open('HEAD', u, false); x.send(); const s = performance.now() - t;
    out.push({ u: u.slice(-6), fetch: +f.toFixed(1), xhr: +s.toFixed(1), st: [a.status, x.status], len: x.getResponseHeader('content-length') }); }
    postMessage(out); };`;
  const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  return new Promise((res) => { w.onmessage = (e) => res(e.data); w.postMessage(url); });
}, url);
console.log(JSON.stringify(r));
await ctx.close(); server.close(); process.exit(0);
