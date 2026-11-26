// Kept snapshots that can never be restored (web/app/snapshots.ts `unrestorable`, docs/machines.md §5.1
// "Unrestorable"), in Node over the store in memory and the overlays' in-memory files: from the disks' files (their
// records lag them while a machine writes them), a snapshot of another core's format, one taken over a stored disk
// written in place or merged into since (`bases`), one pinning a disk written in place that moved on (not in the file
// whole); the restore's plan refusing exactly those (one judgment: `lost`), and forking where the disk didn't move. The header carries the bases (web/app/worker-header.ts), and a merge's
// confirmation counts the snapshots over the disk.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Msg } from '../web/msg.ts';
import { openStoredForWriting, zeroDisk } from '../web/stored.ts';
import { overlay } from '../web/overlay.ts';
import { SNAPSHOT_VERSION } from '../web/snapshot-file.ts';
import { identityOf } from '../web/app/disks.ts';
import { mergeEffect } from '../web/app/merge.ts';
import { planRestore, unrestorable } from '../web/app/snapshots.ts';
import { basesIn, basesOf, dependsOn, diskGenerations } from '../web/app/snapshot-lost.ts';
import { header } from '../web/app/worker-header.ts';
import { slots, type DiskRecord, type MachineRecord } from '../web/app/shape.ts';
import { diskDir, overlayDir, Store, type OverlayRecord, type SnapshotRecord } from '../web/app/store.ts';
import { memoryFiles, memoryRecords } from '../web/app/store-backends.ts';

const MiB = 2 ** 20;
let n = 0;
const keyOf = (m: Msg | undefined) => m?.key;

/**
 * A fresh store: stored disks S (machine A reads it under overlay `os`; machine B writes it in place) and R (A reads it
 * read-only), their block stores made (generation 0).
 */
async function world() {
  const k = `${process.pid}${(n++).toString(16).padStart(4, '0')}`.slice(-8);
  const id = (p: string) => `${p}${k}`.padStart(12, '0').slice(-12);
  const store = new Store(memoryRecords(), memoryFiles(), { channel: false });
  const stored = (p: string, name: string): DiskRecord => ({ id: id(p), kind: 'stored', name, size: 4 * MiB, identity: { kind: 'stored', id: id(p), bytes: 0 }, generation: 0, created: 0 });
  const [S, R] = [stored('d1', 'System'), stored('d2', 'Data')];
  for (const d of [S, R]) {
    (await openStoredForWriting(diskDir(d.id), identityOf(d), d.size)).close();
    await store.put('disks', d);
  }
  const os: OverlayRecord = { id: id('os'), name: 'Variant', disk: S.id, identity: S.identity, generation: 0, bytes: 0, created: 0, modified: 0 };
  await store.put('overlays', os);
  const m = (name: string, attachments: MachineRecord['attachments']): MachineRecord => ({ id: id(name), name, ncpus: 1, ramMiB: 512, display: '2d', created: 0, modified: 0, attachments });
  const A = m('aa', [{ id: id('a1'), disk: S.id, readOnly: false, overlay: os.id }, { id: id('a2'), disk: R.id, readOnly: true }]);
  const B = m('bb', [{ id: id('b1'), disk: S.id, readOnly: false, inPlace: true }]);
  for (const x of [A, B]) await store.put('machines', x);
  const disks = async () => new Map((await store.all('disks')).map((d) => [d.id, d]));
  return { store, S, R, os, A, B, disks };
}

/**
 * Writes a block of stored disk `d` in place (its generation moves, as a machine's run's would), and its record follows
 * (`refresh`: as at the run's end; without, as while the machine still runs).
 */
async function writeInPlace(store: Store, d: DiskRecord, refresh = true) {
  const f = await openStoredForWriting(diskDir(d.id), identityOf(d), d.size);
  assert.ok(await overlay(zeroDisk(d.size), f.data, f.map, f.meta).write(0, new Uint8Array(4096).fill(1)));
  f.close();
  const { refreshStored } = await import('../web/app/disks.ts');
  if (refresh) await refreshStored(store, d.id);
  return (await store.get('disks', d.id))!;
}

