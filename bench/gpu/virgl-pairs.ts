// A capture's read-backs on Chromium's WebGL2, compared in pairs (dEQP draws a case, reads it back, draws its reference
// and reads that back): replays a capture (bench/gpu/deqp-run.ts CAPTURE=) through the renderer, keeps every
// readPixels with the draw before it, and prints each consecutive pair's difference.
//   node bench/gpu/virgl-pairs.ts <capture.vglt>
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { startServer } from '../../tools/serve.ts';

const server = await startServer();
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
try {
  const page = await browser.newPage();
  await page.goto(`${base}/tests/browser/virgl.html`);
  await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready, null, { timeout: 30_000 });
  const out = await page.evaluate(async (t64) => {
    const at = (p: string) => new URL(p, location.origin).href;
    const { VirglRenderer } = (await import(at('/web/virgl-renderer.ts'))) as typeof import('../../web/virgl-renderer.ts');
    const { localHost } = (await import(at('/web/virgl-host.ts'))) as typeof import('../../web/virgl-host.ts');
    const { replay } = (await import(at('/web/virgl-replay.ts'))) as typeof import('../../web/virgl-replay.ts');
    const trace = Uint8Array.from(atob(t64), (c) => c.charCodeAt(0));
    const gl = new OffscreenCanvas(16, 16).getContext('webgl2')!;
    const g = gl as unknown as Record<string, (...a: unknown[]) => unknown>;
    const reads: { px: Uint8Array; draw: string }[] = [];
    let last = '';
    for (const n of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']) {
      const f = g[n].bind(gl);
      g[n] = (...a) => { last = `${n}(${a.join(',')})`; const r = f(...a); const e = gl.getError(); if (e) last += ` error ${e}`; return r; };
    }
    const read = g.readPixels.bind(gl);
    g.readPixels = (...a) => { read(...a); reads.push({ px: (a[6] as Uint8Array).slice(0, (a[2] as number) * (a[3] as number) * 4), draw: last }); };
    const log: string[] = [];
    replay(trace, (ram) => localHost(new VirglRenderer(gl, { ram, log: (m) => log.push(m) })));
    const lines = log.map((m) => `renderer: ${m}`);
    for (let k = 0; k + 1 < reads.length; k += 2) {
      const [a, b] = [reads[k], reads[k + 1]];
      let diff = 0, first = -1;
      for (let i = 0; i < Math.min(a.px.length, b.px.length); i++) if (a.px[i] !== b.px[i]) { diff++; if (first < 0) first = i & ~3; }
      lines.push(`pair ${k / 2}: ${a.draw} | ${b.draw}: ${diff} bytes differ${first >= 0 ? ` (first at pixel ${first / 4}: ${a.px.slice(first, first + 4).join(',')} vs ${b.px.slice(first, first + 4).join(',')})` : ''}`);
    }
    return lines;
  }, Buffer.from(readFileSync(process.argv[2])).toString('base64'));
  console.log(out.join('\n'));
} finally {
  await browser.close();
  server.close();
}
