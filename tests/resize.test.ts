// Growing a disk (docs/machines.md §4.5) in Node, where overlays live in memory: web/app/resize.ts's resize (grow only, in
// sectors, refused while a machine using it runs or its files are open; what it orphans; the grow mark), the shape and
// the start's size through a grown overlay, an export's qcow2 at the grown size and its changes back into an overlay,
// a stored disk read past its old end, and a restore's fork keeping the size. (The overlay's own reads and writes past
// its base are tests/overlay.test.ts's; the device at the grown size and the worker's fork, tests/snapshot-plan.test.ts's.)
// The meta file written from a page runs in Chromium (OPFS).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { hashSource, loadChanges } from '../web/changes.ts';
import type { Source } from '../web/devices.ts';
import { msgOf } from '../web/msg.ts';
import { lockOverlay, openOverlay, overlay, overlayMeta, writeOwnSize } from '../web/overlay.ts';
import { openDisk, readChanges } from '../web/qcow2.ts';
import { changedClusters, nonZeroClusters, writeQcow2, type Sink } from '../web/qcow2-write.ts';
import { machineLock } from '../web/app/machines.ts';
import { sizeSeen } from '../web/app/disk-size.ts';
import { serialOf, shapeOf, slots, type DiskRecord, type MachineRecord } from '../web/app/shape.ts';
import { attachmentTarget, clearGrowMark, growMark, MAX_RESIZE, resize, resizeCosts } from '../web/app/resize.ts';
import { planRestore } from '../web/app/snapshots.ts';
import { overlayDir, Store, type OverlayRecord, type SnapshotRecord } from '../web/app/store.ts';
import { memoryFiles, memoryRecords } from '../web/app/store-backends.ts';
import { openStored, openStoredForWriting, zeroDisk } from '../web/stored.ts';

const MiB = 2 ** 20;
const said = (key: string) => (e: unknown) => msgOf(e)?.key === 'machines:resize.failed' && msgOf((e as Error).cause)?.key === key;

let n = 0;
/** A fresh store with a URL disk (an overlay chosen by machine A, another by B), a stored disk and a ramdisk, all attached. */
async function world() {
  const k = `${process.pid}${(n++).toString(16).padStart(4, '0')}`.slice(-8);
  const id = (p: string) => `${p}${k}`.padStart(12, '0').slice(-12);
  const store = new Store(memoryRecords(), memoryFiles(), { channel: false });
  const url: DiskRecord = { id: id('d1'), kind: 'url', name: 'disk.qcow2', size: 8 * MiB, url: 'https://example.org/disk.qcow2', identity: { kind: 'url', path: '/disk.qcow2', bytes: 1 * MiB }, created: 0 };
  const stored: DiskRecord = { id: id('d2'), kind: 'stored', name: 'stored.img', size: 4 * MiB, identity: { kind: 'stored', id: id('d2'), bytes: 0 }, generation: 0, created: 0 };
  const ram: DiskRecord = { id: id('d3'), kind: 'ramdisk', name: 'RAM', size: 2 * MiB, identity: { kind: 'ramdisk', id: id('d3'), bytes: 2 * MiB }, created: 0 };
  const ov = (o: string, disk: string): OverlayRecord => ({ id: id(o), name: o, disk, identity: url.identity, generation: 0, bytes: 0, created: 0, modified: 0 });
  const [oa, ob, os] = [ov('ca', url.id), ov('cb', url.id), ov('cs', stored.id)];
  const m = (name: string, attachments: MachineRecord['attachments']): MachineRecord => ({ id: id(name), name, ncpus: 1, ramMiB: 512, display: '2d', created: 0, modified: 0, attachments });
  const A = m('aa', [{ id: id('a1'), disk: url.id, readOnly: false, overlay: oa.id }, { id: id('a2'), disk: stored.id, readOnly: false, overlay: os.id }, { id: id('a3'), disk: ram.id, readOnly: false }]);
  const B = m('bb', [{ id: id('b1'), disk: url.id, readOnly: false, overlay: ob.id }, { id: id('b2'), disk: stored.id, readOnly: false, inPlace: true }]);
  for (const d of [url, stored, ram]) await store.put('disks', d);
  for (const o of [oa, ob, os]) await store.put('overlays', o);
  for (const x of [A, B]) await store.put('machines', x);
  const shapeNow = async (x: MachineRecord) => {
    const ds = new Map((await store.all('disks')).map((d) => [d.id, d]));
    const os = new Map((await store.all('overlays')).map((o) => [o.id, o]));
    return shapeOf(x, (i) => ds.get(i), { overlays: (i) => os.get(i) });
  };
  const snap = async (x: MachineRecord, sid: string): Promise<SnapshotRecord> => {
    const s: SnapshotRecord = { id: id(sid), machine: x.id, name: sid, created: 0, bytes: 0, shape: await shapeNow(x), shapeHash: '', pins: [] };
    await store.put('snapshots', s);
    return s;
  };
  return { store, url, stored, ram, oa, ob, os, A, B, shapeNow, snap };
}

