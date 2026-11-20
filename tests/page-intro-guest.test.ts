// The small machine in the introduction's first screen (web/app/intro/IntroGuest.svelte; docs/frontend.md "The
// introduction"), in Chromium with the real guest (images/build.sh intro; skips without it): it boots by itself and
// its first picture comes before its terminal says anything; a key in the terminal ends the tour and the shell runs a
// command; it stops running while scrolled out of view; `poweroff` leaves a button that boots it again; leaving the
// introduction ends its worker. With less motion asked for, it waits for its button. Where it can't run (no shared
// memory, or its file missing), the machine's plate shows in its place.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContextOptions, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { OUR_STORE } from '../web/app/demo-store.ts';
import { t } from '../web/i18n.ts';

const skip = existsSync(new URL('../target/images/intro/intro.img.gz', import.meta.url)) ? false : 'SKIPPED: run images/build.sh intro';
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

/** A fresh profile's page on the introduction, our store answered empty. */
async function intro(options: BrowserContextOptions = {}, setup?: (page: Page) => Promise<unknown>) {
  const ctx = await browser.newContext(options);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await ctx.route(OUR_STORE, (r) => r.fulfill({ headers: { 'Access-Control-Allow-Origin': '*' }, json: { type: 'waarm64-store', version: 1, demos: [] } }));
  await setup?.(page);
  await page.goto(`${base}/web/app/#intro`);
  await page.locator('[data-intro] h1').waitFor({ timeout: 30_000 });
  return { ctx, page, errors };
}
const frame = (page: Page) => page.locator('[data-intro] figure[data-guest]');
const state = (page: Page, s: string) => page.locator(`[data-intro] figure[data-guest="${s}"]`).waitFor({ timeout: 30_000 });
const mark = (page: Page, m: string) => page.locator(`[data-intro] figure[data-mark="${m}"]`).waitFor({ timeout: 30_000 });
const steps = async (page: Page) => Number(await frame(page).locator('.counters').getAttribute('data-steps'));
const terminalText = (page: Page) => frame(page).locator('.xterm-rows').innerText();
const guestWorkers = (page: Page) => page.workers().filter((w) => /guest-worker/.test(w.url())).length;
/**
 * The guest's workers that still run code. Playwright's list alone isn't enough: about one run in five it keeps a
 * worker the page ended (`terminate()` right after the worker's last message), which then answers nothing.
 */
async function answering(page: Page) {
  const alive = await Promise.all(
    page.workers().filter((w) => /guest-worker/.test(w.url())).map((w) =>
      Promise.race([w.evaluate(() => true).catch(() => false), new Promise<boolean>((r) => setTimeout(() => r(false), 2000))]),
    ),
  );
  return alive.filter(Boolean).length;
}
/** A message's words without its markers. */
const plain = (key: string) => t(key).replace(/<\/?[a-z-]+>/g, '');

