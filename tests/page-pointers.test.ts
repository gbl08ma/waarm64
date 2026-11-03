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

/** The page with `devices` (a mouse and a touchscreen), its input ports kept here and its worker stopped (with `booting`, once the page says the machine boots: a moment on one vCPU). */
async function open(query = '', booting = false, devices = 'mouse=1&touch=1') {
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
  await page.goto(`${base}/web/app/?${PAGE_QUERY}ncpus=${booting ? 1 : 2}&view=screen&${devices}&${unattendedQuery()}${query}`);
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

test("without a touchscreen the first finger is the tablet's and its left button; another finger is dropped", { skip, timeout: 120_000 }, async () => {
  const { context, page, errors, cdp, at } = await open('', false, 'mouse=1');
  const [a, b] = [at(0.25, 0.5), at(0.75, 0.5)];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...a, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...a, id: 1 }, { ...b, id: 2 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...a, id: 1 }, { x: b.x, y: b.y + 40, id: 2 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ ...a, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: a.x, y: a.y + 40, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(500);
  const e = await events(page);
  assert.deepEqual([e.touch.length, e.mouse.length], [0, 0]);
  assert.deepEqual(keys(e.tablet), [[EV_KEY, 0x110, 1], [EV_KEY, 0x110, 0]], 'one press, held until the first finger lifts');
  const xs = flat(e.tablet).filter((x) => x[0] === EV_ABS && x[1] === 0).map((x) => x[2]);
  assert.ok(xs.length && xs.every((x) => Math.abs(x - 8192) < 200), `the tablet stays with the first finger: ${xs}`);
  assert.deepEqual(errors, []);
  await context.close();
});

test("the wheel: a mouse's notch is one, a touchpad's small steps add up to notches", { skip, timeout: 120_000 }, async () => {
  const { context, page, errors, at } = await open();
  const p = at(0.5, 0.5);
  await page.mouse.move(p.x, p.y);
  await page.mouse.wheel(0, 100); // a notch down: REL_WHEEL -1
  await page.mouse.wheel(0, -100);
  for (let i = 0; i < 10; i++) await page.mouse.wheel(0, 10); // 100 px in small steps: two notches
  await page.mouse.wheel(0, 30);
  await page.mouse.wheel(0, -30); // turning back starts over: none
  await page.waitForTimeout(300);
  const e = await events(page);
  const wheel = flat(e.tablet).filter((x) => x[0] === EV_REL && x[1] === 8).map((x) => x[2]);
  assert.deepEqual(wheel, [-1, 1, -1, -1]);
  assert.deepEqual(errors, []);
  await context.close();
});

/** The toolbar's mouse lock on, in `mode`, and its menu closed. */
async function lockOn(page: Page, mode: 'pointer' | 'raw') {
  await page.click('#mouse-lock > summary');
  await page.check('#mouse-lock-on');
  await page.check(`#mouse-lock [data-mode=${mode}]`);
  await page.click('#mouse-lock > summary');
  assert.equal(await page.getAttribute('#mouse-lock', 'data-on'), 'true');
}

test('the mouse lock, pointer mode (the default): the motion moves the tablet as unlocked, kept in the screen', { skip, timeout: 120_000 }, async () => {
  const { context, page, errors, cdp, at } = await open();
  await page.click('#mouse-lock > summary');
  assert.equal(await page.isChecked('#mouse-lock [data-mode=pointer]'), true, 'the default');
  await page.click('#mouse-lock > summary');
  await lockOn(page, 'pointer');
  const p = at(0.5, 0.5);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', buttons: 1, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: 'left', buttons: 0, clickCount: 1 });
  await page.waitForFunction(() => document.pointerLockElement?.id === 'screen', null, { timeout: 5000 });
  await page.waitForTimeout(200); // what was posted before the lock (the click's release may come first) arrives before the clear
  await clear(page);
  const width = (await page.locator('#screen').boundingBox())!.width;
  // A quarter of the screen's width right: the tablet goes from the middle to three quarters, as an unlocked pointer would.
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x + Math.round(width / 4), y: p.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x + Math.round(width / 4), y: p.y, button: 'right', buttons: 2, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x + Math.round(width / 4), y: p.y, button: 'right', buttons: 0, clickCount: 1 });
  // Far past the right edge: the tablet stays at it.
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x + Math.round(width * 2), y: p.y });
  await page.waitForTimeout(300);
  const e = await events(page);
  assert.equal(e.mouse.length, 0, 'the relative mouse is still');
  const xs = flat(e.tablet).filter((x) => x[0] === EV_ABS && x[1] === 0).map((x) => x[2]);
  const moved = xs.find((x) => x !== 16384)!; // a move without motion (the lock's) leaves it in the middle
  assert.ok(Math.abs(moved - 24575) < 200, `a quarter of the screen: ${xs}`);
  assert.equal(xs.at(-1), 32767, `kept in the screen: ${xs}`);
  assert.deepEqual(keys(e.tablet), [[EV_KEY, 0x111, 1], [EV_KEY, 0x111, 0]], "the click that took the mouse wasn't the guest's; the next one is the tablet's");
  assert.deepEqual(errors, []);
  await context.close();
});

