// The disk surface window's pure parts in Node: a surface's looks (web/app/surface-look.ts: rims, cores, flashes, the
// disk's end, the legend, a cell's and a range's words) and where a view's numbers come from (web/app/surface-source.ts:
// `chooseSource`, the in-place answer, the polls' pacing, a job's timeout). The window itself is
// tests/page-surface.test.ts's (Chromium).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CORE, FLASH, RIM, TICK } from '../web/app/ui/block-grid.ts';
import { cellWords, checkable, detailLook, detailWords, legendOf, lookOf, rangesOfCell, sizeText, stepOf, viewOf, wholeWords } from '../web/app/surface-look.ts';
import { asInPlace, choiceKey, chooseSource, holdsDisks, jobSource, keptIdentity, pollDelay, type JobWorker } from '../web/app/surface-source.ts';
import { cacheIdentity } from '../web/diskcache.ts';
import { carryActivity, RANGE, UNIT, type InspectAnswer, type RangeDetail, type Surface, type SurfaceLayer } from '../web/surface.ts';
import type { Attachment, DiskRecord } from '../web/app/shape.ts';
import type { OverlayRecord } from '../web/app/store.ts';

const MiB = 2 ** 20;
const per = RANGE / UNIT; // blocks in a range

const layer = (id: string, size: number, held: number[], zero: number[] = held.map(() => 0), known: SurfaceLayer['known'] = 'counted'): SurfaceLayer =>
  ({ id, size, known, held: Uint32Array.from(held), zero: Uint32Array.from(zero) });

test('looks: any held block is the first step, a full cell the last; nothing held is empty; past the disk absent, its end marked', () => {
  assert.deepEqual([stepOf(1, per), stepOf(per / 4, per), stepOf(per / 4 + 1, per), stepOf(per, per), stepOf(0, per)], [1, 1, 2, 4, 1]);
  // A disk of 3 ranges under an overlay grown to 5, a cell a range.
  const s: Surface = {
    size: 5 * RANGE,
    cellBytes: RANGE,
    unitBytes: UNIT,
    layers: [layer('disk', 3 * RANGE, [0, 1, per, 0, 0]), layer('overlay', 5 * RANGE, [0, 0, 10, 0, per], [0, 3, 0, 0, 0])],
    activity: Uint8Array.from([1, 2, 3, 0, 0]),
  };
  const l = lookOf(s);
  assert.equal(l.cells, 5);
  assert.deepEqual([...l.rim], [RIM.empty, RIM.step(1), RIM.step(4), RIM.absent, RIM.absent]);
  assert.deepEqual([...l.core], [CORE.none, CORE.hollow, CORE.step(1), CORE.none, CORE.step(4)], 'only zeroed: hollow');
  assert.deepEqual([...l.flash!], [FLASH.read, FLASH.write, FLASH.read | FLASH.write, 0, 0]);
  assert.equal(l.mark, 2, "the disk's last cell");
  // The disk alone, the same size as the view: no mark, no cores, no flash.
  const alone = lookOf({ ...s, size: 3 * RANGE, layers: [layer('disk', 3 * RANGE, [0, 1, per])], activity: undefined });
  assert.equal(alone.mark, undefined);
  assert.deepEqual([...alone.core], [0, 0, 0]);
  assert.equal(alone.flash, undefined);
  // An image not examined: flat.
  const opaque = lookOf({ ...s, layers: [layer('disk', 5 * RANGE, [per, per, per, per, per], undefined, 'opaque')], activity: undefined });
  assert.ok([...opaque.rim].every((r) => r === RIM.opaque));
  // A short last cell counts its own blocks: 1 MiB held of a cell of 1 MiB is full.
  const short = lookOf({ size: RANGE + MiB, cellBytes: 2 * RANGE, unitBytes: UNIT, layers: [layer('disk', RANGE + MiB, [MiB / UNIT + per])] });
  assert.deepEqual([...short.rim], [RIM.step(4)]);
});

