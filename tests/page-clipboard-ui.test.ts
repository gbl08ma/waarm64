// Clipboard sharing's page without the agent (docs/plans/clipboard.md §4–§5, docs/frontend.md "The toolbar"): on
// Buildroot with `?clipboard=1` (seconds) and `?agentstub`, the test plays the agent's device end (the page's frames
// collected and decoded here, the agent's posted). The toolbar's clipboard button: absent
// without the setting; waiting, sharing, paused; the browser's read permission (prompt: the amber light and the item that
// asks, which headless Chromium answers with a denial; denied: how to allow it; granted, by the test, updating the
// button at once); sync with the permission (the host's copy offered on `clipboardchange`, which Chromium fires);
// the switch saying PAUSE and RESUME, nothing offered while paused and nothing sent by the resume; Send the clipboard
// to the guest, Type the clipboard and Copy the console's text (COPY, the agent's COPIED); Copy the screen (the framebuffer the guest drew, as a PNG on the host's
// clipboard, with no agent). The agent's HELLO as the sign that the machine is up (`?ready=guest`). The PNG worker
// (web/app/png.ts) on a BMP, a JPEG and RGBA pixels. And the Home page's switches: the agent's, on by default, and
// the clipboard's under it, off for a machine that hasn't it, its note, the link to the OpenRC installer's command, ticking it asks for the permission, neither
// orphaning snapshots, saved into the record. A machine made from a demo (`fromDemo`): each run starts paused, with no
// clipboard read, and one click on the switch shares.
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { PAGE_QUERY } from './page-query.ts';
import { answerAsks, type Question } from './page-ask.ts';
import { CAP, COPIED, decodeOffer, encodeFrame, encodeHello, encodeOffer, FRAME, FrameReader, TYPED, type Frame } from '../web/agent-frame.ts';
import { pageCaps } from '../web/app/agent-link.ts';
import { AGENT_OPENRC_INSTALL } from '../web/app/guest-agent.ts';
import { TEXT } from '../web/app/clipboard-host.ts';
import { plain, t } from '../web/i18n.ts';

const IMAGES = new URL('../target/images/', import.meta.url);
const skip = !(existsSync(new URL('buildroot/rootfs.ext4', IMAGES)) && existsSync(new URL('linux/Image', IMAGES))) && 'SKIPPED: run images/build.sh';

let browser: Browser;
let base: string;
let close: () => void;
before(async () => {
  const server = await startServer();
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
});
after(async () => { await browser?.close(); close?.(); });

const terminal = (page: Page) => page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '');
async function onSerial(page: Page, text: string) {
  // The clipboard menu, left open, would cover the terminal.
  await page.evaluate(() => { const m = document.getElementById('clipboard-menu') as HTMLDetailsElement | null; if (m) m.open = false; });
  await page.locator('.xterm').click();
  await page.keyboard.type(text, { delay: 5 });
}
let runs = 0;
/** Runs `cmd` on the serial shell: its output on one line, between markers of its own. */
async function run(page: Page, cmd: string, ms = 30_000) {
  const re = new RegExp(`<<${++runs}:([^<>]*)>>`);
  await onSerial(page, `clear; echo "<<${runs}:$({ ${cmd}; } 2>&1 | tr '\\n<>' ' []')>"">"\n`);
  await page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.xterm-rows')?.textContent ?? ''), re.source, { timeout: ms, polling: 100 })
    .catch(async (e) => { throw new Error(`${e}; the terminal shows: ${await terminal(page)}`); });
  return re.exec(await terminal(page))![1].trim();
}
/**
 * The agent's device end, played by the test (`?agentstub`, web/app/run/dev-knobs.ts): the bytes the page sends are
 * collected (and taken at once), as a guest agent reading its vsock connection would.
 */
