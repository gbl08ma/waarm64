// The on-screen keyboard and the Keys menu on the page (docs/frontend.md "The on-screen keyboard", "Keys the browser
// keeps"): what reaches the guest's keyboard port from clicks, a held key and two fingers chording; modifiers tapped
// and latched, released after the next key or (Preferences) when tapped again; the screen keeps the focus; the
// keyboard moved and resized, remembered (an older page's place too); the menu's combinations and Hold Esc. The keyboard's port is kept on the
// page (the start message is intercepted) and the worker stopped at once, the guest's driver said to be up: nothing
// boots (scripts/ci.sh runs it). ~20 s.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { PAGE_QUERY } from './page-query.ts';
import { t } from '../web/i18n.ts';
import { openHome } from './page-home.ts';

const IMAGES = new URL('../target/images/', import.meta.url);
const skip = !(existsSync(new URL('buildroot/rootfs.ext4', IMAGES)) && existsSync(new URL('linux/Image', IMAGES))) && 'SKIPPED: run images/build.sh';

const EV_KEY = 1;
// Linux keycodes (input-event-codes.h).
const K = { Esc: 1, W: 17, Ctrl: 29, A: 30, Shift: 42, C: 46, V: 47, Alt: 56, F1: 59 };

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

/** The page with its keyboard's, tablet's and serial console's ports kept here, its worker stopped and (`live`) the guest's keyboard driver said to be up. */
async function open(live = true, viewport = { width: 1400, height: 900 }, query = '') {
  const context = await browser.newContext({ viewport, hasTouch: true });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript(() => {
    const w = window as unknown as { __keys: number[][][]; __tablet: number[][][]; __serial: string[]; __workers: Worker[]; __ports: Record<string, MessagePort> };
    w.__ports = {};
    [w.__keys, w.__tablet, w.__serial, w.__workers] = [[], [], [], []];
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, m: Record<string, unknown>, transfer: Transferable[]) {
      if (m?.type === 'start') {
        w.__workers.push(this);
        const ports = m.ports as Record<string, MessagePort>; // the start's `MachinePorts`
        for (const [k, into] of [['keyboard', w.__keys], ['tablet', w.__tablet], ['serial', w.__serial]] as const) {
          const port = ports[k];
          port.onmessage = (e: MessageEvent) => (into as unknown[]).push(e.data);
          w.__ports[k] = port; // the device's end: the test speaks as the guest's device on it
          const stand = new MessageChannel().port2;
          ports[k] = stand;
          transfer = transfer.map((x) => (x === port ? stand : x));
        }
      }
      return post.call(this, m, transfer as unknown as StructuredSerializeOptions);
    } as typeof Worker.prototype.postMessage;
  });
  await load(page, live, query);
  return { context, page, errors };
}

/** Loads (or reloads) the page, stops its worker and says the guest's keyboard driver is up. */
async function load(page: Page, live = true, query = '') {
  await page.goto(`${base}/web/app/?${PAGE_QUERY}machine=buildroot&ncpus=1&view=screen${query}`);
  await page.waitForFunction(() => (window as unknown as { __workers: Worker[] }).__workers.length > 0, null, { timeout: 30_000 });
  await page.evaluate((live) => {
    const [worker] = (window as unknown as { __workers: Worker[] }).__workers;
    worker.terminate();
    if (live) worker.onmessage?.(new MessageEvent('message', { data: { type: 'keyboard', live: true } }));
    document.getElementById('boot')!.style.display = 'none';
  }, live);
  await page.locator('#screen').focus();
}

