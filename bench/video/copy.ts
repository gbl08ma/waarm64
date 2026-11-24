// What a decoded picture costs between its VideoFrame and its planes, before and after `copyPicture` took the planes'
// shape (docs/graphics.md "Video's findings"; the arms: bench/video/copy-page.ts), in Chromium: frames made from bytes
// (I420 and NV12) and frames out of a software and a hardware decoder (a clip encoded on the page), each into two
// planes and three. Per case: whether both paths give the same bytes, the bytes a picture allocates, and the ms a
// picture (median and quartiles of the rounds, the arms alternated).
//   node bench/video/copy.ts [--out <file.json>] [--size 1920x1080] [--rounds 9] [--pictures 120]
// On the Mac host (hardware decoders): bench/video/copy-mac.sh.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { chromium } from 'playwright-core';
import { chromiumEnv } from '../../tools/nosme.ts';
import { startServer } from '../../tools/serve.ts';
import type { Case } from './copy-page.ts';

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
  await page.goto(`${base}/bench/video/copy.html`);
  await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready, null, { timeout: 60_000 });
  const r = await page.evaluate(([w, h, n, p]) => (window as unknown as { copyBench: { run(w: number, h: number, n: number, p: number): Promise<{ cases: Case[]; notes: string[] }> } }).copyBench.run(w, h, n, p), [width, height, rounds, pictures] as const);
  const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); const i = (s.length - 1) * p, lo = Math.floor(i); return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo); };
  const stat = (xs: number[]) => ({ median: q(xs, 0.5), q1: q(xs, 0.25), q3: q(xs, 0.75), min: Math.min(...xs), max: Math.max(...xs) });
  const result = {
    chromium: browser.version(), platform: `${process.platform} ${process.arch}`, size: `${width}x${height}`, rounds, pictures, notes: r.notes,
    cases: r.cases.map((c) => ({ ...c, stats: { before: stat(c.ms.before), after: stat(c.ms.after) }, apart: Math.max(...c.ms.after) < Math.min(...c.ms.before) || Math.max(...c.ms.before) < Math.min(...c.ms.after) })),
  };
  console.log(`Chromium ${result.chromium}, ${result.platform}, ${result.size}, ${rounds} rounds of ${pictures} pictures`);
  for (const n of r.notes) console.log(`  note: ${n}`);
  const f = (x: number) => x.toFixed(2);
  for (const c of result.cases) {
    const b = c.stats.before, a = c.stats.after;
    console.log(`${c.name}, ${c.format} ${c.coded} (${c.visible}) into ${c.planes} planes: ${c.equal ? 'same bytes' : 'DIFFERENT BYTES'}; ` +
      `${(c.bytes.before / 2 ** 20).toFixed(1)} -> ${(c.bytes.after / 2 ** 20).toFixed(1)} MiB a picture; ` +
      `${f(b.median)} [${f(b.q1)}, ${f(b.q3)}] -> ${f(a.median)} [${f(a.q1)}, ${f(a.q3)}] ms a picture (${((a.median / b.median - 1) * 100).toFixed(0)}%${c.apart ? '' : ', rounds overlap'})`);
  }
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(result, null, 1) + '\n');
  }
  if (result.cases.some((c) => !c.equal)) process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