const stub = (page: Page) => page.evaluate(() => {
  const w = window as unknown as { __agentStub: MessagePort; __stubGot: number[]; __stubConn: number };
  w.__stubGot = [];
  w.__stubConn = 0;
  w.__agentStub.onmessage = (e: MessageEvent<{ type: string; bytes?: Uint8Array; conn: number }>) => {
    if (e.data.type !== 'data' || !e.data.bytes || e.data.conn !== w.__stubConn) return;
    w.__stubGot.push(...e.data.bytes);
    w.__agentStub.postMessage({ type: 'taken', n: e.data.bytes.length, conn: e.data.conn });
  };
});
/** The "agent" connects (the page then sends HELLO and the switch), or its connection ends. */
const openPort = (page: Page, open = true) => page.evaluate((open) => { const w = window as unknown as { __agentStub: MessagePort; __stubConn: number }; if (open) w.__stubConn++; w.__agentStub.postMessage({ type: 'open', open, conn: w.__stubConn }); }, open);
/** The "agent" writes `bytes`. */
const guestWrites = (page: Page, bytes: Uint8Array) => page.evaluate((b) => { const w = window as unknown as { __agentStub: MessagePort; __stubConn: number }; w.__agentStub.postMessage({ type: 'data', bytes: new Uint8Array(b), conn: w.__stubConn }); }, [...bytes]);
/** The "agent" reads `n` bytes: the frames in them. */
async function guestReads(page: Page, n: number): Promise<Frame[]> {
  await page.waitForFunction((n) => (window as unknown as { __stubGot: number[] }).__stubGot.length >= n, n, { timeout: 10_000, polling: 50 })
    .catch(async () => assert.fail(`the agent's end got ${await page.evaluate(() => JSON.stringify((window as unknown as { __stubGot: number[] }).__stubGot))}, not ${n} bytes`));
  const bytes = new Uint8Array(await page.evaluate((n) => (window as unknown as { __stubGot: number[] }).__stubGot.splice(0, n), n));
  return new FrameReader().push(bytes);
}
const HELLO = encodeFrame(FRAME.HELLO, encodeHello({ version: 1, caps: CAP.TYPE | CAP.TEXT | CAP.COPY }));
/** The size of the page's frame offering `text` inline. */
const offerSize = (text: string) => encodeFrame(FRAME.OFFER, encodeOffer({ serial: 0, types: [{ type: TEXT, size: Buffer.byteLength(text) }], inline: new TextEncoder().encode(text) })).length;
const inline = (f: Frame) => new TextDecoder().decode(decodeOffer(f.payload)!.inline);
const button = (page: Page) => page.evaluate(() => {
  const m = document.getElementById('clipboard-menu');
  return m && { state: m.dataset.state, permission: m.dataset.permission, on: m.dataset.on !== undefined, dot: m.querySelector<HTMLElement>('summary .dot')?.dataset.tone, title: m.querySelector('summary')!.getAttribute('title') };
});
const waitButton = (page: Page, f: (b: NonNullable<Awaited<ReturnType<typeof button>>>) => boolean, what: string) =>
  (async () => {
    for (let i = 0; i < 100; i++) {
      const b = await button(page);
      if (b && f(b)) return b;
      await page.waitForTimeout(100);
    }
    assert.fail(`${what}: the button is ${JSON.stringify(await button(page))}`);
  })();