test('the mouse lock, raw mode: a click takes the mouse, its motion goes to the mouse, the page draws the guest cursor', { skip, timeout: 120_000 }, async () => {
  const { context, page, errors, cdp, at } = await open();
  await lockOn(page, 'raw');
  const p = at(0.5, 0.5);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', buttons: 1, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: 'left', buttons: 0, clickCount: 1 });
  await page.waitForFunction(() => document.pointerLockElement?.id === 'screen', null, { timeout: 5000 });
  await page.waitForTimeout(200); // what was posted before the lock (the click's release may come first) arrives before the clear
  await clear(page);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x + 30, y: p.y - 20 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x + 30, y: p.y - 20, button: 'right', buttons: 2, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x + 30, y: p.y - 20, button: 'right', buttons: 0, clickCount: 1 });
  await page.waitForTimeout(300);
  let e = await events(page);
  assert.equal(e.tablet.length, 0, `locked, the tablet is still: ${JSON.stringify(e.tablet)}`);
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
  // At the screen's bottom-right corner the cursor is clipped to the screen, as a cursor is: the page doesn't overflow.
  const before = await page.locator('#screen').boundingBox();
  await page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('#screen')!;
    (window as unknown as { __display: MessagePort }).__display.postMessage({ type: 'cursor-at', x: c.width - 2, y: c.height - 2 });
  });
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => { const d = document.documentElement; return [d.scrollWidth - d.clientWidth, d.scrollHeight - d.clientHeight]; });
  assert.deepEqual(overflow, [0, 0], 'no overflow with the cursor at the corner');
  assert.deepEqual(await page.locator('#screen').boundingBox(), before, 'the screen keeps its size');
  // Turning the lock off lets go of the mouse; the pointer is the tablet's again.
  await page.evaluate(() => document.getElementById('mouse-lock-on')!.click());
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

test('a machine that shuts itself down lets go of the mouse and of the cursor its graphical session hid', { skip, timeout: 120_000 }, async () => {
  const { context, page, errors, cdp, at } = await open();
  await lockOn(page, 'raw');
  const p = at(0.5, 0.5);
  const click = async () => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', buttons: 1, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: 'left', buttons: 0, clickCount: 1 });
  };
  await click();
  await page.waitForFunction(() => document.pointerLockElement?.id === 'screen', null, { timeout: 5000 });
  // The guest's session hides the host's pointer (its own cursor is drawn in the frame, or it hid it).
  await page.evaluate(() => (window as unknown as { __display: MessagePort }).__display.postMessage({ type: 'cursor', image: null, hotX: 0, hotY: 0, x: 0, y: 0 }));
  await page.waitForFunction(() => document.querySelector<HTMLCanvasElement>('#screen')!.style.cursor === 'none', null, { timeout: 5000 });
  // The guest powers off: its worker says so.
  await page.evaluate(() => (window as unknown as { __workers: Worker[] }).__workers[0].dispatchEvent(new MessageEvent('message', { data: { type: 'state', state: 'off' } })));
  await page.waitForFunction(() => document.getElementById('state')?.dataset.state === 'off', null, { timeout: 5000 });
  await page.waitForFunction(() => document.pointerLockElement === null, null, { timeout: 5000 });
  assert.equal(await page.evaluate(() => document.querySelector<HTMLCanvasElement>('#screen')!.style.cursor), '', "the page's own pointer over the stopped screen");
  // A click on the stopped screen doesn't take the mouse again.
  await page.waitForTimeout(1500); // Chromium refuses a lock asked for right after one ended: past that, a refusal here is the page's
  await click();
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => document.pointerLockElement), null, 'the stopped screen keeps its hands off the mouse');
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
