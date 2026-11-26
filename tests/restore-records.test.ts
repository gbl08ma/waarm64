// A restore's records (docs/machines.md §5.2 "A restore's records") in Node, where overlays live in memory: what a
// restore's commit writes, what the worker's `loaded` makes the machine's, and what the machine's next load undoes of a
// restore that never loaded, case by case (the rules' table), and the races between machines that share an overlay,
// a commit cut off part way, and Delete overlay. The page's side (a `loaded` that can't be recorded, Retry, a hold's
// words): tests/page-restore.test.ts; the template's first start: tests/page-template-first.test.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openOverlay, overlayMeta, writeMeta } from '../web/overlay.ts';
import { exportDefinition, importDefinition } from '../web/app/definitions.ts';
import { deleteOverlayAsked } from '../web/app/disks.ts';
import { createDisk, createMachine, attach, updateMachine } from '../web/app/machines.ts';
import { planRestore } from '../web/app/snapshots.ts';
import { restoreLoaded, undoCutRestores } from '../web/app/snapshot-undo.ts';
import { newId, shapeOf, type MachineRecord } from '../web/app/shape.ts';
import { overlayDir, Store } from '../web/app/store.ts';
import { memoryFiles, memoryRecords } from '../web/app/store-backends.ts';
import { msgOf } from '../web/msg.ts';

const MiB = 2 ** 20;
const ID = 'ab'.repeat(32);
/** Waits for overlay `id`'s lock to be let go (a close's release lands a moment later). */
const letGo = (id: string) => navigator.locks.request(`waarm64-overlay:${overlayDir(id)}`, async () => {});
const disksOf = async (store: Store) => new Map((await store.all('disks')).map((d) => [d.id, d]));

/** A template's machine imported into a fresh store, the user's own overlay Mine attached (written: generation 2), and pins of slot 0. */
async function withMine() {
  const a = new Store(memoryRecords(), memoryFiles(), { channel: false });
  const t = await createMachine(a, { name: 'Alpine', ncpus: 2, ramMiB: 512, display: '2d', usb: false, mouse: false, touch: false, shares: false });
  const disk0 = await createDisk(a, { kind: 'url', url: 'http://localhost:4000/alpine/manifest.json', size: 256 * MiB, bytes: 80 * MiB, chunked: ID });
  await attach(a, t, disk0);
  const tm = (await a.get('machines', t.id))!;
  const ds = await disksOf(a);
  const slot = shapeOf(tm, (i) => ds.get(i)).disks[0].slot;
  const b = new Store(memoryRecords(), memoryFiles(), { channel: false });
  const { machine } = await importDefinition(b, await exportDefinition(a, tm.id));
  const pins = [{ slot, identity: 'x', size: 256 * MiB, blocks: 120, overlay: 'overlays/0123456789ab', generation: 4 }];
  const disk = (await b.all('disks'))[0];
  const now = Date.now();
  const mine = { id: newId(), name: 'Mine', disk: disk.id, identity: disk.identity, generation: 2, bytes: 4096, created: now, modified: now };
  await b.put('overlays', mine);
  await setMeta(mine.id, 2);
  machine.attachments[0].overlay = mine.id;
  await b.put('machines', machine);
  return { b, m: machine, pins, disk, mine: mine.id, fresh: '' };
}

async function setMeta(id: string, generation: number, filling = false) {
  const f = await openOverlay(overlayDir(id), undefined);
  assert.ok(writeMeta(f.meta, { generation, merging: '', size: 0, ...(filling ? { filling } : {}) }));
  f.close();
  await letGo(id);
}

/** The worker's fill of overlay `id` (web/snapshot.ts): emptied, one past its generation, marked; `done`: its mark cleared at its end. */
async function fill(id: string, done: boolean) {
  const was = (await overlayMeta(overlayDir(id))).generation;
  const f = await openOverlay(overlayDir(id), undefined, undefined, { fresh: true });
  assert.ok(writeMeta(f.meta, { generation: was + 1, merging: '', size: 0, ...(done ? {} : { filling: true }) }));
  f.close();
  await letGo(id);
}

