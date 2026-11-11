// The browser's network connections on the page (docs/network-adapters.md §3), in Chromium, on two stored machines
// whose only disk is blank: the firmware runs and finds nothing to boot, which is all an adapter needs to be live (its
// client gets the machine's port at the start). The control server, 127.0.0.1:1, never answers, so no client gets
// further than trying, and its connection is held all the same. A new machine connects in one wizard (no connections
// yet: straight to the kind); a second tab's machine sees that connection in use by the first, named, and takes it
// after asking, the first saying so; the Network tab detaches it; an ephemeral connection is kept nowhere and is gone
// after a reload, its adapter detached and saying why; Connections renames and deletes (naming the machines it is on).
// A machine powered off lets its connection go; attached and detached from another tab, a running machine follows at
// once; adapters move up and down.
// Needs the firmware (images/build.sh edk2) and the tailnet client (net/ts/build.sh).
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { answerAsks } from './page-ask.ts';
import { t } from '../web/i18n.ts';
import { words } from './words.ts';

const NO_CONNECTION = t('network:NetAdapter.noConnection');
const CHANGE = t('network:NetAdapter.change');
const CONNECT = t('network:NetWizard.connect');
const ATTACH = t('network:NetWizard.attach');
const CHANGE_ADAPTER = t('machines:AdapterCard.adapter.change');
/** A connection to choose in the wizard, in use by `holder`'s machine. */
const heldBy = (holder: string) => words('network:NetPickStep.kind.held', { holder });
const FIRMWARE = new URL('../target/images/edk2/QEMU_EFI.fd', import.meta.url);
const WASM = new URL('../target/net/ts.wasm', import.meta.url);
const skip = !existsSync(FIRMWARE) ? 'SKIPPED: run images/build.sh edk2' : !existsSync(WASM) ? 'SKIPPED: build the tailnet client (net/ts/build.sh)' : undefined;

let browser: Browser;
let base: string;
let close: () => void;
const contexts: BrowserContext[] = [];
before(async () => {
  if (skip) return;
  const server = await startServer();
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
});
after(async () => { for (const c of contexts) await c.close().catch(() => {}); await browser?.close(); close?.(); });

/** Two stored machines, each with a blank disk and one adapter, made through the page's own code. */
async function seed(page: Page): Promise<{ a: string; b: string }> {
  return page.evaluate(async (modules) => {
    // Typed here as the page has them (tsc can't resolve the page's absolute URLs).
    const { Store } = await import(modules[0]) as typeof import('../web/app/store.ts');
    const { attach, createDisk, createMachine } = await import(modules[1]) as typeof import('../web/app/machines.ts');
    const store = await Store.open();
    const ids: string[] = [];
    for (const name of ['Alpha', 'Bravo']) {
      const m = await createMachine(store, { name, ncpus: 1, ramMiB: 256, display: '2d', usb: false });
      await attach(store, m, await createDisk(store, { kind: 'blank', size: 64 << 20, name: `${name} disk` }));
      ids.push(m.id);
    }
    store.close();
    return { a: ids[0], b: ids[1] };
  }, ['/web/app/store.ts', '/web/app/machines.ts']);
}
/** What IndexedDB `webpc` has of a kind (connections, machines). */
const records = (page: Page, kind: string) => page.evaluate((k) => new Promise<{ id: string; [k: string]: unknown }[]>((resolve, reject) => {
  const open = indexedDB.open('webpc');
  open.onsuccess = () => {
    const req = open.result.transaction(k).objectStore(k).getAll();
    req.onsuccess = () => { open.result.close(); resolve(req.result); };
    req.onerror = () => reject(req.error);
  };
  open.onerror = () => reject(open.error);
}), kind);
const adapterOf = async (page: Page, id: string) => ((await records(page, 'machines')).find((m) => m.id === id)!.adapters as { connection?: string }[])[0];
const phase = (page: Page) => page.evaluate(() => document.getElementById('network')?.dataset.phase);
const text = async (page: Page, sel: string) => (await page.locator(sel).textContent()) ?? '';
/** The page's machine has started (its adapters are live). */
const started = (page: Page) => page.waitForFunction(() => ['booting', 'running'].includes(document.getElementById('state')?.dataset.state ?? ''), null, { timeout: 60_000 });
async function menu(page: Page) {
  if (!(await page.evaluate(() => (document.getElementById('network') as HTMLDetailsElement).open))) await page.locator('#network summary').click();
}
/** A new tailnet connection on the page's machine's first adapter, through the menu's wizard (`pick`: the browser has some already). */
async function newTailnet(page: Page, o: { hostname: string; pick: boolean; keep?: boolean }) {
  await menu(page);
  await page.click('#net-setup');
  assert.equal(await page.locator('#net-step-pick').isVisible(), o.pick, o.pick ? 'the connections to choose from first' : 'no connections yet: the kind at once');
  if (o.pick) await page.click('#net-pick-new');
  await page.click('#net-pick-tailnet');
  await page.fill('#net-control', 'http://127.0.0.1:1');
  await page.fill('#net-hostname', o.hostname);
  assert.equal(await page.isChecked('#net-keep'), true, 'kept by default');
  if (o.keep === false) await page.uncheck('#net-keep');
  await page.click('#net-connect');
  await page.waitForFunction(() => !(document.getElementById('net-wizard') as HTMLDialogElement).open, null, { timeout: 10_000 });
  await page.waitForFunction(() => document.getElementById('network')!.dataset.phase !== 'off', null, { timeout: 30_000 });
}