test('legend: only the looks the view can show', () => {
  const keys = (v: Parameters<typeof legendOf>[0]) => legendOf(v).map((e) => e.key.slice(e.key.lastIndexOf('.') + 1));
  assert.deepEqual(keys({ disk: 'counted', overlay: false, grown: false, live: false }), ['empty', 'some', 'full']);
  assert.deepEqual(keys({ disk: 'opaque', overlay: true, grown: true, live: true }), ['opaque', 'absent', 'changed', 'zeroed', 'read', 'written']);
  assert.deepEqual(keys({ disk: 'ram', overlay: false, grown: false, live: true }), ['empty', 'ram', 'full', 'read', 'written']);
});

test("words: a cell's offsets and counts, a range's blocks and runs, sizes as exact as a cell's", () => {
  assert.deepEqual([sizeText(0), sizeText(4 * MiB), sizeText(2 ** 30), sizeText(3 * 2 ** 29), sizeText(5 * 2 ** 40)], ['0 B', '4 MiB', '1 GiB', '1.50 GiB', '5 TiB']);
  const s: Surface = { size: 3 * RANGE, cellBytes: 2 * RANGE, unitBytes: UNIT, layers: [layer('disk', 2 * RANGE, [5, 0]), layer('overlay', 3 * RANGE, [2, 0], [1, 4])], activity: Uint8Array.from([3, 1]) };
  assert.deepEqual(cellWords(s, 0), [
    { key: 'disks:surface-look.at', params: { from: '0 B', to: '8 MiB' } },
    { key: 'disks:surface-look.disk.held', params: { held: 5, count: 2 * per } },
    { key: 'disks:surface-look.overlay.both', params: { count: 2, zero: 1 } },
    { key: 'disks:surface-look.readWritten' },
  ]);
  assert.deepEqual(cellWords(s, 1).map((m) => m.key), ['disks:surface-look.at', 'disks:surface-look.disk.past', 'disks:surface-look.overlay.zeroed', 'disks:surface-look.read']);
  assert.deepEqual(cellWords(s, 1)[0].params, { from: '8 MiB', to: '12 MiB' }, 'the last cell ends at the size');
  assert.deepEqual(rangesOfCell(s, 1), { first: 2, count: 1 }, 'the last cell covers what remains');
  assert.deepEqual(rangesOfCell(s, 0), { first: 0, count: 2 });
  // A range: the disk's 3 blocks in 2 runs, the overlay's 2 in 1, one zeroed, the rest past the end.
  const blocks = new Uint8Array(per).fill(4);
  blocks.set([1, 1, 0, 1, 2, 2, 3, 0]);
  const d: RangeDetail = { range: 1, blocks, runs: { disk: 2, overlay: 1 }, content: { read: 5, zeros: 2 } };
  assert.deepEqual(detailWords(d, { disk: 'counted', overlay: true }), [
    { key: 'disks:surface-look.range', params: { from: '4 MiB', to: '8 MiB' } },
    { key: 'disks:surface-look.range.diskRuns', params: { blocks: 3, count: 2 } },
    { key: 'disks:surface-look.range.overlayRuns', params: { blocks: 2, count: 1 } },
    { key: 'disks:surface-look.range.zeroed', params: { count: 1 } },
    { key: 'disks:surface-look.range.content', params: { count: 5, zeros: 2 } },
  ]);
  const look = detailLook(d);
  assert.deepEqual([...look.rim.subarray(0, 9)], [RIM.step(4), RIM.step(4), RIM.empty, RIM.step(4), 0, 0, 0, 0, RIM.absent]);
  assert.deepEqual([...look.core.subarray(0, 8)], [0, 0, 0, 0, CORE.step(4), CORE.step(4), CORE.hollow, 0]);
  assert.equal(detailLook({ ...d, blocks: Uint8Array.from([5]) }).rim[0], RIM.opaque, 'a block not examined');
  assert.equal(look.tick, undefined, 'nothing kept: no ticks');
});