test('resize: grow only, in sectors, of an overlay, a stored disk or a ramdisk (not a URL disk itself); what the guests see and the shape follow', async () => {
  const w = await world();
  const { store } = w;
  await assert.rejects(resize(store, { overlay: w.oa.id }, 8 * MiB), said('machines:resize.notLarger'), 'the same size');
  await assert.rejects(resize(store, { overlay: w.oa.id }, 4 * MiB), said('machines:resize.notLarger'), 'smaller');
  await assert.rejects(resize(store, { overlay: w.oa.id }, 9 * MiB + 100), said('machines:resize.unaligned'));
  await assert.rejects(resize(store, { disk: w.url.id }, 16 * MiB), said('machines:resize.notResizable'));
  await assert.rejects(resize(store, { overlay: 'ffffffffffff' }, 16 * MiB), said('machines:resize.gone'));
  await assert.rejects(resize(store, { overlay: w.oa.id }, MAX_RESIZE + 512), said('machines:resize.tooLarge'), 'past the cap');
  // What a machine's Disks tab resizes: its overlay, its stored disk in place, its ramdisk.
  assert.deepEqual(w.A.attachments.map((a) => attachmentTarget(a, [w.url, w.stored, w.ram].find((d) => d.id === a.disk))), [{ overlay: w.oa.id }, { overlay: w.os.id }, { disk: w.ram.id }]);
  assert.deepEqual(attachmentTarget(w.B.attachments[1], w.stored), { disk: w.stored.id });
  assert.equal(attachmentTarget({ ...w.B.attachments[0], readOnly: true }, w.url), undefined, 'none read-only');
  assert.equal(attachmentTarget({ ...w.B.attachments[0], overlay: undefined }, w.url), undefined, 'none without an overlay');

  const before = await w.shapeNow(w.A);
  const costs = await resize(store, { overlay: w.oa.id }, 16 * MiB + 512, { grow: true });
  assert.deepEqual(costs.machines.map((m) => m.name), ['aa'], "only the machine that has the overlay chosen");
  assert.equal(costs.size, 8 * MiB);
  const oa = (await store.get('overlays', w.oa.id))!;
  assert.equal(oa.size, 16 * MiB + 512);
  assert.deepEqual(oa.grow, { from: 8 * MiB, to: 16 * MiB + 512 });
  assert.equal((await overlayMeta(overlayDir(w.oa.id))).size, 16 * MiB + 512, 'in its meta, which the device worker reads');
  const after = await w.shapeNow(w.A);
  assert.equal(after.disks[0].size, 16 * MiB + 512, 'the shape has the grown size');
  assert.deepEqual(after.disks[0].identity, before.disks[0].identity, 'the identity as it was: the overlay still belongs to the disk');
  assert.equal((await w.shapeNow(w.B)).disks[0].size, 8 * MiB, "B's overlay of the same disk is as it was");
  assert.equal(shapeOf(w.A, (i) => (i === w.url.id ? w.url : i === w.stored.id ? w.stored : w.ram)).disks[0].size, 8 * MiB, 'without the overlays: the disk\'s');
  // A second resize keeps the first's "from" (the guest hasn't followed either); without the box, the mark goes.
  await resize(store, { overlay: w.oa.id }, 32 * MiB, { grow: true });
  assert.deepEqual(await growMark(store, { overlay: w.oa.id }), { from: 8 * MiB, to: 32 * MiB });
  await clearGrowMark(store, { overlay: w.oa.id });
  assert.equal(await growMark(store, { overlay: w.oa.id }), undefined);
  await resize(store, { overlay: w.oa.id }, 33 * MiB, { grow: true });
  await resize(store, { overlay: w.oa.id }, 34 * MiB);
  assert.equal(await growMark(store, { overlay: w.oa.id }), undefined, 'a resize without the box clears it');

  // A stored disk: its record grows; an overlay over it is the larger of its own and the disk's; in place, the disk's.
  const r = await resize(store, { disk: w.stored.id }, 6 * MiB, { grow: true });
  assert.deepEqual(r.machines.map((m) => m.name).sort(), ['aa', 'bb']);
  const stored = (await store.get('disks', w.stored.id))!;
  assert.equal(stored.size, 6 * MiB);
  assert.deepEqual(stored.identity, w.stored.identity, "its identity keeps the size it was made with (its overlays' base files record it)");
  assert.deepEqual(stored.grow, { from: 4 * MiB, to: 6 * MiB });
  assert.equal((await w.shapeNow(w.A)).disks[1].size, 6 * MiB);
  assert.equal((await w.shapeNow(w.B)).disks[1].size, 6 * MiB, 'written in place');
  await resize(store, { overlay: w.os.id }, 10 * MiB);
  assert.equal((await w.shapeNow(w.A)).disks[1].size, 10 * MiB);
  const r2 = await resize(store, { disk: w.stored.id }, 8 * MiB);
  assert.deepEqual(r2.machines.map((m) => m.name), ['bb'], "A's overlay is larger already: its guest sees no change");

  // A ramdisk: its record; no mark (it is empty at every start).
  await resize(store, { disk: w.ram.id }, 3 * MiB, { grow: true });
  assert.equal((await store.get('disks', w.ram.id))!.size, 3 * MiB);
  assert.equal(await growMark(store, { disk: w.ram.id }), undefined);
  assert.equal((await w.shapeNow(w.A)).disks[2].size, 3 * MiB);

  // The start's size is the shape's (web/app/run/page-disks.ts): through the overlay, past the disk's.
  const a = w.A.attachments[0];
  assert.equal(sizeSeen(w.url, a, await store.get('overlays', w.oa.id)), 34 * MiB);
  assert.equal(sizeSeen(w.url, { ...a, readOnly: true }, await store.get('overlays', w.oa.id)), 8 * MiB, 'read-only: the disk as it is');
});

