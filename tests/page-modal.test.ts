// The Machines modal (web/app/Machines.svelte, docs/plans/machines.md §7) and the URL check (web/app/urlcheck.ts) in
// Chromium, without a guest: a machine made, set and given disks from several sources through the modal's controls,
// kept across a reload, opened on the page; a URL refused with the reason when its server lacks CORS or ranges.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';

let browser: Browser;
let base: string;
let close: () => void;
/** Another origin: serves 4 KiB at /disk.img, with CORS and ranges, or without (`/plain/…`), or ignoring ranges (`/noranges/…`). */
let other: Server;
let otherBase: string;
before(async () => {
  const server = await startServer();
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const body = Buffer.alloc(4096, 7);
  other = createServer((req, res) => {
    const cors = !req.url!.startsWith('/plain/');
    if (cors) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, ETag');
      res.setHeader('Access-Control-Allow-Headers', 'Range');
    }
    res.setHeader('ETag', '"v1"');
    if (req.method === 'OPTIONS') return void res.writeHead(204).end();
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
    if (!m || req.url!.startsWith('/noranges/')) return void res.writeHead(200, { 'Content-Length': body.length }).end(body);
    const [a, b] = m[1] === '' ? [body.length - Number(m[2]), body.length - 1] : [Number(m[1]), Math.min(Number(m[2] || body.length - 1), body.length - 1)];
    res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${body.length}`, 'Content-Length': b - a + 1 }).end(body.subarray(a, b + 1));
  });
  await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
  otherBase = `http://localhost:${(other.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
});
after(async () => { await browser?.close(); close?.(); other?.close(); });

test('the URL check: what a disk server needs, said when it lacks it', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${base}/tests/browser/core.html`);
  const check = (url: string) => page.evaluate(async (url) => {
    const { checkUrl } = await import('/web/app/urlcheck.ts' as string);
    const r = await checkUrl(url);
    return { ok: r.ok, problems: r.problems, bytes: r.bytes, etag: r.etag };
  }, url);
  assert.deepEqual(await check(`${base}/tests/qcow2/data.raw`), { ok: true, problems: [], bytes: 196608, etag: undefined });
  assert.deepEqual(await check(`${otherBase}/disk.img`), { ok: true, problems: [], bytes: 4096, etag: '"v1"' });
  const plain = await check(`${otherBase}/plain/disk.img`);
  assert.equal(plain.ok, false);
  assert.match(plain.problems.join(' '), /CORS/);
  const noRanges = await check(`${otherBase}/noranges/disk.img`);
  assert.match(noRanges.problems.join(' '), /ignores byte ranges/);
  assert.match((await check(`${base}/no/such.img`)).problems.join(' '), /404/);
  await context.close();
});

const modal = (page: Page) => page.locator('.machines');
/** Waits for the machine's `n`-th disk in the modal; on a timeout, says the modal's error. */
const disk = (page: Page, n: number) => page.locator('.machines section.machine [data-attachment]').nth(n).waitFor({ timeout: 30_000 })
  .catch(async (e) => { throw new Error(`${e}; the modal says: ${await page.locator('.machines').textContent()}`); });

test('the modal makes a machine, sets it, gives it disks from several sources, keeps it across a reload and opens it', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => void d.accept());
  await page.goto(`${base}/web/app/`);
  await page.click('#machines-open');
  await modal(page).locator('[data-action=new-machine]').click();
  const m = modal(page).locator('section.machine[data-selected]');
  await m.waitFor();
  const id = await m.getAttribute('data-selected');
  await m.locator('[data-field=name]').fill('Workbench');
  await m.locator('[data-field=ncpus]').selectOption('2');
  await m.locator('[data-field=ram]').selectOption('1024');
  await m.locator('[data-field=display]').selectOption('2d');
  await m.locator('[data-action=save]').click();
  await modal(page).locator('.pick', { hasText: 'Workbench' }).waitFor();
  // A URL disk (checked), a blank one, a ramdisk; a URL whose server lacks CORS is refused with the reason.
  await m.locator('[data-field=url]').fill(`${otherBase}/plain/disk.img`);
  await m.locator('[data-action=add-disk]').click();
  await modal(page).locator('.error', { hasText: 'CORS' }).waitFor();
  await m.locator('[data-field=url]').fill(`${base}/tests/qcow2/deflate.qcow2`);
  await m.locator('[data-action=add-disk]').click();
  await disk(page, 0);
  await m.locator('[data-field=source]').selectOption('blank');
  await m.locator('[data-field=size]').fill('64');
  await m.locator('[data-action=add-disk]').click();
  await disk(page, 1);
  await m.locator('[data-field=source]').selectOption('ramdisk');
  await m.locator('[data-field=size]').fill('32');
  await m.locator('[data-action=add-disk]').click();
  await disk(page, 2);

  const record = () => page.evaluate(async (id) => {
    const { Store } = await import('/web/app/store.ts' as string);
    const store = await Store.open();
    const m = await store.get('machines', id);
    const disks = await Promise.all(m.attachments.map((a: { disk: string }) => store.get('disks', a.disk)));
    store.close();
    return { name: m.name, ncpus: m.ncpus, ramMiB: m.ramMiB, display: m.display, disks: disks.map((d: { kind: string; size: number }) => [d.kind, d.size]), readOnly: m.attachments.map((a: { readOnly: boolean }) => a.readOnly) };
  }, id);
  const want = { name: 'Workbench', ncpus: 2, ramMiB: 1024, display: '2d', disks: [['url', 1 << 20], ['blank', 64 << 20], ['ramdisk', 32 << 20]], readOnly: [false, false, false] };
  const got = await record();
  assert.ok((got.disks[0][1] as number) > 0);
  assert.deepEqual({ ...got, disks: got.disks.slice(1) }, { ...want, disks: want.disks.slice(1) });
  // Reordered and read-only from the list; detached.
  await m.locator('[data-attachment]').nth(1).getByRole('button', { name: 'Up' }).click();
  await page.waitForFunction(async (id) => {
    const { Store } = await import('/web/app/store.ts' as string);
    const store = await Store.open();
    const m = await store.get('machines', id);
    const first = await store.get('disks', m.attachments[0].disk);
    store.close();
    return first.kind === 'blank';
  }, id);
  await m.locator('[data-attachment]').nth(1).getByRole('checkbox', { name: 'read-only' }).check();
  await page.waitForFunction(async (id) => {
    const { Store } = await import('/web/app/store.ts' as string);
    const store = await Store.open();
    const m = await store.get('machines', id);
    store.close();
    return m.attachments[1].readOnly === true;
  }, id);
  await m.locator('[data-attachment]').nth(2).getByRole('button', { name: 'Detach' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.machines [data-attachment]').length === 2);

  // Kept across a reload, and opened on the page: the header names it.
  await page.reload();
  await page.click('#machines-open');
  await modal(page).locator('.pick', { hasText: 'Workbench' }).click();
  await m.locator('[data-action=open]').click();
  await page.waitForURL(new RegExp(`[?&]m=${id}`));
  await page.waitForFunction(() => document.getElementById('machine')!.textContent === 'Workbench');
  assert.deepEqual(errors, []);
  await context.close();
});