test('the machine boots by itself, a key gives its shell, it rests out of view, powers off and starts again, and ends with the introduction', { skip }, async () => {
  const { ctx, page, errors } = await intro();
  await state(page, 'running');
  await mark(page, 'scope');
  assert.equal((await terminalText(page)).trim(), '', 'nothing on the terminal while the first picture runs alone');
  assert.equal((await frame(page).locator('.caption').innerText()).trim(), plain('intro:IntroGuest.caption.scope'));

  // A key typed in the terminal ends the tour; the shell answers.
  await frame(page).locator('.serial').click();
  await page.keyboard.press('Space');
  await mark(page, 'shell');
  assert.equal((await frame(page).locator('.caption').innerText()).trim().replace(/\s+/g, ' '), plain('intro:IntroGuest.caption.shell'));
  await page.keyboard.type('echo ok-$((6*7))\n');
  await page.waitForFunction(() => /ok-42/.test(document.querySelector('[data-intro] figure .xterm-rows')?.textContent ?? ''), null, { timeout: 30_000 });
  await page.waitForFunction(() => Number(document.querySelector<HTMLElement>('[data-intro] figure .counters')?.dataset.steps) > 0, null, { timeout: 10_000 });

  // Out of view it runs nothing: its counters stand still; back in view they move.
  await page.locator('[data-action="intro-end-demos"]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(1500); // the last count before the pause has come
  const rested = await steps(page);
  await page.waitForTimeout(2500);
  assert.equal(await steps(page), rested, 'the guest ran while out of view');
  await frame(page).scrollIntoViewIfNeeded();
  await page.waitForFunction((n) => Number(document.querySelector<HTMLElement>('[data-intro] figure .counters')?.dataset.steps) > n, rested, { timeout: 10_000 });

  // Powered off from its shell: a button boots it again.
  await frame(page).locator('.serial').click();
  await page.keyboard.type('poweroff\n');
  await state(page, 'off');
  for (const end = Date.now() + 5000; (await answering(page)) && Date.now() < end; ) await page.waitForTimeout(100); // its teardown answers, or 2 s pass
  assert.equal(await answering(page), 0, 'the worker of the run that ended is gone');
  await page.locator('[data-action="intro-guest-start"]').click();
  await state(page, 'running');
  assert.equal(await answering(page), 1, 'one worker for the new run');

  // Leaving the introduction ends it.
  await page.locator('[data-action="skip-intro"]').click();
  await page.waitForFunction(() => document.body.dataset.page === 'demos', null, { timeout: 30_000 });
  for (const end = Date.now() + 5000; guestWorkers(page) && Date.now() < end; ) await page.waitForTimeout(100);
  assert.equal(await answering(page), 0, "the guest's worker outlived the introduction");
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("the keyboard passes the machine by: Tab never lands in its terminal, and doesn't end the tour", { skip }, async () => {
  const { ctx, page, errors } = await intro();
  await state(page, 'running');
  await mark(page, 'scope');
  await page.locator('[data-action="intro-demos"]').focus();
  let inFrame = 0;
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    if (await page.evaluate(() => !!document.activeElement?.closest('[data-intro] figure'))) inFrame++;
  }
  assert.equal(inFrame, 0, 'Tab stopped in the frame: its terminal keeps the keys, and the first one ends the tour');
  assert.equal(await page.evaluate(() => !!document.activeElement?.closest('[data-section]')), true, 'Tab went on into the sections');
  assert.equal(await frame(page).getAttribute('data-mark'), 'scope', 'the tour goes on');
  // A click still gives the terminal the keyboard.
  await frame(page).locator('.serial').click();
  await page.keyboard.press('Space');
  await mark(page, 'shell');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('with less motion asked for, the machine waits for its button', { skip }, async () => {
  const { ctx, page, errors } = await intro({ reducedMotion: 'reduce' });
  await state(page, 'waiting');
  await page.waitForTimeout(1500);
  assert.equal(await frame(page).getAttribute('data-guest'), 'waiting', 'it started by itself');
  assert.equal(guestWorkers(page), 0);
  assert.equal((await page.locator('[data-action="intro-guest-start"]').innerText()).trim(), t('intro:IntroGuest.start'));
  await page.locator('[data-action="intro-guest-start"]').click();
  await state(page, 'running');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("where the machine can't run, its plate shows instead: no shared memory; its file missing", async () => {
  // A browser without cross-origin isolation's shared memory.
  const a = await intro({}, (page) => page.addInitScript(() => Object.defineProperty(window, 'crossOriginIsolated', { get: () => false })));
  await a.page.locator('[data-intro] .hero dl').waitFor({ timeout: 30_000 });
  assert.equal(await frame(a.page).count(), 0);
  assert.equal(guestWorkers(a.page), 0);
  assert.deepEqual(a.errors, []);
  await a.ctx.close();
  // The guest's file isn't there (a build without the image): the frame gives way to the plate.
  const b = await intro({}, (page) => page.context().route('**/intro.img.gz*', (r) => r.fulfill({ status: 404, body: 'none' })));
  await b.page.locator('[data-intro] .hero dl').waitFor({ timeout: 30_000 });
  assert.equal(await frame(b.page).count(), 0);
  assert.deepEqual(b.errors, []);
  await b.ctx.close();
});
