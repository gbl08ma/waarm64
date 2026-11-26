// Stored disks (web/stored.ts, docs/machines.md §4.4) in Node, where overlays live in memory: an image
// imported into the block store reads back as the image's bytes; a merge writes an overlay's blocks in and deletes
// it; an interrupted merge is finished at the next opening. (The page's flows are tests/page-machines.test.ts's.)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { chromium } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { openOverlay, overlay, overlayMeta, readMeta, writeMeta } from '../web/overlay.ts';
import { openDisk } from '../web/qcow2.ts';
import { blockSource, importImage, mergeOverlay, openStored, openStoredForWriting, storedEstimate, zeroDisk } from '../web/stored.ts';
import { loggedFiles } from './logged-files.ts';
import { Devices } from '../web/devices.ts';
import type { Source } from '../web/disk-sources.ts';
import { explain } from '../web/app/worker-errors.ts';
import { MACHINES } from '../web/app/machine.ts';
import { msgOf } from '../web/msg.ts';
import { Store } from '../web/app/store.ts';
import { memoryFiles, memoryRecords } from '../web/app/store-backends.ts';

const bufferSource = (b: Uint8Array): Source => ({ size: b.length, read: (off, len) => (off >= 0 && off + len <= b.length ? b.slice(off, off + len) : undefined) });
const same = (a: Uint8Array | undefined, b: Uint8Array) => !!a && a.length === b.length && Buffer.compare(a, b) === 0;

test('an image imported into a stored disk reads back as its bytes, zero blocks left out (raw and qcow2 with compressed clusters)', async () => {
  for (const name of ['data.raw', 'deflate.qcow2']) {
    const file = new Uint8Array(readFileSync(new URL(`qcow2/${name}`, import.meta.url)));
    const image = openDisk((off, len) => file.slice(off, off + len), file.length);
    const want = (await image.read(0, image.size))!;
    const path = `disks/test-${name}`;
    const est = storedEstimate(bufferSource(file));
    assert.equal(est.size, image.size);
    assert.ok(est.estimate >= want.length - [...Array(want.length / 4096).keys()].filter((b) => want.subarray(b * 4096, (b + 1) * 4096).every((x) => x === 0)).length * 4096, `${name}: the estimate covers the data`);
    const files = await openStoredForWriting(path, 'stored', image.size);
    const r = await importImage(bufferSource(file), files);
    files.close();
    assert.equal(r.size, image.size);
    const nonzero = [...Array(Math.ceil(want.length / 4096)).keys()].filter((b) => want.subarray(b * 4096, (b + 1) * 4096).some((x) => x !== 0)).length;
    assert.equal(r.blocks, nonzero, `${name}: only the non-zero blocks`);
    const src = await openStored(path, image.size);
    assert.ok(same(src.read(0, image.size), want), `${name} reads back`);
    assert.ok(same(src.read(4096 + 512, 3 * 4096), want.subarray(4096 + 512, 4 * 4096 + 512)), `${name}: a read across blocks`);
    src.close();
  }
});

test('an import writes its store unordered and flushes both files once, at its end (nothing reads a store before its record)', async () => {
  const size = 700 * 4096 + 300; // the last block not whole
  const image = new Uint8Array(size);
  for (let i = 0; i < size; i++) image[i] = (i >> 12) % 5 === 0 ? 0 : ((i * 2654435761) >>> 24) | 1; // every 5th block zeros
  const f = loggedFiles();
  const r = await importImage(bufferSource(image), { ...f, close() {} });
  assert.equal(r.blocks, 701 - 141); // blocks 0, 5, … 700 are zeros
  assert.equal(f.flushes('data'), 1, 'unordered: one data flush');
  assert.equal(f.unflushed('data'), 0, 'the data flushed after its last write');
  assert.equal(f.unflushed('map'), 0, 'the map flushed after its last write');
  assert.ok(same(blockSource(f.data, f.map, size).read(0, size), image), 'the store reads as the image');
});

