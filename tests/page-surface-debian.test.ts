// The disk surface window live (web/app/SurfaceWindow.svelte, docs/frontend.md "A disk's surface"), on Debian: a stored
// machine with Debian's image from a URL runs on the page; the window opened from its Disks tab is live (the device
// worker's maps through the machine's worker), the overlay's changes show as cores, and a write in the guest flashes
// "written" and adds to them; once the guest powers off, the same window reads the overlay from its files. The window
// without a guest is tests/page-surface.test.ts's. scripts/ci-machines.sh runs it (WAARM64_DISTROS=debian); a Debian
// page boot is ~40 s in the dev VM, ~2.5 min in a cloud session.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { credentialsQuery } from './debian-unattended.ts';
import { withDebianLock } from './debian-lock.ts';
import { PAGE_QUERY } from './page-query.ts';
import { answerAsks } from './page-ask.ts';
import { FLASH } from '../web/app/ui/block-grid.ts';

const debian = (process.env.WAARM64_DISTROS ?? '').split(',').includes('debian');
const IMAGE = new URL('../target/images/debian/disk.qcow2', import.meta.url);
const FIRMWARE = new URL('../target/images/edk2/QEMU_EFI.fd', import.meta.url);
const skip = !debian ? 'SKIPPED: scripts/ci-machines.sh runs it (WAARM64_DISTROS=debian)' : (!existsSync(IMAGE) || !existsSync(FIRMWARE)) && 'SKIPPED: run images/build.sh debian edk2';
const BOOT_MS = 420_000;

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
// The terminal's top left: the window floats over the middle of the page.
const type = async (page: Page, text: string) => {
  await page.locator('.xterm').click({ position: { x: 12, y: 12 } });
  await page.keyboard.type(text, { delay: 5 });
};
let tag = 0;
async function ok(page: Page, cmd: string, ms = 120_000) {
  const n = ++tag;
  await type(page, `o=$( { ${cmd} ; } 2>&1 ); s=$?; echo "<$((${n}*1))<"$o">$s>${n}>"\n`);
  const re = new RegExp(`<${n}<(.*?)>(\\d+)>${n}>`);
  await shows(page, re, ms);
  const m = re.exec(await terminal(page))!;
  assert.equal(m[2], '0', `${cmd}: ${m[1]}`);
  return m[1].trim();
}

/** The window's view now: where from, its overlay's blocks held, whether any square flashes "written". */
const now = (page: Page) => page.evaluate((write) => {
  const s = window.__surface;
  const over = s?.surface?.layers.find((l) => l.id === 'overlay');
  return {
    source: s?.source, live: s?.live, answers: s?.answers() ?? 0,
    held: over ? over.held.reduce((a, b) => a + b, 0) : -1,
    cores: s?.look ? s.look.core.filter((c) => c > 0).length : 0,
    written: !!s?.look?.flash?.some((f) => f & write),
    cellBytes: s?.surface?.cellBytes ?? 0,
  };
}, FLASH.write);
async function until(page: Page, what: string, f: (v: Awaited<ReturnType<typeof now>>) => boolean, ms = 30_000) {
  const t0 = Date.now();
  for (;;) {
    const v = await now(page);
    if (f(v)) return v;
    if (Date.now() - t0 > ms) throw new Error(`${what}: ${JSON.stringify(v)}`);
    await page.waitForTimeout(100);
  }
}

test('the disk surface window, live on Debian: the overlay\'s changes, a guest write flashing and counted; from the files after the power-off', { skip, timeout: 25 * 60_000 }, () => withDebianLock(async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await answerAsks(page);
  await page.goto(`${base}/web/app/?${PAGE_QUERY}view=terminal`);
  const image = readFileSync(IMAGE);
  const size = Number(image.readBigUInt64BE(24)); // the qcow2's virtual size
  const ids = await page.evaluate(async ({ size, bytes }) => {
    const { Store } = await import('/web/app/store.ts' as string);
    const { newId } = await import('/web/app/shape.ts' as string);
    const store = await Store.open();
    const now = Date.now();
    const disk = newId();
    const path = '/target/images/debian/disk.qcow2';
    await store.put('disks', { id: disk, kind: 'url', name: 'disk.qcow2', size, url: path, identity: { kind: 'url', path, bytes }, created: now });
    const [id, attachment] = [newId(), newId()];
    await store.put('machines', { id, name: 'Surface', ncpus: 2, ramMiB: 1024, display: '2d', network: false, attachments: [{ id: attachment, disk, readOnly: false }], created: now, modified: now });
    store.close();
    return { id, attachment };
  }, { size, bytes: image.length });
  await page.goto(`${base}/web/app/?${PAGE_QUERY}m=${ids.id}&view=terminal&display=simple&${credentialsQuery()}`);
  await page.waitForFunction(() => ['running', 'failed', 'crashed', 'off'].includes(document.body.dataset.state!), null, { timeout: BOOT_MS, polling: 250 });
  assert.equal(await page.evaluate(() => document.body.dataset.state), 'running', await terminal(page));
  await shows(page, /login: /, 120_000);
  await type(page, 'root\n');
  await shows(page, /root@\S+:~# /);

  // Opened from the machine's Disks tab (its overlay, made at the start): live, the boot's writes as cores.
  await page.click('#machines-open');
  await page.locator(`.machines nav [data-machine="${ids.id}"]`).click();
  await page.locator(`.machines section.machine[data-selected="${ids.id}"] [data-tab=disks]`).click();
  await page.locator(`[data-attachment="${ids.attachment}"] [data-action=surface-open]`).click();
  await page.locator('.machines [data-action=back]').click();
  const live = await until(page, 'live, with the overlay\'s changes', (v) => v.source === 'live' && v.live === true && v.held > 0 && v.cores > 0);
  assert.equal(await page.locator('#surface-window [data-action=surface-refresh]').count(), 0, 'no Refresh while live');
  const answered = live.answers;
  await page.waitForTimeout(2000);
  assert.ok((await now(page)).answers >= answered + 2, 'polled while live');

  // A write in the guest: squares flash "written" and the overlay holds its blocks.
  await ok(page, 'dd if=/dev/urandom of=/root/x bs=1M count=8 conv=fsync status=none');
  const written = await until(page, 'a write flashed and counted', (v) => v.written && v.held >= live.held + 2048);
  if (process.env.SURFACE_SHOTS) await page.screenshot({ path: `${process.env.SURFACE_SHOTS}/surface-live.png` });
  console.log(`# overlay blocks ${live.held} -> ${written.held}, ${written.cores} squares with changes at ${written.cellBytes / 2 ** 20} MiB`);

  // Powered off: the same window reads the overlay from its files (once the device worker let them go).
  await type(page, 'poweroff\n');
  await page.waitForFunction(() => document.body.dataset.state === 'off', null, { timeout: 180_000 });
  const off = await until(page, 'from the files after the power-off', (v) => v.source === 'offline' && v.held >= written.held, 30_000);
  assert.equal(off.live, false);
  await page.locator('#surface-window [data-action=surface-refresh]').waitFor();
  await page.locator('#surface-window [data-action=close]').click();
  assert.deepEqual(errors, []);
  await context.close();
}));
