// The built-in USB keyboard on the page (docs/usb.md "The keyboard"): a stored Debian machine with the USB
// controller, its screen's keys driving GRUB through the firmware's USB keyboard (EDK2's UsbKbDxe on the
// machine's xHCI): `c` stops the countdown, a command typed at grub> runs, and a held Shift reaches GRUB's
// `keystatus` (no terminal sends a modifier by itself: it is the USB path, not the serial one). Then Linux
// boots, its virtio keyboard goes live, the page unplugs the USB keyboard (the guest sees it gone: no key
// twice), and the screen's keys are virtio-input's. Opt-in with WAARM64_DISTROS=debian (scripts/ci-debian.sh --platform).
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { credentialsQuery } from './debian-unattended.ts';
import { withDebianLock } from './debian-lock.ts';
import { PAGE_QUERY } from './page-query.ts';
import { answerAsks } from './page-ask.ts';

const debian = (process.env.WAARM64_DISTROS ?? '').split(',').includes('debian');
const IMAGE = new URL('../target/images/debian/disk.qcow2', import.meta.url);
const FIRMWARE = new URL('../target/images/edk2/QEMU_EFI.fd', import.meta.url);
const skip = !debian ? 'SKIPPED: scripts/ci-debian.sh --platform runs it (WAARM64_DISTROS=debian)'
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
async function onSerial(page: Page, text: string) {
  await page.locator('.xterm').click();
  await page.keyboard.type(text, { delay: 10 });
}
// The keyboards (USB and virtio) take keys by `code`, as a keyboard does: a shifted character is Shift and its key.
const SHIFTED: Record<string, string> = { '&': 'Digit7', '"': 'Quote', '|': 'Backslash', '>': 'Period', '<': 'Comma', $: 'Digit4', '(': 'Digit9', ')': 'Digit0', '*': 'Digit8', _: 'Minus' };
/** Types on the screen, a key at a time (`delay` between them: the firmware polls its keyboard). */
async function onScreen(page: Page, text: string, delay = 60) {
  await page.locator('#screen').click();
  for (const c of text) {
    if (SHIFTED[c]) await page.keyboard.press(`Shift+${SHIFTED[c]}`);
    else if (/[A-Z]/.test(c)) await page.keyboard.press(`Shift+Key${c}`);
    else if (c === '\n') await page.keyboard.press('Enter');
    else await page.keyboard.press(c);
    await page.waitForTimeout(delay);
  }
}
let tag = 0;
async function ok(page: Page, cmd: string, ms = 120_000) {
  const t = ++tag;
  await onSerial(page, `o=$( { ${cmd} ; } 2>&1 ); s=$?; echo "<$((${t}*1))<"$o">$s>${t}>"\n`);
  const re = new RegExp(`<${t}<(.*?)>(\\d+)>${t}>`);
  await shows(page, re, ms);
  const m = re.exec(await terminal(page))!;
  assert.equal(Number(m[2]), 0, `${cmd}: ${m[1]}`);
  return m[1].trim();
}

test("the built-in USB keyboard drives GRUB on a stored Debian machine (keys and a held Shift), and leaves once Linux's virtio keyboard is live", { skip, timeout: 20 * 60_000 }, () => withDebianLock(async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
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
    await store.put('machines', { id, name: 'Keyboard machine', ncpus: 2, ramMiB: 1024, display: '2d', network: false, usb: true, attachments: [{ id: newId(), disk, readOnly: false }], created: now, modified: now });
    store.close();
    return id;
  }, { size, bytes: image.length });
  await page.goto(`${base}/web/app/?${PAGE_QUERY}m=${id}&view=both&${credentialsQuery()}`);

  // GRUB's menu counts 5 s: `c` on the screen (to the USB keyboard) until its command line is up.
  await shows(page, /BdsDxe: starting/, 240_000);
  // GRUB draws on the screen (gfxterm): a terminal on the serial console too, typed on the screen, shows what it does.
  for (const t = performance.now(); performance.now() - t < 25_000;) {
    await onScreen(page, 'c', 0);
    await page.waitForTimeout(400);
  }
  assert.doesNotMatch(await terminal(page), /Linux version/, "GRUB booted: the screen's key never reached it");
  // The `c`s after the first are at its prompt: Ctrl+U (Ctrl held: a modifier, the keyboard's) clears the line.
  await page.keyboard.press('Control+KeyU');
  await page.waitForTimeout(300);
  await onScreen(page, 'terminal_output --append console\n');
  await shows(page, /grub>/, 10_000);
  // A command typed on the screen runs; Shift held through its Enter is GRUB's `keystatus --shift` (a modifier by
  // itself: only a keyboard has that).
  await onScreen(page, 'echo usb-kbd-works\n');
  await shows(page, /echo usb-kbd-works\s*usb-kbd-works\s*grub>/, 10_000);
  const KEYSTATUS = 'if keystatus --shift; then echo shift-held; else echo shift-up; fi';
  await onScreen(page, `${KEYSTATUS}\n`);
  await shows(page, /shift-up/, 10_000);
  await onScreen(page, KEYSTATUS);
  await page.keyboard.down('ShiftLeft');
  await page.waitForTimeout(200);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  await page.keyboard.up('ShiftLeft');
  await shows(page, /shift-held/, 10_000);
  // Back to the menu (Esc), whose first entry boots.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1500);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.body.dataset.state === 'running', null, { timeout: 420_000, polling: 250 });
  await shows(page, /login: /);
  await onSerial(page, 'root\n');
  await shows(page, /root@\S+:~# /);

  // The guest's virtio keyboard is live: the USB keyboard was unplugged (the guest saw it come and go).
  assert.equal(await ok(page, 'for i in $(seq 80); do grep -qs 1209 /sys/bus/usb/devices/*/idVendor || break; sleep 0.25; done; grep -ls 1209 /sys/bus/usb/devices/*/idVendor | wc -l'), '0');
  // The screen's keys are virtio-input's now, each once: tty1 gets `root` and a command whose output comes back on serial.
  await ok(page, "until grep -q 'login: ' /dev/vcs1; do sleep 0.2; done");
  await onScreen(page, 'root\n', 20);
  await ok(page, "until grep -q 'root@[a-z]*:~# ' /dev/vcs1; do sleep 0.2; done");
  await onScreen(page, 'echo once-$((7-2)) >/dev/ttyAMA0\n', 20);
  await shows(page, /once-5/);
  assert.doesNotMatch(await ok(page, 'cat /dev/vcs1 | tr -s " " | tail -c 400'), /eecchhoo|rroooott/);
  assert.deepEqual(errors, []);
  await context.close();
}));
