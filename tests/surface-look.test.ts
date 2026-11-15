// The disk surface window's pure parts in Node: a surface's looks (web/app/surface-look.ts: rims, cores, flashes, the
// disk's end, the legend, a cell's and a range's words) and where a view's numbers come from (web/app/surface-source.ts:
// `chooseSource`, the in-place answer, the polls' pacing, a job's timeout). The window itself is
// tests/page-surface.test.ts's (Chromium).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CORE, FLASH, RIM } from '../web/app/ui/block-grid.ts';
import { cellWords, detailLook, detailWords, legendOf, lookOf, rangesOfCell, sizeText, stepOf } from '../web/app/surface-look.ts';
import { asInPlace, chooseSource, jobSource, pollDelay, type JobWorker } from '../web/app/surface-source.ts';
import { RANGE, UNIT, type InspectAnswer, type RangeDetail, type Surface, type SurfaceLayer } from '../web/surface.ts';
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
  const look = detailLook(d, false);
  assert.deepEqual([...look.rim.subarray(0, 9)], [RIM.step(4), RIM.step(4), RIM.empty, RIM.step(4), 0, 0, 0, 0, RIM.absent]);
  assert.deepEqual([...look.core.subarray(0, 8)], [0, 0, 0, 0, CORE.step(4), CORE.step(4), CORE.hollow, 0]);
  assert.equal(detailLook(d, true).rim[0], RIM.opaque, "an image's blocks");
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
  assert.equal((chooseSource({ disk: url.id }, url, undefined) as { job: { baseKind: string } }).job.baseKind, 'opaque');
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
  // Closed with an ask in flight: it ends at once, its worker too.
  const closing = jobSource(job, make(), 60_000);
  const pending = closing.surface(1);
  closing.close();
  assert.deepEqual(await pending, { kind: 'none' });
  assert.ok(made[2].ended);
});