/** What the snapshot lists say of kept snapshot `s` (`unrestorable` over the disks' files, as Snapshots.svelte reads them). */
async function listed(store: Store, s: SnapshotRecord) {
  const ds = new Map((await store.all('disks')).map((d) => [d.id, d]));
  return unrestorable(s, (id) => ds.get(id), await diskGenerations(dependsOn([s])));
}

const record = (machine: string, over: Partial<SnapshotRecord> = {}): SnapshotRecord => ({
  id: 'ffffffffff01',
  machine,
  name: 's',
  created: 0,
  bytes: 0,
  shape: { disks: [] } as unknown as SnapshotRecord['shape'],
  shapeHash: '',
  pins: [],
  ...over,
});

test("from the disks' files: another core's format, a stored disk moved under it, a disk written in place moved on (none of it whole)", async () => {
  const w = await world();
  const { store } = w;
  const get = (s: SnapshotRecord) => listed(store, s);
  // Its machine reads S under an overlay and R read-only: their generations at its start are its bases.
  const bases = await basesOf(w.A, (id) => (id === w.S.id ? w.S : id === w.R.id ? w.R : undefined));
  assert.deepEqual(bases, { [w.S.id]: 0, [w.R.id]: 0 });
  assert.equal(await basesOf(w.B, (id) => (id === w.S.id ? w.S : undefined)), undefined, 'written in place: a pin, not a base');

  const overS = record(w.A.id, { bases, coreVersion: SNAPSHOT_VERSION });
  const inPlace = record(w.B.id, { pins: [{ slot: 0, overlay: diskDir(w.S.id), generation: 0, blocks: 0 }] });
  const whole = record(w.B.id, { pins: [{ slot: 0, overlay: diskDir(w.S.id), generation: 0, blocks: 1024 }] });
  assert.equal(await get(overS), undefined);
  assert.equal(await get(inPlace), undefined, 'a record from before `coreVersion`: the format then, as now');
  assert.equal(keyOf(await get(record(w.A.id, { coreVersion: SNAPSHOT_VERSION - 1 }))), 'snapshots:snapshots.unrestorable.version');

  // B writes S in place: every snapshot over S, A's under its overlay and B's own, is lost for good; the whole one isn't.
  // Its record not refreshed yet (B still runs): the files say it, as the restore would refuse it now.
  const moved = await writeInPlace(store, w.S, false);
  assert.equal(moved.generation, 0, 'the record lags');
  const why = await get(overS);
  assert.equal(keyOf(why), 'snapshots:snapshots.unrestorable.base');
  assert.equal(why?.params?.disk, 'System');
  assert.equal(keyOf(await get(inPlace)), 'snapshots:snapshots.unrestorable.inPlace');
  assert.equal(await get(whole), undefined, 'the file has the whole disk: it forks');
  // A snapshot taken during that run, after the disk's first write there: its pin is the files', the record's behind it.
  assert.equal(await get(record(w.B.id, { pins: [{ slot: 0, overlay: diskDir(w.S.id), generation: 1, blocks: 0 }] })), undefined);
});