type Env = Awaited<ReturnType<typeof withMine>>;
/** Plans and commits a restore of snapshot `key` onto machine `id` as its record is now; the worker's plan. */
async function restore(e: Env, id: string, key: string, o: { replace?: boolean; fresh?: boolean } = {}) {
  const m = (await e.b.get('machines', id))!;
  const plan = await planRestore(e.b, m, await disksOf(e.b), { name: `Snap ${key}`, key, pins: e.pins }, { display: '2d' }, { fresh: o.fresh });
  return { plan, steps: await plan.commit(!!o.replace) };
}
/** Machine `id` loaded on a page: its restore that never loaded undone (the lock free). */
const load = async (e: Env, id: string) => undoCutRestores(e.b, (await e.b.get('machines', id))!);
const attachedTo = async (e: Env, id: string) => (await e.b.get('machines', id))!.attachments[0].overlay;
const nameOf = async (e: Env, id: string | undefined) => (id ? (await e.b.get('overlays', id))?.name : undefined);
const names = async (e: Env) => (await e.b.all('overlays')).map((o) => o.name).sort();
const emptied = async (id: string) => !!(await overlayMeta(overlayDir(id))).filling;
/** Whether a later restore of `key` onto a machine on Mine attaches the fork again rather than making one (then undone). */
async function reusedLater(e: Env, key: string) {
  const m = (await e.b.get('machines', e.m.id))!;
  const now = { ...m, attachments: m.attachments.map((a) => ({ ...a, overlay: e.mine })) };
  const plan = await planRestore(e.b, now, await disksOf(e.b), { name: 'later', key, pins: e.pins }, { display: '2d' });
  return plan.forks.map((f) => f.reused);
}

/** A fresh overlay attached to the machine (never written: generation 0), as a template's machine has at its first start. */
async function withFresh() {
  const e = await withMine();
  const now = Date.now();
  const fresh = { id: newId(), name: 'Fresh', disk: e.disk.id, identity: e.disk.identity, generation: 0, bytes: 0, created: now, modified: now };
  await e.b.put('overlays', fresh);
  const m = (await e.b.get('machines', e.m.id))!;
  m.attachments[0].overlay = fresh.id;
  await e.b.put('machines', m);
  return { ...e, fresh: fresh.id };
}

// The rules' table (docs/machines.md §5.2 "A restore's records"): each way a restore writes a disk's overlay, by how far
// the worker got (`never`: cut off or refused before its disk phase; `cut`: its fill cut off; `filled`: refused after
// its fill; `loaded`: the worker's `loaded`), and what the machine's next load finds.
type Case = {
  how: 'fork' | 'reuse' | 'replace' | 'fresh';
  worker: 'never' | 'cut' | 'filled' | 'loaded';
  /** The overlay the machine is on after the next load, by name. */
  on: string;
  /** The overlays there are then, by name. */
  overlays: string[];
  /** Whether the overlay it's on reads as empty (marked as a cut-off fill). */
  empty: boolean;
};
const S = 'Snap k';
const CASES: Case[] = [
  { how: 'fork', worker: 'never', on: 'Mine', overlays: ['Mine'], empty: false },
  { how: 'fork', worker: 'cut', on: 'Mine', overlays: ['Mine'], empty: false },
  { how: 'fork', worker: 'filled', on: 'Mine', overlays: ['Mine'], empty: false },
  { how: 'fork', worker: 'loaded', on: S, overlays: ['Mine', S], empty: false },
  { how: 'reuse', worker: 'never', on: 'Mine', overlays: ['Mine', 'Snap first'], empty: false },
  { how: 'reuse', worker: 'loaded', on: 'Snap first', overlays: ['Mine', 'Snap first'], empty: false },
  { how: 'replace', worker: 'never', on: 'Mine', overlays: ['Mine'], empty: false },
  { how: 'replace', worker: 'cut', on: 'Mine', overlays: ['Mine'], empty: true },
  { how: 'replace', worker: 'filled', on: 'Mine', overlays: ['Mine'], empty: true },
  { how: 'replace', worker: 'loaded', on: 'Mine', overlays: ['Mine'], empty: false },
  { how: 'fresh', worker: 'never', on: 'Fresh', overlays: ['Fresh', 'Mine'], empty: false },
  { how: 'fresh', worker: 'filled', on: 'Fresh', overlays: ['Fresh', 'Mine'], empty: true },
  { how: 'fresh', worker: 'loaded', on: S, overlays: ['Mine', S], empty: false },
];

