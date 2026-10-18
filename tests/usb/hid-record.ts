// Records Chromium's parse of the uhid rig's report descriptors (tests/usb/hid-descriptors.ts) into
// tests/usb/hid-fixtures/<id>.json ({ descriptor: hex, collections: HIDDevice.collections as JSON, ... }) and the raw
// descriptor beside it as <id>.rdesc. The WebHID backend's encoder round-trips against these (docs/usb.md "The WebHID device").
// Re-record when the pinned Chromium moves: node tests/usb/hid-record.ts (needs the uhid rig: tests/usb/gadget.sh install).
import { mkdirSync, writeFileSync } from 'node:fs';
import { DESCRIPTORS } from './hid-descriptors.ts';
import { UhidDevice } from './uhid.ts';
import { openRig, PORTS, uhidMissing } from './rig.ts';

const why = uhidMissing();
if (why) {
  console.error(`hid-record: ${why}`);
  process.exit(1);
}
const dir = 'tests/usb/hid-fixtures';
mkdirSync(dir, { recursive: true });
const devs = DESCRIPTORS.map((d) => new UhidDevice(d));
await new Promise((r) => setTimeout(r, 500));
const rig = await openRig(PORTS.record, '/tests/usb/hid-page.html');
try {
  const chromium = rig.browser.version();
  const { devices } = await rig.page.evaluate(() => (window as any).inWorker({ type: 'list' }));
  for (const d of DESCRIPTORS) {
    const seen = devices.find((x: any) => x.vendorId === d.vendorId && x.productId === d.productId);
    const fixture = {
      id: d.id,
      name: d.name,
      vendorId: d.vendorId,
      productId: d.productId,
      note: d.note,
      chromium,
      visible: !!seen,
      descriptor: Buffer.from(d.rdesc).toString('hex'),
      collections: seen?.collections ?? [],
    };
    writeFileSync(`${dir}/${d.id}.json`, JSON.stringify(fixture, null, 1) + '\n');
    writeFileSync(`${dir}/${d.id}.rdesc`, d.rdesc);
    const top = (seen?.collections ?? []).map((c: any) => `${c.usagePage.toString(16)}:${c.usage.toString(16)}`).join(' ');
    console.log(`${d.id}: ${seen ? `visible, top-level collections ${top || '(none)'}` : 'not visible'}`);
  }
} finally {
  await rig.close();
  for (const u of devs) u.destroy();
}
