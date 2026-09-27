// M6 loop 0: does Chromium bounds-check wasm stores explicitly on this host? (ns per loop iteration)
// Build: wasm-tools parse st.wat -o st.wasm; run: WASM=st.wasm node st-chrome.mjs (from the repo root, playwright-core installed).
import { chromium } from 'playwright-core';
import fs from 'fs';
const wasm = [...fs.readFileSync(process.env.WASM ?? 'st.wasm')];
for (const flags of ['', '--wasm-enforce-bounds-checks', '--no-wasm-bounds-checks']) {
  const b = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: flags ? [`--js-flags=${flags}`] : [] });
  const p = await b.newPage();
  const r = await p.evaluate(async (w) => {
    const m = new WebAssembly.Memory({ initial: 1, maximum: 65536, shared: true });
    const f = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(w)), { env: { mem: m } }).exports.f;
    const out = [];
    for (let k = 0; k < 12; k++) { const t = performance.now(); f(20_000_000); out.push((performance.now() - t) / 20e6 * 1e6); }
    return out.slice(2).sort((a, b) => a - b)[5].toFixed(3);
  }, wasm);
  console.log((flags || 'default').padEnd(32), r, 'ns/iter');
  await b.close();
}
