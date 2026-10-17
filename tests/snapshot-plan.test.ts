// Snapshots of machines as the unit (docs/plans/machines.md §5), in Node on a bare-metal guest (no image needed):
// a snapshot pins each overlay's generation and moves it on for the next change; a ramdisk's blocks are in the file
// (a suspended machine's too); a restore keeps an overlay at its pinned generation, or writes the file's blocks into
// another one (a fork), never into the one it pins unless asked (the default, a replace).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { DeviceSpec } from '../web/devices.ts';
import { lzCodec } from '../web/lz.ts';
import { openOverlay, overlay, overlayMeta } from '../web/overlay.ts';
import { readSnapshot, writeSnapshot } from '../web/snapshot.ts';
import { bootVm, type BootOptions } from '../web/vm.ts';

const WASM = readFileSync(new URL('../target/wasm32-unknown-unknown/release/webpc_core.wasm', import.meta.url));
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
  const module = await WebAssembly.compile(WASM);
  const codec = await lzCodec(module);
  const name = `plan-${process.pid}`;
  await scribble(name, [1, 2], 0x11); // generation 1
  const ram = new Uint8Array(new SharedArrayBuffer(SIZE));
  ram.fill(0x5a, 8192, 12288); // block 2 of the ramdisk
  const devices = (): DeviceSpec[] => [
    { type: 'blk', source: 'zero', size: SIZE, overlay: name, identity: 'test-disk' },
    { type: 'blk', source: 'ram', size: SIZE, ramInit: [[0, ram.buffer as SharedArrayBuffer]] },
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
  const r1 = await readSnapshot(file, codec, codec.snapshotVersion, { devices: keep, plan: [{ slot: 0, action: 'keep' }] });
  const vm1 = await bootVm(module, { ...o, devices: keep, restore: r1.restore });
  await vm1.close();
  assert.equal(await byteAt(name, 1), 0x22, 'kept');
  const chunks = (keep[1] as { ramInit?: [number, SharedArrayBuffer][] }).ramInit!;
  assert.equal(new Uint8Array(chunks.find(([c]) => c === 0)![1])[8192], 0x5a, "the ramdisk's blocks are its new chunks");

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
