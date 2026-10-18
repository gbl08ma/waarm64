// Gadget Zero (web/usb-gadget-zero.ts) and the xHCI's glue (web/usb.ts) in Node (docs/usb.md): what
// usbtest relies on from the device, and the glue on a shared block laid out as the core's
// (core/src/xhci.rs `XhciShared`).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { UsbDevice, UsbFromWorker, UsbResult } from '../web/usb-device.ts';
import { GadgetZero } from '../web/usb-gadget-zero.ts';
import { Usb, registerUsbOpener } from '../web/usb.ts';

let tag = 0;
const control = (d: UsbDevice, requestType: number, request: number, value: number, index: number, length: number, data?: Uint8Array) =>
  new Promise<UsbResult>((resolve) => d.submit({ tag: ++tag, ep: 0, type: 'control', setup: { requestType, request, value, index, length }, data, length }, resolve));
const bulk = (d: UsbDevice, ep: number, length: number, data?: Uint8Array) => new Promise<UsbResult>((resolve) => d.submit({ tag: ++tag, ep, type: 'bulk', length, data }, resolve));

test('Gadget Zero sources and sinks the pattern, loops back, and answers 0x5b/0x5c', async () => {
  const d = new GadgetZero({ speed: 'high', pattern: 1 });
  const dev = await control(d, 0x80, 6, 0x100, 0, 18);
  assert.deepEqual([dev.data![8] | dev.data![9] << 8, dev.data![10] | dev.data![11] << 8, dev.data![17]], [0x0525, 0xa4a0, 2]);
  assert.equal((await control(d, 0x80, 6, 0x600, 0, 10)).actual, 10, 'a high-speed device has a qualifier');
  const other = await control(d, 0x80, 6, 0x700, 0, 255);
  assert.deepEqual([other.data![1], other.data![5]], [7, 3], "the other speed's source/sink");
  assert.equal((await control(d, 0x00, 9, 3, 0, 0)).code, 'success');
  const src = await bulk(d, 0x81, 1024);
  assert.deepEqual([src.code, src.data![511], src.data![512], src.data![600]], ['success', 511 % 63, 0, 88 % 63]);
  assert.equal((await bulk(d, 0x01, 1024, src.data)).code, 'success');
  const bad = src.data!.slice();
  bad[700] ^= 1;
  assert.equal((await bulk(d, 0x01, 1024, bad)).code, 'stall', 'a wrong byte halts the sink');
  assert.equal((await bulk(d, 0x01, 1024, src.data)).code, 'stall', 'until CLEAR_FEATURE(HALT)');
  assert.deepEqual((await control(d, 0x82, 0, 0, 0x01, 2)).data, new Uint8Array([1, 0]));
  assert.equal((await control(d, 0x02, 1, 0, 0x01, 0)).code, 'success');
  assert.equal((await bulk(d, 0x01, 1024, src.data)).code, 'success');
  // Control writes, read back (usbtest 14, 21).
  const bytes = Uint8Array.from({ length: 300 }, (_, i) => i * 7);
  assert.equal((await control(d, 0x40, 0x5b, 0, 0, 300, bytes)).actual, 300);
  assert.equal(Buffer.compare((await control(d, 0xc0, 0x5c, 0, 0, 300)).data!, bytes), 0);
  assert.equal((await control(d, 0x40, 0x5b, 1, 0, 1, bytes.subarray(0, 1))).code, 'stall', 'wValue must be 0');
  // Loopback: an IN waits for data; what OUT TDs took comes back in order.
  assert.equal((await control(d, 0x00, 9, 2, 0, 0)).code, 'success');
  const order: string[] = [];
  d.submit({ tag: ++tag, ep: 0x81, type: 'bulk', length: 512 }, (r) => order.push(`in ${r.code} ${r.actual} ${r.data![0]}`));
  assert.equal(order.length, 0);
  d.submit({ tag: ++tag, ep: 0x01, type: 'bulk', data: new Uint8Array([9, 9, 9]), length: 3 }, (r) => order.push(`out ${r.actual}`));
  assert.deepEqual(order, ['out 3', 'in short 3 9']);
  // A cancelled IN is forgotten: the next OUT's data waits for the next IN.
  const held = ++tag;
  d.submit({ tag: held, ep: 0x81, type: 'bulk', length: 512 }, () => order.push('the cancelled one'));
  d.cancel(0x81, [held]);
  d.submit({ tag: ++tag, ep: 0x01, type: 'bulk', data: new Uint8Array([1]), length: 1 }, () => {});
  assert.equal(order.length, 2);
  assert.equal((await bulk(d, 0x81, 512)).data![0], 1);
  // Super speed: BOS, companions, no qualifier.
  const ss = new GadgetZero({ speed: 'super' });
  assert.equal((await control(ss, 0x80, 6, 0xf00, 0, 22)).actual, 22);
  assert.equal((await control(ss, 0x80, 6, 0x600, 0, 10)).code, 'stall');
  assert.equal((await control(ss, 0x80, 6, 0x200, 0, 255)).data![2], 9 + 9 + 2 * (7 + 6));
});

