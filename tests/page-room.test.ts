// Peer-to-peer rooms on the page (docs/frontend.md "Network", docs/networking/rooms.md): two Debian guests in
// one Chromium, each its own profile (two browsers, as far as the page knows). One creates a private room in the
// Network wizard, its relays under Advanced (the tests' Nostr relay, tests/net/nostr-relay.ts, and the tailcat rig's
// derper, tests/net/tailcat.sh: only its derper is used); the wizard refuses a room without a name and a damaged link
// first. The other joins it with the link the first one's connection keeps. Each guest gets the room's lease from the
// page's network configuration (its address, the room's resolver), and one pings the other by its name in the room
// (`<key>.<tag>.p2p.internal`, which the room's resolver answers, through the guest's systemd-resolved; asked directly
// too), the menu showing the name, the member reached and the
// link to copy. Then registered names (docs/networking/names.md "The resolver"): a room with no server answers NXDOMAIN;
// a server appears (a guest-less member in the room's harness page, tests/browser/room.html, serving titles the test's
// own tool makes on the tests' pretend Bitcoin, net/ts/examples/names-title.rs) while a guest keeps asking, and is found;
// a name by its full name, by the short one through the search domain, a label under it, a zone change, reserved
// names; and what Debian asks the room's resolver on its own. Every page runs the page tests' module
// (target/net/ts-test.wasm, net/ts/build.sh --test-params, served in ts.wasm's place), which takes the pretend Bitcoin's
// titles. Two Debian boots at once, ~4 min alone in the dev VM. Opt-in like the other network tests (scripts/ci-net.sh):
// WAARM64_NET_TESTS=1, WAARM64_DISTROS=debian and WAARM64_TAILCAT=1 (Go for derper).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { unattendedQuery } from './debian-unattended.ts';
import { withDebianLock } from './debian-lock.ts';
import { PAGE_QUERY } from './page-query.ts';
import { answerAsks, type Question } from './page-ask.ts';
import { startNostrRelay, type NostrRelay } from './net/nostr-relay.ts';
import { RIG_RELAY } from './net/tailcat-cli.ts';
import { t } from '../web/i18n.ts';
import { parseRoomLink } from '../web/room.ts';
import { keyPair, nameOf } from './net/room-keys.ts';
import { words } from './words.ts';
import { CALENDARS, EXPLORERS } from '../web/names.ts';
import { CALENDARS as PRETEND, startOtsCalendar, type OtsCalendar } from './net/ots-calendar.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const has = (cmd: string, arg = '--version') => spawnSync(cmd, [arg], { stdio: 'ignore' }).status === 0;
const skip = process.env.WAARM64_NET_TESTS !== '1' ? 'SKIPPED: scripts/ci-net.sh runs it (WAARM64_NET_TESTS=1)'
  : !(process.env.WAARM64_DISTROS ?? '').split(',').includes('debian') ? 'SKIPPED: set WAARM64_DISTROS=debian'
  : process.env.WAARM64_TAILCAT !== '1' ? 'SKIPPED: set WAARM64_TAILCAT=1 (the tailcat rig\'s derper)'
  : !existsSync(`${ROOT}target/images/debian/disk.qcow2`) || !existsSync(`${ROOT}target/images/edk2/QEMU_EFI.fd`) ? 'SKIPPED: run images/build.sh debian edk2'
  : !existsSync(`${ROOT}target/net/ts.wasm`) ? 'SKIPPED: no target/net/ts.wasm (net/ts/build.sh)'
  : !has('go', 'version') && !existsSync(`${ROOT}target/net/tailcat-test/bin/derper`) ? 'SKIPPED: no Go to build derper'
  : undefined;
const script = `${ROOT}tests/net/tailcat.sh`;
const TEST_WASM = `${ROOT}target/net/ts-test.wasm`;
const TITLE_TOOL = `${ROOT}target/debug/examples/names-title`;
const BOOT_MS = 300_000;

