// Machine definitions in and out (docs/plans/machines.md §6; web/app/definitions.ts), in Chromium, without a guest: a
// machine with a URL disk, a file disk, a blank disk and a ramdisk exported from one fresh profile and imported through
// the modal into another comes back with the same shape; its file disk is picked again at its first start, taken
// without a question when its hash is the definition's though its date differs, and asked about when it isn't.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { answerAsks } from './page-ask.ts';

let base: string;
let close: () => void;
let dir: string;
before(async () => {
  const server = await startServer();
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  dir = mkdtempSync(join(tmpdir(), 'webpc-def-'));
});
after(async () => { close?.(); if (dir) rmSync(dir, { recursive: true }); });

/**
 * A fresh profile on disk: Chromium 153 crashes (SIGTRAP) reading a file handle back from IndexedDB in an
 * off-the-record context (docs/backlog.md), and the store keeps file disks' handles.
 */
const profile = () => chromium.launchPersistentContext(mkdtempSync(join(dir, 'profile-')), { executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });

const FIXTURE = new URL('qcow2/data.raw', import.meta.url).pathname;

test('a definition exported from one profile and imported into another: the same shape, file disks picked again (by hash when the date differs)', async () => {
  // Profile A: the machine, its file disk a file in OPFS (a handle the page keeps, as a picked file's).
  const a = await profile();
  const pa = await a.newPage();
  await pa.goto(`${base}/tests/browser/core.html`);
  const out = await pa.evaluate(async () => {
    const { Store } = await import('/web/app/store.ts' as string);
    const { createDisk, createMachine, attach } = await import('/web/app/machines.ts' as string);
    const { exportDefinition, hashFile } = await import('/web/app/definitions.ts' as string);
    const { currentShape } = await import('/web/app/snapshots.ts' as string);
    const store = await Store.open();
    const bytes = await (await fetch('/tests/qcow2/data.raw')).arrayBuffer();
    const h = await (await navigator.storage.getDirectory()).getFileHandle('data.raw', { create: true });
    const w = await h.createWritable();
    await w.write(bytes);
    await w.close();
    const file = await h.getFile();
    const m = await createMachine(store, { name: 'Portable', ncpus: 2, ramMiB: 1024, display: '2d' });
    await attach(store, m, await createDisk(store, { kind: 'url', url: '/tests/qcow2/deflate.qcow2', size: 1 << 20, bytes: 106496 }));
    const fd = await createDisk(store, { kind: 'file', file, handle: h, size: file.size });
    await store.put('disks', { ...fd, sha256: await hashFile(file) });
    await attach(store, m, fd);
    await attach(store, m, await createDisk(store, { kind: 'blank', size: 16 << 20 }));
    await attach(store, m, await createDisk(store, { kind: 'ramdisk', size: 8 << 20 }));
    const disks = new Map((await store.all('disks')).map((d: { id: string }) => [d.id, d]));
    const shape = await currentShape(await store.get('machines', m.id), (id: string) => disks.get(id), { display: '2d' });
    const def = await exportDefinition(store, m.id);
    store.close();
    return { def: JSON.stringify(def), hash: shape.hash };
  });
  await a.close();
  const defFile = join(dir, 'Portable.webpc-machine.json');
  writeFileSync(defFile, out.def);
  const def = JSON.parse(out.def);
  assert.deepEqual(def.disks.map((d: { kind: string }) => d.kind), ['url', 'file', 'blank', 'ramdisk']);
  assert.equal(readFileSync(defFile, 'utf8').includes('handle'), false, 'no handle in the file');

  // Profile B: imported through the Machines page; the same shape.
  const b = await profile();
  const pb = await b.newPage();
  const dialogs: string[] = [];
  const errors: string[] = [];
  await answerAsks(pb, (q) => { dialogs.push(q.text); });
  pb.on('pageerror', (e) => errors.push(String(e)));
  await pb.goto(`${base}/web/app/`);
  await pb.click('#machines-open');
  await pb.setInputFiles('.machines [data-field=import-definition]', defFile);
  await pb.locator('.machines .pick', { hasText: 'Portable' }).waitFor();
  const imported = await pb.evaluate(async () => {
    const { Store } = await import('/web/app/store.ts' as string);
    const { currentShape } = await import('/web/app/snapshots.ts' as string);
    const store = await Store.open();
    const m = (await store.all('machines'))[0];
    const disks = new Map((await store.all('disks')).map((d: { id: string }) => [d.id, d]));
    const shape = await currentShape(m, (id: string) => disks.get(id), { display: '2d' });
    store.close();
    return { id: m.id, hash: shape.hash, kinds: m.attachments.map((x: { disk: string }) => (disks.get(x.disk) as { kind: string }).kind) };
  });
  assert.equal(imported.hash, out.hash, 'the same shape');
  assert.deepEqual(imported.kinds, ['url', 'file', 'blank', 'ramdisk']);

  // Opened: its file disk is to be picked. The fixture's bytes under another date: the hash says it's the same file.
  await pb.locator('.machines .pick', { hasText: 'Portable' }).click();
  await pb.locator('.machines [data-action=open]').click();
  await pb.waitForFunction(() => document.body.dataset.state === 'idle' && /data\.raw needs your permission \(or picking again\)/.test((document.getElementById('message-text')?.textContent ?? '')), null, { timeout: 30_000 });
  const [chooser] = await Promise.all([pb.waitForEvent('filechooser'), pb.locator('#message-actions button', { hasText: 'Pick and start' }).click()]);
  await chooser.setFiles(FIXTURE);
  await pb.waitForFunction(() => ['loading', 'booting', 'running'].includes(document.body.dataset.state!), null, { timeout: 30_000 });
  assert.equal(dialogs.filter((d) => /isn't the file this disk was made from/.test(d)).length, 0, 'taken by its hash, without asking');

  // A file with other bytes: asked about (and taken, the dialog accepted).
  const other = join(dir, 'data.raw');
  writeFileSync(other, Buffer.alloc(4096, 1));
  await pb.reload();
  await pb.waitForFunction(() => document.body.dataset.state === 'idle', null, { timeout: 30_000 });
  const [chooser2] = await Promise.all([pb.waitForEvent('filechooser'), pb.locator('#message-actions button', { hasText: 'Pick and start' }).click()]);
  await chooser2.setFiles(other);
  await pb.waitForFunction(() => ['loading', 'booting', 'running', 'failed'].includes(document.body.dataset.state!), null, { timeout: 30_000 });
  assert.equal(dialogs.filter((d) => /isn't the file this disk was made from/.test(d)).length, 1);
  assert.deepEqual(errors, []);
  await b.close();
});
