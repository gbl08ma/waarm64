// Disks kept in the browser, without a guest (docs/plans/machines.md §3, §4): web/app/disks.ts in Chromium over
// IndexedDB and OPFS. An image imported as a stored disk (qcow2 with compressed clusters, and raw) exports as the
// same disk (`qemu-img compare` against the file, raw, qcow2 compressed or not); a disk's overlays as named variants
// (new, rename, switch, delete). The flows with a guest are tests/page-machines.test.ts's.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';

const qemuImg = (() => { try { execFileSync('qemu-img', ['--version']); return true; } catch { return false; } })();

let browser: Browser;
let base: string;
let close: () => void;
let dir: string;
before(async () => {
  const server = await startServer();
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
  dir = mkdtempSync(join(tmpdir(), 'webpc-disks-'));
});
after(async () => { await browser?.close(); close?.(); if (dir) rmSync(dir, { recursive: true }); });

async function fresh() {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${base}/tests/browser/core.html`);
  return { context, page };
}

/** Imports the fixture `name` as a stored disk in the page and exports it in `modes`; returns the record and the files' bytes. */
const importAndExport = (page: Page, name: string, modes: { mode: string; compress?: boolean }[]) => page.evaluate(async ({ name, modes }) => {
  const { Store } = await import('/web/app/store.ts' as string);
  const { importStored, estimateStored, diskRef } = await import('/web/app/disks.ts' as string);
  const { runExport } = await import('/web/app/export.ts' as string);
  const store = await Store.open();
  const file = new File([await (await fetch(`/tests/qcow2/${name}`)).arrayBuffer()], name);
  const estimate = await estimateStored(file);
  const progress: number[] = [];
  const d = await importStored(store, file, (f: number) => progress.push(f));
  const outs: number[][] = [];
  for (const m of modes) {
    const r = await runExport({ mode: m.mode, compress: m.compress, disk: await diskRef(d), baseName: name }, () => {});
    outs.push([...new Uint8Array(await r.blob.arrayBuffer())]);
  }
  const stored = await store.files.size(`disks/${d.id}`);
  store.close();
  return { d: { kind: d.kind, size: d.size, format: d.format, name: d.name }, estimate, outs, stored, progressed: progress.length > 0 };
}, { name, modes });

test('an image imported into the browser exports as the same disk (raw, and qcow2 compressed or not), checked with qemu-img', { skip: !qemuImg && 'SKIPPED: no qemu-img' }, async () => {
  const { context, page } = await fresh();
  for (const name of ['deflate.qcow2', 'data.raw']) {
    const fixture = new URL(`qcow2/${name}`, import.meta.url).pathname;
    const r = await importAndExport(page, name, [{ mode: 'raw' }, { mode: 'qcow2', compress: true }, { mode: 'qcow2' }]);
    const info = JSON.parse(execFileSync('qemu-img', ['info', '--output=json', fixture]).toString()) as { 'virtual-size': number; format: string };
    assert.deepEqual(r.d, { kind: 'stored', size: info['virtual-size'], format: info.format === 'qcow2' ? 'qcow2' : 'raw', name });
    assert.equal(r.estimate.size, info['virtual-size']);
    assert.ok(r.stored > 0 && r.stored <= r.estimate.estimate + 64 * 1024, `${name}: stored ${r.stored} bytes, estimated ${r.estimate.estimate}`);
    r.outs.forEach((bytes, i) => {
      const out = join(dir, `${name}-${i}.${i ? 'qcow2' : 'raw'}`);
      writeFileSync(out, Buffer.from(bytes));
      if (i) execFileSync('qemu-img', ['check', out]);
      // `compare` exits non-zero when the disks' contents differ (it reads both through their formats).
      execFileSync('qemu-img', ['compare', '-q', fixture, out]);
    });
  }
  await context.close();
});

test("a disk's overlays are named variants: new, rename, switch, delete (a machine that had it chosen is left without one)", async () => {
  const { context, page } = await fresh();
  const r = await page.evaluate(async () => {
    const { Store } = await import('/web/app/store.ts' as string);
    const { createOverlay, renameOverlay, switchOverlay, deleteOverlay, inUse } = await import('/web/app/disks.ts' as string);
    const store = await Store.open();
    const d = { id: 'd0000000000a', kind: 'url', name: 'disk.img', size: 1 << 20, url: '/x', identity: { kind: 'url', path: '/x', bytes: 1 << 20 }, created: 0 };
    await store.put('disks', d);
    const a = await createOverlay(store, d, 'Changes');
    const b = await createOverlay(store, d, 'Experiment');
    const m = { id: 'aaaaaaaaaaab', name: 'M', ncpus: 1, ramMiB: 512, display: '2d', network: false, created: 0, modified: 0, attachments: [{ id: 'a0000000000a', disk: d.id, readOnly: false, overlay: a.id }] };
    await store.put('machines', m);
    await renameOverlay(store, b.id, 'Try it');
    await switchOverlay(store, m, 'a0000000000a', b.id);
    const switched = (await store.get('machines', m.id)).attachments[0].overlay === b.id;
    let refused = '';
    await switchOverlay(store, m, 'a0000000000a', 'ffffffffffff').catch((e: Error) => { refused = e.message; });
    // A machine running on it (its overlay open, as a device worker holds it): deleting is refused.
    const files = await new Promise<{ close(): void }>((resolve) => {
      const w = new Worker('/tests/browser/overlay-worker.ts', { type: 'module' });
      w.onmessage = () => resolve({ close: () => w.terminate() });
      w.postMessage({ type: 'open', name: `overlays/${b.id}` });
    });
    const busy = await inUse(`overlays/${b.id}`);
    let running = '';
    await deleteOverlay(store, b.id).catch((e: Error) => { running = e.message; });
    files.close();
    await new Promise((r) => setTimeout(r, 300));
    await deleteOverlay(store, b.id);
    const out = {
      names: (await store.overlaysOf(d.id)).map((o: { name: string }) => o.name),
      switched, refused, busy, running,
      left: (await store.get('machines', m.id)).attachments[0].overlay ?? null,
      files: await store.files.list('overlays'),
    };
    store.close();
    return out;
  });
  assert.deepEqual(r, { names: ['Changes'], switched: true, refused: "that overlay isn't one of this disk's", busy: true, running: 'a machine is running on it: power it off first', left: null, files: [] });
  await context.close();
});
