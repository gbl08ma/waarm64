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
import { importImage, mergeOverlay, openStored, openStoredForWriting, storedEstimate, zeroDisk } from '../web/stored.ts';
import type { Source } from '../web/devices.ts';

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
