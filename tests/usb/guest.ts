// What the USB test kernel (images/usb/init.c; docs/usb.md) must show in every runner: its console
// lines. Its options are in options.ts; the native twin checks the same (core/tests/usb_guest.rs).
import assert from 'node:assert/strict';

export * from './options.ts';

export function checkUsbHubs(console: string) {
  const c = console.replaceAll('\r\n', '\n');
  for (const want of ['usb: hub usb1 480 Mb/s 4 ports, USB 2.00, xHCI Host Controller\n', 'usb: hub usb2 5000 Mb/s 4 ports, USB 3.00, xHCI Host Controller\n', 'webpc: usb test ok\n']) {
    assert.ok(c.includes(want), `missing ${JSON.stringify(want)}`);
  }
}

/** The testusb run's lines: both gadgets with usbtest bound, a clean first pass, the unplug inside a pass, a clean pass after the replug. */
export function checkUsbGuest(console: string, unplug = true) {
  const c = console.replaceAll('\r\n', '\n');
  for (const want of [
    'usb: gadget 1-1: Gadget Zero, 480 Mb/s, configuration 3, interface driver usbtest\n',
    'usb: gadget 2-2: Gadget Zero, 5000 Mb/s, configuration 3, interface driver usbtest\n',
    'webpc: usb test ok\n',
  ]) assert.ok(c.includes(want), `missing ${JSON.stringify(want)}`);
  const line = (p: number) => c.split('\n').find((l) => l.startsWith(`usb: pass ${p}: `)) ?? `no pass ${p}`;
  assert.match(line(1), /, 0 failed$/);
  if (!unplug) return;
  const pass = Number(c.match(/^usb: unplugged during pass (\d+)$/m)?.[1]);
  assert.ok(pass >= 2, 'no unplug');
  assert.doesNotMatch(line(pass), /, 0 failed/, `the unplug didn't cut pass ${pass} short`);
  assert.ok(c.includes('usb: plugged in again\n'));
  assert.match(line(pass + 1), /, 0 failed$/);
}
