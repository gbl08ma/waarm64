// The game pad of ours (web/usb-gamepad.ts, a wired Xbox 360 controller; docs/usb.md "The game pad") in Node: its
// descriptors as xpad matches them; its report read as xpad reads it, into Linux's game pad codes; the whole way a
// standard pad's state takes to a web page in the guest (xpad's codes, joydev's order, Chromium's mapping for the pad)
// coming back as that state; reports in order; the OUT endpoint's rumble and LEDs; the page's `usb-pad` and
// `usb-rumble` messages through the glue (web/usb.ts); and the page's feed (web/app/gamepads.ts), its rumble too.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { UsbResult } from '../web/usb-device.ts';
import { BUTTONS, GAMEPAD_PRODUCT, GAMEPAD_VENDOR, REPORT_LENGTH, UsbGamepad, padReport, type PadState } from '../web/usb-gamepad.ts';
import { Usb } from '../web/usb.ts';
import { eventually, until } from './until.ts';
import { listPads, padName, PadFeed, padState, POLL_MS, REST, RUMBLE_MS, type PadLike } from '../web/app/gamepads.ts';

let tag = 0;
const control = (d: UsbGamepad, requestType: number, request: number, value: number, index: number, length: number, data?: Uint8Array) =>
  new Promise<UsbResult>((resolve) => d.submit({ tag: ++tag, ep: 0, type: 'control', setup: { requestType, request, value, index, length }, data, length }, resolve));
/** An IN TD on 0x81: its result once there is one (undefined while it waits). */
function poll(d: UsbGamepad, length = 32) {
  const box: { r?: UsbResult; tag: number } = { tag: ++tag };
  d.submit({ tag: box.tag, ep: 0x81, type: 'interrupt', length }, (r) => { box.r = r; });
  return box;
}
/** An OUT TD on 0x02 (a command of xpad's). */
const out = (d: UsbGamepad, ...bytes: number[]) =>
  new Promise<UsbResult>((resolve) => d.submit({ tag: ++tag, ep: 0x02, type: 'interrupt', data: new Uint8Array(bytes), length: bytes.length }, resolve));
const string = (d: Uint8Array) => String.fromCharCode(...new Uint16Array(d.slice(2).buffer));
const pad = (o: Partial<PadState>): PadState => ({ pressed: 0, values: [], axes: [], ...o });
const press = (...buttons: number[]) => buttons.reduce((m, b) => m | 1 << b, 0);
const configure = (d: UsbGamepad) => control(d, 0x00, 9, 1, 0, 0);

/**
 * A report as Linux's xpad reads a wired Xbox 360 pad's (drivers/input/joystick/xpad.c, `xpad360_process_packet`, with
 * its default mapping: the D-pad as a hat, the triggers as axes), as evdev codes and values.
 */
function xpad(r: Uint8Array): Map<string, number> {
  const bit = (byte: number, b: number) => (r[byte] >> b & 1);
  const s16 = (at: number) => (r[at] | r[at + 1] << 8) << 16 >> 16;
  return new Map([
    ['HAT0X', bit(2, 3) - bit(2, 2)], ['HAT0Y', bit(2, 1) - bit(2, 0)],
    ['START', bit(2, 4)], ['SELECT', bit(2, 5)], ['THUMBL', bit(2, 6)], ['THUMBR', bit(2, 7)],
    ['A', bit(3, 4)], ['B', bit(3, 5)], ['X', bit(3, 6)], ['Y', bit(3, 7)], ['TL', bit(3, 0)], ['TR', bit(3, 1)], ['MODE', bit(3, 2)],
    ['ABS_X', s16(6)], ['ABS_Y', ~s16(8)], ['ABS_RX', s16(10)], ['ABS_RY', ~s16(12)], ['ABS_Z', r[4]], ['ABS_RZ', r[5]],
  ]);
}

