// The WebUSB passthrough (web/webusb.ts, docs/plans/usb.md §4) against a scripted fake USBDevice:
// the descriptor filter and the speed heuristic on transcribed descriptors of real device types,
// the standard requests it interprets, the transfer mapping, and the IN carry-over after a cancel.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  UsbOpenError, filterConfig, openWebUsb, parseConfig, pickDevice, splitDescriptors, webUsbOpener,
  type WebUsbDeviceLike, type WebUsbPassthrough,
} from '../web/webusb.ts';
import type { Setup, UsbResult, UsbTransfer } from '../web/usb-device.ts';
import { FakeUsb, namedError } from './usb/fake-webusb.ts';
import { bulk, config, device, fixtures, iad, iface, intr, str, type Fixture } from './usb/webusb-fixtures.ts';

const fx = (name: string) => fixtures.find((f) => f.name.startsWith(name))!;
const tick = () => new Promise((r) => setImmediate(r));
async function settle() { for (let i = 0; i < 5; i++) await tick(); }

let tags = 1;
/** Submits a TD and records its completions (more than one would be a bug). */
function submit(p: WebUsbPassthrough, t: Omit<UsbTransfer, 'tag'>): { tag: number; results: UsbResult[] } {
  const rec = { tag: tags++, results: [] as UsbResult[] };
  p.submit({ ...t, tag: rec.tag }, (r) => rec.results.push(r));
  return rec;
}
async function control(p: WebUsbPassthrough, setup: Setup, data?: Uint8Array): Promise<UsbResult> {
  const r = submit(p, { ep: 0, type: 'control', setup, data, length: setup.length });
  await settle();
  assert.equal(r.results.length, 1, `one completion for request ${setup.request}`);
  return r.results[0];
}
const getDesc = (type: number, index: number, length: number, lang = 0): Setup => ({ requestType: 0x80, request: 6, value: (type << 8) | index, index: lang, length });
const bytes = (r: UsbResult) => r.data ?? new Uint8Array(0);
const same = (a: Uint8Array, b: Uint8Array, what: string) => assert.ok(Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0, `${what} differs`);

async function open(f: Fixture, o: ConstructorParameters<typeof FakeUsb>[1] = {}) {
  const dev = new FakeUsb(f, o);
  const p = await openWebUsb(dev, {});
  return { dev, p };
}

for (const f of fixtures) {
  test(`${f.name} (${f.source}): speed, the protected interfaces filtered out, the rest claimed`, async () => {
    const { dev, p } = await open(f);
    assert.equal(p.speed, f.expect.speed);
    assert.deepEqual([...p.claimed].sort(), f.expect.kept);
    assert.deepEqual([...dev.claimedSet].sort(), f.expect.kept);
    assert.deepEqual(p.problems.filter((x) => x.kind === 'protected-interface').map((x) => (x as { interface: number }).interface), f.expect.protected);
    const cfg = bytes(await control(p, getDesc(2, 0, 4096)));
    assert.equal(cfg[2] | (cfg[3] << 8), cfg.length, 'wTotalLength');
    assert.equal(cfg[4], f.expect.kept.length, 'bNumInterfaces');
    assert.deepEqual([...parseConfig(cfg).interfaces.keys()].sort(), f.expect.kept);
    // Nothing of a dropped interface is left (HID class descriptors, its endpoints).
    const eps = new Set(splitDescriptors(cfg).filter((d) => d.type === 5).map((d) => d.bytes[2]));
    for (const [n, alts] of parseConfig(f.configs[0]).interfaces) for (const e of alts[0].endpoints) assert.equal(eps.has(e.address), f.expect.kept.includes(n), `endpoint ${e.address}`);
    if (f.expect.protected.length) assert.ok(!splitDescriptors(cfg).some((d) => d.type === 0x21));
    // The header alone, as Linux asks first.
    const head = await control(p, getDesc(2, 0, 9));
    assert.equal(head.code, 'success');
    same(bytes(head), cfg.subarray(0, 9), 'config header');
    // The device descriptor and the strings come from the cache: no WebUSB call after attach.
    const before = dev.log.length;
    same(bytes(await control(p, getDesc(1, 0, 18))), f.device, 'device descriptor');
    const short = await control(p, getDesc(1, 0, 64));
    assert.equal(short.code, 'short');
    assert.equal(short.actual, 18);
    for (const [k, s] of f.strings) {
      const [i, lang] = k.split(':').map(Number);
      same(bytes(await control(p, getDesc(3, i, 255, lang))), s, `string ${k}`);
    }
    if (f.bos) same(bytes(await control(p, getDesc(0x0f, 0, 255))), f.bos, 'BOS');
    else assert.equal((await control(p, getDesc(0x0f, 0, 5))).code, 'stall');
    assert.equal(dev.log.length, before, `no WebUSB calls: ${dev.log.slice(before).join(', ')}`);
  });
}