/** The key events the guest got since the last call: `+code` down, `-code` up. */
async function keys(page: Page): Promise<string[]> {
  const frames = await page.evaluate(() => (window as unknown as { __keys: number[][][] }).__keys.splice(0));
  return frames.flat().filter((e) => e[0] === EV_KEY).map((e) => `${e[2] ? '+' : '-'}${e[1]}`);
}
const ev = (...codes: [number, boolean][]) => codes.map(([c, d]) => `${d ? '+' : '-'}${c}`);
/** Waits until the guest has `n` key events (the port's messages are asynchronous). */
const settle = (page: Page, n: number) => page.waitForFunction((n) => (window as unknown as { __keys: number[][][] }).__keys.flat().filter((e) => e[0] === 1).length >= n, n, { timeout: 5000 });
const key = (page: Page, code: string) => page.locator(`#osk [data-code=${code}]`);
const focused = (page: Page) => page.evaluate(() => document.activeElement?.id);
/** Shows the on-screen keyboard from the Keys menu: the screen has the focus again. */
async function showOsk(page: Page) {
  await page.locator('#keys summary').click();
  await page.locator('#osk-toggle').click();
  await page.locator('#osk').waitFor();
  assert.equal(await focused(page), 'screen');
}

test('the on-screen keyboard: clicks, a held key, latched modifiers, two fingers; the screen keeps the focus', { skip, timeout: 120_000 }, async () => {
  const { context, page, errors } = await open();
  await showOsk(page);

  // A click: down, up.
  await key(page, 'KeyA').click();
  await settle(page, 2);
  assert.deepEqual(await keys(page), ev([K.A, true], [K.A, false]));
  assert.equal(await focused(page), 'screen');

  // Held with the mouse: down until the button is let go.
  const a = (await key(page, 'KeyA').boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await settle(page, 1);
  await page.waitForTimeout(700);
  assert.deepEqual(await keys(page), ev([K.A, true]));
  assert.equal(await key(page, 'KeyA').getAttribute('data-state'), 'held');
  await page.mouse.up();
  await settle(page, 1);
  assert.deepEqual(await keys(page), ev([K.A, false]));

  // Ctrl, Alt, F1 by clicks: Ctrl+Alt+F1, the modifiers let go after F1.
  await key(page, 'ControlLeft').click();
  await key(page, 'AltLeft').click();
  assert.equal(await key(page, 'ControlLeft').getAttribute('data-state'), 'latched');
  await key(page, 'F1').click();
  await settle(page, 6);
  assert.deepEqual(await keys(page), ev([K.Ctrl, true], [K.Alt, true], [K.F1, true], [K.F1, false], [K.Alt, false], [K.Ctrl, false]));
  assert.equal(await key(page, 'ControlLeft').getAttribute('data-state'), null);
  // Ctrl clicked twice: deselected.
  await key(page, 'ControlLeft').click();
  await key(page, 'ControlLeft').click();
  await settle(page, 2);
  assert.deepEqual(await keys(page), ev([K.Ctrl, true], [K.Ctrl, false]));

  // Two fingers: Shift held, A pressed, Shift lifted first, then A, as the touches go.
  const cdp = await context.newCDPSession(page);
  const centre = async (code: string) => { const b = (await key(page, code).boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
  const [shift, akey] = [await centre('ShiftLeft'), await centre('KeyA')];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...shift, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...shift, id: 1 }, { ...akey, id: 2 }] });
  await settle(page, 2);
  assert.deepEqual(await keys(page), ev([K.Shift, true], [K.A, true]));
  // A touchEnd's points are those that lift.
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ ...shift, id: 1 }] });
  await settle(page, 1);
  assert.deepEqual(await keys(page), ev([K.Shift, false]), 'Shift, held with A, released when its finger lifts');
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ ...akey, id: 2 }] });
  await settle(page, 1);
  assert.deepEqual(await keys(page), ev([K.A, false]));
  assert.equal(await focused(page), 'screen');

  // The screen losing the focus releases what the keyboard latched (the guest's keys go up; the keyboard forgets them).
  await key(page, 'ShiftLeft').click();
  await settle(page, 1);
  await keys(page);
  await page.locator('#machine').click();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await settle(page, 1);
  assert.deepEqual(await keys(page), ev([K.Shift, false]));
  assert.equal(await key(page, 'ShiftLeft').getAttribute('data-state'), null);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the on-screen keyboard moved and resized, remembered; Preferences keeps modifiers until clicked again', { skip, timeout: 120_000 }, async () => {
  const { context, page, errors } = await open();
  await showOsk(page);
  const before = (await page.locator('#osk').boundingBox())!;
  const bar = (await page.locator('#osk .bar').boundingBox())!;
  await page.mouse.move(bar.x + 40, bar.y + bar.height / 2);
  await page.mouse.down();
  await page.mouse.move(bar.x + 40 - 100, bar.y + bar.height / 2 - 120, { steps: 5 });
  await page.mouse.up();
  const grip = (await page.locator('#osk .grip').boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 - 200, grip.y + grip.height / 2, { steps: 5 });
  await page.mouse.up();
  const after = (await page.locator('#osk').boundingBox())!;
  assert.ok(Math.abs(after.x - (before.x - 100)) < 3 && Math.abs(after.y - (before.y - 120)) < 3, `moved: ${JSON.stringify([before, after])}`);
  assert.ok(Math.abs(after.width - (before.width - 200)) < 3 && after.height < before.height, `resized: ${JSON.stringify([before, after])}`);
  assert.equal(await keys(page).then((k) => k.length), 0, 'moving and resizing press no key');

  // The toggle mode, from Preferences: Ctrl stays down through C and V until clicked again.
  await openHome(page);
  await page.locator('[data-machine=preferences]').click();
  await page.locator('[data-field=osk-toggle]').check();
  await page.locator('[data-action=back]').click();
  await page.locator('#osk').waitFor();
  await page.locator('#screen').focus();
  await key(page, 'ControlLeft').click();
  await key(page, 'KeyC').click();
  await key(page, 'KeyV').click();
  await settle(page, 5);
  assert.deepEqual(await keys(page), ev([K.Ctrl, true], [K.C, true], [K.C, false], [K.V, true], [K.V, false]));
  await key(page, 'ControlLeft').click();
  await settle(page, 1);
  assert.deepEqual(await keys(page), ev([K.Ctrl, false]));

  // Remembered: where it is and how big.
  await load(page);
  await showOsk(page);
  const kept = (await page.locator('#osk').boundingBox())!;
  assert.ok(Math.abs(kept.x - after.x) < 3 && Math.abs(kept.y - after.y) < 3 && Math.abs(kept.width - after.width) < 3, `kept: ${JSON.stringify([after, kept])}`);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the on-screen keyboard\'s place as an older page remembered it (`osk`): it comes back there, moved to the windows\' places', { skip, timeout: 120_000 }, async () => {
  const { context, page, errors } = await open();
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('waarm64.settings') ?? '{}');
    localStorage.setItem('waarm64.settings', JSON.stringify({ ...s, osk: { x: 100, y: 50, w: 700, wc: 300, layout: 'compact' } }));
  });
  await load(page);
  await showOsk(page);
  const osk = page.locator('#osk');
  let b = (await osk.boundingBox())!;
  assert.equal(await osk.getAttribute('data-layout'), 'compact', 'the forced layout');
  assert.ok(Math.abs(b.x - 100) < 1 && Math.abs(b.y - 50) < 1 && Math.abs(b.width - 300) < 1, `where it was: ${JSON.stringify(b)}`);
  const s = await page.evaluate(() => JSON.parse(localStorage.getItem('waarm64.settings') ?? '{}'));
  assert.equal(s.osk, undefined, 'the old place dropped');
  assert.equal(s.oskLayout, 'compact');
  assert.deepEqual([s.windows.osk.x, s.windows.osk.y, s.windows.osk.sizes.full.w, s.windows.osk.sizes.compact.w], [100, 50, 700, 300]);
  // The full layout: its own width.
  await page.locator('#osk .layout').click();
  b = (await osk.boundingBox())!;
  assert.ok(Math.abs(b.x - 100) < 1 && Math.abs(b.width - 700) < 1, `the full layout's width: ${JSON.stringify(b)}`);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the compact layout at a phone\'s width: pages by tabs, a latch and a held key across them; the bar\'s button forces the full one until the width crosses', { skip, timeout: 120_000 }, async () => {
  const { context, page, errors } = await open(true, { width: 390, height: 844 });
  await showOsk(page);
  const layout = () => page.locator('#osk').getAttribute('data-layout');
  assert.equal(await layout(), 'compact');
  assert.equal(await page.locator('#osk .title').isVisible(), false, 'no room for the title beside the tabs');
  assert.equal(await key(page, 'F1').count(), 0, 'the letters\' page first');
  await key(page, 'KeyA').click();
  await settle(page, 2);
  assert.deepEqual(await keys(page), ev([K.A, true], [K.A, false]));

  // Ctrl latched on the letters' page, F1 on the F keys' page: Ctrl+F1.
  await key(page, 'ControlLeft').click();
  await page.locator('#osk [data-page=fn]').click();
  assert.equal(await key(page, 'KeyA').count(), 0);
  assert.equal(await key(page, 'ControlLeft').getAttribute('data-state'), 'latched', 'the latch shows on the other page');
  await key(page, 'F1').click();
  await settle(page, 4);
  assert.deepEqual(await keys(page), ev([K.Ctrl, true], [K.F1, true], [K.F1, false], [K.Ctrl, false]));
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'screen');

  // A key held while the page changes under it: let go when its pointer lifts, its key gone.
  await page.locator('#osk [data-page=main]').click();
  const a = (await key(page, 'KeyA').boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await settle(page, 1);
  await page.locator('#osk [data-page=keypad]').dispatchEvent('click');
  await key(page, 'Numpad5').waitFor();
  await page.mouse.up();
  await settle(page, 2);
  assert.deepEqual(await keys(page), ev([K.A, true], [K.A, false]));

  // The bar's button: the full keyboard, remembered; a wide window then a narrow one again: compact on its own.
  await page.locator('#osk .layout').click();
  assert.equal(await layout(), 'full');
  assert.equal(await key(page, 'F1').count(), 1);
  await load(page);
  await showOsk(page);
  assert.equal(await layout(), 'full', 'forced, remembered');
  await page.setViewportSize({ width: 1400, height: 900 });
  // The wide window seen: the forced layout is the automatic one there, so it's dropped.
  await page.waitForFunction(() => !JSON.parse(localStorage.getItem('waarm64.settings') ?? '{}').oskLayout);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector('#osk')?.getAttribute('data-layout') === 'compact');
  // Forced compact in a wide window.
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForFunction(() => document.querySelector('#osk')?.getAttribute('data-layout') === 'full');
  assert.equal(await page.locator('#osk .title').isVisible(), true, 'the full keyboard\'s title');
  await page.locator('#osk .layout').click();
  assert.equal(await layout(), 'compact');
  assert.equal(await keys(page).then((k) => k.length), 0, 'switching presses no key');
  assert.deepEqual(errors, []);
  await context.close();
});

