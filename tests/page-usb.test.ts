// A machine's USB devices on the Machines page, in Chromium without a guest or host devices (docs/usb.md "The page",
// docs/usb.md "The page"): WebUSB and WebHID are stood in for by a fake (`navigator.usb`, `navigator.hid` with plugged-in
// devices and grants kept per profile), so the flows are the page's own: the controller on for a new machine, off and
// warned about for an existing one; the Add a device wizard remembering what the chooser gives (identical serial-less
// game pads told apart by order, and said so); an entry held by another tab's machine, named; a definition carried to
// another profile, its entries without a grant there until Allow; Forget revoking the grant. Attaching to a running
// guest is tests/page-usb-guest.test.ts's.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { answerAsks, type Question } from './page-ask.ts';
import { t } from '../web/i18n.ts';

const PLUGGED = t('usb:Usb.state.plugged');
const UNGRANTED = t('usb:Usb.state.ungranted');

let base: string;
let close: () => void;
let dir: string;
before(async () => {
  const server = await startServer();
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  dir = mkdtempSync(join(tmpdir(), 'webpc-usb-page-'));
});
/** Every profile opened, closed at the end even when a test fails (a context left open keeps the process alive). */
const contexts: BrowserContext[] = [];
after(async () => { for (const c of contexts) await c.close().catch(() => {}); close?.(); if (dir) rmSync(dir, { recursive: true }); });

/**
 * WebUSB and WebHID, faked: `plugged` are the devices on this "computer"; a grant is kept in localStorage (per
 * profile, as the browser's are); `requestDevice` grants the first plugged device its filters match that has none yet
 * (or the first matching, granted already), as a user picking it in the chooser would.
 */
function fakeDevices(plugged: { api: 'usb' | 'hid'; vendorId: number; productId: number; serialNumber?: string; productName: string }[]) {
  const key = (d: { api: string; vendorId: number; productId: number; serialNumber?: string }, i: number) => `${d.api}:${d.vendorId}:${d.productId}:${d.serialNumber ?? ''}:${i}`;
  const read = (k: string) => { try { return JSON.parse(localStorage.getItem(k) ?? '[]') as string[]; } catch { return []; } };
  const write = (k: string, v: string[]) => localStorage.setItem(k, JSON.stringify(v));
  const objects = plugged.map((d, i) => ({ ...d, key: key(d, i), forget: async () => { write('fake.granted', read('fake.granted').filter((x) => x !== key(d, i))); write('fake.forgot', [...read('fake.forgot'), d.productName]); } }));
  for (const api of ['usb', 'hid'] as const) {
    const mine = objects.filter((d) => d.api === api);
    const fake = {
      getDevices: async () => mine.filter((d) => read('fake.granted').includes(d.key)),
      requestDevice: async (o: { filters: { vendorId?: number; productId?: number; serialNumber?: string }[] }) => {
        const fits = mine.filter((d) => !o.filters.length || o.filters.some((f) => (f.vendorId === undefined || f.vendorId === d.vendorId) && (f.productId === undefined || f.productId === d.productId) && (f.serialNumber === undefined || f.serialNumber === d.serialNumber)));
        const d = fits.find((x) => !read('fake.granted').includes(x.key)) ?? fits[0];
        if (!d) throw new DOMException('No device selected.', 'NotFoundError');
        if (!read('fake.granted').includes(d.key)) write('fake.granted', [...read('fake.granted'), d.key]);
        return api === 'hid' ? [d] : d;
      },
      addEventListener: () => {},
    };
    Object.defineProperty(Navigator.prototype, api, { get: () => fake, configurable: true });
  }
}
const DEVICES = [
  { api: 'usb' as const, vendorId: 0x2e8a, productId: 0x000a, serialNumber: 'E6614C', productName: 'Pico' },
  { api: 'hid' as const, vendorId: 0x054c, productId: 0x0ce6, productName: 'DualSense Wireless Controller' },
  { api: 'hid' as const, vendorId: 0x054c, productId: 0x0ce6, productName: 'DualSense Wireless Controller' },
];

