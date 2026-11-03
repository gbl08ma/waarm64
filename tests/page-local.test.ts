// The local helper as a connection on the page (docs/frontend.md "Network", docs/plans/networking-local.md L2), in
// Chromium, on a stored machine whose only disk is blank (the firmware runs and finds nothing to boot: all an adapter
// needs to be live). The helper's pairing link opens the page: the fragment leaves the address, the Network wizard opens
// on This computer with the link filled in, and Attach keeps a `local` connection on the machine's first adapter, which
// connects at its start through the real helper (built at the commit tests/webpc-net.ts pins). Stopping the helper is said in the menu,
// and Retry, once it runs again, connects again; a link to no helper says it isn't running. And from a public origin,
// where Chromium's Local Network Access gates the socket: connected once allowed, the refusal said where to change it.
// Needs the firmware (images/build.sh edk2) and Go.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { buildHelper, helperSkip } from './webpc-net.ts';
import { t } from '../web/i18n.ts';
import { RELEASE } from '../web/local-release.ts';
import { words } from './words.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const skip = !existsSync(`${ROOT}target/images/edk2/QEMU_EFI.fd`) ? 'SKIPPED: run images/build.sh edk2' : helperSkip();

let browser: Browser;
/** The same Chromium with the test server's address called public, as https://vm.tny.im is: Local Network Access gates its sockets to loopback. */
let publicBrowser: Browser;
let base: string;
let closeServer: () => void;
let helper: ChildProcess | undefined;
let port = 0;
const token = randomBytes(32).toString('base64url');

const freePort = () => new Promise<number>((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const p = (s.address() as AddressInfo).port;
    s.close(() => resolve(p));
  });
});

