// The disk surface window live (web/app/SurfaceWindow.svelte, docs/frontend.md "A disk's surface"), on Debian: a stored
// machine with Debian's image from a URL runs on the page; the window opened from its Disks tab is live (the device
// worker's maps through the machine's worker), opened early in the boot: the disk (a qcow2) is counted per L2 table as
// the boot reads them, what's under the others not examined until then (nothing fetched for the map), and its blocks
// this browser keeps ticked; the overlay's changes show as cores and the picker says what the overlay holds now, and a
// write in the guest flashes "written" and adds to them; once the guest powers off, the same window reads the overlay
// from its files (the URL's image not examined there). The window
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
import { bytesText } from '../web/app/bytes.ts';

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
  const disk = s?.surface?.layers.find((l) => l.id === 'disk');
  const sum = (a?: Uint32Array) => (a ? a.reduce((n, k) => n + k, 0) : 0);
  return {
    disk: disk ? { known: disk.known, why: disk.why, held: sum(disk.held), unknown: sum(disk.unknown), kept: sum(disk.kept) } : undefined,
    ticks: s?.look?.tick ? s.look.tick.filter((x) => x > 0).length : 0,
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
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: process.env.SURFACE_SHOTS ? 2 : 1 });
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
  await page.waitForFunction(() => ['loading', 'booting', 'running', 'failed', 'crashed', 'off'].includes(document.body.dataset.state!), null, { timeout: BOOT_MS, polling: 50 });

  // Opened from the machine's Disks tab (its overlay, made at the start) as the boot begins: live. What the disk's
  // answers say, sampled as they come: its blocks not examined yet, with data, kept.
  await page.click('#machines-open');
  await page.locator(`.machines nav [data-machine="${ids.id}"]`).click();
  await page.locator(`.machines section.machine[data-selected="${ids.id}"] [data-tab=disks]`).click();
  await page.locator(`[data-attachment="${ids.attachment}"] [data-action=surface-open]`).click();
  await page.locator('#wordmark[data-action=back]').click();
  await page.evaluate(() => {
    const w = window as unknown as { __samples: { unknown: number; held: number; kept: number; ticks: number }[] };
    w.__samples = [];
    let last: unknown;
    const sum = (a?: Uint32Array) => (a ? a.reduce((n, k) => n + k, 0) : 0);
    setInterval(() => {
      const s = window.__surface;
      const d = s?.surface?.layers.find((l) => l.id === 'disk');
      if (!s?.live || !d || s.surface === last) return;
      last = s.surface;
      w.__samples.push({ unknown: d.known === 'opaque' ? -1 : sum(d.unknown), held: sum(d.held), kept: sum(d.kept), ticks: s.look?.tick?.filter((x) => x > 0).length ?? 0 });
    }, 50);
  });
  const samples = () => page.evaluate(() => (window as unknown as { __samples: { unknown: number; held: number; kept: number; ticks: number }[] }).__samples);
  // Caught while the boot still reads the image's tables (where it can be: the boot may read them all first).
  const t0 = Date.now();
  while (Date.now() - t0 < 120_000 && !(await samples()).some((x) => x.unknown === 0)) {
    if ((await samples()).some((x) => x.unknown > 0 && x.held > 0)) {
      if (process.env.SURFACE_SHOTS) await page.screenshot({ path: `${process.env.SURFACE_SHOTS}/surface-partial.png` });
      break;
    }
    await page.waitForTimeout(50);
  }
  await page.waitForFunction(() => ['running', 'failed', 'crashed', 'off'].includes(document.body.dataset.state!), null, { timeout: BOOT_MS, polling: 250 });
  assert.equal(await page.evaluate(() => document.body.dataset.state), 'running', await terminal(page));
  await shows(page, /login: /, 120_000);
  await type(page, 'root\n');
  await shows(page, /root@\S+:~# /);
  const live = await until(page, 'live, with the overlay\'s changes', (v) => v.source === 'live' && v.live === true && v.held > 0 && v.cores > 0);
  assert.equal(await page.locator('#surface-window [data-action=surface-refresh]').count(), 0, 'no Refresh while live');
  // The disk counted from its tables (the boot read every one: 2.6 GiB of 3 GiB is unallocated in Debian's image), each
  // as it came: what isn't examined only shrinks; its blocks kept in this browser ticked, said in the legend.
  const counted = await until(page, 'the disk counted from its tables', (v) => v.disk?.known === 'counted' && v.disk.unknown === 0);
  assert.ok(counted.disk!.held > 0 && counted.disk!.held < size / 4096, JSON.stringify(counted.disk));
  const seen = (await samples()).filter((x) => x.unknown >= 0);
  assert.ok(seen.every((x, i) => i === 0 || x.unknown <= seen[i - 1].unknown), `not examined only shrinks: ${JSON.stringify(seen.map((x) => x.unknown))}`);
  const partial = seen.filter((x) => x.unknown > 0 && x.held > 0).length;
  const kept = await until(page, 'its kept blocks ticked', (v) => v.ticks > 0 && v.disk!.kept > 0);
  assert.ok(kept.disk!.kept <= kept.disk!.held, 'kept: of its blocks with data');
  assert.match((await page.locator('#surface-window [data-legend]').getAttribute('data-legend'))!, /keptSome kept/);
  // The picker: what the overlay holds now, from the live answer (its record says what it held when the run began).
  const pick = () => page.evaluate(() => {
    const over = window.__surface?.surface?.layers.find((l) => l.id === 'overlay');
    const text = document.querySelector<HTMLSelectElement>('#surface-window [data-field=surface-overlay]')?.selectedOptions[0]?.textContent;
    return { text, held: over ? over.held.reduce((a, b) => a + b, 0) : -1 };
  });
  const says = (p: Awaited<ReturnType<typeof pick>>) => !!p.text?.includes(`(${bytesText(p.held * 4096)} of`);
  let picked = await pick();
  for (let i = 0; i < 20 && !says(picked); i++) (await page.waitForTimeout(50), (picked = await pick()));
  assert.ok(says(picked), JSON.stringify(picked));
  const answered = live.answers;
  await page.waitForTimeout(2000);
  assert.ok((await now(page)).answers >= answered + 2, 'polled while live');

  // A write in the guest: squares flash "written" and the overlay holds its blocks.
  await ok(page, 'dd if=/dev/urandom of=/root/x bs=1M count=8 conv=fsync status=none');
  const written = await until(page, 'a write flashed and counted', (v) => v.written && v.held >= live.held + 2048);
  if (process.env.SURFACE_SHOTS) await page.screenshot({ path: `${process.env.SURFACE_SHOTS}/surface-live.png` });
  console.log(`# disk blocks with data ${counted.disk!.held} (${kept.disk!.kept} kept, ${kept.ticks} squares ticked); ${seen.length} answers sampled from the boot's start, ${partial} with tables still unread (not examined: ${JSON.stringify([...new Set(seen.map((x) => x.unknown))])}); overlay blocks ${live.held} -> ${written.held}, ${written.cores} squares with changes at ${written.cellBytes / 2 ** 20} MiB`);

  // Powered off: the same window reads the overlay from its files (once the device worker let them go).
  await type(page, 'poweroff\n');
  await page.waitForFunction(() => document.body.dataset.state === 'off', null, { timeout: 180_000 });
  const off = await until(page, 'from the files after the power-off', (v) => v.source === 'offline' && v.disk?.known === 'opaque' && v.held >= written.held, 30_000);
  assert.equal(off.live, false);
  assert.deepEqual([off.disk?.known, off.disk?.why], ['opaque', 'remote'], 'a URL\'s image is examined only while it runs here');
  await page.locator('#surface-window [data-action=surface-refresh]').waitFor();
  await page.locator('#surface-window [data-action=close]').click();
  assert.deepEqual(errors, []);
  await context.close();
}, { chain: 66 })); // the slot lock's hint: ~66 s
