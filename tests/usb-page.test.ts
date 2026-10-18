// A machine's USB on the page, without a browser (docs/plans/usb.md §4a, docs/usb.md "The page"): web/app/usb-ports.ts
// (identities, the lock names, connectors, matching the browser's devices to entries, the messages' words),
// web/app/usb-live.ts's ports against a fake device worker on a MessageChannel and its locks between two "tabs" (two
// Stores on one BroadcastChannel), and the record: new machines with the controller on, definitions carrying it and the
// entries' identities, a settings save that doesn't drop them. The shape's hash is pinned in tests/store.test.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { UsbFromWorker, UsbToWorker } from '../web/usb-device.ts';
import { exportDefinition, importDefinition, parseDefinition } from '../web/app/definitions.ts';
import { createMachine, duplicateMachine, updateMachine } from '../web/app/machines.ts';
import { memoryFiles, memoryRecords, Store } from '../web/app/store.ts';
import type { UsbEntry } from '../web/app/shape.ts';
import { deviceName, freeConnector, hasTwins, identityAt, identityKey, matchDevices, newEntry, problemText, usbLock, validDefinitionUsb } from '../web/app/usb-ports.ts';
import { filterFor, UsbError, UsbLocks, UsbPorts } from '../web/app/usb-live.ts';

const entry = (over: Partial<UsbEntry>): UsbEntry => ({ id: 'e00000000001', api: 'usb', vendorId: 0x2e8a, productId: 0x000a, connector: 0, atStart: true, ...over });

test('identities, lock names and connectors', () => {
  assert.equal(identityKey({ api: 'usb', vendorId: 0x2e8a, productId: 0xa, serialNumber: 'E6614' }), 'usb:2e8a:000a:s:E6614');
  assert.equal(identityKey({ api: 'hid', vendorId: 0x54c, productId: 0xce6 }), 'hid:054c:0ce6:n:0');
  assert.equal(identityKey({ api: 'hid', vendorId: 0x54c, productId: 0xce6, index: 1 }), 'hid:054c:0ce6:n:1');
  assert.equal(usbLock({ api: 'usb', vendorId: 1, productId: 2 }), 'webpc-usb:usb:0001:0002:n:0');
  assert.equal(deviceName({ api: 'usb', vendorId: 0x2e8a, productId: 0xa }), 'USB device 2e8a:000a');
  assert.equal(deviceName({ api: 'hid', vendorId: 1, productId: 2, productName: ' DualSense ' }), 'DualSense');
  assert.equal(deviceName({ api: 'virtual', kind: 'gadget-zero' }), 'Gadget Zero (test device)');
  assert.equal(freeConnector([]), 0);
  assert.equal(freeConnector([{ connector: 0 }, { connector: 2 }]), 1);
  assert.equal(freeConnector([0, 1, 2, 3, 0, 1].map((connector) => ({ connector }))), 2, 'the least used once all are');
  assert.deepEqual(filterFor(entry({ serialNumber: 'X' })), { vendorId: 0x2e8a, productId: 0xa, serialNumber: 'X' });
  assert.deepEqual(filterFor(entry({ api: 'hid', serialNumber: 'X' })), { vendorId: 0x2e8a, productId: 0xa }, "WebHID's filters take no serial number");
});

test("the browser's devices matched to entries: by serial number, and identical serial-less ones by their order", () => {
  const pads = [{ vendorId: 0x54c, productId: 0xce6 }, { vendorId: 0x2e8a, productId: 0xa, serialNumber: 'B' }, { vendorId: 0x54c, productId: 0xce6 }, { vendorId: 0x2e8a, productId: 0xa, serialNumber: 'A' }];
  const entries = [
    entry({ id: 'a', serialNumber: 'A' }), entry({ id: 'b', serialNumber: 'B' }), entry({ id: 'c', serialNumber: 'C' }),
    entry({ id: 'p0', vendorId: 0x54c, productId: 0xce6 }), entry({ id: 'p1', vendorId: 0x54c, productId: 0xce6, index: 1 }), entry({ id: 'p2', vendorId: 0x54c, productId: 0xce6, index: 2 }),
    entry({ id: 'h', api: 'hid', vendorId: 0x54c, productId: 0xce6 }),
  ];
  assert.deepEqual(Object.fromEntries(matchDevices(entries, 'usb', pads)), { a: 3, b: 1, p0: 0, p1: 2 });
  assert.deepEqual(identityAt('usb', pads, 2), { api: 'usb', vendorId: 0x54c, productId: 0xce6, index: 1 });
  assert.deepEqual(identityAt('usb', pads, 3), { api: 'usb', vendorId: 0x2e8a, productId: 0xa, serialNumber: 'A' });
  assert.equal(hasTwins(entries), true);
  assert.equal(hasTwins(entries.slice(0, 3)), false);
  const e = newEntry(identityAt('usb', pads, 2), entries.slice(0, 2));
  assert.equal(e.connector, 1);
  assert.equal(e.index, 1);
  assert.equal(e.atStart, true);
});