test('connections: a new machine connected in one wizard, another tab\'s machine taking it, Detach, an ephemeral one gone after a reload, Connections', { skip, timeout: 5 * 60_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  contexts.push(context);
  const pageA = await context.newPage();
  const errors: string[] = [];
  const asked: string[] = [];
  pageA.on('pageerror', (e) => errors.push(`A: ${e}`));
  await answerAsks(pageA, (q) => { asked.push(`A: ${q.text}`); });
  await pageA.goto(`${base}/web/app/`);
  const { a, b } = await seed(pageA);

  // Alpha: no connections yet, so Connect… goes straight to the kind; one wizard attaches and connects.
  await pageA.goto(`${base}/web/app/?m=${a}`);
  await started(pageA);
  await menu(pageA);
  assert.ok((await text(pageA, '#net-conn')).includes(NO_CONNECTION), 'the menu says no connection is attached');
  await newTailnet(pageA, { hostname: 'alpha', pick: false });
  const [t] = await records(pageA, 'connections');
  assert.ok(t, 'the connection is kept');
  assert.deepEqual(t.tailnet, { controlURL: 'http://127.0.0.1:1', hostname: 'alpha', exitNode: '', stateKey: t.id });
  assert.equal(t.ephemeral, false);
  assert.equal((await adapterOf(pageA, a)).connection, t.id, 'attached to Alpha\'s adapter');
  assert.match(await text(pageA, '#net-conn'), /127\.0\.0\.1:1/);
  assert.equal(await text(pageA, '#net-setup'), CHANGE);

  // Bravo, in another tab: Alpha has it, and says so; Use it here takes it (Alpha disconnects and says why).
  const pageB = await context.newPage();
  pageB.on('pageerror', (e) => errors.push(`B: ${e}`));
  await answerAsks(pageB, (q) => { asked.push(`B: ${q.text}`); });
  await pageB.goto(`${base}/web/app/?m=${b}`);
  await started(pageB);
  await menu(pageB);
  await pageB.click('#net-setup');
  assert.equal(await pageB.locator('#net-step-pick').isVisible(), true);
  const choice = pageB.locator(`[data-connection="${t.id}"]`);
  await pageB.waitForFunction(([id, src]) => new RegExp(src).test(document.querySelector(`[data-connection="${id}"]`)?.textContent ?? ''), [t.id, heldBy('Alpha').source], { timeout: 5_000 });
  await choice.click();
  assert.equal(await text(pageB, '#net-connect'), CONNECT);
  await pageB.click('#net-connect');
  await pageB.waitForFunction(() => document.getElementById('network')!.dataset.phase !== 'off', null, { timeout: 30_000 });
  assert.equal(asked.length, 1, `asked once: ${asked}`);
  assert.match(asked[0], /^B: /);
  assert.match(asked[0], words('network:net-claims.held', { holder: 'Alpha' }));
  assert.match(asked[0], words('network:network-actions.held.useHere'));
  await pageA.waitForFunction(() => document.getElementById('network')!.dataset.phase === 'off', null, { timeout: 15_000 });
  await menu(pageA);
  assert.match(await text(pageA, '#net-hint'), words('network:net-live.taken'));
  assert.equal(await pageA.locator('#net-connect-now').isVisible(), true, 'Alpha keeps it attached: Connect is there');
  assert.equal((await adapterOf(pageB, b)).connection, t.id, 'attached to Bravo too');

  // Alpha's Network tab: Detach takes it off Alpha.
  await pageA.click('#machines-open');
  await pageA.click('[data-tab="network"]');
  await pageA.waitForSelector('[data-adapter="0"] [data-action="detach-connection"]');
  await pageA.click('[data-adapter="0"] [data-action="detach-connection"]');
  await pageA.waitForFunction((src) => new RegExp(src).test(document.querySelector('[data-adapter="0"] [data-connection-name]')?.textContent ?? ''), words('machines:AdapterCard.adapter.noConnection').source, { timeout: 10_000 });
  assert.equal((await adapterOf(pageA, a)).connection, undefined);

  // Bravo: an ephemeral connection in its place, kept nowhere; after a reload it is gone and the adapter says so.
  await menu(pageB);
  await newTailnet(pageB, { hostname: 'bravo', pick: true, keep: false });
  assert.equal((await records(pageB, 'connections')).length, 1, 'the ephemeral one is not stored');
  assert.match(await text(pageB, '#net-conn'), words('network:NetAdapter.connection.ephemeral'));
  const eph = (await adapterOf(pageB, b)).connection;
  assert.ok(eph && eph !== t.id);
  await pageB.reload();
  await started(pageB);
  await pageB.waitForFunction((src) => new RegExp(src).test(document.getElementById('net-hint')?.textContent ?? ''), words('network:net-live.gone').source, { timeout: 15_000 });
  assert.equal(await phase(pageB), 'off');
  assert.ok((await text(pageB, '#net-conn')).includes(NO_CONNECTION), 'the menu says no connection is attached');
  assert.equal((await adapterOf(pageB, b)).connection, undefined, 'detached in the record');

  // Connections: rename, then delete (it is on no machine now; the question says what goes).
  await pageB.click('#machines-open');
  await pageB.click('[data-machine="connections"]');
  const row = pageB.locator(`li[data-connection="${t.id}"]`);
  await row.locator('[data-field="connection-name"]').fill('Home tailnet');
  await row.locator('[data-field="connection-name"]').press('Enter');
  await row.locator('[data-field="connection-name"]').blur();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await records(pageB, 'connections'))[0].name, 'Home tailnet');
  asked.length = 0;
  await row.locator('[data-action="delete-connection"]').click();
  await pageB.waitForFunction((id) => !document.querySelector(`li[data-connection="${id}"]`), t.id, { timeout: 10_000 });
  assert.equal(asked.length, 1);
  assert.match(asked[0], words('network:network-actions.delete.confirm.what', { name: 'Home tailnet' }));
  assert.deepEqual(await records(pageB, 'connections'), []);
  assert.deepEqual(errors, []);
});

