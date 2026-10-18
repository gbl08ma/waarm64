// The machines model (docs/plans/machines.md §2, §5.1): web/app/shape.ts's shape and its hash, and
// web/app/store.ts's records, deletions, sweep and change notices, in Node over memory and in
// Chromium over IndexedDB and OPFS (the same flows, so the browser's backends are the ones tested).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, type Browser } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { canonical, generateName, MAX_DISKS, newId, serialOf, shapeDiff, shapeHash, shapeOf, slots, uniqueName, type DiskRecord, type MachineRecord } from '../web/app/shape.ts';
import { memoryFiles, memoryRecords, Store, type SnapshotRecord } from '../web/app/store.ts';

const disk = (id: string, over: Partial<DiskRecord> = {}): DiskRecord => ({ id, kind: 'url', name: 'disk.qcow2', size: 8 * 2 ** 30, url: 'https://example.org/images/disk.qcow2', identity: { kind: 'url', path: '/images/disk.qcow2', bytes: 400e6 }, created: 0, ...over });
const machine = (over: Partial<MachineRecord> = {}): MachineRecord => ({
  id: 'aaaaaaaaaaaa', name: 'Brisk Heron', ncpus: 2, ramMiB: 1024, display: '3d', network: true, created: 0, modified: 0,
  attachments: [{ id: 'a00000000001', disk: 'd00000000001', readOnly: false, overlay: 'c00000000001' }, { id: 'a00000000002', disk: 'd00000000002', readOnly: false }],
  ...over,
});
const DISKS = new Map([disk('d00000000001'), disk('d00000000002', { kind: 'blank', name: 'Blank', size: 1 << 30, identity: { kind: 'blank', id: 'd00000000002', bytes: 1 << 30 } })].map((d) => [d.id, d]));

test("the shape: the other devices first, then the disks; its hash is stable and moves with what the guest sees, only", async () => {
  const m = machine();
  const s = shapeOf(m, (id) => DISKS.get(id));
  assert.deepEqual(s.devices, ['rng', 'keyboard', 'tablet', 'net', 'gpu', 'snd', 'blk', 'blk']);
  assert.deepEqual(s.disks.map((d) => [d.slot, d.serial]), [[6, 'webpc-a00000000001'], [7, 'webpc-a00000000002']]);
  assert.ok(serialOf('a00000000001').length <= 20);
  // Pinned: a hash that moved means every kept snapshot is orphaned by an upgrade of the page.
  const h = await shapeHash(s);
  assert.equal(h, '171998f85a623541b707c5a8e007d1d3908695d3c6566ebb3b2b67e65a196fbf');
  assert.equal(canonical({ b: 1, a: [2, { d: undefined, c: 3 }] }), '{"a":[2,{"c":3}],"b":1}');
  // Key order and what the guest can't see (names, the chosen overlay, in place, dates) don't move it.
  const same = machine({ name: 'Other', modified: 5, attachments: m.attachments.map((a) => ({ ...a, overlay: 'c00000000009', inPlace: true })) });
  assert.equal(await shapeHash(shapeOf(same, (id) => DISKS.get(id))), h);
  const reverse = (v: unknown): unknown => (Array.isArray(v) ? v.map(reverse) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverse(x)])) : v);
  const reordered = reverse(s) as typeof s;
  assert.notEqual(JSON.stringify(reordered), JSON.stringify(s));
  assert.equal(await shapeHash(reordered), h);
  // A USB controller turned off (or never there: every machine made before USB) leaves the shape and its hash as they
  // were; remembered USB devices are hot-plugged, not in the shape (docs/usb.md "The page").
  const usbDevices = [{ id: 'e00000000001', api: 'usb' as const, vendorId: 0x1d50, productId: 0x6018, serialNumber: 'A1', connector: 0, atStart: true }];
  for (const [what, x] of [['usb off', machine({ usb: false })], ['remembered devices', machine({ usbDevices })], ['both', machine({ usb: false, usbDevices })]] as const) {
    assert.equal(await shapeHash(shapeOf(x, (id) => DISKS.get(id))), h, what);
    assert.equal('usb' in shapeOf(x, (id) => DISKS.get(id)), false, `${what}: no usb key`);
  }
  const withUsb = shapeOf(machine({ usb: true, usbDevices }), (id) => DISKS.get(id));
  assert.equal(withUsb.usb, true);
  assert.equal(await shapeHash(withUsb), await shapeHash(shapeOf(machine({ usb: true }), (id) => DISKS.get(id))), 'devices aren\'t in the shape');
  assert.deepEqual(shapeDiff(s, withUsb), ['it had no USB controller']);
  assert.deepEqual(shapeDiff(withUsb, s), ['it had a USB controller']);
  // What the guest sees does.
  const moved: [string, MachineRecord, Map<string, DiskRecord>?][] = [
    ['RAM', machine({ ramMiB: 2048 }), undefined],
    ['vCPUs', machine({ ncpus: 4 }), undefined],
    ['display', machine({ display: '2d' }), undefined],
    ['network', machine({ network: false }), undefined],
    ['USB controller', machine({ usb: true }), undefined],
    ['read-only', machine({ attachments: [{ ...m.attachments[0], readOnly: true }, m.attachments[1]] }), undefined],
    ['order', machine({ attachments: [m.attachments[1], m.attachments[0]] }), undefined],
    ['detached', machine({ attachments: [m.attachments[0]] }), undefined],
    ['attached anew', machine({ attachments: [m.attachments[0], { ...m.attachments[1], id: 'a00000000003' }] }), undefined],
    ['another image', m, new Map([...DISKS, ['d00000000001', disk('d00000000001', { identity: { kind: 'url', path: '/images/other.qcow2', bytes: 400e6 } })]])],
    ['size', m, new Map([...DISKS, ['d00000000002', { ...DISKS.get('d00000000002')!, size: 2 << 30 }]])],
  ];
  for (const [what, mm, dd] of moved) {
    const t = shapeOf(mm, (id) => (dd ?? DISKS).get(id));
    assert.notEqual(await shapeHash(t), h, what);
    assert.ok(shapeDiff(s, t).length > 0, `${what} is said`);
  }
  assert.notEqual(await shapeHash(shapeOf(m, (id) => DISKS.get(id), { cpu: ['e0pd'] })), h, 'cpu features');
  assert.notEqual(await shapeHash(shapeOf(m, (id) => DISKS.get(id), { display: '2d' })), h, 'a 3D machine run in 2D');
  assert.deepEqual(shapeDiff(s, shapeOf(machine({ ramMiB: 2048 }), (id) => DISKS.get(id))), ['memory: 1024 MiB then, 2048 MiB now']);
  assert.deepEqual(shapeDiff(s, s), []);
  assert.throws(() => shapeOf(m, () => undefined), /isn't in this browser/);
  assert.equal(slots({ network: false, display: 'none', attachments: new Array(MAX_DISKS) }).length, 4 + MAX_DISKS);
});

