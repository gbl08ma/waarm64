// The screen's pointing devices on the page (docs/frontend.md "Mouse lock", "Touch"): a mouse's back and forward buttons
// are the guest's (BTN_SIDE, BTN_EXTRA) and the browser doesn't navigate; a second button pressed while one is held is
// pressed too; touches go to the touchscreen as multitouch slots; with the mouse lock on, a click takes the mouse, its
// motion goes to the relative mouse and the guest's cursor is drawn by the page; leaving a running machine asks first,
// unless Preferences says not to. The tablet's, mouse's and touchscreen's ports are kept on the page (the start message
// is intercepted) and the worker is stopped at once: nothing boots, so it takes no Debian lock (scripts/ci.sh runs it). ~15 s.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { unattendedQuery } from './debian-unattended.ts';
import { PAGE_QUERY } from './page-query.ts';

const IMAGE = new URL('../target/images/debian/disk.qcow2', import.meta.url);
const FIRMWARE = new URL('../target/images/edk2/QEMU_EFI.fd', import.meta.url);
const skip = (!existsSync(IMAGE) || !existsSync(FIRMWARE)) && 'SKIPPED: run images/build.sh debian edk2';

const EV_KEY = 1, EV_REL = 2, EV_ABS = 3;
type Events = Record<'tablet' | 'mouse' | 'touch', number[][][]>;

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

/** The page with a mouse and a touchscreen, its input ports kept here and its worker stopped (with `booting`, once the page says the machine boots: a moment on one vCPU). */
async function open(query = '', booting = false) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, hasTouch: true });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript(() => {
    const w = window as unknown as { __events: Events; __workers: Worker[]; __display?: MessagePort };
    w.__events = { tablet: [], mouse: [], touch: [] };
    w.__workers = [];
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, m: Record<string, unknown>, transfer: Transferable[]) {
      if (m?.type === 'start') {
        w.__workers.push(this);
        w.__display = m.display as MessagePort; // the device's end of the display port: the test posts the guest's cursor on it
        for (const k of ['tablet', 'mouse', 'touch', 'display'] as const) {
          const port = m[k] as MessagePort | undefined;
          if (!port) continue;
          if (k !== 'display') port.onmessage = (e: MessageEvent<number[][]>) => w.__events[k].push(e.data);
          const stand = new MessageChannel().port2;
          m[k] = stand;
          transfer = transfer.map((x) => (x === port ? stand : x));
        }
      }
      return post.call(this, m, transfer as unknown as StructuredSerializeOptions);
    } as typeof Worker.prototype.postMessage;
  });
  await page.goto(`${base}/web/app/?${PAGE_QUERY}ncpus=${booting ? 1 : 2}&view=screen&mouse=1&touch=1&${unattendedQuery()}${query}`);
  await page.waitForFunction(() => (window as unknown as { __workers: Worker[] }).__workers.length > 0, null, { timeout: 30_000 });
  if (booting) await page.waitForSelector('#state[data-state=booting], #state[data-state=running]', { state: 'attached', timeout: 30_000 });
  await page.evaluate(() => {
    (window as unknown as { __workers: Worker[] }).__workers.forEach((w) => w.terminate());
    document.getElementById('boot')!.style.display = 'none'; // the boot card covers the screen's middle
  });
  const cdp = await context.newCDPSession(page);
  const box = (await page.locator('#screen').boundingBox())!;
  const at = (fx: number, fy: number) => ({ x: Math.round(box.x + box.width * fx), y: Math.round(box.y + box.height * fy) });
  return { context, page, errors, cdp, at };
}

const events = (page: Page) => page.evaluate(() => (window as unknown as { __events: Events }).__events);
const clear = (page: Page) => page.evaluate(() => { const e = (window as unknown as { __events: Events }).__events; e.tablet = []; e.mouse = []; e.touch = []; });
/** The [type, code, value] events of `frames` that aren't EV_SYN. */
const flat = (frames: number[][][]) => frames.flat().filter((e) => e[0] !== 0);
const keys = (frames: number[][][]) => flat(frames).filter((e) => e[0] === EV_KEY);

