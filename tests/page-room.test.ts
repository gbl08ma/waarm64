// Peer-to-peer rooms on the page (docs/frontend.md "Network", docs/tailnet.md "Rooms", plan R2): two Debian guests in
// one Chromium, each its own profile (two browsers, as far as the page knows). One creates a private room in the
// Network wizard, its relays under Advanced (the tests' Nostr relay, tests/net/nostr-relay.ts, and the tailcat rig's
// derper, tests/net/tailcat.sh: only its derper is used); the wizard refuses a room without a name and a damaged link
// first. The other joins it with the link the first one's connection keeps. Each guest gets the room's lease from the
// page's network configuration (its address, the room's resolver), and one pings the other by its name in the room
// (`<key>.<tag>.p2p.internal`, which the room's resolver answers, through the guest's systemd-resolved; asked directly
// too), the menu showing the name, the member reached and the
// link to copy. Two Debian boots at once, ~4 min alone. Opt-in like the other network tests (scripts/ci-net.sh):
// WEBPC_NET_TESTS=1, WEBPC_DISTROS=debian and WEBPC_TAILCAT=1 (Go for derper).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { unattendedQuery } from './debian-unattended.ts';
import { withDebianLock } from './debian-lock.ts';
import { PAGE_QUERY } from './page-query.ts';
import { answerAsks } from './page-ask.ts';
import { startNostrRelay, type NostrRelay } from './net/nostr-relay.ts';
import { RIG_RELAY } from './net/tailcat-cli.ts';
import { t } from '../web/i18n.ts';
import { parseRoomLink } from '../web/room.ts';
import { keyPair, nameOf, roomPrefix } from './net/room-keys.ts';
import { words } from './words.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const has = (cmd: string, arg = '--version') => spawnSync(cmd, [arg], { stdio: 'ignore' }).status === 0;
const skip = process.env.WEBPC_NET_TESTS !== '1' ? 'SKIPPED: scripts/ci-net.sh runs it (WEBPC_NET_TESTS=1)'
  : !(process.env.WEBPC_DISTROS ?? '').split(',').includes('debian') ? 'SKIPPED: set WEBPC_DISTROS=debian'
  : process.env.WEBPC_TAILCAT !== '1' ? 'SKIPPED: set WEBPC_TAILCAT=1 (the tailcat rig\'s derper)'
  : !existsSync(`${ROOT}target/images/debian/disk.qcow2`) || !existsSync(`${ROOT}target/images/edk2/QEMU_EFI.fd`) ? 'SKIPPED: run images/build.sh debian edk2'
  : !existsSync(`${ROOT}target/net/ts.wasm`) ? 'SKIPPED: no target/net/ts.wasm (net/ts/build.sh)'
  : !has('go', 'version') && !existsSync(`${ROOT}target/net/tailcat-test/bin/derper`) ? 'SKIPPED: no Go to build derper'
  : undefined;
const script = `${ROOT}tests/net/tailcat.sh`;
const BOOT_MS = 300_000;

let browser: Browser;
let nostr: NostrRelay;
let base: string;
let closeServer: () => void;
before(async () => {
  if (skip) return;
  execFileSync(script, ['up'], { encoding: 'utf8', timeout: 300_000 });
  nostr = await startNostrRelay();
  const server = await startServer();
  closeServer = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
});
after(async () => {
  await browser?.close();
  closeServer?.();
  await nostr?.close();
  if (!skip) spawnSync(script, ['down']);
});

const terminal = (page: Page) => page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '');
const shows = (page: Page, re: RegExp, ms = 60_000) =>
  page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.xterm-rows')?.textContent ?? ''), re.source, { timeout: ms, polling: 100 })
    .catch(async (e) => { throw new Error(`${e}; the terminal shows: ${await terminal(page)}`); });