// A tab closed during an import: the disk's record is made only once the job is done (after its last flush), so a
// store cut off part way is never a disk; its files, marked as filling, are removed at the page's next start.
test('in Chromium (OPFS): an import cut off by its page closing leaves no stored disk', async () => {
  const server = await startServer();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
  try {
    const context = await browser.newContext();
    const at = `http://127.0.0.1:${(server.address() as { port: number }).port}/tests/browser/core.html`;
    const page = await context.newPage();
    await page.goto(at);
    // 256 MiB that isn't zeros, its import started; resolves at its first progress (a MiB of it written).
    await page.evaluate(async () => {
      const { Store } = await import('/web/app/store.ts' as string);
      const { importStored } = await import('/web/app/disks.ts' as string);
      const store = await Store.open();
      const words = new Uint32Array(64 << 20);
      for (let i = 0; i < words.length; i++) words[i] = Math.imul(i, 2654435761) | 1;
      const file = new File([words], 'big.img');
      await new Promise<void>((resolve, reject) => {
        importStored(store, file, (f: number) => { if (f > 0) resolve(); }).then(() => reject(new Error('the import ended before the page closed')), reject);
      });
    });
    await page.close();
    const again = await context.newPage();
    await again.goto(at);
    const r = await again.evaluate(async () => {
      const { Store } = await import('/web/app/store.ts' as string);
      const store = await Store.open();
      const disks = (await store.all('disks')).length;
      const list = async () => {
        const dirs: string[] = [];
        for await (const name of (await (await navigator.storage.getDirectory()).getDirectoryHandle('disks')).keys()) dirs.push(name);
        return dirs.length;
      };
      const left = await list();
      // The page's start removes what it left (review disk-writes 4): marked as filling, its lock free, no record.
      const removed = (await store.dropCutFills()).length;
      store.close();
      return { disks, left, removed, after: await list() };
    });
    assert.deepEqual(r, { disks: 0, left: 1, removed: 1, after: 0 }, 'no record; the files left are removed at the next start');
  } finally {
    await browser.close();
    server.close();
  }
});

test('a merge writes the overlay into the stored disk, moves its generation and deletes the overlay; an interrupted one is finished at the next opening', async () => {
  const size = 64 * 4096;
  const image = new Uint8Array(size);
  for (let i = 0; i < size; i += 4096) image.fill((i / 4096) % 7, i, i + 4096); // blocks 0, 7, 14… are zeros
  const disk = 'disks/test-merge';
  let f = await openStoredForWriting(disk, 'stored', size);
  await importImage(bufferSource(image), f);
  f.close();
  const genBefore = (await overlayMeta(disk)).generation;
  // An overlay over the stored disk: two blocks written, one zeroed.
  const writeOverlay = async (path: string) => {
    const base = await openStored(disk, size);
    const o = await openOverlay(path, 'over-it');
    const d = overlay(openDisk((off, len) => base.read(off, len), size), o.data, o.map, o.meta);
    assert.ok(await d.write(4096, new Uint8Array(4096).fill(0xaa)));
    assert.ok(await d.write(8 * 4096 + 512, new Uint8Array(512).fill(0xbb)));
    assert.ok(await d.zero(3 * 4096, 4096));
    o.close();
    base.close();
  };
  const want = image.slice();
  want.fill(0xaa, 4096, 8192);
  want.fill(0xbb, 8 * 4096 + 512, 8 * 4096 + 1024);
  want.fill(0, 3 * 4096, 4 * 4096);

  await writeOverlay('overlays/test-merge-1');
  assert.equal(await mergeOverlay(disk, 'overlays/test-merge-1', 'stored', size), 3);
  let src = await openStored(disk, size);
  assert.ok(same(src.read(0, size), want));
  src.close();
  assert.deepEqual(await overlayMeta(disk), { generation: genBefore + 1, merging: '', size: 0 });
  await assert.rejects(openOverlay('overlays/test-merge-1', undefined, undefined, { readOnly: true }), /no overlay/, 'the overlay is gone');

  // Interrupted after the mark: the store names the overlay; the next opening (a machine's, an export's) finishes it.
  const disk2 = 'disks/test-merge-2';
  f = await openStoredForWriting(disk2, 'stored', size);
  await importImage(bufferSource(image), f);
  writeMeta(f.meta, { ...readMeta(f.meta), generation: readMeta(f.meta).generation + 1, merging: 'overlays/test-merge-2' });
  f.close();
  // The overlay over disk2 (written against its bytes).
  {
    const base = await (async () => { const o = await openOverlay(disk2, undefined); return { o, src: overlay(zeroDisk(size), o.data, o.map) }; })();
    const o = await openOverlay('overlays/test-merge-2', 'over-it');
    const d = overlay({ size, format: 'raw', read: (off, len) => base.src.read(off, len) }, o.data, o.map, o.meta);
    assert.ok(await d.write(4096, new Uint8Array(4096).fill(0xaa)));
    assert.ok(await d.write(8 * 4096 + 512, new Uint8Array(512).fill(0xbb)));
    assert.ok(await d.zero(3 * 4096, 4096));
    o.close();
    base.o.close();
  }
  src = await openStored(disk2, size); // resumes the merge first
  assert.ok(same(src.read(0, size), want), 'the interrupted merge was finished before the disk was read');
  src.close();
  assert.equal((await overlayMeta(disk2)).merging, '');
  await assert.rejects(openOverlay('overlays/test-merge-2', undefined, undefined, { readOnly: true }), /no overlay/);
});

