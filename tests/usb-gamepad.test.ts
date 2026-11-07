// The game pad of ours (web/usb-gamepad.ts; docs/usb.md "The game pad") in Node: its descriptors, its report read
// back through its own report descriptor (web/hid-descriptor.ts's parse), the standard mapping's buttons, hat, sticks
// and triggers, the page's `usb-pad` messages through the glue (web/usb.ts), and the page's feed (web/app/gamepads.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseReportDescriptor, reportSizes } from '../web/hid-descriptor.ts';
import type { UsbResult } from '../web/usb-device.ts';
import { BUTTONS, GAMEPAD_PRODUCT, GAMEPAD_VENDOR, PAD_REPORT, REPORT_LENGTH, UsbGamepad, hat, padReport, type PadState } from '../web/usb-gamepad.ts';
import { Usb } from '../web/usb.ts';
import { listPads, padName, PadFeed, padState, POLL_MS, REST, type PadLike } from '../web/app/gamepads.ts';

let tag = 0;
const control = (d: UsbGamepad, requestType: number, request: number, value: number, index: number, length: number, data?: Uint8Array) =>
  new Promise<UsbResult>((resolve) => d.submit({ tag: ++tag, ep: 0, type: 'control', setup: { requestType, request, value, index, length }, data, length }, resolve));
/** An IN TD on 0x81: its result once there is one (undefined while it waits). */
function poll(d: UsbGamepad, length = 16) {
  const box: { r?: UsbResult; tag: number } = { tag: ++tag };
  d.submit({ tag: box.tag, ep: 0x81, type: 'interrupt', length }, (r) => { box.r = r; });
  return box;
}
const string = (d: Uint8Array) => String.fromCharCode(...new Uint16Array(d.slice(2).buffer));
const pad = (o: Partial<PadState>): PadState => ({ pressed: 0, values: [], axes: [], ...o });
const press = (...buttons: number[]) => buttons.reduce((m, b) => m | 1 << b, 0);

/** The report's fields by usage (page << 16 | id), read through the report descriptor's parse as a host would. */
function fields(report: Uint8Array): Map<number, number> {
  const [c] = parseReportDescriptor(PAD_REPORT);
  const out = new Map<number, number>();
  let bit = 0;
  for (const item of c.inputReports[0].items) {
    for (let k = 0; k < item.reportCount; k++, bit += item.reportSize) {
      if (item.isConstant) continue;
      let v = 0;
      for (let b = 0; b < item.reportSize; b++) v |= (report[(bit + b) >> 3] >> ((bit + b) & 7) & 1) << b;
      if (item.logicalMinimum < 0 && v & (1 << (item.reportSize - 1))) v -= 1 << item.reportSize;
      out.set(item.isRange ? item.usageMinimum + k : item.usages[k], v);
    }
  }
  return out;
}
const BUTTON = (n: number) => 0x9_0000 | n;
const GD = (id: number) => 0x1_0000 | id;

test('the game pad describes itself as a HID game pad of ours', async () => {
  const d = new UsbGamepad({ name: 'Xbox 360 Controller', serial: 'webpc-pad-1' });
  assert.equal(d.speed, 'full');
  const dev = (await control(d, 0x80, 6, 0x100, 0, 18)).data!;
  assert.deepEqual([dev[4], dev[7], dev[8] | dev[9] << 8, dev[10] | dev[11] << 8], [0, 8, GAMEPAD_VENDOR, GAMEPAD_PRODUCT]);
  assert.equal(string((await control(d, 0x80, 6, 0x302, 0x409, 255)).data!), 'Xbox 360 Controller');
  assert.equal(string((await control(d, 0x80, 6, 0x303, 0x409, 255)).data!), 'webpc-pad-1');
  assert.equal(string((await control(new UsbGamepad(), 0x80, 6, 0x302, 0x409, 255)).data!), 'webpc game pad');
  const c = (await control(d, 0x80, 6, 0x200, 0, 255)).data!;
  assert.equal(c[2] | c[3] << 8, c.length);
  assert.deepEqual([...c.subarray(9 + 5, 9 + 8)], [3, 0, 0], 'class 3, no boot protocol');
  assert.deepEqual([...c.subarray(18, 27)], [9, 0x21, 0x11, 0x01, 0, 1, 0x22, PAD_REPORT.length, 0]);
  assert.deepEqual([...c.subarray(27)], [7, 5, 0x81, 3, 16, 0, 4]);
  const rd = await control(d, 0x81, 6, 0x2200, 0, 255);
  assert.equal(Buffer.compare(rd.data!, PAD_REPORT), 0);
  assert.equal((await control(d, 0x81, 6, 0x2100, 0, 9)).data!.length, 9);
  assert.equal((await control(d, 0x81, 6, 0x2200, 1, 255)).code, 'stall', 'no interface 1');
});

