// Merge into the disk (web/app/merge.ts, docs/machines.md §4.4) in Node, over the store in memory and the overlays'
// in-memory files (the disk worker's job runs here: no Worker in Node): a blank disk's overlay that nothing was written
// to (the one a resize of the disk on a machine makes) grows the blank disk; a written one makes it a stored disk of its
// blocks, at its size; what each asks first (`mergeEffect`). A stored disk's merge is tests/stored.test.ts's and
// tests/page-stored.test.ts's.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { msgOf } from '../web/msg.ts';
import { openOverlay, overlay, overlayMeta } from '../web/overlay.ts';
import { openStored, openStoredForWriting, zeroDisk } from '../web/stored.ts';
import { deleteOverlay, identityOf } from '../web/app/disks.ts';
import { mergeEffect, mergeIntoDisk } from '../web/app/merge.ts';
import { resize } from '../web/app/resize.ts';
import { shapeOf, type DiskRecord, type MachineRecord } from '../web/app/shape.ts';
import { diskDir, overlayDir, Store, type OverlayRecord, type SnapshotRecord } from '../web/app/store.ts';
import { memoryFiles, memoryRecords } from '../web/app/store-backends.ts';

const MiB = 2 ** 20;
let n = 0;

/**
 * A fresh store: a blank disk of 8 MiB attached by machine A (no overlay chosen yet: its Resize makes one) and by
 * machine B (overlay `ob`, chosen), and a kept snapshot of each.
 */
async function world() {
  const k = `${process.pid}${(n++).toString(16).padStart(4, '0')}`.slice(-8);
  const id = (p: string) => `${p}${k}`.padStart(12, '0').slice(-12);
  const store = new Store(memoryRecords(), memoryFiles(), { channel: false });
  const blank: DiskRecord = { id: id('d1'), kind: 'blank', name: 'Scratch', size: 8 * MiB, identity: { kind: 'blank', id: id('d1'), bytes: 8 * MiB }, created: 0 };
  const ob: OverlayRecord = { id: id('ob'), name: 'B', disk: blank.id, identity: blank.identity, generation: 0, bytes: 0, created: 0, modified: 0 };
  const m = (name: string, a: MachineRecord['attachments'][number]): MachineRecord => ({ id: id(name), name, ncpus: 1, ramMiB: 512, display: '2d', created: 0, modified: 0, attachments: [a] });
  const A = m('aa', { id: id('a1'), disk: blank.id, readOnly: false });
  const B = m('bb', { id: id('b1'), disk: blank.id, readOnly: false, overlay: ob.id });
  await store.put('disks', blank);
  await store.put('overlays', ob);
  for (const x of [A, B]) await store.put('machines', x);
  const shapeNow = async (x: MachineRecord) => {
    const ds = new Map((await store.all('disks')).map((d) => [d.id, d]));
    const os = new Map((await store.all('overlays')).map((o) => [o.id, o]));
    return shapeOf((await store.get('machines', x.id))!, (i) => ds.get(i), { overlays: (i) => os.get(i) });
  };
  const snap = async (x: MachineRecord, sid: string): Promise<SnapshotRecord> => {
    const s: SnapshotRecord = { id: id(sid), machine: x.id, name: sid, created: 0, bytes: 0, shape: await shapeNow(x), shapeHash: '', pins: [] };
    await store.put('snapshots', s);
    return s;
  };
  return { store, blank, ob, A, B, shapeNow, snap };
}

/** Writes `fill` into block `b` of overlay `id` over disk `d` (as a machine would: its generation moves). */
async function scribble(id: string, d: DiskRecord, b: number, fill: number, size = d.size) {
  const f = await openOverlay(overlayDir(id), identityOf(d));
  const o = overlay(zeroDisk(size), f.data, f.map, f.meta);
  assert.ok(await o.write(b * 4096, new Uint8Array(4096).fill(fill)));
  f.close();
}

