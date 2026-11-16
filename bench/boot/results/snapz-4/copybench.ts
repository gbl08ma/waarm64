// A staged file's copy into a picked file's stream (an OPFS file's writable stands in), three ways, in a persistent
// profile: 4 MiB ArrayBuffer pieces (one read ahead), 16 MiB, and Blob slices of 64 MiB (the browser copies them).
import { mkdtempSync, rmSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { startServer } from '../../../../tools/serve.ts';
const server = await startServer(8199);
const dir = mkdtempSync('/home/gabriel.guest/Development/waarm64/target/copybench-');
const ctx = await chromium.launchPersistentContext(dir, { executablePath: '/usr/bin/chromium' });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('http://127.0.0.1:8199/tests/browser/core.html');
const N = Number(process.env.MB ?? 680) << 20;
const r = await page.evaluate(async (N) => {
  const root = await navigator.storage.getDirectory();
  const src = await root.getFileHandle('src', { create: true });
  { const w = await src.createWritable(); const b = new Uint8Array(16 << 20); for (let i = 0; i < b.length; i += 4096) b[i] = i & 255; for (let at = 0; at < N; at += b.length) await w.write(b); await w.close(); }
  const file = await src.getFile();
  const out: Record<string, number[]> = {};
  const ways: Record<string, (w: FileSystemWritableFileStream) => Promise<void>> = {
    ab4: async (w) => { const P = 4 << 20; let next = file.slice(0, P).arrayBuffer(); for (let at = 0; at < file.size; at += P) { const p = await next; if (at + P < file.size) next = file.slice(at + P, at + 2 * P).arrayBuffer(); await w.write(new Uint8Array(p)); } },
    ab16: async (w) => { const P = 16 << 20; let next = file.slice(0, P).arrayBuffer(); for (let at = 0; at < file.size; at += P) { const p = await next; if (at + P < file.size) next = file.slice(at + P, at + 2 * P).arrayBuffer(); await w.write(new Uint8Array(p)); } },
    blob64: async (w) => { const P = 64 << 20; for (let at = 0; at < file.size; at += P) await w.write(file.slice(at, at + P)); },
    blobAll: async (w) => { await w.write(file); },
  };
  for (let round = 0; round < 3; round++) for (const [k, f] of Object.entries(ways)) {
    const dst = await root.getFileHandle('dst-' + k, { create: true });
    const w = await dst.createWritable();
    const t = performance.now();
    await f(w);
    const tw = performance.now() - t;
    await w.close();
    (out[k] ??= []).push(Math.round(tw), Math.round(performance.now() - t));
    await root.removeEntry('dst-' + k);
  }
  return out;
}, N);
console.log(`MB ${N >> 20}: [write ms, write+close ms] per round`, JSON.stringify(r));
await ctx.close(); server.close(); rmSync(dir, { recursive: true });