/** The browser's clipboard-read permission, as the page reads it. */
const readState = (page: Page) => page.evaluate(async () => (await navigator.permissions.query({ name: 'clipboard-read' as PermissionName })).state);
const menu = async (page: Page, open: boolean) => {
  if ((await page.evaluate(() => (document.getElementById('clipboard-menu') as HTMLDetailsElement).open)) !== open) await page.click('#clipboard-menu > summary');
};
async function boot(page: Page, query: string) {
  await page.goto(`${base}/web/app/?${PAGE_QUERY}machine=buildroot&view=both&agentstub&${query}`);
  await page.waitForFunction(() => document.body.dataset.state === 'running' && /# $/.test(`${document.querySelector('.xterm-rows')?.textContent?.trimEnd()} `), null, { timeout: 60_000, polling: 200 });
  await stub(page);
}

test("the toolbar's clipboard button: only with the setting; waiting, sharing, paused; the read permission's states; sync, the switch, Send, Type, Copy the console's text", { skip, timeout: 180_000 }, async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await answerAsks(page);
  await boot(page, '');
  assert.equal(await button(page), null, 'no setting: no button');

  await boot(page, 'clipboard=1');
  // No agent yet: waiting; the browser hasn't decided on reading the clipboard (headless Chromium: prompt).
  let b = await waitButton(page, (x) => x.state === 'waiting', 'before the agent');
  assert.deepEqual({ ...b, title: b.title === t('clipboard:ClipboardMenu.title.waiting') }, { state: 'waiting', permission: 'prompt', on: false, dot: 'busy', title: true });
  await menu(page, true);
  assert.equal(await page.isDisabled('#clipboard-send'), true);
  assert.equal(await page.isDisabled('#clipboard-type'), true);
  assert.equal(await page.isDisabled('#clipboard-console'), true);
  assert.equal(await page.isVisible('#clipboard-waiting'), true);
  await menu(page, false);

  // The "agent" connects: the page's HELLO and the switch (RESUME); its HELLO back: sharing (never pressed), with the
  // permission's amber light (no permission: the guest's menus don't get the host's copy).
  await openPort(page);
  const opening = await guestReads(page, encodeFrame(FRAME.HELLO, encodeHello({ version: 1, caps: pageCaps(true) })).length + 5);
  assert.deepEqual(opening.map((f) => f.type), [FRAME.HELLO, FRAME.RESUME]);
  await guestWrites(page, HELLO);
  b = await waitButton(page, (x) => x.state === 'sharing', 'after HELLO');
  assert.deepEqual({ ...b, title: b.title === t('clipboard:ClipboardMenu.title.limited') }, { state: 'sharing', permission: 'prompt', on: false, dot: 'busy', title: true });

  // Allow seeing the clipboard…: the click's read makes the browser ask (headless Chromium says no at once): denied,
  // told by the permission's change event, with how to allow it.
  await menu(page, true);
  await page.click('#clipboard-allow');
  b = await waitButton(page, (x) => x.permission === 'denied', 'after asking');
  assert.equal(b.dot, 'busy');
  await menu(page, true);
  assert.equal(await page.textContent('#clipboard-denied'), t('clipboard:ClipboardMenu.denied'));
  assert.equal(await page.locator('#clipboard-allow').count(), 0);
  await menu(page, false);
  // Allowed (in the site's settings): the button follows at once, green; and it syncs (the clipboard is empty: nothing).
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  b = await waitButton(page, (x) => x.permission === 'granted', 'after the grant');
  assert.deepEqual({ ...b, title: b.title === t('clipboard:ClipboardMenu.title.sharing') }, { state: 'sharing', permission: 'granted', on: false, dot: 'ok', title: true });

  // Sync: a copy on the host reaches the guest (Chromium fires clipboardchange; the page reads on it) as an OFFER.
  const copied = 'copied on the host ✓';
  await page.evaluate((s) => navigator.clipboard.writeText(s), copied);
  const [offer] = await guestReads(page, offerSize(copied));
  assert.equal(offer.type, FRAME.OFFER);
  assert.equal(inline(offer), copied);

  // Pause from the switch: PAUSE to the agent, the icon crossed out; a copy while paused isn't offered.
  await menu(page, true);
  await page.uncheck('#clipboard-on');
  b = await waitButton(page, (x) => x.state === 'paused', 'paused');
  assert.deepEqual({ ...b, title: b.title === t('clipboard:ClipboardMenu.title.paused') }, { state: 'paused', permission: 'granted', on: false, dot: 'off', title: true });
  assert.equal(await page.isDisabled('#clipboard-send'), true);
  assert.equal(await page.isDisabled('#clipboard-type'), true);
  assert.deepEqual((await guestReads(page, 5)).map((f) => f.type), [FRAME.PAUSE]);
  const during = 'copied during the pause';
  await page.evaluate((s) => navigator.clipboard.writeText(s), during);
  await page.waitForTimeout(500);
  // Resume: RESUME, and nothing on its own; the next frame is Send's.
  await menu(page, true);
  await page.check('#clipboard-on');
  await waitButton(page, (x) => x.state === 'sharing', 'resumed');
  await page.waitForTimeout(500);
  await page.click('#clipboard-send');
  const [resume, sent] = await guestReads(page, 5 + offerSize(during));
  assert.equal(resume.type, FRAME.RESUME);
  assert.equal(sent.type, FRAME.OFFER, 'nothing between RESUME and Send');
  assert.equal(inline(sent), during);
  // Type the clipboard: TYPE with the host's text, then the paste's end (an empty TYPE).
  await menu(page, true);
  await page.click('#clipboard-type');
  const [typed, end] = await guestReads(page, 5 + Buffer.byteLength(during) + 5);
  assert.equal(typed.type, FRAME.TYPE);
  assert.equal(new TextDecoder().decode(typed.payload), during);
  assert.deepEqual([end.type, end.payload.length], [FRAME.TYPE, 0]);
  // What became of a paste (the agent's TYPED) shows in the menu the click left open: a failure keeps it open, where the
  // user looks; typed whole, it closes. The "agent" answers a moment after the click's frames.
  const isOpen = () => page.evaluate(() => (document.getElementById('clipboard-menu') as HTMLDetailsElement).open);
  const answerLater = async (typed: number) => {
    await guestReads(page, 5 + Buffer.byteLength(during) + 5);
    await page.waitForTimeout(3000);
    await guestWrites(page, encodeFrame(FRAME.TYPED, new Uint8Array([typed])));
  };
  await menu(page, true);
  await page.click('#clipboard-type');
  let later = answerLater(TYPED.NOT_TEXT);
  assert.equal(await isOpen(), true, 'the menu closed at the click, before Type\'s outcome');
  await page.waitForSelector('#clipboard-not-text', { timeout: 10_000 });
  await later;
  assert.equal(await isOpen(), true, 'the menu closed before Type\'s refusal showed');
  assert.equal(await page.textContent('#clipboard-not-text'), t('clipboard:ClipboardMenu.notText'));
  await menu(page, true);
  await page.click('#clipboard-type');
  later = answerLater(TYPED.DONE);
  assert.equal(await isOpen(), true, 'the menu closed at the click, before Type\'s outcome');
  await page.waitForFunction(() => !(document.getElementById('clipboard-menu') as HTMLDetailsElement).open, undefined, { timeout: 10_000 });
  await later;

  // Copy the console's text: COPY, the "agent's" COPIED with the screen's text, on the host's clipboard as text; a
  // console that shows graphics says so, in the menu the click left open.
  await menu(page, true);
  await page.click('#clipboard-console');
  assert.deepEqual((await guestReads(page, 5)).map((f) => f.type), [FRAME.COPY]);
  const screenText = 'root@buildroot:~# ls\nété ☃';
  await guestWrites(page, encodeFrame(FRAME.COPIED, new Uint8Array([COPIED.OK, ...new TextEncoder().encode(screenText)])));
  await page.waitForFunction((s) => navigator.clipboard.readText().then((t) => t === s), screenText, { timeout: 10_000, polling: 100 })
    .catch(async () => assert.fail(`the host's clipboard has ${JSON.stringify(await page.evaluate(() => navigator.clipboard.readText()))}`));
  await page.waitForFunction(() => !(document.getElementById('clipboard-menu') as HTMLDetailsElement).open, undefined, { timeout: 10_000 });
  // The host's clipboard changed: sharing offers it to the guest, as any copy on the host (dropped here).
  await page.waitForTimeout(500);
  await page.evaluate(() => { (window as unknown as { __stubGot: number[] }).__stubGot.length = 0; });
  await menu(page, true);
  await page.click('#clipboard-console');
  await guestReads(page, 5);
  await guestWrites(page, encodeFrame(FRAME.COPIED, new Uint8Array([COPIED.GRAPHICS])));
  await page.waitForSelector('#clipboard-graphics', { timeout: 10_000 });
  assert.equal(await page.textContent('#clipboard-graphics'), t('clipboard:ClipboardMenu.console.graphics'));
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), screenText, 'the clipboard kept');
  await menu(page, false);

  // The "agent's" connection ends: waiting again.
  await openPort(page, false);
  await waitButton(page, (x) => x.state === 'waiting', 'the connection ended');
  // A machine started with the permission granted: the host's clipboard goes to the guest once its agent says HELLO.
  await boot(page, 'clipboard=1');
  await openPort(page);
  assert.deepEqual((await guestReads(page, opening.reduce((n, f) => n + 5 + f.payload.length, 0))).map((f) => f.type), [FRAME.HELLO, FRAME.RESUME]);
  await guestWrites(page, HELLO);
  const [atHello] = await guestReads(page, offerSize(screenText));
  assert.equal(inline(atHello), screenText, "the host's clipboard now: the console's text");

  // Copy the screen: a PNG of the framebuffer (640×480, the console's text on it) on the host's clipboard, no agent
  // needed (the connection ended: waiting).
  await openPort(page, false);
  await waitButton(page, (x) => x.state === 'waiting', 'the connection ended again');
  // The guest draws its top 160 rows white (x8r8g8b8: 640 × 4 bytes a row); the rest stays black.
  assert.equal(await run(page, "head -c 409600 /dev/zero | tr '\\000' '\\377' >/dev/fb0; echo drawn"), 'drawn');
  await page.waitForTimeout(500);
  await menu(page, true);
  await page.click('#clipboard-screen');
  const screenShot = () => page.evaluate(async () => {
    const item = (await navigator.clipboard.read()).find((i) => i.types.includes('image/png'));
    if (!item) return undefined;
    const bitmap = await createImageBitmap(await item.getType('image/png'));
    const c = new OffscreenCanvas(bitmap.width, bitmap.height);
    const g = c.getContext('2d')!;
    g.drawImage(bitmap, 0, 0);
    const d = g.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let [white, black] = [0, 0];
    for (let k = 0; k < d.length; k += 4) {
      if (d[k] === 255 && d[k + 1] === 255 && d[k + 2] === 255) white++;
      else if (!(d[k] | d[k + 1] | d[k + 2])) black++;
    }
    return { width: bitmap.width, height: bitmap.height, white, black, top: [...d.subarray(0, 4)], opaque: d.every((v, k) => k % 4 !== 3 || v === 255) };
  });
  let shot = await screenShot();
  for (let i = 0; !shot && i < 40; i++) {
    await page.waitForTimeout(250);
    shot = await screenShot();
  }
  assert.ok(shot, 'no image on the host\'s clipboard after Copy the screen');
  assert.deepEqual(shot, { width: 640, height: 480, white: 640 * 160, black: 640 * 320, top: [255, 255, 255, 255], opaque: true }, 'the screen\'s PNG');
  await menu(page, true);
  assert.equal(await page.locator('#clipboard-failed').count(), 0);
  await menu(page, false);
  assert.deepEqual(errors, []);
  await context.close();
});