let browser: Browser;
let nostr: NostrRelay;
let cal: OtsCalendar;
let base: string;
let closeServer: () => void;
before(async () => {
  if (skip) return;
  execFileSync(script, ['up'], { encoding: 'utf8', timeout: 300_000 });
  // The page tests' module and the title tool (both on the tests' pretend Bitcoin).
  execFileSync(`${ROOT}net/ts/build.sh`, ['--test-params'], { encoding: 'utf8', timeout: 600_000 });
  execFileSync('cargo', ['build', '-q', '-p', 'waarm64_ts', '--features', 'test-params', '--example', 'names-title'], { cwd: ROOT, encoding: 'utf8', timeout: 600_000 });
  nostr = await startNostrRelay();
  cal = await startOtsCalendar({ depth: 6 });
  const server = await startServer();
  closeServer = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
});
after(async () => {
  await browser?.close();
  closeServer?.();
  await nostr?.close();
  await cal?.close();
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
/** The room connections IndexedDB `waarm64` keeps. */
const rooms = (page: Page) => page.evaluate(() => new Promise<{ id: string; name: string; room: { link: string; incoming: boolean; relayOnly: boolean; identityKey: string } }[]>((resolve, reject) => {
  const open = indexedDB.open('waarm64');
  open.onsuccess = () => {
    const req = open.result.transaction('connections').objectStore('connections').getAll();
    req.onsuccess = () => { open.result.close(); resolve(req.result.filter((c: { kind: string }) => c.kind === 'room')); };
    req.onerror = () => reject(req.error);
  };
  open.onerror = () => reject(open.error);
}));

/** The room's resolver's log lines (`resolver: <name> (type <n>): <answer>`), every page's: what the guests asked. */
const resolverLog: string[] = [];
/** Every page in `ctx` runs the page tests' module, and its names agent's calendars and explorers are the pretend ones. */
async function testModule(ctx: BrowserContext) {
  await ctx.route(/\/target\/net\/ts\.wasm(\?.*)?$/, (r) => r.fulfill({ path: TEST_WASM, contentType: 'application/wasm' }));
  const map: [string, string][] = [...CALENDARS.map((c, i): [string, string] => [c, cal.calendars[PRETEND[i]]]), ...EXPLORERS.map((e): [string, string] => [e, cal.explorer])];
  await ctx.route((u) => map.some(([from]) => u.href.startsWith(`${from}/`)), async (r) => {
    const url = r.request().url();
    const [from, to] = map.find(([f]) => url.startsWith(`${f}/`))!;
    await r.fulfill({ response: await r.fetch({ url: to + url.slice(from.length) }) });
  });
}
const logOf = (n: number | string) => (m: { text(): string }) => {
  if (/room: resolver: /.test(m.text())) resolverLog.push(`${n}: ${m.text().replace(/^room: resolver: /, '')}`);
  if (/rror|panic|room:|^names:/.test(m.text())) console.log(`# page ${n}: ${m.text().slice(0, 300)}`);
};

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
/** A node key from its name's first label (base32, room.rs `base32`), in hex. */
function keyOfName(name: string): string {
  let [acc, bits, out] = [0, 0, [] as number[]];
  for (const c of name.split('.')[0]) {
    acc = ((acc << 5) | B32.indexOf(c)) & 0xffff;
    bits += 5;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); }
  }
  return Buffer.from(out.slice(0, 32)).toString('hex');
}

type Title = { name: string; key: string; items: string[] };
/** Titles on the tests' pretend Bitcoin (net/ts/examples/names-title.rs): each name's chain with each of its zones. */
const makeTitles = (spec: object): Title[] => {
  const titles: Title[] = JSON.parse(execFileSync(TITLE_TOOL, [JSON.stringify(spec)], { encoding: 'utf8', timeout: 60_000 }));
  // Their blocks, mined by the tool, are known to the pretend explorer (as real blocks are to a real one), so the
  // servers' checks of them pass (docs/networking/names.md "Outside the room"). An item: version, id, the headers' count
  // (2 bytes), the headers.
  for (const t of titles) {
    for (const it of t.items) {
      const b = Buffer.from(it, 'hex');
      const n = b.readUInt16LE(33);
      for (let k = 0; k < n; k++) cal.adopt(b.subarray(35 + 80 * k, 35 + 80 * (k + 1)));
    }
  }
  return titles;
};

