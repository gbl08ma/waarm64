import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
const gen = readFileSync(new URL('./gen.mjs', import.meta.url), 'utf8').replace('export function', 'function');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
const page = await browser.newPage();
page.on('console', (m) => console.log(m.text()));
await page.goto('about:blank');
await page.evaluate(async (gen) => {
  const src = `${gen}
  onmessage = (e) => { const N = 3000; const bytes = gen(N, e.data.nonce);
    let t = performance.now(); const m = new WebAssembly.Module(bytes); const tc = performance.now() - t;
    const f = new WebAssembly.Instance(m).exports; t = performance.now(); let s = 0; for (let i = 0; i < N; i++) s += f['f' + i](i);
    self.keep = m; postMessage('nonce=' + e.data.nonce + ' compile ' + tc.toFixed(1) + ' ms, first calls ' + (performance.now() - t).toFixed(1) + ' ms'); };`;
  const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  const run = (nonce: number | undefined, keep = false) => new Promise<Worker>((res) => { const w = new Worker(url); w.onerror = (e) => { console.log('err', e.message); res(w); }; w.onmessage = (e) => { console.log(e.data); if (!keep) w.terminate(); res(w); }; w.postMessage({ nonce }); });
  await run(undefined, true);
  await run(undefined, true);
  await run(undefined, true);
  await run(7);
}, gen);
await browser.close();
