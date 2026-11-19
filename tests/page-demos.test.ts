// The demo store's page (docs/frontend.md "The demo store"; DEMO loop 6), in Chromium without a guest: the machine
// worker is a stand-in that records each start (tests/demo-fixture.ts), and our store (vmdisks.tny.im) is answered by
// the test with a demo whose template is made on the page in a fresh profile. A first visit opens the store; a card
// opens the demo's interstitial (its checks), Start makes the machine, opens it in the demo's view and its first start
// is the template's restore; a reload keeps the machine and doesn't open the store; the store reached again by `/demos`
// marks the card, and asks Open my machine or Start a fresh copy (named with a suffix). `?id=` opens a demo, an unknown
// id says so over the cards; `?store=` another store warns before anything past its JSON is fetched; and the failure
// paths: the store's server down (Try again), the demo's files gone (404), the download cut off. Home's Demos opens the
// store and its Back returns to Home. (With a guest, a click to a prompt: tests/page-demos-guest.test.ts.)
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { t } from '../web/i18n.ts';
import { makeTemplate, standIn, type Start } from './demo-fixture.ts';

const OURS = 'https://vmdisks.tny.im';
const OTHER = 'https://other.example';
const SNAP = 'cd'.repeat(32);
/** A 1×1 PNG, the cards' thumbnail. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const CORS = { 'Access-Control-Allow-Origin': '*' };

let browser: Browser;
let base: string;
let close: () => void;
let snapshot: Uint8Array;
let piece: string;
let def: Record<string, unknown>;
before(async () => {
  const server = await startServer();
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
  const made = await makeTemplate(browser, base);
  snapshot = new Uint8Array(made.snapshot);
  piece = createHash('sha256').update(snapshot).digest('hex');
  const demo = { id: 'alpine-term', summary: 'A terminal.', thumbnail: 'alpine/thumb.png', download: snapshot.length, view: 'serial', snapshot: { manifest: 'alpine/snapshot.json', id: SNAP } };
  def = { ...made.def, version: 2, disks: made.def.disks.map((x) => ({ ...x, url: 'alpine/manifest.json' })), demo };
});
after(async () => {
  await browser?.close();
  close?.();
});

type Site = { down?: boolean; gone?: boolean; cut?: boolean; requests: string[] };
/** A store at `origin` with the demo (`down`: unreachable; `gone`: its snapshot 404s; `cut`: its piece's download fails). */
const site = (origin: string, s: Site) => async (r: Route) => {
  const url = r.request().url();
  s.requests.push(url);
  const path = new URL(url).pathname;
  if (s.down) return r.abort('connectionrefused');
  if (path === '/store.json') return r.fulfill({ headers: CORS, json: { type: 'waarm64-store', version: 1, name: 'Another', demos: [def] } });
  if (path === '/alpine/manifest.json') return r.fulfill({ headers: CORS, json: {} }); // there (Open my machine checks it)
  if (path === '/alpine/thumb.png') return r.fulfill({ headers: CORS, contentType: 'image/png', body: PNG });
  if (path === '/alpine/snapshot.json' && !s.gone)
    return r.fulfill({ headers: CORS, json: { format: 'waarm64-chunked-1', size: snapshot.length, piece: 2 << 20, pieces: '../pieces/{hash}.bin', hashes: [piece], id: SNAP } });
  if (path === `/pieces/${piece}.bin`) return s.cut ? r.abort('connectionreset') : r.fulfill({ headers: CORS, body: Buffer.from(snapshot) });
  return r.fulfill({ status: 404, headers: CORS });
};

/** A fresh profile's page with the stand-in worker and the stores answered. */
async function visitor(s: Site = { requests: [] }, other: Site = { requests: [] }): Promise<{ ctx: BrowserContext; page: Page; errors: string[] }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => { errors.push(`asked: ${d.message()}`); void d.dismiss(); });
  await standIn(page);
  await ctx.route(`${OURS}/**`, site(OURS, s));
  await ctx.route(`${OTHER}/**`, site(OTHER, other));
  return { ctx, page, errors };
}
const ready = (page: Page) => page.waitForFunction(() => document.body.dataset.state === 'idle' || document.body.dataset.state === 'off', null, { timeout: 30_000, polling: 50 });
const onPage = (page: Page) => page.evaluate(() => document.body.dataset.page);
const starts = (page: Page) => page.evaluate(() => (window as unknown as { __starts: Start[] }).__starts);
const machines = (page: Page) => page.evaluate(async () => {
  const { Store } = await import('/web/app/store.ts' as string);
  return ((await (await Store.open()).all('machines')) as { id: string; name: string; fromDemo?: object; restoreFirst?: string }[]);
});
const text = (page: Page, sel: string) => page.locator(sel).innerText();