const uefiSkip = skip || (!existsSync(new URL('edk2/QEMU_EFI.fd', IMAGES)) && 'SKIPPED: run images/build.sh edk2');
test("a demo's machine starts each run paused: PAUSE at the agent's opening, no clipboard read (the permission stays prompt) at HELLO or focus, Allow hidden; one click on the switch shares (RESUME, its click asks); a machine not from a demo shares from the start", { skip: uefiSkip, timeout: 120_000 }, async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await answerAsks(page);
  // Every read the page makes, counted (any of them while the permission is prompt would make Chromium ask).
  await page.addInitScript(() => {
    const w = window as unknown as { __reads: number };
    w.__reads = 0;
    const c = Clipboard.prototype;
    const [readText, read] = [c.readText, c.read];
    c.readText = function () { w.__reads++; return readText.call(this); };
    c.read = function (...a) { w.__reads++; return read.apply(this, a); };
  });
  const reads = () => page.evaluate(() => (window as unknown as { __reads: number }).__reads);
  await page.goto(`${base}/web/app/#home`);
  await page.locator('.machines').waitFor();
  // A disk the firmware won't boot (Buildroot's root file system): the page starts no machine without one.
  const path = '/target/images/buildroot/rootfs.ext4';
  const bytes = statSync(new URL('buildroot/rootfs.ext4', IMAGES)).size;
  const disk = { id: 'dddddddddd0d', kind: 'url', name: 'rootfs.ext4', size: bytes, url: path, identity: { kind: 'url', path, bytes }, created: 0 };
  const demo = { id: 'dddddddddd01', name: 'From a demo', ncpus: 1, ramMiB: 512, display: '2d', network: false, attachments: [{ id: 'dddddddddda1', disk: disk.id, readOnly: true }], clipboard: true, fromDemo: { store: `${base}/store.json`, id: 'alpine-term' }, created: 0, modified: 0 };
  const plainOne = { ...demo, id: 'dddddddddd02', name: 'Not from a demo', fromDemo: undefined };
  await page.evaluate(async (ms) => {
    const { Store } = await import('/web/app/store.ts' as string);
    const store = await Store.open();
    await store.put('disks', ms.disk);
    for (const m of ms.machines) await store.put('machines', m);
    store.close();
  }, { disk, machines: [demo, plainOne] });
  /** The machine `id` started (the firmware, finding nothing to boot: only the agent's end, the test's, matters). */
  const start = async (id: string) => {
    await page.goto(`${base}/web/app/?${PAGE_QUERY}view=both&agentstub&m=${id}`);
    await page.waitForFunction(() => !!(window as unknown as { __agentStub?: MessagePort }).__agentStub, null, { timeout: 30_000, polling: 100 })
      .catch(async (e) => assert.fail(`${e}; the page: ${await page.evaluate(() => JSON.stringify({ url: location.href, state: document.body.dataset.state, message: document.getElementById('message-text')?.textContent, ask: document.querySelector('dialog[open]')?.textContent?.slice(0, 300) }))}`));
    await stub(page);
  };
  const helloSize = encodeFrame(FRAME.HELLO, encodeHello({ version: 1, caps: pageCaps(true) })).length;

  await start(demo.id);
  let b = await waitButton(page, (x) => x.state === 'paused', 'a demo\'s machine before the agent');
  await openPort(page);
  assert.deepEqual((await guestReads(page, helloSize + 5)).map((f) => f.type), [FRAME.HELLO, FRAME.PAUSE], 'PAUSE at the opening');
  await guestWrites(page, HELLO);
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); // headless: bringToFront fires none
  await page.waitForTimeout(500);
  b = await waitButton(page, (x) => x.state === 'paused', 'after HELLO');
  assert.deepEqual({ ...b, title: b.title === t('clipboard:ClipboardMenu.title.pausedDemo') }, { state: 'paused', permission: 'prompt', on: false, dot: 'off', title: true });
  assert.deepEqual([await reads(), await readState(page)], [0, 'prompt'], 'no read while paused: the browser asked nothing');
  await menu(page, true);
  assert.equal(await page.isChecked('#clipboard-on'), false);
  assert.equal(await page.locator('#clipboard-allow').count(), 0, 'Allow… hidden: the switch is the one click');
  assert.equal(await page.textContent('#clipboard-paused-demo').then((s) => s?.trim()), t('clipboard:ClipboardMenu.title.pausedDemo'));
  assert.equal(await page.isDisabled('#clipboard-send'), true);
  assert.deepEqual([await reads(), await readState(page)], [0, 'prompt'], 'opening the menu reads nothing');
  // One click: RESUME, sharing; the click's read asks (headless Chromium denies at once).
  await page.check('#clipboard-on');
  assert.deepEqual((await guestReads(page, 5)).map((f) => f.type), [FRAME.RESUME]);
  b = await waitButton(page, (x) => x.state === 'sharing' && x.permission === 'denied', 'after the click');
  assert.equal(await reads(), 1, "the switch's click read once, to ask");
  // Allowed: the host's copy reaches the guest.
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  await waitButton(page, (x) => x.permission === 'granted', 'after the grant');
  const copied = 'shared after one click';
  await page.evaluate((s) => navigator.clipboard.writeText(s), copied);
  const [offer] = await guestReads(page, offerSize(copied));
  assert.equal(inline(offer), copied);
  // The next run starts paused again: the resume isn't remembered.
  await start(demo.id);
  await openPort(page);
  assert.deepEqual((await guestReads(page, helloSize + 5)).map((f) => f.type), [FRAME.HELLO, FRAME.PAUSE], 'paused again at the next run');
  await guestWrites(page, HELLO);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForTimeout(500);
  await waitButton(page, (x) => x.state === 'paused', 'the next run');
  assert.equal(await reads(), 0, 'granted, yet no read while paused');

  // A machine not from a demo: RESUME at the opening, sharing from the start (granted now: its HELLO reads, as before).
  await start(plainOne.id);
  await openPort(page);
  assert.deepEqual((await guestReads(page, helloSize + 5)).map((f) => f.type), [FRAME.HELLO, FRAME.RESUME]);
  await guestWrites(page, HELLO);
  b = await waitButton(page, (x) => x.state === 'sharing', 'not from a demo');
  assert.equal(b.title, t('clipboard:ClipboardMenu.title.sharing'));
  const [atHello] = await guestReads(page, offerSize(copied));
  assert.equal(inline(atHello), copied, "the host's clipboard at HELLO");
  assert.deepEqual(errors, []);
  await context.close();
});

