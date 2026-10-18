// WebUSB end to end in the dev VM (scripts/ci-usb.sh, docs/testing.md "USB"): the pinned Chromium, in a dedicated
// worker, against tests/usb/gadget.sh's dummy_hcd gadgets (zero and acm), with permission from Chromium's managed
// policy. Skips without WEBPC_USB_TESTS=1 or without the rig.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { gadgetMissing, openRig, PORTS, usbTests, type Rig } from './usb/rig.ts';

const missing = usbTests ? gadgetMissing() : undefined;
const skip = !usbTests ? 'SKIPPED: scripts/ci-usb.sh runs it (WEBPC_USB_TESTS=1)' : missing ? `SKIPPED: ${missing}` : false;

let rig: Rig | undefined;
before(async () => {
  if (!skip) rig = await openRig(PORTS.webusb, '/tests/usb/usb-page.html');
});
after(async () => rig?.close());

test('WebUSB in a worker: Gadget Zero and the ACM gadget, granted by policy', { skip, timeout: 60_000 }, async () => {
  const r = await rig!.page.evaluate(() => (window as any).inWorker({ type: 'check' }));
  assert.equal(r.usb, true, 'navigator.usb in a dedicated worker');
  assert.ok(r.zero, `Gadget Zero (serial webpc-zero) among the granted devices: ${JSON.stringify(r.devices)} (tests/usb/gadget.sh up zero acm)`);
  assert.deepEqual(r.zero.configurations, [1, 2], 'source/sink and loopback');
  assert.equal(r.zero.descriptor.status, 'ok');
  assert.match(r.zero.descriptor.hex, /^12010002000000402505a0a4/, 'device descriptor: USB 2.0, 64-byte endpoint 0, 0525:a4a0');
  assert.deepEqual(r.zero.bulkIn, { status: 'ok', length: 512, pattern: true });
  assert.deepEqual(r.zero.bulkOut, { status: 'ok', bytesWritten: 512 });
  assert.equal(r.zero.vendorIn.status, 'ok');
  assert.deepEqual(r.zero.loopback, { status: 'ok', same: true });
  assert.ok(r.acm, 'the ACM gadget (serial webpc-acm)');
  assert.deepEqual(r.acm.ifaces, [{ number: 0, class: 2 }, { number: 1, class: 10 }]);
  assert.deepEqual(r.acm.claimed, [0, 1], "both of its interfaces claimed: the host's cdc_acm doesn't hold them");
});