test('ids, generated names and unique names', () => {
  assert.match(newId(), /^[0-9a-f]{12}$/);
  assert.notEqual(newId(), newId());
  const names = new Set<string>();
  for (let i = 0; i < 100; i++) names.add(generateName(names));
  assert.equal(names.size, 100);
  assert.equal(uniqueName('Debian', []), 'Debian');
  assert.equal(uniqueName('Debian', ['Debian', 'Debian (2)']), 'Debian (3)');
  assert.equal(uniqueName('Debian (2)', ['Debian', 'Debian (2)']), 'Debian (3)');
});

/** The store's flows over `make()`'s stores (two on the same backends and channel: two tabs), as a function the browser runs too (its source: it uses nothing from this module). */
async function storeFlows(make: () => Promise<{ a: Store; b: Store; write(path: string, bytes: number): Promise<void> }>) {
  const { a, b, write } = await make();
  const heard: string[] = [];
  b.onChange((c) => heard.push(`${c.kind}:${c.id}${c.deleted ? ':deleted' : ''}`));
  const m = { id: 'aaaaaaaaaaaa', name: 'Brisk Heron', ncpus: 2, ramMiB: 1024, display: '3d' as const, network: true, created: 0, modified: 0, attachments: [{ id: 'a00000000001', disk: 'd00000000001', readOnly: false, overlay: 'c00000000001' }] };
  const d = { id: 'd00000000001', kind: 'url' as const, name: 'disk.qcow2', size: 1 << 30, identity: { kind: 'url' as const, path: '/disk.qcow2', bytes: 1 << 20 }, created: 0 };
  const o = { id: 'c00000000001', name: 'Changes', disk: d.id, identity: d.identity, generation: 0, bytes: 0, created: 0, modified: 0 };
  // Bytes first, then the record (inside `writing`, which the sweep waits for).
  await a.writing(async () => {
    await write('overlays/c00000000001/data', 4096);
    await write('overlays/c00000000001/map', 1024);
    await a.put('disks', d);
    await a.put('overlays', o);
    await a.put('machines', m);
  });
  const snap = (id: string) => ({ id, machine: m.id, name: id, created: 0, bytes: 100, shape: { version: 1, ncpus: 2, ramMiB: 1024, display: '3d' as const, cpu: [], devices: [], disks: [] }, shapeHash: 'x', pins: [] }) satisfies SnapshotRecord;
  await write(`machines/${m.id}/snapshots/b00000000001`, 100);
  await a.put('snapshots', snap('b00000000001'));
  await write('machines/aaaaaaaaaaaa/flash', 1 << 20);
  // A crash between bytes and record: an overlay, a disk, a machine and a snapshot without one.
  await write('overlays/c0000000000f/data', 4096);
  await write('disks/d0000000000f/data', 4096);
  await write('machines/bbbbbbbbbbbb/flash', 1 << 20);
  await write(`machines/${m.id}/snapshots/b0000000000f`, 100);
  // A transient machine's files (named otherwise) are never the sweep's.
  await write('overlays/t-debian/data', 4096);
  const swept = (await b.sweep()).sort();
  const reread = { machines: (await b.all('machines')).map((r) => r.name), overlays: (await b.overlaysOf(d.id)).map((r) => r.id), users: (await b.machinesWith(d.id)).map((r) => r.id), snapshots: (await b.snapshotsOf(m.id)).map((r) => r.id) };
  const sizes = { overlay: await b.files.size('overlays/c00000000001'), machine: await b.files.size('machines/aaaaaaaaaaaa'), transient: await b.files.size('overlays/t-debian') };
  let refused = '';
  await b.deleteDisk(d.id).catch((e) => { refused = String(e); });
  await b.deleteMachine(m.id);
  const afterMachine = { snapshots: (await a.all('snapshots')).length, machineFiles: await a.files.size('machines/aaaaaaaaaaaa'), overlay: !!(await a.get('overlays', o.id)) };
  await b.deleteDisk(d.id);
  const afterDisk = { overlays: (await a.all('overlays')).length, files: await a.files.size('overlays/c00000000001'), disks: (await a.all('disks')).length };
  await new Promise((r) => setTimeout(r, 100)); // the channel delivers asynchronously
  a.close();
  b.close();
  return { swept, reread, sizes, refused, afterMachine, afterDisk, heard };
}