test("the agent's HELLO says the machine is up: with the serial marker off (`?ready=guest`), booting until the guest's agent says HELLO, then running", { skip, timeout: 120_000 }, async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await answerAsks(page);
  await page.goto(`${base}/web/app/?${PAGE_QUERY}machine=buildroot&view=both&agentstub&clipboard=1&ready=guest`);
  // Buildroot's shell prompt (its marker) is up, but not watched for: the machine is still booting.
  await page.waitForFunction(() => /# $/.test(`${document.querySelector('.xterm-rows')?.textContent?.trimEnd()} `), null, { timeout: 60_000, polling: 200 });
  await stub(page);
  await openPort(page);
  await guestReads(page, encodeFrame(FRAME.HELLO, encodeHello({ version: 1, caps: pageCaps(true) })).length + 5); // the page's HELLO and RESUME
  assert.equal(await page.evaluate(() => document.body.dataset.state), 'booting', 'connected, no HELLO yet');
  await guestWrites(page, HELLO);
  await page.waitForFunction(() => document.body.dataset.state === 'running', null, { timeout: 10_000, polling: 100 })
    .catch(async () => assert.fail(`after the agent's HELLO the machine is ${await page.evaluate(() => document.body.dataset.state)}`));
  // A second HELLO (the agent restarted) changes nothing.
  await guestWrites(page, HELLO);
  assert.equal(await page.evaluate(() => document.body.dataset.state), 'running');
  assert.deepEqual(errors, []);
  await context.close();
});