test("the messages for what the device worker can't do, with each OS's remedy", () => {
  const d = { api: 'usb' as const, vendorId: 0x2e8a, productId: 0xa };
  assert.match(problemText({ kind: 'protected-interface', interface: 2, class: 3 }, d, 'linux'), /Interface 2 is a HID interface.*HID device instead/);
  assert.match(problemText({ kind: 'protected-interface', interface: 0, class: 8 }, d, 'linux'), /mass storage.*Disks/);
  const claim = { kind: 'claim-failed' as const, interface: 1, message: 'Unable to claim interface.' };
  assert.match(problemText(claim, d, 'linux'), /cdc_acm.*unbind/);
  assert.match(problemText(claim, d, 'windows'), /WinUSB.*Zadig/);
  assert.match(problemText(claim, d, 'mac'), /macOS/);
  assert.match(problemText({ kind: 'no-collections' }, { ...d, api: 'hid' }), /kept from pages/);
  assert.match(problemText({ kind: 'protected-collection', usagePage: 1, usage: 6, kept: true }, { ...d, api: 'hid' }), /keyboard part.*all but its feature reports/);
  assert.match(problemText({ kind: 'protected-collection', usagePage: 1, usage: 2, kept: false }, { ...d, api: 'hid' }), /mouse part.*doesn't get it/);
  assert.match(problemText({ kind: 'open-failed', message: 'Failed to open the device.' }, { ...d, api: 'hid' }, 'linux'), /hidraw.*KERNEL=="hidraw\*", ATTRS\{idVendor\}=="2e8a", ATTRS\{idProduct\}=="000a", TAG\+="uaccess"/);
  assert.match(problemText({ kind: 'open-failed', message: 'Access denied.' }, d, 'linux'), /\/dev\/bus\/usb.*SUBSYSTEM=="usb"/);
});

/** A fake device worker on the other end of `port`: attaches what it is asked (refusing the vendor 0xdead), detaches. */
function fakeWorker(port: MessagePort, seen: UsbToWorker[]) {
  port.onmessage = (e: MessageEvent<UsbToWorker>) => {
    const m = e.data;
    seen.push(m);
    const say = (s: UsbFromWorker) => port.postMessage(s);
    if (m.type === 'usb-attach') {
      if ('vendorId' in m.device && m.device.vendorId === 0xdead) say({ type: 'usb-state', connector: m.connector, state: 'error', message: "Couldn't attach it.", detail: [{ kind: 'claim-failed', interface: 0, message: 'busy' }] });
      // A Pico's HID interface is left out (WebUSB refuses the class): the attach says so.
      else say({ type: 'usb-state', connector: m.connector, state: 'attached', device: m.device, speed: 'high', ...('vendorId' in m.device && m.device.vendorId === 0x2e8a ? { problems: [{ kind: 'protected-interface', interface: 2, class: 3 }] } : {}) });
    } else say({ type: 'usb-state', connector: m.connector, state: 'detached', reason: 'page' });
  };
}

test('the ports: attach, refuse, detach all and attach again, a device unplugged; the locks between two tabs', async () => {
  const channel = `webpc-usb-test-${process.pid}`;
  const [a, b] = [new Store(memoryRecords(), memoryFiles(), { channel }), new Store(memoryRecords(), memoryFiles(), { channel })];
  const released: string[] = [];
  const locksA = new UsbLocks(a, () => 'Machine A', (lock) => { released.push(lock); locksA.drop(lock); });
  const locksB = new UsbLocks(b, () => 'Machine B', () => {});
  const mc = new MessageChannel();
  const seen: UsbToWorker[] = [];
  fakeWorker(mc.port2, seen);
  const ports = new UsbPorts(mc.port1, locksA);
  const gone: string[] = [];
  ports.onGone = (c, was, reason) => gone.push(`${c}:${was.name}:${reason}`);
  try {
    const pico = { api: 'usb' as const, vendorId: 0x2e8a, productId: 0xa, serialNumber: 'E1', productName: 'Pico' };
    await ports.attach(1, pico, 'e1');
    assert.equal(ports.connectors[1]?.state, 'attached');
    assert.deepEqual(ports.connectors[1]?.problems, [{ kind: 'protected-interface', interface: 2, class: 3 }], 'what was left out, for the page');
    assert.deepEqual([...ports.attachedEntries()], ['e1']);
    await assert.rejects(ports.attach(1, { api: 'virtual', kind: 'gadget-zero' }), /Connector 2 has Pico/);
    // Another tab can't have it; it learns who has it, and asks for it.
    assert.equal(await locksB.take(usbLock(pico)), false);
    assert.equal(await locksB.holder(usbLock(pico)), 'Machine A');
    await ports.attach(0, { api: 'virtual', kind: 'gadget-zero' });
    // Snapshot: everything off, and back.
    const was = await ports.detachAll();
    assert.deepEqual(was.map((c) => c.connector).sort(), [0, 1]);
    assert.equal(ports.attached().length, 0);
    assert.equal(await locksB.take(usbLock(pico)), true, 'detached: its lock is free');
    locksB.drop(usbLock(pico));
    for (const c of was) await ports.attach(c.connector, c.device, c.entry);
    assert.equal(ports.attached().length, 2);
    // A refusal says why, with the remedy, and frees the connector and the lock.
    const bad = { api: 'usb' as const, vendorId: 0xdead, productId: 1 };
    const err = await ports.attach(2, bad).catch((e: unknown) => e);
    assert.ok(err instanceof UsbError && /Couldn't attach it\.\nInterface 0 couldn't be claimed \(busy\)/.test(err.message), String(err));
    assert.equal(ports.connectors[2], undefined);
    assert.equal(await locksA.take(usbLock(bad)), true);
    locksA.drop(usbLock(bad));
    // Unplugged by itself: the connector frees, `onGone` hears why.
    mc.port2.postMessage({ type: 'usb-state', connector: 1, state: 'detached', reason: 'unplugged' } satisfies UsbFromWorker);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(gone, ['1:Pico:unplugged']);
    // Detach there: tab B asks, A lets it go (the page detaches it), B takes it.
    await ports.attach(1, pico, 'e1');
    assert.equal(await locksB.takeFrom(usbLock(pico), 2000), true);
    assert.deepEqual(released, [usbLock(pico)]);
    assert.deepEqual(seen.map((m) => m.type), ['usb-attach', 'usb-attach', 'usb-detach', 'usb-detach', 'usb-attach', 'usb-attach', 'usb-attach', 'usb-attach']);
  } finally {
    ports.close();
    locksA.close();
    locksB.close();
    a.close();
    b.close();
    mc.port2.close();
  }
});

test('the record: new machines have the controller, a settings save keeps the devices, definitions carry identities only', async () => {
  const store = new Store(memoryRecords(), memoryFiles(), { channel: false });
  const m = await createMachine(store, { name: 'Bench' });
  assert.equal(m.usb, true, 'a new machine has it');
  const devices = [entry({ id: 'e1', serialNumber: 'E6614', productName: 'Pico' }), entry({ id: 'e2', api: 'hid', vendorId: 0x54c, productId: 0xce6, connector: 1, atStart: false, index: 1 })];
  await store.put('machines', { ...m, usbDevices: devices });
  // The Settings tab's draft has no devices (or old ones): saving it doesn't drop the list.
  await updateMachine(store, { ...m, name: 'Bench 2', usbDevices: [] });
  assert.equal((await store.get('machines', m.id))!.usbDevices?.length, 2);
  const copy = await duplicateMachine(store, m.id);
  assert.deepEqual(copy.usbDevices?.map((e) => identityKey(e)), devices.map((e) => identityKey(e)));
  assert.ok(copy.usbDevices!.every((e, i) => e.id !== devices[i].id), 'new ids');

  const def = await exportDefinition(store, m.id);
  assert.equal(def.machine.usb, true);
  assert.deepEqual(def.usbDevices, devices.map(({ id: _, ...e }) => e));
  const text = JSON.stringify(def);
  const back = await importDefinition(store, parseDefinition(text));
  assert.equal(back.machine.usb, true);
  assert.deepEqual(back.machine.usbDevices?.map((e) => [identityKey(e), e.connector, e.atStart]), devices.map((e) => [identityKey(e), e.connector, e.atStart]));
  // A machine without the controller says nothing of it; an older definition imports with it off.
  const plain = await createMachine(store, { name: 'Plain', usb: false });
  const pd = await exportDefinition(store, plain.id);
  assert.equal('usb' in pd.machine, false);
  assert.equal('usbDevices' in pd, false);
  assert.equal((await importDefinition(store, parseDefinition(JSON.stringify(pd)))).machine.usb, false);
  // Damaged entries are refused.
  assert.equal(validDefinitionUsb(def.usbDevices), true);
  for (const bad of [{ ...def.usbDevices![0], connector: 4 }, { ...def.usbDevices![0], api: 'bt' }, { ...def.usbDevices![0], vendorId: 0x10000 }]) {
    assert.throws(() => parseDefinition(JSON.stringify({ ...def, usbDevices: [bad] })), /damaged/);
  }
  store.close();
});