for (const c of CASES)
  test(`the rules' table: a ${c.how} the worker ${c.worker === 'never' ? 'never reached' : c.worker === 'loaded' ? 'loaded' : `${c.worker} and never loaded`}: the next load finds the machine on ${c.on}`, async () => {
    const e = c.how === 'fresh' ? await withFresh() : await withMine();
    let key = 'k';
    if (c.how === 'reuse') {
      // An earlier restore of the snapshot made a fork that loaded; the user went back to Mine.
      const first = await restore(e, e.m.id, 'first');
      await fill((await attachedTo(e, e.m.id))!, true);
      await restoreLoaded(e.b, e.m.id);
      const m = (await e.b.get('machines', e.m.id))!;
      m.attachments[0].overlay = e.mine;
      await e.b.put('machines', m);
      key = 'first';
    }
    const { plan, steps } = await restore(e, e.m.id, key, { replace: c.how === 'replace', fresh: c.how === 'fresh' });
    assert.deepEqual(plan.forks.map((f) => f.reused), [c.how === 'reuse']);
    const target = (await attachedTo(e, e.m.id))!;
    if (c.worker === 'cut' || c.worker === 'filled' || c.worker === 'loaded') {
      if (c.how !== 'reuse') await fill(target, c.worker !== 'cut');
    }
    if (c.worker === 'loaded') await restoreLoaded(e.b, e.m.id);
    // Not while the machine's lock is held (a start under way, here or in another tab): nothing is undone.
    const before = (await e.b.get('machines', e.m.id))!;
    await navigator.locks.request(`waarm64-machine:${e.m.id}`, async () => {
      assert.equal(await undoCutRestores(e.b, before), before, 'nothing undone under the lock');
    });
    const after = await load(e, e.m.id);
    assert.equal(await nameOf(e, after.attachments[0].overlay), c.on, 'the overlay it is on');
    assert.equal(await nameOf(e, await attachedTo(e, e.m.id)), c.on, 'in its record');
    assert.deepEqual(await names(e), c.overlays, 'the overlays');
    assert.equal(await emptied(after.attachments[0].overlay!), c.empty, 'read as empty');
    assert.equal(after.restoring, undefined, 'nothing left to undo');
    assert.deepEqual(await load(e, e.m.id), (await e.b.get('machines', e.m.id))!, 'a second load undoes nothing more');
    // What a later restore of the same snapshot finds: a fork that loaded is attached again; one never loaded isn't there.
    if (c.how === 'fork' || c.how === 'reuse') assert.deepEqual(await reusedLater(e, key), [c.worker === 'loaded' || c.how === 'reuse']);
    if (c.how === 'fresh' && c.worker !== 'loaded') {
      // Review restore-marks 6: the next first start restores into it again, and leaves no overlay beside it.
      await restore(e, e.m.id, key, { fresh: true });
      assert.equal(await attachedTo(e, e.m.id), e.fresh, 'into the same overlay');
      assert.equal((await e.b.all('overlays')).length, 2, 'no second overlay beside it');
    }
  });

// Review restore-marks 3: machine One's restore reattaches fork K, which machine Two has chosen; Two loaded while One's
// start holds One's lock moved Two onto One's earlier overlay.
test("another machine's restore that attaches an overlay this machine has chosen is left alone by this machine's load", async () => {
  const e = await withMine();
  const first = await restore(e, e.m.id, 'file:1');
  const k = (await attachedTo(e, e.m.id))!;
  await fill(k, true);
  await restoreLoaded(e.b, e.m.id);
  const one = (await e.b.get('machines', e.m.id))!;
  const two: MachineRecord = { ...one, id: 'f0000000aaaa', name: 'Two', attachments: one.attachments.map((a) => ({ ...a, overlay: k })) };
  await e.b.put('machines', two);
  one.attachments[0].overlay = e.mine;
  await e.b.put('machines', one);
  await navigator.locks.request(`waarm64-machine:${one.id}`, async () => {
    const again = await restore(e, one.id, 'file:1'); // One's restore reuses K, its start under way
    assert.deepEqual(again.plan.forks.map((f) => f.reused), [true]);
    const t = await load(e, two.id);
    assert.equal(t.attachments[0].overlay, k, 'Two stays on the overlay it chose');
  });
  assert.equal(await attachedTo(e, two.id), k);
  // One's restore never loaded: One's own load puts it back.
  assert.equal(await nameOf(e, (await load(e, one.id)).attachments[0].overlay), 'Mine');
});

test("another machine's replace into an overlay this machine has chosen: this machine's load leaves it as it is, the other's undo empties it", async () => {
  const e = await withMine();
  const one = (await e.b.get('machines', e.m.id))!;
  const two: MachineRecord = { ...one, id: 'f0000000bbbb', name: 'Two' };
  await e.b.put('machines', two);
  await navigator.locks.request(`waarm64-machine:${one.id}`, async () => {
    await restore(e, one.id, 'k', { replace: true }); // into Mine, One's start under way
    await load(e, two.id); // Two loaded meanwhile, in another tab
    assert.equal(await emptied(e.mine), false, "untouched by Two's load");
    await fill(e.mine, true); // One's fill, then the worker refuses the snapshot
  });
  await load(e, one.id);
  assert.equal(await emptied(e.mine), true, "One's undo reads it as empty: its restore replaced it and never loaded");
});

test("a fork whose restore never loaded is not attached again by another machine's restore of the snapshot", async () => {
  const e = await withMine();
  await restore(e, e.m.id, 'k');
  await fill((await attachedTo(e, e.m.id))!, true); // filled, then refused: One's next load undoes it
  const one = (await e.b.get('machines', e.m.id))!;
  const two: MachineRecord = { ...one, id: 'f0000000cccc', name: 'Two', restoring: undefined, attachments: one.attachments.map((a) => ({ ...a, overlay: e.mine })) };
  await e.b.put('machines', two);
  const plan = await planRestore(e.b, two, await disksOf(e.b), { name: 'Snap k', key: 'k', pins: e.pins }, { display: '2d' });
  assert.deepEqual(plan.forks.map((f) => f.reused), [false], "One's fork is its restore's until it loaded or was undone");
});

