// Snapshots of machines as the unit (docs/machines.md §5), in Node on a bare-metal guest (no image needed):
// a snapshot pins each overlay's generation and moves it on for the next change; a ramdisk's blocks are in the file
// (a suspended machine's too); a restore keeps an overlay at its pinned generation, or writes the file's blocks into
// another one (a fork), never into the one it pins unless asked (the default, a replace); a swap ramdisk's first page.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import type { DeviceSpec } from '../web/devices.ts';
import { lzCodec } from '../web/lz.ts';
import { openOverlay, overlay, overlayMeta } from '../web/overlay.ts';
import { swapHeader } from '../web/ramdisk.ts';
import { readSnapshot, writeSnapshot } from '../web/snapshot.ts';
import { SnapshotError } from '../web/snapshot-file.ts';
import { bootVm, compileCore, type BootOptions } from '../web/vm.ts';

const WASM = readFileSync(new URL('../target/wasm32-unknown-unknown/release/waarm64_core.wasm', import.meta.url));
const KERNEL = readFileSync(new URL('baremetal/uart.bin', import.meta.url));
const SIZE = 1 << 20;
const zeroBase = { size: SIZE, format: 'raw' as const, read: async (_o: number, len: number) => new Uint8Array(len) };

/** Writes `fill` into blocks `blocks` of overlay `name` (as a machine would have). */
async function scribble(name: string, blocks: number[], fill: number) {
  const f = await openOverlay(name, 'test-disk');
  const d = overlay(zeroBase, f.data, f.map, f.meta);
  for (const b of blocks) assert.ok(await d.write(b * 4096, new Uint8Array(4096).fill(fill)));
  f.close();
}
/** Overlay `name`'s bytes at block `b` (its first byte), opened as the machine's. */
async function byteAt(name: string, b: number) {
  const f = await openOverlay(name, 'test-disk');
  const d = overlay(zeroBase, f.data, f.map);
  const bytes = await d.read(b * 4096, 1);
  f.close();
  return bytes![0];
}

