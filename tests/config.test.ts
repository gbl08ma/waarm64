// What the page's machine is resolved to (web/app/run/config.ts `resolveMachine`, docs/frontend.md "Query
// parameters"): the address, a stored machine's record, the browser's settings and the defaults, field by field. The
// table is the rule: a change to it is a change to what machines run with.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addressFor, asRun, resolveMachine, type DeviceSwitches, type Resolved } from '../web/app/run/config.ts';
import { shapeHash, shapeOf } from '../web/app/shape.ts';
import type { Settings } from '../web/app/settings.ts';
import type { MachineRecord } from '../web/app/shape.ts';

const record = (over: Partial<MachineRecord> = {}): MachineRecord => ({
  id: 'aaaaaaaaaaaa', name: 'Brisk Heron', ncpus: 2, ramMiB: 1024, display: '2d', network: true, created: 0, modified: 0, attachments: [], ...over,
});
/** A stored machine with every switch off (`clock`, `netConfig` and `agent` unset: a record from before them; the last two on then), and one with every switch on. */
const OFF = record();
const ON = record({ usb: true, mouse: true, touch: true, clipboard: true, clock: true, shares: true, netConfig: false, display: '3d', vulkan: true, keyboard: 'gb' });
const ENV = { gpu: true, ramMiB: 2048, cores: 8 };
const DEVICES: (keyof DeviceSwitches)[] = ['usb', 'mouse', 'touch', 'agent', 'clipboard', 'clock', 'shares', 'netConfig'];
/** The switches that are on, by name. */
const on = (d: DeviceSwitches) => DEVICES.filter((k) => d[k]).join(' ');

type Row = [name: string, query: string, record: MachineRecord | undefined, settings: Settings, expect: Partial<Omit<Resolved, 'devices'>> & { devices?: string }];
const TABLE: Row[] = [
  // The devices (and the guest agent and network settings, on unless turned off).
  ['transient: the defaults', '', undefined, {}, { devices: 'agent clock netConfig' }],
  ['transient: each device on', 'usb=1&mouse=1&touch=1&clipboard=1', undefined, {}, { devices: 'usb mouse touch agent clipboard clock netConfig' }],
  ['transient: the agent, the clock and the network settings off', 'agent=0&clock=0&netconfig=0', undefined, {}, { devices: '' }],
  ['transient: =0 of an off one, =1 of an on one', 'usb=0&clock=1&netconfig=1&agent=1', undefined, {}, { devices: 'agent clock netConfig' }],
  ['stored, all off: as its record', '', OFF, {}, { devices: 'agent netConfig' }],
  ['stored, all off: the address turns each on', 'usb=1&mouse=1&touch=1&clipboard=1&clock=1', OFF, {}, { devices: 'usb mouse touch agent clipboard clock netConfig' }],
  ['stored, all on: as its record', '', ON, {}, { devices: 'usb mouse touch agent clipboard clock shares' }],
  ['stored, all on: the address turns each off', 'usb=0&mouse=0&touch=0&agent=0&clipboard=0&clock=0', ON, {}, { devices: 'shares' }],
  ['stored: ?netconfig=1 over its record', 'netconfig=1', ON, {}, { devices: 'usb mouse touch agent clipboard clock shares netConfig' }],
  ['stored: ?netconfig=0 over its record', 'netconfig=0', OFF, {}, { devices: 'agent' }],
  ['stored: the agent off in its record (its clipboard switch kept)', '', record({ agent: false, clipboard: true }), {}, { devices: 'clipboard netConfig' }],
  ['stored: ?agent=1 over its record', 'agent=1', record({ agent: false }), {}, { devices: 'agent netConfig' }],
  // The size.
  ['transient: the default size', '', undefined, {}, { ncpus: 4, ramMiB: 2048, ramSplit: undefined, jitMiB: 0 }],
  ['transient: the size chosen last', '', undefined, { ncpus: 2, ramMiB: 4096, jitMiB: 64 }, { ncpus: 2, ramMiB: 4096, jitMiB: 64 }],
  ['transient: a remembered size not offered', '', undefined, { ncpus: 5, ramMiB: 1000 }, { ncpus: 4, ramMiB: 2048 }],
  ['transient: the address over the settings', 'ncpus=3&ram=3072&jitmb=96', undefined, { ncpus: 2, ramMiB: 4096, jitMiB: 64 }, { ncpus: 3, ramMiB: 3072, jitMiB: 96 }],
  ['stored: its record, not the settings', '', OFF, { ncpus: 6, ramMiB: 4096, jitMiB: 64 }, { ncpus: 2, ramMiB: 1024, jitMiB: 0 }],
  ['stored: its own JIT budget', '', record({ jitMiB: 160 }), { jitMiB: 64 }, { jitMiB: 160 }],
  ['stored: the address over its record', 'ncpus=4&ram=2048&jitmb=128', OFF, {}, { ncpus: 4, ramMiB: 2048, jitMiB: 128 }],
  ['stored: its split', '', record({ ramSplit: [768, 256] }), {}, { ramMiB: 1024, ramSplit: [768, 256] }],
  ['stored: ?ram= drops its split', 'ram=2048', record({ ramSplit: [768, 256] }), {}, { ramMiB: 2048, ramSplit: undefined }],
  ['?split= over ?ram=', 'ram=2048&split=3071,1024', OFF, {}, { ramMiB: 4095, ramSplit: [3071, 1024] }],
  ['a ?split= that can\'t be laid out is ignored', 'split=0,1024', OFF, {}, { ramMiB: 1024, ramSplit: undefined }],
  // The display (before what the browser can do), Vulkan and the keyboard layout.
  ['transient: 3D by default', '', undefined, {}, { three: true, vulkan: false, keyboard: 'browser' }],
  ['transient: 2D as chosen last', '', undefined, { gpu: '2d' }, { three: false }],
  ['transient: ?gpu=virgl over the settings', 'gpu=virgl', undefined, { gpu: '2d' }, { three: true }],
  ['?gpu=2d', 'gpu=2d', ON, {}, { three: false }],
  ['?gpu=virgl-null is 2D on the page', 'gpu=virgl-null', ON, {}, { three: false }],
  ['?display=simple: no 3D', 'display=simple', ON, {}, { three: false }],
  ['stored: its record over the settings', '', ON, { gpu: '2d' }, { three: true, vulkan: true, keyboard: 'gb' }],
  ['stored 2D: ?gpu=virgl over its record', 'gpu=virgl', OFF, {}, { three: true }],
  ['?gpu=vulkan', 'gpu=vulkan', OFF, {}, { vulkan: true }],
  ['?keyboard= over its record', 'keyboard=fr', ON, {}, { keyboard: 'fr' }],
  ['a stored machine without a layout set', '', OFF, {}, { keyboard: undefined }],
  ['the tests\' ?machine= guests: no layout', 'machine=buildroot', undefined, {}, { keyboard: undefined }],
];