test("looks: a qcow2's squares under tables not read yet, and a remote image's kept blocks as ticks over every rim", () => {
  // Four cells a range: all not examined; a quarter held of the half known; known empty with a part not examined;
  // all known and full.
  const disk: SurfaceLayer = { ...layer('disk', 4 * RANGE, [0, per / 4, 0, per]), unknown: Uint32Array.from([per, per / 2, per / 2, 0]), why: 'tables' };
  const s: Surface = { size: 4 * RANGE, cellBytes: RANGE, unitBytes: UNIT, layers: [disk] };
  assert.deepEqual([...lookOf(s).rim], [RIM.opaque, RIM.step(2), RIM.opaque, RIM.step(4)], 'a step over the blocks known; known empty with some not examined: not examined');
  assert.equal(lookOf(s).tick, undefined, 'a local image: no ticks');
  assert.deepEqual(cellWords(s, 1).slice(1), [
    { key: 'disks:surface-look.disk.heldKnown', params: { held: per / 4, count: per / 2 } },
    { key: 'disks:surface-look.disk.unknown', params: { count: per / 2 } },
  ]);
  assert.deepEqual(wholeWords(s, false), [{ key: 'disks:surface-look.why.tablesSome' }]);
  assert.deepEqual(wholeWords({ ...s, layers: [{ ...disk, why: 'large' }] }, false), [{ key: 'disks:surface-look.why.largeSome' }]);
  assert.deepEqual(wholeWords({ ...s, layers: [{ ...disk, unknown: Uint32Array.from([per, per, per, per]) }] }, false), [{ key: 'disks:surface-look.why.tables' }], 'none known yet');
  // Kept: of the units with data (a qcow2's), of every unit (a raw one's).
  const kept: SurfaceLayer = { ...layer('disk', 4 * RANGE, [0, 10, 10, per]), kept: Uint32Array.from([0, 4, 10, per]) };
  assert.deepEqual([...lookOf({ ...s, layers: [kept] }).tick!], [TICK.none, TICK.part, TICK.all, TICK.all]);
  assert.deepEqual(cellWords({ ...s, layers: [kept] }, 1).slice(-1), [{ key: 'disks:surface-look.disk.keptData', params: { kept: 4 } }]);
  assert.deepEqual(cellWords({ ...s, layers: [{ ...kept, kept: new Uint32Array(4) }] }, 1).slice(-1), [{ key: 'disks:surface-look.disk.keptNone' }]);
  assert.deepEqual(wholeWords({ ...s, layers: [kept] }, false), [{ key: 'disks:surface-look.hint' }, { key: 'disks:surface-look.keptAll', params: { size: sizeText((per + 14) * UNIT) } }]);
  const raw: SurfaceLayer = { ...layer('disk', 4 * RANGE, [per, per, per, per], undefined, 'opaque'), kept: Uint32Array.from([0, 1, per - 1, per]) };
  const rawLook = lookOf({ ...s, layers: [raw] });
  assert.deepEqual([...rawLook.rim], [RIM.opaque, RIM.opaque, RIM.opaque, RIM.opaque], 'the rim says what the disk holds, not what is kept');
  assert.deepEqual([...rawLook.tick!], [TICK.none, TICK.part, TICK.part, TICK.all]);
  // The legend: "not examined" with a counted disk that has some; the kept pair over each disk's look.
  const keys = (v: Parameters<typeof legendOf>[0]) => legendOf(v).map((e) => `${e.key.slice(e.key.lastIndexOf('.') + 1)}${e.tick ? `:${e.tick}` : ''}`);
  assert.deepEqual(keys(viewOf(s, 'file', false, false)), ['empty', 'some', 'full', 'opaque']);
  assert.deepEqual(keys(viewOf({ ...s, layers: [kept] }, 'url', false, true)), ['empty', 'some', 'full', `keptSome:${TICK.part}`, `kept:${TICK.all}`, 'read', 'written']);
  assert.deepEqual(legendOf(viewOf({ ...s, layers: [kept] }, 'url', false, true))[3].rim, RIM.step(2));
  assert.deepEqual(legendOf(viewOf({ ...s, layers: [raw] }, 'url', false, true))[1].rim, RIM.opaque, 'ticks over the hatch');
  // A range's kept blocks: ticked, and said.
  const blocks = new Uint8Array(per);
  blocks.set([1, 1, 0, 5]);
  const keptBlocks = new Uint8Array(per);
  keptBlocks[1] = 1;
  const r: RangeDetail = { range: 0, blocks, runs: {}, kept: keptBlocks };
  assert.deepEqual([...detailLook(r).tick!.subarray(0, 3)], [TICK.none, TICK.all, TICK.none]);
  assert.deepEqual(detailWords(r, { disk: 'counted', overlay: false, kept: true }).slice(1), [
    { key: 'disks:surface-look.range.disk', params: { count: 2 } },
    { key: 'disks:surface-look.range.unknown', params: { count: 1 } },
    { key: 'disks:surface-look.range.keptData', params: { count: 1 } },
  ]);
});