test('the BOS is read only for bcdUSB 2.01 and later, and the strings of every referenced index', async () => {
  const { dev } = await open(fx('Silicon Labs'));
  assert.ok(!dev.log.some((l) => l.startsWith('get 15:')), 'no BOS for USB 1.1');
  assert.deepEqual(dev.log.filter((l) => l.startsWith('get 3:')), ['get 3:0:0', 'get 3:1:1033', 'get 3:2:1033', 'get 3:3:1033']);
  const pico = await open(fx('Raspberry Pi Pico'));
  assert.ok(pico.dev.log.includes('get 3:5:1033'), 'the interface string of the reset interface');
});

test('an IAD loses the dropped interfaces from its range, and goes when none is left', () => {
  const raw = config(1, 0x80, 50,
    iad(0, 3, 0xef, 0, 0), iface(0, 0, 1, 0x03, 0, 0), intr(0x81, 8, 1), iface(1, 0, 1, 0xff, 0, 0), bulk(0x82, 64), iface(2, 0, 1, 0xff, 0, 0), bulk(0x03, 64),
    iad(3, 2, 0x01, 0, 0), iface(3, 0, 0, 0x01, 1, 0), iface(4, 0, 0, 0x01, 2, 0));
  const out = filterConfig(raw, new Set([0, 3, 4]));
  const ds = splitDescriptors(out);
  const iads = ds.filter((d) => d.type === 0x0b);
  assert.equal(iads.length, 1);
  assert.deepEqual([iads[0].bytes[2], iads[0].bytes[3]], [1, 2]);
  assert.equal(out[4], 2);
  assert.equal(out[2] | (out[3] << 8), out.length);
  assert.deepEqual(ds.filter((d) => d.type === 5).map((d) => d.bytes[2]), [0x82, 0x03]);
});

test('an interface the host holds is reported with the remedy and hidden; a device left with nothing fails to open', async () => {
  const { p } = await open(fx('Raspberry Pi Pico'), { hostHeld: [0, 1] });
  assert.deepEqual([...p.claimed], [2]);
  const failed = p.problems.filter((x) => x.kind === 'claim-failed');
  assert.equal(failed.length, 2);
  assert.match((failed[0] as { message: string }).message, /Unable to claim interface/, "the browser's words (the page adds the remedy)");
  const cfg = bytes(await control(p, getDesc(2, 0, 4096)));
  assert.deepEqual([...parseConfig(cfg).interfaces.keys()], [2]);
  assert.ok(!splitDescriptors(cfg).some((d) => d.type === 0x0b), 'the IAD went with CDC');
  await assert.rejects(open(fx('FTDI'), { hostHeld: [0] }), (e) => {
    assert.ok(e instanceof UsbOpenError);
    assert.deepEqual(e.problems, [{ kind: 'claim-failed', interface: 0, message: 'Unable to claim interface.' }]);
    return true;
  });
  const dev = new FakeUsb(fx('FTDI'), { hostHeld: [0] });
  await assert.rejects(openWebUsb(dev), UsbOpenError);
  assert.ok(dev.log.includes('close'), 'closed again');
});

test('an unconfigured device gets its first configuration at open', async () => {
  const { dev, p } = await open(fx('FTDI'), { configured: false });
  assert.ok(dev.log.includes('selectConfiguration 1'));
  assert.deepEqual([...p.claimed], [0]);
});