test("the restore's plan refuses a snapshot whose stored disk moved under it, and forks a disk pinned in place, unmoved, now under an overlay", async () => {
  const w = await world();
  const { store } = w;
  const slotOf = (m: MachineRecord, i: number) => slots({ nets: 0, display: '2d', attachments: m.attachments }).findIndex((s) => s.attachment === i);
  const run = { display: '2d' as const, devices: [] };
  const bases = await basesOf(w.A, (id) => (id === w.S.id ? w.S : w.R));
  const pinsA = [{ slot: slotOf(w.A, 0), identity: identityOf(w.S), size: 4 * MiB, blocks: 0, overlay: overlayDir(w.os.id), generation: 0 }];
  const planA = async () => planRestore(store, w.A, await w.disks(), { name: 's', key: 'k', pins: pinsA, bases }, run);
  assert.equal((await planA()).refused, undefined, 'over the disks as they were: kept');

  // B was snapshotted in place, then its attachment put under an overlay (not in place any more), S not written: a fork
  // of what the file holds of it (nothing) over S as it was is the snapshot's disk.
  const pinsB = [{ slot: slotOf(w.B, 0), identity: identityOf(w.S), size: 4 * MiB, blocks: 0, overlay: diskDir(w.S.id), generation: 0 }];
  const B2 = structuredClone(w.B);
  B2.attachments[0].inPlace = undefined;
  await store.put('machines', B2);
  const plan = await planRestore(store, B2, await w.disks(), { name: 's', key: 'kb', pins: pinsB }, run);
  assert.equal(plan.refused, undefined);
  assert.equal(plan.forks.length, 1);
  const steps = await plan.commit(false);
  const write = steps.find((s) => s.action === 'write');
  assert.ok(write?.action === 'write' && !write.whole, 'a fork, not of the whole disk');
  const b = (await store.get('machines', w.B.id))!;
  assert.ok(b.attachments[0].overlay && !b.attachments[0].inPlace);

  // Now S is written in place (by another machine): A's snapshot over it, and B's in place, are refused.
  await writeInPlace(store, w.S);
  const refused = (await planA()).refused;
  assert.equal(keyOf(refused), 'snapshots:snapshots.baseMoved');
  assert.equal(refused?.params?.disk, 'System');
  const again = await planRestore(store, (await store.get('machines', w.B.id))!, await w.disks(), { name: 's', key: 'kb2', pins: pinsB }, run);
  assert.equal(keyOf(again.refused), 'snapshots:snapshots.writtenInPlace');
});

test('the lists and the restore agree on every reason a snapshot is refused, before and after its disk moves, its record lagging', async () => {
  const w = await world();
  const { store } = w;
  const slotOf = (m: MachineRecord, i: number) => slots({ nets: 0, display: '2d', attachments: m.attachments }).findIndex((s) => s.attachment === i);
  const run = { display: '2d' as const, devices: [] };
  const bases = await basesOf(w.A, (id) => (id === w.S.id ? w.S : w.R));
  const pinA = { slot: slotOf(w.A, 0), identity: identityOf(w.S), size: 4 * MiB, blocks: 0, overlay: overlayDir(w.os.id), generation: 0 };
  const pinB = (blocks: number) => ({ slot: slotOf(w.B, 0), identity: identityOf(w.S), size: 4 * MiB, blocks, overlay: diskDir(w.S.id), generation: 0 });
  // The words each says a reason in: the list's, the restore's.
  const words: Record<string, string> = {
    'snapshots:snapshots.unrestorable.version': 'snapshots:snapshot.otherVersion',
    'snapshots:snapshots.unrestorable.base': 'snapshots:snapshots.baseMoved',
    'snapshots:snapshots.unrestorable.inPlace': 'snapshots:snapshots.writtenInPlace',
  };
  const underOverlay: MachineRecord = { ...w.B, attachments: [{ ...w.B.attachments[0], inPlace: undefined }] };
  const cases = [
    { name: 'over S under an overlay', m: w.A, pins: [pinA], bases },
    { name: 'over S, of another format', m: w.A, pins: [pinA], bases, coreVersion: SNAPSHOT_VERSION + 1 },
    { name: 'S in place', m: w.B, pins: [pinB(0)] },
    { name: 'S in place, whole', m: w.B, pins: [pinB(1024)] },
    { name: 'S in place, the attachment under an overlay since', m: underOverlay, pins: [pinB(0)] },
  ];
  const seen = new Set<string>();
  let n = 0;
  for (const moved of [false, true]) {
    if (moved) await writeInPlace(store, w.S, false); // B runs: S's files move, its record doesn't yet
    for (const c of cases) {
      const pins = c.pins.map(({ slot, overlay, generation, blocks }) => ({ slot, overlay, generation, blocks }));
      const rec = record(c.m.id, { pins, bases: c.bases, coreVersion: c.coreVersion ?? SNAPSHOT_VERSION });
      const list = keyOf(await listed(store, rec));
      const snap = { name: 's', key: `k${n++}`, pins: c.pins, bases: c.bases, coreVersion: rec.coreVersion };
      const plan = await planRestore(store, c.m, await w.disks(), snap, run);
      const what = `${c.name}${moved ? ', S moved' : ''}: the list says ${list}, the restore ${keyOf(plan.refused)}`;
      assert.equal(list ? words[list] : undefined, keyOf(plan.refused), what);
      if (list) seen.add(list);
    }
  }
  assert.deepEqual([...seen].sort(), Object.keys(words).sort(), 'every reason came up');
});