test("live: an answer a newer ask replaced has its activity carried into the next picture, at the next one's cell size", () => {
  const next: Surface = { size: 8 * RANGE, cellBytes: 2 * RANGE, unitBytes: UNIT, layers: [], activity: Uint8Array.from([0, 1, 0, 0]) };
  // The dropped one at a range a cell: range 0 written, range 5 read; the next at two ranges a cell.
  const carried = carryActivity({ cellBytes: RANGE, activity: Uint8Array.from([2, 0, 0, 0, 0, 1, 0, 0]) }, next);
  assert.deepEqual([...carried!], [2, 1, 1, 0]);
  // To smaller cells: a cell of the dropped one marks each it covers.
  const finer = carryActivity({ cellBytes: 4 * RANGE, activity: Uint8Array.from([0, 2]) }, { ...next, cellBytes: RANGE, activity: undefined });
  assert.deepEqual([...finer!], [0, 0, 0, 0, 2, 2, 2, 2]);
  assert.equal(carryActivity({ cellBytes: RANGE }, next), next.activity, 'nothing to carry');
});

// ---------------------------------------------------------------------------------------------------------------------
// Where the numbers come from.

const disk = (kind: DiskRecord['kind'], size = 64 * MiB): DiskRecord => ({ id: `d-${kind}`, kind, name: kind, size, identity: null } as unknown as DiskRecord);
const over = (d: DiskRecord, id: string, size?: number): OverlayRecord => ({ id, name: id, disk: d.id, identity: null, generation: 0, bytes: 0, created: 0, modified: 0, ...(size ? { size } : {}) } as unknown as OverlayRecord);
const at = (d: DiskRecord, o: Partial<Attachment> = {}): Attachment => ({ id: `a-${d.id}`, disk: d.id, readOnly: false, ...o });

