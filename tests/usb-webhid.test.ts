// The WebHID device (web/webhid.ts, docs/usb.md "The WebHID device") against a fake
// HIDDevice: the descriptors built from its collections, the HID class requests, input reports to
// IN TDs, OUT TDs to sendReport, cancel, detach and the opener.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hidItem, parseReportDescriptor, type HidCollectionInfo } from '../web/hid-descriptor.ts';
import type { Setup, UsbResult, UsbTransfer } from '../web/usb-device.ts';
import { INPUT_QUEUE, openWebHid, webHidOpener, type WebHidDevice, type WebHidDeviceLike, type WebHidInputReport } from '../web/webhid.ts';
import { UsbOpenError } from '../web/webusb.ts';

const u = (page: number, id: number) => ((page << 16) | id) >>> 0;
const col = (usagePage: number, usage: number, o: Partial<HidCollectionInfo> = {}): HidCollectionInfo =>
  ({ usagePage, usage, type: 1, children: [], inputReports: [], outputReports: [], featureReports: [], ...o });
const bytesItem = (usage: number, count: number) => hidItem({ usages: [usage], logicalMaximum: 255, reportSize: 8, reportCount: count });

/** Reports 1 (7 bytes in), 5 (31 out), 0x12 (15 feature). */
const pad = [col(1, 5, {
  inputReports: [{ reportId: 1, items: [bytesItem(u(1, 0x30), 7)] }],
  outputReports: [{ reportId: 5, items: [bytesItem(u(0xff00, 1), 31)] }],
  featureReports: [{ reportId: 0x12, items: [bytesItem(u(0xff00, 2), 15)] }],
})];
const via = [col(0xff60, 0x61, {
  inputReports: [{ reportId: 0, items: [bytesItem(u(0xff60, 0x62), 32)] }],
  outputReports: [{ reportId: 0, items: [bytesItem(u(0xff60, 0x63), 32)] }],
})];

const err = (name: string) => Object.assign(new Error(name), { name });

class FakeHid implements WebHidDeviceLike {
  vendorId = 0x054c;
  productId = 0x0ce6;
  productName = 'DualSense Wireless Controller';
  opened = false;
  collections: HidCollectionInfo[];
  listeners = new Set<(e: WebHidInputReport) => void>();
  sent: [string, number, number[]][] = [];
  sendFails = false;
  /** As Chromium: led by the report ID when the device uses IDs. */
  feature: (id: number) => Uint8Array = (id) => Uint8Array.from({ length: 16 }, (_, i) => (i === 0 ? id : 100 + i));
  log: string[] = [];
  constructor(collections: HidCollectionInfo[]) { this.collections = collections; }
  async open() { this.opened = true; this.log.push('open'); }
  async close() { this.opened = false; this.log.push('close'); }
  async sendReport(id: number, data: BufferSource) {
    this.sent.push(['output', id, [...new Uint8Array(data as ArrayBuffer)]]);
    if (this.sendFails) throw err('NotAllowedError');
  }
  async sendFeatureReport(id: number, data: BufferSource) { this.sent.push(['feature', id, [...new Uint8Array(data as ArrayBuffer)]]); }
  async receiveFeatureReport(id: number) { const b = this.feature(id); return new DataView(b.buffer, b.byteOffset, b.byteLength); }
  addEventListener(_: 'inputreport', l: (e: WebHidInputReport) => void) { this.listeners.add(l); }
  removeEventListener(_: 'inputreport', l: (e: WebHidInputReport) => void) { this.listeners.delete(l); }
  report(reportId: number, data: number[]) {
    const b = Uint8Array.from(data);
    for (const l of this.listeners) l({ reportId, data: new DataView(b.buffer) });
  }
}

