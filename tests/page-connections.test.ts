// The browser's network connections on the page (docs/plans/network-adapters.md §3), in Chromium, on two stored machines
// whose only disk is blank: the firmware runs and finds nothing to boot, which is all an adapter needs to be live (its
// client gets the machine's port at the start). The control server, 127.0.0.1:1, never answers, so no client gets
// further than trying, and its connection is held all the same. A new machine connects in one wizard (no connections
// yet: straight to the kind); a second tab's machine sees that connection in use by the first, named, and takes it
// after asking, the first saying so; the Network tab detaches it; an ephemeral connection is kept nowhere and is gone
// after a reload, its adapter detached and saying why; Connections renames and deletes (naming the machines it is on).
// Needs the firmware (images/build.sh edk2) and the tailnet client (net/ts/build.sh).
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { answerAsks } from './page-ask.ts';

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
  assert.match(await text(pageA, '#net-conn'), /No connection attached/);
  await newTailnet(pageA, { hostname: 'alpha', pick: false });
  const [t] = await records(pageA, 'connections');
  assert.ok(t, 'the connection is kept');
  assert.deepEqual(t.tailnet, { controlURL: 'http://127.0.0.1:1', hostname: 'alpha', exitNode: '', stateKey: t.id });
  assert.equal(t.ephemeral, false);
  assert.equal((await adapterOf(pageA, a)).connection, t.id, 'attached to Alpha\'s adapter');
  assert.match(await text(pageA, '#net-conn'), /127\.0\.0\.1:1/);
  assert.equal(await text(pageA, '#net-setup'), 'Change connection…');

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
  await pageB.waitForFunction((id) => /in use by Alpha/.test(document.querySelector(`[data-connection="${id}"]`)?.textContent ?? ''), t.id, { timeout: 5_000 });
  await choice.click();
  assert.equal(await text(pageB, '#net-connect'), 'Connect');
  await pageB.click('#net-connect');
  await pageB.waitForFunction(() => document.getElementById('network')!.dataset.phase !== 'off', null, { timeout: 30_000 });
  assert.equal(asked.length, 1, `asked once: ${asked}`);
  assert.match(asked[0], /^B: .*in use by Alpha.*Use it here/);
  await pageA.waitForFunction(() => document.getElementById('network')!.dataset.phase === 'off', null, { timeout: 15_000 });
  await menu(pageA);
  assert.match(await text(pageA, '#net-hint'), /taken by another machine/);
  assert.equal(await pageA.locator('#net-connect-now').isVisible(), true, 'Alpha keeps it attached: Connect is there');
  assert.equal((await adapterOf(pageB, b)).connection, t.id, 'attached to Bravo too');

  // Alpha's Network tab: Detach takes it off Alpha.
  await pageA.click('#machines-open');
  await pageA.click('[data-tab="network"]');
  await pageA.waitForSelector('[data-adapter="0"] [data-action="detach-connection"]');
  await pageA.click('[data-adapter="0"] [data-action="detach-connection"]');
  await pageA.waitForFunction(() => /No connection/.test(document.querySelector('[data-adapter="0"] [data-connection-name]')?.textContent ?? ''), null, { timeout: 10_000 });
  assert.equal((await adapterOf(pageA, a)).connection, undefined);

  // Bravo: an ephemeral connection in its place, kept nowhere; after a reload it is gone and the adapter says so.
  await menu(pageB);
  await newTailnet(pageB, { hostname: 'bravo', pick: true, keep: false });
  assert.equal((await records(pageB, 'connections')).length, 1, 'the ephemeral one is not stored');
  assert.match(await text(pageB, '#net-conn'), /ephemeral/);
  const eph = (await adapterOf(pageB, b)).connection;
  assert.ok(eph && eph !== t.id);
  await pageB.reload();
  await started(pageB);
  await pageB.waitForFunction(() => /gone/.test(document.getElementById('net-hint')?.textContent ?? ''), null, { timeout: 15_000 });
  assert.equal(await phase(pageB), 'off');
  assert.match(await text(pageB, '#net-conn'), /No connection attached/);
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
  assert.match(asked[0], /Delete the connection Home tailnet\?/);
  assert.deepEqual(await records(pageB, 'connections'), []);
  assert.deepEqual(errors, []);
});
