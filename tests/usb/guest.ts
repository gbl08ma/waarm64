// What the USB test kernel (images/usb/init.c; docs/usb.md) must show in every runner: its console
// lines. Its options are in options.ts; the native twin checks the same (core/tests/usb_guest.rs).
import assert from 'node:assert/strict';

export * from './options.ts';

/**
 * The console without the kernel's records ("[    1.234567] …\r\n"), so init's lines read whole. With
 * more than one vCPU the kernel writes a record whenever its console lock comes free, between two of
 * init's writes too: in parallel SMP usbtest's "unlink retry" flood (printed late, from the other vCPU)
 * landed inside "webpc: usb test ok\n", between the text and its newline, in about one run in seven. A
 * record is written whole (under the port's lock), init's lines may not be.
 */
export function userLines(console: string) {
  return console.replace(/\[ *\d+\.\d{6}\] [^\r\n]*\r?\n/g, '').replaceAll('\r\n', '\n');
}

export function checkUsbHubs(console: string) {
  const c = userLines(console);
  for (const want of ['usb: hub usb1 480 Mb/s 4 ports, USB 2.00, xHCI Host Controller\n', 'usb: hub usb2 5000 Mb/s 4 ports, USB 3.00, xHCI Host Controller\n', 'webpc: usb test ok\n']) {
    assert.ok(c.includes(want), `missing ${JSON.stringify(want)}`);
  }
}

/** The testusb run's lines: both gadgets with usbtest bound, a clean first pass, the unplug inside a pass, a clean pass after the replug. */
export function checkUsbGuest(console: string, unplug = true) {
  const c = userLines(console);
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