test('the Keys menu: Ctrl+W and Esc sent, Hold Esc held for seconds', { skip, timeout: 120_000 }, async () => {
  const { context, page, errors } = await open();
  await page.locator('#keys summary').click();
  await page.locator('[data-chord="ControlLeft KeyW"]').click();
  await settle(page, 4);
  assert.deepEqual(await keys(page), ev([K.Ctrl, true], [K.W, true], [K.W, false], [K.Ctrl, false]));
  await page.locator('#keys summary').click();
  await page.locator('[data-chord=Escape]').click();
  await settle(page, 2);
  assert.deepEqual(await keys(page), ev([K.Esc, true], [K.Esc, false]));
  await page.locator('#keys summary').click();
  const t0 = Date.now();
  await page.locator('#hold-esc').click();
  await settle(page, 1);
  assert.deepEqual(await keys(page), ev([K.Esc, true]));
  await settle(page, 1);
  const held = Date.now() - t0;
  assert.deepEqual(await keys(page), ev([K.Esc, false]));
  assert.ok(held >= 2500, `held ${held} ms`);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the on-screen keyboard beside the screen\'s own keys and fingers: each holds its own; a typed key ends a latch; a driver coming up releases', { skip, timeout: 120_000 }, async () => {
  const { context, page, errors } = await open();
  await showOsk(page);
  // Shift latched on the keyboard, the physical Shift pressed and let go: the guest's Shift stays down for the next key.
  await key(page, 'ShiftLeft').click();
  await page.keyboard.down('Shift');
  await page.keyboard.up('Shift');
  await key(page, 'KeyA').click();
  await settle(page, 4);
  assert.deepEqual(await keys(page), ev([K.Shift, true], [K.A, true], [K.A, false], [K.Shift, false]));
  // Ctrl latched, C typed on the physical keyboard: Ctrl+C, then Ctrl let go.
  await key(page, 'ControlLeft').click();
  await page.keyboard.press('KeyC');
  await settle(page, 4);
  assert.deepEqual(await keys(page), ev([K.Ctrl, true], [K.C, true], [K.C, false], [K.Ctrl, false]));
  assert.equal(await key(page, 'ControlLeft').getAttribute('data-state'), null);

  // A finger holding Shift on the keyboard, another tapping the screen (no touchscreen): the tablet's click.
  const cdp = await context.newCDPSession(page);
  const sb = (await key(page, 'ShiftLeft').boundingBox())!;
  const shift = { x: sb.x + sb.width / 2, y: sb.y + sb.height / 2 };
  const sc = (await page.locator('#screen').boundingBox())!;
  const screen = { x: sc.x + sc.width / 4, y: sc.y + sc.height / 4 };
  await page.evaluate(() => { (window as unknown as { __tablet: unknown[] }).__tablet.length = 0; });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...shift, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...shift, id: 1 }, { ...screen, id: 2 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ ...screen, id: 2 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ ...shift, id: 1 }] });
  await settle(page, 2);
  const tablet = await page.evaluate(() => (window as unknown as { __tablet: number[][][] }).__tablet.flat().filter((e) => e[0] === 1).map((e) => `${e[2] ? '+' : '-'}${e[1]}`));
  assert.deepEqual(tablet, ['+272', '-272'], 'the screen\'s finger clicks');
  assert.deepEqual(await keys(page), ev([K.Shift, true], [K.Shift, false]));

  // The guest's keyboard driver going away (a reboot to the firmware) releases what the keyboard latched.
  await key(page, 'ShiftLeft').click();
  await settle(page, 1);
  await keys(page);
  await page.evaluate(() => (window as unknown as { __workers: Worker[] }).__workers[0].onmessage?.(new MessageEvent('message', { data: { type: 'keyboard', live: false } })));
  await settle(page, 1);
  assert.deepEqual(await keys(page), ev([K.Shift, false]));
  assert.equal(await key(page, 'ShiftLeft').getAttribute('data-state'), null);
  assert.deepEqual(errors, []);
  await context.close();
});

