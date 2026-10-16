// The page's Network menu (docs/frontend.md "Network") in headless Chromium, on Debian, without a
// control server that answers: what the page does around the client. Connecting with a bad URL is
// refused in the form; connecting with an auth key starts the client without restarting the machine (it
// has its network card from the boot: the guest sees eth0 on its serial console); the client can't
// reach 127.0.0.1:1, so the menu shows it's connecting or failed, never connected; the settings are
// kept but never the key, a reload asks for the key again; Disconnect stops the client. What needs a
// control server (login, the address, peers) is tests/net-tailnet.test.ts's. The tailcat kind
// (docs/plans/tailnet-client.md T2): the fields swap, a malformed address is refused, and with
// WEBPC_TAILCAT=1 an address of a server that isn't there (tests/net/tailcat.sh's relay, another
// key) is waited for, then fails; the address is never kept. Two Debian boots, ~4 min alone.
// Opt-in with WEBPC_DISTROS=debian, like Debian's other Chromium tests.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { unattendedQuery } from './debian-unattended.ts';
import { withDebianLock } from './debian-lock.ts';
import { PAGE_QUERY } from './page-query.ts';

const IMAGE = new URL('../target/images/debian/disk.qcow2', import.meta.url);
const FIRMWARE = new URL('../target/images/edk2/QEMU_EFI.fd', import.meta.url);
const WASM = new URL('../target/net/tailscale.wasm', import.meta.url);
const skip = process.env.WEBPC_NET_TESTS !== '1' ? 'SKIPPED: scripts/ci-net.sh runs it (WEBPC_NET_TESTS=1)'
  : !(process.env.WEBPC_DISTROS ?? '').split(',').includes('debian') ? 'SKIPPED: set WEBPC_DISTROS=debian'
  : !existsSync(IMAGE) || !existsSync(FIRMWARE) ? 'SKIPPED: run npm start (or images/build.sh debian edk2)'
  : !existsSync(WASM) ? 'SKIPPED: build the Tailscale client (net/tailscale/build.sh; needs Go)'
  : undefined;
const TAILCAT = new URL('../tests/net/tailcat.sh', import.meta.url).pathname;
const tailcatOn = !skip && process.env.WEBPC_TAILCAT === '1' && existsSync(new URL('../target/net/ts.wasm', import.meta.url));

/** The address with its server key changed: well-formed, on the same relay, but nobody answers it. */
function otherServer(addr: string) {
  const b = Buffer.from(addr.slice(2), 'base64url');
  const at = b.indexOf(Buffer.from([0x61, 0x70, 0x58, 0x20])); // "p": bytes(32)
  assert.ok(at >= 0, 'the address has its server key');
  b[at + 4] ^= 0xff;
  return `tc${b.toString('base64url')}`;
}

let tailcatRig: string | undefined;
let browser: Browser;
let base: string;
let close: () => void;
before(async () => {
  if (skip) return;
  const server = await startServer();
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
  if (tailcatOn) tailcatRig = /WEBPC_TAILCAT_ADDR=(\S+)/.exec(execFileSync(TAILCAT, ['up'], { encoding: 'utf8', timeout: 300_000 }))![1];
});
after(async () => { await browser?.close(); close?.(); if (tailcatOn) spawnSync(TAILCAT, ['down']); });

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

