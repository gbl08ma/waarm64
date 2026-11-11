// Clipboard sharing's page without the agent (docs/plans/clipboard.md §4–§5, docs/frontend.md "The toolbar"): on
// Buildroot with `?clipboard=1` (seconds), the guest's shell plays the agent on the port (`exec 3<>` its node, HELLO
// written with printf, the page's frames read back with dd and decoded here). The toolbar's clipboard button: absent
// without the setting; waiting, sharing, paused; the browser's read permission (prompt: the mark and the item that
// asks, which headless Chromium answers with a denial; denied: how to allow it; granted, by the test, updating the
// button at once); sync with the permission (the host's copy offered on `clipboardchange`, which Chromium fires);
// the switch saying PAUSE and RESUME, nothing offered while paused and nothing sent by the resume; Send the clipboard
// to the guest and Type the clipboard; Copy the screen (the framebuffer the guest drew, as a PNG on the host's
// clipboard, with no agent). The PNG worker (web/app/png.ts) on a BMP, a JPEG and RGBA pixels. And the Machines page's
// switch: off for a machine that hasn't it, its note, ticking it asks for the permission, the orphans' warning both
// ways, saved into the record.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { PAGE_QUERY } from './page-query.ts';
import { answerAsks, type Question } from './page-ask.ts';
import { CAP, decodeOffer, encodeFrame, encodeHello, encodeOffer, FRAME, FrameReader, TYPED, type Frame } from '../web/agent-frame.ts';
import { PAGE_CAPS } from '../web/app/agent-link.ts';
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
/** The guest's shell opens the agent's port as fd 3 (the page then sends HELLO and the switch). */
const openPort = (page: Page) => onSerial(page, 'exec 3<>/dev/$(basename $(dirname $(grep -l org.webpc.agent.0 /sys/class/virtio-ports/*/name)))\n');
/** The guest writes `bytes` to the port. */
const guestWrites = (page: Page, bytes: Uint8Array) => run(page, `printf '${[...bytes].map((b) => `\\${b.toString(8).padStart(3, '0')}`).join('')}' >&3; echo written`);
/** The guest reads `n` bytes from the port: the frames in them. */
async function guestReads(page: Page, n: number): Promise<Frame[]> {
  const hex = await run(page, `dd bs=1 count=${n} <&3 2>/dev/null | od -An -v -tx1`);
  const bytes = new Uint8Array(hex.split(/\s+/).filter(Boolean).map((x) => parseInt(x, 16)));
  assert.equal(bytes.length, n, `the guest read ${hex}`);
  return new FrameReader().push(bytes);
}
const HELLO = encodeFrame(FRAME.HELLO, encodeHello({ version: 1, caps: CAP.TYPE | CAP.TEXT }));
/** The size of the page's frame offering `text` inline. */
const offerSize = (text: string) => encodeFrame(FRAME.OFFER, encodeOffer({ serial: 0, types: [{ type: TEXT, size: Buffer.byteLength(text) }], inline: new TextEncoder().encode(text) })).length;
const inline = (f: Frame) => new TextDecoder().decode(decodeOffer(f.payload)!.inline);
const button = (page: Page) => page.evaluate(() => {
  const m = document.getElementById('clipboard-menu');
  return m && { state: m.dataset.state, permission: m.dataset.permission, on: m.dataset.on !== undefined, mark: !!m.querySelector('summary .dot'), title: m.querySelector('summary')!.getAttribute('title') };
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
  await page.goto(`${base}/web/app/?${PAGE_QUERY}machine=buildroot&view=both&${query}`);
  await page.waitForFunction(() => document.body.dataset.state === 'running' && /# $/.test(`${document.querySelector('.xterm-rows')?.textContent?.trimEnd()} `), null, { timeout: 60_000, polling: 200 });
}

test("the toolbar's clipboard button: only with the setting; waiting, sharing, paused; the read permission's states; sync, the switch, Send and Type", { skip, timeout: 180_000 }, async () => {
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
  assert.deepEqual({ ...b, title: b.title === t('clipboard:ClipboardMenu.title.waiting') }, { state: 'waiting', permission: 'prompt', on: false, mark: false, title: true });
  await menu(page, true);
  assert.equal(await page.isDisabled('#clipboard-send'), true);
  assert.equal(await page.isDisabled('#clipboard-type'), true);
  assert.equal(await page.isVisible('#clipboard-waiting'), true);
  await menu(page, false);

  // The guest's "agent" opens the port: the page's HELLO and the switch (RESUME); its HELLO back: sharing, with the
  // permission's mark (no permission: the guest's menus don't get the host's copy).
  await openPort(page);
  const opening = await guestReads(page, encodeFrame(FRAME.HELLO, encodeHello({ version: 1, caps: PAGE_CAPS })).length + 5);
  assert.deepEqual(opening.map((f) => f.type), [FRAME.HELLO, FRAME.RESUME]);
  await guestWrites(page, HELLO);
  b = await waitButton(page, (x) => x.state === 'sharing', 'after HELLO');
  assert.deepEqual({ ...b, title: b.title === t('clipboard:ClipboardMenu.title.limited') }, { state: 'sharing', permission: 'prompt', on: true, mark: true, title: true });

  // Allow seeing the clipboard…: the click's read makes the browser ask (headless Chromium says no at once): denied,
  // told by the permission's change event, with how to allow it.
  await menu(page, true);
  await page.click('#clipboard-allow');
  b = await waitButton(page, (x) => x.permission === 'denied', 'after asking');
  assert.equal(b.mark, true);
  await menu(page, true);
  assert.equal(await page.textContent('#clipboard-denied'), t('clipboard:ClipboardMenu.denied'));
  assert.equal(await page.locator('#clipboard-allow').count(), 0);
  await menu(page, false);
  // Allowed (in the site's settings): the button follows at once, no mark; and it syncs (the clipboard is empty: nothing).
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  b = await waitButton(page, (x) => x.permission === 'granted', 'after the grant');
  assert.deepEqual({ ...b, title: b.title === t('clipboard:ClipboardMenu.title.sharing') }, { state: 'sharing', permission: 'granted', on: true, mark: false, title: true });

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
  assert.deepEqual({ ...b, title: b.title === t('clipboard:ClipboardMenu.title.paused') }, { state: 'paused', permission: 'granted', on: false, mark: false, title: true });
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
  // user looks; typed whole, it closes. The guest's side is set up first, to answer in the background, because typing
  // on the serial shell closes the menu (onSerial). The background job's output goes away from run()'s `$(…)`, which
  // would otherwise wait for it (and it waits for the click's frames).
  const isOpen = () => page.evaluate(() => (document.getElementById('clipboard-menu') as HTMLDetailsElement).open);
  const answerLater = (typed: number) => run(page, `(sleep 3; dd bs=1 count=${5 + Buffer.byteLength(during) + 5} <&3 >/dev/null 2>&1; printf '${[...encodeFrame(FRAME.TYPED, new Uint8Array([typed]))].map((b) => `\\${b.toString(8).padStart(3, '0')}`).join('')}' >&3) </dev/null >/dev/null 2>&1 & echo later`);
  await answerLater(TYPED.NOT_TEXT);
  await menu(page, true);
  await page.click('#clipboard-type');
  assert.equal(await isOpen(), true, 'the menu closed at the click, before Type\'s outcome');
  await page.waitForSelector('#clipboard-not-text', { timeout: 10_000 });
  assert.equal(await isOpen(), true, 'the menu closed before Type\'s refusal showed');
  assert.equal(await page.textContent('#clipboard-not-text'), t('clipboard:ClipboardMenu.notText'));
  await answerLater(TYPED.DONE);
  await menu(page, true);
  await page.click('#clipboard-type');
  assert.equal(await isOpen(), true, 'the menu closed at the click, before Type\'s outcome');
  await page.waitForFunction(() => !(document.getElementById('clipboard-menu') as HTMLDetailsElement).open, undefined, { timeout: 10_000 });

  // The "agent" closes the port: waiting again.
  await onSerial(page, 'exec 3>&-\n');
  await waitButton(page, (x) => x.state === 'waiting', 'the port closed');
  // A machine started with the permission granted: the host's clipboard goes to the guest once its agent says HELLO.
  await boot(page, 'clipboard=1');
  await openPort(page);
  assert.deepEqual((await guestReads(page, opening.reduce((n, f) => n + 5 + f.payload.length, 0))).map((f) => f.type), [FRAME.HELLO, FRAME.RESUME]);
  await guestWrites(page, HELLO);
  const [atHello] = await guestReads(page, offerSize(during));
  assert.equal(inline(atHello), during);

  // Copy the screen: a PNG of the framebuffer (640×480, the console's text on it) on the host's clipboard, no agent
  // needed (the port closed: waiting).
  await onSerial(page, 'exec 3>&-\n');
  await waitButton(page, (x) => x.state === 'waiting', 'the port closed again');
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

test("the Machines page's clipboard switch: off by default, its note; ticking it asks for the permission; the orphans' warning; saved", { timeout: 120_000 }, async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const asked: Question[] = [];
  await answerAsks(page, (q) => { asked.push(q); });
  await page.goto(`${base}/web/app/#machines`);
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
  assert.equal(await page.isChecked('.machines [data-field=clipboard]'), false);
  const note = await page.locator('.machines .check-field', { has: page.locator('[data-field=clipboard]') }).locator('.note').textContent();
  assert.equal(note?.replace(/\s+/g, ' ').trim(), plain(t('machines:DeviceSwitches.clipboard.note')).replace(/\s+/g, ' ').trim());
  assert.equal(await page.locator('.machines [data-clipboard-orphans]').count(), 0);
  // Ticking it is the click that asks: Chromium prompts (headless: denied at once).
  assert.equal(await readState(page), 'prompt');
  await page.check('.machines [data-field=clipboard]');
  for (let i = 0; (await readState(page)) !== 'denied'; i++) {
    if (i > 50) assert.fail(`ticking the switch didn't ask: the permission is ${await readState(page)}`);
    await page.waitForTimeout(100);
  }
  assert.equal(await page.textContent('.machines [data-clipboard-orphans]'), t('machines:DeviceSwitches.clipboard.orphans.on'));
  await page.click('.machines [data-action=save]');
  await page.waitForFunction(() => (document.querySelector('.machines [data-action=save]') as HTMLButtonElement).disabled, null, { polling: 100 });
  assert.ok(asked.some((q) => q.text === t('machines:machine-edit.orphans.confirm')), 'asked first');
  const saved = await page.evaluate(async () => {
    const { Store } = await import('/web/app/store.ts' as string);
    return (await (await Store.open()).get('machines', 'cccccccccccc')).clipboard;
  });
  assert.equal(saved, true);
  await page.click('.machines [data-tab=snapshots]');
  await page.locator('.machines', { hasText: t('machines:shape-diff.clipboard.hadNo') }).waitFor();
  // Off again: the warning says so; unticking asks nothing.
  await page.locator('.machines [data-selected] [data-tab=settings]').click();
  await page.uncheck('.machines [data-field=clipboard]');
  assert.equal(await page.textContent('.machines [data-clipboard-orphans]'), t('machines:DeviceSwitches.clipboard.orphans.off'));
  assert.deepEqual(errors, []);
  await context.close();
});