/**
 * What a web page in the guest reads of the pad through Chromium: joydev numbers xpad's keys and axes by code (BTN_A,
 * B, X, Y, TL, TR, SELECT, START, MODE, THUMBL, THUMBR; ABS_X, Y, Z, RX, RY, RZ, HAT0X, HAT0Y) and scales each axis's
 * range to ±32767, Chromium reads that as −1–1, and its mapping for 045e:028e (device/gamepad/
 * gamepad_standard_mappings_linux.cc, `MapperXInputStyleGamepad`) makes it the standard layout.
 */
function guestChromium(r: Uint8Array): { pressed: boolean[]; axes: number[]; triggers: number[] } {
  const e = xpad(r);
  const keys = ['A', 'B', 'X', 'Y', 'TL', 'TR', 'SELECT', 'START', 'MODE', 'THUMBL', 'THUMBR'].map((k) => e.get(k) === 1);
  const scale = (v: number, lo: number, hi: number) => Math.round(((v - lo) * 2 * 32767) / (hi - lo) - 32767) / 32767;
  const raw = [scale(e.get('ABS_X')!, -32768, 32767), scale(e.get('ABS_Y')!, -32768, 32767), scale(e.get('ABS_Z')!, 0, 255),
    scale(e.get('ABS_RX')!, -32768, 32767), scale(e.get('ABS_RY')!, -32768, 32767), scale(e.get('ABS_RZ')!, 0, 255), e.get('HAT0X')!, e.get('HAT0Y')!];
  const trigger = (a: number) => (a + 1) / 2;
  const pressed = [...keys.slice(0, 6), trigger(raw[2]) > 0.1, trigger(raw[5]) > 0.1, keys[6], keys[7], keys[9], keys[10],
    raw[7] < -0.5, raw[7] > 0.5, raw[6] < -0.5, raw[6] > 0.5, keys[8]];
  return { pressed, axes: [raw[0], raw[1], raw[3], raw[4]], triggers: [trigger(raw[2]), trigger(raw[5])] };
}

test('the game pad describes itself as a wired Xbox 360 controller', async () => {
  const d = new UsbGamepad({ name: 'Xbox 360 Controller', serial: 'waarm64-pad-1' });
  assert.equal(d.speed, 'full');
  const dev = (await control(d, 0x80, 6, 0x100, 0, 18)).data!;
  assert.deepEqual([dev[4], dev[5], dev[6], dev[7], dev[8] | dev[9] << 8, dev[10] | dev[11] << 8], [0xff, 0xff, 0xff, 8, 0x045e, 0x028e]);
  assert.deepEqual([GAMEPAD_VENDOR, GAMEPAD_PRODUCT], [0x045e, 0x028e]);
  assert.equal(string((await control(d, 0x80, 6, 0x302, 0x409, 255)).data!), 'Xbox 360 Controller');
  assert.equal(string((await control(d, 0x80, 6, 0x303, 0x409, 255)).data!), 'waarm64-pad-1');
  assert.equal(string((await control(new UsbGamepad(), 0x80, 6, 0x302, 0x409, 255)).data!), 'waarm64 game pad');
  const c = (await control(d, 0x80, 6, 0x200, 0, 255)).data!;
  assert.equal(c[2] | c[3] << 8, c.length);
  // xpad matches the vendor and the interface ff/5d/01, and wants exactly two endpoints, interrupt IN and OUT.
  assert.deepEqual([...c.subarray(9, 18)], [9, 4, 0, 0, 2, 0xff, 0x5d, 0x01, 0]);
  assert.deepEqual([...c.subarray(18)], [7, 5, 0x81, 3, 32, 0, 4, 7, 5, 0x02, 3, 32, 0, 8]);
  assert.equal((await control(d, 0x81, 6, 0x2200, 0, 255)).code, 'stall', 'no HID report descriptor');
});