/** Starts the helper on `port` with the test's token, accepting the test server's origin; resolves once it listens. */
async function startHelper() {
  let log = '';
  helper = spawn(`${ROOT}target/net/webpc-net`, ['--listen', `127.0.0.1:${port}`, '--origin', base], { env: { ...process.env, WEBPC_NET_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
  helper.stdout!.on('data', (d) => { log += d; });
  helper.stderr!.on('data', (d) => { log += d; });
  for (let k = 0; k < 100 && !log.includes('listening on'); k++) await new Promise((r) => setTimeout(r, 100));
  assert.match(log, /listening on/, `the helper didn't start: ${log}`);
}
const stopHelper = () => new Promise<void>((resolve) => {
  if (!helper || helper.exitCode !== null) return resolve();
  helper.once('exit', () => resolve());
  helper.kill();
});

before(async () => {
  if (skip) return;
  buildHelper();
  const server = await startServer();
  closeServer = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  port = await freePort();
  await startHelper();
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
  publicBrowser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', args: [`--ip-address-space-overrides=${new URL(base).host}=public`] });
});
after(async () => { await browser?.close(); await publicBrowser?.close(); closeServer?.(); await stopHelper(); });

/** A stored machine with a blank disk and one adapter, made through the page's own code. */
const seed = (page: Page) => page.evaluate(async (modules) => {
  const { Store } = await import(modules[0]) as typeof import('../web/app/store.ts');
  const { attach, createDisk, createMachine } = await import(modules[1]) as typeof import('../web/app/machines.ts');
  const store = await Store.open();
  const m = await createMachine(store, { name: 'Alpha', ncpus: 1, ramMiB: 256, display: '2d', usb: false });
  await attach(store, m, await createDisk(store, { kind: 'blank', size: 64 << 20, name: 'Alpha disk' }));
  store.close();
  return m.id;
}, ['/web/app/store.ts', '/web/app/machines.ts']);
const connections = (page: Page) => page.evaluate(() => new Promise<{ id: string; kind: string; name: string; local?: { url: string } }[]>((resolve, reject) => {
  const open = indexedDB.open('webpc');
  open.onsuccess = () => {
    const req = open.result.transaction('connections').objectStore('connections').getAll();
    req.onsuccess = () => { open.result.close(); resolve(req.result); };
    req.onerror = () => reject(req.error);
  };
  open.onerror = () => reject(open.error);
}));
const phaseIs = (page: Page, p: string, ms = 30_000) => page.waitForFunction((want) => document.getElementById('network')?.dataset.phase === want, p, { timeout: ms });
async function menu(page: Page) {
  if (!(await page.evaluate(() => (document.getElementById('network') as HTMLDetailsElement).open))) await page.locator('#network summary').click();
}

test("the helper's pairing link: the wizard on This computer, Attach, connected at the start; a stopped helper said, Retry", { skip, timeout: 5 * 60_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  try {
    await page.goto(`${base}/web/app/`);
    const id = await seed(page);
    const ws = `ws://127.0.0.1:${port}/${token}`;
    await page.goto(`${base}/web/app/?m=${id}#net=${ws}`);
    // The dialog is made when the page mounts, after its start's awaits (the store, the network's migration): `goto`
    // can return before that, and a predicate that throws ends the wait.
    await page.waitForFunction(() => (document.getElementById('net-wizard') as HTMLDialogElement | null)?.open === true, null, { timeout: 15_000 });
    assert.equal(new URL(page.url()).hash, '', 'the token left the address');
    assert.equal(await page.locator('#net-step-local').isVisible(), true, 'on This computer');
    assert.equal(await page.inputValue('#net-local-url'), ws);
    assert.equal(await page.locator('#net-local-install summary').textContent(), t('network:NetWizard.install', { version: RELEASE.version }));
    assert.ok(((await page.locator('#net-local-lines').textContent()) ?? '').includes(`/releases/download/${RELEASE.version}/`), 'the release\'s install lines');
    assert.equal(await page.isChecked('#net-keep'), true);
    assert.equal(await page.locator('#net-connect').textContent(), t('network:NetWizard.attach'), 'the machine is off: attached, connecting at its start');
    await page.click('#net-connect');
    await page.waitForFunction(() => !(document.getElementById('net-wizard') as HTMLDialogElement).open, null, { timeout: 10_000 });
    const [c] = await connections(page);
    assert.deepEqual([c.kind, c.name, c.local], ['local', t('network:connections.thisComputer'), { url: ws }]);

    // The machine starts and its adapter connects through the helper.
    await page.reload();
    await phaseIs(page, 'connected');
    await menu(page);
    assert.match((await page.locator('#net-status').textContent()) ?? '', words('network:network.connectedLocal', {}, { start: true }));
    assert.ok(((await page.locator('#net-conn').textContent()) ?? '').includes(t('network:connections.thisComputer')), 'the connection is This computer');

    // The helper stops: the menu says so; Retry once it runs again connects again.
    await stopHelper();
    await phaseIs(page, 'error');
    assert.match((await page.locator('#net-status').textContent()) ?? '', words('network:local-net.closed'));
    await startHelper();
    await page.click('#net-retry');
    await phaseIs(page, 'connected');

    // A link to no helper: it says it isn't running.
    await stopHelper();
    await phaseIs(page, 'error');
    await page.click('#net-retry');
    await page.waitForFunction((src) => new RegExp(src).test(document.getElementById('net-status')?.textContent ?? ''), words('network:local-net.unreached').source, { timeout: 15_000 });
    await startHelper();
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('a pairing link opened in a tab that already shows the page: the fragment changes only, and the wizard opens', { skip, timeout: 2 * 60_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto(`${base}/web/app/`);
    const id = await seed(page);
    await page.goto(`${base}/web/app/?m=${id}`);
    await page.waitForFunction(() => !!document.getElementById('net-wizard'), null, { timeout: 15_000 });
    const ws = `ws://127.0.0.1:${port}/${token}`;
    await page.evaluate((h) => { location.hash = h; }, `#net=${ws}`); // no reload: a fragment's change only
    await page.waitForFunction(() => (document.getElementById('net-wizard') as HTMLDialogElement).open, null, { timeout: 10_000 });
    assert.equal(new URL(page.url()).hash, '', 'the token left the address');
    assert.equal(await page.inputValue('#net-local-url'), ws);
  } finally {
    await context.close();
  }
});

/** Through the helper's pairing link: a stored machine whose first adapter is attached to a new `local` connection. */
async function pairAndAttach(page: Page) {
  await page.goto(`${base}/web/app/`);
  const id = await seed(page);
  await page.goto(`${base}/web/app/?m=${id}#net=ws://127.0.0.1:${port}/${token}`);
  await page.waitForFunction(() => (document.getElementById('net-wizard') as HTMLDialogElement | null)?.open === true, null, { timeout: 15_000 });
  await page.click('#net-connect');
  await page.waitForFunction(() => !(document.getElementById('net-wizard') as HTMLDialogElement).open, null, { timeout: 10_000 });
}

// Chromium's Local Network Access (bench/net/REPORT.md "The local helper"): a public page's socket to loopback needs the
// `loopback-network` permission. Granted (through CDP: Playwright's grantPermissions doesn't know the name), the adapter
// connects as on a local page; refused (headless shows no prompt, so the ask ends denied), the menu says where the
// setting is rather than that the helper isn't running.
test('from a public origin: granted, the adapter connects; refused, the menu says where to allow it', { skip, timeout: 5 * 60_000 }, async () => {
  for (const granted of [true, false]) {
    const context = await publicBrowser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    try {
      await page.goto(`${base}/web/app/`);
      assert.equal(await page.evaluate(async () => (await navigator.permissions.query({ name: 'loopback-network' as PermissionName })).state), 'prompt', 'the page is gated');
      if (granted) {
        const cdp = await context.newCDPSession(page);
        const { targetInfo } = await cdp.send('Target.getTargetInfo');
        await cdp.send('Browser.setPermission', { permission: { name: 'loopback-network' }, setting: 'granted', origin: base, browserContextId: targetInfo.browserContextId });
      }
      await pairAndAttach(page);
      await page.reload();
      if (granted) {
        await phaseIs(page, 'connected');
        await menu(page);
        assert.match((await page.locator('#net-status').textContent()) ?? '', words('network:network.connectedLocal', {}, { start: true }));
      } else {
        await phaseIs(page, 'error');
        await menu(page);
        assert.match((await page.locator('#net-status').textContent()) ?? '', words('network:local-net.refused'));
      }
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
});
