// The demo store's page (docs/frontend.md "The demo store"; DEMO loop 6), in Chromium without a guest: the machine
// worker is a stand-in that records each start (tests/demo-fixture.ts), and our store (vmdisks.tny.im) is answered by
// the test with a demo whose template is made on the page in a fresh profile (and a second demo of it, for the list).
// The store's demos are a list beside the chosen one's pane (the first with none named; another is a click on its row),
// and in a narrow window one column: the list, then the pane with All demos back. A first visit opens the store; a row
// opens the demo's pane (its checks), Start makes the machine, opens it in the demo's view and its first start
// is the template's restore; a reload keeps the machine and doesn't open the store; the store reached again by `/demos`
// marks the card, and asks Open my machine or Start a fresh copy (named with a suffix). `?id=` opens a demo, an unknown
// id says so over the cards; `?store=` another store warns before anything past its JSON is fetched; and the failure
// paths: the store's server down (Try again), the demo's files gone (404), the download cut off. Home's Demos opens the
// store and its Back returns to Home. New machine offers the store's demo as a template (DEMO loop 13): a machine with
// its settings, cold, not the demo's; the store down, its empty machine still made. (With a guest, a click to a prompt: tests/page-demos-guest.test.ts.)
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { t } from '../web/i18n.ts';
import { makeTemplate, standIn, type Start } from './demo-fixture.ts';

const OURS = 'https://vmdisks.tny.im';
const OTHER = 'https://other.example';
/** The snapshot's content id: its one piece's hash's (web/chunked.ts `contentId`). */
let SNAP = '';
/** A 1×1 PNG, the cards' thumbnail. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const CORS = { 'Access-Control-Allow-Origin': '*' };

let browser: Browser;
let base: string;
let close: () => void;
let snapshot: Uint8Array;
let piece: string;
let def: Record<string, unknown>;
/** A second demo in the stores (the same files under another id), for the list beside a demo's pane. */
let second: Record<string, unknown>;
/** A window of one column (720 px and under): the list, then the chosen demo's pane alone. */
const NARROW = { width: 720, height: 900 };
before(async () => {
  const server = await startServer();
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
  const made = await makeTemplate(browser, base);
  snapshot = new Uint8Array(made.snapshot);
  piece = createHash('sha256').update(snapshot).digest('hex');
  SNAP = createHash('sha256').update(piece).digest('hex');
  const demo = { id: 'alpine-term', summary: 'A terminal.', thumbnail: 'alpine/thumb.png', download: snapshot.length, view: 'serial', snapshot: { manifest: 'alpine/snapshot.json', id: SNAP }, template: true };
  def = { ...made.def, version: 2, disks: made.def.disks.map((x) => ({ ...x, url: 'alpine/manifest.json' })), demo };
  second = { ...def, machine: { ...(def.machine as object), name: 'Alpine two' }, demo: { ...demo, id: 'alpine-two', summary: 'Another terminal.', template: false } };
});
after(async () => {
  await browser?.close();
  close?.();
});

type Site = { down?: boolean; gone?: boolean; cut?: boolean; requests: string[]; held?: Promise<void>; storeHeld?: Promise<boolean> };
/** A store at `origin` with the demo (`down`: unreachable; `gone`: its snapshot 404s; `cut`: its piece's download fails). */
const site = (origin: string, s: Site) => async (r: Route) => {
  const url = r.request().url();
  s.requests.push(url);
  const path = new URL(url).pathname;
  if (s.down) return r.abort('connectionrefused');
  if (path === '/store.json' && s.storeHeld && !(await s.storeHeld)) return r.abort('connectionrefused').catch(() => undefined);
  if (path === `/pieces/${piece}.bin` && s.held) await s.held;
  if (path === '/store.json') return r.fulfill({ headers: CORS, json: { type: 'waarm64-store', version: 1, name: 'Another', demos: [def, second] } });
  if (path === '/alpine/manifest.json') return r.fulfill({ headers: CORS, json: {} }); // there (Open my machine checks it)
  if (path === '/alpine/thumb.png') return r.fulfill({ headers: CORS, contentType: 'image/png', body: PNG });
  if (path === '/alpine/snapshot.json' && !s.gone)
    return r.fulfill({ headers: CORS, json: { format: 'waarm64-chunked-1', size: snapshot.length, piece: 2 << 20, pieces: '../pieces/{hash}.bin', hashes: [piece], id: SNAP } });
  if (path === `/pieces/${piece}.bin`) return (s.cut ? r.abort('connectionreset') : r.fulfill({ headers: CORS, body: Buffer.from(snapshot) })).catch(() => undefined); // aborted by the page meanwhile
  return r.fulfill({ status: 404, headers: CORS });
};

