// Kept snapshots that can never be restored (web/app/snapshots.ts `unrestorable`, docs/machines.md §5.1
// "Unrestorable"), in Node over the store in memory and the overlays' in-memory files: from the records alone, a
// snapshot of another core's format, one taken over a stored disk written in place or merged into since (`bases`), one
// pinning a disk written in place that moved on (not in the file whole); and the restore's plan refusing the same, or
// forking where the disk didn't move. The header carries the bases (web/app/worker-header.ts), and a merge's
// confirmation counts the snapshots over the disk.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Msg } from '../web/msg.ts';
import { openStoredForWriting, zeroDisk } from '../web/stored.ts';
import { overlay } from '../web/overlay.ts';
import { SNAPSHOT_VERSION } from '../web/snapshot-file.ts';
import { identityOf } from '../web/app/disks.ts';
import { mergeEffect } from '../web/app/merge.ts';
import { basesIn, basesOf, planRestore, unrestorable } from '../web/app/snapshots.ts';
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

/** Writes a block of stored disk `d` in place (its generation moves, as a machine's run's would), and its record follows. */
async function writeInPlace(store: Store, d: DiskRecord) {
  const f = await openStoredForWriting(diskDir(d.id), identityOf(d), d.size);
  assert.ok(await overlay(zeroDisk(d.size), f.data, f.map, f.meta).write(0, new Uint8Array(4096).fill(1)));
  f.close();
  const { refreshStored } = await import('../web/app/disks.ts');
  await refreshStored(store, d.id);
  return (await store.get('disks', d.id))!;
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

test("from the records: another core's format, a stored disk moved under it, a disk written in place moved on (none of it whole)", async () => {
  const w = await world();
  const { store } = w;
  const lookup = async () => {
    const ds = await w.disks();
    return (id: string) => ds.get(id);
  };
  // Its machine reads S under an overlay and R read-only: their generations at its start are its bases.
  const bases = await basesOf(w.A, (id) => (id === w.S.id ? w.S : id === w.R.id ? w.R : undefined));
  assert.deepEqual(bases, { [w.S.id]: 0, [w.R.id]: 0 });
  assert.equal(await basesOf(w.B, (id) => (id === w.S.id ? w.S : undefined)), undefined, 'written in place: a pin, not a base');

  const overS = record(w.A.id, { bases, coreVersion: SNAPSHOT_VERSION });
  const inPlace = record(w.B.id, { pins: [{ slot: 0, overlay: diskDir(w.S.id), generation: 0, blocks: 0 }] });
  const whole = record(w.B.id, { pins: [{ slot: 0, overlay: diskDir(w.S.id), generation: 0, blocks: 1024 }] });
  let get = await lookup();
  assert.equal(unrestorable(overS, get), undefined);
  assert.equal(unrestorable(inPlace, get), undefined, 'a record from before `coreVersion`: the format then, as now');
  assert.equal(keyOf(unrestorable(record(w.A.id, { coreVersion: SNAPSHOT_VERSION - 1 }), get)), 'snapshots:snapshots.unrestorable.version');

  // B writes S in place: every snapshot over S, A's under its overlay and B's own, is lost for good; the whole one isn't.
  const moved = await writeInPlace(store, w.S);
  assert.equal(moved.generation, 1);
  get = await lookup();
  const why = unrestorable(overS, get);
  assert.equal(keyOf(why), 'snapshots:snapshots.unrestorable.base');
  assert.equal(why?.params?.disk, 'System');
  assert.equal(keyOf(unrestorable(inPlace, get)), 'snapshots:snapshots.unrestorable.inPlace');
  assert.equal(unrestorable(whole, get), undefined, 'the file has the whole disk: it forks');
  // A record behind its files (a machine writes it in place now) says nothing yet: only a moved record is for good.
  assert.equal(unrestorable(record(w.B.id, { pins: [{ slot: 0, overlay: diskDir(w.S.id), generation: 5, blocks: 0 }] }), get), undefined);
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