const twoConfigs: Fixture = {
  name: 'two configurations', source: 'transcribed',
  device: device({ bcdUSB: 0x0200, mps0: 64, vid: 0x1234, pid: 0x5678, bcdDevice: 1, configs: 2 }),
  configs: [
    config(1, 0x80, 50, iface(0, 0, 1, 0xff, 0, 0), bulk(0x81, 512), iface(0, 1, 2, 0xff, 0, 0), bulk(0x81, 512), bulk(0x01, 512)),
    config(2, 0x80, 50, iface(0, 0, 0, 0xff, 0, 0), iface(1, 0, 1, 0xff, 0, 0), bulk(0x82, 512)),
  ],
  strings: new Map(), expect: { speed: 'high', protected: [], kept: [0] },
};

test('SET_CONFIGURATION: the same one re-claims nothing, another selects and re-claims, 0 releases', async () => {
  const { dev, p } = await open(twoConfigs);
  let mark = dev.log.length;
  const set = (v: number) => control(p, { requestType: 0, request: 9, value: v, index: 0, length: 0 });
  assert.equal((await set(1)).code, 'success');
  assert.deepEqual(dev.log.slice(mark), []);
  assert.equal((await set(0)).code, 'success');
  assert.deepEqual(dev.log.slice(mark), ['release 0']);
  assert.deepEqual(bytes(await control(p, { requestType: 0x80, request: 8, value: 0, index: 0, length: 1 })), Uint8Array.of(0));
  mark = dev.log.length;
  await set(1);
  assert.deepEqual(dev.log.slice(mark), ['claim 0']);
  mark = dev.log.length;
  await set(2);
  assert.deepEqual(dev.log.slice(mark), ['release 0', 'selectConfiguration 2', 'claim 0', 'claim 1']);
  assert.equal((await set(7)).code, 'stall');
});

test('SET_INTERFACE, CLEAR_FEATURE(HALT) and the requests answered locally', async () => {
  const { dev, p } = await open(twoConfigs);
  const mark = dev.log.length;
  assert.equal((await control(p, { requestType: 1, request: 11, value: 1, index: 0, length: 0 })).code, 'success');
  assert.equal((await control(p, { requestType: 1, request: 11, value: 5, index: 0, length: 0 })).code, 'stall', 'no such alternate');
  assert.equal((await control(p, { requestType: 1, request: 11, value: 0, index: 3, length: 0 })).code, 'stall', 'no such interface');
  assert.equal((await control(p, { requestType: 2, request: 1, value: 0, index: 0x81, length: 0 })).code, 'success');
  assert.equal((await control(p, { requestType: 0, request: 3, value: 1, index: 0, length: 0 })).code, 'success', 'remote wakeup');
  assert.equal((await control(p, { requestType: 0, request: 1, value: 48, index: 0, length: 0 })).code, 'success', 'U1 enable');
  assert.equal((await control(p, { requestType: 0, request: 48, value: 0, index: 0, length: 6 }, new Uint8Array(6))).code, 'success', 'SET_SEL');
  assert.equal((await control(p, { requestType: 0, request: 49, value: 40, index: 0, length: 0 })).code, 'success', 'SET_ISOCH_DELAY');
  assert.deepEqual(dev.log.slice(mark), ['alt 0 1', 'clearHalt in 1']);
  assert.equal(dev.controlOuts.length, 0, 'no standard OUT request reached WebUSB');
  // SET_CONFIGURATION with the same value puts the alternate back to 0.
  await control(p, { requestType: 0, request: 9, value: 1, index: 0, length: 0 });
  assert.equal(dev.log.at(-1), 'alt 0 0');
});