const tick = () => new Promise((r) => setImmediate(r));
async function settle() { for (let i = 0; i < 4; i++) await tick(); }
let tags = 1;
function submit(d: WebHidDevice, t: Omit<UsbTransfer, 'tag'>) {
  const rec = { tag: tags++, results: [] as UsbResult[] };
  d.submit({ ...t, tag: rec.tag }, (r) => rec.results.push(r));
  return rec;
}
async function control(d: WebHidDevice, setup: Setup, data?: Uint8Array): Promise<UsbResult> {
  const r = submit(d, { ep: 0, type: 'control', setup, data, length: setup.length });
  await settle();
  assert.equal(r.results.length, 1, `one completion for request ${setup.request}`);
  return r.results[0];
}
const data = (r: UsbResult) => [...(r.data ?? [])];
const getDesc = (type: number, index: number, length: number, requestType = 0x80, wIndex = 0): Setup => ({ requestType, request: 6, value: (type << 8) | index, index: wIndex, length });

async function configured(cs: HidCollectionInfo[]) {
  const fake = new FakeHid(cs);
  const d = await openWebHid(fake, { serial: 'waarm64-hid-2' });
  assert.equal((await control(d, { requestType: 0, request: 9, value: 1, index: 0, length: 0 })).code, 'success');
  return { fake, d };
}

test('the descriptors: IDs, one HID interface, the report descriptor, endpoints sized by the reports', async () => {
  const { fake, d } = await configured(pad);
  assert.ok(fake.opened);
  assert.equal(d.speed, 'full');
  const dev = data(await control(d, getDesc(1, 0, 18)));
  assert.deepEqual(dev.slice(0, 4), [18, 1, 0x00, 0x02]);
  assert.deepEqual(dev.slice(8, 12), [0x4c, 0x05, 0xe6, 0x0c]);
  const cfg = Uint8Array.from(data(await control(d, getDesc(2, 0, 255))));
  assert.equal(cfg[2] | (cfg[3] << 8), cfg.length);
  assert.deepEqual([...cfg.subarray(9, 18)], [9, 4, 0, 0, 2, 3, 0, 0, 0], 'class 3, no boot subclass');
  const report = Uint8Array.from(data(await control(d, getDesc(0x22, 0, 1024, 0x81))));
  assert.deepEqual([...cfg.subarray(18, 27)], [9, 0x21, 0x11, 0x01, 0, 1, 0x22, report.length & 0xff, report.length >> 8]);
  assert.deepEqual(data(await control(d, getDesc(0x21, 0, 9, 0x81))), [...cfg.subarray(18, 27)]);
  assert.deepEqual(parseReportDescriptor(report), pad);
  assert.deepEqual([...cfg.subarray(27, 34)], [7, 5, 0x81, 3, 8, 0, 1], 'IN: 7 bytes and the ID, 1 ms');
  assert.deepEqual([...cfg.subarray(34, 41)], [7, 5, 0x01, 3, 32, 0, 1], 'OUT: 31 bytes and the ID');
  const str = (r: UsbResult) => String.fromCharCode(...new Uint16Array(Uint8Array.from(data(r)).buffer.slice(2)));
  assert.equal(str(await control(d, getDesc(3, dev[15], 255, 0x80, 0x0409))), 'DualSense Wireless Controller');
  assert.equal(str(await control(d, getDesc(3, dev[16], 255, 0x80, 0x0409))), 'waarm64-hid-2');
});

test('a large input report makes it high speed (bInterval 4 is 1 ms); no output reports, no OUT endpoint', async () => {
  const big = [col(0xff00, 1, { inputReports: [{ reportId: 0, items: [bytesItem(u(0xff00, 2), 100)] }] })];
  const { d } = await configured(big);
  assert.equal(d.speed, 'high');
  const cfg = data(await control(d, getDesc(2, 0, 255)));
  assert.equal(cfg[9 + 4], 1, 'one endpoint');
  assert.deepEqual(cfg.slice(27, 34), [7, 5, 0x81, 3, 100, 0, 4]);
});