test('chooseSource: live where the machine on this page has the disk so, else the files; a ramdisk only while it runs', () => {
  const [stored, url, blank, ram] = [disk('stored'), disk('url'), disk('blank'), disk('ramdisk')];
  const work = over(stored, 'work', 128 * MiB);
  const other = over(stored, 'other');
  // Slot order: a URL disk, then the stored disk through `work`, then the ramdisk.
  const running = { attachments: [at(url, { overlay: 'u1' }), at(stored, { overlay: 'work' }), at(ram)] };
  assert.deepEqual(chooseSource({ disk: stored.id, overlay: 'work' }, stored, work, running), { kind: 'live', disk: 1, inPlace: false });
  assert.deepEqual(chooseSource({ disk: ram.id }, ram, undefined, running), { kind: 'live', disk: 2, inPlace: false });
  // Another overlay of it, or the disk alone (its base under the overlay the machine writes): the files.
  assert.deepEqual(chooseSource({ disk: stored.id, overlay: 'other' }, stored, other, running), {
    kind: 'offline',
    job: { stored: `disks/${stored.id}`, overlay: 'overlays/other', size: 64 * MiB, baseKind: 'stored' },
  });
  assert.deepEqual(chooseSource({ disk: stored.id }, stored, undefined, running), { kind: 'offline', job: { stored: `disks/${stored.id}`, size: 64 * MiB, baseKind: 'stored' } });
  // A grown overlay's own size goes with the job; images are not examined; a blank disk holds nothing.
  assert.deepEqual(chooseSource({ disk: stored.id, overlay: 'work' }, stored, work), {
    kind: 'offline',
    job: { stored: `disks/${stored.id}`, overlay: 'overlays/work', overlaySize: 128 * MiB, size: 64 * MiB, baseKind: 'stored' },
  });
  // A URL's image: from the blocks this browser keeps, named by its record (keptIdentity); none kept without a validator.
  const urlDisk = { ...url, url: 'https://example.com/d.img', identity: { kind: 'url', path: '/d.img', bytes: 64 * MiB, etag: '"e1"' } } as DiskRecord;
  assert.deepEqual(chooseSource({ disk: url.id }, urlDisk, undefined), {
    kind: 'offline',
    job: { baseKind: 'remote', remote: { bytes: 64 * MiB, identity: keptIdentity(urlDisk) }, size: 64 * MiB },
  });
  const plain = { ...urlDisk, identity: { kind: 'url', path: '/d.img', bytes: 64 * MiB } } as DiskRecord;
  assert.deepEqual((chooseSource({ disk: url.id }, plain, undefined) as { job: unknown }).job, { baseKind: 'remote', remote: { bytes: 64 * MiB }, size: 64 * MiB });
  assert.equal((chooseSource({ disk: blank.id }, blank, undefined) as { job: { baseKind: string } }).job.baseKind, 'blank');
  // In place, and read-only: the disk alone is live.
  assert.deepEqual(chooseSource({ disk: stored.id }, stored, undefined, { attachments: [at(stored, { inPlace: true })] }), { kind: 'live', disk: 0, inPlace: true });
  assert.deepEqual(chooseSource({ disk: stored.id }, stored, undefined, { attachments: [at(stored, { readOnly: true, inPlace: true })] }), { kind: 'live', disk: 0, inPlace: false });
  assert.deepEqual(chooseSource({ disk: url.id }, url, undefined, { attachments: [at(url, { readOnly: true })] }), { kind: 'live', disk: 0, inPlace: false });
  // A ramdisk not running; a disk or an overlay gone.
  assert.deepEqual(chooseSource({ disk: ram.id }, ram, undefined), { kind: 'unavailable', why: { key: 'disks:surface-source.ramdisk' } });
  assert.deepEqual(chooseSource({ disk: 'gone' }, undefined, undefined, running), { kind: 'unavailable', why: { key: 'disks:surface-source.diskGone' } });
  assert.deepEqual(chooseSource({ disk: stored.id, overlay: 'x' }, stored, undefined, running), { kind: 'unavailable', why: { key: 'disks:surface-source.overlayGone' } });
});

test("keptIdentity: a URL disk's record names its kept blocks as the running machine names them", () => {
  const rec = (url: string, identity: object) => ({ id: 'u', kind: 'url', name: 'u', size: 8 * MiB, url, identity, created: 0 }) as DiskRecord;
  // web/disk-sources.ts `remoteSource`'s names, pinned: blocks kept under them by a page before stay found.
  assert.equal(keptIdentity(rec('https://h/d.img', { kind: 'url', path: '/d.img', bytes: 8 * MiB, etag: '"e1"' })), '{"url":"https://h/d.img","size":8388608,"validator":"\\"e1\\""}');
  assert.equal(keptIdentity(rec('https://h/d.img', { kind: 'url', path: '/d.img', bytes: 8 * MiB, lastModified: 'Tue, 01 Sep 2026 00:00:00 GMT' })), cacheIdentity({ url: 'https://h/d.img', size: 8 * MiB, validator: 'Tue, 01 Sep 2026 00:00:00 GMT' }));
  assert.equal(keptIdentity(rec('https://h/d.json', { kind: 'url', chunked: 'abc', bytes: 8 * MiB })), 'chunked:abc');
  assert.equal(keptIdentity(rec('https://h/d.json', { kind: 'url', path: '/d.json', bytes: 8 * MiB, etag: 'abc' })), 'chunked:abc', 'a chunked image added before content ids');
  assert.equal(keptIdentity(rec('https://h/d.img', { kind: 'url', path: '/d.img', bytes: 8 * MiB })), undefined, 'no validator: nothing kept');
  assert.equal(keptIdentity(disk('stored')), undefined);
});

