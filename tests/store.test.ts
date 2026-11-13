// The machines model (docs/machines.md §2, §5.1): web/app/shape.ts's shape and its hash, and
// web/app/store.ts's records, deletions, sweep and change notices, in Node over memory and in
// Chromium over IndexedDB and OPFS (the same flows, so the browser's backends are the ones tested).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium, type Browser } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { canonical, DEFAULT_MAC, generateName, isMac, MAX_ADAPTERS, MAX_DISKS, newId, newMac, serialOf, shapeHash, shapeOf, slots, uniqueName, type DiskRecord, type MachineRecord, type Shape } from '../web/app/shape.ts';
import { shapeDiff } from '../web/app/shape-diff.ts';
import { Store, type SnapshotRecord } from '../web/app/store.ts';
import { memoryFiles, memoryRecords } from '../web/app/store-backends.ts';
import { t, text } from '../web/i18n.ts';
import { words } from './words.ts';

/** What `shapeDiff` says, in the catalog's words. */
const diffWords = (...a: Parameters<typeof shapeDiff>) => shapeDiff(...a).map((m) => text(m));

const disk = (id: string, over: Partial<DiskRecord> = {}): DiskRecord => ({ id, kind: 'url', name: 'disk.qcow2', size: 8 * 2 ** 30, url: 'https://example.org/images/disk.qcow2', identity: { kind: 'url', path: '/images/disk.qcow2', bytes: 400e6 }, created: 0, ...over });
const machine = (over: Partial<MachineRecord> = {}): MachineRecord => ({
  id: 'aaaaaaaaaaaa', name: 'Brisk Heron', ncpus: 2, ramMiB: 1024, display: '3d', network: true, created: 0, modified: 0,
  attachments: [{ id: 'a00000000001', disk: 'd00000000001', readOnly: false, overlay: 'c00000000001' }, { id: 'a00000000002', disk: 'd00000000002', readOnly: false }],
  ...over,
});
const DISKS = new Map([disk('d00000000001'), disk('d00000000002', { kind: 'blank', name: 'Blank', size: 1 << 30, identity: { kind: 'blank', id: 'd00000000002', bytes: 1 << 30 } })].map((d) => [d.id, d])); // i18n-ignore: a name the test gives

