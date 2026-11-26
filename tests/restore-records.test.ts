// A restore's records (docs/machines.md §5.2 "A restore's records") in Node, where overlays live in memory: what a
// restore's commit writes, what the worker's `loaded` makes the machine's, and what the machine's next load undoes of a
// restore that never loaded, case by case (the rules' table), and the races between machines that share an overlay,
// a commit cut off part way, and Delete overlay. The page's side (a `loaded` that can't be recorded, Retry, a hold's
// words): tests/page-restore.test.ts; the template's first start: tests/page-template-first.test.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openOverlay, overlayMeta, writeMeta } from '../web/overlay.ts';
import { exportDefinition, importDefinition } from '../web/app/definitions.ts';
import { deleteOverlayAsked, switchOverlay } from '../web/app/disks.ts';
import { attachFolder } from '../web/app/folders.ts';
import { MACHINES } from '../web/app/machine.ts';
import { createDisk, createMachine, attach, duplicateMachine, editAttachment, setAdapterConnection, updateMachine } from '../web/app/machines.ts';
import { explain } from '../web/app/worker-errors.ts';
import { planRestore } from '../web/app/snapshots.ts';
import { restoreLoaded, undoCutRestores } from '../web/app/snapshot-undo.ts';
import { newId, shapeOf, type MachineRecord } from '../web/app/shape.ts';
import { overlayDir, Store } from '../web/app/store.ts';
import { memoryFiles, memoryRecords } from '../web/app/store-backends.ts';
import { msgOf, MsgError } from '../web/msg.ts';

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

/**
 * The worker's fill of overlay `id` (web/snapshot.ts) for the restore that names it (its token, from the machine's
 * `restoring`): moved on and marked with the token before it is emptied (`openOverlay`'s `fresh`); `done`: its mark
 * cleared at its end.
 */
async function fill(id: string, done: boolean, b?: Store) {
  const token = b ? tokenOf(await b.all('machines'), id) : undefined;
  const was = (await overlayMeta(overlayDir(id))).generation;
  const f = await openOverlay(overlayDir(id), undefined, undefined, { fresh: { size: 0, token } });
  assert.ok(writeMeta(f.meta, { generation: was + 1, merging: '', size: 0, filling: !done, token }));
  f.close();
  await letGo(id);
}
const tokenOf = (ms: MachineRecord[], id: string) =>
  ms.flatMap((m) => m.restoring ?? []).find((s) => s.overlay === id)?.token;