async function onSerial(page: Page, text: string) {
  // The Network menu, open, covers the terminal.
  if (await page.evaluate(() => (document.getElementById('network') as HTMLDetailsElement).open)) await page.locator('#network summary').click();
  await page.locator('.xterm').click();
  await page.keyboard.type(text, { delay: 5 });
}
let runs = 0;
/** Runs `cmd` on the serial shell: its output on one line (its lines joined by spaces), between markers of its own. */
async function run(page: Page, cmd: string, ms = 60_000) {
  const re = new RegExp(`<<${++runs}:([^<>]*)>>`);
  await onSerial(page, `clear; echo "<<${runs}:$({ ${cmd}; } 2>&1 | tr '\\n<>' ' []')>"">"\n`);
  await shows(page, re, ms);
  return re.exec(await terminal(page))![1].trim();
}
async function running(page: Page) {
  await page.waitForFunction(() => ['running', 'failed', 'crashed', 'idle', 'off'].includes(document.body.dataset.state!), null, { timeout: BOOT_MS, polling: 250 });
  const [state, message] = await page.evaluate(() => [document.body.dataset.state, document.getElementById('message-text')?.textContent ?? '']);
  assert.equal(state, 'running', message ?? '');
}
const visible = (page: Page, sel: string) => page.locator(sel).isVisible();
const text = async (page: Page, sel: string) => (await page.locator(sel).textContent()) ?? '';
/** The Network menu open, its wizard at the room's choice (Create a room or Join a room). */
async function roomWizard(page: Page) {
  if (!(await page.evaluate(() => (document.getElementById('network') as HTMLDetailsElement).open))) await page.locator('#network summary').click();
  await page.click('#net-setup');
  if (await visible(page, '#net-step-pick')) await page.click('#net-pick-new');
  await page.click('#net-pick-room');
  assert.equal(await visible(page, '#net-step-room-pick'), true, 'at the room\'s choice');
  assert.equal(await visible(page, '#net-connect'), false, 'nothing to submit before the choice');
}
const menuSays = (page: Page, re: RegExp, ms: number) =>
  page.waitForFunction((src) => new RegExp(src).test(document.getElementById('net-status')!.textContent!), re.source, { timeout: ms, polling: 100 })
    .catch(async (e) => { throw new Error(`${e}; the menu said ${await page.evaluate(() => [document.getElementById('network')!.dataset.phase, document.getElementById('net-status')!.textContent, document.getElementById('net-menu-error')!.textContent])}`); });
/** The room connections IndexedDB `webpc` keeps. */
const rooms = (page: Page) => page.evaluate(() => new Promise<{ id: string; name: string; room: { link: string; incoming: boolean; relayOnly: boolean; identityKey: string } }[]>((resolve, reject) => {
  const open = indexedDB.open('webpc');
  open.onsuccess = () => {
    const req = open.result.transaction('connections').objectStore('connections').getAll();
    req.onsuccess = () => { open.result.close(); resolve(req.result.filter((c: { kind: string }) => c.kind === 'room')); };
    req.onerror = () => reject(req.error);
  };
  open.onerror = () => reject(open.error);
}));

async function machine(contexts: BrowserContext[]): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, ignoreHTTPSErrors: true }); // the rig's derper has a self-signed certificate
  contexts.push(ctx);
  const page = await ctx.newPage();
  page.on('console', (m) => { if (/rror|panic|room:/.test(m.text())) console.log(`# page ${contexts.length}: ${m.text().slice(0, 300)}`); });
  await answerAsks(page);
  await page.goto(`${base}/web/app/?${PAGE_QUERY}ncpus=2&view=both&${unattendedQuery()}`);
  return page;
}