test('the Network menu: a bad URL is refused; connecting starts the client without a restart; the key is not kept; Disconnect stops it', { skip, timeout: 20 * 60_000 }, () => withDebianLock(async () => {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, ignoreHTTPSErrors: true }); // a fresh profile: empty storage; the tailcat rig's relay has a self-signed certificate
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const dialogs: string[] = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); void d.accept(); });
  try {
    await page.goto(`${base}/web/app/?${PAGE_QUERY}ncpus=2&view=both&${unattendedQuery()}`);
    assert.equal(await page.locator('#network').isVisible(), true, 'Debian can have a card');
    await page.locator('#network summary').click();
    assert.match((await page.locator('#net-status').textContent())!, /Not connected/);
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

    // Connect with an auth key: no restart (the card is there from the boot), so no question either.
    await page.fill('#net-hostname', 'testbox');
    await page.fill('#net-authkey', 'tskey-auth-SECRET-1234');
    assert.equal(await page.getAttribute('#net-authkey', 'type'), 'password');
    await page.check('#net-reveal');
    assert.equal(await page.getAttribute('#net-authkey', 'type'), 'text');
    await page.uncheck('#net-reveal');
    assert.equal(await page.getAttribute('#net-authkey', 'type'), 'password');
    await page.click('#net-connect');
    await page.waitForFunction(() => document.getElementById('network')!.dataset.phase !== 'off', null, { timeout: 30_000 });
    assert.equal(await page.locator('#net-form').isVisible(), false, 'the form gives way to the actions while a client runs');
    assert.equal(await page.locator('#net-logout').isVisible(), false, "an auth key's node can't be logged out of");
    assert.equal(await page.locator('#net-disconnect').isVisible(), true);
    assert.ok(['connecting', 'login', 'error'].includes((await phase(page))!), `unreachable control server: ${await phase(page)}`);
    const saved = await settings(page);
    assert.ok(!saved.includes('SECRET'), 'the auth key is never saved');
    assert.deepEqual(JSON.parse(saved).net, { controlURL: 'http://127.0.0.1:1', hostname: 'testbox', autoconnect: false, keyed: true, exitNode: '', kind: 'tailscale' });

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
    assert.equal(await page.locator('#net-remove').count(), 0, 'the card is always there: nothing to remove');

    // The tailcat kind: the fields swap; a malformed address is refused in the form.
    await page.selectOption('#net-kind', 'tailcat');
    assert.equal(await page.locator('#net-control').isVisible(), false);
    assert.equal(await page.locator('#net-tailcat').isVisible(), true);
    assert.equal(await page.getAttribute('#net-tailcat', 'type'), 'password', 'the address is a secret');
    await page.fill('#net-tailcat', 'tcnot-an-address');
    await page.click('#net-connect');
    assert.match((await page.locator('#net-error').textContent())!, /isn't a tailcat address/);
    assert.equal(await phase(page), 'off');
    // A well-formed address of a server that isn't there (the rig's relay, another server key): the
    // client meows unanswered, then gives up with an error; Disconnect brings back the form, the kind remembered.
    if (tailcatRig) {
      await page.fill('#net-tailcat', otherServer(tailcatRig));
      await page.click('#net-connect');
      await page.waitForFunction(() => /Waiting for the tailcat server/.test(document.getElementById('net-status')!.textContent!), null, { timeout: 15_000, polling: 100 })
        .catch(async (e) => { throw new Error(`${e}; the menu said ${await page.evaluate(() => [document.getElementById('network')!.dataset.phase, document.getElementById('net-status')!.textContent, document.getElementById('net-error')!.textContent])}`); });
      assert.equal(await page.locator('#net-tailcat').inputValue(), '', 'the address leaves the field');
      await page.waitForFunction(() => document.getElementById('network')!.dataset.phase === 'error', null, { timeout: 30_000, polling: 250 });
      assert.match((await page.locator('#net-status').textContent())!, /Couldn't connect/);
      assert.ok(!(await settings(page)).includes(tailcatRig.slice(2, 30)), 'the address is never saved');
      await page.click('#net-disconnect');
      await page.waitForFunction(() => document.getElementById('network')!.dataset.phase === 'off', null, { timeout: 10_000 });
      assert.equal(await page.locator('#net-kind').inputValue(), 'tailcat');
      assert.equal(await page.locator('#net-tailcat').isVisible(), true);
      assert.equal(await page.locator('#net-tailcat').inputValue(), '');
    } else console.log('# SKIPPED: the menu against a tailcat relay (WEBPC_TAILCAT=1 and net/ts/build.sh)');
    assert.equal(JSON.parse(await settings(page)).net.kind, 'tailcat', 'the kind is kept');
    await page.selectOption('#net-kind', 'tailscale');
    assert.equal(await page.locator('#net-control').isVisible(), true);

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
    assert.deepEqual(dialogs, [], 'connecting and disconnecting never restart the machine');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}));