test("a first visit opens the store; a card's Start makes the machine, opened in its view, restored at its first start; a reload keeps it; started before asks", async () => {
  const { ctx, page, errors } = await visitor();
  await page.goto(`${base}/web/app/?firstvisit=1`);
  await page.locator('[data-demo="alpine-term"]').waitFor({ timeout: 30_000 });
  assert.equal(await onPage(page), 'demos', 'the first visit lands on the store');
  assert.equal(await page.locator('[data-demo="alpine-term"] img').getAttribute('alt'), t('machines:DemoCard.thumbnail.alt', { name: 'Alpine' }));
  await page.locator('[data-demo="alpine-term"]').focus();
  await page.keyboard.press('Enter'); // the card is reached and opened by the keyboard
  await page.locator('[data-action="start-demo"]:not([disabled])').waitFor({ timeout: 10_000 });
  assert.match(page.url(), /#demos\?id=alpine-term$/, 'the address names the demo');
  assert.equal(await page.locator('[data-check="isolation"]').getAttribute('data-level'), 'ok');
  await page.locator('[data-action="start-demo"]').click();
  await page.waitForFunction(() => (window as unknown as { __starts: unknown[] }).__starts.length === 1, null, { timeout: 30_000, polling: 50 });
  const [start] = await starts(page);
  assert.equal(start.snapshot, true, "the first start is the template's restore");
  assert.equal(await onPage(page), 'machine');
  assert.equal(await page.evaluate(() => document.body.dataset.view), 'terminal', "the demo's view (serial)");
  const [m] = await machines(page);
  assert.deepEqual(m.fromDemo, { store: `${OURS}/store.json`, id: 'alpine-term' });
  assert.match(page.url(), new RegExp(`[?&]m=${m.id}$`));

  await page.reload();
  await ready(page);
  assert.equal(await onPage(page), 'machine', 'a reload keeps the machine, not the store');
  assert.equal((await starts(page))[0]?.snapshot, false, 'its own start now, no restore');

  await page.goto(`${base}/demos`);
  await page.locator('[data-demo="alpine-term"] [data-mark="mine"]').waitFor({ timeout: 30_000 });
  assert.match(page.url(), /\/web\/app\/demos$/, "the store's own path");
  await page.locator('[data-demo="alpine-term"]').click();
  await page.locator('[data-field="started-before"]').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-action')), 'open-mine', 'Open my machine is the default');
  await page.locator('[data-action="fresh-copy"]:not([disabled])').click();
  await page.waitForFunction(() => document.body.dataset.page === 'machine', null, { timeout: 30_000, polling: 50 });
  await page.waitForURL(/\/web\/app\/\?m=/, { timeout: 30_000 }); // the page's own address again, the copy's
  const names = (await machines(page)).map((x) => x.name).sort();
  assert.deepEqual(names, ['Alpine', 'Alpine (2)'], 'the fresh copy named with a suffix');

  await page.goto(`${base}/web/app/#demos?id=alpine-term`);
  await page.locator('[data-action="open-mine"]').waitFor({ timeout: 30_000 });
  await page.locator('[data-action="open-mine"]').click();
  await page.waitForFunction(() => document.body.dataset.page === 'machine', null, { timeout: 30_000, polling: 50 });
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('?id= opens a demo, an unknown one says so over the cards; Home\'s Demos opens the store and Back returns to Home', async () => {
  const { ctx, page, errors } = await visitor();
  await page.goto(`${base}/demos?id=alpine-term`);
  await page.locator('article[data-demo="alpine-term"]').waitFor({ timeout: 30_000 });
  await page.goto(`${base}/demos?id=nope`);
  await page.locator('[data-field="unknown-id"]').waitFor({ timeout: 30_000 });
  assert.equal(await text(page, '[data-field="unknown-id"]'), t('machines:DemosPage.unknown', { id: 'nope' }));
  assert.equal(await page.locator('[data-demo="alpine-term"]').count(), 1, 'the cards under it');
  await page.goto(`${base}/web/app/#home`);
  await ready(page);
  await page.locator('[data-machine="demos"]').click();
  await page.locator('[data-demo="alpine-term"]').waitFor({ timeout: 30_000 });
  await page.locator('.demos [data-action="back"]').click();
  assert.equal(await onPage(page), 'machines', 'Back to Home');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("?store= another store: its warning before anything past its JSON; accepted, its cards", async () => {
  const other: Site = { requests: [] };
  const { ctx, page, errors } = await visitor(undefined, other);
  await page.goto(`${base}/demos?store=${encodeURIComponent(`${OTHER}/store.json`)}&id=alpine-term`);
  await page.locator('[data-field="not-ours"]').waitFor({ timeout: 30_000 });
  assert.deepEqual(other.requests, [`${OTHER}/store.json`], 'its JSON only');
  await page.locator('[data-action="accept-store"]').click();
  await page.locator('article[data-demo="alpine-term"] img').waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('img')].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 10_000, polling: 50 });
  assert.ok(other.requests.includes(`${OTHER}/alpine/thumb.png`), 'its thumbnail once accepted');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("failures in words: the store's server down (Try again), the demo's files gone, the download cut off; none leaves a machine", async () => {
  const ours: Site = { requests: [], down: true };
  const { ctx, page, errors } = await visitor(ours);
  await page.goto(`${base}/demos?id=alpine-term`);
  await page.locator('[data-field="store-error"]').waitFor({ timeout: 30_000 });
  assert.match(await text(page, '[data-field="store-error"]'), new RegExp(t('machines:demo-store.failed')));
  ours.down = false;
  ours.gone = true;
  await page.locator('[data-action="retry"]').click();
  await page.locator('[data-action="start-demo"]:not([disabled])').click();
  await page.locator('.start [role="alert"]').waitFor({ timeout: 30_000 });
  assert.match(await text(page, '.start [role="alert"]'), new RegExp(t('machines:template.gone')));
  ours.gone = false;
  ours.cut = true;
  await page.locator('[data-action="start-demo"]:not([disabled])').click();
  await page.waitForFunction((w) => document.querySelector('.start [role="alert"]')?.textContent?.includes(w), t('machines:template.cutOff'), { timeout: 30_000, polling: 50 });
  assert.equal((await machines(page)).length, 0, 'no machine from a failed download');
  assert.equal(await onPage(page), 'demos');
  assert.deepEqual(errors, []);
  await ctx.close();
});