test('a stored disk written in place answers live as a blank disk and its store: the store is shown as the disk', () => {
  const size = 2 * RANGE;
  const live: InspectAnswer = { kind: 'disk-surface', surface: { size, cellBytes: RANGE, unitBytes: UNIT, layers: [layer('disk', size, [0, 0]), layer('overlay', size, [7, 0], [2, 0])] } };
  const s = (asInPlace(live) as Extract<InspectAnswer, { kind: 'disk-surface' }>).surface;
  assert.deepEqual(s.layers.map((l) => [l.id, [...l.held], [...l.zero]]), [['disk', [7, 0], [0, 0]]]);
  const blocks = Uint8Array.from([0, 2, 3, 4]);
  const r = asInPlace({ kind: 'disk-range', detail: { range: 0, blocks, runs: { overlay: 3 } } }) as Extract<InspectAnswer, { kind: 'disk-range' }>;
  assert.deepEqual([...r.detail.blocks], [0, 1, 0, 4]);
  assert.deepEqual(r.detail.runs, { disk: 3 });
});

test("the live poll's pacing: every 500 ms, stretched to keep an answer's cost under 2%", () => {
  assert.equal(pollDelay(), 500);
  assert.equal(pollDelay(4), 500);
  assert.equal(pollDelay(30), 1500);
});

test("a job's ask: its worker's answer, or after its time a refusal in words, and the worker ended either way", async () => {
  const made: { posted: unknown[]; ended: boolean; w: JobWorker }[] = [];
  const make = (answer?: InspectAnswer) => () => {
    const m = { posted: [] as unknown[], ended: false, w: undefined as unknown as JobWorker };
    m.w = {
      onmessage: null,
      onerror: null,
      postMessage(x: unknown) {
        m.posted.push(x);
        if (answer) queueMicrotask(() => m.w.onmessage?.({ data: answer } as MessageEvent<InspectAnswer>));
      },
      terminate() { m.ended = true; },
    };
    made.push(m);
    return m.w;
  };
  const job = { size: RANGE, baseKind: 'blank' as const };
  const ok = jobSource(job, make({ kind: 'none', why: { key: 'disks:surface-job.inUse' } }), 1000);
  assert.deepEqual(await ok.surface(12), { kind: 'none', why: { key: 'disks:surface-job.inUse' } });
  assert.deepEqual(made[0].posted, [{ ...job, query: { kind: 'disk-surface', disk: 0, cells: 12 } }]);
  assert.ok(made[0].ended);
  const slow = jobSource(job, make(), 20);
  assert.deepEqual(await slow.range(0, true), { kind: 'none', why: { key: 'disks:surface-source.noAnswer' } });
  assert.ok(made[1].ended);
  assert.deepEqual(made[1].posted, [{ ...job, query: { kind: 'disk-range', disk: 0, range: 0, content: true } }]);
  // Closed with an ask in flight: it ends at once; its worker once it answers (it may have the files open, and a
  // terminated worker's locks go before its handles do: a deletion under the lock would find them open).
  const closing = jobSource(job, make(), 60_000);
  const pending = closing.surface(1);
  await new Promise((r) => setTimeout(r)); // the job posted
  closing.close();
  assert.deepEqual(await pending, { kind: 'none' });
  assert.ok(!made[2].ended, 'left to finish');
  made[2].w.onmessage?.({ data: { kind: 'none' } } as MessageEvent<InspectAnswer>);
  assert.ok(made[2].ended);
  // Closed before its job was posted (it waited for a merge, or an image's handle): the worker has nothing open, ended at once.
  const early = jobSource(job, make(), 60_000);
  const unposted = early.surface(1);
  early.close();
  assert.deepEqual(await unposted, { kind: 'none' });
  await new Promise((r) => setTimeout(r));
  assert.deepEqual(made[3].posted, []);
  assert.ok(made[3].ended);
});

test("a job's asks: a newer one of a kind ends the one before (its worker once it answers), a range's and the map's apart", async () => {
  const made: { ended: boolean; answer: (a: InspectAnswer) => void }[] = [];
  const make = () => {
    const w: JobWorker = { onmessage: null, onerror: null, postMessage() {}, terminate() { m.ended = true; } };
    const m = { ended: false, answer: (a: InspectAnswer) => w.onmessage?.({ data: a } as MessageEvent<InspectAnswer>) };
    made.push(m);
    return w;
  };
  const s = jobSource({ size: RANGE, baseKind: 'blank' }, make, 60_000);
  const first = s.surface(4);
  const range = s.range(0, true);
  await new Promise((r) => setTimeout(r)); // their jobs posted
  const second = s.surface(8);
  assert.deepEqual(await first, { kind: 'none' }, 'superseded');
  assert.deepEqual(made.map((m) => m.ended), [false, false, false], "the first map's worker left to finish, the range's running");
  const a: InspectAnswer = { kind: 'none', why: { key: 'disks:surface-job.inUse' } };
  made[0].answer({ kind: 'none' });
  assert.deepEqual(made.map((m) => m.ended), [true, false, false], "the first map's worker ended once it answered");
  made[2].answer(a);
  assert.deepEqual(await second, a);
  made[1].answer(a);
  assert.deepEqual(await range, a);
  assert.ok(made.every((m) => m.ended));
});