test('a snapshot pins generations and carries the ramdisk; a restore keeps, forks or replaces by plan', async () => {
  const module = await compileCore(WASM);
  const codec = await lzCodec(module);
  const name = `plan-${process.pid}`;
  await scribble(name, [1, 2], 0x11); // generation 1
  const ram = new Uint8Array(new SharedArrayBuffer(SIZE));
  ram.fill(0x5a, 8192, 12288); // block 2 of the ramdisk
  const devices = (): DeviceSpec[] => [
    { type: 'blk', source: 'zero', size: SIZE, overlay: name, identity: 'test-disk' },
    { type: 'blk', source: 'ram', size: SIZE, ramInit: [[0, ram]] },
  ];
  const o: BootOptions = { ramSize: 16 << 20, kernel: KERNEL, kernelOffset: 0, cmdline: '', jit: 0 };
  const vm = await bootVm(module, { ...o, devices: devices() });
  await vm.runAsync(10_000);
  await vm.settle();
  const parts: Uint8Array[] = [];
  await writeSnapshot(vm, (b) => { parts.push(b.slice()); }, { machine: 'test' }, codec);
  const suspendParts: Uint8Array[] = [];
  await writeSnapshot(vm, (b) => { suspendParts.push(b.slice()); }, { machine: 'test' }, codec, { suspend: true });
  await vm.close();
  const file = new Blob(parts as BlobPart[]);
  const { header } = await readSnapshot(file, codec, codec.snapshotVersion, { devices: devices() });
  const pins = (header.disks as { slot: number; overlay?: string; generation?: number; blocks: number; ram?: boolean }[]).map((d) => ({ slot: d.slot, overlay: d.overlay, generation: d.generation, blocks: d.blocks, ram: !!d.ram }));
  assert.deepEqual(pins, [{ slot: 0, overlay: name, generation: 1, blocks: 2, ram: false }, { slot: 1, overlay: undefined, generation: undefined, blocks: 1, ram: true }]);
  const suspendPins = (await readSnapshot(new Blob(suspendParts as BlobPart[]), codec, codec.snapshotVersion, { devices: devices(), resume: true })).header.disks as { blocks: number }[];
  assert.deepEqual(suspendPins.map((d) => d.blocks), [0, 1], "a suspended file has the ramdisk's blocks, not the overlay's");

  // After the snapshot, the overlay moves on: the next change bumps its generation (the snapshot asked for an epoch).
  // (Here by a new opening; the device's own epoch is checked by tests/overlay.test.ts's planted bug.)
  await scribble(name, [1], 0x22);
  assert.equal((await overlayMeta(name)).generation, 2);

  // keep: the overlay is left as it is (its block 1 stays 0x22); the ramdisk gets the file's blocks.
  const keep = devices();
  (keep[1] as { ramInit?: unknown }).ramInit = undefined;
  // A keep planned at another generation (the guest wrote after the page planned) is refused before anything moves.
  await assert.rejects(
    readSnapshot(file, codec, codec.snapshotVersion, { devices: keep, plan: [{ slot: 0, action: 'keep', generation: 1 }] }),
    (e: unknown) => e instanceof SnapshotError && e.msg.key === 'snapshots:snapshot.keptMoved',
  );
  const r1 = await readSnapshot(file, codec, codec.snapshotVersion, { devices: keep, plan: [{ slot: 0, action: 'keep', generation: 2 }] });
  const vm1 = await bootVm(module, { ...o, devices: keep, restore: r1.restore });
  await vm1.close();
  assert.equal(await byteAt(name, 1), 0x22, 'kept');
  const chunks = (keep[1] as { ramInit?: [number, Uint8Array][] }).ramInit!;
  assert.equal(chunks.find(([c]) => c === 0)![1][8192], 0x5a, "the ramdisk's blocks are its new chunks");

  // write: the file's blocks go into a fork, the pinned overlay is untouched.
  const fork = `${name}-fork`;
  const r2 = await readSnapshot(file, codec, codec.snapshotVersion, { devices: devices(), plan: [{ slot: 0, action: 'write', overlay: fork, identity: 'test-disk', size: SIZE }] });
  await (await bootVm(module, { ...o, devices: devices(), restore: r2.restore })).close();
  assert.deepEqual([await byteAt(fork, 1), await byteAt(fork, 2), await byteAt(name, 1)], [0x11, 0x11, 0x22]);
  assert.equal((await overlayMeta(fork)).generation, 1, "a fork's generation is 1 (what the page records as its fork's)");
  // The default (no plan): a replace of the pinned overlay.
  const r3 = await readSnapshot(file, codec, codec.snapshotVersion, { devices: devices() });
  await (await bootVm(module, { ...o, devices: devices(), restore: r3.restore })).close();
  assert.equal(await byteAt(name, 1), 0x11, 'replaced');
  assert.equal((await overlayMeta(name)).generation, 3, 'a replaced overlay goes on from its generation (2), never back to one a snapshot pinned');
});

// A disk whose size isn't a multiple of 4 KiB (a raw image of any size, a disk resized to a multiple of 512): its last
// block is partial, and GPT's backup header there means it is always written. The restore writes it into an emptied
// overlay, whose write reads the rest of the block from its base.
test("a restore of a disk whose size isn't a multiple of 4 KiB, its last block written: forked and replaced", async () => {
  const module = await compileCore(WASM);
  const codec = await lzCodec(module);
  const ODD = 10 * 4096 + 512;
  const name = `odd-${process.pid}`;
  const zeros = { size: ODD, format: 'raw' as const, read: async (_o: number, len: number) => new Uint8Array(len) };
  const f = await openOverlay(name, 'odd-disk');
  const d = overlay(zeros, f.data, f.map, f.meta);
  assert.ok(await d.write(ODD - 512, new Uint8Array(512).fill(0x77)));
  assert.ok(await d.write(4096, new Uint8Array(4096).fill(0x66)));
  f.close();
  const devices = (): DeviceSpec[] => [{ type: 'blk', source: 'zero', size: ODD, overlay: name, identity: 'odd-disk' }];
  const o: BootOptions = { ramSize: 16 << 20, kernel: KERNEL, kernelOffset: 0, cmdline: '', jit: 0 };
  const vm = await bootVm(module, { ...o, devices: devices() });
  await vm.runAsync(10_000);
  await vm.settle();
  const parts: Uint8Array[] = [];
  await writeSnapshot(vm, (b) => { parts.push(b.slice()); }, { machine: 'test' }, codec);
  await vm.close();
  const file = new Blob(parts as BlobPart[]);
  const bytesOf = async (overlayName: string) => {
    const g = await openOverlay(overlayName, 'odd-disk');
    const all = (await overlay(zeros, g.data, g.map).read(0, ODD))!;
    g.close();
    return [all[4096], all[ODD - 513], all[ODD - 512], all[ODD - 1]];
  };
  const fork = `${name}-fork`;
  const r = await readSnapshot(file, codec, codec.snapshotVersion, { devices: devices(), plan: [{ slot: 0, action: 'write', overlay: fork, identity: 'odd-disk', size: ODD }] });
  await (await bootVm(module, { ...o, devices: devices(), restore: r.restore })).close();
  assert.deepEqual(await bytesOf(fork), [0x66, 0, 0x77, 0x77], 'forked');
  const r2 = await readSnapshot(file, codec, codec.snapshotVersion, { devices: devices() });
  await (await bootVm(module, { ...o, devices: devices(), restore: r2.restore })).close();
  assert.deepEqual(await bytesOf(name), [0x66, 0, 0x77, 0x77], 'replaced');
});

