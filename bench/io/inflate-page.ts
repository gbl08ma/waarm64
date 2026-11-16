// The inflate pool's A/B on the page (bench/io/REPORT.md): Debian's published qcow2 booted on the
// page (`?machine=debian`, served over HTTP) to its login prompt, imported as a stored disk, and exported whole
// (qcow2, uncompressed, into OPFS), timed; one JSON line, with the sizes of the overlays' and stored disks' `map` and
// `data` files at the end. The A/B set inflatePool's default size by hand between runs (the two-level map's swapped
// web/overlay.ts and web/stored.ts). SNAPZ loop 6 added `export-c` (the same export, compressed: inflate and deflate)
// and `reads`: the reader alone on the page's thread, every 1 MiB of target/bench/io-usr.qcow2 (bench/io/REPORT.md
// "The inflate pool": 64 KiB clusters, compressed) through `openDisk` with the inflater one after another and with a
// pool of four, after a warm-up pass, and its clusters' inflate alone (µs a cluster).
//   node bench/io/inflate-page.ts <label> [boot,import,export,export-c,reads]
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { startServer } from '../../tools/serve.ts';
import { credentialsQuery } from '../../tests/debian-unattended.ts';
import { answerAsks } from '../../tests/page-ask.ts';

const label = process.argv[2];
const what = (process.argv[3] ?? 'boot,import,export').split(',');
const TMP = new URL('../../target/bench/', import.meta.url).pathname; // a profile with a stored Debian in it (~1 GB): not /tmp, which is RAM
const server = await startServer();
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const out: Record<string, unknown> = { label };
mkdirSync(TMP, { recursive: true });
const profile = mkdtempSync(join(TMP, 'profile-'));
const context = await chromium.launchPersistentContext(profile, { executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
try {
  const page = context.pages()[0] ?? await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await answerAsks(page);
  if (what.includes('boot')) {
    const t0 = Date.now();
    await page.goto(`${base}/web/app/?machine=debian&view=terminal&display=simple&${credentialsQuery()}`);
    await page.waitForFunction(() => ['running', 'failed', 'crashed'].includes(document.body.dataset.state!), null, { timeout: 240_000, polling: 100 });
    out.state = await page.evaluate(() => document.body.dataset.state);
    out.boot_ms = Date.now() - t0;
    out.ncpus = await page.evaluate(() => navigator.hardwareConcurrency);
  }
  await page.goto(`${base}/web/app/?view=terminal`);
  if (what.includes('import')) {
    out.import_ms = await page.evaluate(async () => {
      const { Store } = await import('/web/app/store.ts' as string);
      const disks = await import('/web/app/disks.ts' as string);
      const file = new File([await (await fetch('/target/images/debian/disk.qcow2')).blob()], 'debian.qcow2');
      const store = await Store.open();
      try {
        const t0 = performance.now();
        await disks.importStored(store, file);
        return performance.now() - t0;
      } finally {
        store.close();
      }
    });
  }
  if (what.includes('reads')) {
    out.reads = await page.evaluate(async () => {
      const { openDisk, inflateEach } = await import('/web/qcow2.ts' as string);
      const { inflatePool } = await import('/web/inflate-pool.ts' as string);
      const img = new Uint8Array(await (await fetch('/target/bench/io-usr.qcow2')).arrayBuffer());
      const at = (off: number, len: number) => (off + len <= img.length ? img.subarray(off, off + len) : undefined);
      const pool = inflatePool(4);
      const r: Record<string, number> = {};
      for (const [name, inflater] of [['each', inflateEach], ['pool4', pool], ['each', inflateEach], ['pool4', pool]] as const) {
        const d = openDisk(at, img.length, inflater);
        const t0 = performance.now();
        for (let off = 0; off < d.size; off += 1 << 20) if (!(await d.read(off, 1 << 20))) throw new Error(`no read at ${off}`);
        r[`${name}_1MiB_ms`] = (performance.now() - t0) / (d.size / (1 << 20)); // the second pass's: the first warms up
      }
      pool.close();
      // The clusters' inflate alone: every compressed cluster's stored bytes, one after another on this thread.
      const d = openDisk(at, img.length);
      const al = d.allocation!(at);
      const inputs: Uint8Array[] = [];
      for (let c = 0; c < al.size / al.clusterBytes; c++) {
        const h = al.host(c);
        if (h && h[1] < al.clusterBytes) inputs.push(img.subarray(h[0], h[0] + h[1]));
      }
      await inflateEach(inputs.slice(0, 200), al.clusterBytes);
      const t0 = performance.now();
      const got = await inflateEach(inputs, al.clusterBytes);
      r.inflate_us = (performance.now() - t0) * 1000 / inputs.length;
      r.clusters = inputs.length;
      r.failed = got.filter((x: unknown) => !x).length;
      // An export's deflate alone (web/qcow2-write.ts `deflate`, as the in-place packer and each pool worker run it):
      // 4 KiB pieces of those clusters with a byte that isn't zero, one after another on this thread.
      const { deflate } = await import('/web/qcow2-write.ts' as string);
      const pieces: Uint8Array[] = [];
      for (const c of got as Uint8Array[]) for (let o = 0; o < c.length && pieces.length < 8000; o += 4096) if (c.subarray(o, o + 4096).some((x) => x)) pieces.push(c.subarray(o, o + 4096));
      for (const p of pieces.slice(0, 200)) await deflate(p);
      const t1 = performance.now();
      let packed = 0;
      for (const p of pieces) packed += ((await deflate(p)) as Uint8Array | undefined)?.length ?? 4096;
      r.deflate_us = (performance.now() - t1) * 1000 / pieces.length;
      r.deflate_ratio = pieces.length * 4096 / packed;
      return r;
    });
  }
  if (what.includes('export-c')) {
    out.export_c_ms = await page.evaluate(async () => {
      const { runExport } = await import('/web/app/export.ts' as string);
      const handle = await (await navigator.storage.getDirectory()).getFileHandle('export-c.qcow2', { create: true });
      const t0 = performance.now();
      await runExport({ mode: 'qcow2', compress: true, disk: { source: { url: '/target/images/debian/disk.qcow2' } }, baseName: 'debian.qcow2', handle }, () => {});
      const ms = performance.now() - t0;
      return { ms, bytes: (await handle.getFile()).size };
    });
  }
  if (what.includes('export')) {
    out.export_ms = await page.evaluate(async () => {
      const { runExport } = await import('/web/app/export.ts' as string);
      const handle = await (await navigator.storage.getDirectory()).getFileHandle('export.qcow2', { create: true });
      const t0 = performance.now();
      await runExport({ mode: 'qcow2', compress: false, disk: { source: { url: '/target/images/debian/disk.qcow2' } }, baseName: 'debian.qcow2', handle }, () => {});
      return performance.now() - t0;
    });
  }
  // What the overlays' and stored disks' files take (the two-level map's A/B, bench/io/REPORT.md): every `map` and `data` in OPFS.
  out.files = await page.evaluate(async () => {
    const found: Record<string, number> = {};
    const walk = async (d: FileSystemDirectoryHandle, path: string) => {
      for await (const [name, h] of (d as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
        if (h.kind === 'directory') await walk(h as FileSystemDirectoryHandle, `${path}${name}/`);
        else if (name === 'map' || name === 'data') found[`${path}${name}`] = (await (h as FileSystemFileHandle).getFile()).size;
      }
    };
    await walk(await navigator.storage.getDirectory(), '');
    return found;
  });
  out.errors = errors;
} finally {
  await context.close();
  server.close();
  rmSync(profile, { recursive: true, force: true });
}
console.log(JSON.stringify(out));
