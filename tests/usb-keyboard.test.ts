// The built-in USB keyboard (web/usb-keyboard.ts; docs/usb.md "The keyboard") in Node: a HID boot keyboard
// fed from the page's key events, alone and through the glue (web/usb.ts) as the page's `usb-key` messages.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { UsbResult } from '../web/usb-device.ts';
import { BOOT_REPORT, MODIFIERS, USAGES, UsbKeyboard } from '../web/usb-keyboard.ts';
import { Usb } from '../web/usb.ts';

let tag = 0;
const control = (d: UsbKeyboard, requestType: number, request: number, value: number, index: number, length: number, data?: Uint8Array) =>
  new Promise<UsbResult>((resolve) => d.submit({ tag: ++tag, ep: 0, type: 'control', setup: { requestType, request, value, index, length }, data, length }, resolve));
/** An IN TD on 0x81: its result once there is one (undefined while it waits). */
function poll(d: UsbKeyboard) {
  const box: { r?: UsbResult; tag: number } = { tag: ++tag };
  d.submit({ tag: box.tag, ep: 0x81, type: 'interrupt', length: 8 }, (r) => { box.r = r; });
  return box;
}
const bytes = (r?: UsbResult) => [...(r?.data ?? [])];

test('the keyboard describes itself as a HID boot keyboard', async () => {
  const d = new UsbKeyboard();
  assert.equal(d.speed, 'full');
  const dev = (await control(d, 0x80, 6, 0x100, 0, 18)).data!;
  assert.deepEqual([dev[4], dev[7], dev[8] | dev[9] << 8, dev[10] | dev[11] << 8], [0, 8, 0x1209, 0x0001]);
  const c = (await control(d, 0x80, 6, 0x200, 0, 255)).data!;
  assert.equal(c[2] | c[3] << 8, c.length);
  assert.deepEqual([...c.subarray(9 + 5, 9 + 8)], [3, 1, 1], 'class 3, boot subclass, keyboard protocol');
  assert.deepEqual([...c.subarray(18, 27)], [9, 0x21, 0x11, 0x01, 0, 1, 0x22, BOOT_REPORT.length, 0]);
  assert.deepEqual([...c.subarray(27)], [7, 5, 0x81, 3, 8, 0, 10]);
  const rd = await control(d, 0x81, 6, 0x2200, 0, 255);
  assert.equal(Buffer.compare(rd.data!, BOOT_REPORT), 0);
  assert.equal(BOOT_REPORT.length, 63);
  assert.deepEqual((await control(d, 0x81, 6, 0x2100, 0, 9)).data!.length, 9);
  assert.equal((await control(d, 0x81, 6, 0x2200, 1, 255)).code, 'stall', 'no interface 1');
});