test('each standard button, the D-pad, the sticks and the triggers land on xpad\'s game pad codes', () => {
  // The standard mapping's buttons 0–16, and what xpad makes of each alone.
  const codes = ['A', 'B', 'X', 'Y', 'TL', 'TR', 'ABS_Z', 'ABS_RZ', 'SELECT', 'START', 'THUMBL', 'THUMBR', 'HAT0Y-', 'HAT0Y+', 'HAT0X-', 'HAT0X+', 'MODE'];
  assert.equal(BUTTONS.length, codes.length);
  const atRest = xpad(padReport(REST));
  assert.ok([...atRest.values()].every((v) => v === 0), 'at rest: every code 0');
  codes.forEach((code, i) => {
    const e = xpad(padReport(pad({ pressed: press(i), values: Object.assign([], { [i]: 1 }) })));
    for (const [k, v] of e) {
      const want = code === k ? (k.startsWith('ABS') ? 255 : 1) : code === `${k}-` ? -1 : code === `${k}+` ? 1 : 0;
      assert.equal(v, want, `standard button ${i} → ${code}: ${k}`);
    }
  });
  // Diagonals and opposites, as the pad's own buttons.
  const hat = (...b: number[]) => { const e = xpad(padReport(pad({ pressed: press(...b) }))); return [e.get('HAT0X'), e.get('HAT0Y')]; };
  assert.deepEqual([hat(12, 15), hat(13, 14), hat(12, 13)], [[1, -1], [-1, 1], [0, 0]]);
  // Sticks: up and left negative, as the Gamepad API has them; scaled, clamped, NaN centred.
  const e = xpad(padReport(pad({ axes: [-1, 1, 0.5, -0.25], values: [0, 0, 0, 0, 0, 0, 0.5, 2] })));
  assert.deepEqual(['ABS_X', 'ABS_Y', 'ABS_RX', 'ABS_RY', 'ABS_Z', 'ABS_RZ'].map((k) => e.get(k)), [-32767, 32767, 16384, -8192, 128, 255]);
  const g = xpad(padReport(pad({ axes: [Number.NaN, 7, -7], values: [0, 0, 0, 0, 0, 0, -1] })));
  assert.deepEqual(['ABS_X', 'ABS_Y', 'ABS_RX', 'ABS_RY', 'ABS_Z'].map((k) => g.get(k)), [0, 32767, -32767, 0, 0]);
  // A digital trigger (pressed, no value) is all the way in.
  assert.equal(xpad(padReport(pad({ pressed: press(6) }))).get('ABS_Z'), 255);
  const r = padReport(REST);
  assert.deepEqual([r.length, r[0], r[1]], [REPORT_LENGTH, 0x00, 0x14], 'type 0, length 20');
});

test('a standard pad\'s state reaches a web page in the guest\'s Chromium as that state', () => {
  // Each button alone, then all of them, then the sticks and the triggers: what the page in the guest reads is the host's.
  for (let i = 0; i < 17; i++) {
    const g = guestChromium(padReport(pad({ pressed: press(i), values: Object.assign([], { [i]: 1 }) })));
    assert.deepEqual(g.pressed.flatMap((p, j) => (p ? [j] : [])), [i], `standard button ${i}`);
  }
  // (Up with down and left with right cancel on the pad's hat, as on the real pad's D-pad.)
  const all = guestChromium(padReport(pad({ pressed: 0x1ffff & ~press(13, 15), values: [0, 0, 0, 0, 0, 0, 1, 1] })));
  assert.deepEqual(all.pressed.flatMap((p, j) => (p ? [] : [j])), [13, 15]);
  const axes = [-1, 1, 0.5, -0.25];
  const s = guestChromium(padReport(pad({ axes, values: [0, 0, 0, 0, 0, 0, 0.25, 0.75] })));
  s.axes.forEach((a, i) => assert.ok(Math.abs(a - axes[i]) < 1e-3, `axis ${i}: ${a}, not ${axes[i]}`));
  s.triggers.forEach((v, i) => assert.ok(Math.abs(v - [0.25, 0.75][i]) < 0.01, `trigger ${i}: ${v}`));
});