/** Another machine's run on overlay `id` that writes it: its opening bumps the generation before the first change. */
async function runWrites(id: string) {
  const was = await overlayMeta(overlayDir(id));
  const f = await openOverlay(overlayDir(id), undefined);
  assert.ok(writeMeta(f.meta, { ...was, generation: was.generation + 1, token: undefined }));
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
/** A second machine, a copy of `id` (its record as Duplicate makes it). */
const copyOf = (e: Env, id: string) => duplicateMachine(e.b, id);
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
      await restore(e, e.m.id, 'first');
      await fill((await attachedTo(e, e.m.id))!, true, e.b);
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
      if (c.how !== 'reuse') await fill(target, c.worker !== 'cut', e.b);
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

// Review restore-marks 3: machine One's restore reattached fork K, which machine Two has chosen; Two loaded while One's
// start holds One's lock moved Two onto One's earlier overlay. Since review restore-records 9 (PERF loop 84) One's
// restore doesn't attach Two's K again: it forks, and Two's load leaves that alone too.
test("another machine's restore of a snapshot whose earlier fork this machine has chosen forks, and is left alone by this machine's load", async () => {
  const e = await withMine();
  await restore(e, e.m.id, 'file:1');
  const k = (await attachedTo(e, e.m.id))!;
  await fill(k, true, e.b);
  await restoreLoaded(e.b, e.m.id);
  const one = (await e.b.get('machines', e.m.id))!;
  const two: MachineRecord = { ...one, id: 'f0000000aaaa', name: 'Two', attachments: one.attachments.map((a) => ({ ...a, overlay: k })) };
  await e.b.put('machines', two);
  one.attachments[0].overlay = e.mine;
  await e.b.put('machines', one);
  await navigator.locks.request(`waarm64-machine:${one.id}`, async () => {
    const again = await restore(e, one.id, 'file:1'); // One's restore, its start under way: K is Two's
    assert.deepEqual(again.plan.forks.map((f) => f.reused), [false]);
    const t = await load(e, two.id);
    assert.equal(t.attachments[0].overlay, k, 'Two stays on the overlay it chose');
  });
  assert.equal(await attachedTo(e, two.id), k);
  // One's restore never loaded: One's own load puts it back, and deletes its own new fork, not Two's K.
  assert.equal(await nameOf(e, (await load(e, one.id)).attachments[0].overlay), 'Mine');
  assert.deepEqual(await names(e), ['Mine', 'Snap file:1']);
});

// Since review restore-records 1 (PERF loop 84) a replace isn't made into an overlay another machine has at the commit
// (it forks): Two chooses Mine after One's commit, as a copy of One then is.
test("another machine's replace into an overlay this machine chose after its commit: this machine's load leaves it as it is, the other's undo empties it", async () => {
  const e = await withMine();
  const one = (await e.b.get('machines', e.m.id))!;
  await navigator.locks.request(`waarm64-machine:${one.id}`, async () => {
    await restore(e, one.id, 'k', { replace: true }); // into Mine, One's start under way
    const two = await copyOf(e, one.id); // in another tab, a copy of One: on Mine
    await load(e, two.id); // Two loaded meanwhile
    assert.equal(await emptied(e.mine), false, "untouched by Two's load");
    await fill(e.mine, true, e.b); // One's fill, then the worker refuses the snapshot
  });
  await load(e, one.id);
  assert.equal(await emptied(e.mine), true, "One's undo reads it as empty: its restore replaced it and never loaded");
});

test("a fork whose restore never loaded is not attached again by another machine's restore of the snapshot", async () => {
  const e = await withMine();
  await restore(e, e.m.id, 'k');
  await fill((await attachedTo(e, e.m.id))!, true, e.b); // filled, then refused: One's next load undoes it
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
    await fill(target, true, e.b); // then refused: never loaded
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
    const [put, update] = [e.b.put.bind(e.b), e.b.update.bind(e.b)];
    let armed = true;
    const refuse = (kind: string) => {
      if (kind !== at || !armed) return;
      armed = false;
      throw new DOMException('the storage is full', 'QuotaExceededError');
    };
    e.b.put = (async (kind: string, value: unknown) => {
      refuse(kind);
      return put(kind as 'machines', value as MachineRecord);
    }) as typeof e.b.put;
    e.b.update = (async (kind: string, id: string, f: (was: MachineRecord | undefined) => MachineRecord | undefined) => {
      refuse(kind);
      return update(kind as 'machines', id, f);
    }) as typeof e.b.update;
    const among = e.b.updateAmong.bind(e.b);
    e.b.updateAmong = (async (kind: string, id: string, f: (was: MachineRecord | undefined, all: MachineRecord[]) => MachineRecord | undefined) => {
      refuse(kind);
      return among(kind as 'machines', id, f);
    }) as typeof e.b.updateAmong;
    await assert.rejects(restore(e, e.m.id, 'k'));
    [e.b.put, e.b.update, e.b.updateAmong] = [put, update, among];
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

// Review restore-records (PERF loop 84): overlays and forks other machines attach. The rules (docs/machines.md §5.2 "A
// restore's records", "Other machines"): a restore writes into an overlay only when no other machine has it; an undo
// empties or deletes only what its own fill's token proves nothing else wrote since, and never a fork another machine
// has chosen; Duplicate copies what the undo will put back.


test('review 1: a replace is not offered, and not made, on an overlay another machine has chosen: it forks', async () => {
  const e = await withMine();
  const two = await copyOf(e, e.m.id); // shares Mine
  assert.equal(two.attachments[0].overlay, e.mine);
  const { plan, steps } = await restore(e, e.m.id, 'k', { replace: true });
  assert.deepEqual(plan.forks.map((f) => f.replaceable), [undefined], 'nothing to replace is asked');
  assert.notEqual(steps[0].action === 'write' && steps[0].overlay, overlayDir(e.mine), 'the restore writes a fork, not Mine');
  await runWrites(e.mine); // Two runs on Mine
  await load(e, e.m.id);
  assert.equal(await emptied(e.mine), false, "Two's Mine as Two left it");
  assert.equal(await attachedTo(e, two.id), e.mine);
});

test("review 1: a replace's undo leaves an overlay another machine wrote after the commit as that machine left it", async () => {
  for (const worker of ['never', 'filled'] as const) {
    const e = await withMine();
    await restore(e, e.m.id, 'k', { replace: true }); // into Mine
    if (worker === 'filled') await fill(e.mine, true, e.b); // then refused after its fill
    const two = await copyOf(e, e.m.id); // a copy made after the commit: on Mine too
    assert.equal(two.attachments[0].overlay, e.mine, `${worker}: the copy on Mine`);
    await runWrites(e.mine); // the copy runs on Mine and writes it
    await load(e, e.m.id);
    assert.equal(await emptied(e.mine), false, `${worker}: what the copy wrote is not read as empty`);
    assert.equal((await e.b.get('machines', e.m.id))!.restoring, undefined, `${worker}: undone`);
  }
});

test("review 1: a template's first restore cut off, then a copy boots on its fresh overlay: the undo leaves it, and the next first restore forks", async () => {
  const e = await withFresh();
  await restore(e, e.m.id, 'k', { fresh: true }); // into Fresh, cut off before the disk phase
  const copy = await copyOf(e, e.m.id);
  assert.equal(copy.attachments[0].overlay, e.fresh);
  await runWrites(e.fresh); // the copy boots and writes
  await load(e, e.m.id);
  assert.equal(await emptied(e.fresh), false, "the copy's Fresh as it left it");
  const again = await restore(e, e.m.id, 'k', { fresh: true });
  assert.notEqual(again.steps[0].action === 'write' && again.steps[0].overlay, overlayDir(e.fresh), 'not into Fresh: the copy has it');
});

test("review 1: a template's first restore doesn't write into a fresh overlay another machine has chosen", async () => {
  const e = await withFresh();
  await copyOf(e, e.m.id); // a copy made before the first start: on Fresh
  const { steps } = await restore(e, e.m.id, 'k', { fresh: true });
  assert.notEqual(steps[0].action === 'write' && steps[0].overlay, overlayDir(e.fresh), 'a fork beside it');
});

test('review 2: the replace answer holds for the overlay the question named, not for another one attached since', async () => {
  const e = await withMine();
  const m = (await e.b.get('machines', e.m.id))!;
  const plan = await planRestore(e.b, m, await disksOf(e.b), { name: 'Snap k', key: 'k', pins: e.pins }, { display: '2d' });
  assert.deepEqual(plan.forks.map((f) => f.replaceable?.name), ['Mine']);
  const now = Date.now();
  const work = { id: newId(), name: 'Work', disk: e.disk.id, identity: e.disk.identity, generation: 5, bytes: 1 << 30, created: now, modified: now };
  await e.b.put('overlays', work);
  await setMeta(work.id, 5);
  const switched = (await e.b.get('machines', e.m.id))!;
  switched.attachments[0].overlay = work.id; // the Home page in another tab, while the question was open
  await e.b.put('machines', switched);
  const steps = await plan.commit(true);
  assert.notEqual(steps[0].action === 'write' && steps[0].overlay, overlayDir(work.id), 'Work is not written into');
  assert.equal((await e.b.get('machines', e.m.id))!.restoring?.[0].how, 'fork');
});

test('review 3: a copy made while a restore has not loaded is on what the undo puts back, and keeps it', async () => {
  const e = await withMine();
  await restore(e, e.m.id, 'k');
  const fork = (await attachedTo(e, e.m.id))!;
  await fill(fork, true, e.b); // then refused
  const copy = await copyOf(e, e.m.id);
  assert.equal(copy.attachments[0].overlay, e.mine, 'the copy on Mine, not the fork');
  await load(e, e.m.id);
  assert.equal(await attachedTo(e, copy.id), e.mine);
  assert.deepEqual(await names(e), ['Mine'], 'the fork undone');
});

test('review 3: the undo never deletes a fork another machine has chosen since, running or not, written or not', async () => {
  for (const how of ['chosen', 'written', 'running'] as const) {
    const e = await withMine();
    await restore(e, e.m.id, 'k');
    const fork = (await attachedTo(e, e.m.id))!;
    await fill(fork, true, e.b); // then refused
    const two = await copyOf(e, e.m.id);
    await switchOverlay(e.b, two, two.attachments[0].id, fork); // Two chose it (the Overlays dialog)
    if (how === 'written') await runWrites(fork); // ran on it and stopped
    const open = how === 'running' ? await openOverlay(overlayDir(fork), undefined) : undefined;
    const after = await load(e, e.m.id);
    assert.equal(await nameOf(e, after.attachments[0].overlay), 'Mine', `${how}: One back on Mine`);
    assert.equal(after.restoring, undefined, `${how}: One's restore undone (review 8: not held up by Two's run)`);
    assert.equal(await attachedTo(e, two.id), fork, `${how}: Two keeps the fork`);
    assert.ok(await e.b.get('overlays', fork), `${how}: the fork kept`);
    open?.close();
    if (open) await letGo(fork);
  }
});

test("review 3: the undo keeps a fork someone else wrote since, though no machine has it chosen now", async () => {
  const e = await withMine();
  await restore(e, e.m.id, 'k');
  const fork = (await attachedTo(e, e.m.id))!;
  await fill(fork, true, e.b);
  await runWrites(fork); // a machine that chose it, ran and went back to another overlay
  await load(e, e.m.id);
  assert.ok(await e.b.get('overlays', fork), 'not deleted: its writes are not the restore\'s');
});

test('review 4: a fill cut off between emptying the overlay and its meta never takes the generation back', async () => {
  const e = await withMine(); // Mine at generation 2
  await restore(e, e.m.id, 'k', { replace: true });
  const token = tokenOf(await e.b.all('machines'), e.mine);
  const f = await openOverlay(overlayDir(e.mine), undefined, undefined, { fresh: { size: 0, token } });
  f.close(); // cut off: the tab closed before the fill wrote its meta
  await letGo(e.mine);
  await load(e, e.m.id);
  const b = await openOverlay(overlayDir(e.mine), undefined); // the next boot
  b.close();
  await letGo(e.mine);
  const meta = await overlayMeta(overlayDir(e.mine));
  assert.ok(meta.generation > 2, `past the generation a kept snapshot may pin (${meta.generation})`);
  assert.equal(meta.filling, undefined, 'read as empty, then emptied');
});

/**
 * Runs `write` (a writer of machine records) with its first read of one (after `skip` others) held until `between`
 * (another tab's write) has landed: what a read-modify-write outside the machine's lock does to it.
 */
async function interleaved(e: Env, write: () => Promise<unknown>, between: () => Promise<unknown>, skip = 0) {
  const get = e.b.get.bind(e.b);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let reached!: () => void;
  const read = new Promise<void>((r) => (reached = r));
  let armed = true;
  e.b.get = (async (kind: 'machines', id: string) => {
    const v = await get(kind, id);
    if (kind === 'machines' && armed && skip-- <= 0) {
      armed = false;
      reached();
      await gate;
    }
    return v;
  }) as typeof e.b.get;
  const writing = write();
  await Promise.race([read, writing]);
  e.b.get = get;
  await between();
  release();
  await writing;
}

test("review 5: a machine record's other writers keep a restore's commit and its load that land while they work", async () => {
  // Each writes either from its own read of the record (held here until the other write landed) or from the caller's
  // copy (the Home page's, read before).
  type Writer = [string, 'reads' | 'given', (e: Env, given: MachineRecord) => Promise<unknown>];
  const writers: Writer[] = [
    ['a settings save', 'given', (e, given) => updateMachine(e.b, { ...given, name: 'Renamed' })],
    ['a settings save', 'reads', (e, given) => updateMachine(e.b, { ...given, name: 'Renamed' })],
    ['a connection', 'reads', (e) => setAdapterConnection(e.b, e.m.id, 0, 'c0000000000a')],
    ['an attached folder', 'reads', (e) => attachFolder(e.b, e.m.id, 'f00000000001', false)],
    ['an attachment edit', 'given', (e, given) => editAttachment(e.b, given, given.attachments[0].id, { move: 1 })],
    ['an attach', 'given', async (e, given) => attach(e.b, given, await createDisk(e.b, { kind: 'blank', size: 1 << 20 }))],
  ];
  const across = (e: Env, how: 'reads' | 'given', write: (given: MachineRecord) => Promise<unknown>, between: () => Promise<unknown>) =>
    e.b.get('machines', e.m.id).then((given) =>
      how === 'reads' ? interleaved(e, () => write(given!), between) : between().then(() => write(given!)),
    );
  for (const [what, how, write] of writers) {
    // Across the commit: the record keeps the commit's attachments and its restore to undo.
    const e = await withMine();
    let committed: MachineRecord | undefined;
    await across(e, how, (given) => write(e, given), async () => {
      await restore(e, e.m.id, 'k');
      committed = (await e.b.get('machines', e.m.id))!;
    });
    const after = (await e.b.get('machines', e.m.id))!;
    assert.deepEqual(
      [after.attachments[0].overlay, after.restoring],
      [committed!.attachments[0].overlay, committed!.restoring],
      `${what} (${how}): the commit kept`,
    );
    // Across `loaded`: the restore stays the machine's.
    const f = await withMine();
    await restore(f, f.m.id, 'k');
    await fill((await attachedTo(f, f.m.id))!, true, f.b);
    await across(f, how, (given) => write(f, given), () => restoreLoaded(f.b, f.m.id));
    assert.equal((await f.b.get('machines', f.m.id))!.restoring, undefined, `${what} (${how}): loaded stays loaded`);
  }
});

test("review 5: a restore's commit and its undo keep what another tab wrote to the machine's record while they worked", async () => {
  const e = await withMine();
  // The commit reads the record (planning again: the read after the helper's), then writes it: a connection attached in
  // between stays.
  await interleaved(e, () => restore(e, e.m.id, 'k'), () => setAdapterConnection(e.b, e.m.id, 0, 'c0000000000b'), 1);
  const committed = (await e.b.get('machines', e.m.id))!;
  assert.ok(committed.restoring, 'committed');
  assert.equal(committed.adapters?.[0].connection, 'c0000000000b', "the commit kept the other tab's write");
  // The undo reads it under the lock, works on the overlays, then writes it: the same.
  const given = (await e.b.get('machines', e.m.id))!;
  await interleaved(e, () => undoCutRestores(e.b, given), () => setAdapterConnection(e.b, e.m.id, 0, 'c0000000000c'));
  const undone = (await e.b.get('machines', e.m.id))!;
  assert.equal(undone.restoring, undefined, 'undone');
  assert.equal(undone.attachments[0].overlay, e.mine);
  assert.equal(undone.adapters?.[0].connection, 'c0000000000c', "the undo kept the other tab's write");
});

test('review 6: a restore refused after its fill emptied an overlay says so, whatever refused it', () => {
  const at = { restoring: true, ramMiB: 64 };
  const full = Object.assign(new MsgError('snapshots:snapshot.storageFull'), { emptied: true });
  const inUse = Object.assign(new Error('the disk is in use'), { problem: 'overlay-in-use', emptied: true });
  for (const err of [full, inUse]) {
    const [problem, error] = explain(err, MACHINES.buildroot, at);
    assert.equal(problem, 'snapshot', `${String(err)}: a snapshot's problem (Start, Load snapshot; a template boots instead)`);
    assert.equal(msgOf(error)?.key, 'snapshots:worker-errors.notRestored');
    assert.equal(msgOf((error as Error).cause)?.key, 'snapshots:worker-errors.notRestored.emptied');
  }
});

test("review 9: a restore doesn't attach again an earlier fork that another machine has chosen, or that another machine's undo goes back onto", async () => {
  // One restored k (fork F, loaded) and stays on F.
  const e = await withMine();
  await restore(e, e.m.id, 'k');
  const f = (await attachedTo(e, e.m.id))!;
  await fill(f, true, e.b);
  await restoreLoaded(e.b, e.m.id);
  const two = await copyOf(e, e.m.id);
  await switchOverlay(e.b, two, two.attachments[0].id, e.mine);
  const plan = async () => (await planRestore(e.b, (await e.b.get('machines', two.id))!, await disksOf(e.b), { name: 'Snap k', key: 'k', pins: e.pins }, { display: '2d' })).forks.map((x) => x.reused);
  assert.deepEqual(await plan(), [false], "One's F is One's");
  // One's restore of another snapshot, never loaded: its undo puts One back on F.
  await restore(e, e.m.id, 'k2');
  assert.notEqual(await attachedTo(e, e.m.id), f);
  assert.deepEqual(await plan(), [false], "F is One's again at its undo");
});

// Review restore-tokens (PERF loop 86).

test("restore-tokens 4: a copy of a machine whose restore hasn't loaded isn't put on an earlier overlay deleted since", async () => {
  const e = await withMine();
  await restore(e, e.m.id, 'k'); // a fork, never loaded: its undo goes back onto Mine
  await deleteOverlayAsked(e.b, e.mine); // the machine is free: Delete overlay of Mine is allowed
  assert.equal(await e.b.get('overlays', e.mine), undefined);
  const copy = await copyOf(e, e.m.id);
  assert.equal(copy.attachments[0].overlay, undefined, 'no overlay: its next start makes an empty one, as the undo leaves the original');
  const after = await load(e, e.m.id);
  assert.equal(after.attachments[0].overlay, undefined, 'the undo agrees');
});

test("restore-tokens 8: a template's fresh overlay marked as its fork at `loaded` and its record refreshed at the run's stop, at once: both stay", async () => {
  const { refreshOverlay } = await import('../web/app/disks.ts');
  for (const first of ['loaded', 'refresh'] as const) {
    const e = await withFresh();
    await restore(e, e.m.id, 'k', { fresh: true }); // into Fresh
    await fill(e.fresh, true, e.b);
    const loaded = () => restoreLoaded(e.b, e.m.id);
    const refresh = () => refreshOverlay(e.b, e.fresh);
    await Promise.all(first === 'loaded' ? [loaded(), refresh()] : [refresh(), loaded()]);
    const o = (await e.b.get('overlays', e.fresh))!;
    assert.deepEqual([o.name, o.fork, o.generation], ['Snap k', { snapshot: 'k', generation: 1 }, 1], `${first} first: the fork's name and mark, and the generation from its files`);
  }
  // The refresh landing just after any read of the overlay's record that `loaded` makes (none of its own: one write).
  const e = await withFresh();
  await restore(e, e.m.id, 'k', { fresh: true });
  await fill(e.fresh, true, e.b);
  const get = e.b.get.bind(e.b);
  let fired = false;
  e.b.get = (async (kind: 'overlays', id: string) => {
    const got = await get(kind, id);
    if (kind === 'overlays' && id === e.fresh && !fired) {
      fired = true;
      await refreshOverlay(e.b, e.fresh);
    }
    return got;
  }) as Store['get'];
  await restoreLoaded(e.b, e.m.id);
  e.b.get = get;
  if (!fired) await refreshOverlay(e.b, e.fresh);
  const o = (await e.b.get('overlays', e.fresh))!;
  assert.deepEqual([o.name, o.fork, o.generation], ['Snap k', { snapshot: 'k', generation: 1 }, 1], 'the refresh between: both stay');
});

test("restore-tokens 7: another machine chose the overlay a replace writes into between the commit's check and its write: the commit refuses, and Retry forks", async () => {
  const e = await withMine();
  const two = await copyOf(e, e.m.id);
  const now = Date.now();
  const work = { id: newId(), name: 'Work', disk: e.disk.id, identity: e.disk.identity, generation: 0, bytes: 0, created: now, modified: now };
  await e.b.put('overlays', work);
  await switchOverlay(e.b, two, two.attachments[0].id, work.id); // Two on Work: Mine is One's alone
  const m = (await e.b.get('machines', e.m.id))!;
  const plan = await planRestore(e.b, m, await disksOf(e.b), { name: 'Snap k', key: 'k', pins: e.pins }, { display: '2d' });
  assert.deepEqual(plan.forks.map((f) => f.replaceable?.name), ['Mine'], 'Mine offered to replace');
  // Another tab's Overlays dialog puts Two on Mine just before the commit's write of One's record.
  const [update, among] = [e.b.update.bind(e.b), e.b.updateAmong.bind(e.b)];
  let armed = true;
  const meanwhile = async (kind: string, id: string) => {
    if (!armed || kind !== 'machines' || id !== e.m.id) return;
    armed = false;
    await switchOverlay(e.b, (await e.b.get('machines', two.id))!, two.attachments[0].id, e.mine);
  };
  e.b.update = (async (kind: 'machines', id: string, f: Parameters<Store['update']>[2]) => (await meanwhile(kind, id), update(kind, id, f as never))) as Store['update'];
  e.b.updateAmong = (async (kind: 'machines', id: string, f: Parameters<Store['updateAmong']>[2]) => (await meanwhile(kind, id), among(kind, id, f as never))) as Store['updateAmong'];
  await assert.rejects(plan.commit(true), (x: unknown) => msgOf(x)?.key === 'snapshots:snapshots.takenMeanwhile' && msgOf(x)?.params?.overlay === 'Mine');
  [e.b.update, e.b.updateAmong] = [update, among];
  const after = (await e.b.get('machines', e.m.id))!;
  assert.deepEqual([after.restoring, after.attachments[0].overlay], [undefined, e.mine], 'nothing committed');
  // Retry: planned again on the records as they are now, it forks beside Two's Mine.
  const steps = await plan.commit(true);
  assert.notEqual(steps[0].action === 'write' && steps[0].overlay, overlayDir(e.mine), 'a fork, not Mine');
  assert.equal(await attachedTo(e, two.id), e.mine);
});
