// The page's Network menu (docs/frontend.md "Network") in headless Chromium, on Debian, without a
// control server that answers: what the page does around the client. Connecting with a bad URL is
// refused in the form; connecting with an auth key gives the machine a network card (the guest sees
// eth0 on its serial console), starts the client (which can't reach 127.0.0.1:1: the menu shows it's
// connecting or failed, never connected), keeps the settings but never the key, and a reload boots
// the machine with the card and asks for the key again; Disconnect stops the client. What needs a
// control server (login, the address, peers) is tests/net-tailnet.test.ts's. Two Debian boots,
// ~4 min alone. Opt-in with WEBPC_DISTROS=debian, like Debian's other Chromium tests.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { withDebianLock } from './debian-lock.ts';

const IMAGE = new URL('../target/images/debian/Image', import.meta.url);
const WASM = new URL('../target/net/tailscale.wasm', import.meta.url);
const skip = !(process.env.WEBPC_DISTROS ?? '').split(',').includes('debian') ? 'SKIPPED: set WEBPC_DISTROS=debian'
  : !existsSync(IMAGE) ? 'SKIPPED: run tools/debian.ts (or npm start)'
  : !existsSync(WASM) ? 'SKIPPED: build the Tailscale client (net/tailscale/build.sh; needs Go)'
  : undefined;

let browser: Browser;
let base: string;
let close: () => void;
before(async () => {
  if (skip) return;
  const server = await startServer();
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
});
after(async () => { await browser?.close(); close?.(); });

const BOOT_MS = 180_000;
const terminal = (page: Page) => page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '');
const shows = (page: Page, re: RegExp, ms = 60_000) =>
  page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.xterm-rows')?.textContent ?? ''), re.source, { timeout: ms, polling: 100 })
    .catch(async (e) => { throw new Error(`${e}; the terminal shows: ${await terminal(page)}`); });
async function onSerial(page: Page, text: string) {
  await page.locator('.xterm').click();
  await page.keyboard.type(text, { delay: 10 });
}
async function running(page: Page) {
  await page.waitForFunction(() => ['running', 'failed', 'crashed', 'idle', 'off'].includes(document.body.dataset.state!), null, { timeout: BOOT_MS, polling: 250 })
    .catch(async (e) => {
      const [state, status, message, net] = await page.evaluate(() => [document.body.dataset.state, document.getElementById('status')!.textContent, document.getElementById('message-text')!.textContent, document.getElementById('net-status')!.textContent]);
      throw new Error(`${e}; the page is ${state} (${status}; ${message}; network: ${net}); the terminal shows: ${await terminal(page)}`);
    });
  const [state, message] = await page.evaluate(() => [document.body.dataset.state, document.getElementById('message-text')!.textContent]);
  assert.equal(state, 'running', message ?? '');
}
const phase = (page: Page) => page.evaluate(() => document.getElementById('network')!.dataset.phase);
const settings = (page: Page) => page.evaluate(() => localStorage.getItem('webpc.settings') ?? '');

test('the Network menu: a bad URL is refused; connecting adds a card and starts the client; the key is not kept; Disconnect stops it', { skip, timeout: 20 * 60_000 }, () => withDebianLock(async () => {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } }); // a fresh profile: empty storage
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const dialogs: string[] = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); void d.accept(); });
  try {
    await page.goto(`${base}/web/app/?ncpus=2&view=both`);
    assert.equal(await page.locator('#network').isVisible(), true, 'Debian can have a card');
    await page.locator('#network summary').click();
    assert.match((await page.locator('#net-status').textContent())!, /No network card/);
    assert.equal(await page.locator('#net-disconnect').isVisible(), false);

    // A bad control server is refused in the form: nothing restarts, nothing is saved.
    await page.fill('#net-control', 'ftp://example.com');
    await page.click('#net-connect');
    assert.match((await page.locator('#net-error').textContent())!, /https/);
    await page.fill('#net-hostname', 'no good');
    await page.fill('#net-control', 'http://127.0.0.1:1');
    await page.click('#net-connect');
    assert.match((await page.locator('#net-error').textContent())!, /hostname/i);
    assert.equal(await settings(page), '', 'nothing saved');
    assert.deepEqual(dialogs, []);

    // Connect with an auth key: the machine restarts with a card (it was still loading: no question).
    await page.fill('#net-hostname', 'testbox');
    await page.fill('#net-authkey', 'tskey-auth-SECRET-1234');
    await page.click('#net-connect');
    await page.waitForFunction(() => document.getElementById('network')!.dataset.phase !== 'off', null, { timeout: 30_000 });
    assert.equal(await page.locator('#net-form').isVisible(), false, 'the form gives way to the actions while a client runs');
    assert.equal(await page.locator('#net-logout').isVisible(), false, "an auth key's node can't be logged out of");
    assert.equal(await page.locator('#net-disconnect').isVisible(), true);
    assert.ok(['connecting', 'login', 'error'].includes((await phase(page))!), `unreachable control server: ${await phase(page)}`);
    const saved = await settings(page);
    assert.ok(!saved.includes('SECRET'), 'the auth key is never saved');
    assert.deepEqual(JSON.parse(saved).net, { enabled: true, controlURL: 'http://127.0.0.1:1', hostname: 'testbox', autoconnect: false, keyed: true });

    // The machine has the card: its guest sees eth0.
    await running(page);
    await onSerial(page, 'root\n');
    await shows(page, /root@\S+:~# /);
    await onSerial(page, 'ls /sys/cla""ss/net | tr "\\n" " "; echo\n');
    await shows(page, /eth0/);

    // Disconnect: the client stops (the port comes back), the form again; the card stays.
    await page.locator('#network summary').click();
    await page.click('#net-disconnect');
    await page.waitForFunction(() => document.getElementById('network')!.dataset.phase === 'off', null, { timeout: 10_000 });
    assert.equal(await page.locator('#net-form').isVisible(), true);
    assert.equal(await page.locator('#net-remove').isVisible(), true, 'the card stays until it is removed');

    // A reload: the machine boots with the card, the client isn't started (no key to start it with).
    await page.reload();
    assert.match((await page.locator('#net-hint').textContent())!, /auth key/i);
    assert.equal(await page.locator('#net-control').inputValue(), 'http://127.0.0.1:1');
    assert.equal(await phase(page), 'off');
    await running(page);
    await onSerial(page, 'root\n');
    await shows(page, /root@\S+:~# /);
    await onSerial(page, 'ls /sys/cla""ss/net | tr "\\n" " "; echo\n');
    await shows(page, /eth0/);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}));