test('changes become reports, in order, to the IN TDs; the start request, cancel and reset', async () => {
  const d = new UsbGamepad();
  d.pad(pad({ pressed: press(0) }));
  assert.equal(d.report()[3], 0x10, 'unconfigured: the state is kept');
  assert.equal((await configure(d)).code, 'success');
  // The vendor request xpad sends as its input starts: the report now.
  const start = await control(d, 0xc1, 0x01, 0x0100, 0, 20);
  assert.equal(Buffer.compare(start.data!, d.report()), 0);
  assert.equal((await control(d, 0xa1, 0x01, 0x0100, 0, 20)).code, 'stall', 'no HID requests');
  const first = poll(d);
  assert.equal(first.r, undefined, 'nothing changed since: the TD waits');
  d.pad(pad({ pressed: press(0, 1) }));
  const got1 = first.r as UsbResult | undefined; // (assert.equal above narrowed it to undefined)
  assert.equal(got1?.actual, REPORT_LENGTH);
  assert.equal(got1!.data![3], 0x30);
  // The same state again is no report; changes with no TD queued wait in order (a press and its release both arrive).
  d.pad(pad({ pressed: press(0, 1) }));
  d.pad(pad({ pressed: press(1) }));
  d.pad(pad({ pressed: 0 }));
  assert.equal(poll(d).r!.data![3], 0x20);
  assert.equal(poll(d).r!.data![3], 0);
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
  d.pad(pad({ axes: [-1] }));
  assert.equal(poll(d, 4).r?.data?.length, 4, 'a short IN takes what fits');
  // A reset forgets what waited.
  d.pad(pad({ axes: [0.5] }));
  d.reset();
  await configure(d);
  assert.equal(poll(d).r, undefined);
});

test('the OUT endpoint: rumble on a change, the LEDs kept, the motors stopped by a reset or an unplug', async () => {
  const d = new UsbGamepad();
  const rumbles: [number, number][] = [];
  d.onRumble = (s, w) => rumbles.push([s, w]);
  assert.equal((await out(d, 0x00, 0x08, 0x00, 0xff, 0x80, 0, 0, 0)).code, 'error', 'unconfigured: no endpoint');
  await configure(d);
  assert.deepEqual(await out(d, 0x01, 0x03, 0x02), { code: 'success', actual: 3 });
  assert.equal(d.led, 2, 'player 1\'s quarter');
  assert.deepEqual(await out(d, 0x00, 0x08, 0x00, 0xff, 0x33, 0, 0, 0), { code: 'success', actual: 8 });
  await out(d, 0x00, 0x08, 0x00, 0xff, 0x33, 0, 0, 0);
  await out(d, 0x02, 0x08, 0x03); // not a command of the pad's
  await out(d, 0x00, 0x08, 0x00, 0, 0, 0, 0, 0);
  await out(d, 0x00, 0x08, 0x00, 0, 0x66, 0, 0, 0);
  assert.deepEqual(rumbles, [[1, 0.2], [0, 0], [0, 0.4]]);
  d.reset();
  assert.deepEqual(rumbles.at(-1), [0, 0], 'a reset stops the motors');
  assert.equal(d.led, 0);
  await configure(d);
  await out(d, 0x00, 0x08, 0x00, 0x80, 0, 0, 0, 0);
  d.detach();
  assert.deepEqual(rumbles.slice(-2), [[0x80 / 255, 0], [0, 0]], 'an unplug stops them');
});

