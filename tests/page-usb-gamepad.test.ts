// The game pad of ours on the page (docs/usb.md "The game pad"): a stored Debian machine with the USB controller and a
// host game pad stood in for by a fake Gamepad API (`navigator.getGamepads`, the connect and disconnect events). The
// USB menu lists no pad until one is "pressed", then lists it; its checkbox attaches the game pad, and the guest's
// hid-generic makes it an evdev game pad with the codes of Linux's game pad convention (BTN_A…BTN_THUMBR, the hat,
// the sticks and triggers); the fake pad's button, stick and D-pad reach /dev/input as those codes; the pad going
// away unplugs it. Opt-in with WEBPC_DISTROS=debian (scripts/ci-debian.sh --platform); ~1 min.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { credentialsQuery } from './debian-unattended.ts';
import { withDebianLock } from './debian-lock.ts';
import { PAGE_QUERY } from './page-query.ts';
import { answerAsks } from './page-ask.ts';
import { t } from '../web/i18n.ts';

const debian = (process.env.WEBPC_DISTROS ?? '').split(',').includes('debian');
const IMAGE = new URL('../target/images/debian/disk.qcow2', import.meta.url);
const FIRMWARE = new URL('../target/images/edk2/QEMU_EFI.fd', import.meta.url);
const skip = !debian ? 'SKIPPED: scripts/ci-debian.sh --platform runs it (WEBPC_DISTROS=debian)'
  : (!existsSync(IMAGE) || !existsSync(FIRMWARE)) && 'SKIPPED: run images/build.sh debian edk2';

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

const terminal = (page: Page) => page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '');
const shows = (page: Page, re: RegExp, ms = 60_000) =>
  page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.xterm-rows')?.textContent ?? ''), re.source, { timeout: ms, polling: 100 })
    .catch(async (e) => { throw new Error(`${e}; the terminal shows: ${await terminal(page)}`); });
async function type(page: Page, text: string) {
  await page.locator('.xterm').click();
  await page.keyboard.type(text, { delay: 5 });
}
let tag = 0;
async function ok(page: Page, cmd: string, ms = 120_000) {
  const t = ++tag;
  await type(page, `o=$( { ${cmd} ; } 2>&1 ); s=$?; echo "<$((${t}*1))<"$o">$s>${t}>"\n`);
  const re = new RegExp(`<${t}<(.*?)>(\\d+)>${t}>`);
  await shows(page, re, ms);
  const m = re.exec(await terminal(page))!;
  assert.equal(Number(m[2]), 0, `${cmd}: ${m[1]}`);
  return m[1].trim();
}
/** The guest's event device of the game pad (1209:0002), after waiting up to 10 s for it ('' when there is none). */
const padEvent = (page: Page, want: boolean) => ok(page, `for i in $(seq 40); do e=$(for d in /sys/class/input/event*; do [ "$(cat $d/device/id/vendor)$(cat $d/device/id/product)" = 12090002 ] && basename $d; done | head -1); [ ${want ? '-n' : '-z'} "$e" ] && break; sleep 0.25; done; echo "$e"`);

/** The Gamepad API, faked: `window.fakePad` is the host's pad (null: none listed yet), changed by the test. */
function fakeGamepads() {
  const w = window as unknown as { fakePad: unknown };
  w.fakePad = null;
  Object.defineProperty(Navigator.prototype, 'getGamepads', { value: () => [w.fakePad], configurable: true });
}
const button = (pressed: boolean) => ({ pressed, value: pressed ? 1 : 0 });
const PAD = { index: 0, id: 'Test pad (STANDARD GAMEPAD Vendor: 1234 Product: 5678)', connected: true, mapping: 'standard', buttons: Array.from({ length: 17 }, () => button(false)), axes: [0, 0, 0, 0] };
/** Sets the fake pad's buttons (by standard index) and axes, and says it connected or disconnected. */
const setPad = (page: Page, o: { pressed?: number[]; axes?: number[]; event?: 'gamepadconnected' | 'gamepaddisconnected'; gone?: boolean }) => page.evaluate(({ pad, o }) => {
  const w = window as unknown as { fakePad: unknown };
  const p = { ...pad, buttons: pad.buttons.map((_, i) => ({ pressed: !!o.pressed?.includes(i), value: o.pressed?.includes(i) ? 1 : 0 })), axes: o.axes ?? pad.axes };
  w.fakePad = o.gone ? null : p;
  if (o.event) dispatchEvent(Object.assign(new Event(o.event), { gamepad: p }));
}, { pad: PAD, o });