test('two Debian guests in one Chromium: one creates a private room in the wizard, the other joins by its link, and they ping each other by name', { skip, timeout: 25 * 60_000 }, () => withDebianLock(async () => {
  const contexts: BrowserContext[] = [];
  try {
    const a = await machine(contexts);
    const b = await machine(contexts);
    await Promise.all([running(a), running(b)]);

    // Create: a name is needed; the relays under Advanced; private by default.
    await roomWizard(a);
    await a.click('#net-room-create');
    assert.equal(await a.isChecked('#net-room-private'), true, 'private by default');
    assert.equal(await a.isChecked('#net-room-direct'), true, 'direct connections by default');
    assert.equal(await visible(a, '#net-room-incoming'), false, 'incoming connections are under Advanced');
    assert.equal(await a.isChecked('#net-room-incoming'), true, 'members may connect by default');
    // The note on who can learn this computer's IP address follows the switch.
    assert.match(await text(a, '#net-room-ip'), words('network:NetRoomStep.room.ip.direct'));
    await a.uncheck('#net-room-direct');
    assert.match(await text(a, '#net-room-ip'), words('network:NetRoomStep.room.ip.relayed'));
    await a.check('#net-room-direct');
    assert.match(await text(a, '#net-room-ip'), words('network:NetRoomStep.room.ip.direct'));
    await a.click('#net-connect');
    assert.match(await text(a, '#net-error'), words('network:NetRoomStep.room.noName'));
    await a.fill('#net-room-id', 'test lan');
    await a.locator('#net-room-advanced summary').click();
    await a.fill('#net-room-nostr', nostr.url);
    await a.fill('#net-room-derp', 'derp.invalid:443:1');
    await a.click('#net-connect');
    assert.match(await text(a, '#net-error'), words('network:room.badDerp', { relay: 'derp.invalid:443:1' }));
    await a.fill('#net-room-derp', RIG_RELAY);
    await a.click('#net-connect');
    await menuSays(a, words('network:network-view.room.connections', { count: 0 }), 60_000);
    const [ra] = await rooms(a);
    assert.deepEqual([ra.room.incoming, ra.room.relayOnly], [true, false], 'the switches as they were left');
    assert.equal(ra.name, 'test lan', 'named by the room, without its private suffix');
    assert.match(ra.room.link, /^webpc-room:test%20lan-[a-z2-7]{26}\?nostr=ws%3A%2F%2F127\.0\.0\.1%3A\d+&derp=127\.0\.0\.1%3A8444$/);
    const nameA = await a.locator('#net-room-name').inputValue();
    assert.match(nameA, /^[a-z2-7]{52}\.[a-z2-7]{8}\.p2p\.internal$/, 'its name to give out');
    assert.equal(await visible(a, '#net-room-link-copy'), true, 'the link to copy');
    assert.equal(await a.locator('#net-room-link-value').getAttribute('type'), 'password', 'the link is hidden');
    // Details…: the name, the link and who may connect, in a dialog of their own.
    await a.click('#net-details-open');
    assert.equal(await a.locator('#net-details-room-name').inputValue(), nameA);
    assert.equal(await a.locator('label:has(#net-details-address) .name').textContent(), t('network:NetDetails.address.v6'), 'a room has IPv6 alone');
    assert.equal(await a.locator('#net-details-room-link').inputValue(), ra.room.link);
    assert.match(await text(a, '#net-details-room-note'), words('network:NetDetails.room.note'));
    await a.click('#net-details-close');
    assert.equal(await a.evaluate(() => (document.getElementById('net-details') as HTMLDialogElement).open), false, 'Close closes it');

    // Join: a damaged link is refused; the link the first one keeps joins the same room.
    await roomWizard(b);
    await b.click('#net-room-join');
    await b.fill('#net-room-link', 'webpc-room:a%zz');
    await b.click('#net-connect');
    assert.match(await text(b, '#net-error'), words('network:room.badLink'));
    await b.fill('#net-room-link', ra.room.link);
    await b.uncheck('#net-keep'); // ephemeral: its key lives in the connection's record, which New name changes
    // With a pasted key (as net/ts/examples/room-key-mine.rs mines one): what isn't one is refused; the name is the key's.
    await b.locator('#net-room-advanced summary').click();
    await b.selectOption('#net-room-key', '#paste');
    assert.match(await text(b, '#net-room-advanced'), words('network:NetRoomStep.room.key.paste.note'));
    await b.fill('#net-room-key-paste', 'not a key');
    await b.click('#net-connect');
    assert.match(await text(b, '#net-error'), words('network:NetRoomStep.room.key.bad'));
    const pasted = keyPair();
    const parsed = parseRoomLink(ra.room.link);
    assert.ok('room' in parsed);
    const prefix = roomPrefix(parsed.room.id);
    await b.fill('#net-room-key-paste', ` ${pasted.key.toUpperCase()} `);
    await b.click('#net-connect');
    await menuSays(b, words('network:network-view.room.connections', { count: 0 }), 60_000);
    const nameB = await b.locator('#net-room-name').inputValue();
    assert.equal(nameB, nameOf(prefix, pasted.pub), 'the pasted key\'s name');
    assert.equal(nameB.split('.')[1], nameA.split('.')[1], 'one room, one tag');
    assert.notEqual(nameB, nameA);

    // The guests: each has its room address and the room's resolver, from the page's network configuration.
    for (const p of [a, b]) {
      await onSerial(p, 'root\n');
      await shows(p, /root@\S+:~# /);
    }
    const addr6 = async (p: Page) => {
      for (let k = 0; k < 60; k++) {
        const s = await run(p, "ip -6 -o addr show scope global | awk '{print $4}'");
        if (/^fd/.test(s)) return s.split(/\s+/)[0];
        await p.waitForTimeout(1000);
      }
      throw new Error(`no room address: ${await run(p, 'ip -br addr; networkctl status 2>&1 | tail -5')}`);
    };
    const [a6, b6] = await Promise.all([addr6(a), addr6(b)]);
    assert.equal(a6.slice(0, 14), b6.slice(0, 14), `one room, one /48: ${a6}, ${b6}`);
    // The room's resolver itself, asked directly (a raw AAAA query over bash's /dev/udp), apart from the guest's resolver.
    const dns6 = `${a6.split(':').slice(0, 3).join(':')}::53`;
    const q = ['\\x12\\x34\\x01\\x00\\x00\\x01\\x00\\x00\\x00\\x00\\x00\\x00', ...nameA.split('.').map((l) => `\\x${l.length.toString(16).padStart(2, '0')}${l}`), '\\x00\\x00\\x1c\\x00\\x01'].join('');
    const raw = await run(b, `exec 3<>/dev/udp/${dns6}/53; printf '${q}' >&3; timeout 3 cat <&3 >/tmp/r; exec 3>&-; od -An -tx1 /tmp/r | tr -s ' '`, 60_000);
    assert.match(raw, /^12 34 85 80 00 01 00 01 /, `the room's resolver answers the AAAA itself (its id, NOERROR, one answer): ${raw}`);
    const resolved = await run(b, `getent ahosts ${nameA} | head -1`, 60_000);
    assert.match(resolved, new RegExp(`^${a6.split('/')[0]}\\s`), `the room's resolver answers the name with its address: ${resolved}; ${await run(b, `resolvectl query ${nameA}; resolvectl query -t AAAA ${nameA.split('.').slice(1).join('.')}; ip -6 route; ping -6 -c 1 -W 3 ${a6.split('/')[0].replace(/:[^:]+:[^:]+:[^:]+:[^:]+:[^:]+$/, '::53')}`, 60_000)}`);
    // By name, through the relay first and then directly: the first ping waits for the lookup and its call back.
    const ping = await run(b, `ping -6 -c 4 -W 10 ${nameA} | tail -2`, 120_000);
    assert.match(ping, / 0% packet loss/, `B pings A by name: ${ping}`);
    await menuSays(a, words('network:network-view.room.connections', { count: 1 }), 30_000);
    await menuSays(b, words('network:network-view.room.connections', { count: 1 }), 30_000);
    const back = await run(a, `ping -6 -c 2 -W 10 ${nameB} | tail -2`, 60_000);
    assert.match(back, / 0% packet loss/, `A pings B by name: ${back}`);
    assert.equal(await a.locator('#net-room-link-copy').getAttribute('aria-label'), t('common:ValueField.copy'));
    // Where the clipboard refuses, the link is shown in its field and selected (not the machine's name).
    await a.evaluate(() => { navigator.clipboard.writeText = () => Promise.reject(new Error('refused')); });
    if (!(await a.evaluate(() => (document.getElementById('network') as HTMLDetailsElement).open))) await a.locator('#network summary').click();
    await a.click('#net-room-link-copy');
    await a.waitForFunction(() => document.activeElement?.id === 'net-room-link-value', null, { timeout: 5_000 });
    assert.equal(await a.evaluate(() => getSelection()?.toString() || (document.activeElement as HTMLInputElement).value.slice((document.activeElement as HTMLInputElement).selectionStart!, (document.activeElement as HTMLInputElement).selectionEnd!)), ra.room.link);

    // New name, then Save in the same Edit: the new key stays (Save once wrote back the record the wizard opened with).
    await b.click('#machines-open');
    await b.click('[data-machine="connections"]');
    await b.click('li[data-connection] [data-action="edit-connection"]');
    await b.locator('#net-room-new-name').evaluate((e) => e.closest('details')?.setAttribute('open', ''));
    // Copy key copies the connection's key; where the clipboard refuses, it's shown in its field, selected.
    await b.evaluate(() => {
      const w = window as unknown as { copied: string[] };
      w.copied = [];
      navigator.clipboard.writeText = (s: string) => { w.copied.push(s); return Promise.resolve(); };
    });
    await b.waitForFunction(() => !(document.getElementById('net-room-key-copy') as HTMLButtonElement).disabled, null, { timeout: 10_000 });
    assert.equal(await b.locator('#net-room-key-value').getAttribute('type'), 'password', 'hidden');
    await b.click('#net-room-key-copy');
    assert.deepEqual(await b.evaluate(() => (window as unknown as { copied: string[] }).copied), [pasted.key]);
    assert.equal(await b.locator('#net-room-key-copy').getAttribute('aria-label'), t('common:ValueField.copied'), 'the icon says it copied');
    await b.click('#net-room-key-show');
    assert.equal(await b.locator('#net-room-key-value').getAttribute('type'), 'text', 'Show');
    await b.click('#net-room-key-show');
    assert.equal(await b.locator('#net-room-key-value').getAttribute('type'), 'password', 'Hide');
    await b.evaluate(() => { navigator.clipboard.writeText = () => Promise.reject(new Error('refused')); });
    await b.click('#net-room-key-copy');
    await b.waitForFunction(() => document.activeElement?.id === 'net-room-key-value', null, { timeout: 5_000 });
    assert.equal(await b.locator('#net-room-key-value').getAttribute('type'), 'text', 'shown where the clipboard refused');
    assert.equal(await b.locator('#net-room-key-value').inputValue(), pasted.key);
    await b.click('#net-room-new-name');
    await b.waitForFunction(() => (document.getElementById('net-room-new-name') as HTMLButtonElement).disabled, null, { timeout: 10_000 });
    // Ephemeral: the new key is in the record already, so it's the one to copy (a stored one's comes at its next start).
    await b.waitForFunction((old) => { const v = (document.getElementById('net-room-key-value') as HTMLInputElement).value; return /^[0-9a-f]{64}$/.test(v) && v !== old; }, pasted.key, { timeout: 10_000 });
    assert.match(await text(b, '#net-room-advanced'), words('network:NetRoomStep.room.exportKey.note'));
    await b.click('#net-connect');
    await b.waitForFunction(() => !(document.getElementById('net-wizard') as HTMLDialogElement).open, null, { timeout: 30_000 })
      .catch(async (e) => { throw new Error(`${e}; the wizard says ${await text(b, '#net-error')}; step ${await b.evaluate(() => [...document.querySelectorAll('#net-wizard section:not([hidden])')].map((x) => x.id))}`); });
    await b.click('[data-action="back"]');
    await b.locator('#network summary').click();
    await b.waitForFunction((old) => { const v = (document.getElementById('net-room-name') as HTMLInputElement | null)?.value; return !!v && v !== old; }, nameB, { timeout: 30_000 })
      .catch(async (e) => { throw new Error(`${e}; the name stayed ${await b.locator('#net-room-name').inputValue()}`); });
  } finally {
    for (const c of contexts) await c.close();
  }
}));