test("resize: refused while a machine using it runs, or its overlay or stored disk is open; the snapshots it orphans are its machines' at the size now", async () => {
  const w = await world();
  const { store } = w;
  const s1 = await w.snap(w.A, 's1');
  const s2 = await w.snap(w.B, 's2');
  await resize(store, { disk: w.ram.id }, 4 * MiB);
  const s3 = await w.snap(w.A, 's3'); // made after: the ramdisk at 4 MiB
  const costs = await resizeCosts(store, { disk: w.ram.id }, 8 * MiB);
  assert.deepEqual(costs.snapshots.map((s) => s.name), ['s3'], 's1 is orphaned already (the ramdisk grew since); B has no ramdisk');
  const c2 = await resizeCosts(store, { disk: w.stored.id }, 8 * MiB);
  assert.deepEqual(c2.snapshots.map((s) => s.name).sort(), [s1.name, s2.name, s3.name].sort());

  // A running machine (its page's lock) refuses it, with its name; the other machine's overlay is free to grow.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let granted!: () => void;
  const got = new Promise<void>((r) => (granted = r));
  void navigator.locks.request(machineLock(w.A.id), () => (granted(), held));
  await got;
  const c3 = await resizeCosts(store, { overlay: w.oa.id }, 16 * MiB);
  assert.deepEqual(c3.running.map((m) => m.name), ['aa']);
  await assert.rejects(resize(store, { overlay: w.oa.id }, 16 * MiB), (e: unknown) => said('machines:resize.running')(e) && msgOf((e as Error).cause)?.params?.count === 1);
  await assert.rejects(resize(store, { disk: w.stored.id }, 16 * MiB), said('machines:resize.running'));
  assert.equal((await store.get('overlays', w.oa.id))!.size, undefined, 'nothing changed');
  await resize(store, { overlay: w.ob.id }, 16 * MiB);
  release();

  // Its files open (a machine the store doesn't know runs, an export): refused too, and nothing changes.
  const f = await openOverlay(overlayDir(w.oa.id), 'x');
  await assert.rejects(resize(store, { overlay: w.oa.id }, 16 * MiB), said('machines:resize.inUse'));
  f.close();
  const unlock = await lockOverlay(`disks/${w.stored.id}`, 1000, 'shared'); // a machine reading it under its overlay
  await assert.rejects(resize(store, { disk: w.stored.id }, 16 * MiB), said('machines:resize.inUse'));
  unlock();
  assert.equal((await store.get('disks', w.stored.id))!.size, 4 * MiB);
  await resize(store, { overlay: w.oa.id }, 16 * MiB);
  await resize(store, { disk: w.stored.id }, 16 * MiB);
});