test("a mouse's buttons: back and forward are the guest's, a second button held with the first is pressed", { skip, timeout: 120_000 }, async () => {
  const { context, page, errors, cdp, at } = await open();
  const url = page.url();
  const p = at(0.25, 0.25);
  const mouse = (type: 'mousePressed' | 'mouseReleased', button: 'left' | 'right' | 'back' | 'forward', buttons: number) => cdp.send('Input.dispatchMouseEvent', { type, ...p, button, buttons, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p });
  await mouse('mousePressed', 'back', 8);
  await mouse('mouseReleased', 'back', 0);
  await mouse('mousePressed', 'forward', 16);
  await mouse('mouseReleased', 'forward', 0);
  // Left, then right while left is held (a pointermove for the page), released in turn.
  await mouse('mousePressed', 'left', 1);
  await mouse('mousePressed', 'right', 3);
  await mouse('mouseReleased', 'left', 2);
  await mouse('mouseReleased', 'right', 0);
  await page.waitForTimeout(500);
  assert.equal(page.url(), url, "the back and forward buttons didn't navigate");
  const e = await events(page);
  assert.deepEqual(keys(e.tablet), [[EV_KEY, 0x113, 1], [EV_KEY, 0x113, 0], [EV_KEY, 0x114, 1], [EV_KEY, 0x114, 0], [EV_KEY, 0x110, 1], [EV_KEY, 0x111, 1], [EV_KEY, 0x110, 0], [EV_KEY, 0x111, 0]]);
  assert.ok(flat(e.tablet).some((x) => x[0] === EV_ABS && x[1] === 0 && Math.abs(x[2] - 8192) < 200), 'the tablet is where the pointer is');
  assert.deepEqual([e.mouse.length, e.touch.length], [0, 0], 'without the lock the mouse is the tablet');
  assert.deepEqual(errors, []);
  await context.close();
});