test('GET_STATUS and class and vendor requests pass through with their recipient; a hidden interface stalls', async () => {
  const { dev, p } = await open(fx('DAPLink'));
  dev.controlIn = async (s, length) => ({ status: 'ok', data: new DataView(Uint8Array.from({ length }, (_, i) => i + s.request).buffer) });
  const st = await control(p, { requestType: 0x80, request: 0, value: 0, index: 0, length: 2 });
  assert.equal(st.code, 'success');
  assert.equal(dev.log.at(-1), 'controlIn standard/device 0 0 0 2');
  await control(p, { requestType: 0xc0, request: 0x20, value: 5, index: 0, length: 4 });
  assert.equal(dev.log.at(-1), 'controlIn vendor/device 32 5 0 4');
  await control(p, { requestType: 0xa1, request: 0x21, value: 0, index: 1, length: 7 });
  assert.equal(dev.log.at(-1), 'controlIn class/interface 33 0 1 7');
  // SET_LINE_CODING to the CDC interface.
  const line = Uint8Array.of(0x00, 0xc2, 0x01, 0x00, 0, 0, 8);
  const r = await control(p, { requestType: 0x21, request: 0x20, value: 0, index: 1, length: 7 }, line);
  assert.deepEqual(r, { code: 'success', actual: 7 });
  same(dev.controlOuts.at(-1)!.data, line, 'line coding');
  assert.equal(dev.controlOuts.at(-1)!.setup.recipient, 'interface');
  // The HID interface (3) isn't the guest's: a request to it stalls without reaching WebUSB.
  const n = dev.log.length;
  assert.equal((await control(p, { requestType: 0xa1, request: 1, value: 0x0100, index: 3, length: 64 })).code, 'stall');
  assert.equal(dev.log.length, n);
  // A stall from the device is a stall.
  dev.controlIn = async () => ({ status: 'stall' });
  assert.equal((await control(p, { requestType: 0xc0, request: 1, value: 0, index: 0, length: 4 })).code, 'stall');
});

test('bulk OUT: the gathered data, an empty transfer for a zero-length TD, results to codes', async () => {
  const { dev, p } = await open(fx('FTDI'));
  const a = submit(p, { ep: 0x02, type: 'bulk', data: Uint8Array.from({ length: 128 }, (_, i) => i), length: 128 });
  await settle();
  assert.deepEqual(dev.outs.map((o) => [o.ep, o.data.length]), [[2, 128]]);
  assert.deepEqual(a.results, [{ code: 'success', actual: 128 }]);
  // Linux queues URB_ZERO_PACKET's ZLP as a TD of its own: a length-0 OUT TD is an empty transferOut.
  const z = submit(p, { ep: 0x02, type: 'bulk', length: 0 });
  await settle();
  assert.deepEqual(dev.outs.at(-1)!.data.length, 0);
  assert.deepEqual(z.results, [{ code: 'success', actual: 0 }]);
  dev.outScript = async () => ({ status: 'stall', bytesWritten: 0 });
  const b = submit(p, { ep: 0x02, type: 'bulk', data: new Uint8Array(3), length: 3 });
  await settle();
  dev.outScript = async () => { throw namedError('NetworkError', 'transfer error'); };
  const c = submit(p, { ep: 0x02, type: 'bulk', data: new Uint8Array(3), length: 3 });
  await settle();
  assert.deepEqual(b.results, [{ code: 'stall', actual: 0 }]);
  assert.deepEqual(c.results, [{ code: 'error', actual: 0 }]);
});

test('OUT TDs complete in submit order whatever order WebUSB resolves them in', async () => {
  const { dev, p } = await open(fx('FTDI'));
  const resolvers: (() => void)[] = [];
  dev.outScript = (_ep, data) => new Promise((res) => resolvers.push(() => res({ status: 'ok', bytesWritten: data.length })));
  const order: number[] = [];
  for (let i = 0; i < 3; i++) p.submit({ tag: 100 + i, ep: 2, type: 'bulk', data: new Uint8Array(i + 1), length: i + 1 }, () => order.push(100 + i));
  await settle();
  resolvers[2](); resolvers[0](); await settle();
  assert.deepEqual(order, [100]);
  resolvers[1](); await settle();
  assert.deepEqual(order, [100, 101, 102]);
});