/** A fresh profile's page with the stand-in worker and the stores answered. */
async function visitor(s: Site = { requests: [] }, other: Site = { requests: [] }, live = false, viewport?: { width: number; height: number }): Promise<{ ctx: BrowserContext; page: Page; errors: string[] }> {
  const ctx = await browser.newContext(viewport ? { viewport } : {});
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => { errors.push(`asked: ${d.message()}`); void d.dismiss(); });
  await standIn(page, live);
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
  await page.locator('.cards [data-demo="alpine-term"]').waitFor({ timeout: 30_000 });
  assert.equal(await onPage(page), 'demos', 'the first visit lands on the store');
  assert.equal(await page.locator('.cards [data-demo="alpine-term"] img').getAttribute('alt'), '', "decorative: the button's name is the demo's (#15)");
  await page.locator('.cards [data-demo="alpine-term"]').focus();
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
  assert.equal(await page.evaluate(() => document.body.dataset.view), 'terminal', "a reload keeps the demo's view (this tab's, not the visitor's preference)");
  assert.equal((await starts(page))[0]?.snapshot, false, 'its own start now, no restore');

  await page.goto(`${base}/demos`);
  await page.locator('.cards [data-demo="alpine-term"] [data-mark="mine"]').waitFor({ timeout: 30_000 });
  assert.match(page.url(), /\/web\/app\/demos$/, "the store's own path");
  await page.locator('.cards [data-demo="alpine-term"]').click();
  await page.locator('[data-field="started-before"]').waitFor();
  assert.equal(await page.locator('[data-action="open-mine"]').evaluate((b) => b.classList.contains('primary')), true, 'Open my machine is the default');
  await page.locator('[data-action="fresh-copy"]:not([disabled])').click();
  await page.waitForFunction(() => document.body.dataset.page === 'machine', null, { timeout: 30_000, polling: 50 });
  await page.waitForURL(/\/web\/app\/\?m=/, { timeout: 30_000 }); // the page's own address again, the copy's
  const names = (await machines(page)).map((x) => x.name).sort();
  assert.deepEqual(names, ['Alpine', 'Alpine (2)'], 'the fresh copy named with a suffix');

  await page.setViewportSize(NARROW); // one column: the pane replaces the list, and its default button takes the focus
  await page.goto(`${base}/web/app/#demos?id=alpine-term`);
  await page.locator('[data-action="open-mine"]').waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-action') === 'open-mine', null, { timeout: 5_000, polling: 50 }).catch(() => undefined);
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-action')), 'open-mine', 'Open my machine has the focus (Enter opens it)');
  await page.locator('[data-action="open-mine"]').click();
  await page.waitForFunction(() => document.body.dataset.page === 'machine', null, { timeout: 30_000, polling: 50 });
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('?id= opens a demo, an unknown one says so where its pane would be; Home\'s Demos opens the store and Back returns to Home', async () => {
  const { ctx, page, errors } = await visitor();
  await page.goto(`${base}/demos?id=alpine-term`);
  await page.locator('article[data-demo="alpine-term"]').waitFor({ timeout: 30_000 });
  await page.goto(`${base}/demos?id=nope`);
  await page.locator('[data-field="unknown-id"]').waitFor({ timeout: 30_000 });
  assert.equal(await text(page, '[data-field="unknown-id"]'), t('machines:DemosPage.unknown', { id: 'nope' }));
  assert.equal(await page.locator('[data-field="no-demo"] [data-field="unknown-id"]').count(), 1, "said where the demo's pane would be");
  assert.equal(await page.locator('.cards [data-demo="alpine-term"]').count(), 1, 'the list beside it');
  assert.equal(await page.locator('article[data-demo]').count(), 0, 'no demo shown in its place');
  await page.goto(`${base}/web/app/#home`);
  await ready(page);
  await page.locator('[data-machine="demos"]').click();
  await page.locator('.cards [data-demo="alpine-term"]').waitFor({ timeout: 30_000 });
  await page.locator('.demos [data-action="back"]').click();
  assert.equal(await onPage(page), 'machines', 'Back to Home');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("New machine: a store's template makes a machine with its settings that boots (no snapshot, not the demo's); the store down, the empty machine still works", async () => {
  const s: Site = { requests: [] };
  const { ctx, page, errors } = await visitor(s);
  await page.goto(`${base}/web/app/#home`);
  await ready(page);
  await page.locator('[data-action="new-machine"]').click();
  await page.locator('#new-machine [data-template="alpine-term"]').click({ timeout: 30_000 });
  await page.locator('#new-machine').waitFor({ state: 'detached', timeout: 30_000 });
  const [m] = await machines(page);
  const r = m as typeof m & { ncpus: number; ramMiB: number; display: string; adapters?: { connection?: string }[] };
  assert.equal(r.name, 'Alpine');
  assert.deepEqual([r.ncpus, r.ramMiB, r.display], [(def.machine as { ncpus: number }).ncpus, (def.machine as { ramMiB: number }).ramMiB, (def.machine as { display: string }).display], "the definition's settings");
  assert.equal(r.fromDemo, undefined, "not the demo's");
  assert.equal(r.restoreFirst, undefined, 'no template snapshot to restore');
  assert.ok(!r.adapters?.some((a) => a.connection), 'no demo network');
  assert.equal(await page.locator(`[data-machine="${m.id}"]`).count(), 1, 'listed, and chosen');
  await page.locator('[data-action="open"]').click();
  await page.waitForFunction(() => (window as unknown as { __starts: unknown[] }).__starts.length === 1, null, { timeout: 30_000, polling: 50 });
  assert.equal((await starts(page))[0].snapshot, false, 'a cold boot');
  assert.ok(!s.requests.some((u) => u.includes('snapshot.json') || u.includes('/pieces/')), "the demo's snapshot never fetched");
  assert.deepEqual(errors, []);
  await ctx.close();

  const down = await visitor({ down: true, requests: [] });
  await down.page.goto(`${base}/web/app/#home`);
  await ready(down.page);
  await down.page.locator('[data-action="new-machine"]').click();
  await down.page.locator('[data-field="templates-error"]').waitFor({ timeout: 30_000 });
  assert.match(await text(down.page, '[data-field="templates-error"]'), new RegExp(t('machines:demo-store.failed')));
  await down.page.locator('#new-machine [data-template="empty"]').click();
  await down.page.locator('#new-machine').waitFor({ state: 'detached', timeout: 30_000 });
  const [blank] = await machines(down.page);
  assert.equal((blank as unknown as { attachments: unknown[] }).attachments.length, 0, 'an empty machine, no disks');
  assert.deepEqual(down.errors, []);
  await down.ctx.close();
});

test("?store= another store: its warning before anything past its JSON; accepted, its demos", async () => {
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

// REVIEW.md (review/demo-page-2) #1, #2, #7, #8, #9, #15.
const focused = (page: Page) => page.evaluate(() => { const a = document.activeElement; return a?.getAttribute('data-demo') ?? a?.tagName; });

test("#1: a demo's start belongs to its pane: left mid-download (another demo's row, All demos in one column, Back), its download stops and nothing opens", async () => {
  for (const [leave, viewport] of [['.cards [data-demo="alpine-two"]', undefined], ['[data-action="all-demos"]', NARROW], ['.demos [data-action="back"]', undefined]] as const) {
    let release!: () => void;
    const s: Site = { requests: [], held: new Promise((r) => (release = r)) };
    const { ctx, page, errors } = await visitor(s, undefined, false, viewport);
    const failed: string[] = [];
    page.on('requestfailed', (r) => failed.push(r.url()));
    await page.goto(`${base}/web/app/#home`);
    await ready(page);
    await page.locator('[data-machine="demos"]').click();
    await page.locator('.cards [data-demo="alpine-term"]').click({ timeout: 30_000 });
    await page.locator('[data-action="start-demo"]:not([disabled])').click({ timeout: 10_000 });
    await page.waitForFunction(() => document.querySelector('progress') || document.querySelector('[data-field="progress"]'), null, { timeout: 30_000, polling: 50 });
    for (let i = 0; i < 300 && !s.requests.some((u) => u.includes('/pieces/')); i++) await page.waitForTimeout(50);
    await page.locator(leave).click();
    for (let i = 0; i < 100 && !failed.some((u) => u.includes('/pieces/')); i++) await page.waitForTimeout(50);
    assert.ok(failed.some((u) => u.includes('/pieces/')), `${leave}: the download kept going`);
    release();
    await page.waitForTimeout(1500);
    assert.equal((await machines(page)).length, 0, `${leave}: a machine made`);
    assert.equal((await starts(page)).length, 0, `${leave}: a machine opened`);
    assert.notEqual(await onPage(page), 'machine', `${leave}: the page jumped to the machine`);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
});

test("#2, #9, #15: Open my machine for the machine running here opens it, not Home; a demo's view isn't saved as the visitor's; focus and names", async () => {
  const { ctx, page, errors } = await visitor(undefined, undefined, true);
  await page.goto(`${base}/web/app/#demos?id=alpine-term`);
  await page.locator('[data-action="start-demo"]:not([disabled])').waitFor({ timeout: 30_000 });
  await page.locator('[data-action="start-demo"]').click();
  await page.waitForFunction(() => document.body.dataset.page === 'machine' && document.body.dataset.state === 'running', null, { timeout: 30_000, polling: 50 });
  assert.equal(await page.evaluate(() => document.body.dataset.view), 'terminal');
  const kept = await page.evaluate(async () => ((await import('/web/app/settings.ts' as string)).settings() as { view?: string }).view);
  assert.notEqual(kept, 'terminal', "the demo's view saved as the visitor's (#9)");
  await page.locator('#machines-open').click();
  await page.locator('[data-machine="demos"]').click();
  await page.locator('.cards [data-demo="alpine-term"]').click({ timeout: 30_000 });
  await page.locator('[data-action="open-mine"]:not([disabled])').click({ timeout: 10_000 });
  await page.waitForFunction(() => document.body.dataset.page !== 'demos', null, { timeout: 10_000, polling: 50 });
  assert.equal(await onPage(page), 'machine', 'its machine, not Home (#2)');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("#15, one column: a row opens the demo's pane alone, which takes the focus; All demos gives it back to the demo's row; the download's progress has a name", async () => {
  let release!: () => void;
  const s: Site = { requests: [], held: new Promise((r) => (release = r)) };
  const { ctx, page } = await visitor(s, undefined, false, NARROW);
  await page.goto(`${base}/web/app/#demos`);
  await page.locator('.cards [data-demo="alpine-term"]').click({ timeout: 30_000 });
  await page.locator('article[data-demo="alpine-term"]').waitFor();
  assert.equal(await page.locator('.cards').count(), 0, "the list left for the demo's pane");
  assert.equal(await page.evaluate(() => document.activeElement?.matches('article[data-demo="alpine-term"]')), true, "the demo's pane, named after it, takes the focus (#15)");
  await page.locator('[data-action="all-demos"]').click();
  await page.locator('.cards [data-demo="alpine-term"]').waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-demo') === 'alpine-term', null, { timeout: 5_000, polling: 50 }).catch(() => undefined);
  assert.equal(await focused(page), 'alpine-term', 'the focus fell to the body');
  await page.locator('.cards [data-demo="alpine-term"]').click();
  await page.locator('[data-action="start-demo"]:not([disabled])').click({ timeout: 10_000 });
  await page.locator('[data-field="progress"] progress').waitFor({ timeout: 30_000 });
  assert.equal(await page.locator('[data-field="progress"] progress').getAttribute('aria-label'), t('machines:DemoStart.busy.download'));
  release();
  await ctx.close();
});

test("#7: a store's read that's no longer the one shown doesn't show its failure or its busy state", async () => {
  let answer!: (ok: boolean) => void;
  const other: Site = { requests: [], storeHeld: new Promise((r) => (answer = r)) };
  const { ctx, page, errors } = await visitor(undefined, other);
  await page.goto(`${base}/web/app/#demos?store=${encodeURIComponent(`${OTHER}/store.json`)}`);
  await page.locator('.demos [role="status"]').waitFor({ timeout: 30_000 });
  for (let i = 0; i < 200 && !other.requests.length; i++) await page.waitForTimeout(50);
  await page.evaluate(() => (location.hash = '#demos')); // our store instead, while theirs still loads
  await page.locator('.cards [data-demo="alpine-term"]').waitFor({ timeout: 30_000 });
  answer(false); // theirs fails now
  await page.waitForTimeout(1000);
  assert.equal(await page.locator('[data-field="store-error"]').count(), 0, "the old read's failure shown over our store");
  assert.equal(await page.locator('.cards [data-demo="alpine-term"]').count(), 1);
  assert.equal(await page.locator('.demos [role="status"]').count(), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("#8, one column: the browser's Back retraces the store: a demo's pane to the list, the list to Home; Forward again", async () => {
  const { ctx, page, errors } = await visitor(undefined, undefined, false, NARROW);
  await page.goto(`${base}/web/app/#home`);
  await ready(page);
  await page.locator('[data-machine="demos"]').click();
  await page.locator('.cards [data-demo="alpine-term"]').click({ timeout: 30_000 });
  await page.locator('article[data-demo="alpine-term"]').waitFor();
  await page.goBack();
  await page.locator('ul.cards [data-demo="alpine-term"]').waitFor({ timeout: 10_000 });
  assert.equal(await page.locator('article[data-demo]').count(), 0, "the demo's panel left");
  assert.equal(await onPage(page), 'demos');
  await page.goBack();
  await page.waitForFunction(() => document.body.dataset.page === 'machines', null, { timeout: 10_000, polling: 50 });
  assert.match(page.url(), /#home$/);
  await page.goForward();
  await page.waitForFunction(() => document.body.dataset.page === 'demos', null, { timeout: 10_000, polling: 50 });
  await page.locator('ul.cards [data-demo="alpine-term"]').first().waitFor();
  await page.reload();
  await page.locator('ul.cards [data-demo="alpine-term"]').waitFor({ timeout: 30_000 });
  assert.equal(await onPage(page), 'demos', 'a reload keeps the store');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("the list beside the chosen demo's pane: the first shown with none named, another a click on its row, no way back needed; one column when narrow", async () => {
  const { ctx, page, errors } = await visitor();
  await page.goto(`${base}/web/app/#demos`);
  await page.locator('article[data-demo="alpine-term"]').waitFor({ timeout: 30_000 });
  assert.match(page.url(), /#demos$/, "the address names no demo: the store's first shows by default");
  assert.equal(await page.locator('.cards [data-demo="alpine-term"]').getAttribute('aria-current'), 'true', 'its row is the chosen one');
  assert.equal(await page.locator('.cards [data-demo="alpine-two"]').getAttribute('aria-current'), 'false');
  assert.notEqual(await page.evaluate(() => document.activeElement?.closest('article')?.tagName), 'ARTICLE', 'shown by default, the pane takes no focus');
  await page.locator('.cards [data-demo="alpine-two"]').click();
  await page.locator('article[data-demo="alpine-two"]').waitFor();
  assert.match(page.url(), /#demos\?id=alpine-two$/);
  assert.equal(await page.locator('.cards [data-demo]').count(), 2, 'the list stays beside it');
  assert.equal(await page.locator('[data-action="all-demos"]').count(), 0, 'no trip back to make');
  assert.equal(await focused(page), 'alpine-two', 'the focus stays on the row');
  assert.equal(await page.locator('.cards [data-demo="alpine-two"]').getAttribute('aria-current'), 'true');
  await page.locator('.cards [data-demo="alpine-term"]').click();
  await page.locator('article[data-demo="alpine-term"]').waitFor();
  assert.equal(await page.locator('article[data-demo]').count(), 1, 'one pane, the chosen demo\'s');
  await page.goBack();
  await page.locator('article[data-demo="alpine-two"]').waitFor({ timeout: 10_000 });

  await page.setViewportSize(NARROW); // one column: the chosen demo's pane alone, with its way back
  await page.locator('[data-action="all-demos"]').waitFor();
  assert.equal(await page.locator('.cards').count(), 0);
  await page.locator('[data-action="all-demos"]').click();
  await page.locator('.cards [data-demo="alpine-two"]').waitFor();
  assert.equal(await page.locator('article[data-demo]').count(), 0, 'the list alone: none shown by default in one column');
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.locator('article[data-demo="alpine-term"]').waitFor();
  assert.deepEqual(errors, []);
  await ctx.close();
});