const source = (b: Uint8Array): Source => ({ size: b.length, read: (off, len) => (off >= 0 && off + len <= b.length ? b.slice(off, off + len) : undefined) });

test("a grown overlay exports at its size (whole, and changes larger than their backing file), and its changes come back into a grown overlay", async () => {
  const baseSize = 64 * 4096 + 512;
  const size = 256 * 4096;
  const baseBytes = Uint8Array.from({ length: baseSize }, (_, k) => (k * 2654435761) >>> 24);
  const base = openDisk((off, len) => baseBytes.slice(off, off + len), baseSize);
  const name = `overlays/export-grown-${process.pid}`;
  const release = await lockOverlay(name);
  await writeOwnSize(name, size); // as Store.resize does
  release();
  const g = await openOverlay(name, 'export-base');
  const d = overlay(base, g.data, g.map, g.meta); // as the export worker opens it (with its meta)
  assert.equal(d.size, size);
  assert.ok(await d.write(size - 4096, new Uint8Array(4096).fill(0xee)));
  assert.ok(await d.write(100, new Uint8Array(10).fill(0x11)));
  const file = async (o: Parameters<typeof writeQcow2>[0]['clusters'], backing?: Parameters<typeof writeQcow2>[0]['backing']) => {
    const parts: Uint8Array[] = [];
    const sink: Sink = (chunk, at) => { if (at === undefined) parts.push(chunk.slice()); else parts[0] = chunk.slice(); };
    await writeQcow2({ size: d.size, clusters: o, backing, sink });
    return new Uint8Array(Buffer.concat(parts));
  };
  const whole = await file(nonZeroClusters(d));
  const image = openDisk((off, len) => whole.slice(off, off + len), whole.length);
  assert.equal(image.size, size, "the whole disk's qcow2 has the grown virtual size");
  assert.equal(Buffer.compare((await image.read(0, size))!, (await d.read(0, size))!), 0);
  const changes = await file(changedClusters(d), { name: 'base.img', format: 'raw', hash: await hashSource(source(baseBytes), () => {}) });
  const c = readChanges((off, len) => changes.slice(off, off + len), changes.length)!;
  assert.equal(c.size, size, 'changes larger than their backing file');
  g.close();
  // Back in: a new overlay with the grown size, reading as the exported disk.
  const back = `overlays/export-back-${process.pid}`;
  await loadChanges({ changes: source(changes), base: source(baseBytes), label: 'base.img', overlay: back, identity: 'export-base' });
  assert.equal((await overlayMeta(back)).size, size);
  const h = await openOverlay(back, 'export-base');
  const e = overlay(base, h.data, h.map, h.meta);
  assert.equal(e.size, size);
  assert.equal(Buffer.compare((await e.read(0, size))!, (await image.read(0, size))!), 0);
  h.close();
});