test('the PNG worker (web/app/png.ts): a BMP, a JPEG and RGBA pixels as PNGs of the same pixels; what the browser can\'t decode refused', { timeout: 60_000 }, async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route(`${base}/png.html`, (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>png</title>' }));
  await page.goto(`${base}/png.html`);
  const got = await page.evaluate(async () => {
    const { rgbaPng, toPng } = await import('/web/app/png.ts' as string) as typeof import('../web/app/png.ts');
    const pixels = async (b: Blob) => {
      const bitmap = await createImageBitmap(b);
      const c = new OffscreenCanvas(bitmap.width, bitmap.height);
      const g = c.getContext('2d')!;
      g.drawImage(bitmap, 0, 0);
      return { type: b.type, signature: [...new Uint8Array(await b.slice(0, 8).arrayBuffer())], width: bitmap.width, height: bitmap.height, rgba: [...g.getImageData(0, 0, bitmap.width, bitmap.height).data] };
    };
    // A 2×2 BMP, 24 bits, bottom-up rows of BGR padded to 4 bytes: blue, green over red, white.
    const bmp = new Uint8Array(70);
    const v = new DataView(bmp.buffer);
    bmp.set([0x42, 0x4d]);
    v.setUint32(2, 70, true);
    v.setUint32(10, 54, true);
    v.setUint32(14, 40, true);
    v.setInt32(18, 2, true);
    v.setInt32(22, 2, true);
    v.setUint16(26, 1, true);
    v.setUint16(28, 24, true);
    v.setUint32(34, 16, true);
    bmp.set([0, 0, 255, 255, 255, 255, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0], 54);
    const fromBmp = await pixels(await toPng(new Blob([bmp], { type: 'image/bmp' })));
    // A JPEG of a canvas, red on the left and blue on the right.
    const c = new OffscreenCanvas(64, 32);
    const g = c.getContext('2d')!;
    g.fillStyle = '#f00';
    g.fillRect(0, 0, 32, 32);
    g.fillStyle = '#00f';
    g.fillRect(32, 0, 32, 32);
    const fromJpeg = await pixels(await toPng(await c.convertToBlob({ type: 'image/jpeg', quality: 0.95 })));
    const fromRgba = await pixels(await rgbaPng(2, 1, new Uint8Array([10, 20, 30, 255, 200, 100, 50, 255])));
    const refused = await toPng(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' })).then(() => 'converted', (e) => (e as DOMException).name);
    return { fromBmp, fromJpeg: { ...fromJpeg, rgba: undefined, left: fromJpeg.rgba.slice(4 * (16 * 64 + 8), 4 * (16 * 64 + 8) + 4), right: fromJpeg.rgba.slice(4 * (16 * 64 + 56), 4 * (16 * 64 + 56) + 4) }, fromRgba, refused };
  });
  const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  assert.deepEqual(got.fromBmp, { type: 'image/png', signature: PNG_SIGNATURE, width: 2, height: 2, rgba: [0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255, 255, 255, 255, 255] });
  assert.deepEqual({ ...got.fromJpeg, left: undefined, right: undefined }, { type: 'image/png', signature: PNG_SIGNATURE, width: 64, height: 32, rgba: undefined, left: undefined, right: undefined });
  const near = (a: number[], b: number[]) => a.every((x, i) => Math.abs(x - b[i]) <= 8);
  assert.ok(near(got.fromJpeg.left, [255, 0, 0, 255]) && near(got.fromJpeg.right, [0, 0, 255, 255]), `the JPEG's pixels: ${got.fromJpeg.left} ${got.fromJpeg.right}`);
  assert.deepEqual(got.fromRgba, { type: 'image/png', signature: PNG_SIGNATURE, width: 2, height: 1, rgba: [10, 20, 30, 255, 200, 100, 50, 255] });
  assert.equal(got.refused, 'DataError');
  assert.deepEqual(errors, []);
  await context.close();
});

test("the Home page's agent and clipboard switches: the agent on by default, the clipboard off, its note, the OpenRC dialog's command; off without the agent; ticking it asks for the permission; no orphans (not in the shape); saved", { timeout: 120_000 }, async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const asked: Question[] = [];
  await answerAsks(page, (q) => { asked.push(q); });
  await page.goto(`${base}/web/app/#home`);
  await page.locator('.machines').waitFor();
  await page.evaluate(async () => {
    const { Store } = await import('/web/app/store.ts' as string);
    const { currentShape } = await import('/web/app/snapshots.ts' as string);
    const store = await Store.open();
    const m = { id: 'cccccccccccc', name: 'Clipboard machine', ncpus: 2, ramMiB: 1024, display: '2d', network: true, attachments: [], created: 0, modified: 0 };
    await store.put('machines', m);
    const { shape, hash } = await currentShape(m, () => undefined, { display: '2d' });
    await store.put('snapshots', { id: 'dddddddddddd', machine: m.id, name: 'Before', created: 1, bytes: 1, shape, shapeHash: hash, pins: [] });
  });
  await page.reload();
  await page.locator('.machines .pick', { hasText: 'Clipboard machine' }).click();
  await page.locator('.machines [data-selected] [data-tab=settings]').click();
  const stored = () => page.evaluate(async () => {
    const { Store } = await import('/web/app/store.ts' as string);
    const m = await (await Store.open()).get('machines', 'cccccccccccc');
    return { agent: m.agent, clipboard: m.clipboard };
  });
  const save = async () => {
    await page.click('.machines [data-action=save]');
    await page.waitForFunction(() => (document.querySelector('.machines [data-action=save]') as HTMLButtonElement).disabled, null, { polling: 100 });
  };
  assert.equal(await page.isChecked('.machines [data-field=agent]'), true, 'the agent: on by default');
  assert.equal(await page.textContent('.machines [data-agent-note]'), t('machines:DeviceSwitches.agent.on'));
  assert.equal(await page.isChecked('.machines [data-field=clipboard]'), false);
  const note = await page.locator('.machines .check-field', { has: page.locator('[data-field=clipboard]') }).locator('.note').textContent();
  assert.equal(note?.replace(/\s+/g, ' ').trim(), plain(t('machines:DeviceSwitches.clipboard.note')).replace(/\s+/g, ' ').trim());
  // The link under it: the OpenRC installer's command in a dialog, to copy (docs/devices.md "On OpenRC"); closed again.
  await page.click('.machines #agent-openrc-open');
  await page.locator('dialog#agent-openrc[open]').waitFor();
  assert.equal(await page.inputValue('#agent-openrc-command'), AGENT_OPENRC_INSTALL);
  assert.equal(await page.isVisible('#agent-openrc-command-copy'), true);
  await page.click('#agent-openrc-close');
  await page.locator('dialog#agent-openrc').waitFor({ state: 'detached' });
  // Ticking it is the click that asks: Chromium prompts (headless: denied at once).
  assert.equal(await readState(page), 'prompt');
  await page.check('.machines [data-field=clipboard]');
  for (let i = 0; (await readState(page)) !== 'denied'; i++) {
    if (i > 50) assert.fail(`ticking the switch didn't ask: the permission is ${await readState(page)}`);
    await page.waitForTimeout(100);
  }
  await save();
  assert.deepEqual(await stored(), { agent: undefined, clipboard: true });
  assert.ok(!asked.some((q) => q.text === t('machines:machine-edit.orphans.confirm')), 'no snapshot orphaned: nothing asked');
  // The agent off: the clipboard's switch with it.
  await page.uncheck('.machines [data-field=agent]');
  assert.equal(await page.textContent('.machines [data-agent-note]'), t('machines:DeviceSwitches.agent.off'));
  assert.equal(await page.isDisabled('.machines [data-field=clipboard]'), true);
  await save();
  assert.deepEqual(await stored(), { agent: false, clipboard: true });
  await page.click('.machines [data-tab=snapshots]');
  assert.equal(await page.locator('.machines', { hasText: t('machines:shape-diff.clipboard.hadNo') }).count(), 0, 'the snapshot still fits');
  assert.deepEqual(errors, []);
  await context.close();
});