test('a host game pad through the Gamepad API: listed once pressed, attached from the menu, an evdev game pad in Debian, unplugged when it goes', { skip, timeout: 20 * 60_000 }, () => withDebianLock(async () => {
  const context = await browser.newContext();
  await context.addInitScript(fakeGamepads);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await answerAsks(page, () => {});
  await page.goto(`${base}/web/app/?${PAGE_QUERY}view=terminal`);
  const image = readFileSync(IMAGE);
  const size = Number(image.readBigUInt64BE(24));
  const id = await page.evaluate(async ({ size, bytes }) => {
    const { Store } = await import('/web/app/store.ts' as string);
    const { newId } = await import('/web/app/shape.ts' as string);
    const store = await Store.open();
    const now = Date.now();
    const disk = newId();
    await store.put('disks', { id: disk, kind: 'url', name: 'disk.qcow2', size, url: '/target/images/debian/disk.qcow2', identity: { kind: 'url', path: '/target/images/debian/disk.qcow2', bytes }, created: now });
    const id = newId();
    await store.put('machines', { id, name: 'Game pad machine', ncpus: 2, ramMiB: 1024, display: '2d', network: false, usb: true, attachments: [{ id: newId(), disk, readOnly: false }], created: now, modified: now });
    store.close();
    return id;
  }, { size, bytes: image.length });
  await page.goto(`${base}/web/app/?${PAGE_QUERY}m=${id}&view=terminal&display=simple&${credentialsQuery()}`);
  await page.waitForFunction(() => document.body.dataset.state === 'running', null, { timeout: 420_000, polling: 250 });
  await shows(page, /login: /);
  await type(page, 'root\n');
  await shows(page, /root@\S+:~# /);
  assert.equal(await padEvent(page, false), '');

  // No pad until one is pressed: the hint. Then it is listed, and its checkbox attaches it.
  await page.click('#usb-menu summary');
  assert.ok(await page.getByText(t('usb:UsbMenu.pads.none')).isVisible());
  await setPad(page, { event: 'gamepadconnected' });
  await page.waitForSelector('#usb-menu [data-usb-pad="0"]', { timeout: 10_000 });
  assert.equal(await page.textContent('#usb-menu [data-usb-pad="0"] .name'), 'Test pad');
  await page.check('#usb-menu [data-usb-pad="0"] input');
  await page.waitForFunction(() => document.getElementById('usb-menu')?.dataset.attached === '1', null, { timeout: 30_000, polling: 100 });
  const ev = await padEvent(page, true);
  assert.match(ev, /^event\d+$/);
  const sys = `/sys/class/input/${ev}/device`;
  assert.equal(await ok(page, `cat ${sys}/name`), 'webpc Test pad');
  assert.equal(await ok(page, `basename $(readlink ${sys}/device/driver)`), 'hid-generic');
  // BTN_A…BTN_THUMBR (0x130–0x13e: the 15 buttons), and ABS_X, Y, Z, RX, RY, RZ, HAT0X, HAT0Y.
  assert.equal(await ok(page, `cat ${sys}/capabilities/key`), '7fff000000000000 0 0 0 0');
  assert.equal(await ok(page, `cat ${sys}/capabilities/abs`), '3003f');

  // The pad's A, its left stick full left, its D-pad right: BTN_A 1, ABS_X −32767, ABS_HAT0X 1 in /dev/input.
  await ok(page, `(timeout 15 cat /dev/input/${ev} > /tmp/ev 2> /dev/null < /dev/null &) ; sleep 1`);
  await setPad(page, { pressed: [0, 15], axes: [-1, 0, 0, 0] });
  await new Promise((r) => setTimeout(r, 500));
  await setPad(page, {});
  const events = await ok(page, `for i in $(seq 40); do [ $(stat -c %s /tmp/ev) -ge 192 ] && break; sleep 0.25; done; od -An -v -td2 -w24 /tmp/ev | awk '$9 != 0 { printf "%s:%s:%s ", $9, $10, $11 }'`);
  // (type, code, value's low 16 bits as int16) per event; SYN reports dropped.
  for (const want of ['1:304:1', '3:0:-32767', '3:16:1', '1:304:0', '3:0:0', '3:16:0']) assert.ok(events.split(' ').includes(want), `${want} in ${events}`);
  assert.ok(events.indexOf('1:304:1') < events.indexOf('1:304:0'), events);

  // The pad goes away: the game pad is unplugged, the menu lists nothing again.
  await setPad(page, { event: 'gamepaddisconnected', gone: true });
  await page.waitForFunction(() => !document.getElementById('usb-menu')?.dataset.attached, null, { timeout: 30_000, polling: 100 });
  assert.equal(await padEvent(page, false), '');
  assert.equal(await page.locator('#usb-menu [data-usb-pad]').count(), 0);
  assert.deepEqual(errors, []);
  await context.close();
}));
