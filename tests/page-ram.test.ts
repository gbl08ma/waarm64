// The RAM map live (web/app/RamWindow.svelte, docs/frontend.md "RAM's map"), on Debian: opened from the status bar's
// RAM while the machine runs, it shows RAM's pages with data at their guest addresses and, from its second look, what
// changed; 64 MiB the guest writes into a tmpfs adds to both, and once the file is gone the guest gives the memory back
// (the balloon's free page reporting zeroes it) and the map counts it cleared; a pinned square's pages and addresses;
// powered off, the window says the map needs a running machine and RAM is no longer a link. Its pure parts are
// tests/ram-scan.test.ts's. scripts/ci-debian.sh runs it (WAARM64_DISTROS=debian); a Debian page boot is ~40 s in the
// dev VM, ~2.5 min in a cloud session.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { unattendedQuery } from './debian-unattended.ts';
import { withDebianLock } from './debian-lock.ts';
import { PAGE_QUERY } from './page-query.ts';
import { answerAsks } from './page-ask.ts';
import { t } from '../web/i18n.ts';
import { words } from './words.ts';

const debian = (process.env.WAARM64_DISTROS ?? '').split(',').includes('debian');
const IMAGE = new URL('../target/images/debian/disk.qcow2', import.meta.url);
const FIRMWARE = new URL('../target/images/edk2/QEMU_EFI.fd', import.meta.url);
const skip = !debian ? 'SKIPPED: scripts/ci-debian.sh runs it (WAARM64_DISTROS=debian)' : (!existsSync(IMAGE) || !existsSync(FIRMWARE)) && 'SKIPPED: run images/build.sh debian edk2';
const BOOT_MS = 420_000;
const MiB = 2 ** 20;

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

/** The map now: its pages with data, changed and cleared at the last look, its looks, the answers taken. */
const now = (page: Page) => page.evaluate(() => {
  const r = window.__ram;
  const sum = (a?: Uint32Array) => (a ? a.reduce((n, k) => n + k, 0) : -1);
  const layer = (id: string) => r?.surface?.layers.find((l) => l.id === id);
  return {
    live: r?.live, size: r?.surface?.size ?? 0, cellBytes: r?.surface?.cellBytes ?? 0, layout: r?.layout ?? [],
    data: sum(layer('ram')?.held), changed: sum(layer('changed')?.held), cleared: sum(layer('changed')?.zero),
    cores: r?.look ? r.look.core.filter((c) => c > 0).length : 0, answers: r?.answers() ?? 0,
  };
});
async function until(page: Page, what: string, f: (v: Awaited<ReturnType<typeof now>>) => boolean, ms = 60_000) {
  const t0 = Date.now();
  for (;;) {
    const v = await now(page);
    if (f(v)) return v;
    if (Date.now() - t0 > ms) throw new Error(`${what}: ${JSON.stringify(v)}`);
    await page.waitForTimeout(100);
  }
}

