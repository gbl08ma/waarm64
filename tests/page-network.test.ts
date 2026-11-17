// The page's Network wizard and menu (docs/frontend.md "Network") in headless Chromium, on Debian,
// without a control server that answers: what the page does around the clients. The wizard opens
// at the choice (a tailnet or tailcat), and each kind's step refuses what's wrong in the form;
// connecting with an auth key starts the client without restarting the machine (it has its
// network card from the boot: the guest sees eth0 on its serial console); the client can't reach
// 127.0.0.1:1, so the menu shows it's connecting or failed, never connected; the connection is
// kept (docs/networking/adapters.md) but never the key; Disconnect stops the client, which
// stays off over a reload. tailcat (docs/networking/tailnet.md "tailcat"): neither choice, or a malformed
// address, is refused; with WAARM64_TAILCAT=1 (tests/net/tailcat.sh's relay) an address of a server
// that isn't there, on an ephemeral connection (never stored), is waited for, then fails, and the
// machine lets tailcat clients in on that relay: the menu shows its address, the tailcat CLI
// reaches a web server in the guest through it, the address is the same after a reload (which
// reconnects by itself) and a new one after New address (the connection's Edit). An ephemeral
// tailnet connection is gone after the last reload. What needs a control server (login, the
// address, peers) is tests/net-tailnet.test.ts's. Two Debian boots, ~4 min alone. Opt-in with
// WAARM64_DISTROS=debian, like Debian's other Chromium tests.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { unattendedQuery } from './debian-unattended.ts';
import { withDebianLock } from './debian-lock.ts';
import { PAGE_QUERY } from './page-query.ts';
import { t } from '../web/i18n.ts';
import { words } from './words.ts';
import { answerAsks } from './page-ask.ts';

const IMAGE = new URL('../target/images/debian/disk.qcow2', import.meta.url);
const FIRMWARE = new URL('../target/images/edk2/QEMU_EFI.fd', import.meta.url);
const WASM = new URL('../target/net/ts.wasm', import.meta.url);
const skip = process.env.WAARM64_NET_TESTS !== '1' ? 'SKIPPED: scripts/ci-net.sh runs it (WAARM64_NET_TESTS=1)'
  : !(process.env.WAARM64_DISTROS ?? '').split(',').includes('debian') ? 'SKIPPED: set WAARM64_DISTROS=debian'
  : !existsSync(IMAGE) || !existsSync(FIRMWARE) ? 'SKIPPED: run images/build.sh debian edk2'
  : !existsSync(WASM) ? 'SKIPPED: build the tailnet client (net/ts/build.sh)'
  : undefined;
const TAILCAT = new URL('../tests/net/tailcat.sh', import.meta.url).pathname;
const tailcatOn = !skip && process.env.WAARM64_TAILCAT === '1' && existsSync(new URL('../target/net/ts.wasm', import.meta.url));

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
  if (tailcatOn) tailcatRig = /WAARM64_TAILCAT_ADDR=(\S+)/.exec(execFileSync(TAILCAT, ['up'], { encoding: 'utf8', timeout: 300_000 }))![1];
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
      const [state, status, message, net] = await page.evaluate(() => [document.body.dataset.state, (document.getElementById('status')?.textContent ?? ''), (document.getElementById('message-text')?.textContent ?? ''), document.getElementById('net-status')!.textContent]);
      throw new Error(`${e}; the page is ${state} (${status}; ${message}; network: ${net}); the terminal shows: ${await terminal(page)}`);
    });
  const [state, message] = await page.evaluate(() => [document.body.dataset.state, (document.getElementById('message-text')?.textContent ?? '')]);
  assert.equal(state, 'running', message ?? '');
}
const phase = (page: Page) => page.evaluate(() => document.getElementById('network')!.dataset.phase);
/** The connections IndexedDB `waarm64` keeps (the stored ones: an ephemeral one is in the page's memory only). */
const connections = (page: Page) => page.evaluate(() => new Promise<{ id: string; name: string; ephemeral: boolean; connectAtStart: boolean; tailnet?: Record<string, string>; tailcat?: Record<string, unknown> }[]>((resolve, reject) => {
  const open = indexedDB.open('waarm64');
  open.onsuccess = () => {
    const req = open.result.transaction('connections').objectStore('connections').getAll();
    req.onsuccess = () => { open.result.close(); resolve(req.result); };
    req.onerror = () => reject(req.error);
  };
  open.onerror = () => reject(open.error);
}));