// A grown overlay (docs/machines.md §4.5): over an image smaller than the guest's size, the device opens it at that
// size (the spec's, as the page gives it), a snapshot pins that size, and a restore's fork keeps it in its meta.
test("a grown overlay over a smaller image: the device opens it at the guest's size, a snapshot pins it, a fork keeps it", async () => {
  const module = await compileCore(WASM);
  const codec = await lzCodec(module);
  const dir = mkdtempSync(join(tmpdir(), 'waarm64-grown-'));
  try {
    const img = join(dir, 'base.img');
    writeFileSync(img, new Uint8Array(SIZE).fill(0x33));
    const GROWN = 4 * SIZE;
    const name = `grown-${process.pid}`;
    const image = { size: SIZE, format: 'raw' as const, read: async (_o: number, len: number) => new Uint8Array(len).fill(0x33) };
    // A block past the image's end, written as a machine would have.
    const f = await openOverlay(name, 'grown-disk');
    assert.ok(await overlay(image, f.data, f.map, f.meta, GROWN).write(GROWN - 4096, new Uint8Array(4096).fill(0x44)));
    f.close();
    const devices = (): DeviceSpec[] => [{ type: 'blk', url: pathToFileURL(img).href, size: GROWN, overlay: name, identity: 'grown-disk' }];
    const o: BootOptions = { ramSize: 16 << 20, kernel: KERNEL, kernelOffset: 0, cmdline: '', jit: 0 };
    const vm = await bootVm(module, { ...o, devices: devices() });
    await vm.runAsync(10_000);
    await vm.settle();
    const parts: Uint8Array[] = [];
    await writeSnapshot(vm, (b) => { parts.push(b.slice()); }, { machine: 'test' }, codec);
    await vm.close();
    const file = new Blob(parts as BlobPart[]);
    const { header } = await readSnapshot(file, codec, codec.snapshotVersion, { devices: devices() });
    const [pin] = header.disks as { size: number; blocks: number }[];
    assert.deepEqual([pin.size, pin.blocks], [GROWN, 1], 'pinned at the grown size, with the block past the image');
    const fork = `${name}-fork`;
    const r = await readSnapshot(file, codec, codec.snapshotVersion, { devices: devices(), plan: [{ slot: 0, action: 'write', overlay: fork, identity: 'grown-disk', size: GROWN }] });
    await (await bootVm(module, { ...o, devices: devices(), restore: r.restore })).close();
    assert.equal((await overlayMeta(fork)).size, GROWN, "the fork's own size");
    const g = await openOverlay(fork, 'grown-disk');
    const d = overlay(image, g.data, g.map, g.meta); // as the next start opens it
    assert.equal(d.size, GROWN);
    assert.deepEqual([(await d.read(0, 1))![0], (await d.read(SIZE, 1))![0], (await d.read(GROWN - 1, 1))![0]], [0x33, 0, 0x44]);
    g.close();
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// A swap ramdisk (web/app/guest-swap.ts): the device writes the swap area's first page over the empty ramdisk at its
// start, and not over a restored one's chunks (the guest's own swap is in them).
test("a swap ramdisk starts with its swap page; a restored one keeps the snapshot's chunks", async () => {
  const module = await compileCore(WASM);
  const codec = await lzCodec(module);
  const o: BootOptions = { ramSize: 16 << 20, kernel: KERNEL, kernelOffset: 0, cmdline: '', jit: 0 };
  /** The ramdisk's blocks as a snapshot of a machine started with `spec` carries them. */
  const carried = async (spec: DeviceSpec) => {
    const vm = await bootVm(module, { ...o, devices: [spec] });
    await vm.runAsync(10_000);
    await vm.settle();
    const parts: Uint8Array[] = [];
    await writeSnapshot(vm, (b) => { parts.push(b.slice()); }, { machine: 'test' }, codec);
    await vm.close();
    const into: DeviceSpec[] = [{ type: 'blk', source: 'ram', size: SIZE }];
    const r = await readSnapshot(new Blob(parts as BlobPart[]), codec, codec.snapshotVersion, { devices: into });
    await (await bootVm(module, { ...o, devices: into, restore: r.restore })).close();
    return (into[0] as { ramInit: [number, Uint8Array][] }).ramInit;
  };
  const fresh = await carried({ type: 'blk', source: 'ram', size: SIZE, swap: 'waarm64-swap0' });
  assert.equal(fresh.length, 1);
  const [c, bytes] = fresh[0];
  assert.equal(c, 0);
  assert.equal(Buffer.compare(bytes.subarray(0, 4096), swapHeader(SIZE, 'waarm64-swap0', bytes.slice(1036, 1052))), 0, 'the swap page, with its UUID');
  assert.ok(bytes.subarray(4096).every((x) => x === 0), 'nothing past it');
  const restored = await carried({ type: 'blk', source: 'ram', size: SIZE, swap: 'waarm64-swap0', ramInit: [] });
  assert.deepEqual(restored, [], "a restored swap ramdisk is the snapshot's");
});

// Spill memories (docs/spill-memories.md): their RAM is in the file after memory 0's, each from a whole chunk
// (the first spill memory here ends mid-chunk), and comes back into the same layout; another layout is refused.
test("a snapshot carries the spill memories' RAM, and restores only onto the same ones", async () => {
  const { ramStarts } = await import('../web/snapshot.ts');
  const { SnapshotError } = await import('../web/snapshot-file.ts');
  const { text } = await import('../web/i18n.ts');
  assert.deepEqual(ramStarts([16 << 20, 0x18_0000, 2 << 20]), [0, 16, 18]);
  const module = await compileCore(WASM);
  const codec = await lzCodec(module);
  const spill = [0x18_0000, 2 << 20];
  const o: BootOptions = { ramSize: 16 << 20, spill, kernel: KERNEL, kernelOffset: 0, cmdline: '', jit: 0 };
  const vm = await bootVm(module, o);
  await vm.runAsync(10_000);
  await vm.settle();
  /** The pages written: [memory, offset, byte]; the last page of each spill memory too. */
  const marks: [number, number, number][] = [[0, 15 << 20, 0x11], [1, 0, 0x22], [1, 0x17_f000, 0x33], [2, 0x10_0000, 0x44], [2, (2 << 20) - 4096, 0x55]];
  const views = (v: typeof vm) => [new Uint8Array(v.memory.buffer, v.ram, v.ramSize), ...v.spillRam()];
  for (const [m, at, b] of marks) views(vm)[m].fill(b, at, at + 4096);
  const parts: Uint8Array[] = [];
  await writeSnapshot(vm, (b) => { parts.push(b.slice()); }, { machine: 'test' }, codec);
  const before = views(vm).map((v) => v.slice());
  await vm.close();
  const file = new Blob(parts as BlobPart[]);
  const { header, restore } = await readSnapshot(file, codec, codec.snapshotVersion);
  assert.deepEqual(header.spill, spill);
  const back = await bootVm(module, { ...o, restore });
  const after = views(back);
  for (let m = 0; m < 3; m++) assert.equal(Buffer.compare(after[m], before[m]), 0, `memory ${m} came back as it was`);
  assert.equal(after[2][(2 << 20) - 1], 0x55);
  await back.close();
  for (const other of [[0x18_0000], [2 << 20, 0x18_0000], undefined]) {
    const { restore } = await readSnapshot(file, codec, codec.snapshotVersion);
    await assert.rejects(bootVm(module, { ...o, spill: other, restore }), (e: unknown) => e instanceof SnapshotError && /NUMA nodes of 1\.5 MiB \+ 2 MiB/.test(text(e.msg)), JSON.stringify(other));
  }
});
