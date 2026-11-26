// How long a fresh browser's first WebGL2 context takes to make in a worker (an OffscreenCanvas), and its first readPixels.
import { chromium } from 'playwright-core';
const out = [];
for (let k = 0; k < 3; k++) {
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: true });
  const p = await b.newPage();
  await p.goto('about:blank');
  out.push(await p.evaluate(async () => {
    const src = `onmessage = (e) => { const t0 = performance.now(); const gl = e.data.getContext('webgl2', { powerPreference: 'high-performance' }); const t1 = performance.now();
      const px = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); const t2 = performance.now(); postMessage([+(t1 - t0).toFixed(1), +(t2 - t1).toFixed(1)]); };`;
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    const c = document.createElement('canvas').transferControlToOffscreen();
    const t = performance.now();
    return new Promise((res) => { w.onmessage = (e) => res({ getContext: e.data[0], firstRead: e.data[1], total: +(performance.now() - t).toFixed(1) }); w.postMessage(c, [c]); });
  }));
  await b.close();
}
console.log(JSON.stringify(out));
