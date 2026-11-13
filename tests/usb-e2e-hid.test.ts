// WebHID end to end in the dev VM (scripts/ci-usb.sh, docs/testing.md "USB"): the uhid rig's devices
// (tests/usb/hid-descriptors.ts) in the pinned Chromium, in a dedicated worker, with permission from Chromium's
// managed policy. Chromium's parse still matches the recorded fixtures (tests/usb/hid-fixtures, which the WebHID
// backend's encoder round-trips against), input reports reach the worker, and output and feature reports reach the
// rig. Skips without WAARM64_USB_TESTS=1 or without the rig.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { DESCRIPTORS } from './usb/hid-descriptors.ts';
import { UhidDevice } from './usb/uhid.ts';
import { openRig, PORTS, uhidMissing, usbTests, type Rig } from './usb/rig.ts';

const missing = usbTests ? uhidMissing() : undefined;
const skip = !usbTests ? 'SKIPPED: scripts/ci-usb.sh runs it (WAARM64_USB_TESTS=1)' : missing ? `SKIPPED: ${missing}` : false;

let rig: Rig | undefined;
const devs = new Map<string, UhidDevice>();
let opened: (() => void) | undefined;
before(async () => {
  if (skip) return;
  for (const d of DESCRIPTORS) devs.set(d.id, new UhidDevice(d));
  await new Promise((r) => setTimeout(r, 500));
  rig = await openRig(PORTS.hid, '/tests/usb/hid-page.html');
  await rig.page.exposeFunction('rigOpened', () => opened?.());
  await rig.page.evaluate(() => { (window as any).onOpened = () => (window as any).rigOpened(); });
});
after(async () => {
  await rig?.close();
  for (const u of devs.values()) u.destroy();
});

type Io = { inputs: { id: number; data: number[] }[]; features: { id: number; data: number[] }[] };

/** Opens the device in the worker, sends `inputs` from the rig once it's open, does `send` and `readFeature` there. */
async function io(id: string, inputs: number[][], send: { kind: 'output' | 'feature'; id: number; data: number[] }[], readFeature: number[], expect = inputs.length): Promise<Io> {
  const u = devs.get(id)!;
  u.writes.length = 0;
  const isOpen = new Promise<void>((r) => { opened = r; });
  const run = rig!.page.evaluate((m) => (window as any).inWorker(m), { type: 'io', vendorId: u.d.vendorId, productId: u.d.productId, send, readFeature, inputs: expect, wait: 1500 });
  run.catch(() => {}); // awaited below; a rejection before then isn't unhandled
  await isOpen;
  await new Promise((r) => setTimeout(r, 100));
  for (const i of inputs) u.input(Uint8Array.from(i));
  return run;
}
const hex = (a: ArrayLike<number>) => Buffer.from(Uint8Array.from(a)).toString('hex');
const writes = (id: string) => devs.get(id)!.writes.map((w) => `${w.kind} ${hex(w.data)}`);

test("Chromium's parse matches the recorded fixtures, in a worker", { skip, timeout: 60_000 }, async () => {
  const r = await rig!.page.evaluate(() => (window as any).inWorker({ type: 'list' }));
  assert.equal(r.hid, true, 'navigator.hid in a dedicated worker');
  for (const d of DESCRIPTORS) {
    const fx = JSON.parse(readFileSync(`tests/usb/hid-fixtures/${d.id}.json`, 'utf8'));
    assert.equal(fx.descriptor, hex(d.rdesc), `${d.id}: the fixture's descriptor is the rig's (node tests/usb/hid-record.ts)`);
    const seen = r.devices.find((x: any) => x.vendorId === d.vendorId && x.productId === d.productId);
    assert.ok(seen, `${d.id} is visible`);
    assert.ok(JSON.stringify(seen.collections) === JSON.stringify(fx.collections), `${d.id}: Chromium's parse differs from the fixture (re-record: node tests/usb/hid-record.ts)`);
  }
});

test('reports with IDs: input in the worker without the ID byte; output, feature writes and reads', { skip, timeout: 30_000 }, async () => {
  const r = await io('vendor-ids', [[1, 1, 2, 3, 4, 5, 6, 7, 8], [2, 1, 0, 2, 0, 3, 0, 4, 0], [6, 5]],
    [{ kind: 'output', id: 3, data: Array(16).fill(0x33) }, { kind: 'feature', id: 4, data: [9, 8, 7, 6] }], [5, 4]);
  assert.deepEqual(r.inputs, [{ id: 1, data: [1, 2, 3, 4, 5, 6, 7, 8] }, { id: 2, data: [1, 0, 2, 0, 3, 0, 4, 0] }, { id: 6, data: [5] }]);
  assert.deepEqual(writes('vendor-ids'), [`output 03${'33'.repeat(16)}`, 'set-feature 0409080706']);
  // receiveFeatureReport's data starts with the report ID, unlike an input report's.
  assert.deepEqual(r.features.map((f) => [f.id, hex(f.data)]), [[5, `05${'55'.repeat(63)}`], [4, '0409080706']]);
});

test('reports without IDs: report ID 0 in WebHID, a 0 byte in front at the host', { skip, timeout: 30_000 }, async () => {
  const r = await io('vendor-noid', [Array(32).fill(0x61)],
    [{ kind: 'output', id: 0, data: Array(32).fill(0x63) }, { kind: 'feature', id: 0, data: Array(32).fill(0x64) }], [0]);
  assert.deepEqual(r.inputs, [{ id: 0, data: Array(32).fill(0x61) }]);
  assert.deepEqual(writes('vendor-noid'), [`output 00${'63'.repeat(32)}`, `set-feature 00${'64'.repeat(32)}`]);
  assert.deepEqual(r.features.map((f) => [f.id, hex(f.data)]), [[0, '64'.repeat(32)]]);
});

test("the DualSense: its input report, its output report beside hid-playstation's, its feature reports", { skip, timeout: 30_000 }, async () => {
  const r = await io('dualsense', [[1, ...Array(63).fill(0x80)]], [{ kind: 'output', id: 2, data: Array(63).fill(0x22) }], [5, 9]);
  assert.deepEqual(r.inputs, [{ id: 1, data: Array(63).fill(0x80) }]);
  assert.ok(writes('dualsense').includes(`output 02${'22'.repeat(63)}`), 'the output report reached the rig');
  assert.deepEqual(r.features.map((f) => [f.id, f.data.length]), [[5, 41], [9, 20]]);
});

test("a keyboard's protected collections: no keyboard or mouse input, no LED output; its feature report and the rest work", { skip, timeout: 30_000 }, async () => {
  // Empty keyboard and mouse reports (they'd reach the dev VM's own input too), a consumer key, a vendor report.
  const r = await io('keyboard', [[1, 0, 0, 0, 0, 0, 0, 0, 0], [2, 0xe9, 0], [4, 0, 0, 0], [5, ...Array(32).fill(0x55)]],
    [{ kind: 'output', id: 5, data: Array(32).fill(0x56) }], [6], 2);
  assert.deepEqual(r.inputs.map((i) => i.id), [2, 5], 'only the consumer and vendor input reports arrive');
  assert.deepEqual(writes('keyboard'), [`output 05${'56'.repeat(32)}`]);
  assert.deepEqual(r.features.map((f) => [f.id, hex(f.data)]), [[6, `06${'66'.repeat(8)}`]]);
  await assert.rejects(io('keyboard', [], [{ kind: 'output', id: 1, data: [1] }], []), /NotAllowedError/, "the keyboard's LED report is refused");
});