test("the header carries the bases; a file's are read back whole or not at all; a merge into the disk counts the snapshots over it", async () => {
  const w = await world();
  const { store } = w;
  const about = { name: 'A', shape: { disks: [] } as never, shapeHash: 'h', urls: {}, bases: { [w.S.id]: 3 } };
  const h = header({ name: 'debian' as never, ncpus: 1, disk: null, kinds: [], cpu: [], about }, undefined, '');
  assert.deepEqual((h as Record<string, unknown>).bases, { [w.S.id]: 3 });
  const asHeader = (bases: unknown) => ({ format: 1 as const, coreVersion: 6, abi: 1, created: '', bases });
  assert.deepEqual(basesIn(asHeader({ [w.S.id]: 3 })), { [w.S.id]: 3 });
  assert.equal(basesIn(asHeader({ [w.S.id]: 'x' })), undefined);
  assert.equal(basesIn(asHeader([1])), undefined);
  assert.equal(basesIn(asHeader(undefined)), undefined);

  // Merging into R (stored): the snapshot that read R read-only is counted, though it pins nothing of R.
  const os2: OverlayRecord = { ...w.os, id: 'ffffffffff02', disk: w.R.id, identity: w.R.identity };
  await store.put('overlays', os2);
  const s = record(w.A.id, { bases: { [w.R.id]: 0 } });
  await store.put('snapshots', s);
  const effect = await mergeEffect(store, os2.id);
  assert.deepEqual(effect?.snapshots.map((x) => x.id), [s.id]);
});

test('a stored disk attached read-only with a leftover in-place mark is read, not written: a base; Read-only clears the mark', async () => {
  const w = await world();
  const { store } = w;
  // B's attachment written in place, then made read-only before the mark was cleared (a record from before).
  const C: MachineRecord = { ...w.B, id: w.B.id.replace(/^../, 'cc'), attachments: [{ ...w.B.attachments[0], readOnly: true, inPlace: true }] };
  assert.deepEqual(await basesOf(C, (id) => (id === w.S.id ? w.S : undefined)), { [w.S.id]: 0 }, 'its guest reads S: its generation is a base');
  // Ticking Read-only clears the mark (the box is hidden then: unticked, the disk is under an overlay again).
  await store.put('machines', w.B);
  const { editAttachment } = await import('../web/app/machines.ts');
  await editAttachment(store, w.B, w.B.attachments[0].id, { readOnly: true });
  const b = (await store.get('machines', w.B.id))!.attachments[0];
  assert.deepEqual([b.readOnly, b.inPlace], [true, undefined]);
});

