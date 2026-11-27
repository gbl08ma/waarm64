// A machine from a template (docs/machines.md "A machine from a template"; DEMO loop 1) in Node, where overlays live in
// memory: a chunked image's identity is its content (`chunked`, the manifest's id), so the same image added from
// another host or path is the same disk, and one added before content ids is still found; a machine's definition
// imported into another browser has the template's shape; and the template's pins, mapped by slot onto that machine,
// fork onto its fresh overlays (none yet: a new one; a never-written one: that one, nothing left behind or asked).
// The first start's restore on the page, in a fresh profile: tests/page-template-first.test.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openOverlay, overlayMeta, readMeta, writeMeta } from '../web/overlay.ts';
import { exportDefinition, importDefinition, parseDefinition } from '../web/app/definitions.ts';
import { createDisk, createMachine, attach, knownDisk } from '../web/app/machines.ts';
import { resolveUrls } from '../web/app/template.ts';
import { planRestore } from '../web/app/snapshots.ts';
import { restoreLoaded, undoCutRestores } from '../web/app/snapshot-undo.ts';
import { MachineLock } from '../web/app/run/machine-lock.ts';
import { canonical, shapeHash, shapeOf, type MachineRecord } from '../web/app/shape.ts';
import { overlayDir, Store } from '../web/app/store.ts';
import { memoryFiles, memoryRecords } from '../web/app/store-backends.ts';
import { MACHINES } from '../web/app/machine.ts';
import { explain } from '../web/app/worker-errors.ts';
import { MsgError } from '../web/msg.ts';

const MiB = 2 ** 20;
const ID = 'ab'.repeat(32);
/** Waits for overlay `id`'s lock to be let go (a close's release lands a moment later). */
const letGo = (id: string) => navigator.locks.request(`waarm64-overlay:${overlayDir(id)}`, async () => {});
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
  const moved = { kind: 'url' as const, url: 'https://disks.waarm64.com/alpine-term/manifest.json', size: 256 * MiB, bytes: 80 * MiB, chunked: ID };
  assert.equal((await knownDisk(store, moved))?.id, d.id, 'hosted elsewhere: the disk the browser has');
  assert.equal(await knownDisk(store, { ...moved, chunked: 'cd'.repeat(32) }), undefined, 'other content: another disk');
  // A disk record made before: the URL's path, the manifest's id as its etag.
  const old = fresh();
  await old.put('disks', { id: 'd00000000001', kind: 'url', name: 'm', size: 256 * MiB, url: 'https://disks.waarm64.com/alpine-term/manifest.json', identity: { kind: 'url', path: '/alpine-term/manifest.json', bytes: 80 * MiB, etag: ID }, created: 0 });
  assert.equal((await knownDisk(old, moved))?.id, 'd00000000001', "the old record's overlays come back with it");
});