/** Milliseconds a command takes on the guest, and its output. */
async function timed(page: Page, cmd: string, ms = 60_000): Promise<{ ms: number; out: string }> {
  const r = await run(page, `s=$(date +%s%N); out=$(${cmd} 2>&1); echo "$(( ($(date +%s%N) - s) / 1000000 )) $out"`, ms);
  const [t, ...rest] = r.split(' ');
  return { ms: Number(t), out: rest.join(' ') };
}

/** The pages' questions as they opened (web/app/ask.svelte.ts), answered OK unless `cancelling`. */
const asked: Question[] = [];
let cancelling = false;

async function machine(contexts: BrowserContext[]): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, ignoreHTTPSErrors: true }); // the rig's derper has a self-signed certificate
  contexts.push(ctx);
  await testModule(ctx);
  const page = await ctx.newPage();
  page.on('console', logOf(contexts.length));
  await answerAsks(page, (q) => {
    asked.push(q);
    return cancelling ? false : true;
  });
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
    assert.match(ra.room.link, /^waarm64-room:test%20lan-[a-z2-7]{26}\?nostr=ws%3A%2F%2F127\.0\.0\.1%3A\d+&derp=127\.0\.0\.1%3A8444$/);
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
    await b.fill('#net-room-link', 'waarm64-room:a%zz');
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
    await b.fill('#net-room-key-paste', ` ${pasted.key.toUpperCase()} `);
    await b.click('#net-connect');
    await menuSays(b, words('network:network-view.room.connections', { count: 0 }), 60_000);
    const nameB = await b.locator('#net-room-name').inputValue();
    assert.equal(nameB, nameOf(parsed.room.id, pasted.pub), 'the pasted key\'s name');
    assert.equal(nameB.split('.')[1], nameA.split('.')[1], 'one room, one tag');
    assert.notEqual(nameB, nameA);

    // The guests: each has its room address and the room's resolver, from the page's network configuration.
    for (const p of [a, b]) {
      await shows(p, /login: /);
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
    // The /48: three groups (as text, a group's leading zeros are dropped, so a fixed length of characters isn't it).
    const p48 = (x: string) => x.split(':').slice(0, 3).join(':');
    assert.equal(p48(a6), p48(b6), `one room, one /48: ${a6}, ${b6}`);
    // The room's resolver itself, asked directly (a raw AAAA query over bash's /dev/udp), apart from the guest's resolver.
    const dns6 = `${a6.split(':').slice(0, 3).join(':')}::53`;
    const q = ['\\x12\\x34\\x01\\x00\\x00\\x01\\x00\\x00\\x00\\x00\\x00\\x00', ...nameA.split('.').map((l) => `\\x${l.length.toString(16).padStart(2, '0')}${l}`), '\\x00\\x00\\x1c\\x00\\x01'].join('');
    const raw = await run(b, `exec 3<>/dev/udp/${dns6}/53; printf '${q}' >&3; timeout 3 cat <&3 >/tmp/r; exec 3>&-; od -An -tx1 /tmp/r | tr -s ' '`, 60_000);
    assert.match(raw, /^12 34 85 80 00 01 00 01 /, `the room's resolver answers the AAAA itself (its id, NOERROR, one answer): ${raw}`);
    const resolved = await run(b, `getent ahosts ${nameA} | head -1`, 60_000);
    assert.match(resolved, new RegExp(`^${a6.split('/')[0]}\\s`), `the room's resolver answers the name with its address: ${resolved}; ${await run(b, `resolvectl query ${nameA}; resolvectl query -t AAAA ${nameA.split('.').slice(1).join('.')}; ip -6 route; ping -6 -c 1 -W 3 ${a6.split('/')[0].replace(/:[^:]+:[^:]+:[^:]+:[^:]+:[^:]+$/, '::53')}`, 60_000)}`);
    // By name, through the relay first and then directly (the menu counts the direct one): the first ping waits for the
    // lookup and its call back.
    const ping = await run(b, `ping -6 -c 4 -W 10 ${nameA} | tail -2`, 120_000);
    assert.match(ping, / 0% packet loss/, `B pings A by name: ${ping}`);
    await menuSays(a, words('network:network-view.room.connectionsDirect', { count: 1, direct: 1 }), 30_000);
    await menuSays(b, words('network:network-view.room.connectionsDirect', { count: 1, direct: 1 }), 30_000);
    const back = await run(a, `ping -6 -c 2 -W 10 ${nameB} | tail -2`, 60_000);
    assert.match(back, / 0% packet loss/, `A pings B by name: ${back}`);

    await registeredNames({ a, b, nameA, nameB, a6, b6, roomId: parsed.room.id, contexts });
    await namingThisMachine({ a, b, nameA, a6 });
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

    await namesKeptWithTheConnection(a, b);
  } finally {
    for (const c of contexts) await c.close();
  }
}));