test('the page\'s usb-pad messages reach the game pad through the glue, and its rumble comes back as usb-rumble', async () => {
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
  const channel = new MessageChannel();
  const usb = new Usb({ memory, shared: 0, ram: 65536, ramSize: 65536, deterministic: false, kick: () => {}, port: channel.port1 });
  const answers: unknown[] = [];
  channel.port2.onmessage = (e) => answers.push(e.data);
  try {
    const device = { api: 'virtual', kind: 'gamepad', index: 0, name: 'Pad' } as const;
    channel.port2.postMessage({ type: 'usb-attach', connector: 1, device });
    await until(() => answers.length > 0, 'the attach answered');
    assert.deepEqual(answers, [{ type: 'usb-state', connector: 1, state: 'attached', device, speed: 'full' }]);
    const gp = (usb as unknown as { plugged: { dev: UsbGamepad }[] }).plugged[1].dev;
    assert.equal(string((await control(gp, 0x80, 6, 0x303, 0x409, 255)).data!), 'waarm64-pad-1', 'the serial is the connector\'s');
    channel.port2.postMessage({ type: 'usb-pad', connector: 1, pad: pad({ pressed: press(9), axes: [0, -1] }) });
    channel.port2.postMessage({ type: 'usb-pad', connector: 2, pad: pad({ pressed: press(0) }) });
    await until(() => xpad(gp.report()).get('START') === 1, 'the pad state reached the device');
    await new Promise((r) => setTimeout(r, 20)); // for an answer that shouldn't come
    const e = xpad(gp.report());
    assert.deepEqual([e.get('START'), e.get('A'), e.get('ABS_Y')], [1, 0, -32767]);
    assert.equal(answers.length, 1, 'states get no answer');
    await configure(gp);
    await out(gp, 0x00, 0x08, 0x00, 0, 0xff, 0, 0, 0);
    await until(() => answers.length > 1, 'the rumble');
    assert.deepEqual(answers.slice(1), [{ type: 'usb-rumble', connector: 1, strong: 0, weak: 1 }]);
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
    await eventually(() => assert.deepEqual(sent.at(-1), [2, padState(g)]));
    feed.stop();
    pads = [null, { ...g, axes: [] }];
    await new Promise((r) => setTimeout(r, POLL_MS * 4));
    assert.equal(sent.length, 4, 'stopped: not polled');
    assert.deepEqual(listPads(() => []), []);
  } finally {
    feed.stop();
  }
});

test('the page\'s feed plays the guest\'s rumble on the host\'s pad, again while it goes on, and stops it', async () => {
  const calls: unknown[] = [];
  const vibrationActuator = {
    playEffect: (type: string, params: object) => { calls.push([type, params]); return Promise.resolve('complete'); },
    reset: () => { calls.push('reset'); return Promise.resolve('complete'); },
  };
  const g: PadLike = { index: 0, id: 'Pad', connected: true, buttons: [], axes: [], vibrationActuator };
  const AGAIN = 30;
  const feed = new PadFeed(() => {}, { read: () => [g], hidden: () => false, again: AGAIN });
  try {
    feed.rumble(1, 1, 1);
    assert.deepEqual(calls, [], 'not a pad of the feed\'s');
    feed.set(new Map([[1, 0]]));
    feed.rumble(1, 0, 0);
    assert.deepEqual(calls, [], 'nothing to stop');
    feed.rumble(1, 1, 0.5);
    const effect = ['dual-rumble', { startDelay: 0, duration: RUMBLE_MS, strongMagnitude: 1, weakMagnitude: 0.5 }];
    assert.deepEqual(calls, [effect]);
    await until(() => calls.length >= 2, 'played again');
    assert.ok(calls.length >= 2 && calls.every((c) => JSON.stringify(c) === JSON.stringify(effect)), `played again: ${JSON.stringify(calls)}`);
    feed.rumble(1, 0, 0);
    const n = calls.length;
    assert.equal(calls.at(-1), 'reset');
    await new Promise((r) => setTimeout(r, AGAIN * 2.5));
    assert.equal(calls.length, n, 'stopped: not played again');
    // Detached while it rumbles: stopped on the host's pad, not played again.
    feed.rumble(1, 0.25, 0);
    feed.set(new Map());
    assert.equal(calls.at(-1), 'reset');
    const m = calls.length;
    await new Promise((r) => setTimeout(r, AGAIN * 2.5));
    assert.equal(calls.length, m);
  } finally {
    feed.stop();
  }
});