const profile = async () => {
  const c = await chromium.launchPersistentContext(mkdtempSync(join(dir, 'profile-')), { executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
  contexts.push(c);
  await c.addInitScript(fakeDevices, DEVICES);
  return c;
};
async function open(c: BrowserContext, asked: Question[] = []) {
  const page = c.pages()[0] ?? await c.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await answerAsks(page, (q) => { asked.push(q); });
  await page.goto(`${base}/web/app/#machines`);
  await page.locator('.machines').waitFor();
  return { page, errors };
}
/** The USB tab's entries: name, state, connector, at start. */
const entries = (page: Page) => page.$$eval('.machines [data-usb-entry]', (els) => els.map((e) => ({
  name: e.querySelector('strong')?.textContent ?? '',
  state: e.querySelector('[data-usb-state]')?.textContent ?? '',
  connector: Number((e.querySelector('[data-field=connector]') as HTMLSelectElement).value),
  atStart: (e.querySelector('[data-field=at-start]') as HTMLInputElement).checked,
})));
async function addDevice(page: Page, kind: 'usb' | 'hid', count: number) {
  await page.click('.machines [data-action=add-usb]');
  await page.click('#add-usb [data-usb-kind=' + kind + ']');
  await page.locator('#add-usb').waitFor({ state: 'detached' });
  await page.waitForFunction((n) => document.querySelectorAll('.machines [data-usb-entry]').length === n, count, { polling: 100 });
}

test('the USB tab: the controller, Add a device, twins, a device held elsewhere; a definition on another profile, Allow, Forget', async () => {
  const a = await profile();
  const { page, errors } = await open(a);
  // A new machine has the controller.
  await page.click('.machines [data-action=new-machine]');
  await page.locator('.machines [data-selected] [data-tab=settings]').waitFor();
  assert.equal(await page.isChecked('.machines [data-field=usb]'), true);
  await page.click('.machines [data-tab=usb]');
  await page.locator('.machines .usb .none', { hasText: t('usb:Usb.none') }).waitFor();

  // The wizard: the kind first, then the chooser (here, the fake's first device of that kind).
  await page.click('.machines [data-action=add-usb]');
  assert.equal(await page.textContent('#add-usb [data-usb-kind=usb]'), t('usb:AddUsb.usb') + t('usb:AddUsb.usb.text'));
  assert.equal(await page.textContent('#add-usb [data-usb-kind=hid]'), t('usb:AddUsb.hid') + t('usb:AddUsb.hid.text'));
  await page.click('#add-usb [data-usb-kind=usb]');
  await page.locator('#add-usb').waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.querySelectorAll('.machines [data-usb-entry]').length === 1, null, { polling: 100 });
  await addDevice(page, 'hid', 2);
  await addDevice(page, 'hid', 3);
  await page.waitForFunction((want) => [...document.querySelectorAll('.machines [data-usb-state]')].every((e) => e.textContent === want), PLUGGED, { polling: 100 });
  assert.deepEqual(await entries(page), [
    { name: 'Pico', state: PLUGGED, connector: 0, atStart: true },
    { name: 'DualSense Wireless Controller', state: PLUGGED, connector: 1, atStart: true },
    { name: 'DualSense Wireless Controller', state: PLUGGED, connector: 2, atStart: true },
  ]);
  await page.locator('.machines [data-usb-twins]').waitFor();
  assert.ok((await page.textContent('.machines [data-usb-entry]:nth-child(3) .meta') ?? '').includes(t('usb:Usb.meta.index.nd', { n: 2 })));
  // Connectors 1-3 are the user's (4 is the built-in keyboard's, the tab says so). Connector and attach at start are kept.
  assert.deepEqual(await page.$$eval('.machines [data-usb-entry]:nth-child(3) [data-field=connector] option', (o) => o.map((e) => e.textContent)), ['1', '2', '3']);
  assert.ok([t('usb:Usb.builtin', { connector: 4 }), t('usb:Usb.builtin.asNow', { connector: 4 }), t('usb:Usb.builtin.pluggedNow', { connector: 4 })].includes(await page.textContent('.machines [data-usb-builtin]') ?? ''));
  await page.selectOption('.machines [data-usb-entry]:nth-child(3) [data-field=connector]', { value: '0' });
  // The connector's save re-renders the entry when it lands, undoing a click made before it (under load, CI saw it):
  // uncheck until the box stays clear.
  for (let i = 0; ; i++) {
    try {
      await page.uncheck('.machines [data-usb-entry]:nth-child(3) [data-field=at-start]', { timeout: 2_000 });
      break;
    } catch (e) {
      if (i >= 10) throw e;
      await page.waitForTimeout(200);
    }
  }
  await page.waitForFunction(() => (document.querySelector('.machines [data-usb-entry]:nth-child(3) [data-field=connector]') as HTMLSelectElement).value === '0', null, { polling: 100 });

  // Another tab's machine holds the Pico: the tab says which.
  const other = await a.newPage();
  await other.goto(`${base}/tests/browser/core.html`);
  await other.evaluate(async () => {
    const { Store } = await import('/web/app/store.ts' as string);
    const { UsbLocks } = await import('/web/app/usb-live.ts' as string);
    const { usbLock } = await import('/web/app/usb-ports.ts' as string);
    const locks = new UsbLocks(await Store.open(), () => 'Other machine', () => {});
    (window as unknown as { locks: unknown }).locks = locks;
    await locks.take(usbLock({ api: 'usb', vendorId: 0x2e8a, productId: 0x000a, serialNumber: 'E6614C' }));
  });
  await page.click('.machines [data-tab=settings]');
  await page.click('.machines [data-tab=usb]');
  await page.locator('.machines [data-usb-entry]:first-child [data-usb-state]', { hasText: t('usb:Usb.state.heldBy', { holder: 'Other machine' }) }).waitFor();
  await other.close();

  // The definition carries the identities, not the grants.
  const def = await page.evaluate(async () => {
    const { Store } = await import('/web/app/store.ts' as string);
    const { exportDefinition } = await import('/web/app/definitions.ts' as string);
    const store = await Store.open();
    const m = (await store.all('machines'))[0];
    return JSON.stringify(await exportDefinition(store, m.id));
  });
  assert.deepEqual(errors, []);
  await a.close();
  const parsed = JSON.parse(def);
  assert.equal(parsed.machine.usb, true);
  assert.deepEqual(parsed.usbDevices.map((e: { productName: string; connector: number; atStart: boolean; index?: number }) => [e.productName, e.connector, e.atStart, e.index ?? 0]), [['Pico', 0, true, 0], ['DualSense Wireless Controller', 1, true, 0], ['DualSense Wireless Controller', 0, false, 1]]);

  // Another profile: imported, its entries have no grant until Allow (the chooser, filtered on the device).
  const b = await profile();
  const asked: Question[] = [];
  const { page: pb, errors: errorsB } = await open(b, asked);
  const file = join(dir, 'Bench.webpc-machine.json');
  writeFileSync(file, def);
  await pb.setInputFiles('.machines [data-field=import-definition]', file);
  await pb.locator('.machines [data-selected] [data-tab=usb]').click();
  await pb.waitForFunction((want) => [...document.querySelectorAll('.machines [data-usb-state]')].length === 3 && [...document.querySelectorAll('.machines [data-usb-state]')].every((e) => e.textContent === want), UNGRANTED, { polling: 100 });
  await pb.click('.machines [data-usb-entry]:first-child [data-action=allow]');
  await pb.locator('.machines [data-usb-entry]:first-child [data-usb-state]', { hasText: PLUGGED }).waitFor();
  assert.equal((await entries(pb))[1].state, UNGRANTED, 'the others stay as they were');

  // Forget: asked, and the grant goes (no other machine remembers it).
  await pb.click('.machines [data-usb-entry]:first-child [data-action=forget]');
  await pb.waitForFunction(() => document.querySelectorAll('.machines [data-usb-entry]').length === 2, null, { polling: 100 });
  assert.ok(asked.some((q) => /Forget Pico\?/.test(q.text)));
  assert.deepEqual(await pb.evaluate(() => JSON.parse(localStorage.getItem('fake.forgot') ?? '[]')), ['Pico']);
  assert.deepEqual(errorsB, []);
  await b.close();
});

test("an existing machine (made before USB) keeps its shape: the controller off, turning it on warns and orphans its snapshots", async () => {
  const c = await profile();
  const asked: Question[] = [];
  const { page, errors } = await open(c, asked);
  const before = await page.evaluate(async () => {
    const { Store } = await import('/web/app/store.ts' as string);
    const { currentShape } = await import('/web/app/snapshots.ts' as string);
    const store = await Store.open();
    // As machines.ts made them before: no `usb` key. One kept snapshot of it.
    const m = { id: 'aaaaaaaaaaaa', name: 'Old machine', ncpus: 2, ramMiB: 1024, display: '2d', network: true, attachments: [], created: 0, modified: 0 };
    await store.put('machines', m);
    const { shape, hash } = await currentShape(m, () => undefined, { display: '2d' });
    await store.put('snapshots', { id: 'bbbbbbbbbbbb', machine: m.id, name: 'Before', created: 1, bytes: 1, shape, shapeHash: hash, pins: [] });
    return hash;
  });
  await page.reload();
  await page.locator('.machines .pick', { hasText: 'Old machine' }).click();
  await page.locator('.machines [data-selected] [data-tab=settings]').click();
  assert.equal(await page.isChecked('.machines [data-field=usb]'), false);
  assert.equal(await page.locator('.machines [data-usb-orphans]').count(), 0);
  await page.check('.machines [data-field=usb]');
  await page.locator('.machines [data-usb-orphans]').waitFor();
  await page.click('.machines [data-action=save]');
  await page.waitForFunction(() => (document.querySelector('.machines [data-action=save]') as HTMLButtonElement).disabled, null, { polling: 100 });
  assert.ok(asked.some((q) => q.text === t('machines:machine-edit.orphans.confirm')), 'asked first');
  const after = await page.evaluate(async () => {
    const { Store } = await import('/web/app/store.ts' as string);
    const { currentShape } = await import('/web/app/snapshots.ts' as string);
    const store = await Store.open();
    const m = await store.get('machines', 'aaaaaaaaaaaa');
    return { usb: m.usb, hash: (await currentShape(m, () => undefined, { display: '2d' })).hash };
  });
  assert.equal(after.usb, true);
  assert.notEqual(after.hash, before);
  await page.click('.machines [data-tab=snapshots]');
  await page.locator('.machines', { hasText: t('machines:shape-diff.usb.hadNo') }).waitFor();
  assert.deepEqual(errors, []);
  await c.close();
});
