// A machine from a template (docs/machines.md "A machine from a template"; DEMO loop 1) in Node, where overlays live in
// memory: a chunked image's identity is its content (`chunked`, the manifest's id), so the same image added from
// another host or path is the same disk, and one added before content ids is still found; a machine's definition
// imported into another browser has the template's shape; and the template's pins, mapped by slot onto that machine,
// fork onto its fresh overlays (none yet: a new one; a never-written one: that one, nothing left behind or asked).
// The first start's restore on the page, in a fresh profile: tests/page-template-first.test.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openOverlay, writeMeta } from '../web/overlay.ts';
import { exportDefinition, importDefinition, parseDefinition } from '../web/app/definitions.ts';
import { createDisk, createMachine, attach, knownDisk } from '../web/app/machines.ts';
import { resolveUrls } from '../web/app/template.ts';
import { planRestore } from '../web/app/snapshots.ts';
import { canonical, shapeHash, shapeOf, type MachineRecord } from '../web/app/shape.ts';
import { overlayDir, Store } from '../web/app/store.ts';
import { memoryFiles, memoryRecords } from '../web/app/store-backends.ts';

const MiB = 2 ** 20;
const ID = 'ab'.repeat(32);
const fresh = () => new Store(memoryRecords(), memoryFiles(), { channel: false });
const disksOf = async (store: Store) => new Map((await store.all('disks')).map((d) => [d.id, d]));
const shape = async (store: Store, m: MachineRecord) => {
  const ds = await disksOf(store);
  return shapeHash(shapeOf(m, (i) => ds.get(i)));
};
/** The slot `m`'s first disk takes. */
const slot0 = async (store: Store, m: MachineRecord) => {
  const ds = await disksOf(store);
  return shapeOf(m, (i) => ds.get(i)).disks[0].slot;
};

/** A machine as a template's is made: a chunked image by its URL on the host it was made against. */
async function templateMachine(store: Store) {
  const m = await createMachine(store, { name: 'Alpine', ncpus: 2, ramMiB: 512, display: '2d', usb: false, mouse: false, touch: false, shares: false });
  const d = await createDisk(store, { kind: 'url', url: 'http://localhost:4000/alpine/manifest.json', size: 256 * MiB, bytes: 80 * MiB, chunked: ID });
  await attach(store, m, d);
  return (await store.get('machines', m.id))!;
}

test("a chunked image's identity is its content: the same image from another host or path is the same disk; one added before content ids is found", async () => {
  const store = fresh();
  const d = await createDisk(store, { kind: 'url', url: 'http://localhost:4000/alpine/manifest.json', size: 256 * MiB, bytes: 80 * MiB, chunked: ID });
  assert.deepEqual(d.identity, { kind: 'url', chunked: ID, bytes: 80 * MiB }, 'no path in it');
  const moved = { kind: 'url' as const, url: 'https://vmdisks.tny.im/alpine-term/manifest.json', size: 256 * MiB, bytes: 80 * MiB, chunked: ID };
  assert.equal((await knownDisk(store, moved))?.id, d.id, 'hosted elsewhere: the disk the browser has');
  assert.equal(await knownDisk(store, { ...moved, chunked: 'cd'.repeat(32) }), undefined, 'other content: another disk');
  // A disk record made before: the URL's path, the manifest's id as its etag.
  const old = fresh();
  await old.put('disks', { id: 'd00000000001', kind: 'url', name: 'm', size: 256 * MiB, url: 'https://vmdisks.tny.im/alpine-term/manifest.json', identity: { kind: 'url', path: '/alpine-term/manifest.json', bytes: 80 * MiB, etag: ID }, created: 0 });
  assert.equal((await knownDisk(old, moved))?.id, 'd00000000001', "the old record's overlays come back with it");
});

test("a template's definition imported in another browser makes a machine of the template's shape, its disk's URL resolved against the definition's", async () => {
  const a = fresh();
  const m = await templateMachine(a);
  const def = await exportDefinition(a, m.id);
  def.disks[0].url = 'manifest.json'; // as the site publishes it: beside the definition
  const resolved = resolveUrls(parseDefinition(JSON.stringify(def)), 'https://vmdisks.tny.im/alpine-term/definition.json');
  assert.equal(resolved.disks[0].url, 'https://vmdisks.tny.im/alpine-term/manifest.json');
  const b = fresh();
  const { machine } = await importDefinition(b, resolved);
  assert.equal(await shape(b, machine), await shape(a, m), 'the same shape: a snapshot of the template restores on it');
  const disk = (await b.all('disks'))[0];
  assert.equal(canonical(disk.identity), canonical({ kind: 'url', chunked: ID, bytes: 80 * MiB }));
  assert.equal(disk.url, 'https://vmdisks.tny.im/alpine-term/manifest.json');
});