test("a blank disk resized on a machine, then its overlay merged: nothing was written, so the blank disk grows to the overlay's size and stays blank", async () => {
  const w = await world();
  const { store } = w;
  await resize(store, { machine: w.A.id, attachment: w.A.attachments[0].id }, 16 * MiB, { grow: true });
  const changes = (await store.get('machines', w.A.id))!.attachments[0].overlay!;
  const before = await w.shapeNow(w.A);
  assert.equal(before.disks[0].size, 16 * MiB);
  const snapA = await w.snap(w.A, 'sa');
  const snapB = await w.snap(w.B, 'sb'); // B sees the disk at 8 MiB through its own overlay: the grow moves it

  const effect = await mergeEffect(store, changes);
  assert.ok(effect);
  assert.equal(effect.how, 'grow');
  assert.equal(effect.size, 16 * MiB);
  assert.deepEqual(effect.others, [], 'the other overlays stay: the disk still reads as zeros');
  assert.deepEqual(effect.snapshots.map((s) => s.id), [snapB.id], "B's guest would see 16 MiB: its snapshots at 8 MiB orphan; A's stay");

  assert.equal(await mergeIntoDisk(store, changes, effect), 0);
  const d = (await store.get('disks', w.blank.id))!;
  assert.deepEqual([d.kind, d.size, d.identity], ['blank', 16 * MiB, w.blank.identity], 'blank, grown, its identity as made');
  assert.equal(await store.get('overlays', changes), undefined, 'the overlay is gone');
  assert.equal((await store.get('machines', w.A.id))!.attachments[0].overlay, undefined, 'unchosen: the next start makes one at the disk size');
  assert.ok(await store.get('overlays', w.ob.id), "B's overlay stays");
  const after = await w.shapeNow(w.A);
  assert.deepEqual(after, before, "A's guest sees the same disk: its snapshot isn't orphaned");
  assert.ok(snapA.shape.disks[0].size === after.disks[0].size);
  assert.equal((await w.shapeNow(w.B)).disks[0].size, 16 * MiB);
});

test('a blank disk with a written overlay merged becomes a stored disk of its blocks, at the overlay size; its other overlays go', async () => {
  const w = await world();
  const { store } = w;
  await resize(store, { machine: w.A.id, attachment: w.A.attachments[0].id }, 16 * MiB, { grow: true });
  const changes = (await store.get('machines', w.A.id))!.attachments[0].overlay!;
  await scribble(changes, w.blank, 3, 0x5a, 16 * MiB);
  await scribble(changes, w.blank, 3000, 0xa5, 16 * MiB); // past the blank disk's 8 MiB
  await scribble(w.ob.id, w.blank, 1, 0x11);
  const snapA = await w.snap(w.A, 'sa');
  const snapB = await w.snap(w.B, 'sb');

  const effect = await mergeEffect(store, changes);
  assert.ok(effect);
  assert.equal(effect.how, 'convert');
  assert.equal(effect.size, 16 * MiB);
  assert.deepEqual(effect.others.map((o) => o.id), [w.ob.id]);
  assert.deepEqual(effect.snapshots.map((s) => s.id).sort(), [snapA.id, snapB.id].sort(), 'another disk to every machine that attaches it');

  assert.equal(await mergeIntoDisk(store, changes, effect), 2);
  const d = (await store.get('disks', w.blank.id))!;
  assert.deepEqual([d.kind, d.size, d.identity], ['stored', 16 * MiB, { kind: 'stored', id: w.blank.id, bytes: 0 }]);
  assert.deepEqual(d.grow, { from: 8 * MiB, to: 16 * MiB }, "the overlay's grow mark");
  assert.equal(d.generation, (await overlayMeta(diskDir(d.id))).generation);
  assert.deepEqual(await store.overlaysOf(d.id), [], 'no overlay left');
  for (const m of [w.A, w.B]) assert.equal((await store.get('machines', m.id))!.attachments[0].overlay, undefined);
  const src = await openStored(diskDir(d.id), d.size);
  const at = (b: number) => src.read(b * 4096, 1)![0];
  assert.deepEqual([at(3), at(3000), at(1), at(4)], [0x5a, 0xa5, 0, 0], "the overlay's blocks; B's overlay's aren't");
  src.close();
  await assert.rejects(openOverlay(overlayDir(changes), undefined, undefined, { readOnly: true }), /no overlay/, 'its files are gone');
  assert.notEqual((await w.shapeNow(w.A)).disks[0].identity.kind, snapA.shape.disks[0].identity.kind);
});