test('bulk IN: data, short, stall, babble, a lost device', async () => {
  let gone = 0;
  const dev = new FakeUsb(fx('Realtek'));
  const p = await openWebUsb(dev, { gone: () => gone++ });
  const a = submit(p, { ep: 0x81, type: 'bulk', length: 512 });
  const b = submit(p, { ep: 0x81, type: 'bulk', length: 512 });
  const c = submit(p, { ep: 0x81, type: 'bulk', length: 4 });
  const d = submit(p, { ep: 0x81, type: 'bulk', length: 512 });
  await settle();
  assert.equal(dev.pending(1), 4);
  dev.answer(1, { data: new Uint8Array(512).fill(7) });
  dev.answer(1, { data: new Uint8Array(100) });
  dev.answer(1, { status: 'babble', data: new Uint8Array(4) });
  dev.answer(1, { status: 'stall' });
  await settle();
  assert.deepEqual(a.results.map((r) => [r.code, r.actual]), [['success', 512]]);
  assert.deepEqual(b.results.map((r) => [r.code, r.actual]), [['short', 100]]);
  assert.deepEqual(c.results.map((r) => [r.code, r.actual]), [['babble', 4]]);
  assert.deepEqual(d.results.map((r) => [r.code, r.actual]), [['stall', 0]]);
  const e = submit(p, { ep: 0x81, type: 'bulk', length: 512 });
  await settle();
  dev.answer(1, namedError('NotFoundError', 'The device was disconnected.'));
  await settle();
  assert.deepEqual(e.results, [{ code: 'error', actual: 0 }]);
  assert.equal(gone, 1);
});

const payload = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff);

test('IN data outlives a cancel: the next TD gets the orphan\'s bytes, and no new transfer is issued for it', async () => {
  const { dev, p } = await open(fx('FTDI'));
  const a = submit(p, { ep: 0x81, type: 'bulk', length: 64 });
  await settle();
  assert.equal(dev.pending(1), 1);
  p.cancel(0x81, [a.tag]);
  const b = submit(p, { ep: 0x81, type: 'bulk', length: 64 });
  await settle();
  assert.equal(dev.pending(1), 1, 'the orphan serves the next TD');
  const x = payload(10, 1);
  dev.answer(1, { data: x });
  await settle();
  assert.equal(a.results.length, 0, 'the cancelled TD never completes');
  assert.equal(b.results.length, 1);
  same(bytes(b.results[0]), x, 'carried data');
  assert.equal(b.results[0].code, 'short');
  submit(p, { ep: 0x81, type: 'bulk', length: 64 });
  await settle();
  assert.equal(dev.pending(1), 1, 'a fresh transfer for the next TD');
});

test('carry-over keeps the order across several cancelled transfers, and serves a later TD at once', async () => {
  const { dev, p } = await open(fx('FTDI'));
  const tds = [0, 1, 2].map(() => submit(p, { ep: 0x81, type: 'bulk', length: 64 }));
  await settle();
  assert.equal(dev.pending(1), 3);
  p.cancel(0x81, [tds[0].tag, tds[1].tag]);
  const d = submit(p, { ep: 0x81, type: 'bulk', length: 64 });
  await settle();
  assert.equal(dev.pending(1), 3);
  const xs = [payload(64, 1), payload(20, 2), payload(33, 3)];
  for (const x of xs) dev.answer(1, { data: x });
  await settle();
  same(bytes(tds[2].results[0]), xs[0], 'first');
  same(bytes(d.results[0]), xs[1], 'second');
  assert.equal(dev.pending(1), 0);
  const e = submit(p, { ep: 0x81, type: 'bulk', length: 64 });
  assert.equal(e.results.length, 1, 'served from the carry-over before submit returns');
  same(bytes(e.results[0]), xs[2], 'third');
  // An orphan that resolves with nothing for anyone: kept if it has data, dropped if empty or an error.
  const f = submit(p, { ep: 0x81, type: 'bulk', length: 64 });
  const g = submit(p, { ep: 0x81, type: 'bulk', length: 64 });
  const h = submit(p, { ep: 0x81, type: 'bulk', length: 64 });
  await settle();
  p.cancel(0x81, [f.tag, g.tag, h.tag]);
  dev.answer(1, { data: new Uint8Array(0) });
  dev.answer(1, namedError('NetworkError', 'transfer error'));
  const y = payload(5, 9);
  dev.answer(1, { data: y });
  await settle();
  const i = submit(p, { ep: 0x81, type: 'bulk', length: 64 });
  assert.equal(dev.pending(1), 0);
  same(bytes(i.results[0]), y, 'only the data survived');
});