// Review restore-tokens 1: a snapshot taken under an overlay, its attachment written in place since. The machine runs on
// the stored disk itself, so the overlay its record still names is neither kept (the snapshot's RAM would land on the
// stored disk without the overlay's blocks) nor written into (a replace, a template's fresh overlay): the disk forks,
// under an overlay again. Turned on and run in place, the stored disk moved under the snapshot: refused (its base).
test("a snapshot taken under an overlay, the attachment written in place since: it forks (never kept or written into), or is refused once the disk moved", async () => {
  const slotOf = (m: MachineRecord) => slots({ nets: 0, display: '2d', attachments: m.attachments }).findIndex((s) => s.attachment === 0);
  const run = { display: '2d' as const, devices: [] };
  const { editAttachment } = await import('../web/app/machines.ts');
  const { openOverlay, writeMeta } = await import('../web/overlay.ts');
  const setGeneration = async (id: string, generation: number) => {
    const f = await openOverlay(overlayDir(id), undefined);
    assert.ok(writeMeta(f.meta, { generation, merging: '', size: 0 }));
    f.close();
    await navigator.locks.request(`waarm64-overlay:${overlayDir(id)}`, async () => {});
  };
  /** A fresh world, A's overlay at generation `at` (pinned at 0), A's attachment then written in place. */
  const inPlace = async (at: number) => {
    const w = await world();
    await setGeneration(w.os.id, 0);
    const bases = await basesOf(w.A, (id) => (id === w.S.id ? w.S : w.R));
    const pins = [{ slot: slotOf(w.A), identity: identityOf(w.S), size: 4 * MiB, blocks: 0, overlay: overlayDir(w.os.id), generation: 0 }];
    if (at) await setGeneration(w.os.id, at);
    await editAttachment(w.store, w.A, w.A.attachments[0].id, { inPlace: true });
    const m = (await w.store.get('machines', w.A.id))!;
    assert.deepEqual([m.attachments[0].overlay, m.attachments[0].inPlace], [w.os.id, true], 'the record still names the overlay');
    return { ...w, m, snap: { name: 's', key: `k${at}`, pins, bases } };
  };
  type W = Awaited<ReturnType<typeof inPlace>>;
  /** The plan's words, the worker's plan, and the attachment after the commit. */
  const restored = async (w: W, o: { replace?: boolean; fresh?: boolean } = {}) => {
    const plan = await planRestore(w.store, w.m, await w.disks(), w.snap, run, { fresh: o.fresh });
    const words = { kept: plan.kept, forks: plan.forks.map((f) => [f.reused, f.replaceable?.overlay]) };
    const steps = await plan.commit(!!o.replace);
    const a = (await w.store.get('machines', w.A.id))!.attachments[0];
    return { words, steps, a };
  };
  const forked = (w: W, r: Awaited<ReturnType<typeof restored>>, what: string) => {
    assert.deepEqual(r.words, { kept: [], forks: [[false, undefined]] }, `${what}: a fork, no replace offered`);
    assert.equal(r.steps.length, 1);
    const step = r.steps[0];
    assert.ok(step.action === 'write' && step.fork && step.overlay !== overlayDir(w.os.id), `${what}: written into a new fork, not the overlay`);
    assert.ok(r.a.overlay && r.a.overlay !== w.os.id && !r.a.inPlace, `${what}: the attachment under the fork, not in place`);
  };

  // Turned on, restored before any run, the overlay as pinned (and at the stored disk's generation, which the worker's
  // keep check read): no keep.
  let w = await inPlace(0);
  forked(w, await restored(w), 'unmoved');
  // Its undo puts the attachment back in place, on its overlay.
  assert.deepEqual((await w.store.get('machines', w.A.id))!.restoring?.map((s) => s.how === 'fork' && s.before), [{ overlay: w.os.id, inPlace: true }]);
  // The overlay moved on before it was turned on: no replace offered, and a replace answered (asked of another disk,
  // say) writes nothing into it.
  w = await inPlace(2);
  forked(w, await restored(w, { replace: true }), 'moved, replace');
  // A template's first restore (its pin names the template's overlay) onto a fresh overlay of an attachment written in
  // place: not filled.
  w = await inPlace(0);
  w.snap.pins = [{ ...w.snap.pins[0], overlay: 'overlays/0123456789ab', generation: 4 }];
  forked(w, await restored(w, { fresh: true }), 'fresh');
  // Run in place, writing: the stored disk moved under the snapshot (its base), refused, as the lists say.
  w = await inPlace(0);
  await writeInPlace(w.store, w.S);
  assert.equal(keyOf((await planRestore(w.store, w.m, await w.disks(), w.snap, run)).refused), 'snapshots:snapshots.baseMoved');
  // Pinned in place and still in place, unmoved: kept, on the stored disk (the keep names what the device runs on).
  w = await inPlace(0);
  const pinsB = [{ slot: slotOf(w.m), identity: identityOf(w.S), size: 4 * MiB, blocks: 0, overlay: diskDir(w.S.id), generation: 0 }];
  const kept = await planRestore(w.store, w.m, await w.disks(), { name: 's', key: 'kb', pins: pinsB }, run);
  assert.deepEqual(kept.kept, ['System']);
  assert.deepEqual(await kept.commit(false), [{ slot: pinsB[0].slot, action: 'keep', overlay: diskDir(w.S.id), generation: 0 }]);
});