test('power off lets a connection go; a running machine follows what another tab attaches; adapters move', { skip, timeout: 5 * 60_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  contexts.push(context);
  const pageA = await context.newPage();
  const errors: string[] = [];
  pageA.on('pageerror', (e) => errors.push(`A: ${e}`));
  await answerAsks(pageA, () => {});
  await pageA.goto(`${base}/web/app/`);
  const { a, b } = await seed(pageA);
  const locks = () => pageA.evaluate(async () => ((await navigator.locks.query()).held ?? []).map((l) => l.name!).filter((n) => n.startsWith('webpc-net:')));
  /** The locks once they are `want` (or after 5 s): a lock is let go just after its client stops, and freed asynchronously. */
  const locksBecome = async (want: string[]) => {
    let got = await locks();
    for (let k = 0; k < 50 && JSON.stringify(got) !== JSON.stringify(want); k++) {
      await pageA.waitForTimeout(100);
      got = await locks();
    }
    return got;
  };

  // Alpha connects, and powered off lets go: nothing to Connect to, and Change connection… still there.
  await pageA.goto(`${base}/web/app/?m=${a}`);
  await started(pageA);
  await newTailnet(pageA, { hostname: 'alpha', pick: false });
  const [t] = await records(pageA, 'connections');
  assert.deepEqual(await locks(), [`webpc-net:${t.id}`]);
  await pageA.click('#power-off');
  await pageA.waitForFunction(() => document.getElementById('state')?.dataset.state === 'off', null, { timeout: 30_000 });
  await pageA.waitForFunction(() => document.getElementById('network')!.dataset.phase === 'off', null, { timeout: 10_000 });
  assert.deepEqual(await locksBecome([]), [], 'its lock is let go');
  assert.equal((await records(pageA, 'connections'))[0].connectAtStart, true, "it isn't a Disconnect");
  await menu(pageA);
  assert.equal(await pageA.locator('#net-connect-now').isVisible(), false);
  assert.equal(await text(pageA, '#net-setup'), CHANGE);

  // Bravo runs in another tab; from Alpha's tab, attaching to it connects it there at once.
  const pageB = await context.newPage();
  pageB.on('pageerror', (e) => errors.push(`B: ${e}`));
  await pageB.goto(`${base}/web/app/?m=${b}`);
  await started(pageB);
  assert.equal(await phase(pageB), 'off');
  await pageA.click('#machines-open');
  await pageA.click(`[data-machine="${b}"]`);
  await pageA.click('[data-tab="network"]');
  await pageA.click('[data-adapter="0"] [data-action="attach-connection"]');
  await pageA.locator(`#net-wizard [data-connection="${t.id}"]`).click();
  assert.equal(await text(pageA, '#net-connect'), ATTACH);
  await pageA.click('#net-connect');
  await pageB.waitForFunction(() => document.getElementById('network')!.dataset.phase !== 'off', null, { timeout: 15_000 });
  assert.deepEqual(await locksBecome([`webpc-net:${t.id}`]), [`webpc-net:${t.id}`], 'Bravo holds it');
  await menu(pageB);
  assert.match(await text(pageB, '#net-conn'), /127\.0\.0\.1:1/);
  // Detached there, it stops here.
  await pageA.click('[data-adapter="0"] [data-action="detach-connection"]');
  await pageB.waitForFunction(() => document.getElementById('network')!.dataset.phase === 'off', null, { timeout: 15_000 });
  assert.deepEqual(await locksBecome([]), []);
  // The menu's line follows the phase a moment later (under CI's load it was read before it moved: 2026-11-02).
  await pageB.waitForFunction((words) => (document.querySelector('#net-conn')?.textContent ?? '').includes(words), NO_CONNECTION, { timeout: 5_000 }).catch(() => {});
  assert.ok((await text(pageB, '#net-conn')).includes(NO_CONNECTION), 'the menu says no connection is attached');
  await pageB.close();

  // Alpha, off: a second adapter, moved first. The first can't go up, the last can't go down, and Save keeps the order.
  await pageA.click(`[data-machine="${a}"]`);
  await pageA.click('[data-tab="network"]');
  await pageA.click('[data-action="add-adapter"]');
  assert.equal(await pageA.locator('[data-adapter="0"] [data-action="adapter-up"]').isDisabled(), true);
  assert.equal(await pageA.locator('[data-adapter="1"] [data-action="adapter-down"]').isDisabled(), true);
  await pageA.click('[data-action="save"]');
  await pageA.waitForFunction(() => document.querySelector('[data-action="save"]')?.hasAttribute('disabled') !== false, null, { timeout: 10_000 });
  const macs = async () => ((await records(pageA, 'machines')).find((m) => m.id === a)!.adapters as { mac: string }[]).map((x) => x.mac);
  const before = await macs();
  assert.equal(before.length, 2);
  await pageA.click('[data-adapter="1"] [data-action="adapter-up"]');
  await pageA.click('[data-action="save"]');
  await pageA.waitForFunction(() => document.querySelector('[data-action="save"]')?.hasAttribute('disabled') !== false, null, { timeout: 10_000 });
  assert.deepEqual(await macs(), [before[1], before[0]]);

  // Still off, the new adapter (now first) gets the connection from its row: the row says so at once (Change
  // connection… and Detach), with no reload, though nothing connects until the machine starts; Detach brings Attach back.
  const row = '.adapters [data-adapter="0"]';
  const rowShows = (attached: boolean) => pageA.waitForFunction(([sel, attached, change]) => {
    const detach = !!document.querySelector(`${sel} [data-action="detach-connection"]`);
    return detach === attached && (document.querySelector(`${sel} [data-action="attach-connection"]`)?.textContent === change) === attached;
  }, [row, attached, CHANGE_ADAPTER] as const, { timeout: 5_000 })
    .catch(async (e) => { throw new Error(`${e}; the row says ${await text(pageA, row)}`); });
  await rowShows(false);
  await pageA.click(`${row} [data-action="attach-connection"]`);
  await pageA.locator(`#net-wizard [data-connection="${t.id}"]`).click();
  assert.equal(await text(pageA, '#net-connect'), ATTACH);
  await pageA.click('#net-connect');
  await rowShows(true);
  assert.equal(((await records(pageA, 'machines')).find((m) => m.id === a)!.adapters as { connection?: string }[])[0].connection, t.id, 'kept in the record');
  await pageA.click(`${row} [data-action="detach-connection"]`);
  await rowShows(false);
  assert.deepEqual(errors, []);
});