test('input reports go to the oldest IN TD, ID first; queued while none waits, the oldest dropped past the limit', async () => {
  const { fake, d } = await configured(pad);
  const a = submit(d, { ep: 0x81, type: 'interrupt', length: 8 });
  const b = submit(d, { ep: 0x81, type: 'interrupt', length: 8 });
  assert.equal(a.results.length, 0);
  fake.report(1, [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(a.results.map((r) => [r.code, data(r)]), [['success', [1, 1, 2, 3, 4, 5, 6, 7]]]);
  assert.equal(b.results.length, 0);
  d.cancel(0x81, [b.tag]);
  for (let i = 0; i < INPUT_QUEUE + 3; i++) fake.report(1, [i, 0, 0, 0, 0, 0, 0]);
  assert.equal(b.results.length, 0, 'cancelled');
  const c = submit(d, { ep: 0x81, type: 'interrupt', length: 8 });
  assert.equal(data(c.results[0])[1], 3, 'the three oldest went');
  // Without report IDs the report is the data alone.
  const v = await configured(via);
  const e = submit(v.d, { ep: 0x81, type: 'interrupt', length: 32 });
  v.fake.report(0, Array.from({ length: 32 }, (_, i) => i));
  assert.equal(e.results[0].actual, 32);
  assert.equal(data(e.results[0])[31], 31);
});

test('an OUT TD is one sendReport (ID from its first byte); a rejected one stalls', async () => {
  const { fake, d } = await configured(pad);
  const a = submit(d, { ep: 0x01, type: 'interrupt', data: Uint8Array.of(5, 0xaa, 0xbb), length: 3 });
  await settle();
  assert.deepEqual(fake.sent, [['output', 5, [0xaa, 0xbb]]]);
  assert.deepEqual(a.results, [{ code: 'success', actual: 3 }]);
  fake.sendFails = true;
  const b = submit(d, { ep: 0x01, type: 'interrupt', data: Uint8Array.of(5, 1), length: 2 });
  await settle();
  assert.deepEqual(b.results, [{ code: 'stall', actual: 0 }]);
  const v = await configured(via);
  submit(v.d, { ep: 0x01, type: 'interrupt', data: Uint8Array.of(1, 2, 3), length: 3 });
  await settle();
  assert.deepEqual(v.fake.sent, [['output', 0, [1, 2, 3]]]);
});

test('HID class requests: GET_REPORT input and feature, SET_REPORT, idle and protocol', async () => {
  const { fake, d } = await configured(pad);
  const cls = (request: number, value: number, length: number, dir = 0xa1): Setup => ({ requestType: dir, request, value, index: 0, length });
  assert.deepEqual(data(await control(d, cls(1, 0x0101, 64))), [1, 0, 0, 0, 0, 0, 0, 0], 'zeros before the first report');
  fake.report(1, [9, 8, 7, 6, 5, 4, 3]);
  assert.deepEqual(data(await control(d, cls(1, 0x0101, 64))), [1, 9, 8, 7, 6, 5, 4, 3]);
  assert.equal((await control(d, cls(1, 0x0102, 64))).code, 'stall', 'no input report 2');
  const f = await control(d, cls(1, 0x0312, 16));
  assert.deepEqual(data(f).slice(0, 2), [0x12, 101], 'led by its ID, as Chromium gives it');
  assert.equal(f.actual, 16);
  assert.equal((await control(d, cls(9, 0x0205, 3, 0x21), Uint8Array.of(5, 1, 2))).code, 'success');
  assert.equal((await control(d, cls(9, 0x0312, 3, 0x21), Uint8Array.of(0x12, 3, 4))).code, 'success');
  assert.deepEqual(fake.sent, [['output', 5, [1, 2]], ['feature', 0x12, [3, 4]]]);
  assert.equal((await control(d, cls(0x0a, 0x2000, 0, 0x21))).code, 'success');
  assert.deepEqual(data(await control(d, cls(2, 0, 1))), [0x20]);
  assert.equal((await control(d, cls(0x0b, 0, 0, 0x21))).code, 'success');
  assert.deepEqual(data(await control(d, cls(3, 0, 1))), [1]);
  assert.equal((await control(d, cls(0x42, 0, 1))).code, 'stall');
  fake.sendFails = true;
  assert.equal((await control(d, cls(9, 0x0205, 2, 0x21), Uint8Array.of(5, 1))).code, 'stall');
});

test('detach closes the device and stops its reports; reset drops queued reports and TDs', async () => {
  const { fake, d } = await configured(pad);
  fake.report(1, [1, 1, 1, 1, 1, 1, 1]);
  d.reset();
  await control(d, { requestType: 0, request: 9, value: 1, index: 0, length: 0 });
  const a = submit(d, { ep: 0x81, type: 'interrupt', length: 8 });
  assert.equal(a.results.length, 0, 'the report before the reset is gone');
  d.detach();
  await settle();
  assert.equal(fake.listeners.size, 0);
  assert.ok(fake.log.includes('close'));
  fake.report(1, [2, 2, 2, 2, 2, 2, 2]);
  assert.equal(a.results.length, 0);
});

test('a device whose collections WebHID hides fails to open; the opener finds by IDs and index and reports a disconnect', async () => {
  await assert.rejects(openWebHid(new FakeHid([])), (e) => e instanceof UsbOpenError && e.problems[0].kind === 'no-collections');
  const devs = [new FakeHid(pad), new FakeHid(via), new FakeHid(pad)];
  const listeners = new Set<(e: { device: WebHidDeviceLike }) => void>();
  const hid = {
    getDevices: async () => devs,
    addEventListener: (_: 'disconnect', l: (e: { device: WebHidDeviceLike }) => void) => listeners.add(l),
    removeEventListener: (_: 'disconnect', l: (e: { device: WebHidDeviceLike }) => void) => listeners.delete(l),
  };
  let gone = 0;
  const d = await webHidOpener(hid)({ api: 'hid', vendorId: 0x054c, productId: 0x0ce6, index: 1 }, { gone: () => gone++, connector: 3 });
  assert.equal(d.dev, devs[1]);
  for (const l of [...listeners]) l({ device: devs[0] });
  assert.equal(gone, 0);
  for (const l of [...listeners]) l({ device: devs[1] });
  assert.equal(gone, 1);
  await assert.rejects(webHidOpener(hid)({ api: 'hid', vendorId: 1, productId: 1 }), UsbOpenError);
});

test('a protected collection\'s input and output reports are left out; a device with nothing else fails to open', async () => {
  const kb = (usage: number, o: Partial<HidCollectionInfo>) => col(1, usage, o);
  const leds = { reportId: 1, items: [bytesItem(u(8, 1), 1)] };
  // As Chromium shows a keyboard composite: the keyboard's top level without input and output, its feature kept; a mouse
  // whose pointer child still lists report 4.
  const cs = [
    kb(6, { featureReports: [{ reportId: 2, items: [bytesItem(u(0xff00, 9), 4)] }], children: [col(8, 0, { type: 2, outputReports: [leds] })] }),
    kb(2, { children: [col(1, 1, { type: 0, inputReports: [{ reportId: 4, items: [bytesItem(u(1, 0x30), 3)] }] })] }),
    col(0xff60, 0x61, { inputReports: [{ reportId: 5, items: [bytesItem(u(0xff60, 0x62), 32)] }] }),
  ];
  const d = await openWebHid(new FakeHid(cs));
  const got = parseReportDescriptor(d.layout.report);
  assert.deepEqual(got.map((c) => [c.usagePage, c.usage, c.children.length]), [[1, 6, 0], [0xff60, 0x61, 0]]);
  assert.deepEqual([...d.layout.sizes.output.keys()], [], 'no LED output report, so no OUT endpoint');
  assert.equal(d.layout.outMax, 0);
  assert.deepEqual(d.problems, [
    { kind: 'protected-collection', usagePage: 1, usage: 6, kept: true },
    { kind: 'protected-collection', usagePage: 1, usage: 2, kept: false },
  ], 'what the guest doesn\'t get, for the page');
  await assert.rejects(openWebHid(new FakeHid([cs[1]])), (e) => e instanceof UsbOpenError && e.problems[0].kind === 'no-collections');
});