/** A guest-less member serving `titles` (one item each) in the room: tests/browser/room.html. */
async function namesServer(contexts: BrowserContext[], roomId: string, titles: { key: string; item: string }[]): Promise<Page> {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  contexts.push(ctx);
  await testModule(ctx);
  const page = await ctx.newPage();
  page.on('console', logOf('server'));
  // It serves once its first question is over (nobody else serves, or it synced with who does).
  const serving = page.waitForEvent('console', { predicate: (m) => /nobody serves the registry|synced: answering/.test(m.text()), timeout: 90_000 });
  page.on('pageerror', (e) => console.log(`# server page error: ${e}`));
  const q = new URLSearchParams({ room: roomId, relay: RIG_RELAY, nostr: nostr.url, names: JSON.stringify(titles) });
  await page.goto(`${base}/tests/browser/room.html?${q}`);
  await page.waitForFunction('window.harness?.room().state === "Running"', null, { timeout: 60_000, polling: 100 });
  await serving;
  return page;
}

/** The registered names' part (docs/networking/names.md "The resolver"), on the two guests of the room the test made. */
async function registeredNames(o: { a: Page; b: Page; nameA: string; nameB: string; a6: string; b6: string; roomId: string; contexts: BrowserContext[] }) {
  const { a, b, roomId, contexts } = o;
  const domain = o.nameA.split('.').slice(1).join('.');
  const [ipA, ipB] = [o.a6.split('/')[0], o.b6.split('/')[0]];
  const [keyA, keyB] = [keyOfName(o.nameA), keyOfName(o.nameB)];
  const full = (n: string) => `${n}.${domain}`;
  const [title] = makeTitles({
    room: roomId,
    titles: [{
      name: 'test123', secret: 1, claimDaysAgo: 20, renewDaysAgo: [4],
      zones: [
        { seq: 1, points: [{ label: null, key: keyA }, { label: 'git', key: keyB }] },
        { seq: 2, points: [{ label: null, key: keyB }, { label: 'git', key: keyA }] },
      ],
    }],
  });
  const lookup = (p: Page, name: string) => timed(p, `getent ahosts ${name} | head -1`);

  // A room with no server: NXDOMAIN once nobody answered "who serves?" (2.5 s), then at once while that's remembered.
  const none = await lookup(b, full('test123'));
  console.log(`# names: with no server, ${full('test123')} took ${none.ms} ms: ${none.out || '(not found)'}`);
  assert.equal(none.out, '', 'not found');
  const again = await lookup(b, full('test123'));
  console.log(`# names: asked again: ${again.ms} ms`);
  assert.equal(again.out, '');
  assert.ok(again.ms < none.ms, `remembered: ${again.ms} ms after ${none.ms}`);

  // Reserved and ill-formed names: NXDOMAIN at once, nothing asked.
  for (const r of ['wpad', 'com', 'localhost', 'isatap', 'a.b.test123']) {
    const x = await lookup(b, full(r));
    assert.equal(x.out, '', `${r} isn't found`);
    assert.ok(x.ms < 1500, `${r}: at once (${x.ms} ms)`);
  }

  // The guest keeps asking while the room's first server appears.
  await run(b, `rm -f /tmp/found; (for i in $(seq 1 120); do if getent ahosts ${full('test123')} > /dev/null; then date +%s%N > /tmp/found; break; fi; sleep 2; done) < /dev/null > /dev/null 2>&1 & true`);
  const server = await namesServer(contexts, roomId, [{ key: title.key, item: title.items[0] }]);
  const appeared = BigInt(await run(b, 'date +%s%N'));
  let found = '';
  for (let k = 0; k < 120 && !found; k++) {
    found = await run(b, 'cat /tmp/found 2>/dev/null');
    if (!found) await b.waitForTimeout(2000);
  }
  assert.ok(found, 'the guest that kept asking found the name');
  console.log(`# names: the room's first server found ${Number(BigInt(found) - appeared) / 1e6} ms after it ran`);

  // By its full name: A's address, and B pings A by it.
  const byName = await lookup(b, full('test123'));
  assert.match(byName.out, new RegExp(`^${ipA}\\s`), `test123 is A: ${byName.out}`);
  const ping = await run(b, `ping -6 -c 2 -W 10 ${full('test123')} | tail -2`, 60_000);
  assert.match(ping, / 0% packet loss/, `B pings A by its registered name: ${ping}`);
  // A label under it: B itself.
  const git = await lookup(b, full('git.test123'));
  assert.match(git.out, new RegExp(`^${ipB}\\s`), `git.test123 is B: ${git.out}`);
  assert.ok(git.ms < 1500, `from what the member keeps, at once (${git.ms} ms)`);

  // By the short name, through the search domain the lease gives (DHCPv6's domain list), which Debian takes as it is.
  const iface = await run(b, `ip -6 -o addr show | awk '/ fd/{print $2; exit}'`);
  const domains = await run(b, `resolvectl domain ${iface}`);
  console.log(`# names: the room's interface ${iface}, its search domains: ${domains}`);
  assert.ok(domains.includes(domain), `Debian takes the lease's search domain (systemd-networkd, DHCPv6's domain list): ${domains}`);
  let short = { ms: 0, out: '' };
  for (let k = 0; k < 10 && !short.out; k++) {
    short = await lookup(b, 'test123');
    if (!short.out) await b.waitForTimeout(2000);
  }
  assert.match(short.out, new RegExp(`^${ipA}\\s`), `the short name through the search domain: ${short.out}`);

  // A zone change: the server's title now points the name at B. A member that hadn't asked sees it at once; one that
  // keeps the name sees it once what it keeps is 5 minutes old (names.md "A member resolving a name").
  await server.context().close();
  await namesServer(contexts, roomId, [{ key: title.key, item: title.items[1] }]);
  const changed = await lookup(a, full('test123'));
  assert.match(changed.out, new RegExp(`^${ipB}\\s`), `after the zone change, test123 is B for A: ${changed.out}`);
  console.log(`# names: after the zone change A resolved test123 in ${changed.ms} ms`);
  const stale = await lookup(b, full('test123'));
  console.log(`# names: B, which keeps it, still says ${stale.out.split(/\s/)[0]} (until 5 minutes after it last checked)`);

  // Kept and stored: A (a stored connection) keeps the name it resolved in IndexedDB; the label, from what it keeps.
  const fromA = await lookup(a, full('git.test123'));
  assert.match(fromA.out, new RegExp(`^${ipA}\\s`), `after the zone change, git.test123 is A: ${fromA.out}`);
  await a.waitForTimeout(2500);
  const kept = await a.evaluate(() => new Promise<number>((resolve) => {
    const open = indexedDB.open('waarm64-room');
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains('names')) { db.close(); return resolve(-1); }
      const r = db.transaction('names').objectStore('names').count();
      r.onsuccess = () => { db.close(); resolve(r.result); };
    };
    open.onerror = () => resolve(-2);
  }));
  assert.equal(kept, 1, 'A keeps the name it resolved');

  // What the guests asked the room's resolver for on their own (anything but the names above).
  const ours = /^(test123|git\.test123|wpad|com|localhost|isatap|a\.b\.test123) /;
  const own = [...new Set(resolverLog.map((l) => l.replace(/^[^:]+: /, '')).filter((l) => !ours.test(l)))];
  console.log(`# names: the guests asked on their own: ${own.length ? own.join('; ') : 'nothing'}`);
}