const ROOT = new URL('..', import.meta.url).pathname;

/** The tailcat CLI (tests/net/tailcat.sh built it) as a client, `input` on its stdin; its stdout. Never synchronous: this
 * process serves the page's disk, and a guest reading it while the CLI waits on the guest would wait for the timeout. */
async function tailcatCLI(args: string[], input: string): Promise<string> {
  const child = spawn(`${ROOT}target/net/tailcat-test/bin/tailcat`, args, {
    env: { ...process.env, SSL_CERT_FILE: `${ROOT}target/net/tailcat-test/certs/127.0.0.1.crt`, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1', HOME: `${ROOT}target/net/tailcat-test/run` },
  });
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8').on('data', (d: string) => { out += d; });
  child.stderr.setEncoding('utf8').on('data', (d: string) => { err += d; });
  child.stdin.end(input);
  const timer = setTimeout(() => child.kill(), 60_000);
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
  clearTimeout(timer);
  if (code !== 0 && !out) throw new Error(`tailcat ${args[0]}: exit ${code}; ${err.slice(-800)}`);
  return out;
}

const visible = (page: Page, sel: string) => page.locator(sel).isVisible();
const text = async (page: Page, sel: string) => (await page.locator(sel).textContent()) ?? '';
async function wizard(page: Page) {
  if (!(await page.evaluate(() => (document.getElementById('network') as HTMLDetailsElement).open))) await page.locator('#network summary').click();
  await page.click('#net-setup');
  assert.equal(await visible(page, '#net-wizard'), true, 'the wizard opens');
  // With connections in this browser it opens at them: New connection… goes on to the kind.
  if (await visible(page, '#net-step-pick')) await page.click('#net-pick-new');
  assert.equal(await visible(page, '#net-step-kind'), true, 'at the choice');
  assert.equal(await visible(page, '#net-connect'), false);
}
const statusIs = (page: Page, re: RegExp, ms: number) =>
  page.waitForFunction((src) => new RegExp(src).test(document.getElementById('net-status')!.textContent!), re.source, { timeout: ms, polling: 100 })
    .catch(async (e) => { throw new Error(`${e}; the menu said ${await page.evaluate(() => [document.getElementById('network')!.dataset.phase, document.getElementById('net-status')!.textContent, document.getElementById('net-menu-error')!.textContent])}`); });

test('the Network wizard and menu: a tailnet and tailcat, form errors, connecting without a restart, keys never kept, Disconnect; a served machine', { skip, timeout: 20 * 60_000 }, () => withDebianLock(async () => {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, ignoreHTTPSErrors: true }); // a fresh profile: empty storage; the tailcat rig's relay has a self-signed certificate
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const dialogs: string[] = [];
  await answerAsks(page, (q) => { dialogs.push(q.text); });
  try {
    await page.goto(`${base}/web/app/?${PAGE_QUERY}ncpus=2&view=both&${unattendedQuery()}`);
    await page.locator('#network').waitFor({ state: 'visible', timeout: 60_000 }); // Debian can have a card (once it starts)
    await page.locator('#network summary').click();
    assert.match(await text(page, '#net-status'), words('network:network-view.notConnected'));
    assert.equal(await text(page, '#net-setup'), t('network:NetAdapter.setup'));
    assert.equal(await visible(page, '#net-disconnect'), false);

    // A tailnet: a bad control server or hostname is refused in the form; nothing restarts, nothing of them is saved.
    await wizard(page);
    await page.click('#net-pick-tailnet');
    assert.equal(await visible(page, '#net-step-tailnet'), true);
    await page.fill('#net-control', 'ftp://example.com');
    await page.click('#net-connect');
    assert.match(await text(page, '#net-error'), words('network:network.notHttps'));
    await page.fill('#net-hostname', 'no good');
    await page.fill('#net-control', 'http://127.0.0.1:1');
    await page.click('#net-connect');
    assert.match(await text(page, '#net-error'), words('network:network.badHostname'));
    assert.deepEqual(await connections(page), [], 'nothing of it saved');
    // Back to the choice, and forward again: the fields are as they were.
    await page.click('#net-back');
    assert.equal(await visible(page, '#net-step-kind'), true);
    await page.click('#net-pick-tailnet');
    assert.equal(await page.locator('#net-control').inputValue(), 'http://127.0.0.1:1');
    assert.deepEqual(dialogs, []);

    // Connect with an auth key: no restart (the card is there from the boot), so no question either.
    await page.fill('#net-hostname', 'testbox');
    await page.fill('#net-authkey', 'tskey-auth-SECRET-1234');
    assert.equal(await page.getAttribute('#net-authkey', 'type'), 'password');
    await page.click('#net-authkey-show');
    assert.equal(await page.getAttribute('#net-authkey', 'type'), 'text');
    await page.click('#net-authkey-show');
    assert.equal(await page.getAttribute('#net-authkey', 'type'), 'password');
    await page.click('#net-connect');
    await page.waitForFunction(() => document.getElementById('network')!.dataset.phase !== 'off', null, { timeout: 30_000 });
    // It closes once the page has attached the connection, a moment after the menu's phase moves (a loaded host lost the race).
    await page.waitForFunction(() => !(document.getElementById('net-wizard') as HTMLDialogElement).open, null, { timeout: 10_000 });
    assert.equal(await visible(page, '#net-wizard'), false, 'the wizard closes');
    assert.equal(await visible(page, '#net-status'), true, 'the menu shows how it goes');
    assert.equal(await visible(page, '#net-logout'), true, 'a kept connection is a kept node: it can be logged out');
    assert.equal(await visible(page, '#net-disconnect'), true);
    assert.equal(await text(page, '#net-setup'), t('network:NetAdapter.change'));
    assert.ok(['connecting', 'login', 'error'].includes((await phase(page))!), `unreachable control server: ${await phase(page)}`);
    const saved = await connections(page);
    assert.ok(!JSON.stringify(saved).includes('SECRET'), 'the auth key is never saved');
    assert.equal(saved.length, 1);
    assert.deepEqual(saved[0].tailnet, { controlURL: 'http://127.0.0.1:1', hostname: 'testbox', exitNode: '', stateKey: saved[0].id });
    assert.equal(saved[0].connectAtStart, true);
    assert.ok(!(await page.evaluate(() => localStorage.getItem('waarm64.settings') ?? '')).includes('127.0.0.1:1'), 'no network settings of old');

    // The machine has the card: its guest sees eth0.
    await running(page);
    await shows(page, /login: /);
    await onSerial(page, 'root\n');
    await shows(page, /root@\S+:~# /);
    await onSerial(page, 'ls /sys/cla""ss/net | tr "\\n" " "; echo\n');
    await shows(page, /eth0/);

    // Disconnect: the client stops (the port comes back); the card stays.
    await page.locator('#network summary').click();
    await page.click('#net-disconnect');
    await page.waitForFunction(() => document.getElementById('network')!.dataset.phase === 'off', null, { timeout: 10_000 });
    assert.equal(await text(page, '#net-setup'), t('network:NetAdapter.change'), 'the connection stays attached');
    assert.equal(await visible(page, '#net-connect-now'), true);
    assert.equal((await connections(page))[0].connectAtStart, false, 'off at the next start');
    assert.equal(await page.locator('#net-remove').count(), 0, 'the card is always there: nothing to remove');

    // tailcat: through a computer of the user's by default; neither choice, or a malformed address, is refused.
    await wizard(page);
    await page.click('#net-pick-tailcat');
    assert.equal(await page.isChecked('#net-tc-exit'), true);
    assert.equal(await page.isChecked('#net-tc-serve'), false);
    assert.equal(await visible(page, '#net-tailcat'), true);
    assert.equal(await visible(page, '#net-tc-relay'), false, 'the serving settings show when serving');
    assert.equal(await page.getAttribute('#net-tailcat', 'type'), 'password', 'the address is a secret');
    await page.uncheck('#net-tc-exit');
    assert.equal(await visible(page, '#net-tailcat'), false);
    await page.click('#net-connect');
    assert.match(await text(page, '#net-error'), words('network:NetTailcatStep.chooseTailcat'));
    await page.check('#net-tc-exit');
    await page.fill('#net-tailcat', 'tcnot-an-address');
    await page.click('#net-connect');
    assert.match(await text(page, '#net-error'), words('network:tailcat.notAddress'));
    assert.equal(await phase(page), 'off');
    if (!tailcatRig) {
      console.log('# SKIPPED: the wizard against a tailcat relay, and serving (WAARM64_TAILCAT=1 and net/ts/build.sh)');
      await page.click('#net-cancel');
    } else {
      // A well-formed address of a server that isn't there (the rig's relay, another server key), on an ephemeral
      // connection: the client meows unanswered, then gives up with an error.
      await page.fill('#net-tailcat', otherServer(tailcatRig));
      await page.uncheck('#net-keep');
      await page.click('#net-connect');
      await statusIs(page, words('network:network-view.meowing'), 15_000);
      await page.waitForFunction(() => document.getElementById('network')!.dataset.phase === 'error', null, { timeout: 30_000, polling: 250 });
      assert.match(await text(page, '#net-status'), words('network:network-view.couldntConnect'));
      assert.ok(!JSON.stringify(await connections(page)).includes(tailcatRig.slice(2, 30)), 'an ephemeral connection is never stored');
      await page.click('#net-disconnect');
      await page.waitForFunction(() => document.getElementById('network')!.dataset.phase === 'off', null, { timeout: 10_000 });

      // Serving only, on the rig's relay (Advanced): the menu shows the machine's address, and a tailcat client
      // reaches the guest through it.
      await wizard(page);
      await page.click('#net-pick-tailcat');
      assert.equal(await page.locator('#net-tailcat').inputValue(), '', 'a new connection starts empty');
      await page.uncheck('#net-tc-exit');
      await page.check('#net-tc-serve');
      await page.click('#net-tc-advanced summary');
      assert.equal(await page.locator('#net-tc-forget').count(), 0, 'a new connection has no address to forget');
      await page.fill('#net-tc-relay', 'https://nope/');
      await page.click('#net-connect');
      assert.match(await text(page, '#net-error'), words('network:tailcat.badRelay'));
      await page.fill('#net-tc-relay', '127.0.0.1:8444');
      await page.click('#net-connect');
      await statusIs(page, words('network:network-view.servingOnly'), 30_000);
      assert.equal(await visible(page, '#net-served'), true);
      assert.equal(await page.getAttribute('#net-served-addr', 'type'), 'password');
      await page.click('#net-served-show');
      assert.equal(await page.getAttribute('#net-served-addr', 'type'), 'text');
      const served = await page.locator('#net-served-addr').inputValue();
      const parsed = JSON.parse(await tailcatCLI(['parse', served], ''));
      assert.deepEqual(parsed.Region[0].Nodes[0], { HostName: '127.0.0.1', DERPPort: 8444 }, 'the relay given');
      const cat = (await connections(page)).find((c) => c.tailcat);
      assert.equal(cat?.connectAtStart, true, 'a served machine reconnects by itself');
      assert.equal(cat?.tailcat?.relay, '127.0.0.1:8444');
      // The guest takes the tunnel's IPv6 address (DHCPv6) and serves a page on it. The menu closed first: open, it
      // covers the terminal's middle (since the toolbar's mouse lock moved it).
      await page.click('#network > summary');
      await page.waitForFunction(() => !(document.getElementById('network') as HTMLDetailsElement).open, null, { timeout: 5000 });
      await page.locator('.xterm').click();
      await onSerial(page, 'cd /tmp; echo served-page > index.html; (python3 -m http.server --bind :: 8080 >/dev/null 2>&1 &); sleep 2; ip -6 -br addr show scope global | grep -c fd7a; echo READY\n');
      await shows(page, /1READY/, 60_000); // the rows run together: the count (1), then READY
      const got = await tailcatCLI([served, '8080'], 'GET /index.html HTTP/1.0\r\n\r\n');
      assert.match(got, /served-page/, `a tailcat client reaches the guest: ${got.slice(0, 300)}`);

      // A reload: the same address, and connected without asking (the identity and the relay are kept).
      await page.reload();
      await running(page);
      await page.locator('#network summary').click();
      await statusIs(page, words('network:network-view.servingOnly'), 60_000);
      await page.click('#net-served-show');
      assert.equal(await page.locator('#net-served-addr').inputValue(), served, 'the same address after a reload');
      // New address, from the connection's Edit (the Machines page's Connections): the kept one is forgotten, and
      // Save serves at another.
      await page.click('#machines-open');
      await page.click('[data-machine="connections"]');
      await page.click(`li[data-connection="${cat!.id}"] [data-action="edit-connection"]`);
      assert.equal(await page.locator('#net-tc-relay').inputValue(), '127.0.0.1:8444');
      assert.equal(await page.locator('#net-tc-advanced').evaluate((d) => (d as HTMLDetailsElement).open), true, 'Advanced is open: its relay is set');
      await page.click('#net-tc-forget');
      await page.click('#net-connect');
      await page.click('[data-action="back"]');
      await page.locator('#network summary').click();
      await statusIs(page, words('network:network-view.servingOnly'), 30_000);
      await page.waitForFunction((old) => (document.getElementById('net-served-addr') as HTMLInputElement).value !== old, served, { timeout: 10_000 });
      await page.click('#net-disconnect');
      await page.waitForFunction(() => document.getElementById('network')!.dataset.phase === 'off', null, { timeout: 10_000 });
      assert.deepEqual(dialogs.length, 1, `New address asked first: ${dialogs}`);
      dialogs.length = 0;
    }

    // An ephemeral tailnet connection in its place: after a reload it is gone, and the adapter says so; the machine
    // boots with the card all the same.
    await wizard(page);
    await page.click('#net-pick-tailnet');
    await page.fill('#net-control', 'http://127.0.0.1:1');
    await page.uncheck('#net-keep');
    await page.click('#net-connect');
    await page.waitForFunction(() => document.getElementById('network')!.dataset.phase !== 'off', null, { timeout: 30_000 });
    assert.match(await text(page, '#net-conn'), words('network:NetAdapter.connection.ephemeral'));
    const kept = (await connections(page)).length;
    await page.reload();
    await page.locator('#network summary').click();
    await page.waitForFunction((src) => new RegExp(src).test(document.getElementById('net-hint')!.textContent!), words('network:net-live.gone').source, { timeout: 30_000 });
    assert.equal(await phase(page), 'off');
    assert.match(await text(page, '#net-conn'), words('network:NetAdapter.noConnection'));
    assert.equal((await connections(page)).length, kept, 'the stored ones stay');
    await running(page);
    await shows(page, /login: /);
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