test('a stored disk grown reads zeros past its old end, takes writes there in place, and an overlay over it sees them', async () => {
  const path = `disks/grown-${process.pid}`;
  const old = 8 * 4096;
  const size = 32 * 4096;
  let f = await openStoredForWriting(path, 'stored', old);
  assert.ok(await overlay(zeroDisk(old), f.data, f.map, f.meta).write(0, new Uint8Array(old).fill(3)));
  f.close();
  // Its record grew (Store.resize): it opens at the new size, written in place over zeros as the device does.
  f = await openStoredForWriting(path, 'stored', size);
  const inPlace = overlay(zeroDisk(size), f.data, f.map, f.meta);
  assert.ok((await inPlace.read(old, size - old))!.every((x) => x === 0));
  assert.ok(await inPlace.write(size - 4096, new Uint8Array(4096).fill(9)));
  f.close();
  const src = await openStored(path, size);
  assert.equal(src.read(old - 1, 1)![0], 3);
  assert.equal(src.read(old, 1)![0], 0);
  assert.equal(src.read(size - 1, 1)![0], 9);
  const o = await openOverlay(`overlays/over-grown-${process.pid}`, 'over');
  const d = overlay(openDisk((off, len) => src.read(off, len), size), o.data, o.map, o.meta, size);
  assert.equal((await d.read(size - 4096, 4096))!.every((x) => x === 9), true);
  o.close();
  src.close();
});

test("a restore's fork of a grown overlay keeps its size: the fork's record and the worker's plan", async () => {
  const w = await world();
  const { store } = w;
  await resize(store, { overlay: w.oa.id }, 16 * MiB);
  const slot = slots({ nets: 0, display: '2d', attachments: w.A.attachments }).findIndex((s) => s.attachment === 0);
  const ds = new Map((await store.all('disks')).map((d) => [d.id, d]));
  // The snapshot pinned the overlay at generation 0; it has moved on since: the restore forks.
  const pins = [{ slot, identity: 'x', size: 16 * MiB, blocks: 1, overlay: overlayDir(w.oa.id), generation: 7 }];
  const plan = await planRestore(store, (await store.get('machines', w.A.id))!, ds, { name: 'snap', key: 'k', pins }, { display: '2d', devices: [] });
  assert.equal(plan.forks.length, 1);
  const steps = await plan.commit(false);
  const write = steps.find((s) => s.action === 'write');
  assert.ok(write && write.action === 'write');
  assert.equal(write.size, 16 * MiB, "the worker writes the fork at the snapshot's size");
  const m = (await store.get('machines', w.A.id))!;
  const fork = (await store.get('overlays', m.attachments[0].overlay!))!;
  assert.notEqual(fork.id, w.oa.id);
  assert.equal(fork.size, 16 * MiB, "the fork's record");
  assert.equal(serialOf(m.attachments[0].id), (await w.shapeNow(m)).disks[0].serial);
  assert.equal((await w.shapeNow(m)).disks[0].size, 16 * MiB, 'the machine with its fork has the shape it had');
});

test("in Chromium (OPFS, from a page): an overlay's own size written into a meta file of 32 bytes keeps its generation and merging", async () => {
  const server = await startServer();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
  try {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/tests/browser/core.html`);
    const r = await page.evaluate(async () => {
      const { encodeMeta, lockOverlay, opfsDir, overlayMeta, writeOwnSize } = await import('/web/overlay.ts' as string);
      const name = 'overlays/resize-test';
      const meta = await (await opfsDir(name, true)).getFileHandle('meta', { create: true });
      const w = await meta.createWritable();
      await w.write(encodeMeta({ generation: 9, merging: 'c00000000001', size: 0 }).subarray(0, 32)); // as pages before sizes wrote it
      await w.close();
      const was = await overlayMeta(name);
      const release = await lockOverlay(name);
      await writeOwnSize(name, 3 << 20);
      release();
      const fresh = 'overlays/resize-fresh';
      await writeOwnSize(fresh, 1 << 20); // no files yet
      return { was, now: await overlayMeta(name), bytes: (await meta.getFile()).size, fresh: await overlayMeta(fresh) };
    });
    assert.deepEqual(r, {
      was: { generation: 9, merging: 'c00000000001', size: 0 },
      now: { generation: 9, merging: 'c00000000001', size: 3 << 20 },
      bytes: 40,
      fresh: { generation: 0, merging: '', size: 1 << 20 },
    });
  } finally {
    await browser.close();
    server.close();
  }
});
