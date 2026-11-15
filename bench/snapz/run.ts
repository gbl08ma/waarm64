// Ad-hoc codec bench in headless Chromium: node run.ts <corpus.bin> <plan.json> <out.json>
// plan = [{ type: 'single'|'pool'|'restore'|'crc', codec, n, sink, sample, ... }, ...]
import { chromium } from 'playwright-core';
import { readFileSync, statSync, writeFileSync, createReadStream } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';

const [corpus, planFile, outFile] = process.argv.slice(2);
const plan = JSON.parse(readFileSync(planFile, 'utf8'));
const here = new URL('.', import.meta.url).pathname;
const files: Record<string, string> = {
  '/coord.js': `${here}www/coord.js`,
  '/pool.js': `${here}www/pool.js`,
  '/codec.js': `${here}www/codec.js`,
  '/fflate.js': `${here}../../node_modules/fflate/esm/browser.js`,
  '/plain.wasm': `${here}target/plain/wasm32-unknown-unknown/release/codecs.wasm`,
  '/safe.wasm': `${here}target/safe/wasm32-unknown-unknown/release/codecs.wasm`,
  '/czstd.wasm': `${here}target/czstd/wasm32-unknown-unknown/release/codecs.wasm`,
};
const headers = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cache-Control': 'no-store' };
const server = createServer((req, res) => {
  const path = new URL(req.url!, 'http://x').pathname;
  if (path === '/') { res.writeHead(200, { ...headers, 'content-type': 'text/html' }); res.end('<!doctype html><title>codecs</title>'); return; }
  const f = path === '/corpus' ? corpus : files[path];
  if (!f) { res.writeHead(404, headers); res.end(); return; }
  res.writeHead(200, { ...headers, 'content-type': f.endsWith('.wasm') ? 'application/wasm' : f.endsWith('.js') ? 'text/javascript' : 'application/octet-stream', 'content-length': statSync(f).size });
  createReadStream(f).pipe(res);
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as { port: number }).port;
const exe = process.env.CHROMIUM ?? '/usr/bin/chromium';
// PROFILE=<dir>: a persistent profile on disk (OPFS as a user's); else Playwright's off-the-record context.
const ctx = process.env.PROFILE ? await chromium.launchPersistentContext(process.env.PROFILE, { executablePath: exe }) : await (await chromium.launch({ executablePath: exe })).newContext();
const browser = { version: () => ctx.browser()?.version() ?? 'persistent', close: () => ctx.close() };
const version = browser.version();
const page = await ctx.newPage();
page.on('console', (m) => console.log('[page]', m.text()));
await page.goto(`http://127.0.0.1:${port}/`);
const size = statSync(corpus).size;
console.log(`corpus ${(size / 1e6).toFixed(0)} MB, Chromium ${version}`);
const tl = Date.now();
await page.evaluate(async (size) => {
  const g = globalThis as any;
  const u = new Uint8Array(new SharedArrayBuffer(size));
  const r = (await fetch('/corpus')).body!.getReader();
  let at = 0;
  for (;;) { const { done, value } = await r.read(); if (done) break; u.set(value, at); at += value.length; }
  if (at !== size) throw new Error(`corpus ${at} of ${size}`);
  g.corpus = u;
}, size);
console.log(`loaded in ${Date.now() - tl} ms`);
const ready = await page.evaluate(async () => {
  const g = globalThis as any;
  const u = g.corpus as Uint8Array;
  const dv = new DataView(u.buffer);
  const frames: { tag: number; off: number; len: number }[] = [];
  for (let o = 0; o < u.length;) {
    const tag = u[o];
    const len = dv.getUint32(o + 1, true);
    frames.push({ tag, off: o + 5, len });
    o += 5 + len;
  }
  const wasms: Record<string, ArrayBuffer> = {};
  for (const k of ['plain', 'safe', 'czstd']) wasms[k] = await (await fetch(`/${k}.wasm`)).arrayBuffer();
  const w = new Worker('/coord.js', { type: 'module' });
  g.coord = w;
  g.call = (m: unknown) => new Promise((res) => { w.onmessage = (e) => res(e.data); w.postMessage(m); });
  await g.call({ type: 'init', sab: u.buffer, frames, wasms });
  return { frames: frames.length, ram: frames.filter((f) => f.tag === 0).length, disk: frames.filter((f) => f.tag === 1).length, crossOriginIsolated };
});
console.log(JSON.stringify(ready));
const results: unknown[] = [];
for (const job of plan) {
  const r = await page.evaluate((j) => (globalThis as any).call(j), job) as { ok: boolean; r?: Record<string, number | string>; error?: string };
  if (!r.ok) { console.log('FAIL', JSON.stringify(job), r.error); results.push({ job, error: r.error }); continue; }
  const short = Object.fromEntries(Object.entries(r.r!).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(v > 100 ? 0 : 2) : v]));
  console.log(JSON.stringify({ ...job, ...short }));
  results.push({ job, ...r.r });
}
const host = { cpu: execFileSync('uname', ['-m']).toString().trim(), nproc: +execFileSync('nproc').toString(), chromium: version, date: new Date().toISOString() };
writeFileSync(outFile, JSON.stringify({ host, corpus, results }, null, 1));
await browser.close();
server.close();
