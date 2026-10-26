// VK2's costs of a submit and of a pipeline on the renderer's driver (bench/vulkan/REPORT.md "VK2: the module, a
// pipeline, a submit"): bench/vulkan/costs/page.ts in headless Chromium (or HEADED=1), N rounds of a submit of one
// draw with a pipeline made before, alternated with a submit whose pipeline is made anew from a new fragment shader
// (a specialization constant's value). Prints and writes medians and IQRs of the ms in the call and to the fence, and
// of a hand-written WGSL pipeline of the same kind made with createRenderPipelineAsync (the browser's compile alone).
//   node bench/vulkan/costs.ts [out.json]     (N, default 40; SEED fixes the shaders' values, so a second run finds them in
//   the GPU's own shader cache (Metal keeps one on disk), a random one otherwise; CHROMIUM, CHROMIUM_ARGS as the tests take them;
//   on the Mac through bench/vulkan/mac-costs.sh)
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright-core';
import { startServer } from '../../tools/serve.ts';

const root = new URL('../..', import.meta.url).pathname;
const out = process.argv[2] ?? join(root, 'bench/results/local/vk2-costs.json');
const N = Number(process.env.N ?? 40);
const spv = join(root, 'target/vk/test');
mkdirSync(spv, { recursive: true });
// The shaders' SPIR-V (glslc; where there is none, as on the Mac host, the copies mac-costs.sh brought).
const glslc = spawnSync('glslc', ['--version']).status === 0;
for (const [src, name] of [['tests/venus/driver.vert', 'driver.vert'], ['tests/venus/driver.frag', 'driver.frag'], ['tests/venus/driver.comp', 'driver.comp'], ['bench/vulkan/costs/costs.frag', 'costs.frag']]) {
  if (!glslc && existsSync(join(spv, `${name}.spv`))) continue;
  const r = spawnSync('glslc', ['--target-env=vulkan1.2', '-o', join(spv, `${name}.spv`), join(root, src)], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`glslc ${src}: ${r.stderr ?? r.error}`);
}
const server = await startServer();
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: !process.env.HEADED,
  args: (process.env.CHROMIUM_ARGS ?? (process.platform === 'darwin' ? '--enable-unsafe-webgpu' : '--enable-unsafe-webgpu --enable-features=Vulkan')).split(' ').filter(Boolean) });
try {
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') console.error(`page: ${m.text().slice(0, 500)}`); });
  await page.goto(`${base}/bench/vulkan/costs/index.html`);
  await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready);
  const r = await page.evaluate(([n, seed]) => (window as unknown as { costs: { run(s: object, n: number, seed?: number): Promise<Record<string, unknown>> } }).costs.run({
    vert: '/target/vk/test/driver.vert.spv', frag: '/target/vk/test/driver.frag.spv', comp: '/target/vk/test/driver.comp.spv', costs: '/target/vk/test/costs.frag.spv' }, n, seed), [N, process.env.SEED ? Number(process.env.SEED) : undefined] as const);
  if (r.error || r.skipped) throw new Error(String(r.error ?? r.skipped));
  const q = (v: number[], p: number) => { const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  const sum = (rows: { call: number; total: number }[]) => Object.fromEntries((['call', 'total'] as const).map((k) => {
    const v = rows.map((x) => x[k]);
    return [k, { median: +q(v, 0.5).toFixed(3), iqr: +(q(v, 0.75) - q(v, 0.25)).toFixed(3) }];
  }));
  const res = { date: new Date().toISOString(), chromium: browser.version(), platform: process.platform, adapter: r.adapter, n: N, seed: process.env.SEED ?? 'random',
    submit: sum(r.submit as { call: number; total: number }[]), pipeline: sum(r.pipeline as { call: number; total: number }[]),
    handWritten: sum((r.hand as number[]).map((x) => ({ call: x, total: x }))).total, errors: r.errors, stats: r.stats, raw: { submit: r.submit, pipeline: r.pipeline } };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(res, null, 1) + '\n');
  console.log(JSON.stringify({ adapter: res.adapter, chromium: res.chromium, submit: res.submit, pipeline: res.pipeline, handWritten: res.handWritten, errors: res.errors }));
} finally {
  await browser.close();
  server.close();
}