/** No dialog open and the message bar as it was: what reaching a name may not take (the kickoff's decision 6). */
const untouched = (p: Page) => p.evaluate(() => [document.querySelectorAll('dialog[open]').length, document.getElementById('message-text')?.textContent ?? '']);

/**
 * Name this machine… (docs/networking/names.md "What the user sees"), on A: the dialog's check (as typed, the page alone; at Register, the room), its two notices
 * and no key, Register; the name Reserved, then Active once its anchor is collected; B's guest reaches it with nothing
 * done on B's page; a label added in A's details; on a load in its last week (the page's clock 24 days on) the notice.
 */
async function namingThisMachine(o: { a: Page; b: Page; nameA: string; a6: string }) {
  const { a, b } = o;
  const domain = o.nameA.split('.').slice(1).join('.');
  const ipA = o.a6.split('/')[0];
  const keyA = keyOfName(o.nameA);
  if (!(await a.evaluate(() => (document.getElementById('network') as HTMLDetailsElement).open))) await a.locator('#network summary').click();
  await a.click('#net-name-open');
  await a.waitForFunction(() => (document.getElementById('net-name') as HTMLDialogElement).open, null, { timeout: 5_000 });
  // Decision 6: one dialog, exactly the two notices, no box, no key shown or asked for; the field the only input.
  const dialog = await a.evaluate(() => {
    const d = document.getElementById('net-name')!;
    return { notices: d.querySelectorAll('[data-notices] > *').length, boxes: d.querySelectorAll('input[type=checkbox], input[type=radio]').length, inputs: d.querySelectorAll('input, textarea, select').length, text: d.textContent ?? '', values: [...d.querySelectorAll('input')].map((i) => i.value) };
  });
  assert.equal(dialog.notices, 2, 'two notices');
  assert.equal(dialog.boxes, 0, 'no boxes');
  assert.equal(dialog.inputs, 1, 'the name\'s field alone');
  assert.match(dialog.text, words('network:NameDialog.notice.find'));
  assert.match(dialog.text, words('network:NameDialog.notice.visit'));
  for (const secret of [keyA, o.nameA.split('.')[0]]) assert.ok(!dialog.text.includes(secret) && !dialog.values.some((v) => v.includes(secret)), 'no key shown');
  const says = async (key: string, params: Record<string, string> = {}) => {
    await a.waitForFunction((src) => new RegExp(src).test(document.getElementById('net-name-check')?.textContent ?? ''), words(key, params).source, { timeout: 30_000, polling: 100 })
      .catch(async (e) => { throw new Error(`${e}; it says ${await text(a, '#net-name-check')}`); });
  };
  const isOpen = () => a.evaluate(() => (document.getElementById('net-name') as HTMLDialogElement).open);
  // As typed, the page alone (the user's decision, 2026-11-17): a reserved name is refused at once; a valid one says
  // nothing and offers Register, the room's servers not asked (a name they hold isn't said taken while it's typed).
  await a.fill('#net-name-input', 'wpad');
  await says('network:names-view.check.invalid');
  assert.equal(await a.locator('#net-name-register').isDisabled(), true, 'a reserved name: no Register');
  await a.fill('#net-name-input', 'test123');
  await a.waitForFunction(() => document.getElementById('net-name-check')?.dataset.check === 'valid', null, { timeout: 10_000 });
  await a.waitForTimeout(1500);
  assert.equal(await a.evaluate(() => document.getElementById('net-name-check')?.dataset.check), 'valid', 'typing asks no server');
  assert.equal(await a.locator('#net-name-register').isDisabled(), false, 'a valid name: Register');
  // Register pressed: the room's servers asked; taken keeps the dialog open with the date.
  await a.click('#net-name-register');
  await says('network:names-view.check.taken', { name: 'test123' });
  assert.equal(await isOpen(), true, 'taken: the dialog stays open');
  assert.equal(await a.locator('#net-name-register').isDisabled(), true, 'taken: no Register');
  await a.fill('#net-name-input', 'mybox');
  await a.waitForFunction(() => document.getElementById('net-name-check')?.dataset.check === 'valid', null, { timeout: 10_000 });
  // Free: Register asks (a checker of its own: servers found again), registers and closes.
  await a.click('#net-name-register');
  await a.waitForFunction(() => !(document.getElementById('net-name') as HTMLDialogElement).open, null, { timeout: 30_000 })
    .catch(async (e) => { throw new Error(`${e}; it says ${await text(a, '#net-name-check')}`); });
  await a.locator('#network summary').click();
  const stateOf = () => a.evaluate(() => document.querySelector('#net-names [data-name="mybox"]')?.getAttribute('data-state'));
  await a.waitForFunction(() => document.querySelector('#net-names [data-name="mybox"]')?.getAttribute('data-state') === 'reserved', null, { timeout: 120_000, polling: 250 })
    .catch(async (e) => { throw new Error(`${e}; its state ${await stateOf()}; the bar says ${await untouched(a)}`); });
  assert.match(await text(a, '#net-names [data-name="mybox"]'), words('network:names-view.reserved_other', {}));
  // Its anchor: mined six deep, collected by a pass (the one the agent makes when its backoff on the pending proof ends,
  // 5 minutes after the pass at Register: its backoff ended now in the title's record), published.
  cal.mine(7);
  const before = await untouched(b);
  // The agent's passes done first (the one after Register makes the next renewal ahead and saves the title: an edit of
  // the record below made meanwhile would be written over).
  await a.evaluate('import("/web/names.ts").then((n) => n.namesAgent().pass())');
  await a.evaluate(() => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('waarm64-room');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('titles', 'readwrite');
      tx.objectStore('titles').openCursor().onsuccess = (e) => {
        const c = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
        if (!c) return;
        const t = c.value as { collect: Record<string, { next: number }> };
        for (const k of Object.keys(t.collect)) t.collect[k].next = 0;
        c.update(t);
        c.continue();
      };
      tx.oncomplete = () => { open.result.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  }));
  await a.evaluate('import("/web/names.ts").then((n) => n.namesAgent().pass())');
  await a.waitForFunction(() => document.querySelector('#net-names [data-name="mybox"]')?.getAttribute('data-state') === 'active', null, { timeout: 90_000, polling: 250 })
    .catch(async (e) => { throw new Error(`${e}; its state ${await stateOf()}`); });
  assert.match(await text(a, '#net-names [data-name="mybox"]'), words('network:names-view.active', {}));
  // Decision 6: B's guest reaches it by name, with nothing done on B's page (no switch, notice or dialog).
  let got = '';
  for (let k = 0; k < 30 && !new RegExp(`^${ipA}\\s`).test(got); k++) {
    got = await run(b, `getent ahosts mybox.${domain} | head -1`);
    if (!new RegExp(`^${ipA}\\s`).test(got)) await b.waitForTimeout(2000);
  }
  assert.match(got, new RegExp(`^${ipA}\\s`), `B reaches A by the name A's dialog registered: ${got}`);
  const ping = await run(b, `ping -6 -c 2 -W 10 mybox.${domain} | tail -2`, 60_000);
  assert.match(ping, / 0% packet loss/, ping);
  assert.deepEqual(await untouched(b), before, 'nothing on B\'s page');
  // A's details: the registry's line, and a label added under the name (at this machine), which A's resolver answers.
  await a.click('#net-details-open');
  await a.waitForFunction(() => !!document.getElementById('net-details-names-line'), null, { timeout: 30_000 });
  assert.match(await text(a, '#net-details-names-line'), words('network:names-view.line.serving_other', {}));
  await a.click('#net-details [data-name="mybox"] [data-action="add-label"]');
  await a.fill('#net-details [data-name="mybox"] [data-point=""] [data-field="label"] >> nth=0', 'web');
  await a.click('#net-details [data-name="mybox"] [data-action="save-zone"]');
  await a.click('#net-details-close');
  let web = '';
  for (let k = 0; k < 20 && !web; k++) {
    web = await run(a, `getent ahosts web.mybox.${domain} | head -1`);
    if (!web) await a.waitForTimeout(1000);
  }
  assert.match(web, new RegExp(`^${ipA}\\s`), `the label points at A: ${web}`);
  // On load, a name in its last week is said (this browser's clock 24 days on: kept until 30 days after the claim).
  const later = await a.context().newPage();
  await later.clock.install({ time: Date.now() + 24 * 86400_000 });
  await later.goto(`${base}/web/app/`);
  await later.waitForFunction((src) => new RegExp(src).test(document.getElementById('message-text')?.textContent ?? ''), words('network:names.lastWeek_one', { names: 'mybox' }).source, { timeout: 60_000, polling: 250 })
    .catch(async (e) => { throw new Error(`${e}; the bar says ${await later.evaluate(() => document.getElementById('message-text')?.textContent)}`); });
  await later.close();
}