test('the report descriptor is one Game Pad collection whose input report is the report\'s layout', () => {
  const cs = parseReportDescriptor(PAD_REPORT);
  assert.equal(cs.length, 1);
  assert.deepEqual([cs[0].usagePage, cs[0].usage, cs[0].type], [1, 5, 1], 'Generic Desktop, Game Pad, Application');
  assert.deepEqual(cs[0].outputReports, []);
  assert.deepEqual(cs[0].featureReports, []);
  const sizes = reportSizes(cs);
  assert.deepEqual([...sizes.input], [[0, REPORT_LENGTH]], 'one input report, no ID');
  const items = cs[0].inputReports[0].items;
  const h = items.find((i) => i.usages.includes(GD(0x39)))!;
  assert.deepEqual([h.logicalMinimum, h.logicalMaximum, h.physicalMinimum, h.physicalMaximum, h.hasNull, h.unitSystem], [0, 7, 0, 315, true, 'english-rotation']);
  const sticks = items.find((i) => i.usages.includes(GD(0x30)))!;
  assert.deepEqual([sticks.usages, sticks.logicalMinimum, sticks.logicalMaximum, sticks.physicalMaximum], [[GD(0x30), GD(0x31), GD(0x33), GD(0x34)], -32767, 32767, 0]);
  const triggers = items.find((i) => i.usages.includes(GD(0x32)))!;
  assert.deepEqual([triggers.usages, triggers.logicalMinimum, triggers.logicalMaximum], [[GD(0x32), GD(0x35)], 0, 255]);
});

