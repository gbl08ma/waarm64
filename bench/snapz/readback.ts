// The 3D read-back of a snapshot's save, alone (PERF loop 85; bench/boot/REPORT.md "PERF loop 85"; dev-only): the
// desktop guest's resources as its save reads them back (Firefox on a still page under sway: the formats and sizes
// its renderer held, 40 levels, 144 MB read), loaded into a VirglRenderer on a WebGL2 canvas in the page, then saved
// (`VirglRenderer.save`, what the GPU worker's `save` runs) `SAVES` times after one warm-up. Each resource's contents
// are a byte pattern (the read-back's cost doesn't depend on them).
//   node bench/snapz/readback.ts [out.json]       WEB=<dir served as /web> (another tree's web/: an arm), ROUNDS (5), SAVES (5)
// Each round a browser of its own. On the Mac's GPU: bench/snapz/readback-mac.sh.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { startServer } from '../../tools/serve.ts';
import { chromiumEnv } from '../../tools/nosme.ts';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const out = resolve(process.argv[2] ?? `${ROOT}/bench/results/local/snapz-readback.json`);
const WEB = process.env.WEB ?? 'web';
const ROUNDS = Number(process.env.ROUNDS ?? 5);
const SAVES = Number(process.env.SAVES ?? 5);
const CHROMIUM = process.env.CHROMIUM ?? '/usr/bin/chromium';
/** [format name, width, height, count]: the desktop's levels (PERF loop 85's diagnostic). */
const LEVELS: [string, number, number, number][] = [
  ['B8G8R8X8_UNORM', 1376, 762, 2],
  ['B8G8R8A8_UNORM', 1376, 762, 5], ['B8G8R8A8_UNORM', 2048, 2048, 1], ['B8G8R8A8_UNORM', 1376, 23, 1],
  ['B8G8R8A8_UNORM', 64, 64, 1], ['B8G8R8A8_UNORM', 24, 24, 1], ['B8G8R8A8_UNORM', 1, 1, 1],
  ['R8_UNORM', 2048, 2048, 3], ['R8_UNORM', 1024, 1024, 1], ['R8_UNORM', 8, 8, 1],
  ['R8G8B8A8_UNORM', 2048, 2048, 2], ['R8G8B8A8_UNORM', 1024, 512, 4], ['R8G8B8A8_UNORM', 32, 1024, 1], ['R8G8B8A8_UNORM', 1, 1, 2],
  ['R32G32B32A32_FLOAT', 1024, 8, 1], ['R32G32B32A32_FLOAT', 1024, 2, 9],
  ['R32G32B32A32_SINT', 1024, 8, 1], ['R32G32B32A32_SINT', 1024, 2, 3],
];

const server = await startServer(Number(process.env.WAARM64_PORT ?? 0));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const rounds: unknown[] = [];
for (let k = 0; k < ROUNDS; k++) {
  const browser = await chromium.launch({ executablePath: CHROMIUM, headless: true, env: chromiumEnv(), args: (process.env.CHROMIUM_ARGS ?? '').split(' ').filter(Boolean) });
  const page = await browser.newPage();
  await page.goto(`${base}/package.json`); // any page of the origin: the renderer is imported into it
  const r = await page.evaluate(async ({ web, levels, saves }) => {
    const { VirglRenderer } = await import(`/${web}/virgl-renderer.ts`);
    const { FORMATS } = await import(`/${web}/virgl-formats.ts`);
    const gl = new OffscreenCanvas(16, 16).getContext('webgl2', { powerPreference: 'high-performance' })!;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    const r = new VirglRenderer(gl, { ram: () => [] });
    type F = { id: number; name: string; bpp: number };
    const byName = new Map(([...FORMATS.values()] as F[]).map((f) => [f.name, f]));
    const resources: { desc: object; backing: null; levels: { level: number; how: string; data: Uint8Array }[] }[] = [];
    let id = 1, bytes = 0;
    for (const [name, w, h, n] of levels) {
      const f = byName.get(name)!;
      for (let j = 0; j < n; j++) {
        const data = new Uint8Array(w * h * f.bpp);
        for (let i = 0; i < data.length; i++) data[i] = (i * 31 + j) & 0x7f; // finite floats, no NaN to canonicalize
        bytes += data.length;
        resources.push({ desc: { id: id++, target: 2, format: f.id, bind: 0, width: w, height: h, depth: 1, arraySize: 1, lastLevel: 0, samples: 0, flags: 0 }, backing: null, levels: [{ level: 0, how: 'bytes', data }] });
      }
    }
    r.load({ version: 1, resources, contexts: [] });
    const ms: number[] = [];
    let same = true;
    for (let s = 0; s <= saves; s++) {
      gl.finish();
      const t = performance.now();
      const saved = r.save();
      const dt = performance.now() - t;
      if (s) ms.push(dt);
      if (s === saves) same = saved.resources.every((x: { levels: { data: Uint8Array }[] }, i: number) => {
        const a = x.levels[0]?.data, b = resources[i].levels[0].data;
        return !!a && a.length === b.length && a.every((v, q) => v === b[q]);
      });
    }
    return { renderer, ms, bytes, same, glError: gl.getError() };
  }, { web: WEB, levels: LEVELS, saves: SAVES });
  console.log(`round ${k}`, JSON.stringify(r));
  rounds.push(r);
  await browser.close();
}
server.close();
const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const meds = (rounds as { ms: number[] }[]).map((r) => med(r.ms));
console.log('median of the rounds\' medians', med(meds).toFixed(1), 'rounds', meds.map((m) => m.toFixed(1)).join(' '));
let chromiumVersion = '';
try { chromiumVersion = execFileSync(CHROMIUM, ['--version'], { encoding: 'utf8' }).trim(); } catch { /* the Mac's: by its path */ }
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ meta: { web: WEB, rounds: ROUNDS, saves: SAVES, chromium: chromiumVersion, date: new Date().toISOString() }, rounds }, null, 1) + '\n');
console.log('wrote', out);
process.exit(0);
