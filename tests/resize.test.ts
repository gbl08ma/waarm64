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
import { baseHash, hashSource, loadChanges } from '../web/changes.ts';
import type { Source } from '../web/disk-sources.ts';
import { msgOf } from '../web/msg.ts';
import { t } from '../web/i18n.ts';
import { lockOverlay, openOverlay, overlay, overlayMeta, writeMeta, writeOwnSize } from '../web/overlay.ts';
import { openDisk, readChanges } from '../web/qcow2.ts';
import { changedClusters, nonZeroClusters, writeQcow2, type Sink } from '../web/qcow2-write.ts';
import { machineLock } from '../web/app/machines.ts';
import { sizeSeen } from '../web/app/disk-size.ts';
import { serialOf, shapeHash, shapeOf, slots, type DiskRecord, type MachineRecord } from '../web/app/shape.ts';
import { attachmentTarget, clearGrowMark, growFailed, growMark, growsOf, keepSize, MAX_RESIZE, resize, resizeCosts, sizeOrphans } from '../web/app/resize.ts';
import { createOverlay, newEmptyOverlay, refreshOverlay } from '../web/app/disks.ts';
import { exportDefinition, importDefinition, parseDefinition } from '../web/app/definitions.ts';
import { restoreLoaded } from '../web/app/snapshot-undo.ts';
import { planRestore } from '../web/app/snapshots.ts';
import { machineLike } from '../web/app/machine-like.ts';
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
  assert.deepEqual(w.A.attachments.map((a) => attachmentTarget(w.A, a, [w.url, w.stored, w.ram].find((d) => d.id === a.disk))), [{ overlay: w.oa.id }, { overlay: w.os.id }, { disk: w.ram.id }]);
  assert.deepEqual(attachmentTarget(w.B, w.B.attachments[1], w.stored), { disk: w.stored.id });
  assert.equal(attachmentTarget(w.B, { ...w.B.attachments[0], readOnly: true }, w.url), undefined, 'none read-only');
  assert.deepEqual(attachmentTarget(w.B, { ...w.B.attachments[0], overlay: undefined }, w.url), { machine: w.B.id, attachment: w.B.attachments[0].id }, 'without an overlay: the one to make');

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

test("the run's grows (growsOf): a marked overlay, a stored disk's mark under an overlay and in place (the first machine to boot it clears it for both), a failure noted; none read-only or for a ramdisk", async () => {
  const w = await world();
  const { store } = w;
  assert.deepEqual(await growsOf(store, w.A.id), [], 'no marks');
  await resize(store, { overlay: w.oa.id }, 16 * MiB, { grow: true });
  await resize(store, { disk: w.stored.id }, 6 * MiB, { grow: true });
  await resize(store, { disk: w.ram.id }, 3 * MiB, { grow: true });
  const [a1, a2] = w.A.attachments;
  assert.deepEqual(await growsOf(store, w.A.id), [
    { serial: serialOf(a1.id), name: 'disk.qcow2', size: 16 * MiB, marks: [{ target: { overlay: w.oa.id }, mark: { from: 8 * MiB, to: 16 * MiB } }] },
    { serial: serialOf(a2.id), name: 'stored.img', size: 6 * MiB, marks: [{ target: { disk: w.stored.id }, mark: { from: 4 * MiB, to: 6 * MiB } }] },
  ], "A: its overlay's mark; the stored disk's through its overlay over it; not the ramdisk");
  const b2 = w.B.attachments[1];
  assert.deepEqual(await growsOf(store, w.B.id), [
    { serial: serialOf(b2.id), name: 'stored.img', size: 6 * MiB, marks: [{ target: { disk: w.stored.id }, mark: { from: 4 * MiB, to: 6 * MiB } }] },
  ], 'B: the stored disk written in place (its overlay of the URL disk has no mark)');
  // A failure noted on the mark; a new resize starts afresh.
  await growFailed(store, { disk: w.stored.id });
  assert.deepEqual(await growMark(store, { disk: w.stored.id }), { from: 4 * MiB, to: 6 * MiB, failed: true });
  // The mark is the disk's: cleared by A's guest, B has none to send.
  await clearGrowMark(store, { disk: w.stored.id });
  assert.deepEqual((await growsOf(store, w.B.id)), []);
  assert.deepEqual((await growsOf(store, w.A.id)).map((g) => g.serial), [serialOf(a1.id)]);
  await resize(store, { disk: w.stored.id }, 7 * MiB, { grow: true });
  await growFailed(store, { disk: w.stored.id });
  await resize(store, { disk: w.stored.id }, 8 * MiB, { grow: true });
  assert.deepEqual(await growMark(store, { disk: w.stored.id }), { from: 6 * MiB, to: 8 * MiB }, "a resize's mark has no failure");
  // Read-only: none.
  await store.put('machines', { ...w.A, attachments: w.A.attachments.map((a) => ({ ...a, readOnly: true })) });
  assert.deepEqual(await growsOf(store, w.A.id), []);
  assert.deepEqual(await growsOf(store, 'ffffffffffff'), [], 'a machine gone');
});