test('touches go to the touchscreen, one slot each', { skip, timeout: 120_000 }, async () => {
  const { context, page, errors, cdp, at } = await open();
  const [a, b] = [at(0.25, 0.5), at(0.75, 0.5)];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...a, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...a, id: 1 }, { ...b, id: 2 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...a, id: 1 }, { x: b.x, y: b.y + 40, id: 2 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ ...a, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(500);
  const e = await events(page);
  assert.equal(e.tablet.length, 0, 'touches are not the tablet');
  const ev = flat(e.touch);
  const slots = ev.filter((x) => x[0] === EV_ABS && x[1] === 0x2f).map((x) => x[2]);
  assert.deepEqual([...new Set(slots)].sort(), [0, 1], `two slots: ${JSON.stringify(ev)}`);
  const ids = ev.filter((x) => x[0] === EV_ABS && x[1] === 0x39).map((x) => x[2]);
  assert.deepEqual(ids, [0, 1, -1, -1], 'two contacts, each lifted');
  assert.deepEqual(ev.filter((x) => x[0] === EV_KEY), [[EV_KEY, 0x14a, 1], [EV_KEY, 0x14a, 0]], 'BTN_TOUCH from the first finger down to the last up');
  const xs = ev.filter((x) => x[0] === EV_ABS && x[1] === 0x35).map((x) => x[2]);
  assert.ok(Math.abs(xs[0] - 8192) < 200 && Math.abs(xs[1] - 24575) < 200, `positions across the screen: ${xs}`);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the mouse lock: a click takes the mouse, its motion goes to the mouse, the page draws the guest cursor', { skip, timeout: 120_000 }, async () => {
  const { context, page, errors, cdp, at } = await open();
  await page.click('#mouse-lock');
  assert.equal(await page.getAttribute('#mouse-lock', 'aria-pressed'), 'true');
  const p = at(0.5, 0.5);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', buttons: 1, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: 'left', buttons: 0, clickCount: 1 });
  await page.waitForFunction(() => document.pointerLockElement?.id === 'screen', null, { timeout: 5000 });
  await clear(page);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x + 30, y: p.y - 20 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x + 30, y: p.y - 20, button: 'right', buttons: 2, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x + 30, y: p.y - 20, button: 'right', buttons: 0, clickCount: 1 });
  await page.waitForTimeout(300);
  let e = await events(page);
  assert.equal(e.tablet.length, 0, 'locked, the tablet is still');
  const rel = flat(e.mouse).filter((x) => x[0] === EV_REL);
  assert.ok(rel.length > 0 && rel.every((x) => x[1] === 0 || x[1] === 1), `relative motion: ${JSON.stringify(rel)}`);
  assert.deepEqual(keys(e.mouse), [[EV_KEY, 0x111, 1], [EV_KEY, 0x111, 0]], "the click that took the mouse wasn't the guest's; the next one is the mouse's");
  // The guest's cursor, drawn where the guest says.
  const lock = page.locator('#screen-cursor');
  await page.evaluate(() => {
    const d = (window as unknown as { __display: MessagePort }).__display;
    d.postMessage({ type: 'cursor', image: new Uint8Array(64 * 64 * 4).fill(255).buffer, hotX: 0, hotY: 0, x: 100, y: 50 });
    d.postMessage({ type: 'cursor-at', x: 120, y: 60 });
  });
  await page.waitForFunction(() => /translate\(/.test(document.getElementById('screen-cursor')!.style.transform), null, { timeout: 5000 });
  assert.equal(await lock.isVisible(), true, 'drawn while locked');
  const { transform, k } = await page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('#screen')!;
    return { transform: document.getElementById('screen-cursor')!.style.transform, k: c.clientWidth / c.width };
  });
  const [tx, ty] = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(transform)!.slice(1).map(Number);
  assert.ok(Math.abs(tx - 120 * k) < 0.01 && Math.abs(ty - 60 * k) < 0.01, `at the guest's position: ${transform} (scale ${k})`);
  // Turning the lock off lets go of the mouse; the pointer is the tablet's again.
  await page.evaluate(() => document.getElementById('mouse-lock')!.click());
  await page.waitForFunction(() => document.pointerLockElement === null, null, { timeout: 5000 });
  assert.equal(await lock.isVisible(), false, 'hidden once let go');
  await clear(page);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at(0.25, 0.25) });
  await page.waitForTimeout(300);
  e = await events(page);
  assert.ok(e.tablet.length > 0 && e.mouse.length === 0, 'unlocked, the tablet again');
  assert.deepEqual(errors, []);
  await context.close();
});

test('leaving a running machine asks first, unless Preferences says not to', { skip, timeout: 120_000 }, async () => {
  const { context, page, errors, at } = await open('&leavewarning=1', true);
  assert.ok(['booting', 'running'].includes((await page.getAttribute('#state', 'data-state'))!), 'the page thinks it runs');
  await page.mouse.click(at(0.5, 0.5).x, at(0.5, 0.5).y); // the browser asks only on a page the user has used
  const asked: string[] = [];
  page.on('dialog', (d) => { asked.push(d.type()); void d.dismiss(); });
  await page.reload({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(300);
  assert.deepEqual(asked, ['beforeunload'], 'asked, and stayed');
  // Preferences, on the Machines page: turned off, it doesn't ask.
  await page.click('#machines-open');
  await page.click(`[data-machine=preferences]`);
  const box = page.locator('[data-field=leave-warning]');
  assert.equal(await box.isChecked(), true, 'on by default');
  await box.uncheck();
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('webpc.settings')!).leaveWarning), false);
  await page.reload({ timeout: 30_000 });
  assert.deepEqual(asked, ['beforeunload'], 'not asked again');
  assert.deepEqual(errors, []);
  await context.close();
});