test('before the guest has a keyboard driver: the keyboard and the Keys menu type into the serial console', { skip, timeout: 120_000 }, async () => {
  const { context, page, errors } = await open(false);
  const serial = async (n: number) => {
    await page.waitForFunction((n) => (window as unknown as { __serial: string[] }).__serial.join('').length >= n, n, { timeout: 5000 });
    return page.evaluate(() => (window as unknown as { __serial: string[] }).__serial.splice(0).join(''));
  };
  await showOsk(page);
  await key(page, 'ShiftLeft').click();
  await key(page, 'KeyA').click();
  await key(page, 'KeyB').click();
  assert.equal(await serial(2), 'Ab');
  await key(page, 'ControlLeft').click();
  await key(page, 'KeyC').click();
  assert.equal(await serial(1), '\x03');
  await page.locator('#keys summary').click();
  await page.locator('[data-chord=Escape]').click();
  assert.equal(await serial(1), '\x1b');
  await page.locator('#keys summary').click();
  await page.locator('[data-chord="ControlLeft KeyW"]').click();
  assert.equal(await serial(1), '\x17');
  assert.deepEqual(await keys(page), [], 'nothing to the keyboard without its driver');
  assert.deepEqual(errors, []);
  await context.close();
});

/** The serial console's input since the last call, once it has `n` characters. */
async function serialIn(page: Page, n: number) {
  await page.waitForFunction((n) => (window as unknown as { __serial: string[] }).__serial.join('').length >= n, n, { timeout: 5000 });
  return page.evaluate(() => (window as unknown as { __serial: string[] }).__serial.splice(0).join(''));
}
const terminalFocused = (page: Page) => page.evaluate(() => document.activeElement === document.querySelector('#terminal textarea'));

