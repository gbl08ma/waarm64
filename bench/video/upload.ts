// What a decoded picture costs between its arrays and its textures when it is smaller than its planes (1080p in
// 1920×1088 planes: docs/graphics.md "Video's measurements"; the arms: bench/video/upload-page.ts), in Chromium's
// WebGL2. Per arm: whether what a draw samples holds the picture's bytes, and the ms a picture (median and quartiles
// of the rounds, the arms in turn; `calls` is the time inside the GL calls, the rest waiting for the GPU's side).
//   node bench/video/upload.ts [--out <file.json>] [--size 1920x1080] [--rounds 9] [--pictures 120]
// On the Mac host (a real GPU): TOOL=upload bench/video/copy-mac.sh <out.json>.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { chromium } from 'playwright-core';
import { chromiumEnv } from '../../tools/nosme.ts';
import { startServer } from '../../tools/serve.ts';
import type { Arm, Result } from './upload-page.ts';

const arg = (name: string, or: string) => { const k = process.argv.indexOf(`--${name}`); return k < 0 ? or : process.argv[k + 1]; };
const [width, height] = arg('size', '1920x1080').split('x').map(Number);
const rounds = Number(arg('rounds', '9')), pictures = Number(arg('pictures', '120'));
const out = arg('out', '');

const server = await startServer();
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', args: process.env.CHROMIUM_ARGS?.split(' ').filter(Boolean), env: chromiumEnv() });
try {
  const page = await browser.newPage();
  page.on('console', (m) => { if (process.env.VERBOSE) console.log('page:', m.text()); });
  await page.goto(`${base}/bench/video/upload.html`);
  await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready, null, { timeout: 60_000 });
  const r = await page.evaluate(([w, h, n, p]) => (window as unknown as { uploadBench: { run(w: number, h: number, n: number, p: number): Promise<Result> } }).uploadBench.run(w, h, n, p), [width, height, rounds, pictures] as const);
  const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); const i = (s.length - 1) * p, lo = Math.floor(i); return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo); };
  const stat = (xs: number[]) => ({ median: q(xs, 0.5), q1: q(xs, 0.25), q3: q(xs, 0.75), min: Math.min(...xs), max: Math.max(...xs) });
  const arms = Object.keys(r.ms) as Arm[];
  const result = {
    chromium: browser.version(), platform: `${process.platform} ${process.arch}`, renderer: r.renderer, picture: r.picture, plane: r.plane, rounds, pictures,
    arms: arms.map((a) => ({ arm: a, equal: r.equal[a], stats: stat(r.ms[a]), calls: stat(r.callsMs[a]), ms: r.ms[a], callsMs: r.callsMs[a], apartFromTwice: Math.max(...r.ms[a]) < Math.min(...r.ms.twice) || Math.max(...r.ms.twice) < Math.min(...r.ms[a]) })),
  };
  console.log(`Chromium ${result.chromium}, ${result.platform}, ${result.renderer}; ${r.picture} in ${r.plane} planes, ${rounds} rounds of ${pictures} pictures`);
  const f = (x: number) => x.toFixed(2);
  for (const a of result.arms)
    console.log(`${a.arm.padEnd(5)} ${a.equal ? 'same bytes' : 'DIFFERENT BYTES'}; ${f(a.stats.median)} [${f(a.stats.q1)}, ${f(a.stats.q3)}] ms a picture (calls ${f(a.calls.median)})${a.arm === 'twice' || a.apartFromTwice ? '' : ', rounds overlap twice\'s'}`);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(result, null, 1) + '\n');
  }
  if (result.arms.some((a) => !a.equal)) process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