test('resolveMachine: the address, the record, the settings and the defaults, as the table says', () => {
  for (const [name, query, rec, settings, expect] of TABLE) {
    const r = resolveMachine(new URLSearchParams(query), rec, settings, ENV);
    const got: Record<string, unknown> = { ...r, devices: on(r.devices) };
    for (const [k, v] of Object.entries(expect)) assert.deepEqual(got[k], v, `${name} (?${query}): ${k}`);
  }
});

test('resolveMachine: a kind of machine without a virtio-gpu has no 3D', () => {
  assert.equal(resolveMachine(new URLSearchParams('gpu=virgl'), undefined, {}, { ...ENV, gpu: false }).three, false);
});

test('asRun: without the address, a stored machine runs as its record (its snapshots keep their shape); with it, as resolved', async () => {
  const disks = () => ({ id: 'd', kind: 'blank', name: 'd', size: 1 << 30, identity: { kind: 'blank', id: 'd', bytes: 1 << 30 }, created: 0 }) as const;
  const attachments = [{ id: 'a00000000001', disk: 'd', readOnly: false }];
  for (const r of [OFF, ON, record({ ramSplit: [768, 256], jitMiB: 160 }), record({ usb: true, clock: true, display: '3d' })].map((x) => ({ ...x, attachments }))) {
    const run = asRun(r, resolveMachine(new URLSearchParams(''), r, { ncpus: 6, ramMiB: 4096, jitMiB: 64, gpu: '2d' }, ENV));
    assert.equal(await shapeHash(shapeOf(run, disks)), await shapeHash(shapeOf(r, disks)), r.name);
    assert.deepEqual(shapeOf(run, disks), shapeOf(r, disks));
  }
  const over = shapeOf(asRun({ ...OFF, attachments }, resolveMachine(new URLSearchParams('mouse=1&ncpus=4&ram=2048'), { ...OFF, attachments }, {}, ENV)), disks);
  assert.deepEqual([over.ncpus, over.ramMiB, over.devices.includes('mouse')], [4, 2048, true]);
});

test("addressFor: another machine than the page's resolves without the address's size and switches (finding 2)", async () => {
  const disks = () => ({ id: 'd', kind: 'blank', name: 'd', size: 1 << 30, identity: { kind: 'blank', id: 'd', bytes: 1 << 30 }, created: 0 }) as const;
  const attachments = [{ id: 'a00000000001', disk: 'd', readOnly: false }];
  const q = new URLSearchParams('m=aaaaaaaaaaab&ncpus=4&ram=2048&split=1024,1024&jitmb=96&usb=1&mouse=1&touch=1&clipboard=1&agent=0&clock=1&netconfig=0&gpu=2d');
  for (const r of [OFF, ON].map((x) => ({ ...x, attachments }))) {
    const other = asRun(r, resolveMachine(addressFor(q, false), r, {}, ENV));
    assert.equal(await shapeHash(shapeOf(other, disks)), await shapeHash(shapeOf(r, disks)), `${r.name}: its kept snapshots' hash`);
    const own = shapeOf(asRun(r, resolveMachine(addressFor(q, true), r, {}, ENV)), disks);
    assert.deepEqual([own.ncpus, own.ramMiB], [4, 2048], "the page's own machine: the address's");
  }
  assert.equal(addressFor(q, false).get('gpu'), '2d', 'the page-wide keys stay (a switch keeps them)');
  assert.equal(q.get('ncpus'), '4', "the page's address is left as it is");
});