test('a merge copies runs of blocks (data and zeroed, longer than one write, the last one partial) as they are', async () => {
  const size = 600 * 4096 + 100;
  const image = new Uint8Array(size).fill(0x11);
  const disk = 'disks/test-merge-runs';
  const f = await openStoredForWriting(disk, 'stored', size);
  await importImage(bufferSource(image), f);
  f.close();
  const want = image.slice();
  const base = await openStored(disk, size);
  const o = await openOverlay('overlays/test-merge-runs', 'over-it');
  const d = overlay(openDisk((off, len) => base.read(off, len), size), o.data, o.map, o.meta);
  const write = async (at: number, len: number, v: number) => {
    assert.ok(await d.write(at, new Uint8Array(len).fill(v)));
    want.fill(v, at, at + len);
  };
  await write(10 * 4096, 391 * 4096, 0xa1); // blocks 10..400: longer than one run
  assert.ok(await d.zero(401 * 4096, 5 * 4096)); // 401..405, right after
  want.fill(0, 401 * 4096, 406 * 4096);
  await write(406 * 4096, 4096, 0xa2);
  await write(599 * 4096, 4096 + 100, 0xa3); // the last block, partial
  o.close();
  base.close();
  assert.equal(await mergeOverlay(disk, 'overlays/test-merge-runs', 'stored', size), 391 + 5 + 1 + 2);
  const src = await openStored(disk, size);
  assert.ok(same(src.read(0, size), want), 'the merged disk reads as the overlay did');
  src.close();
});