test('the glue turns request records into TDs and results into completion records', async () => {
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
  const u32 = new Uint32Array(memory.buffer);
  const RAM = 65536;
  let kicks = 0;
  const channel = new MessageChannel();
  const states: UsbFromWorker[] = [];
  channel.port2.onmessage = (e) => states.push(e.data);
  const usb = new Usb({ memory, shared: 0, ram: RAM, ramSize: 65536, deterministic: true, kick: () => kicks++, port: channel.port1 });
  const CPL = (8 + 8 + 4 * 4096) / 4;
  const completions = () => {
    const out: number[][] = [];
    for (let t = u32[CPL + 1]; t !== u32[CPL]; t += 3) out.push([0, 1, 2].map((k) => u32[CPL + 2 + ((t + k) % 4096)]));
    u32[CPL + 1] = u32[CPL];
    return out;
  };
  const post = (words: number[]) => {
    const REQ = 8 / 4;
    for (const w of words) {
      u32[REQ + 2 + (u32[REQ] % 4096)] = w;
      u32[REQ]++;
    }
  };
  const m = await usb.attach(0, { api: 'virtual', kind: 'gadget-zero', pattern: 1 });
  assert.equal(m.state, 'attached');
  assert.deepEqual(completions(), [[0, 1 | 3 << 8, 0]], 'an attach at high speed');
  assert.equal((await usb.attach(0, { api: 'virtual', kind: 'gadget-zero' })).state, 'error', 'the connector is taken');
  assert.equal((await usb.attach(1, { api: 'usb', vendorId: 1, productId: 2 })).state, 'error', 'no real devices in deterministic mode');
  // GET_DESCRIPTOR(DEVICE) for 64 bytes into RAM offset 0x100: 18 bytes, a short packet.
  post([7, 0 | 1 << 8 | 0 << 16, 6, 1 | 4 << 16 | 1 << 24, 64, 0x0100_0680, 64 << 16, 0x100, 64]);
  usb.poll();
  assert.deepEqual(completions(), [[7, 13 << 8, 18]]);
  assert.deepEqual([...new Uint8Array(memory.buffer, RAM + 0x100, 4)], [18, 1, 0, 2]);
  // SET_CONFIGURATION(3), then a bulk OUT (DCI 2: OUT 1) of immediate data whose last byte breaks the pattern.
  post([8, 0 | 1 << 8, 4, 0 | 4 << 16 | 1 << 24, 0, 0x0003_0900, 0]);
  post([9, 0 | 2 << 8, 6, 1 | 2 << 16, 8, 0, 8 | 0x8000_0000, 0x03020100, 0x08060504]);
  usb.poll();
  assert.deepEqual(completions(), [[8, 1 << 8, 0], [9, 6 << 8, 0]]);
  // A detach empties the connector; a record of the old generation is dropped.
  usb.detach(0, 'page');
  assert.deepEqual(completions(), [[0, 2, 0]]);
  post([10, 0 | 3 << 8, 4, 1 | 6 << 16, 512, 0x200, 512]);
  usb.poll();
  assert.deepEqual(completions(), []);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(states.map((s) => s.state), ['attached', 'error', 'error', 'detached']);
  assert.ok(kicks >= 4);
  usb.close();
  channel.port2.close();
});