test('a carried-over chunk larger than the next TD is split, nothing lost', async () => {
  const { dev, p } = await open(fx('FTDI'));
  const a = submit(p, { ep: 0x81, type: 'bulk', length: 64 });
  await settle();
  p.cancel(0x81, [a.tag]);
  const x = payload(64, 4);
  dev.answer(1, { data: x });
  await settle();
  const b = submit(p, { ep: 0x81, type: 'bulk', length: 16 });
  const c = submit(p, { ep: 0x81, type: 'bulk', length: 64 });
  assert.deepEqual([b.results[0].code, b.results[0].actual, c.results[0].code, c.results[0].actual], ['success', 16, 'short', 48]);
  same(Buffer.concat([bytes(b.results[0]), bytes(c.results[0])]), x, 'split');
});

test('a stall carried over reaches the next TD, and CLEAR_FEATURE(HALT) spends it', async () => {
  const { dev, p } = await open(fx('FTDI'));
  const a = submit(p, { ep: 0x81, type: 'bulk', length: 64 });
  await settle();
  p.cancel(0x81, [a.tag]);
  dev.answer(1, { status: 'stall' });
  await settle();
  assert.equal(submit(p, { ep: 0x81, type: 'bulk', length: 64 }).results[0].code, 'stall');
  const b = submit(p, { ep: 0x81, type: 'bulk', length: 64 });
  await settle();
  p.cancel(0x81, [b.tag]);
  dev.answer(1, { status: 'stall' });
  await settle();
  await control(p, { requestType: 2, request: 1, value: 0, index: 0x81, length: 0 });
  const c = submit(p, { ep: 0x81, type: 'bulk', length: 64 });
  assert.equal(c.results.length, 0);
  await settle();
  assert.equal(dev.pending(1), 1);
});

test('interrupt endpoints work the same; endpoints dropped at Configure Endpoint lose their state', async () => {
  const { dev, p } = await open(fx('Raspberry Pi Pico'));
  const a = submit(p, { ep: 0x81, type: 'interrupt', length: 8 });
  await settle();
  p.cancel(0x81, [a.tag]);
  p.configured([{ ep: 0x02, type: 'bulk', maxPacket: 64, interval: 0 }, { ep: 0x82, type: 'bulk', maxPacket: 64, interval: 0 }]);
  dev.answer(1, { data: Uint8Array.of(0xa1, 0x20) });
  await settle();
  const b = submit(p, { ep: 0x81, type: 'interrupt', length: 8 });
  await settle();
  assert.equal(b.results.length, 0, 'the old endpoint\'s orphan went with it');
  assert.equal(dev.pending(1), 1);
});

test('detach: no completion after it, the interfaces released and the device closed', async () => {
  const { dev, p } = await open(fx('Android'));
  const a = submit(p, { ep: 0x81, type: 'bulk', length: 512 });
  await settle();
  p.detach();
  dev.answer(1, { data: new Uint8Array(512) });
  await settle();
  assert.equal(a.results.length, 0);
  assert.deepEqual(dev.log.slice(-3), ['release 0', 'release 1', 'close']);
  p.submit({ tag: 9, ep: 0, type: 'control', setup: getDesc(1, 0, 18), length: 18 }, () => assert.fail('after detach'));
  await settle();
});

test('reset: device.reset(), outstanding TDs dropped; a reset that loses the device reports it gone', async () => {
  let gone = 0;
  const dev = new FakeUsb(fx('Silicon Labs'));
  const p = await openWebUsb(dev, { gone: () => gone++ });
  const a = submit(p, { ep: 0x81, type: 'bulk', length: 64 });
  await settle();
  p.reset();
  await settle();
  assert.ok(dev.log.includes('reset'));
  dev.answer(1, { data: new Uint8Array(4) });
  await settle();
  assert.equal(a.results.length, 0);
  assert.equal(gone, 0);
  dev.resetFails = true;
  p.reset();
  await settle();
  assert.equal(gone, 1);
});

