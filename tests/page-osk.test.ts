// The on-screen keyboard and the Keys menu on the page (docs/frontend.md "The on-screen keyboard", "Keys the browser
// keeps"): what reaches the guest's keyboard port from clicks, a held key and two fingers chording; modifiers tapped
// and latched, released after the next key or (Preferences) when tapped again; the screen keeps the focus; the
// keyboard moved and resized, remembered; the menu's combinations and Hold Esc. The keyboard's port is kept on the
// page (the start message is intercepted) and the worker stopped at once, the guest's driver said to be up: nothing
// boots (scripts/ci.sh runs it). ~20 s.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { PAGE_QUERY } from './page-query.ts';

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

/** The page with its keyboard's port kept here, its worker stopped and the guest's keyboard driver said to be up. */
async function open() {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, hasTouch: true });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript(() => {
    const w = window as unknown as { __keys: number[][][]; __workers: Worker[] };
    w.__keys = [];
    w.__workers = [];
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, m: Record<string, unknown>, transfer: Transferable[]) {
      if (m?.type === 'start') {
        w.__workers.push(this);
        const port = m.keyboard as MessagePort;
        port.onmessage = (e: MessageEvent<number[][]>) => w.__keys.push(e.data);
        const stand = new MessageChannel().port2;
        m.keyboard = stand;
        transfer = transfer.map((x) => (x === port ? stand : x));
      }
      return post.call(this, m, transfer as unknown as StructuredSerializeOptions);
    } as typeof Worker.prototype.postMessage;
  });
  await load(page);
  return { context, page, errors };
}

/** Loads (or reloads) the page, stops its worker and says the guest's keyboard driver is up. */
async function load(page: Page) {
  await page.goto(`${base}/web/app/?${PAGE_QUERY}machine=buildroot&ncpus=1&view=screen`);
  await page.waitForFunction(() => (window as unknown as { __workers: Worker[] }).__workers.length > 0, null, { timeout: 30_000 });
  await page.evaluate(() => {
    const [worker] = (window as unknown as { __workers: Worker[] }).__workers;
    worker.terminate();
    worker.onmessage?.(new MessageEvent('message', { data: { type: 'keyboard', live: true } }));
    document.getElementById('boot')!.style.display = 'none';
  });
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
async function showOsk(page: Page) {
  await page.locator('#keys summary').click();
  await page.locator('#osk-toggle').click();
  await page.locator('#osk').waitFor();
  await page.locator('#screen').focus();
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
  const corner = (await page.locator('#osk .corner').boundingBox())!;
  await page.mouse.move(corner.x + 8, corner.y + 8);
  await page.mouse.down();
  await page.mouse.move(corner.x + 8 - 200, corner.y + 8, { steps: 5 });
  await page.mouse.up();
  const after = (await page.locator('#osk').boundingBox())!;
  assert.ok(Math.abs(after.x - (before.x - 100)) < 3 && Math.abs(after.y - (before.y - 120)) < 3, `moved: ${JSON.stringify([before, after])}`);
  assert.ok(Math.abs(after.width - (before.width - 200)) < 3 && after.height < before.height, `resized: ${JSON.stringify([before, after])}`);
  assert.equal(await keys(page).then((k) => k.length), 0, 'moving and resizing press no key');

  // The toggle mode, from Preferences: Ctrl stays down through C and V until clicked again.
  await page.locator('#machines-open').click();
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