test("a merge is refused for a URL disk's overlay, and while the overlay is open", async () => {
  const w = await world();
  const { store } = w;
  const url: DiskRecord = { id: 'ffff00000001', kind: 'url', name: 'u', size: MiB, url: 'https://example.org/u', identity: { kind: 'url', path: '/u', bytes: MiB }, created: 0 };
  await store.put('disks', url);
  await store.put('overlays', { ...w.ob, id: 'ffff00000002', disk: url.id, identity: url.identity });
  assert.equal(await mergeEffect(store, 'ffff00000002'), undefined);
  await assert.rejects(mergeIntoDisk(store, 'ffff00000002', { how: 'stored', others: [], size: MiB }), (e: unknown) => msgOf(e)?.key === 'disks:merge.onlyStored');
  // The overlay open (a machine runs on it): its lock is held.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let granted!: () => void;
  const got = new Promise<void>((r) => (granted = r));
  void navigator.locks.request(`waarm64-overlay:${overlayDir(w.ob.id)}`, () => (granted(), held));
  await got;
  await assert.rejects(mergeIntoDisk(store, w.ob.id, (await mergeEffect(store, w.ob.id))!), (e: unknown) => msgOf(e)?.key === 'disks:merge.overlayNamedRunning');
  release();
  assert.ok(await store.get('overlays', w.ob.id), 'nothing was done');
});

/** Overlay `id`'s data file refuses its reads after the first `n` (a merge's copy fails partway); the call returned ends that. */
async function failingReads(id: string, n: number) {
  const f = await openOverlay(overlayDir(id), undefined, undefined, { readOnly: true });
  const real = f.data.read.bind(f.data);
  let left = n;
  f.data.read = (buf, o) => {
    if (left-- <= 0) throw new Error('the storage failed');
    return real(buf, o);
  };
  f.close();
  return () => void (f.data.read = real);
}

test("a blank disk's conversion that fails partway leaves the overlay as it was: its blocks, its record, its machines' choice; the disk blank; asked again, it is done", async () => {
  const w = await world();
  const { store } = w;
  await scribble(w.ob.id, w.blank, 3, 0x5a);
  await scribble(w.ob.id, w.blank, 1000, 0xa5);
  assert.equal((await mergeEffect(store, w.ob.id))?.how, 'convert');
  const restore = await failingReads(w.ob.id, 1);
  await assert.rejects(mergeIntoDisk(store, w.ob.id, (await mergeEffect(store, w.ob.id))!));
  restore();
  assert.ok(await store.get('overlays', w.ob.id), "the overlay's record stays (the sweep would delete its files without it)");
  assert.equal((await store.get('machines', w.B.id))!.attachments[0].overlay, w.ob.id, 'still chosen');
  assert.equal((await store.get('disks', w.blank.id))!.kind, 'blank');
  await assert.rejects(openOverlay(diskDir(w.blank.id), undefined, undefined, { readOnly: true }), /no overlay/, 'the half-made store is gone');
  const o = await openOverlay(overlayDir(w.ob.id), undefined, undefined, { readOnly: true });
  const v = overlay(zeroDisk(w.blank.size), o.data, o.map);
  assert.deepEqual([v.block(3)?.[0], v.block(1000)?.[0]], [0x5a, 0xa5], 'its blocks are there');
  o.close();

  assert.equal(await mergeIntoDisk(store, w.ob.id, (await mergeEffect(store, w.ob.id))!), 2);
  assert.equal((await store.get('disks', w.blank.id))!.kind, 'stored');
  assert.equal(await store.get('overlays', w.ob.id), undefined);
});