test('the standard mapping lands where Linux\'s game pad codes are', () => {
  // hid-input: button n of a Game Pad is BTN_GAMEPAD + n - 1 (A B C X Y Z TL TR TL2 TR2 SELECT START MODE THUMBL THUMBR).
  const codes = ['A', 'B', 'C', 'X', 'Y', 'Z', 'TL', 'TR', 'TL2', 'TR2', 'SELECT', 'START', 'MODE', 'THUMBL', 'THUMBR'];
  const standard = ['A', 'B', 'X', 'Y', 'TL', 'TR', 'TL2', 'TR2', 'SELECT', 'START', 'THUMBL', 'THUMBR', '', '', '', '', 'MODE'];
  assert.deepEqual(BUTTONS.map((b) => (b ? codes[b - 1] : '')), standard);
  // Each button alone: its bit, nothing else.
  standard.forEach((code, i) => {
    if (!code) return;
    const f = fields(padReport(pad({ pressed: press(i) })));
    for (let n = 1; n <= 15; n++) assert.equal(f.get(BUTTON(n)), codes[n - 1] === code ? 1 : 0, `standard button ${i} → ${code}, HID button ${n}`);
    assert.equal(f.get(GD(0x39)), 8, 'the hat at rest');
  });
  // The D-pad is the hat: up 0, clockwise; opposite buttons cancel.
  const dpad = (...b: number[]) => fields(padReport(pad({ pressed: press(...b) }))).get(GD(0x39));
  assert.deepEqual([dpad(12), dpad(12, 15), dpad(15), dpad(13, 15), dpad(13), dpad(13, 14), dpad(14), dpad(12, 14)], [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(dpad(12, 13), 8);
  assert.equal(dpad(12, 13, 15), 2);
  assert.equal(hat(false, false, true, true), 8);
  // Sticks and triggers: scaled, clamped, NaN centred.
  const f = fields(padReport(pad({ axes: [-1, 1, 0.5, -0.25, 0.9], values: [0, 0, 0, 0, 0, 0, 0.5, 2], pressed: press(7) })));
  assert.deepEqual([GD(0x30), GD(0x31), GD(0x33), GD(0x34), GD(0x32), GD(0x35)].map((u) => f.get(u)), [-32767, 32767, 16384, -8192, 128, 255]);
  assert.equal(f.get(BUTTON(10)), 1, 'TR2 pressed');
  const g = fields(padReport(pad({ axes: [Number.NaN, 7, -7], values: [0, 0, 0, 0, 0, 0, -1] })));
  assert.deepEqual([g.get(GD(0x30)), g.get(GD(0x31)), g.get(GD(0x33)), g.get(GD(0x34)), g.get(GD(0x32))], [0, 32767, -32767, 0, 0]);
});

test('changes become reports, in order, to the IN TDs; GET_REPORT, idle, cancel and reset', async () => {
  const d = new UsbGamepad();
  d.pad(pad({ pressed: press(0) }));
  assert.equal(d.report()[0], 1, 'unconfigured: the state is kept');
  assert.equal((await control(d, 0x00, 9, 1, 0, 0)).code, 'success');
  const first = poll(d);
  assert.equal(first.r, undefined, 'nothing changed since: the TD waits');
  d.pad(pad({ pressed: press(0, 1) }));
  const got1 = first.r as UsbResult | undefined; // (assert.equal above narrowed it to undefined)
  assert.equal(got1?.actual, REPORT_LENGTH);
  assert.deepEqual([...got1!.data!.subarray(0, 3)], [3, 0, 8]);
  // The same state again is no report; changes with no TD queued wait in order (a press and its release both arrive).
  d.pad(pad({ pressed: press(0, 1) }));
  d.pad(pad({ pressed: press(1) }));
  d.pad(pad({ pressed: 0 }));
  assert.deepEqual([...poll(d).r!.data!.subarray(0, 2)], [2, 0]);
  assert.deepEqual([...poll(d).r!.data!.subarray(0, 2)], [0, 0]);
  const idle = poll(d);
  assert.equal(idle.r, undefined);
  d.cancel(0x81, [idle.tag]);
  d.pad(pad({ axes: [1] }));
  assert.equal(idle.r, undefined, 'a cancelled TD isn\'t the next report\'s');
  assert.equal(Buffer.compare(poll(d).r!.data!, padReport(pad({ axes: [1] }))), 0);
  // Forty changes unread: the newest 32 wait.
  for (let i = 1; i <= 40; i++) d.pad(pad({ axes: [i / 64] }));
  const got = Array.from({ length: 33 }, () => poll(d));
  assert.equal(got.filter((b) => b.r).length, 32);
  assert.equal(Buffer.compare(got[31].r!.data!, padReport(pad({ axes: [40 / 64] }))), 0);
  d.cancel(0x81, [got[32].tag]);
  // GET_REPORT is the state now; a short IN takes what fits.
  assert.equal(Buffer.compare((await control(d, 0xa1, 0x01, 0x0100, 0, REPORT_LENGTH)).data!, d.report()), 0);
  assert.equal((await control(d, 0xa1, 0x01, 0x0300, 0, 8)).code, 'stall', 'no feature report');
  assert.equal((await control(d, 0xa1, 0x03, 0, 0, 1)).code, 'stall', 'no boot protocol');
  assert.equal((await control(d, 0x21, 0x0a, 0x7d00, 0, 0)).code, 'success');
  assert.deepEqual([...(await control(d, 0xa1, 0x02, 0, 0, 1)).data!], [0x7d]);
  d.pad(pad({ axes: [-1] }));
  assert.equal(poll(d, 4).r?.data?.length, 4);
  // A reset forgets what waited.
  d.pad(pad({ axes: [0.5] }));
  d.reset();
  await control(d, 0x00, 9, 1, 0, 0);
  assert.equal(poll(d).r, undefined);
  assert.deepEqual([...(await control(d, 0xa1, 0x02, 0, 0, 1)).data!], [0], 'idle back to 0');
});

test('the page\'s usb-pad messages reach the game pad through the glue', async () => {
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
  const channel = new MessageChannel();
  const usb = new Usb({ memory, shared: 0, ram: 65536, ramSize: 65536, deterministic: false, kick: () => {}, port: channel.port1 });
  const answers: unknown[] = [];
  channel.port2.onmessage = (e) => answers.push(e.data);
  try {
    const device = { api: 'virtual', kind: 'gamepad', index: 0, name: 'Pad' } as const;
    channel.port2.postMessage({ type: 'usb-attach', connector: 1, device });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(answers, [{ type: 'usb-state', connector: 1, state: 'attached', device, speed: 'full' }]);
    const gp = (usb as unknown as { plugged: { dev: UsbGamepad }[] }).plugged[1].dev;
    assert.equal(string((await control(gp, 0x80, 6, 0x303, 0x409, 255)).data!), 'webpc-pad-1', 'the serial is the connector\'s');
    channel.port2.postMessage({ type: 'usb-pad', connector: 1, pad: pad({ pressed: press(9), axes: [0, -1] }) });
    channel.port2.postMessage({ type: 'usb-pad', connector: 2, pad: pad({ pressed: press(0) }) });
    await new Promise((r) => setTimeout(r, 20));
    const f = fields(gp.report());
    assert.deepEqual([f.get(BUTTON(12)), f.get(BUTTON(1)), f.get(GD(0x31))], [1, 0, -32767]);
    assert.equal(answers.length, 1, 'states get no answer');
  } finally {
    usb.close();
    channel.port2.close();
  }
});

test('the page\'s feed: pad names, states, a send per change, at rest while hidden or gone', async () => {
  assert.equal(padName('Microsoft X-Box 360 pad (STANDARD GAMEPAD Vendor: 045e Product: 028e)'), 'Microsoft X-Box 360 pad');
  assert.equal(padName('Xbox 360 Controller (XInput STANDARD GAMEPAD)'), 'Xbox 360 Controller');
  assert.equal(padName('(weird)'), '(weird)');
  const button = (pressed: boolean, value = pressed ? 1 : 0) => ({ pressed, value });
  const g = { index: 1, id: 'Pad (STANDARD GAMEPAD)', connected: true, buttons: [button(true), button(false), button(false, 0.25)], axes: [0.5, -0.5, 0, 0, 1] };
  assert.deepEqual(padState(g), { pressed: 1, values: [1, 0, 0.25], axes: [0.5, -0.5, 0, 0] });
  assert.equal(padState({ ...g, buttons: Array.from({ length: 32 }, () => button(true)) }).pressed, 0xffff_ffff);
  let pads: (PadLike | null)[] = [null, g];
  let hidden = false;
  assert.deepEqual(listPads(() => pads), [{ index: 1, name: 'Pad' }]);
  const sent: [number, PadState][] = [];
  const feed = new PadFeed((c, s) => sent.push([c, s]), { read: () => pads, hidden: () => hidden });
  try {
    feed.set(new Map([[2, 1]]));
    assert.deepEqual(sent, [[2, padState(g)]], 'the state at once');
    feed.tick();
    assert.equal(sent.length, 1, 'unchanged: nothing');
    pads = [null, { ...g, axes: [0.75] }];
    feed.tick();
    assert.deepEqual(sent.at(-1), [2, { ...padState(g), axes: [0.75] }]);
    hidden = true;
    feed.tick();
    assert.deepEqual(sent.at(-1), [2, REST], 'hidden: at rest');
    hidden = false;
    pads = [null, null];
    feed.tick();
    assert.equal(sent.length, 3, 'gone: still at rest, nothing new');
    pads = [null, { ...g, index: 0 }];
    feed.tick();
    assert.equal(sent.length, 3, 'another pad at that place isn\'t it');
    // Polled while attached: a change is sent within the poll's period.
    pads = [null, g];
    await new Promise((r) => setTimeout(r, POLL_MS * 4));
    assert.deepEqual(sent.at(-1), [2, padState(g)]);
    feed.stop();
    pads = [null, { ...g, axes: [] }];
    await new Promise((r) => setTimeout(r, POLL_MS * 4));
    assert.equal(sent.length, 4, 'stopped: not polled');
    assert.deepEqual(listPads(() => []), []);
  } finally {
    feed.stop();
  }
});