/** A glue on its own shared block, with helpers to post records and read completions. */
function rig(deterministic = true) {
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
  const u32 = new Uint32Array(memory.buffer);
  const usb = new Usb({ memory, shared: 0, ram: 65536, ramSize: 65536, deterministic, kick: () => {} });
  const CPL = (8 + 8 + 4 * 4096) / 4;
  const completions = () => {
    const out: number[][] = [];
    for (let t = u32[CPL + 1]; t !== u32[CPL]; t += 3) out.push([0, 1, 2].map((k) => u32[CPL + 2 + ((t + k) % 4096)]));
    u32[CPL + 1] = u32[CPL];
    return out;
  };
  const post = (words: number[]) => {
    for (const w of words) {
      u32[2 + 2 + (u32[2] % 4096)] = w;
      u32[2]++;
    }
  };
  return { u32, usb, completions, post, CPL };
}

test('an attach reports what of the device the guest doesn\'t get, and a failed one why', async () => {
  const problems = [{ kind: 'protected-interface' as const, interface: 3, class: 3 }];
  registerUsbOpener('usb', async (id) => {
    if (id.vendorId === 9) throw Object.assign(new Error('no interface left'), { problems: [{ kind: 'claim-failed', interface: 0, message: 'Unable to claim interface.' }] });
    return { speed: 'full', problems, submit() {}, cancel() {}, reset() {}, detach() {} };
  });
  const { usb } = rig(false);
  const m = await usb.attach(0, { api: 'usb', vendorId: 1, productId: 2 });
  assert.deepEqual(m.state === 'attached' && m.problems, problems);
  const f = await usb.attach(1, { api: 'usb', vendorId: 9, productId: 2 });
  assert.deepEqual(f.state === 'error' && f.detail, [{ kind: 'claim-failed', interface: 0, message: 'Unable to claim interface.' }]);
  usb.close();
});

test('a device that throws fails its TD, not the device worker', async () => {
  registerUsbOpener('usb', async () => ({
    speed: 'high',
    submit() { throw new TypeError('a bug'); },
    cancel() { throw new Error('another'); },
    reset() {},
    detach() {},
  }));
  const { usb, completions, post } = rig(false);
  const errors: unknown[] = [];
  const err = console.error;
  console.error = (...a: unknown[]) => errors.push(a);
  try {
    assert.equal((await usb.attach(0, { api: 'usb', vendorId: 1, productId: 2 })).state, 'attached');
    completions();
    // A control transfer without its setup stage (a guest's), then a cancel: both throw in the device.
    post([5, 0 | 1 << 8, 4, 0 | 4 << 16, 0, 0, 0]);
    post([0, 0 | 1 << 8 | 2 << 16, 2, 1, 6]);
    usb.poll();
    assert.deepEqual(completions(), [[5, 4 << 8, 0]], 'a transaction error');
    assert.equal(errors.length, 1);
  } finally {
    console.error = err;
  }
  usb.close();
});

test('completions wait in the glue while the core\'s ring is full', async () => {
  const { u32, usb, completions, post, CPL } = rig();
  await usb.attach(0, { api: 'virtual', kind: 'gadget-zero' });
  completions();
  // The core hasn't taken anything: 4095 words in the ring, no room for a record.
  u32[CPL] = (u32[CPL + 1] + 4095) >>> 0;
  post([7, 0 | 1 << 8, 6, 1 | 4 << 16 | 1 << 24, 18, 0x0100_0680, 18 << 16, 0x100, 18]);
  usb.poll();
  assert.equal((u32[CPL] - u32[CPL + 1]) >>> 0, 4095, 'nothing written');
  u32[CPL + 1] = u32[CPL]; // the core took them
  usb.poll();
  assert.deepEqual(completions(), [[7, 1 << 8, 18]]);
  usb.close();
});

test('a tag given again after its cancel in the same batch is the new TD\'s', async () => {
  const { usb, completions, post } = rig();
  await usb.attach(0, { api: 'virtual', kind: 'gadget-zero' });
  completions();
  const get = (tag: number) => [tag, 0 | 1 << 8, 6, 1 | 4 << 16 | 1 << 24, 18, 0x0100_0680, 18 << 16, 0x100, 18];
  post(get(9));
  post([0, 0 | 1 << 8 | 2 << 16, 2, 1, 9]);
  post(get(9));
  usb.poll();
  assert.deepEqual(completions(), [[9, 1 << 8, 18]], 'the first one never reached the device; the second did');
  usb.close();
});