test("a template's definition imported in another browser makes a machine of the template's shape, its disk's URL resolved against the definition's", async () => {
  const a = fresh();
  const m = await templateMachine(a);
  const def = await exportDefinition(a, m.id);
  def.disks[0].url = 'manifest.json'; // as the site publishes it: beside the definition
  const resolved = resolveUrls(parseDefinition(JSON.stringify(def)), 'https://disks.waarm64.com/alpine-term/definition.json');
  assert.equal(resolved.disks[0].url, 'https://disks.waarm64.com/alpine-term/manifest.json');
  const b = fresh();
  const { machine } = await importDefinition(b, resolved);
  assert.equal(await shape(b, machine), await shape(a, m), 'the same shape: a snapshot of the template restores on it');
  const disk = (await b.all('disks'))[0];
  assert.equal(canonical(disk.identity), canonical({ kind: 'url', chunked: ID, bytes: 80 * MiB }));
  assert.equal(disk.url, 'https://disks.waarm64.com/alpine-term/manifest.json');
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
  const token = m.restoring?.[0].token;
  assert.match(token ?? '', /^[0-9a-f]{12}$/, "the restore's fill token");
  assert.deepEqual(steps, [{ slot: pins[0].slot, action: 'write', overlay: overlayDir(o.id), identity: canonical(o.identity), size: 256 * MiB, whole: false, fork: true, token }]);
  assert.deepEqual([o.name, o.fork], ['Alpine', { snapshot: 'k1', generation: 1 }]);
  assert.deepEqual(m.restoring, [{ attachment: m.attachments[0].id, how: 'fork', overlay: o.id, before: {}, token }], 'what the attachment had: no overlay');
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
  // Review restore-tokens 6: its fill deletes nothing of the disk's (it held nothing), so the worker plans it as a fork's:
  // a refusal after it (the storage full) says no changes were deleted, and isn't a snapshot that can't load here (a
  // template's first start then keeps its mark and restores again, rather than booting instead for good).
  assert.deepEqual(steps.map((s) => s.action === 'write' && !!s.fork), [true], 'planned as a fork: nothing of the disk deleted');
  const full = new MsgError('snapshots:snapshot.storageFull');
  assert.notEqual(explain(full, MACHINES.buildroot, { restoring: true, ramMiB: 64 })[0], 'snapshot', "a fork's refusal after its fill: not a snapshot's problem");
  assert.deepEqual(m.restoring, [{ attachment: m.attachments[0].id, how: 'into', overlay: empty.id, generation: 0, fork: { snapshot: 'k2', name: 'Alpine' }, token: m.restoring?.[0].token }]);
  await restoreLoaded(b, m.id); // it loaded: named after the snapshot, its fork
  m.restoring = undefined; // as the record is now
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

// Review disk-writes 1: a restore's fork recorded and attached before its fill; the fill cut off (a closed tab, the
// storage full), the next restore of the snapshot reused the half-filled fork as complete (its generation was the
// fork's), and the machine started on it.
test("a fork whose restore was cut off before its fill was done is never reused; the machine goes back to the overlay it had, the fork deleted", async () => {
  const { b, machine, pins } = await imported();
  const disk = (await b.all('disks'))[0];
  const now = Date.now();
  const mine = { id: 'e00000000003', name: 'Mine', disk: disk.id, identity: disk.identity, generation: 2, bytes: 4096, created: now, modified: now };
  await b.put('overlays', mine);
  machine.attachments[0].overlay = mine.id;
  await b.put('machines', machine);
  const plan = await planRestore(b, machine, await disksOf(b), { name: 'Alpine', key: 'k4', pins }, { display: '2d' });
  await plan.commit(false);
  const m = (await b.get('machines', machine.id))!;
  const fork = m.attachments[0].overlay!;
  assert.notEqual(fork, mine.id);
  assert.deepEqual((await b.get('overlays', fork))!.fork, { snapshot: 'k4', generation: 1 });
  assert.deepEqual(m.restoring?.map((s) => s.how !== 'into' && s.before), [{ overlay: mine.id }]);
  // The worker's fill cut off: the fork marked at generation 1 with the restore's token, part of the blocks in (web/snapshot.ts).
  const f = await openOverlay(overlayDir(fork), canonical(disk.identity));
  assert.ok(writeMeta(f.meta, { generation: 1, merging: '', size: 0, filling: true, token: m.restoring?.[0].token }));
  f.close();
  await navigator.locks.request(`waarm64-overlay:${overlayDir(fork)}`, async () => {}); // its lock let go (a release lands a moment later)
  const again = await planRestore(b, m, await disksOf(b), { name: 'Alpine', key: 'k4', pins }, { display: '2d' });
  assert.deepEqual(again.forks.map((x) => x.reused), [false], 'the half-filled fork is not reused');
  // Open somewhere (its fill still running, or a machine in another tab): left as it is.
  const open = await openOverlay(overlayDir(fork), undefined, undefined, { readOnly: true }); // a writer's would empty it
  assert.equal(await undoCutRestores(b, m), m, 'not while it is open');
  open.close();
  await navigator.locks.request(`waarm64-overlay:${overlayDir(fork)}`, async () => {});
  const back = await undoCutRestores(b, m);
  assert.equal(back.attachments[0].overlay, mine.id, 'back on the overlay it had');
  assert.equal((await b.get('machines', m.id))!.attachments[0].overlay, mine.id, 'in its record');
  assert.equal(await b.get('overlays', fork), undefined, 'the fork deleted');
  assert.equal((await overlayMeta(overlayDir(fork))).generation, 0, 'and its files');
  assert.equal(await undoCutRestores(b, back), back, 'nothing more to undo');
  // A fork whose fill ended (its mark cleared) and whose restore loaded (the worker's `loaded`) stays, and is reused.
  await again.commit(false);
  const m2 = (await b.get('machines', m.id))!;
  const g = await openOverlay(overlayDir(m2.attachments[0].overlay!), canonical(disk.identity));
  assert.ok(writeMeta(g.meta, { ...readMeta(g.meta), generation: 1 }));
  g.close();
  await letGo(m2.attachments[0].overlay!);
  await restoreLoaded(b, m2.id);
  assert.equal(await undoCutRestores(b, m2), m2);
  const third = await planRestore(b, m2, await disksOf(b), { name: 'Alpine', key: 'k4', pins }, { display: '2d' });
  assert.deepEqual(third.forks.map((x) => x.reused), [true]);
});

/** `imported()` with the user's own overlay attached (written: generation 2). */
async function withMine() {
  const { b, machine, pins } = await imported();
  const disk = (await b.all('disks'))[0];
  const now = Date.now();
  const mine = { id: 'e00000000003', name: 'Mine', disk: disk.id, identity: disk.identity, generation: 2, bytes: 4096, created: now, modified: now };
  await b.put('overlays', mine);
  machine.attachments[0].overlay = mine.id;
  await b.put('machines', machine);
  return { b, machine, pins, disk, mine };
}

// Review cut-jobs 1: the restore records and attaches its fork before the worker's check pass; cut off there (the tab
// closed, the file refused), the fork had no mark and no files, the undo left it attached, and the machine booted on an
// empty disk with the user's overlay detached.
test("a fork the restore attached but no fill opened is undone: the machine goes back on the overlay it had, except while a start holds the machine", async () => {
  const { b, machine, pins, mine } = await withMine();
  const plan = await planRestore(b, machine, await disksOf(b), { name: 'Alpine', key: 'k6', pins }, { display: '2d' });
  await plan.commit(false);
  const m = (await b.get('machines', machine.id))!;
  const fork = m.attachments[0].overlay!;
  assert.notEqual(fork, mine.id);
  // The restore's own start holds the machine's lock from before its commit (here, or in another tab): its fork is its own.
  await navigator.locks.request(`waarm64-machine:${machine.id}`, async () => {
    assert.equal(await undoCutRestores(b, m), m, 'not while a start holds the machine');
  });
  // The tab closed during the check pass: the worker never opened the fork.
  const back = await undoCutRestores(b, m);
  assert.equal(back.attachments[0].overlay, mine.id, 'back on the overlay it had');
  assert.equal(await b.get('overlays', fork), undefined, 'the fork deleted');
  assert.ok(await b.get('overlays', mine.id), "the user's overlay kept");
});

// Review cut-jobs 2: a replace writes into the attached overlay, an earlier fork whose record still had the `before` of
// its own restore; cut off, the undo put the machine back on what that fork had replaced and deleted the fork.
test("a replace into an earlier fork, cut off, leaves the machine on that fork (read as empty), not on what the fork replaced", async () => {
  const { b, machine, pins, disk, mine } = await withMine();
  const first = await planRestore(b, machine, await disksOf(b), { name: 'Alpine', key: 'k7', pins }, { display: '2d' });
  await first.commit(false);
  const m = (await b.get('machines', machine.id))!;
  const fork = m.attachments[0].overlay!;
  {
    const f = await openOverlay(overlayDir(fork), canonical(disk.identity)); // its fill done: generation 1, no mark
    assert.ok(writeMeta(f.meta, { generation: 1, merging: '', size: 0 }));
    f.close();
  }
  await letGo(fork);
  await restoreLoaded(b, m.id); // and it loaded
  // Another snapshot restored over it, the user answering replace: a write into the fork.
  const second = await planRestore(b, m, await disksOf(b), { name: 'Other', key: 'k8', pins }, { display: '2d' }, { room: 0 });
  assert.deepEqual(second.forks.map((x) => x.replaceable?.overlay), [fork]);
  const steps = await second.commit(true);
  assert.deepEqual(steps.map((s) => s.action === 'write' && s.overlay), [overlayDir(fork)]);
  // The worker's fill: emptied and marked one past its generation, then cut off.
  {
    const f = await openOverlay(overlayDir(fork), canonical(disk.identity), undefined, { fresh: { size: 0 } });
    assert.ok(writeMeta(f.meta, { generation: 2, merging: '', size: 0, filling: true }));
    f.close();
  }
  await letGo(fork);
  const m2 = (await b.get('machines', machine.id))!;
  const after = await undoCutRestores(b, m2);
  assert.equal(after.attachments[0].overlay, fork, 'still on the fork the replace emptied');
  assert.ok(await b.get('overlays', fork), "the fork's record kept");
  assert.equal(after.attachments[0].inPlace, undefined);
  assert.ok(await b.get('overlays', mine.id));
});

// REVIEW.md (review/demo-page) R1: a definition naming an image's content id from another URL (another store's demo,
// an imported file) doesn't decide where a later definition's disk is read from: a URL disk is the same disk only at
// the same URL (its identity, the shape's, still matches on any host).
test("a definition's URL disk is reused only at its own URL: another store's record of the same image isn't ours", async () => {
  const a = fresh();
  const m = await templateMachine(a);
  const at = async (url: string) => {
    const def = await exportDefinition(a, m.id);
    def.disks[0].url = url;
    return def;
  };
  const store = fresh();
  const evil = await importDefinition(store, await at('https://evil.example/fake/manifest.json'));
  const ours = await importDefinition(store, await at('https://disks.waarm64.com/alpine-term/manifest.json'));
  const disk = await store.get('disks', ours.machine.attachments[0].disk);
  assert.equal(disk?.url, 'https://disks.waarm64.com/alpine-term/manifest.json', "the project's demo reads another store's URL");
  assert.notEqual(ours.machine.attachments[0].disk, evil.machine.attachments[0].disk);
  assert.equal(await shape(store, ours.machine), await shape(a, m), "the template's shape all the same");
  const again = await importDefinition(store, await at('https://disks.waarm64.com/alpine-term/manifest.json'));
  assert.equal(again.machine.attachments[0].disk, ours.machine.attachments[0].disk, 'the same URL: the same disk');
});

// R2: a blank or ramdisk disk's identity id is the definition's, hashed in the shape; never a record's id to take.
test("a definition's blank disk whose identity names an existing record's id doesn't overwrite that record", async () => {
  const a = fresh();
  const base = await exportDefinition(a, (await templateMachine(a)).id);
  const blank = (bytes: number, id = 'aaaaaaaaaaaa') => ({
    ...base,
    disks: [...base.disks, { kind: 'blank' as const, name: 'scratch', size: bytes, identity: { kind: 'blank' as const, id, bytes }, readOnly: false, serial: '0123456789ab' }],
  });
  const store = fresh();
  const first = await importDefinition(store, blank(MiB));
  const second = await importDefinition(store, blank(2 * MiB));
  const disk = await store.get('disks', first.machine.attachments[1].disk);
  assert.equal(disk?.size, MiB, "machine A's blank disk was overwritten by B's import");
  assert.notEqual(second.machine.attachments[1].disk, first.machine.attachments[1].disk);
  // An identity naming one of the user's own disks' ids: that disk stays as it was.
  const mine = (await store.all('disks')).find((d) => d.kind === 'url')!;
  await importDefinition(store, blank(MiB, mine.id));
  assert.equal((await store.get('disks', mine.id))?.kind, 'url', "the user's disk record was replaced");
  // Identities checked by kind: a blank disk's identity of another kind, or without an id, is refused.
  const bad = (identity: unknown) => JSON.stringify({ ...base, disks: [{ ...blank(MiB).disks[1], identity }] });
  assert.throws(() => parseDefinition(bad({ kind: 'url', chunked: ID, bytes: MiB })), /damaged/);
  assert.throws(() => parseDefinition(bad({ kind: 'blank', bytes: MiB })), /damaged/);
  assert.throws(() => parseDefinition(JSON.stringify({ ...base, disks: [{ ...base.disks[0], identity: { kind: 'url', chunked: '../x', bytes: 1 } }] })), /damaged/);
});

// Review cut-jobs 1: the undo skips a machine whose lock is held (a start owns its forks), so a page reading its
// records again right after its own run ended must not find that run's lock still on its way out.
test("a page's machine lock, let go, is released by the time `settled` says so: the undo then sees the machine free", async () => {
  const lock = new MachineLock();
  const id = 'f00000000001';
  const held = async () => ((await navigator.locks.query()).held ?? []).some((l) => l.name === `waarm64-machine:${id}`);
  assert.ok(await lock.hold(id));
  assert.ok(await held());
  lock.drop();
  // It waits for the lock's request to end (in Chromium the release lands a moment after the drop), not for the drop.
  let first = '';
  const settled = lock.settled().then(() => (first ||= 'settled'));
  await Promise.resolve();
  first ||= 'drop';
  await settled;
  assert.equal(first, 'drop', "settled only once the lock's request ended");
  assert.equal(await held(), false, 'released');
  await lock.settled(); // none held since: at once
});

// Review disk-locks 2: a template's first restore wrote its fork mark onto the machine's fresh overlay (no `before`); cut
// off before the fill, the next start booted on it, the boot's first write moved its generation to the fork's, and a
// later restore of the snapshot attached the booted disk as the snapshot's blocks.
test("a template's first restore cut off before its fill: the next load takes the fork mark off the fresh overlay, so a later restore after a boot forks anew", async () => {
  const { b, machine, pins } = await imported();
  const disk = (await b.all('disks'))[0];
  const now = Date.now();
  const empty = { id: 'e00000000009', name: 'e1', disk: disk.id, identity: disk.identity, generation: 0, bytes: 0, created: now, modified: now };
  await b.put('overlays', empty);
  machine.attachments[0].overlay = empty.id;
  await b.put('machines', machine);
  const first = await planRestore(b, machine, await disksOf(b), { name: 'Alpine', key: 'K', pins }, { display: '2d' }, { fresh: true });
  await first.commit(false); // the start then cut off before the disk phase (the tab closed in the check pass)
  const rec = (await b.get('machines', machine.id))!;
  const loaded = await undoCutRestores(b, rec); // the next start reads the records
  assert.equal(loaded.attachments[0].overlay, empty.id, 'the fresh overlay stays attached');
  const unmarked = (await b.get('overlays', empty.id))!;
  assert.deepEqual([unmarked.fork, loaded.restoring], [undefined, undefined], 'no fork of the snapshot: its restore never loaded');
  // That start boots on it: its first write moves its generation 0 -> 1, the fork's.
  const f = await openOverlay(overlayDir(empty.id), undefined);
  assert.ok(writeMeta(f.meta, { ...readMeta(f.meta), generation: 1 }));
  f.close();
  await letGo(empty.id);
  const plan = await planRestore(b, loaded, await disksOf(b), { name: 'Alpine', key: 'K', pins }, { display: '2d' });
  assert.deepEqual(plan.forks.map((x) => x.reused), [false], 'the booted disk is not the snapshot');
});

// Review disk-locks 3: once the fill was done, a restore that failed after it (the core refused the state, a disk that
// didn't open) left the forks attached and whole, while the page said its disks hold none of the snapshot.
test('a restore that never loaded, its fill done (refused after it), is undone as one cut off: the machine back on the overlay it had, the fork deleted', async () => {
  const { b, machine, pins, disk, mine } = await withMine();
  const plan = await planRestore(b, machine, await disksOf(b), { name: 'Alpine', key: 'k9', pins }, { display: '2d' });
  await plan.commit(false);
  const m = (await b.get('machines', machine.id))!;
  const fork = m.attachments[0].overlay!;
  const f = await openOverlay(overlayDir(fork), canonical(disk.identity)); // filled: generation 1, no mark, the restore's token
  assert.ok(writeMeta(f.meta, { generation: 1, merging: '', size: 0, token: m.restoring?.[0].token }));
  f.close();
  await letGo(fork);
  const back = await undoCutRestores(b, m);
  assert.equal(back.attachments[0].overlay, mine.id, 'back on the overlay it had');
  assert.equal(await b.get('overlays', fork), undefined, 'the fork deleted');
});

// Review disk-locks 7: the undo wrote back the record read before it took the machine's lock.
test("the undo of a cut-off restore keeps what another tab wrote to the machine's record since it was read", async () => {
  const { b, machine, pins, mine } = await withMine();
  const plan = await planRestore(b, machine, await disksOf(b), { name: 'Alpine', key: 'k10', pins }, { display: '2d' });
  await plan.commit(false);
  const read = (await b.get('machines', machine.id))!; // the page's reading, before the lock
  await b.put('machines', { ...read, name: 'Renamed elsewhere', modified: Date.now() }); // Home, in another tab
  const back = await undoCutRestores(b, read);
  assert.equal(back.attachments[0].overlay, mine.id);
  assert.equal((await b.get('machines', machine.id))!.name, 'Renamed elsewhere', "the other tab's edit stays");
});

// Review disk-locks 6: two holds of the page's machine lock at once (a template's first start and a Start meanwhile)
// found the page's own lock: the second said the machine runs in another tab.
test("a page's machine lock asked for twice at once: both are this page's", async () => {
  const lock = new MachineLock();
  const id = 'f00000000002';
  assert.deepEqual(await Promise.all([lock.hold(id), lock.hold(id)]), [true, true]);
  lock.drop();
  await lock.settled();
});

// Review disk-locks 3, a restore that attaches an earlier fork again: one that never loaded goes back as a new fork's
// does, and the earlier fork stays (it was attached, not made).
test('a restore that attached an earlier fork again and never loaded: the machine back on the overlay it had, the earlier fork kept', async () => {
  const { b, machine, pins, disk, mine } = await withMine();
  const first = await planRestore(b, machine, await disksOf(b), { name: 'Alpine', key: 'k11', pins }, { display: '2d' });
  await first.commit(false);
  const fork = (await b.get('machines', machine.id))!.attachments[0].overlay!;
  const f = await openOverlay(overlayDir(fork), canonical(disk.identity)); // filled
  assert.ok(writeMeta(f.meta, { generation: 1, merging: '', size: 0 }));
  f.close();
  await letGo(fork);
  await restoreLoaded(b, machine.id); // it loaded: the fork is the machine's
  const m = (await b.get('machines', machine.id))!;
  m.attachments[0].overlay = mine.id; // the user switched back to their overlay
  await b.put('machines', m);
  const again = await planRestore(b, m, await disksOf(b), { name: 'Alpine', key: 'k11', pins }, { display: '2d' });
  assert.deepEqual(again.forks.map((x) => x.reused), [true]);
  await again.commit(false); // then the start is cut off, or refused, before the snapshot loaded
  const back = await undoCutRestores(b, (await b.get('machines', m.id))!);
  assert.equal(back.attachments[0].overlay, mine.id, 'back on the overlay it had');
  const kept = await b.get('overlays', fork);
  assert.ok(kept, 'the earlier fork kept');
  assert.deepEqual([back.restoring, kept.fork], [undefined, { snapshot: 'k11', generation: 1 }], 'as it was: reused by the next restore');
});