test("the shape: the other devices first, then the disks; its hash is stable and moves with what the guest sees, only", async () => {
  const m = machine();
  const s = shapeOf(m, (id) => DISKS.get(id));
  assert.deepEqual(s.devices, ['rng', 'keyboard', 'tablet', 'net', 'gpu', 'snd', 'blk', 'blk', 'vsock']);
  assert.deepEqual(s.disks.map((d) => [d.slot, d.serial]), [[6, 'waarm64-a00000000001'], [7, 'waarm64-a00000000002']]);
  assert.ok(serialOf('a00000000001').length <= 20);
  // Pinned: a hash that moved means every kept snapshot is orphaned by an upgrade of the page (ABI 59's, 60's and 62's CPU
  // features moved it, on purpose: they're in the hash; so did the rename, through the disks' serials).
  const h = await shapeHash(s);
  assert.equal(h, '98d7992de26c133da8c4e7898c3bd9467f02be26e90f5b4dc7253ae79ea126c7');
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
  assert.deepEqual(diffWords(s, withUsb), [t('machines:shape-diff.usb.hadNo')]);
  assert.deepEqual(diffWords(withUsb, s), [t('machines:shape-diff.usb.had')]);
  // What the guest sees does.
  const moved: [string, MachineRecord, Map<string, DiskRecord>?][] = [
    ['RAM', machine({ ramMiB: 2048 }), undefined],
    ['vCPUs', machine({ ncpus: 4 }), undefined],
    ['display', machine({ display: '2d' }), undefined],
    ['network', machine({ network: false }), undefined],
    ['usb on', machine({ usb: true }), undefined],
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
  // A ramdisk as swap (web/app/guest-swap.ts) is in the shape, and said; the box on another kind of disk isn't.
  const RAM = new Map([...DISKS, ['d00000000002', disk('d00000000002', { kind: 'ramdisk', name: 'Ramdisk', size: 1 << 30, identity: { kind: 'ramdisk', id: 'd00000000002', bytes: 1 << 30 } })]]); // i18n-ignore: a name the test gives
  const noSwap = shapeOf(m, (id) => RAM.get(id));
  const swapM = machine({ attachments: [m.attachments[0], { ...m.attachments[1], swap: true }] });
  const withSwap = shapeOf(swapM, (id) => RAM.get(id));
  assert.equal(withSwap.disks[1].swap, true);
  assert.equal('swap' in noSwap.disks[1], false, 'left out when off');
  assert.notEqual(await shapeHash(withSwap), await shapeHash(noSwap), 'swap');
  assert.deepEqual(diffWords(noSwap, withSwap), [t('machines:shape-diff.disk.notSwapThen', { n: 2 })]);
  assert.deepEqual(diffWords(withSwap, noSwap), [t('machines:shape-diff.disk.swapThen', { n: 2 })]);
  assert.equal(await shapeHash(shapeOf(swapM, (id) => DISKS.get(id))), h, 'swap on a blank disk is nothing');
  assert.notEqual(await shapeHash(shapeOf(m, (id) => DISKS.get(id), { cpu: ['e0pd'] })), h, 'cpu features');
  // SHA3 came after shapes: with it or without, a machine's snapshots keep their hash.
  const noSha3 = shapeOf(m, (id) => DISKS.get(id), { cpu: ['rng', 'e0pd', 'jscvt', 'rcpc', 'sb', 'flagm', 'dit', 'frintts', 'dotprod', 'rdm', 'rcpc2'] });
  assert.deepEqual(s.cpu, ['rng', 'e0pd', 'sha3', 'jscvt', 'rcpc', 'sb', 'flagm', 'dit', 'frintts', 'dotprod', 'rdm', 'rcpc2']);
  assert.equal(await shapeHash(noSha3), h, 'sha3 left out of the hash');
  assert.deepEqual(diffWords(noSha3, s), []);
  // The features after it are in the hash (machines kept before them needn't match).
  for (const f of ['jscvt', 'rcpc', 'sb', 'flagm', 'dit', 'frintts', 'dotprod', 'rdm', 'rcpc2'] as const) {
    const without = shapeOf(m, (id) => DISKS.get(id), { cpu: s.cpu.filter((g) => g !== f) });
    assert.notEqual(await shapeHash(without), h, `${f} in the hash`);
  }
  // FEAT_I8MM is off by default (docs/cpu.md): a machine given it has another shape.
  assert.notEqual(await shapeHash(shapeOf(m, (id) => DISKS.get(id), { cpu: [...s.cpu, 'i8mm'] })), h, 'i8mm in the hash');
  assert.notEqual(await shapeHash(shapeOf(m, (id) => DISKS.get(id), { cpu: [...s.cpu, 'fcma'] })), h, 'fcma in the hash');
  assert.notEqual(await shapeHash(shapeOf(m, (id) => DISKS.get(id), { cpu: [...s.cpu, 'fp16'] })), h, 'fp16 in the hash');
  assert.notEqual(await shapeHash(shapeOf(m, (id) => DISKS.get(id), { cpu: [...s.cpu, 'bf16'] })), h, 'bf16 in the hash');
  assert.notEqual(await shapeHash(shapeOf(m, (id) => DISKS.get(id), { display: '2d' })), h, 'a 3D machine run in 2D');
  assert.deepEqual(diffWords(s, shapeOf(machine({ ramMiB: 2048 }), (id) => DISKS.get(id))), [t('machines:shape-diff.ram', { was: 1024, now: 2048 })]);
  assert.deepEqual(diffWords(s, s), []);
  // A split set by hand (spill memories, docs/spill-memories.md) moves it; the automatic one is no field at all.
  assert.equal('split' in s, false);
  const split = shapeOf(machine({ ramSplit: [512, 512] }), (id) => DISKS.get(id));
  assert.notEqual(await shapeHash(split), h, 'a split set by hand');
  assert.deepEqual(diffWords(s, split), [t('machines:shape-diff.split', { was: t('machines:shape-diff.split.automatic'), now: t('machines:shape-diff.split.sizes', { sizes: '512 + 512' }) })]);
  assert.throws(() => shapeOf(m, () => undefined), /isn't in this browser/); // i18n-ignore: the developer's Error
  assert.equal(slots({ nets: 0, display: 'none', attachments: new Array(MAX_DISKS) }).length, 5 + MAX_DISKS); // rng, keyboard, tablet, snd, the disks, vsock
});

test('shapes pinned: representative shapes\' hashes and what shapeDiff says of them both ways stay as they were', async () => {
  const m = machine();
  const of = (over: Partial<MachineRecord>, d = DISKS, opts?: Parameters<typeof shapeOf>[2]) => shapeOf(machine(over), (id) => d.get(id), opts);
  const base = of({});
  const RAM = new Map([...DISKS, ['d00000000002', disk('d00000000002', { kind: 'ramdisk', size: 1 << 30, identity: { kind: 'ramdisk', id: 'd00000000002', bytes: 1 << 30 } })]]);
  const files = new Map([...DISKS, ['d00000000001', disk('d00000000001', { kind: 'file', identity: { kind: 'file', name: 'x.img', bytes: 1 << 30, modified: 7 } })]]);
  const variants: Shape[] = [
    base,
    of({ ncpus: 4, ramMiB: 2048 }),
    of({ ramSplit: [512, 512] }),
    of({ display: '2d' }),
    of({ vulkan: true }),
    of({}, DISKS, { cpu: ['e0pd'] }),
    of({ network: undefined, adapters: [{ id: 'f00000000001', mac: '52:54:00:ab:cd:ef' }] }),
    of({ network: undefined, adapters: [{ id: 'f00000000001', mac: DEFAULT_MAC }, { id: 'f00000000002', mac: '52:54:00:ab:cd:ef' }] }),
    of({ usb: true, mouse: true, touch: true, clock: true, shares: true }),
    of({ attachments: [{ ...m.attachments[0], readOnly: true }, { ...m.attachments[1], id: 'a00000000003' }] }),
    of({ attachments: [m.attachments[0]] }),
    of({ attachments: [m.attachments[0], { ...m.attachments[1], swap: true }] }, RAM),
    of({}, files),
    of({}, new Map([...DISKS, ['d00000000002', { ...DISKS.get('d00000000002')!, size: 2 << 30 }]])),
    of({ jitMiB: 64 }),
    { ...base, version: 0 },
    { ...base, devices: [...base.devices].reverse() },
  ];
  const seen = await Promise.all(variants.map(async (v) => [await shapeHash(v), diffWords(base, v), diffWords(v, base)]));
  const digest = createHash('sha256').update(JSON.stringify(seen)).digest('hex');
  assert.equal(digest, '4be58e34e2d2fef0b4784d199008fbefdfad3080050cabef6bd48873e6ace8f8', 'the shapes\' hashes or their diffs moved');
});

test('network adapters in the shape: one at the default MAC is the card machines had before; more, or another MAC, move it', async () => {
  const of = (over: Partial<MachineRecord>) => shapeOf(machine(over), (id) => DISKS.get(id));
  const card = of({});
  const h = await shapeHash(card);
  // Machines made before adapters (`network`) and after (`adapters`) are the same machine to their snapshots.
  assert.equal(await shapeHash(of({ network: undefined, adapters: [{ id: 'f00000000001', mac: DEFAULT_MAC, connection: 'c00000000001' }] })), h, 'one adapter at the default MAC, attached or not');
  assert.equal(await shapeHash(of({ network: false })), await shapeHash(of({ network: undefined, adapters: [] })), 'no card, no adapters');
  assert.equal('macs' in card, false);
  const mac2 = '52:54:00:ab:cd:ef';
  const two = of({ network: undefined, adapters: [{ id: 'f00000000001', mac: DEFAULT_MAC }, { id: 'f00000000002', mac: mac2 }] });
  assert.deepEqual(two.devices, ['rng', 'keyboard', 'tablet', 'net', 'net', 'gpu', 'snd', 'blk', 'blk', 'vsock'], 'the adapters where the card was, in order');
  assert.deepEqual(two.macs, [DEFAULT_MAC, mac2]);
  assert.deepEqual(two.disks.map((d) => d.slot), [7, 8]);
  assert.deepEqual(diffWords(card, two), [t('machines:shape-diff.adapters', { was: 1, now: 2 })]);
  // Planted: a MAC left out of the hash would restore a snapshot onto adapters the guest doesn't know.
  const other = of({ network: undefined, adapters: [{ id: 'f00000000001', mac: mac2 }] });
  assert.notEqual(await shapeHash(other), h, 'another MAC');
  assert.deepEqual(diffWords(card, other), [`network adapter 1: MAC ${DEFAULT_MAC} then, ${mac2} now`]);
  const swapped = of({ network: undefined, adapters: [{ id: 'f00000000002', mac: mac2 }, { id: 'f00000000001', mac: DEFAULT_MAC }] });
  assert.notEqual(await shapeHash(swapped), await shapeHash(two), 'their order');
  assert.ok(shapeDiff(two, swapped).length > 0);
  // New MACs: QEMU's prefix, unicast and locally administered, none taken.
  const macs = new Set<string>([DEFAULT_MAC]);
  for (let i = 0; i < 50; i++) {
    const m = newMac(macs);
    assert.ok(isMac(m) && m.startsWith('52:54:00:') && !macs.has(m), m);
    macs.add(m);
  }
  assert.equal(isMac('53:54:00:12:34:56'), false, 'multicast');
  assert.equal(MAX_ADAPTERS, 4);
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
  const wrote: string[] = [];
  a.onWrite((c) => wrote.push(`${c.kind}:${c.id}${c.deleted ? ':deleted' : ''}`));
  const m = { id: 'aaaaaaaaaaaa', name: 'Brisk Heron', ncpus: 2, ramMiB: 1024, display: '3d' as const, network: true, created: 0, modified: 0, attachments: [{ id: 'a00000000001', disk: 'd00000000001', readOnly: false, overlay: 'c00000000001' }] };
  const d = { id: 'd00000000001', kind: 'url' as const, name: 'disk.qcow2', size: 1 << 30, identity: { kind: 'url' as const, path: '/disk.qcow2', bytes: 1 << 20 }, created: 0 };
  const o = { id: 'c00000000001', name: 'Changes', disk: d.id, identity: d.identity, generation: 0, bytes: 0, created: 0, modified: 0 }; // i18n-ignore: a name the test gives
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
  let refused: unknown;
  await b.deleteDisk(d.id).catch((e) => { refused = [(e as { msg?: unknown }).msg ?? String(e), (e as { cause?: { msg?: unknown } }).cause?.msg]; });
  await b.deleteMachine(m.id);
  const afterMachine = { snapshots: (await a.all('snapshots')).length, machineFiles: await a.files.size('machines/aaaaaaaaaaaa'), overlay: !!(await a.get('overlays', o.id)) };
  await b.deleteDisk(d.id);
  const afterDisk = { overlays: (await a.all('overlays')).length, files: await a.files.size('overlays/c00000000001'), disks: (await a.all('disks')).length };
  await new Promise((r) => setTimeout(r, 100)); // the channel delivers asynchronously
  a.close();
  b.close();
  return { swept, reread, sizes, refused, afterMachine, afterDisk, heard, wrote };
}

const expected = {
  swept: ['disks/d0000000000f', 'machines/aaaaaaaaaaaa/snapshots/b0000000000f', 'machines/bbbbbbbbbbbb', 'overlays/c0000000000f'],
  reread: { machines: ['Brisk Heron'], overlays: ['c00000000001'], users: ['aaaaaaaaaaaa'], snapshots: ['b00000000001'] },
  sizes: { overlay: 5120, machine: (1 << 20) + 100, transient: 4096 },
  refused: [{ key: 'machines:store.diskAttached' }, { key: 'machines:store.diskAttached.cause', params: { machines: ['Brisk Heron'] } }],
  afterMachine: { snapshots: 0, machineFiles: 0, overlay: true },
  afterDisk: { overlays: 0, files: 0, disks: 0 },
  // `a`'s puts and `b`'s deletions: `b` hears only what another store did.
  heard: ['disks:d00000000001', 'overlays:c00000000001', 'machines:aaaaaaaaaaaa', 'snapshots:b00000000001'],
  // `a` hears its own writes (the page's records follow them), not `b`'s.
  wrote: ['disks:d00000000001', 'overlays:c00000000001', 'machines:aaaaaaaaaaaa', 'snapshots:b00000000001'],
};

test('the store over memory: records after bytes, the sweep of what a crash left, deletions in order, another tab hears the changes', async () => {
  const r = await storeFlows(async () => {
    const [records, files] = [memoryRecords(), memoryFiles()];
    const channel = `waarm64-store-test-${Math.random()}`;
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
    const { Store } = await import('/web/app/store.ts' as string);
    const { idbRecords, opfsFiles } = await import('/web/app/store-backends.ts' as string);
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
    await a.put('overlays', { id: 'c00000000002', name: 'Changes', disk: 'd00000000001', identity: { kind: 'blank', id: 'd00000000001', bytes: 4096 }, generation: 0, bytes: 4096, created: 0, modified: 0 }); // i18n-ignore: a name the test gives
  });
  await new Promise((r) => setTimeout(r, 10));
  const swept = b.sweep();
  await new Promise((r) => setTimeout(r, 50));
  recorded();
  await writer;
  assert.deepEqual(await swept, []);
  assert.deepEqual(files.paths(), ['overlays/c00000000002/data']);
});

test('network adapters on the Machines page: added up to the limit, removed; copies and definitions carry the MACs, no connections', async () => {
  const { createMachine, duplicateMachine, movedAdapter, withAdapter, withoutAdapter } = await import('../web/app/machines.ts');
  const { exportDefinition, importDefinition, parseDefinition } = await import('../web/app/definitions.ts');
  const { adaptersOf } = await import('../web/app/shape.ts');
  const store = new Store(memoryRecords(), memoryFiles(), { channel: false });
  const m = await createMachine(store, { name: 'Net' });
  // One adapter, with a MAC of its own: two machines on one network (the local helper's switch) must differ.
  const [mac] = adaptersOf(m).map((a) => a.mac);
  assert.equal(adaptersOf(m).length, 1);
  assert.ok(isMac(mac) && mac !== DEFAULT_MAC, mac);
  assert.notEqual(adaptersOf(await createMachine(store, { name: 'Net 2' }))[0].mac, mac, "another new machine's MAC");
  assert.deepEqual(adaptersOf(await createMachine(store, { network: false })), []);
  const bare = await createMachine(store, { network: false });
  const first = adaptersOf(withAdapter(bare))[0].mac;
  assert.ok(isMac(first) && first !== DEFAULT_MAC, `the first adapter added: ${first}`);
  let x = m;
  for (let i = 0; i < 6; i++) x = withAdapter(x);
  assert.equal(adaptersOf(x).length, MAX_ADAPTERS);
  assert.equal(new Set(adaptersOf(x).map((a) => a.mac)).size, MAX_ADAPTERS, 'each its own MAC');
  x = withoutAdapter(x, adaptersOf(x)[1].id);
  assert.equal(adaptersOf(x).length, MAX_ADAPTERS - 1);
  x.adapters![0].connection = 'c00000000001';
  // Moved: the MAC and the connection go with the adapter; the ends stay where they are, and the order is the shape's.
  const order = adaptersOf(x).map((a) => a.id);
  const moved = movedAdapter(x, order[0], 1);
  assert.deepEqual(adaptersOf(moved).map((a) => a.id), [order[1], order[0], order[2]]);
  assert.equal(adaptersOf(moved)[1].connection, 'c00000000001');
  assert.deepEqual(adaptersOf(movedAdapter(x, order[0], -1)).map((a) => a.id), order);
  assert.deepEqual(adaptersOf(movedAdapter(x, order[2], 1)).map((a) => a.id), order);
  assert.notEqual(await shapeHash(shapeOf(moved, () => undefined)), await shapeHash(shapeOf(x, () => undefined)), 'the guest sees eth0 and eth1 change');
  await store.put('machines', x);
  const copy = await duplicateMachine(store, x.id);
  assert.deepEqual(adaptersOf(copy).map((a) => a.mac), adaptersOf(x).map((a) => a.mac));
  assert.ok(adaptersOf(copy).every((a) => !a.connection), 'a copy has no connections (one machine at a time has one)');
  const def = await exportDefinition(store, x.id);
  assert.deepEqual(def.machine.macs, adaptersOf(x).map((a) => a.mac));
  assert.equal(JSON.stringify(def).includes('c00000000001'), false, 'no connection travels');
  const back = await importDefinition(store, parseDefinition(JSON.stringify(def)));
  assert.deepEqual(adaptersOf(back.machine).map((a) => [a.mac, a.connection]), adaptersOf(x).map((a) => [a.mac, undefined]));
  // One adapter at the default MAC is written as definitions were before adapters, and such a definition reads back as it.
  const made = await createMachine(store, { name: 'Plain' }); // made before new machines had MACs of their own
  await store.put('machines', { ...made, adapters: [{ ...adaptersOf(made)[0], mac: DEFAULT_MAC }] });
  const plain = await exportDefinition(store, made.id);
  assert.deepEqual([plain.machine.network, 'macs' in plain.machine], [true, false]);
  assert.deepEqual(adaptersOf((await importDefinition(store, plain)).machine).map((a) => a.mac), [DEFAULT_MAC]);
  for (const macs of [[], ['53:54:00:00:00:01'], ['nope'], new Array(MAX_ADAPTERS + 1).fill(DEFAULT_MAC)]) {
    assert.throws(() => parseDefinition(JSON.stringify({ ...def, machine: { ...def.machine, macs } })), /damaged/, JSON.stringify(macs));
  }
});

test("guest RAM past memory 0: the page's split, its note, and a split set by hand in a definition", async () => {
  const { MEMORY0_MIB, numaNote, ramSplitError, ramSplitMiB } = await import('../web/app/machine.ts');
  const { createMachine } = await import('../web/app/machines.ts');
  const { exportDefinition, importDefinition, parseDefinition } = await import('../web/app/definitions.ts');
  assert.equal(MEMORY0_MIB, 3071);
  assert.deepEqual(ramSplitMiB(2560), [2560]);
  assert.deepEqual(ramSplitMiB(16384), [3071, 4096, 4096, 4096, 1025]);
  assert.deepEqual(ramSplitMiB(2048, [1024, 1024]), [1024, 1024]);
  assert.equal(numaNote(2560), undefined);
  // With Vulkan, memory 0 is as without; memory 1 holds Venus's arena and window before node 1 (as web/app/worker.ts
  // splits it), so node 1 is smaller.
  assert.equal(numaNote(3071, undefined, true), undefined);
  assert.deepEqual(ramSplitMiB(4096, undefined, true), [3071, 1025]);
  assert.deepEqual(ramSplitMiB(8192, undefined, true), [3071, 1536, 3585]);
  assert.equal(text(numaNote(4096, undefined, true)!), t('machines:machine.numa', { count: 1, fast: 3071, rest: 1025 }));
  assert.equal(ramSplitError([1024, 1536], true), undefined);
  assert.match(text(ramSplitError([1024, 1537], true)!), words('machines:machine.split.vulkan', { max: 1536 }, { whole: true }));
  assert.equal(text(numaNote(4096)!), t('machines:machine.numa', { count: 1, fast: 3071, rest: 1025 }));
  assert.match(text(numaNote(8192)!), words('machines:machine.numa', { count: 2 }, { whole: true }));
  assert.match(text(numaNote(2048, [1024, 1024])!), words('machines:machine.numa', { count: 1, rest: 1024 }, { whole: true }));
  assert.equal(ramSplitError([1024, 1024]), undefined);
  assert.match(text(ramSplitError([3072])!), words('machines:machine.split.memory0Max', { max: 3071 }, { whole: true }));
  assert.match(text(ramSplitError([1024.5])!), words('machines:machine.split.whole', {}, { whole: true }));
  const store = new Store(memoryRecords(), memoryFiles(), { channel: false });
  const m = { ...(await createMachine(store, { name: 'Numa', ramMiB: 3072 })), ramSplit: [2048, 1024] };
  await store.put('machines', m);
  const def = await exportDefinition(store, m.id);
  assert.deepEqual(def.machine.ramSplit, [2048, 1024]);
  assert.deepEqual((await importDefinition(store, parseDefinition(JSON.stringify(def)))).machine.ramSplit, [2048, 1024]);
  assert.equal('ramSplit' in (await exportDefinition(store, (await createMachine(store, {})).id)).machine, false);
  for (const ramSplit of [[2048, 512], [3072, 0], [4096], 'no']) {
    assert.throws(() => parseDefinition(JSON.stringify({ ...def, machine: { ...def.machine, ramSplit } })), /damaged/, JSON.stringify(ramSplit));
  }
  // A split is checked with Vulkan's renderer and window in memory 1 when the definition has Vulkan (it couldn't boot).
  const big = { ...def, machine: { ...def.machine, ramMiB: 7167, ramSplit: [3071, 4096] } };
  assert.deepEqual(parseDefinition(JSON.stringify(big)).machine.ramSplit, [3071, 4096]);
  assert.throws(() => parseDefinition(JSON.stringify({ ...big, machine: { ...big.machine, display: '3d', vulkan: true } })), /damaged/);
  assert.ok(parseDefinition(JSON.stringify({ ...big, machine: { ...big.machine, ramMiB: 4607, ramSplit: [3071, 1536], display: '3d', vulkan: true } })));
});

test("a machine's JIT budget: carried by its shape and its definition, outside the shape's hash, counted by the memory rule; its keyboard layout and network settings by its definition", async () => {
  const { hostMemoryGiB, jitHostGiB, JIT_DEFAULT_MIB } = await import('../web/app/machine.ts');
  const { createMachine, updateMachine } = await import('../web/app/machines.ts');
  const { exportDefinition, importDefinition, parseDefinition } = await import('../web/app/definitions.ts');
  const store = new Store(memoryRecords(), memoryFiles(), { channel: false });
  const m = await createMachine(store, { name: 'Jit' });
  const s = shapeOf(m, () => undefined);
  assert.equal('jitMiB' in s, false, 'unset: no field');
  const set = shapeOf({ ...m, jitMiB: 128 }, () => undefined);
  assert.equal(set.jitMiB, 128);
  assert.equal(await shapeHash(set), await shapeHash(s), 'the guest does not see it: no snapshot is orphaned');
  assert.deepEqual(diffWords(s, set), []);
  const plain = await createMachine(store, { name: 'Plain' });
  const saved = await updateMachine(store, { ...m, jitMiB: 128 });
  const def = await exportDefinition(store, saved.id);
  assert.equal(def.machine.jitMiB, 128);
  assert.equal((await importDefinition(store, parseDefinition(JSON.stringify(def)))).machine.jitMiB, 128);
  assert.equal('jitMiB' in (await exportDefinition(store, plain.id)).machine, false);
  for (const jitMiB of [0, -5, 1.5, 'big']) assert.throws(() => parseDefinition(JSON.stringify({ ...def, machine: { ...def.machine, jitMiB } })), /damaged/, String(jitMiB));
  // The keyboard layout likewise: in the record and its definition, not in the shape; an unknown one is refused.
  assert.equal('keyboard' in shapeOf({ ...m, keyboard: 'pt' }, () => undefined), false);
  const kbd = await exportDefinition(store, (await updateMachine(store, { ...saved, keyboard: 'pt' })).id);
  assert.equal(kbd.machine.keyboard, 'pt');
  assert.equal((await importDefinition(store, parseDefinition(JSON.stringify(kbd)))).machine.keyboard, 'pt');
  // A new machine follows the browser (web/app/keyboard.ts FOLLOW_BROWSER), and its definition says so; one set to none carries no field.
  assert.equal(plain.keyboard, 'browser');
  const follows = await exportDefinition(store, plain.id);
  assert.equal(follows.machine.keyboard, 'browser');
  assert.equal((await importDefinition(store, parseDefinition(JSON.stringify(follows)))).machine.keyboard, 'browser');
  assert.equal('keyboard' in (await exportDefinition(store, (await updateMachine(store, { ...plain, keyboard: undefined })).id)).machine, false);
  for (const keyboard of ['xx', 7, '']) assert.throws(() => parseDefinition(JSON.stringify({ ...kbd, machine: { ...kbd.machine, keyboard } })), /damaged/, String(keyboard));
  // The network's settings in the guest (web/app/guest-net.ts): on unless false; only off travels, outside the shape.
  assert.equal('netConfig' in plain, false);
  assert.equal('netConfig' in shapeOf({ ...m, netConfig: false }, () => undefined), false);
  assert.equal('netConfig' in follows.machine, false);
  const off = await exportDefinition(store, (await updateMachine(store, { ...plain, netConfig: false })).id);
  assert.equal(off.machine.netConfig, false);
  assert.equal((await importDefinition(store, parseDefinition(JSON.stringify(off)))).machine.netConfig, false);
  for (const netConfig of [true, 0, 'no']) assert.throws(() => parseDefinition(JSON.stringify({ ...off, machine: { ...off.machine, netConfig } })), /damaged/, String(netConfig));
  // The rule: 160 MiB is what it was measured with; the default (320) adds 0.625 GiB; smaller saves at most 0.25.
  assert.equal(jitHostGiB(160), 0);
  assert.equal(JIT_DEFAULT_MIB, 320);
  assert.equal(hostMemoryGiB(1024, 4), hostMemoryGiB(1024, 4, 160) + 0.625);
  assert.equal(jitHostGiB(16), -0.25);
});

test("Make a machine like it: a swap ramdisk in the snapshot's shape comes back as one, made again under its id", async () => {
  const { machineLike } = await import('../web/app/snapshots.ts');
  const store = new Store(memoryRecords(), memoryFiles(), { channel: false });
  const ram = disk('d00000000002', { kind: 'ramdisk', name: 'Ramdisk', size: 64 << 20, identity: { kind: 'ramdisk', id: 'd00000000002', bytes: 64 << 20 } }); // i18n-ignore: a name the test gives
  const was = machine({ attachments: [machine().attachments[0], { id: 'a00000000002', disk: ram.id, readOnly: false, swap: true }] });
  const shape = shapeOf(was, (id) => (id === ram.id ? ram : DISKS.get(id)));
  await store.put('disks', DISKS.get('d00000000001')!); // the URL disk is still in the browser; the ramdisk isn't
  const like = await machineLike(store, { id: 'b00000000001', machine: was.id, name: 'Snap', shape });
  assert.deepEqual(like.attachments.map((a) => [a.disk, !!a.swap]), [['d00000000001', false], [ram.id, true]]);
  assert.equal((await store.get('disks', ram.id))?.kind, 'ramdisk');
  const disks = new Map((await store.all('disks')).map((d) => [d.id, d]));
  assert.equal(await shapeHash(shapeOf(like, (id) => disks.get(id))), await shapeHash(shape), "the snapshot's shape");
});

test("a machine's Vulkan setting: in its shape (with 3D only) and its definition; off leaves the shape as it was", async () => {
  const { createMachine, updateMachine } = await import('../web/app/machines.ts');
  const { exportDefinition, importDefinition, parseDefinition } = await import('../web/app/definitions.ts');
  const store = new Store(memoryRecords(), memoryFiles(), { channel: false });
  const m = await createMachine(store, { name: 'Vk' });
  const s = shapeOf(m, () => undefined);
  assert.equal('vulkan' in s, false, 'off: no field');
  assert.equal(await shapeHash(shapeOf({ ...m, vulkan: false }, () => undefined)), await shapeHash(s));
  const on = shapeOf({ ...m, vulkan: true }, () => undefined);
  assert.equal(on.vulkan, true);
  assert.notEqual(await shapeHash(on), await shapeHash(s), 'the guest sees it');
  assert.deepEqual(diffWords(s, on), [t('machines:shape-diff.vulkan.hadNo')]);
  assert.deepEqual(diffWords(on, s), [t('machines:shape-diff.vulkan.had')]);
  // Only beside 3D: a 2D machine, or a 3D one run in 2D, has none; the page's `?gpu=vulkan` gives a 3D one Vulkan.
  assert.equal('vulkan' in shapeOf({ ...m, display: '2d', vulkan: true }, () => undefined), false);
  assert.equal('vulkan' in shapeOf({ ...m, vulkan: true }, () => undefined, { display: '2d' }), false);
  assert.equal(shapeOf(m, () => undefined, { vulkan: true }).vulkan, true);
  // Saving it needs the machine off (a shape change), and its definition carries it.
  const saved = await updateMachine(store, { ...m, vulkan: true });
  const def = await exportDefinition(store, saved.id);
  assert.equal(def.machine.vulkan, true);
  assert.equal((await importDefinition(store, parseDefinition(JSON.stringify(def)))).machine.vulkan, true);
  assert.equal('vulkan' in (await exportDefinition(store, (await updateMachine(store, { ...saved, vulkan: false })).id)).machine, false);
  assert.throws(() => parseDefinition(JSON.stringify({ ...def, machine: { ...def.machine, vulkan: 'yes' } })), /damaged/);
});

test('the shape: the notify socket (vsock) on every machine, after the disks, out of the hash: a shape without it is the same machine', async () => {
  const s = shapeOf(machine(), (id) => DISKS.get(id));
  assert.equal(s.devices.at(-1), 'vsock');
  assert.deepEqual(s.disks.map((d) => d.slot), [6, 7], 'the disks where they were');
  const before = { ...s, devices: s.devices.filter((k) => k !== 'vsock') };
  assert.equal(await shapeHash(before), await shapeHash(s));
  assert.deepEqual(diffWords(before, s), []);
  assert.deepEqual(slots({ nets: 1, attachments: [0], vsock: false }).map((x) => x.kind), ['rng', 'keyboard', 'tablet', 'net', 'gpu', 'snd', 'blk']);
});

test('the shape: the guest agent and clipboard sharing leave it alone (over the vsock every firmware machine has); a snapshot from before, with the agent\'s console, is said', async () => {
  const s = shapeOf(machine(), (id) => DISKS.get(id));
  const h = await shapeHash(s);
  for (const m of [machine({ clipboard: true }), machine({ agent: false }), machine({ agent: false, clipboard: true })])
    assert.equal(await shapeHash(shapeOf(m, (id) => DISKS.get(id))), h);
  assert.deepEqual(s.devices, ['rng', 'keyboard', 'tablet', 'net', 'gpu', 'snd', 'blk', 'blk', 'vsock']);
  // The agent's virtio-console, before vsock (2026-11-13): an old snapshot's shape says it had clipboard sharing.
  const old = { ...s, devices: ['rng', 'keyboard', 'tablet', 'net', 'gpu', 'snd', 'agent', 'blk', 'blk', 'vsock'] } as unknown as typeof s;
  assert.deepEqual(diffWords(old, s), [t('machines:shape-diff.clipboard.had')]);
});