test("a stored disk's merge that fails partway keeps the overlay's record (its files outlive the sweep) and the disk's mark; asked again, it is done", async () => {
  const w = await world();
  const { store } = w;
  const size = 8 * MiB;
  const sid = w.blank.id.replace(/^../, 'e5');
  const d: DiskRecord = { id: sid, kind: 'stored', name: 'S', size, identity: { kind: 'stored', id: sid, bytes: 0 }, created: 0 };
  await store.put('disks', d);
  (await openStoredForWriting(diskDir(d.id), identityOf(d), size)).close();
  const o: OverlayRecord = { ...w.ob, id: w.ob.id.replace(/^../, 'e6'), disk: d.id, identity: d.identity };
  await store.put('overlays', o);
  await scribble(o.id, d, 3, 0x5a);
  await scribble(o.id, d, 1000, 0xa5);
  const restore = await failingReads(o.id, 1);
  await assert.rejects(mergeIntoDisk(store, o.id, (await mergeEffect(store, o.id))!));
  restore();
  assert.ok(await store.get('overlays', o.id), "the overlay's record stays");
  assert.equal((await overlayMeta(diskDir(d.id))).merging, overlayDir(o.id), 'the disk is marked: it is never read half merged');
  await assert.rejects(deleteOverlay(store, o.id), (e: unknown) => msgOf(e)?.key === 'disks:disks.overlayMerging', 'nor left half merged by a deletion');

  assert.equal(await mergeIntoDisk(store, o.id, (await mergeEffect(store, o.id))!), 2);
  assert.equal(await store.get('overlays', o.id), undefined);
  const src = await openStored(diskDir(d.id), size);
  assert.deepEqual([src.read(3 * 4096, 1)![0], src.read(1000 * 4096, 1)![0]], [0x5a, 0xa5]);
  src.close();
  assert.equal((await overlayMeta(diskDir(d.id))).merging, '');
});

test('a merge is refused when it is no longer the one confirmed: the overlay written meanwhile (a grow become a conversion), another overlay made', async () => {
  const w = await world();
  const { store } = w;
  await resize(store, { machine: w.A.id, attachment: w.A.attachments[0].id }, 16 * MiB, { grow: true });
  const changes = (await store.get('machines', w.A.id))!.attachments[0].overlay!;
  const grow = (await mergeEffect(store, changes))!;
  assert.equal(grow.how, 'grow');
  await scribble(changes, w.blank, 3, 0x5a, 16 * MiB); // a machine ran on it in another tab
  const changed = (e: unknown) => msgOf(e)?.key === 'disks:merge.changed';
  await assert.rejects(mergeIntoDisk(store, changes, grow), changed);
  assert.ok(await store.get('overlays', w.ob.id), "B's overlay, which a conversion deletes, stays");
  assert.equal((await store.get('disks', w.blank.id))!.kind, 'blank');

  const convert = (await mergeEffect(store, changes))!;
  assert.deepEqual([convert.how, convert.others.map((x) => x.id)], ['convert', [w.ob.id]]);
  const made: OverlayRecord = { ...w.ob, id: w.ob.id.replace(/^../, 'e7'), name: 'Made meanwhile' };
  await store.put('overlays', made);
  await assert.rejects(mergeIntoDisk(store, changes, convert), changed);
  assert.ok(await store.get('overlays', made.id), 'the overlay not listed stays');
  assert.ok(await store.get('overlays', w.ob.id));
  assert.equal(await mergeIntoDisk(store, changes, (await mergeEffect(store, changes))!), 1, 'asked again, it is done');
});

test("a blank disk's grow by a merge is refused while a machine runs over another overlay of the disk (its guest would see the disk change size under it)", async () => {
  const w = await world();
  const { store } = w;
  await resize(store, { machine: w.A.id, attachment: w.A.attachments[0].id }, 16 * MiB, { grow: true });
  const changes = (await store.get('machines', w.A.id))!.attachments[0].overlay!;
  const effect = (await mergeEffect(store, changes))!;
  assert.equal(effect.how, 'grow');
  // B runs over its overlay: its lock is held.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let granted!: () => void;
  const got = new Promise<void>((r) => (granted = r));
  void navigator.locks.request(`waarm64-overlay:${overlayDir(w.ob.id)}`, () => (granted(), held));
  await got;
  await assert.rejects(mergeIntoDisk(store, changes, effect), (e: unknown) => msgOf(e)?.key === 'disks:merge.overlayNamedRunning' && msgOf(e)?.params?.name === w.ob.name);
  release();
  assert.equal((await store.get('disks', w.blank.id))!.size, 8 * MiB, 'not grown');
  assert.ok(await store.get('overlays', changes), 'nothing was done');
});
