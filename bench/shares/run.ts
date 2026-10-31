// Headless: bench/shares's measures on OPFS, and on a real folder of this machine (a directory dropped through CDP:
// the picker can't be driven, a drop's handle is the same thing). Results go to --out (relative to the repo).
//   node bench/shares/run.ts [--out bench/results/local/shares.json]
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { ROOT, startServer } from '../../tools/serve.ts';

const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'bench/results/local/shares.json';
const server = await startServer();
const { port } = server.address() as { port: number };
const dir = mkdtempSync(join(ROOT, 'bench/results/local/shares-'));
const c = await chromium.launchPersistentContext(join(dir, 'profile'), { executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
const results: Record<string, unknown> = { chromium: c.browser()?.version() };
try {
  const page = await c.newPage();
  page.on('console', (m) => console.log(m.text()));
  page.on('pageerror', (e) => console.log(String(e)));
  await page.goto(`http://127.0.0.1:${port}/bench/shares/index.html`);
  results.opfs = await page.evaluate(() => (window as unknown as { __run(r: string, k: string): Promise<unknown> }).__run('opfs', 'opfs'));
  console.log('opfs done');
  const folder = join(dir, 'folder');
  mkdirSync(join(folder, 'small'), { recursive: true });
  for (let k = 0; k < 5000; k++) writeFileSync(join(folder, 'small', `f${k}`), Buffer.alloc(4096, 1));
  writeFileSync(join(folder, 'big'), Buffer.alloc(100 << 20, 7));
  const cdp = await c.newCDPSession(page);
  const at = { x: 100, y: 100 };
  const data = { items: [], files: [folder], dragOperationsMask: 1 };
  await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', ...at, data });
  await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', ...at, data });
  await cdp.send('Input.dispatchDragEvent', { type: 'drop', ...at, data });
  await page.waitForTimeout(500);
  console.log(await page.textContent('#drop'));
  results.host = await page.evaluate(async () => {
    const w = window as unknown as { __dropped?: FileSystemDirectoryHandle; __run(r: unknown, k: string): Promise<unknown> };
    return w.__dropped ? w.__run(w.__dropped, 'host-read') : { error: 'no handle from the drop' };
  });
} finally {
  await c.close();
  server.close();
  rmSync(dir, { recursive: true, force: true });
}
writeFileSync(join(ROOT, out), `${JSON.stringify(results, null, 1)}\n`);
console.log(`wrote ${out}`);
