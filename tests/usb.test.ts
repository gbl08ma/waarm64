// The USB glue's device side in Node (docs/usb.md): the virtual device base (web/usb-virtual.ts)
// answering chapter 9 from descriptors.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Setup, UsbResult, UsbTransfer } from '../web/usb-device.ts';
import { VirtualDevice, parseConfig, stringDescriptor, type ControlAnswer } from '../web/usb-virtual.ts';

const DEVICE = new Uint8Array([18, 1, 0x00, 0x02, 0xff, 0, 0, 64, 0x34, 0x12, 0x78, 0x56, 0x01, 0x00, 1, 2, 0, 1]);
// One configuration (value 1, self-powered): interface 0 with alt 0 (bulk 0x81, 0x02) and alt 1 (interrupt 0x83).
const CONFIG = new Uint8Array([
  9, 2, 9 + 9 + 7 + 7 + 9 + 7, 0, 1, 1, 0, 0xc0, 1,
  9, 4, 0, 0, 2, 0xff, 0, 0, 0,
  7, 5, 0x81, 2, 0x00, 0x02, 0,
  7, 5, 0x02, 2, 0x00, 0x02, 0,
  9, 4, 0, 1, 1, 0xff, 0, 0, 0,
  7, 5, 0x83, 3, 8, 0, 4,
]);

class Thing extends VirtualDevice {
  log: string[] = [];
  constructor() {
    super('high', { device: DEVICE, configs: [CONFIG], strings: ['Maker', 'Thing'] });
  }
  protected control(s: Setup, data?: Uint8Array): ControlAnswer | Promise<ControlAnswer> {
    if (s.request === 0x42) return Promise.resolve(new Uint8Array([7, 8, 9]));
    if (s.request === 0x43) return data !== undefined;
    return undefined;
  }
  protected transfer(t: UsbTransfer, done: (r: UsbResult) => void) {
    this.log.push(`${t.ep.toString(16)} ${t.length}`);
    done({ code: 'success', actual: t.length, data: t.ep & 0x80 ? new Uint8Array(t.length) : undefined });
  }
  protected changed() {
    this.log.push(`changed ${this.configuration} ${this.alts.get(0) ?? 0}`);
  }
}

let tag = 0;
const control = (d: VirtualDevice, requestType: number, request: number, value: number, index: number, length: number, data?: Uint8Array) =>
  new Promise<UsbResult>((resolve) => d.submit({ tag: ++tag, ep: 0, type: 'control', setup: { requestType, request, value, index, length }, data, length }, resolve));
const bulk = (d: VirtualDevice, ep: number, length: number) => new Promise<UsbResult>((resolve) => d.submit({ tag: ++tag, ep, type: 'bulk', length }, resolve));

test('a virtual device answers chapter 9 from its descriptors', async () => {
  const d = new Thing();
  assert.deepEqual(parseConfig(CONFIG).interfaces.get(0)?.map((a) => a.endpoints.map((e) => e.ep)), [[0x81, 0x02], [0x83]]);
  const dev = await control(d, 0x80, 6, 0x100, 0, 64);
  assert.deepEqual([dev.code, dev.actual, Buffer.compare(dev.data!, DEVICE)], ['short', 18, 0]);
  const head = await control(d, 0x80, 6, 0x200, 0, 9);
  assert.deepEqual([head.code, head.actual, head.data![2]], ['success', 9, CONFIG.length]);
  assert.deepEqual((await control(d, 0x80, 6, 0x300, 0, 255)).data, new Uint8Array([4, 3, 9, 4]));
  assert.deepEqual((await control(d, 0x80, 6, 0x302, 0x409, 255)).data, stringDescriptor('Thing'));
  for (const v of [0x303, 0x400, 0x500, 0x600, 0xf00, 0x201]) assert.equal((await control(d, 0x80, 6, v, 0, 64)).code, 'stall', `descriptor ${v.toString(16)}`);
  // Unconfigured: no endpoints, no interfaces.
  assert.equal((await bulk(d, 0x81, 512)).code, 'error');
  assert.equal((await control(d, 0x81, 10, 0, 0, 1)).code, 'stall');
  assert.deepEqual((await control(d, 0x80, 8, 0, 0, 1)).data, new Uint8Array([0]));
  assert.equal((await control(d, 0x00, 9, 2, 0, 0)).code, 'stall');
  assert.equal((await control(d, 0x00, 9, 1, 0, 0)).code, 'success');
  assert.deepEqual((await control(d, 0x80, 8, 0, 0, 1)).data, new Uint8Array([1]));
  assert.deepEqual((await control(d, 0x80, 0, 0, 0, 2)).data, new Uint8Array([1, 0]), 'self-powered');
  assert.deepEqual((await bulk(d, 0x81, 512)).code, 'success');
  assert.equal((await bulk(d, 0x83, 8)).code, 'error', 'not in alt 0');
  // Halts.
  assert.equal((await control(d, 0x02, 3, 0, 0x81, 0)).code, 'success');
  assert.deepEqual((await control(d, 0x82, 0, 0, 0x81, 2)).data, new Uint8Array([1, 0]));
  assert.equal((await bulk(d, 0x81, 512)).code, 'stall');
  assert.equal((await control(d, 0x02, 1, 0, 0x81, 0)).code, 'success');
  assert.deepEqual((await control(d, 0x82, 0, 0, 0x81, 2)).data, new Uint8Array([0, 0]));
  assert.equal((await control(d, 0x82, 0, 0, 0x85, 2)).code, 'stall', 'no such endpoint');
  // Alternate settings.
  assert.equal((await control(d, 0x01, 11, 1, 0, 0)).code, 'success');
  assert.deepEqual((await control(d, 0x81, 10, 0, 0, 1)).data, new Uint8Array([1]));
  assert.equal((await bulk(d, 0x83, 8)).code, 'success');
  assert.equal((await control(d, 0x01, 11, 2, 0, 0)).code, 'stall');
  // Vendor requests: asynchronous answers stay in order with the standard ones.
  const order: string[] = [];
  const a = control(d, 0xc0, 0x42, 0, 0, 2).then((r) => order.push(`a ${r.code} ${r.actual}`));
  const b = control(d, 0x80, 8, 0, 0, 1).then((r) => order.push(`b ${r.code} ${r.data![0]}`));
  await Promise.all([a, b]);
  assert.deepEqual(order, ['a success 2', 'b success 1']);
  assert.equal((await control(d, 0x40, 0x43, 0, 0, 3, new Uint8Array(3))).actual, 3);
  assert.equal((await control(d, 0x40, 0x44, 0, 0, 0)).code, 'stall');
  d.reset();
  assert.deepEqual((await control(d, 0x80, 8, 0, 0, 1)).data, new Uint8Array([0]));
  assert.deepEqual(d.log, ['changed 1 0', '81 512', 'changed 1 1', '83 8', 'changed 0 0']);
});