test("a definition carries a grown overlay's size (overlaySize): the imported machine's overlay has it and its grow mark, so its guest sees the same disk", async () => {
  const w = await world();
  const { store } = w;
  await resize(store, { overlay: w.oa.id }, 16 * MiB);
  const def = await exportDefinition(store, w.A.id);
  assert.deepEqual(def.disks.map((d) => [d.size, d.overlaySize]), [[8 * MiB, 16 * MiB], [4 * MiB, undefined], [2 * MiB, undefined]], 'only the grown overlay, past its disk');
  const { machine } = await importDefinition(store, parseDefinition(JSON.stringify(def)));
  const [a] = machine.attachments;
  assert.equal(a.disk, w.url.id, 'the same disk, by identity');
  assert.ok(a.overlay && a.overlay !== w.oa.id, 'an overlay of its own');
  const o = (await store.get('overlays', a.overlay))!;
  assert.deepEqual([o.size, o.grow, o.bytes], [16 * MiB, { from: 8 * MiB, to: 16 * MiB }, 0]);
  assert.equal((await overlayMeta(overlayDir(o.id))).size, 16 * MiB, 'in its meta, which the device worker reads');
  assert.equal((await w.shapeNow(machine)).disks[0].size, (await w.shapeNow(w.A)).disks[0].size, 'the same size in the shape');
  assert.equal(machine.attachments[1].overlay, undefined, 'the others get theirs at the first start, as before');
  // A size that isn't past the disk's, or not in sectors: damaged.
  for (const overlaySize of [8 * MiB, 16 * MiB + 1, -1]) {
    const bad = { ...def, disks: [{ ...def.disks[0], overlaySize }, ...def.disks.slice(1)] };
    assert.throws(() => parseDefinition(JSON.stringify(bad)), /damaged/, String(overlaySize));
  }
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

// ---- The page review's findings (RESIZE loop 5b; bench/results/local/resize/review-page-resize.md) ----

/** The slot attachment `i` of machine `m` takes (no network, 2D). */
const slotOf = (m: MachineRecord, i: number) => slots({ nets: 0, display: '2d', attachments: m.attachments }).findIndex((s) => s.attachment === i);
const disksOf = async (store: Store) => new Map((await store.all('disks')).map((d) => [d.id, d]));
/** Overlay `id`'s meta made with `generation` (and its own `size`), as a machine's run leaves it. */
async function metaAt(id: string, generation: number, size = 0) {
  const f = await openOverlay(overlayDir(id), undefined);
  assert.ok(writeMeta(f.meta, { generation, merging: '', size }));
  f.close();
}

test('finding 1: a restore commits on the machine record as it is when it commits, not the one it was planned on (edits since stay)', async () => {
  const w = await world();
  const { store } = w;
  const planned = (await store.get('machines', w.A.id))!; // the page's record, as it loaded it
  const pins = [{ slot: slotOf(w.A, 0), identity: 'x', size: 8 * MiB, blocks: 1, overlay: overlayDir(w.oa.id), generation: 7 }];
  const plan = await planRestore(store, planned, await disksOf(store), { name: 'snap', key: 'k', pins }, { display: '2d', devices: [] });
  assert.equal(plan.forks.length, 1);
  // Meanwhile (the Home page, another tab): renamed, its URL disk switched to another overlay.
  const third = await createOverlay(store, w.url, 'Third');
  const edited = structuredClone((await store.get('machines', w.A.id))!);
  edited.name = 'renamed';
  edited.attachments[0].overlay = third.id;
  await store.put('machines', edited);
  const steps = await plan.commit(false);
  const m = (await store.get('machines', w.A.id))!;
  assert.equal(m.name, 'renamed', 'the edit made since stays');
  const write = steps.find((s) => s.action === 'write');
  assert.ok(write && write.action === 'write');
  assert.equal(write.overlay, overlayDir(m.attachments[0].overlay!), 'the worker fills the overlay the record attaches');
  assert.ok(![w.oa.id, third.id].includes(m.attachments[0].overlay!), 'a fork');
  assert.equal(m.attachments[1].overlay, w.os.id, 'the other disks as they are');
});

test("finding 2: a stored disk's grow mark goes only to the machines whose disk it grew (not through an overlay larger already)", async () => {
  const w = await world();
  const { store } = w;
  // X's overlay of the stored disk was grown past its new size before (that grow done: no mark).
  const ox: OverlayRecord = { ...w.os, id: 'c0000000000x', name: 'x' };
  await store.put('overlays', ox);
  const X: MachineRecord = { ...w.A, id: 'b0000000000x', name: 'xx', attachments: [{ id: 'a0000000000x', disk: w.stored.id, readOnly: false, overlay: ox.id }] };
  await store.put('machines', X);
  await resize(store, { overlay: ox.id }, 32 * MiB);
  const costs = await resize(store, { disk: w.stored.id }, 16 * MiB, { grow: true });
  assert.deepEqual(costs.machines.map((m) => m.name).sort(), ['aa', 'bb'], 'its disk grows for A and B, not X');
  assert.deepEqual(await growsOf(store, X.id), [], "X's guest saw no change: no GROW for it");
  assert.deepEqual((await growsOf(store, w.A.id)).map((g) => [g.serial, g.size]), [[serialOf(w.A.attachments[1].id), 16 * MiB]]);
  // An overlay of its own below the disk's new size: the disk's grow is its guest's too.
  await resize(store, { overlay: w.os.id }, 18 * MiB);
  await resize(store, { disk: w.stored.id }, 20 * MiB, { grow: true });
  assert.deepEqual((await growsOf(store, w.A.id)).map((g) => g.size), [20 * MiB]);
});

test("finding 3: an earlier fork grown since isn't reused: the snapshot's disk had another size", async () => {
  const w = await world();
  const { store } = w;
  const fork: OverlayRecord = { ...w.ob, id: 'c0000000000f', name: 'snap', fork: { snapshot: 'k', generation: 1 }, generation: 1, size: 16 * MiB };
  await store.put('overlays', fork);
  await metaAt(fork.id, 1, 16 * MiB);
  const pins = [{ slot: slotOf(w.A, 0), identity: 'x', size: 8 * MiB, blocks: 1, overlay: overlayDir(w.oa.id), generation: 7 }];
  const plan = await planRestore(store, (await store.get('machines', w.A.id))!, await disksOf(store), { name: 'snap', key: 'k', pins }, { display: '2d', devices: [] });
  assert.deepEqual(plan.forks.map((f) => f.reused), [false], 'a new fork, at the snapshot\'s size');
  // At the size it was forked at, it's reused.
  await store.put('overlays', { ...fork, size: undefined });
  await metaAt(fork.id, 1, 0);
  const again = await planRestore(store, (await store.get('machines', w.A.id))!, await disksOf(store), { name: 'snap', key: 'k', pins }, { display: '2d', devices: [] });
  assert.deepEqual(again.forks.map((f) => f.reused), [true]);
});

test("finding 4: a grown overlay made by the page (a restore's fork) has its size in its meta at once, not only after the worker's fill", async () => {
  const w = await world();
  const o = await createOverlay(w.store, w.url, 'f', { snapshot: 'k', generation: 1 }, 16 * MiB);
  assert.equal(o.size, 16 * MiB);
  assert.equal((await overlayMeta(overlayDir(o.id))).size, 16 * MiB, 'what an export opens it at');
  const plain = await createOverlay(w.store, w.url, 'g');
  assert.equal((await overlayMeta(overlayDir(plain.id))).size, 0);
});

test("finding 5: a resize whose record write is refused leaves the overlay's meta at the record's size; a meta past its record is taken into it", async () => {
  const w = await world();
  const { store } = w;
  const put = store.put.bind(store);
  let refuse = true;
  store.put = (async (kind: Parameters<Store['put']>[0], r: Parameters<Store['put']>[1]) => {
    if (kind === 'overlays' && refuse) {
      refuse = false;
      throw new Error('refused');
    }
    return put(kind, r);
  }) as Store['put'];
  await assert.rejects(resize(store, { overlay: w.oa.id }, 16 * MiB, { grow: true }), /refused/);
  assert.equal((await store.get('overlays', w.oa.id))!.size, undefined);
  assert.equal((await overlayMeta(overlayDir(w.oa.id))).size, 0, 'the meta as the record says');
  // Cut off between the two (a tab closed): the meta has it, the record not; the next refresh takes it.
  await writeOwnSize(overlayDir(w.oa.id), 12 * MiB);
  await refreshOverlay(store, w.oa.id);
  assert.equal((await store.get('overlays', w.oa.id))!.size, 12 * MiB);
  assert.equal(await sizeNowOf(store, w.oa.id), 12 * MiB, 'Resize… says the size the guest sees');
});
const sizeNowOf = async (store: Store, id: string) => (await resizeCosts(store, { overlay: id }, MAX_RESIZE)).size;

test("finding 6: a restore's fork of a snapshot taken after a resize its guest hadn't followed keeps the grow mark", async () => {
  const w = await world();
  const { store } = w;
  await resize(store, { overlay: w.oa.id }, 16 * MiB, { grow: true });
  const pins = (size: number) => [{ slot: slotOf(w.A, 0), identity: 'x', size, blocks: 1, overlay: overlayDir(w.oa.id), generation: 7 }];
  const fork = async (size: number) => {
    const plan = await planRestore(store, (await store.get('machines', w.A.id))!, await disksOf(store), { name: 'snap', key: `k${size}`, pins: pins(size) }, { display: '2d', devices: [] });
    await plan.commit(false);
    await restoreLoaded(store, w.A.id); // it loaded: the next restore isn't stacked on one to undo
    const m = (await store.get('machines', w.A.id))!;
    return (await store.get('overlays', m.attachments[0].overlay!))!;
  };
  const after = await fork(16 * MiB);
  assert.notEqual(after.id, w.oa.id);
  assert.deepEqual(after.grow, { from: 8 * MiB, to: 16 * MiB }, 'taken at the new size, the partition not grown yet');
  assert.deepEqual((await growsOf(store, w.A.id)).map((g) => g.marks.map((x) => x.target)), [[{ overlay: after.id }]]);
  assert.deepEqual((await store.get('overlays', w.oa.id))!.grow, { from: 8 * MiB, to: 16 * MiB }, 'the resized overlay keeps its own');
  const before = await fork(8 * MiB);
  assert.equal(before.grow, undefined, 'taken before the resize: the fork is at the old size, nothing to grow');
});

test("finding 7: a machine like a snapshot gets the disk sizes the snapshot had (a grown overlay's, a ramdisk grown since)", async () => {
  const w = await world();
  const { store } = w;
  await resize(store, { overlay: w.oa.id }, 16 * MiB);
  const shape = await w.shapeNow(w.A); // the URL disk seen at 16 MiB, the ramdisk at 2 MiB
  const hash = await shapeHash(shape);
  await resize(store, { disk: w.ram.id }, 3 * MiB);
  const like = await machineLike(store, { id: 'eeeeeeeeeee7', machine: w.A.id, name: 'snap', shape });
  assert.equal(await shapeHash(await w.shapeNow(like)), hash, "the snapshot's shape");
  // A stored disk grown since can't be seen smaller: refused, said why.
  await resize(store, { disk: w.stored.id }, 6 * MiB);
  await assert.rejects(machineLike(store, { id: 'eeeeeeeeeee8', machine: w.A.id, name: 'snap', shape }), (e: unknown) => msgOf((e as Error).cause)?.key === 'snapshots:machine-like.storedDiskGrown.cause');
});

test('finding 8: New empty keeps the size its attachment had (marked to grow); a switch to an overlay of another size says what it orphans; changes imported keep it too', async () => {
  const w = await world();
  const { store } = w;
  await resize(store, { overlay: w.oa.id }, 16 * MiB);
  const s = await w.snap(w.A, 'kept');
  const before = await shapeHash(await w.shapeNow(w.A));
  const a = w.A.attachments[0].id;
  const m = (await store.get('machines', w.A.id))!;
  const o = await newEmptyOverlay(store, m, a, 'fresh');
  assert.equal(o.size, 16 * MiB);
  assert.deepEqual(o.grow, { from: 8 * MiB, to: 16 * MiB }, "its base's partition doesn't fill it");
  assert.equal((await overlayMeta(overlayDir(o.id))).size, 16 * MiB);
  assert.equal(await shapeHash(await w.shapeNow((await store.get('machines', w.A.id))!)), before, 'the same shape: nothing orphaned');
  // A switch to B's overlay (8 MiB): the snapshots made at 16 MiB are orphaned, and the switch says so first.
  assert.deepEqual((await sizeOrphans(store, w.A.id, a, { overlay: w.ob.id })).map((x) => x.id), [s.id]);
  assert.deepEqual(await sizeOrphans(store, w.A.id, a, { overlay: w.oa.id }), [], 'the same size: none');
  // Changes imported into a new overlay smaller than the attachment's: grown to it, marked.
  const imported = await createOverlay(store, w.url, 'imported');
  const kept = await keepSize(store, imported, 16 * MiB);
  assert.deepEqual([kept.size, kept.grow], [16 * MiB, { from: 8 * MiB, to: 16 * MiB }]);
  assert.equal((await overlayMeta(overlayDir(imported.id))).size, 16 * MiB);
});

test("finding 10: a definition's overlaySize past MAX_RESIZE is damaged", async () => {
  const w = await world();
  await resize(w.store, { overlay: w.oa.id }, 16 * MiB);
  const def = await exportDefinition(w.store, w.A.id);
  const bad = { ...def, disks: [{ ...def.disks[0], overlaySize: MAX_RESIZE + 512 }, ...def.disks.slice(1)] };
  assert.throws(() => parseDefinition(JSON.stringify(bad)), /damaged/);
  const ok = { ...def, disks: [{ ...def.disks[0], overlaySize: MAX_RESIZE }, ...def.disks.slice(1)] };
  parseDefinition(JSON.stringify(ok));
});

test("finding 11: a grown stored disk's definition asks for the image it was made from, under an overlay at the grown size, marked", async () => {
  const w = await world();
  await resize(w.store, { disk: w.stored.id }, 6 * MiB);
  const def = await exportDefinition(w.store, w.B.id);
  const sd = def.disks[1];
  assert.deepEqual([sd.kind, sd.size, sd.overlaySize], ['stored', 4 * MiB, 6 * MiB], 'the size made with, and the grown one');
  // Another browser: the stored disk becomes a file to pick, of the size it was made with, under a grown overlay.
  const other = new Store(memoryRecords(), memoryFiles(), { channel: false });
  const { machine } = await importDefinition(other, parseDefinition(JSON.stringify(def)));
  const d = (await other.get('disks', machine.attachments[1].disk))!;
  assert.deepEqual([d.kind, d.size, (d.identity as { bytes: number }).bytes], ['file', 4 * MiB, 4 * MiB]);
  const o = (await other.get('overlays', machine.attachments[1].overlay!))!;
  assert.deepEqual([o.size, o.grow], [6 * MiB, { from: 4 * MiB, to: 6 * MiB }]);
  const ds = new Map((await other.all('disks')).map((x) => [x.id, x]));
  const os = new Map((await other.all('overlays')).map((x) => [x.id, x]));
  assert.equal(shapeOf(machine, (i) => ds.get(i), { overlays: (i) => os.get(i) }).disks[1].size, 6 * MiB, 'the guest sees the grown size');
});

test("finding 12: a changes file exported from a stored disk's overlay still imports after the disk grew", async () => {
  const path = `disks/hashed-${process.pid}`;
  const made = 16 * 4096;
  let f = await openStoredForWriting(path, 'stored', made);
  assert.ok(await overlay(zeroDisk(made), f.data, f.map, f.meta).write(0, new Uint8Array(made).fill(5)));
  f.close();
  // The export, before the grow: changes over the stored disk, its hash of the disk as made.
  const src = await openStored(path, made);
  const name = `overlays/hashed-${process.pid}`;
  const g = await openOverlay(name, 'hashed');
  const d = overlay(openDisk((off, len) => src.read(off, len)!, made), g.data, g.map, g.meta, made);
  assert.ok(await d.write(4096, new Uint8Array(4096).fill(7)));
  const parts: Uint8Array[] = [];
  const sink: Sink = (chunk, at) => { if (at === undefined) parts.push(chunk.slice()); else parts[0] = chunk.slice(); };
  await writeQcow2({ size: d.size, clusters: changedClusters(d), backing: { name: 'stored.img', format: 'raw', hash: await baseHash(src, undefined, () => {}) }, sink });
  const changes = new Uint8Array(Buffer.concat(parts));
  g.close();
  src.close();
  // The disk grown to four times that (its record; nothing written past its old end): the file still loads.
  const grown = await openStored(path, 4 * made);
  const back = `overlays/hashed-back-${process.pid}`;
  await loadChanges({ changes: source(changes), base: grown, made, label: 'stored.img', overlay: back, identity: 'hashed' });
  const h = await openOverlay(back, 'hashed');
  const e = overlay(openDisk((off, len) => grown.read(off, len)!, 4 * made), h.data, h.map, h.meta, 4 * made);
  assert.equal((await e.read(4096, 1))![0], 7);
  assert.equal((await e.read(0, 1))![0], 5);
  h.close();
  // Written past its old end since: its bytes aren't the ones the file was made over any more.
  grown.close();
  f = await openStoredForWriting(path, 'stored', 4 * made);
  assert.ok(await overlay(zeroDisk(4 * made), f.data, f.map, f.meta).write(3 * made, new Uint8Array(4096).fill(9)));
  f.close();
  const written = await openStored(path, 4 * made);
  await assert.rejects(loadChanges({ changes: source(changes), base: written, made, label: 'stored.img', overlay: back, identity: 'hashed' }), (e: unknown) => /otherSize|otherBase/.test(msgOf(e)?.key ?? ''));
  written.close();
});

test('finding 13: a resize reads its target again under the lock (an overlay forgotten meanwhile stays gone); a ramdisk resize holds its machines\' locks', async () => {
  const w = await world();
  const { store } = w;
  const locks = navigator.locks as LockManager & { request: LockManager['request'] };
  const request = locks.request;
  const path = overlayDir(w.oa.id);
  locks.request = (async (name: string, ...rest: unknown[]) => {
    if (name === `waarm64-overlay:${path}`) await store.forget('overlays', w.oa.id); // a merge's, between the read and the write
    return (request as (...a: unknown[]) => Promise<unknown>).call(locks, name, ...rest);
  }) as LockManager['request'];
  try {
    await assert.rejects(resize(store, { overlay: w.oa.id }, 16 * MiB), said('machines:resize.gone'));
  } finally {
    locks.request = request;
  }
  assert.equal(await store.get('overlays', w.oa.id), undefined, 'not brought back');
  // A ramdisk: while its record is written, a start of a machine that has it (its lock, ifAvailable) is refused.
  const put = store.put.bind(store);
  let free: boolean | undefined;
  store.put = (async (kind: Parameters<Store['put']>[0], r: Parameters<Store['put']>[1]) => {
    if (kind === 'disks' && r.id === w.ram.id) free = await locks.request(machineLock(w.A.id), { ifAvailable: true }, (l) => l !== null);
    return put(kind, r);
  }) as Store['put'];
  await resize(store, { disk: w.ram.id }, 4 * MiB);
  assert.equal(free, false, "A's lock held by the resize");
});

test("an attachment with no overlay chosen: Resize makes one at the new size (\"Changes\", marked) and chooses it; only its machine's disk grows; one made meanwhile is resized as itself", async () => {
  const w = await world();
  const { store } = w;
  const machine = (name: string, aid: string): MachineRecord => ({ id: `${name}${w.url.id}`.slice(-12), name, ncpus: 1, ramMiB: 512, display: '2d', created: 0, modified: 0, attachments: [{ id: `${aid}${w.url.id}`.slice(-12), disk: w.url.id, readOnly: false }] });
  const C = machine('cc', 'c1');
  await store.put('machines', C);
  const snapC = await w.snap(C, 'sc');
  const at = { machine: C.id, attachment: C.attachments[0].id };
  const costs = await resizeCosts(store, at, 16 * MiB);
  assert.equal(costs.size, 8 * MiB);
  assert.equal(costs.held, 0, 'nothing held: the overlay is to make');
  assert.deepEqual(costs.machines.map((m) => m.name), ['cc'], "A's and B's overlays of the same disk don't grow");
  assert.deepEqual(costs.snapshots.map((s) => s.id), [snapC.id]);
  await assert.rejects(resizeCosts(store, at, 8 * MiB), said('machines:resize.notLarger'));
  await assert.rejects(resizeCosts(store, { machine: w.B.id, attachment: w.B.attachments[1].id }, 16 * MiB), said('machines:resize.notResizable'), 'in place: the disk is the target');
  await assert.rejects(resizeCosts(store, { machine: C.id, attachment: 'ffffffffffff' }, 16 * MiB), said('machines:resize.gone'));

  // Its machine running: refused, nothing made.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let granted!: () => void;
  const got = new Promise<void>((r) => (granted = r));
  void navigator.locks.request(machineLock(C.id), () => (granted(), held));
  await got;
  const before = (await store.all('overlays')).length;
  await assert.rejects(resize(store, at, 16 * MiB, { grow: true }), said('machines:resize.running'));
  assert.equal((await store.all('overlays')).length, before);
  release();

  await resize(store, at, 16 * MiB, { grow: true });
  const c = (await store.get('machines', C.id))!;
  const o = c.attachments[0].overlay ? await store.get('overlays', c.attachments[0].overlay) : undefined;
  assert.ok(o, 'chosen');
  assert.deepEqual([o.name, o.disk, o.size, o.grow], [t('disks:page-disks.overlayName'), w.url.id, 16 * MiB, { from: 8 * MiB, to: 16 * MiB }]);
  assert.equal((await overlayMeta(overlayDir(o.id))).size, 16 * MiB, 'in its meta, which the device worker reads');
  assert.equal((await w.shapeNow(c)).disks[0].size, 16 * MiB);
  assert.equal((await w.shapeNow(w.A)).disks[0].size, 8 * MiB);
  // Asked again of the attachment: it's that overlay's resize now (none made).
  await resize(store, at, 32 * MiB);
  assert.equal((await store.all('overlays')).length, before + 1);
  assert.deepEqual([(await store.get('overlays', o.id))!.size, (await store.get('overlays', o.id))!.grow], [32 * MiB, undefined]);

  // One made while the resize waited for the machine's lock (a start): resized, not replaced.
  const D = machine('dd', 'd1');
  await store.put('machines', D);
  const mine = await createOverlay(store, w.url, 'Started');
  const locks = navigator.locks as LockManager & { request: LockManager['request'] };
  const request = locks.request;
  locks.request = (async (name: string, ...rest: unknown[]) => {
    if (name === machineLock(D.id)) {
      locks.request = request;
      const d = (await store.get('machines', D.id))!;
      await store.put('machines', { ...d, attachments: [{ ...d.attachments[0], overlay: mine.id }] });
    }
    return (request as (...a: unknown[]) => Promise<unknown>).call(locks, name, ...rest);
  }) as LockManager['request'];
  try {
    await resize(store, { machine: D.id, attachment: D.attachments[0].id }, 16 * MiB);
  } finally {
    locks.request = request;
  }
  assert.equal((await store.get('machines', D.id))!.attachments[0].overlay, mine.id);
  assert.equal((await store.get('overlays', mine.id))!.size, 16 * MiB);
  assert.equal((await store.all('overlays')).length, before + 2, 'no other made');
});