test('keys become boot reports: modifiers as bits, six keys, rollover, one report per change', async () => {
  const d = new UsbKeyboard();
  assert.equal(d.key('KeyA', true), true, 'unconfigured: the state is kept, nothing is sent');
  assert.equal((await control(d, 0x00, 9, 1, 0, 0)).code, 'success');
  const first = poll(d);
  assert.equal(first.r, undefined, 'nothing changed since: the TD waits');
  d.key('ShiftLeft', true);
  assert.deepEqual(bytes(first.r), [0x02, 0, 0x04, 0, 0, 0, 0, 0]);
  // Changes with no TD queued wait, in order: a press and its release both reach the host.
  d.key('KeyA', false);
  d.key('AltRight', true);
  d.key('AltRight', false);
  assert.deepEqual(bytes(poll(d).r), [0x02, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(bytes(poll(d).r), [0x42, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(bytes(poll(d).r), [0x02, 0, 0, 0, 0, 0, 0, 0]);
  const idle = poll(d);
  assert.equal(idle.r, undefined);
  d.cancel(0x81, [idle.tag]);
  // Seven keys: ErrorRollOver; back to six, the keys again.
  for (const k of ['KeyB', 'KeyC', 'KeyD', 'KeyE', 'KeyF', 'KeyG']) d.key(k, true);
  for (let i = 0; i < 5; i++) poll(d);
  const six = poll(d);
  assert.deepEqual(bytes(six.r), [0x02, 0, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a]);
  d.key('KeyH', true);
  assert.deepEqual(bytes(poll(d).r), [0x02, 0, 1, 1, 1, 1, 1, 1]);
  d.key('KeyB', false);
  assert.deepEqual(bytes(poll(d).r), [0x02, 0, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b]);
  // A repeat (down again) changes nothing; an unknown key isn't the keyboard's.
  d.key('KeyC', true);
  assert.equal(poll(d).r, undefined);
  assert.equal(d.key('BrowserBack', true), false);
  d.releaseAll();
  assert.ok(d.report().every((b) => b === 0));
  // Every modifier's bit, every mapped key's usage within the descriptor's range.
  assert.deepEqual([...MODIFIERS.values()], [1, 2, 4, 8, 16, 32, 64, 128]);
  assert.ok([...USAGES.values()].every((u) => u >= 4 && u <= 0x65));
  assert.equal(USAGES.get('Enter'), 0x28);
  assert.equal(USAGES.get('ArrowDown'), 0x51);
  assert.equal(USAGES.get('F2'), 0x3b);
});

test('the keyboard takes LEDs, idle, protocol and GET_REPORT', async () => {
  const d = new UsbKeyboard();
  await control(d, 0x00, 9, 1, 0, 0);
  assert.equal((await control(d, 0x21, 0x09, 0x0200, 0, 1, new Uint8Array([0x02]))).code, 'success');
  assert.equal(d.leds, 2, 'caps lock');
  assert.deepEqual(bytes(await control(d, 0xa1, 0x01, 0x0200, 0, 1)), [2]);
  assert.equal((await control(d, 0x21, 0x0a, 0x7d00, 0, 0)).code, 'success');
  assert.deepEqual(bytes(await control(d, 0xa1, 0x02, 0, 0, 1)), [0x7d]);
  assert.deepEqual(bytes(await control(d, 0xa1, 0x03, 0, 0, 1)), [1], 'report protocol after reset');
  assert.equal((await control(d, 0x21, 0x0b, 0, 0, 0)).code, 'success');
  assert.deepEqual(bytes(await control(d, 0xa1, 0x03, 0, 0, 1)), [0]);
  assert.equal((await control(d, 0x21, 0x0b, 2, 0, 0)).code, 'stall');
  d.key('ControlLeft', true);
  poll(d);
  assert.deepEqual(bytes(await control(d, 0xa1, 0x01, 0x0100, 0, 8)), [1, 0, 0, 0, 0, 0, 0, 0]);
  // A cancelled TD isn't the next report's.
  const held = poll(d);
  d.cancel(0x81, [held.tag]);
  d.key('ControlLeft', false);
  assert.equal(held.r, undefined);
  assert.deepEqual(bytes(poll(d).r), [0, 0, 0, 0, 0, 0, 0, 0]);
});

test('the page\'s usb-key messages reach the keyboard through the glue', async () => {
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
  const channel = new MessageChannel();
  const usb = new Usb({ memory, shared: 0, ram: 65536, ramSize: 65536, deterministic: false, kick: () => {}, port: channel.port1 });
  const answers: unknown[] = [];
  channel.port2.onmessage = (e) => answers.push(e.data);
  try {
    channel.port2.postMessage({ type: 'usb-attach', connector: 3, device: { api: 'virtual', kind: 'keyboard' } });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(answers, [{ type: 'usb-state', connector: 3, state: 'attached', device: { api: 'virtual', kind: 'keyboard' }, speed: 'full' }]);
    const kbd = (usb as unknown as { plugged: { dev: UsbKeyboard }[] }).plugged[3].dev;
    channel.port2.postMessage({ type: 'usb-key', connector: 3, code: 'MetaLeft', down: true });
    channel.port2.postMessage({ type: 'usb-key', connector: 3, code: 'KeyQ', down: true });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(bytes({ code: 'success', actual: 8, data: kbd.report() }), [0x08, 0, 0x14, 0, 0, 0, 0, 0]);
    channel.port2.postMessage({ type: 'usb-key', connector: 3, code: '', down: false });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual([...kbd.report()], [0, 0, 0, 0, 0, 0, 0, 0]);
    assert.equal(answers.length, 1, 'keys get no answer');
    // The guest's LEDs (SET_REPORT) go to the page: Caps Lock on, then the same again (no message), then off.
    await control(kbd, 0x00, 9, 1, 0, 0);
    await control(kbd, 0x21, 0x09, 0x0200, 0, 1, new Uint8Array([0x02]));
    await control(kbd, 0x21, 0x09, 0x0200, 0, 1, new Uint8Array([0x02]));
    await control(kbd, 0x21, 0x09, 0x0200, 0, 1, new Uint8Array([0x00]));
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(answers.slice(1), [{ type: 'usb-leds', connector: 3, leds: 2 }, { type: 'usb-leds', connector: 3, leds: 0 }]);
  } finally {
    usb.close();
    channel.port2.close();
  }
});