test("the RAM map, live on Debian: data and changes counted, a guest's 64 MiB written and given back; a pinned square; off after the power-off", { skip, timeout: 15 * 60_000 }, () => withDebianLock(async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: process.env.RAM_SHOTS ? 2 : 1 });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await answerAsks(page);
  await page.goto(`${base}/web/app/?${PAGE_QUERY}${unattendedQuery()}&ncpus=2&ram=1024&view=terminal&display=simple`);
  assert.equal(await page.locator('[data-action=ram-open]').count(), 0, 'RAM is no link before the machine runs');
  await page.waitForFunction(() => ['running', 'failed', 'crashed', 'off'].includes(document.body.dataset.state!), null, { timeout: BOOT_MS, polling: 250 });
  assert.equal(await page.evaluate(() => document.body.dataset.state), 'running', await terminal(page));
  await shows(page, /login: /, 120_000);
  await type(page, 'root\n');
  await shows(page, /root@\S+:~# /);

  // Opened from the status bar's RAM: all of RAM at its guest address, data in it; from the second look, changes.
  await page.locator('#status [data-action=ram-open]').click();
  await page.locator('#ram-window').waitFor();
  const first = await until(page, 'a first look with data', (v) => v.live === true && v.data > 0);
  assert.equal(first.size, 1024 * MiB);
  assert.deepEqual(first.layout, [{ off: 0, pa: 0x4000_0000, size: 1024 * MiB }]);
  assert.ok(first.data < first.size / 4096, 'not every page holds data');
  const second = await until(page, 'a second look, with changes', (v) => v.changed >= 0);
  assert.match((await page.locator('#ram-window [data-legend]').getAttribute('data-legend'))!, /zero some full changed cleared/);
  assert.match((await page.locator('#ram-window [data-field=ram-every]').textContent())!, /\d|second/);
  await page.waitForTimeout(3000);
  assert.ok((await now(page)).answers >= second.answers + 1, 'looked again');

  // 64 MiB of random bytes in a tmpfs: its pages hold data, and changed since the look before.
  // Every look's changed pages, summed as they come (the write may span two looks).
  await page.evaluate(() => {
    const w = window as unknown as { __changed: number };
    w.__changed = 0;
    let last: unknown;
    setInterval(() => {
      const r = window.__ram;
      const c = r?.surface?.layers.find((l) => l.id === 'changed');
      if (!c || r?.surface === last) return;
      last = r?.surface;
      w.__changed += c.held.reduce((n, k) => n + k, 0);
    }, 50);
  });
  const changedSum = () => page.evaluate(() => (window as unknown as { __changed: number }).__changed);
  const before = await now(page);
  const ahead = await changedSum();
  await ok(page, 'head -c 64M /dev/urandom > /dev/shm/x');
  const written = await until(page, '64 MiB written counted', (v) => v.data >= before.data + 14_000);
  await page.waitForTimeout(3000); // a look after the write's last pages
  const moved = (await changedSum()) - ahead;
  assert.ok(moved >= 16_384, `64 MiB of pages seen changed over the looks: ${String(moved)}`);
  if (process.env.RAM_SHOTS) await page.screenshot({ path: `${process.env.RAM_SHOTS}/ram-live.png` });
  // Gone: the guest gives the memory back (free page reporting zeroes it, ~2 s after the free), and it's cleared.
  await ok(page, 'rm /dev/shm/x');
  const cleared = await until(page, 'the freed memory cleared', (v) => v.data <= written.data - 8_000, 90_000);
  console.log(`# RAM pages with data ${before.data} -> ${written.data} (${String(moved)} changed over the looks) -> ${cleared.data}; squares of ${first.cellBytes / MiB} MiB`);

  // The line under the map: the whole, then a square pointed at; a click pins it, with its pages and addresses.
  assert.match((await page.locator('#ram-window [data-field=ram-line]').textContent())!, words('machine:ram-look.hint'));
  const grid = page.locator('#ram-window [role=application] canvas');
  const box = (await grid.boundingBox())!;
  await page.mouse.move(box.x + 4, box.y + 4);
  await page.waitForFunction(() => /0x4000_0000/.test(document.querySelector('#ram-window [data-field=ram-line]')?.textContent ?? ''));
  await page.mouse.click(box.x + 4, box.y + 4);
  await page.locator('#ram-square [data-field=ram-range-words]').waitFor();
  assert.match((await page.locator('#ram-square [data-field=ram-range-words]').textContent())!, /0x4000_0000.*0x4040_0000/);
  assert.equal(await page.evaluate(() => window.__ram?.pinned), 0);

  // Powered off: the window says why it shows nothing, and RAM isn't a link.
  await type(page, 'poweroff\n');
  await page.waitForFunction(() => document.body.dataset.state === 'off', null, { timeout: 180_000 });
  await page.locator('#ram-window [data-field=ram-why]').waitFor();
  assert.equal((await page.locator('#ram-window [data-field=ram-why]').textContent())!.trim(), t('machine:ram-source.notRunning'));
  assert.equal(await page.locator('#ram-square').count(), 0, 'the pinned square closed');
  assert.equal(await page.locator('[data-action=ram-open]').count(), 0);
  await page.locator('#ram-window [data-action=close]').click();
  assert.deepEqual(errors, []);
  await context.close();
}));