const expected = {
  swept: ['disks/d0000000000f', 'machines/aaaaaaaaaaaa/snapshots/b0000000000f', 'machines/bbbbbbbbbbbb', 'overlays/c0000000000f'],
  reread: { machines: ['Brisk Heron'], overlays: ['c00000000001'], users: ['aaaaaaaaaaaa'], snapshots: ['b00000000001'] },
  sizes: { overlay: 5120, machine: (1 << 20) + 100, transient: 4096 },
  refused: 'Error: the disk is attached to Brisk Heron: detach it first',
  afterMachine: { snapshots: 0, machineFiles: 0, overlay: true },
  afterDisk: { overlays: 0, files: 0, disks: 0 },
  // `a`'s puts and `b`'s deletions: `b` hears only what another store did.
  heard: ['disks:d00000000001', 'overlays:c00000000001', 'machines:aaaaaaaaaaaa', 'snapshots:b00000000001'],
};

test('the store over memory: records after bytes, the sweep of what a crash left, deletions in order, another tab hears the changes', async () => {
  const r = await storeFlows(async () => {
    const [records, files] = [memoryRecords(), memoryFiles()];
    const channel = `webpc-store-test-${Math.random()}`;
    return { a: new Store(records, files, { channel }), b: new Store(records, files, { channel }), write: async (p, n) => files.write(p, n) };
  });
  assert.deepEqual(r, expected);
});

let browser: Browser | undefined;
let base = '';
let close = () => {};
before(async () => {
  const server = await startServer();
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
});
after(async () => { await browser?.close(); close(); });

test('the store in Chromium: IndexedDB and OPFS, two tabs', async () => {
  const context = await browser!.newContext();
  const page = await context.newPage();
  await page.goto(`${base}/tests/browser/core.html`);
  const flows = storeFlows.toString();
  const r = await page.evaluate(async (src) => {
    const { Store, idbRecords, opfsFiles } = await import('/web/app/store.ts' as string);
    const root = await navigator.storage.getDirectory();
    const write = async (path: string, bytes: number) => {
      const parts = path.split('/');
      let d = root;
      for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
      const w = await (await d.getFileHandle(parts.at(-1)!, { create: true })).createWritable();
      await w.write(new Uint8Array(bytes));
      await w.close();
    };
    // eslint-disable-next-line no-new-func
    const run = new Function(`return (${src})`)();
    return run(async () => ({ a: new Store(await idbRecords(), opfsFiles(root)), b: new Store(await idbRecords(), opfsFiles(root)), write }));
  }, flows);
  await context.close();
  assert.deepEqual(r, expected);
});

test("the sweep waits for a writer between its bytes and its record (another tab's, through the lock)", async () => {
  const [records, files] = [memoryRecords(), memoryFiles()];
  const [a, b] = [new Store(records, files, { channel: false }), new Store(records, files, { channel: false })];
  let recorded!: () => void;
  const gate = new Promise<void>((r) => { recorded = r; });
  const writer = a.writing(async () => {
    files.write('overlays/c00000000002/data', 4096);
    await gate;
    await a.put('overlays', { id: 'c00000000002', name: 'Changes', disk: 'd00000000001', identity: { kind: 'blank', id: 'd00000000001', bytes: 4096 }, generation: 0, bytes: 4096, created: 0, modified: 0 });
  });
  await new Promise((r) => setTimeout(r, 10));
  const swept = b.sweep();
  await new Promise((r) => setTimeout(r, 50));
  recorded();
  await writer;
  assert.deepEqual(await swept, []);
  assert.deepEqual(files.paths(), ['overlays/c00000000002/data']);
});