test('the opener finds the device by vendor, product and serial, or by index among serial-less ones', async () => {
  const f = fx('FTDI');
  const devs = [new FakeUsb(f, { serial: 'A1' }), new FakeUsb(f), new FakeUsb(f), new FakeUsb(fx('Silicon Labs'))];
  const id = { api: 'usb' as const, vendorId: 0x0403, productId: 0x6001 };
  assert.equal(pickDevice(devs, { ...id, serialNumber: 'A1' }), devs[0]);
  assert.equal(pickDevice(devs, id), devs[1]);
  assert.equal(pickDevice(devs, { ...id, index: 1 }), devs[2]);
  assert.equal(pickDevice(devs, { ...id, serialNumber: 'nope' }), undefined);
  const listeners = new Set<(e: { device: WebUsbDeviceLike }) => void>();
  const usb = {
    getDevices: async () => devs,
    addEventListener: (_: 'disconnect', l: (e: { device: WebUsbDeviceLike }) => void) => listeners.add(l),
    removeEventListener: (_: 'disconnect', l: (e: { device: WebUsbDeviceLike }) => void) => listeners.delete(l),
  };
  let gone = 0;
  const p = await webUsbOpener(usb)({ ...id, index: 1 }, { gone: () => gone++ });
  assert.equal(p.dev, devs[2]);
  for (const l of [...listeners]) l({ device: devs[1] });
  assert.equal(gone, 0);
  for (const l of [...listeners]) l({ device: devs[2] });
  for (const l of [...listeners]) l({ device: devs[2] });
  assert.equal(gone, 1);
  assert.equal(listeners.size, 0);
  await assert.rejects(webUsbOpener(usb)({ api: 'usb', vendorId: 1, productId: 2 }), UsbOpenError);
});

test('strings outside the cache pass through (a Microsoft OS string, an index only a class descriptor names)', async () => {
  const { dev, p } = await open(fx('FTDI'));
  const r = await control(p, getDesc(3, 0xee, 18, 0));
  assert.equal(r.code, 'stall');
  assert.equal(dev.log.at(-1), 'get 3:238:0');
  void str;
});

test('SET_FEATURE(ENDPOINT_HALT) is ours (WebUSB refuses it): TDs stall and GET_STATUS says halted until CLEAR_FEATURE; endpoint 0 is answered here', async () => {
  const { dev, p } = await open(fx('FTDI'));
  const mark = dev.log.length;
  assert.equal((await control(p, { requestType: 2, request: 3, value: 0, index: 0x81, length: 0 })).code, 'success');
  assert.equal(submit(p, { ep: 0x81, type: 'bulk', length: 64 }).results[0].code, 'stall');
  same(bytes(await control(p, { requestType: 0x82, request: 0, value: 0, index: 0x81, length: 2 })), Uint8Array.of(1, 0), 'halted status');
  same(bytes(await control(p, { requestType: 0x82, request: 0, value: 0, index: 0, length: 2 })), Uint8Array.of(0, 0), 'endpoint 0 status');
  assert.equal((await control(p, { requestType: 2, request: 1, value: 0, index: 0, length: 0 })).code, 'success', 'CLEAR_FEATURE(HALT) on endpoint 0');
  assert.deepEqual(dev.log.slice(mark), [], 'none of it reached WebUSB');
  assert.equal(dev.controlOuts.length, 0);
  await control(p, { requestType: 2, request: 1, value: 0, index: 0x81, length: 0 });
  assert.deepEqual(dev.log.slice(mark), ['clearHalt in 1']);
  const a = submit(p, { ep: 0x81, type: 'bulk', length: 64 });
  await settle();
  assert.equal(dev.pending(1), 1, 'to the device again');
  dev.answer(1, { data: new Uint8Array(3) });
  await settle();
  assert.equal(a.results[0].code, 'short');
  // GET_STATUS of an endpoint that isn't halted here is the device's.
  dev.controlIn = async () => ({ status: 'ok', data: new DataView(new Uint8Array(2).buffer) });
  await control(p, { requestType: 0x82, request: 0, value: 0, index: 0x02, length: 2 });
  assert.equal(dev.log.at(-1), 'controlIn standard/endpoint 0 0 2 2');
});
