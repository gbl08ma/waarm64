// The introduction (web/app/IntroPage.svelte; docs/frontend.md "The introduction"), in Chromium without a guest: a
// first visit opens it over the whole window (no toolbar, no status bar) at `#intro`; Skip leaves it for the demo
// store's page, where the toolbar and the status bar are, and the browser's Back returns to it; a reload keeps it. A
// visitor with a machine isn't shown it by a bare address, reaches it at `#intro` and from About's button, and Skip
// leads them Home. Our store is answered empty by the test (no request leaves the machine).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { OUR_STORE } from '../web/app/demo-store.ts';
import { t } from '../web/i18n.ts';
import { newEmptyMachine, openHome } from './page-home.ts';

let browser: Browser;
let base: string;
let close: () => void;
before(async () => {
  const server = await startServer();
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
});
after(async () => {
  await browser?.close();
  close?.();
});

/** A fresh profile's page, our store answered empty. */
async function visitor() {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await ctx.route(OUR_STORE, (r) => r.fulfill({ headers: { 'Access-Control-Allow-Origin': '*' }, json: { type: 'waarm64-store', version: 1, demos: [] } }));
  return { ctx, page, errors };
}
const onPage = (page: Page) => page.evaluate(() => document.body.dataset.page);
const becomes = (page: Page, name: string) => page.waitForFunction((n) => document.body.dataset.page === n, name, { timeout: 30_000, polling: 50 });
const hash = (page: Page) => new URL(page.url()).hash;

test('a first visit opens the introduction over the whole window; Skip leads to the store, Back returns; a reload keeps it', async () => {
  const { ctx, page, errors } = await visitor();
  await page.goto(`${base}/web/app/?firstvisit=1`);
  await page.locator('[data-intro] h1').waitFor({ timeout: 30_000 });
  assert.equal(await onPage(page), 'intro');
  assert.equal(hash(page), '#intro', 'the address names it');
  assert.equal(await page.locator('header.toolbar').isVisible(), false, 'no toolbar under the introduction');
  assert.equal(await page.locator('#status').isVisible(), false, 'no status bar');
  assert.equal(await page.locator('main').isVisible(), false, "the machine's place is hidden");
  assert.equal(await page.locator('[data-action="skip-intro"]').getAttribute('data-to'), 'demos');

  await page.reload();
  await page.locator('[data-intro] h1').waitFor({ timeout: 30_000 });
  assert.equal(await onPage(page), 'intro', 'a reload keeps it');

  await page.locator('[data-action="skip-intro"]').click();
  await becomes(page, 'demos');
  assert.equal(hash(page), '#demos');
  await page.locator('header.toolbar').waitFor({ state: 'visible' });
  assert.equal(await page.locator('[data-intro]').count(), 0);

  await page.goBack();
  await becomes(page, 'intro');
  assert.equal(hash(page), '#intro');
  await page.locator('[data-action="intro-demos"]').click(); // the first screen's button leads there too
  await becomes(page, 'demos');
  await page.goBack();
  await becomes(page, 'intro');
  await page.locator('[data-action="intro-end-demos"]').click(); // and its end's
  await becomes(page, 'demos');
  assert.equal(await page.locator('[data-action="intro-end-home"]').count(), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("with a machine kept: a bare address isn't the introduction; `#intro` and About's button open it; Skip leads Home", async () => {
  const { ctx, page, errors } = await visitor();
  await page.goto(`${base}/web/app/`);
  await openHome(page);
  await newEmptyMachine(page);
  await page.locator('nav [data-machine]:not([data-machine=preferences], [data-machine=demos], [data-machine=about])').first().waitFor({ timeout: 10_000 });

  await page.goto(`${base}/web/app/?firstvisit=1`);
  await page.locator('header.toolbar').waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForFunction(() => document.body.dataset.state !== undefined, null, { timeout: 30_000 });
  assert.notEqual(await onPage(page), 'intro', 'not a first visit');

  await page.goto(`${base}/web/app/#intro`);
  await page.reload(); // a fragment's change alone doesn't load the page again
  await page.locator('[data-intro] h1').waitFor({ timeout: 30_000 });
  const skip = page.locator('[data-action="skip-intro"]');
  assert.equal(await skip.getAttribute('data-to'), 'home');
  assert.equal((await skip.innerText()).trim(), t('intro:IntroPage.skip.home'));
  assert.equal(await page.locator('[data-action="intro-end-home"]').count(), 1, 'the end offers their machines too');
  await skip.click();
  await becomes(page, 'machines');
  assert.equal(hash(page), '#home');

  await page.click('[data-machine=about]');
  await page.locator('[data-action="open-intro"]').click();
  await becomes(page, 'intro');
  assert.equal(hash(page), '#intro');
  await page.goBack();
  await becomes(page, 'machines');
  assert.equal(await page.locator('section[data-selected=about]').count(), 1, 'Home as it was left: About');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('wording: the introduction', async () => {
  const { ctx, page } = await visitor();
  await page.goto(`${base}/web/app/#intro`);
  await page.locator('[data-intro] h1').waitFor({ timeout: 30_000 });
  assert.equal(await page.locator('[data-intro] h1').innerText(), 'A whole 64-bit ARM computer in a browser tab');
  assert.equal((await page.locator('[data-action="skip-intro"]').innerText()).trim(), 'Skip to the demos');
  assert.equal((await page.locator('[data-action="intro-demos"]').innerText()).trim(), 'Try a demo');
  await ctx.close();
});