test("chooseSource: this tab's machine writing the disk in place holds its store (said so, no job), and a machine loading is live to be", () => {
  const stored = disk('stored');
  const work = over(stored, 'work');
  const here = { attachments: [at(stored, { inPlace: true })] };
  assert.deepEqual(chooseSource({ disk: stored.id, overlay: 'work' }, stored, work, here), { kind: 'unavailable', why: { key: 'disks:surface-source.inPlaceHere' } });
  assert.deepEqual(chooseSource({ disk: stored.id }, stored, undefined, here), { kind: 'live', disk: 0, inPlace: true });
  // Read-only here (a shared lock, as the job's): its overlays are read from their files.
  assert.equal(chooseSource({ disk: stored.id, overlay: 'work' }, stored, work, { attachments: [at(stored, { inPlace: true, readOnly: true })] }).kind, 'offline');
  // The machine here holds its disks from its loading (its device worker opens them) to its stop; not once off.
  assert.deepEqual((['loading', 'booting', 'running', 'rebooting'] as const).map(holdsDisks), [true, true, true, true]);
  assert.deepEqual((['off', 'suspended', 'crashed', 'failed', 'idle'] as const).map(holdsDisks), [false, false, false, false, false]);
});

test("the choice's key: two file disks of one size apart (their ids, their files), the same disk alike however its handle is read back", () => {
  const handle = () => ({ kind: 'file', name: 'a.qcow2' }) as unknown as FileSystemFileHandle;
  const file = (id: string, name: string, h = handle()) => ({ ...disk('file'), id, name, handle: h, identity: { kind: 'file', name, bytes: 64 * MiB, modified: 1 } }) as unknown as DiskRecord;
  const [a, b] = [file('fa', 'a.qcow2'), file('fb', 'b.qcow2')];
  const key = (d: DiskRecord) => choiceKey(chooseSource({ disk: d.id }, d, undefined), d);
  assert.notEqual(key(a), key(b));
  assert.equal(key(a), key(file('fa', 'a.qcow2')), 'the records read again: a new handle object, the same key');
  assert.notEqual(key(a), key({ ...a, identity: { kind: 'file', name: 'a.qcow2', bytes: 64 * MiB, modified: 2 } } as unknown as DiskRecord), 'another file picked for it');
  assert.ok(!key(a).includes('handle'), 'no handle in it');
});

test("Check contents: offered where a block it would read is held; an image it doesn't read can't be checked, said so", () => {
  const blocks = new Uint8Array(per);
  blocks.set([1, 1, 5]);
  const image: RangeDetail = { range: 0, blocks, runs: {} };
  assert.equal(checkable(image, { disk: 'opaque' }), false, 'an image not examined: its blocks are not read');
  assert.equal(checkable(image, { disk: 'counted' }), true);
  assert.equal(checkable({ ...image, blocks: Uint8Array.from([1, 2]) }, { disk: 'opaque' }), true, "the overlay's blocks are read");
  assert.equal(checkable({ ...image, blocks: new Uint8Array(per) }, { disk: 'counted' }), false, 'nothing held');
  // A check that read none of the held blocks (a remote qcow2's, counted from its tables but not fetched): said so.
  const none = detailWords({ ...image, content: { read: 0, zeros: 0 } }, { disk: 'counted', overlay: false });
  assert.deepEqual(none.at(-1), { key: 'disks:surface-look.range.uncheckable' });
  assert.ok(!none.some((m) => m.key === 'disks:surface-look.range.content'));
});
