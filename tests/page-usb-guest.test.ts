// USB on the page with a guest, without host devices (docs/usb.md "The page"): a stored Debian machine with the USB
// controller, Gadget Zero attached from the toolbar's USB menu (`?usbzero=1`) and seen by the guest, a kept snapshot
// that asks first, empties the ports and attaches it again (the guest sees it unplugged and back), and a detach. The
// status bar's USB total counts its traffic, and its renderer and frame rate are the simple framebuffer's.
// Opt-in with WAARM64_DISTROS=debian (scripts/ci-machines.sh); from a booted-Debian fixture (tests/debian-fixture.ts
// `storedFixture`), ~15 s.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { putStored, replacesFixture, STORED, STORED_QUERY, storedFixture } from './debian-fixture.ts';
import { loadSnapshotFile } from '../bench/snapshot-start.ts';
import { withDebianLock } from './debian-lock.ts';
import { PAGE_QUERY } from './page-query.ts';
import { answerAsks, type Question } from './page-ask.ts';
import { t } from '../web/i18n.ts';
import { words } from './words.ts';

const debian = (process.env.WAARM64_DISTROS ?? '').split(',').includes('debian');
const IMAGE = new URL('../target/images/debian/disk.qcow2', import.meta.url);
const FIRMWARE = new URL('../target/images/edk2/QEMU_EFI.fd', import.meta.url);
const GLUE = new URL('../web/usb.ts', import.meta.url);
const skip = !debian ? 'SKIPPED: scripts/ci-machines.sh runs it (WAARM64_DISTROS=debian)'
  : (!existsSync(IMAGE) || !existsSync(FIRMWARE)) ? 'SKIPPED: run images/build.sh debian edk2'
    : !existsSync(GLUE) && 'SKIPPED: no xHCI glue (web/usb.ts) yet';

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
/** How many of the guest's USB devices are Gadget Zero (0525:a4a0), after waiting up to 10 s for `want`. */
const zeros = (page: Page, want: number) => ok(page, `for i in $(seq 40); do n=$(grep -ls a4a0 /sys/bus/usb/devices/*/idProduct | wc -l); [ $n = ${want} ] && break; sleep 0.25; done; echo $n`);

test('Gadget Zero on a stored Debian machine: attached from the menu, seen by the guest, unplugged around a snapshot and back, detached', { skip, timeout: 20 * 60_000 }, async () => {
  const fixture = await storedFixture(browser, base, STORED.usb(), STORED_QUERY);
  await withDebianLock(async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors: string[] = [];
    const asked: Question[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await answerAsks(page, (q) => { if (replacesFixture(q)) return false; asked.push(q); });
    const usb = STORED.usb();
    await page.goto(`${base}/web/app/?autostart=1&${PAGE_QUERY}view=terminal`);
    await putStored(page, usb);
    // The status bar (docs/frontend.md "The status bar"): the screen's renderer and frame rate, the USB devices' total.
    await page.evaluate(() => localStorage.setItem('waarm64.settings', JSON.stringify({ ...JSON.parse(localStorage.getItem('waarm64.settings') ?? '{}'), statusBar: [{ kind: 'gpu' }, { kind: 'fps' }, { kind: 'usbtotal' }] })));
    await page.goto(`${base}/web/app/?autostart=1&${STORED_QUERY}&usbzero=1&m=${usb.machine.id}`);
    if (fixture) await loadSnapshotFile(page, fixture);
    await page.waitForFunction(() => document.body.dataset.state === 'running', null, { timeout: 420_000, polling: 250 });
    await shows(page, /login: /);
    await type(page, 'root\n');
    await shows(page, /root@\S+:~# /);
    assert.equal(await zeros(page, 0), '0');

    // Attached from the menu: the guest enumerates it.
    await page.click('#usb-menu summary');
    await page.check('#usb-menu [data-usb-zero] input');
    await page.waitForFunction(() => document.getElementById('usb-menu')?.dataset.attached === '1', null, { timeout: 30_000, polling: 100 });
    assert.equal(await zeros(page, 1), '1');
    // Its enumeration's descriptors (and the built-in keyboard's, in the firmware) came in over the xHCI.
    const el = (sel: string) => page.evaluate((sel) => (document.querySelector(`#status ${sel}`)?.textContent ?? '').replace(/\s+/g, ' ').trim(), sel);
    /** `key`'s words as a pattern, its parameters' places matched by the patterns given. */
    const pattern = (key: string, re: Record<string, string>) => {
      let src = words(key, Object.fromEntries(Object.keys(re).map((k) => [k, `\u{E000}${k}\u{E000}`]))).source;
      for (const [k, v] of Object.entries(re)) src = src.replace(`\u{E000}${k}\u{E000}`, v);
      return new RegExp(`^${src}$`);
    };
    assert.equal(await el('[data-kind=gpu]'), t('statusbar:statusbar-graphics.gpu.framebuffer'));
    assert.match(await el('[data-kind=fps]'), pattern('statusbar:statusbar-graphics.fps', { fps: '\\d+' }));
    const traffic = pattern('statusbar:statusbar-traffic.usb', { traffic: pattern('statusbar:statusbar-traffic.usb.traffic', { in: '[1-9][\\d.]* (B|KiB|MiB)', out: '[\\d.]+ (B|KiB|MiB)' }).source.slice(1, -1) });
    assert.match(await el('[data-kind=usbtotal] .sr'), traffic);

    // A kept snapshot: asked first (naming it), unplugged while it is written, attached again after.
    await page.click('#save-snapshot');
    await page.waitForFunction((src) => new RegExp(src).test(document.getElementById('message-text')?.textContent ?? ''), words('snapshots:snapshot-actions.kept').source, { timeout: 120_000, polling: 250 });
    assert.ok(asked.some((q) => q.text === t('usb:usb-attach.empty.snapshot', { count: 1, list: t('usb:usb-ports.gadgetZero') })), asked.map((q) => q.text).join(' | '));
    await page.waitForFunction(() => document.getElementById('usb-menu')?.dataset.attached === '1', null, { timeout: 30_000, polling: 100 });
    assert.equal(await zeros(page, 1), '1');
    assert.match(await ok(page, 'dmesg | grep -c "USB disconnect"'), /^[1-9]/, 'the guest saw it unplugged');

    // Detached: gone from the guest.
    if (!(await page.isVisible('#usb-menu [data-usb-zero] input'))) await page.click('#usb-menu summary');
    await page.uncheck('#usb-menu [data-usb-zero] input');
    await page.waitForFunction(() => !document.getElementById('usb-menu')?.dataset.attached, null, { timeout: 30_000, polling: 100 });
    assert.equal(await zeros(page, 0), '0');
    assert.deepEqual(errors, []);
    await context.close();
  });
});
