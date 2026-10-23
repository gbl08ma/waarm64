// What a fresh Playwright (incognito) profile lets OPFS hold against what navigator.storage.estimate() reports: one
// sync handle written 64 MiB at a time until a write falls short (bench/remote-disk/REPORT.md "R3").
//   node bench/remote-disk/quota-probe.ts
import { chromium } from 'playwright-core';
import { startServer } from '../../tools/serve.ts';
const server = await startServer();
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium' });
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${(server.address() as any).port}/tests/browser/core.html`);
console.log(await page.evaluate(async () => {
  const src = `const e0 = await navigator.storage.estimate();
    const root = await navigator.storage.getDirectory();
    const h = await (await root.getFileHandle('fill', { create: true })).createSyncAccessHandle();
    const chunk = new Uint8Array(64 << 20); let n = 0, err = '';
    let short = -1; try { for (;;) { const k = h.write(chunk, { at: n }); if (k !== chunk.length) { short = k; break; } n += chunk.length; if (n > 8 * 2 ** 30) break; } } catch (e) { err = e.name + ': ' + e.message; }
    h.close(); const e1 = await navigator.storage.estimate();
    postMessage({ before: e0, wroteMiB: n / 2 ** 20, short, err, after: e1 });`;
  const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })), { type: 'module' });
  return JSON.stringify(await new Promise((r) => { w.onmessage = (e) => r(e.data); }));
}));
await browser.close(); server.close();