/** The template's machine in browser A, its definition imported in a fresh browser B, and the template's pins (slot by slot). */
async function imported() {
  const a = fresh();
  const m = await templateMachine(a);
  const b = fresh();
  const { machine } = await importDefinition(b, await exportDefinition(a, m.id));
  const pins = [{ slot: await slot0(a, m), identity: 'x', size: 256 * MiB, blocks: 120, overlay: 'overlays/0123456789ab', generation: 4 }];
  return { b, machine, pins };
}

test("a template's restore onto a new machine with no overlay yet forks: a new overlay named after it, nothing asked", async () => {
  const { b, machine, pins } = await imported();
  const plan = await planRestore(b, machine, await disksOf(b), { name: 'Alpine', key: 'k1', pins }, { display: '2d' });
  assert.equal(plan.refused, undefined);
  assert.deepEqual(plan.forks.map((f) => [f.reused, f.replaceable]), [[false, undefined]], 'a fork, no replace offered');
  const steps = await plan.commit(false);
  const m = (await b.get('machines', machine.id))!;
  const o = (await b.get('overlays', m.attachments[0].overlay!))!;
  assert.deepEqual(steps, [{ slot: pins[0].slot, action: 'write', overlay: overlayDir(o.id), identity: canonical(o.identity), size: 256 * MiB, whole: false }]);
  assert.deepEqual([o.name, o.fork], ['Alpine', { snapshot: 'k1', generation: 1 }]);
  assert.equal((await b.all('overlays')).length, 1);
});

test("a machine's first restore onto a fresh overlay (never written) fills that one: no overlay left behind, nothing asked; a user's restore, or a written overlay, forks as before", async () => {
  const { b, machine, pins } = await imported();
  // The start made its overlay before the restore (generation 0: never written).
  const disk = (await b.all('disks'))[0];
  const now = Date.now();
  const empty = { id: 'e00000000001', name: 'e1', disk: disk.id, identity: disk.identity, generation: 0, bytes: 0, created: now, modified: now };
  await b.put('overlays', empty);
  machine.attachments[0].overlay = empty.id;
  await b.put('machines', machine);
  // A restore the user asks for: the overlay is theirs, a fork goes beside it (they're asked whether to replace it).
  const asked = await planRestore(b, machine, await disksOf(b), { name: 'Alpine', key: 'k2', pins }, { display: '2d' });
  assert.deepEqual(asked.forks.map((f) => f.replaceable?.overlay), [empty.id]);
  // The machine's first restore (a template's): it fills the fresh one.
  const plan = await planRestore(b, machine, await disksOf(b), { name: 'Alpine', key: 'k2', pins }, { display: '2d' }, { fresh: true });
  assert.deepEqual(plan.forks.map((f) => [f.reused, f.replaceable]), [[false, undefined]], 'nothing to replace: it holds nothing');
  const steps = await plan.commit(false);
  const m = (await b.get('machines', machine.id))!;
  assert.equal(m.attachments[0].overlay, empty.id, 'the fresh overlay is the fork');
  assert.deepEqual(steps.map((s) => s.action === 'write' && s.overlay), [overlayDir(empty.id)]);
  const o = (await b.get('overlays', empty.id))!;
  assert.deepEqual([o.name, o.fork], ['Alpine', { snapshot: 'k2', generation: 1 }]);
  assert.equal((await b.all('overlays')).length, 1, 'no other overlay');

  // Written to since (its generation moved): an ordinary fork, the user asked whether to replace it.
  const written = { ...empty, id: 'e00000000002', name: 'Mine', fork: undefined, bytes: 4096 };
  await b.put('overlays', written);
  const f = await openOverlay(overlayDir(written.id), undefined);
  assert.ok(writeMeta(f.meta, { generation: 3, merging: '', size: 0 }));
  f.close();
  m.attachments[0].overlay = written.id;
  await b.put('machines', m);
  const again = await planRestore(b, m, await disksOf(b), { name: 'Alpine', key: 'k3', pins }, { display: '2d' }, { fresh: true });
  assert.deepEqual(again.forks.map((x) => x.replaceable?.overlay), [written.id]);
  await again.commit(false);
  const after = (await b.get('machines', m.id))!;
  assert.ok(![written.id, empty.id].includes(after.attachments[0].overlay!), 'a new fork');
});