// OPFS removes an overlay's directory a file at a time: a tab closed meanwhile leaves some of its files, and the merge
// that was deleting it resumes at the store's next opening (in Node an overlay is whole or gone).
test('in Chromium (OPFS): a merge resumed after its overlay was partly deleted (its map gone, its data left) deletes the rest', async () => {
  const server = await startServer();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
  try {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/tests/browser/core.html`);
    const src = `
      const { openOverlay, opfsDir, overlay, overlayMeta, readMeta, writeMeta } = await import('ORIGIN/web/overlay.ts');
      const { resumeMerge, zeroDisk } = await import('ORIGIN/web/stored.ts');
      const size = 64 * 4096, disk = 'disks/partly-merged', ov = 'overlays/partly-merged';
      let f = await openOverlay(disk, 'stored');
      f.close();
      const o = await openOverlay(ov, 'over-it');
      await overlay(zeroDisk(size), o.data, o.map, o.meta).write(4096, new Uint8Array(4096).fill(1));
      o.close();
      // The copy done, the store still marked, and the overlay's deletion cut off after its map.
      f = await openOverlay(disk, 'stored');
      writeMeta(f.meta, { ...readMeta(f.meta), merging: ov });
      f.close();
      await (await opfsDir(ov)).removeEntry('map');
      await resumeMerge(disk, size);
      const left = await opfsDir(ov).then(() => true, (e) => (e.name === 'NotFoundError' ? false : e.name));
      postMessage({ left, merging: (await overlayMeta(disk)).merging });`;
    const got = await page.evaluate(async (src) => {
      const w = new Worker(URL.createObjectURL(new Blob([src.replaceAll('ORIGIN', location.origin)], { type: 'text/javascript' })), { type: 'module' });
      return await new Promise((resolve, reject) => { w.onmessage = (e) => resolve(e.data); w.onerror = (e) => reject(new Error(e.message)); });
    }, src);
    assert.deepEqual(got, { left: false, merging: '' });
  } finally {
    await browser.close();
    server.close();
  }
});

// Review disk-writes 3: the machine that has the merged overlay chosen opens it first (exclusive); the merge's resume,
// at the stored disk's opening, then asked for it shared and waited on itself (Web Locks aren't re-entrant), 10 s and
// "in use", at every start.
test('a machine whose disk is marked by a merge cut off of the overlay it has chosen starts: the merge is finished first', async () => {
  const size = 32 * 4096;
  const disk = 'disks/merge-chosen', ov = 'overlays/merge-chosen';
  let f = await openStoredForWriting(disk, 'stored', size);
  await importImage(bufferSource(new Uint8Array(size).fill(3)), f);
  writeMeta(f.meta, { ...readMeta(f.meta), generation: readMeta(f.meta).generation + 1, merging: ov });
  f.close();
  const o = await openOverlay(ov, 'over-it');
  assert.ok(await overlay(zeroDisk(size), o.data, o.map, o.meta).write(4096, new Uint8Array(4096).fill(0xaa)));
  o.close();
  const memory = new WebAssembly.Memory({ initial: 4, maximum: 4, shared: true });
  const started = performance.now();
  const d = await Devices.open({ memory, shared: [0, 1024], ram: 8192, ramSize: 0, signal: 4096, deterministic: true, specs: [{ type: 'blk', stored: disk, size, overlay: ov, identity: 'over-it' }] }, () => {});
  const ms = performance.now() - started;
  d.close();
  assert.ok(ms < 5000, `opened in ${Math.round(ms)} ms`);
  assert.equal((await overlayMeta(disk)).merging, '', 'the merge finished');
  const src = await openStored(disk, size);
  assert.equal(src.read(4096, 1)![0], 0xaa, "the overlay's block is the disk's");
  src.close();
});

// Review cut-jobs 5: a start in another tab during a merge waited on the disk, then opened the overlay the merge had
// just copied in and deleted as a new one; the merge then forgot its record, and the guest's writes went nowhere.
test('a machine whose stored disk a merge holds (another tab) is refused at once (the page says a merge runs); one held by no merge starts', async () => {
  const size = 32 * 4096;
  const disk = 'disks/merge-held', ov = 'overlays/merge-held';
  const f = await openStoredForWriting(disk, 'stored', size);
  await importImage(bufferSource(new Uint8Array(size).fill(3)), f);
  f.close();
  const open = () => Devices.open({ memory: new WebAssembly.Memory({ initial: 4, maximum: 4, shared: true }), shared: [0, 1024], ram: 8192, ramSize: 0, signal: 4096, deterministic: true, specs: [{ type: 'blk', stored: disk, size, overlay: ov, identity: 'over-it' }] }, () => {});
  let letGo!: () => void;
  const merging = new Promise<void>((r) => { letGo = r; });
  let taken!: () => void;
  const got = new Promise<void>((r) => { taken = r; });
  const merge = navigator.locks.request(`waarm64-merge:${disk}`, () => (taken(), merging)); // web/app/merge.ts holds it
  await got;
  const started = performance.now();
  let refused: unknown;
  await assert.rejects(open().catch((e: unknown) => { refused = e; throw e; }), (e: unknown) => (e as { problem?: string }).problem === 'disk-merging');
  const [problem, error] = explain(refused, MACHINES.buildroot, { restoring: false, ramMiB: 64 });
  assert.deepEqual([problem, msgOf((error as Error).cause)?.key], ['disk-in-use', 'machine:worker-errors.diskMerging.cause'], 'said as a merge, Retry offered');
  assert.ok(performance.now() - started < 5000, 'without waiting on the disk');
  letGo();
  await merge;
  const d = await open();
  d.close();
});

// Review cut-jobs 9: the page's sweep of cut-off fills stopped at the first entry whose removal failed (a closing
// worker's handles lingering), and the entries after it waited for the next page start.
test('the sweep of cut-off fills goes on past an entry it can\'t remove, then says it failed', async () => {
  const files = memoryFiles();
  const store = new Store(memoryRecords(), files, { channel: false });
  const ids = ['c0000000000a', 'c0000000000b'];
  for (const id of ids) {
    files.write(`overlays/${id}/meta`, 48);
    const f = await openOverlay(`overlays/${id}`, 'x');
    writeMeta(f.meta, { generation: 1, merging: '', size: 0, filling: true });
    f.close();
    await navigator.locks.request(`waarm64-overlay:overlays/${id}`, async () => {});
  }
  const get = store.get.bind(store);
  store.get = ((kind: 'overlays', id: string) => (id === ids[0] ? Promise.reject(new Error('busy')) : get(kind, id))) as typeof store.get;
  await assert.rejects(store.dropCutFills(), /busy/);
  assert.equal((await overlayMeta(`overlays/${ids[1]}`)).filling, undefined, 'the second removed all the same');
  assert.equal((await overlayMeta(`overlays/${ids[0]}`)).filling, true, 'the first left for the next start');
});

// Review cut-jobs 8: an overlay a fill was cut off in reads as empty, yet its record took the size of its files, so
// the Home page and a merge's confirmation spoke of changes it doesn't hold.
test("in Chromium (OPFS): a marked overlay's record says it holds nothing, whatever its files' size", async () => {
  const server = await startServer();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
  try {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/tests/browser/core.html`);
    const bytes = await page.evaluate(async () => {
      const { Store } = await import('/web/app/store.ts' as string);
      const { refreshOverlay } = await import('/web/app/disks.ts' as string);
      const { encodeMeta } = await import('/web/overlay.ts' as string);
      const id = 'c0000000000c';
      const dir = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('overlays', { create: true })).getDirectoryHandle(id, { create: true });
      const put = async (name: string, b: Uint8Array<ArrayBuffer>) => {
        const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
        await w.write(b);
        await w.close();
      };
      await put('data', new Uint8Array(8192).fill(1));
      const at = async (filling: boolean) => {
        await put('meta', encodeMeta({ generation: 3, merging: '', size: 0, filling }));
        return (await refreshOverlay(store, id)).bytes;
      };
      const store = await Store.open();
      await store.put('overlays', { id, name: 'cut', disk: 'd0000000000c', identity: { kind: 'blank', id: 'd0000000000c', bytes: 0 }, generation: 0, bytes: 0, created: 0, modified: 0 });
      const out = [await at(true), await at(false)];
      store.close();
      return out;
    });
    assert.deepEqual(bytes, [0, 8192], 'marked: none; its mark cleared: its files');
  } finally {
    await browser.close();
    server.close();
  }
});