/** After the name: the wizard's key carries the names; Delete says so; B's connection, not kept, can't hold one. */
async function namesKeptWithTheConnection(a: Page, b: Page) {
  // The Home page: the wizard's key carries the names; Delete says so.
  await a.click('#machines-open');
  await a.click('[data-machine="connections"]');
  await a.click('li[data-connection] [data-action="edit-connection"] >> nth=0');
  await a.locator('#net-room-new-name').evaluate((e) => e.closest('details')?.setAttribute('open', ''));
  await a.waitForFunction(() => /\./.test((document.getElementById('net-room-key-value') as HTMLInputElement).value), null, { timeout: 10_000 });
  const exported = await a.locator('#net-room-key-value').inputValue();
  assert.match(exported, /^[0-9a-f]{64}\.[A-Za-z0-9_-]+$/, 'the key, then its names');
  await a.keyboard.press('Escape');
  cancelling = true;
  const n = asked.length;
  await a.click('li[data-connection] [data-action="delete-connection"] >> nth=0');
  for (let k = 0; k < 100 && asked.length === n; k++) await a.waitForTimeout(100);
  cancelling = false;
  const q = asked.at(-1);
  assert.ok(asked.length > n && q, 'Delete asks');
  assert.equal(q.kind, 'prompt', 'with a field');
  assert.match(q.text, words('network:network-actions.delete.names.on_one', { names: 'mybox' }));
  assert.equal(q.value, exported, 'the export to copy');
  await a.waitForFunction(() => !(document.getElementById('ask') as HTMLDialogElement).open, null, { timeout: 5_000 });
  assert.equal((await rooms(a)).length, 1, 'Cancel: kept');
  // B's connection isn't kept (its key is in the page's memory): it can't hold a name, and the dialog says so.
  if (!(await b.evaluate(() => (document.getElementById('network') as HTMLDetailsElement).open))) await b.locator('#network summary').click();
  await b.click('#net-name-open');
  await b.waitForFunction(() => (document.getElementById('net-name') as HTMLDialogElement).open, null, { timeout: 5_000 });
  assert.match(await text(b, '#net-name-ephemeral'), words('network:NameDialog.ephemeral'));
  assert.equal(await b.locator('#net-name-register').count(), 0, 'no Register');
  assert.equal(await b.locator('#net-name-input').count(), 0, 'no field');
}