test('the terminal\'s view: the keys go to the serial console as its typing does, the terminal keeps the focus; a held key repeats there', { skip, timeout: 120_000 }, async () => {
  const { context, page, errors } = await open();
  await page.locator('[data-view-button=terminal]').click();
  assert.ok(await terminalFocused(page));
  await page.locator('#keys summary').click();
  await page.locator('#osk-toggle').click();
  await page.locator('#osk').waitFor();
  assert.ok(await terminalFocused(page), 'the terminal keeps the focus');
  await key(page, 'ShiftLeft').click();
  await key(page, 'KeyA').click();
  await key(page, 'KeyB').click();
  await key(page, 'ControlLeft').click();
  await key(page, 'KeyC').click();
  await key(page, 'ArrowUp').click();
  assert.equal(await serialIn(page, 6), 'Ab\x03\x1b[A');
  assert.ok(await terminalFocused(page));
  // Held: the key, then its repeats (500 ms, then ~30 a second).
  const a = (await key(page, 'KeyA').boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(900);
  await page.mouse.up();
  const held = await serialIn(page, 4);
  assert.match(held, /^a{4,}$/, `held: ${JSON.stringify(held)}`);
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => (window as unknown as { __serial: string[] }).__serial.length), 0, 'no repeat after the release');
  // Both views, the screen clicked: the keys go to the screen's keyboard again.
  await page.locator('[data-view-button=both]').click();
  await page.locator('#screen').focus();
  await key(page, 'KeyA').click();
  await settle(page, 2);
  assert.deepEqual(await keys(page), ev([K.A, true], [K.A, false]));
  assert.deepEqual(errors, []);
  await context.close();
});