test('a restore whose undo finds its overlay open elsewhere stays to be undone: the next restore is refused until then', async () => {
  for (const how of ['replace', 'fork'] as const) {
    const e = await withMine();
    await restore(e, e.m.id, 'k', { replace: how === 'replace' });
    const target = (await attachedTo(e, e.m.id))!;
    await fill(target, true); // then refused: never loaded
    const open = await openOverlay(overlayDir(target), undefined, undefined, { readOnly: true }); // another tab's job
    const m = (await e.b.get('machines', e.m.id))!;
    assert.equal(await undoCutRestores(e.b, m), m, `${how}: nothing undone while it is open`);
    assert.ok((await e.b.get('machines', e.m.id))!.restoring, `${how}: still to be undone`);
    await assert.rejects(restore(e, e.m.id, 'k2'), (x: unknown) => msgOf(x)?.key === 'snapshots:snapshot-undo.pending', `${how}: no restore over it`);
    open.close();
    await letGo(target);
    const after = await load(e, e.m.id);
    assert.equal(after.restoring, undefined, `${how}: undone once free`);
    assert.equal(await nameOf(e, after.attachments[0].overlay), 'Mine');
    assert.equal(await emptied(e.mine), how === 'replace');
  }
});

test('a fork whose restore never loaded, deleted meanwhile (Delete overlay, a merge): the next load still puts the machine back', async () => {
  const e = await withMine();
  await restore(e, e.m.id, 'k');
  const fork = (await attachedTo(e, e.m.id))!;
  await deleteOverlayAsked(e.b, fork); // the machine left without one
  assert.equal(await attachedTo(e, e.m.id), undefined);
  const after = await load(e, e.m.id);
  assert.equal(await nameOf(e, after.attachments[0].overlay), 'Mine', 'back on the overlay it had');
});

// Found by checking the rules (PERF loop 82): a settings save wrote the draft's whole record, read before a restore's
// commit, so it put the attachments back and dropped the restore to undo.
test("a machine's settings saved from a draft read before a restore's commit keep what the commit wrote", async () => {
  const e = await withMine();
  const draft = (await e.b.get('machines', e.m.id))!; // the settings form's copy
  await restore(e, e.m.id, 'k');
  const committed = (await e.b.get('machines', e.m.id))!;
  await updateMachine(e.b, { ...draft, name: 'Renamed' });
  const after = (await e.b.get('machines', e.m.id))!;
  assert.equal(after.name, 'Renamed');
  assert.deepEqual([after.attachments, after.restoring], [committed.attachments, committed.restoring], "the commit's attachments and its restore to undo");
});

// Review restore-marks 7: the commit wrote the overlays' records, then the machine's; cut off in between (the storage
// full, the tab closed), the forks it made stayed, marked, where no undo reached them.
test('a commit cut off part way leaves nothing that the next load does not undo', async () => {
  for (const at of ['machines', 'overlays'] as const) {
    const e = await withMine();
    const put = e.b.put.bind(e.b);
    let armed = true;
    e.b.put = (async (kind: string, value: unknown) => {
      if (kind === at && armed) {
        armed = false;
        throw new DOMException('the storage is full', 'QuotaExceededError');
      }
      return put(kind as 'machines', value as MachineRecord);
    }) as typeof e.b.put;
    await assert.rejects(restore(e, e.m.id, 'k'));
    e.b.put = put;
    const after = await load(e, e.m.id);
    assert.equal(await nameOf(e, after.attachments[0].overlay), 'Mine', `${at}: back on Mine`);
    assert.deepEqual(await names(e), ['Mine'], `${at}: no fork left behind`);
  }
});

// Review restore-marks 8: Delete overlay held the machines that have the overlay chosen; a machine whose restore never
// loaded and would go back onto it wasn't, so its undo could name the overlay as it was deleted.
test('Delete overlay holds off a machine whose restore that never loaded goes back onto the overlay', async () => {
  const e = await withMine();
  await restore(e, e.m.id, 'k'); // a fork, never loaded: its undo goes back onto Mine
  await navigator.locks.request(`waarm64-machine:${e.m.id}`, async () => {
    await assert.rejects(deleteOverlayAsked(e.b, e.mine), (x: unknown) => msgOf(x)?.key === 'disks:disks.overlayUsersRunning');
  });
  assert.ok(await e.b.get('overlays', e.mine), 'not deleted while the machine is held');
});