test('before the guest has a keyboard driver, a held key repeats on the serial console; with it, the guest\'s kernel repeats', { skip, timeout: 120_000 }, async () => {
  const { context, page, errors } = await open(false);
  await showOsk(page);
  const hold = async (ms: number) => {
    const b = (await key(page, 'KeyB').boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(ms);
    await page.mouse.up();
  };
  await hold(900);
  assert.match(await serialIn(page, 4), /^b{4,}$/);
  // The driver up: one down and one up to the keyboard, whatever the hold.
  await page.evaluate(() => (window as unknown as { __workers: Worker[] }).__workers[0].onmessage?.(new MessageEvent('message', { data: { type: 'keyboard', live: true } })));
  await hold(900);
  await settle(page, 2);
  await page.waitForTimeout(100);
  assert.deepEqual(await keys(page), ev([48, true], [48, false]));
  assert.deepEqual(errors, []);
  await context.close();
});

test('the machine\'s keyboard layout: German legends and ISO\'s key, its characters and AltGr\'s on the serial console', { skip, timeout: 120_000 }, async () => {
  const { context, page, errors } = await open(false, undefined, '&keyboard=de');
  await showOsk(page);
  assert.equal(await key(page, 'KeyY').locator('.main').textContent(), 'Z');
  assert.equal(await key(page, 'Semicolon').locator('.main').textContent(), 'Ö');
  assert.equal(await key(page, 'KeyQ').locator('.alt').textContent(), '@');
  assert.equal(await key(page, 'IntlBackslash').count(), 1, 'ISO\'s key beside the left Shift');
  await key(page, 'KeyY').click();
  await key(page, 'Semicolon').click();
  await key(page, 'IntlBackslash').click();
  await key(page, 'AltRight').click();
  await key(page, 'KeyQ').click();
  assert.equal(await serialIn(page, 4), 'zö<@');
  assert.deepEqual(errors, []);
  await context.close();
});

test('a layout\'s compact letters\' page: German\'s Ü, Ö and Ä beside the letters; JIS\'s input-method keys to the guest', { skip, timeout: 120_000 }, async () => {
  const de = await open(true, { width: 390, height: 844 }, '&keyboard=de');
  await showOsk(de.page);
  assert.equal(await de.page.locator('#osk').getAttribute('data-layout'), 'compact');
  for (const [code, main] of [['BracketLeft', 'Ü'], ['Semicolon', 'Ö'], ['Quote', 'Ä']]) assert.equal(await key(de.page, code).locator('.main').textContent(), main, code);
  await key(de.page, 'Quote').click();
  await settle(de.page, 2);
  assert.deepEqual(await keys(de.page), ev([40, true], [40, false]));
  await de.page.locator('#osk [data-page=symbols]').click();
  assert.equal(await key(de.page, 'Quote').count(), 0, 'not on the symbols\' page too');
  assert.equal(await key(de.page, 'Minus').count(), 1);
  assert.deepEqual(de.errors, []);
  await de.context.close();

  // JIS: Muhenkan, Henkan, Katakana/Hiragana beside Space, their keycodes (KEY_MUHENKAN, KEY_HENKAN, KEY_KATAKANAHIRAGANA).
  const jp = await open(true, undefined, '&keyboard=jp');
  await showOsk(jp.page);
  assert.equal(await key(jp.page, 'NonConvert').locator('.main').textContent(), t('osk:Osk.key.NonConvert'));
  for (const code of ['NonConvert', 'Convert', 'KanaMode']) await key(jp.page, code).click();
  await settle(jp.page, 6);
  assert.deepEqual(await keys(jp.page), ev([94, true], [94, false], [92, true], [92, false], [93, true], [93, false]));
  assert.deepEqual(jp.errors, []);
  await jp.context.close();
});

test('the lock keys show the guest\'s LEDs: the virtio keyboard\'s with its driver, the built-in USB one\'s before', { skip, timeout: 120_000 }, async () => {
  const { context, page, errors } = await open();
  await showOsk(page);
  const led = (code: string) => key(page, code).getAttribute('data-led');
  /** The guest's keyboard driver sets LED `code` (0 Num, 1 Caps, 2 Scroll Lock): a virtio-input status event. */
  const status = (code: number, value: number) => page.evaluate(([c, v]) => (window as unknown as { __ports: Record<string, MessagePort> }).__ports.keyboard.postMessage([0x11, c, v]), [code, value]);
  const shows = (code: string, on: boolean) => page.waitForFunction(([c, on]) => (document.querySelector(`#osk [data-code=${c}]`)?.getAttribute('data-led') === 'on') === on, [code, on] as const, { timeout: 5000 });
  assert.equal(await led('CapsLock'), 'off');
  assert.equal(await led('KeyA'), null, 'only the lock keys have one');
  await status(1, 1);
  await shows('CapsLock', true);
  await status(0, 1);
  await shows('NumLock', true);
  assert.equal(await led('ScrollLock'), 'off');
  await status(1, 0);
  await shows('CapsLock', false);
  assert.equal(await led('NumLock'), 'on');
  // The driver gone (the firmware's turn): the built-in USB keyboard's LEDs, none set on this machine.
  await page.evaluate(() => (window as unknown as { __workers: Worker[] }).__workers[0].onmessage?.(new MessageEvent('message', { data: { type: 'keyboard', live: false } })));
  await shows('NumLock', false);
  // Back: the virtio keyboard's, as the guest left them.
  await page.evaluate(() => (window as unknown as { __workers: Worker[] }).__workers[0].onmessage?.(new MessageEvent('message', { data: { type: 'keyboard', live: true } })));
  await shows('NumLock', true);
  assert.deepEqual(errors, []);
  await context.close();
});
