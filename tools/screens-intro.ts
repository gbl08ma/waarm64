// The introduction for tools/screens.ts (docs/frontend.md "Screenshots", "The introduction"): its first screen with
// the small machine waiting for its button (the context asks for less motion, so nothing moves by itself and the
// states are the same from run to run) and with the machine's plate (the guest's file answered 404), each section,
// the two deep dives opened, and its end; wide and 720 px. Last, wide only and where the guest is built, the first
// screen with the machine running, at the tour's reveal: a look at the real thing, not a state to compare (its
// picture differs from run to run).
import { existsSync } from 'node:fs';
import type { Browser, Page } from 'playwright-core';
import { ROOT } from './serve.ts';
import type { Shots } from './screens-demos.ts';

const STORE = 'https://vmdisks.tny.im/**';

async function at(browser: Browser, o: Shots, viewport: { width: number; height: number }, suffix: string) {
  const ctx = await browser.newContext({ viewport, reducedMotion: 'reduce' });
  await ctx.route(STORE, (r) => r.fulfill({ headers: { 'Access-Control-Allow-Origin': '*' }, json: { type: 'waarm64-store', version: 1, demos: [] } }));
  const open = async () => {
    const page = await ctx.newPage();
    await page.goto(`${o.base}/web/app/#intro`);
    if (o.css) await page.addStyleTag({ path: o.css });
    await page.locator('[data-intro] h1').waitFor({ timeout: 30_000 });
    return page;
  };
  const take = (name: string, then?: (page: Page) => Promise<unknown>) =>
    o.state(`intro-${name}${suffix}`, async () => {
      const page = await open();
      await then?.(page);
      await o.shot(page, `intro-${name}${suffix}`);
      await page.close();
    });
  /** A section's top under the introduction's bar. */
  const to = (page: Page, selector: string) =>
    page.locator(selector).first().evaluate((e) => e.scrollIntoView({ behavior: 'instant', block: 'start' }));

  await take('hero', (page) => page.locator('[data-intro] figure[data-guest="waiting"], [data-intro] .hero dl').first().waitFor({ timeout: 30_000 }));
  for (const id of ['intro-facts', 'intro-compare', 'intro-how']) await take(id.slice('intro-'.length), (page) => to(page, `[data-section="${id}"]`));
  for (const topic of ['cpu', 'memory']) {
    await take(`dive-${topic}`, async (page) => {
      const article = page.locator(`[data-topic$="${topic}"]`).first();
      await article.locator('[data-action="go-deeper"]').click();
      await article.locator('[data-field="dive"]').waitFor({ timeout: 30_000 });
      await page.waitForLoadState('networkidle'); // the captures, fetched when the processor's dive opens
      await to(page, `[data-topic$="${topic}"] [data-field="dive"]`);
    });
  }
  await take('end', (page) => page.locator('[data-action="intro-end-demos"]').scrollIntoViewIfNeeded());
  await ctx.close();

  // Where the machine can't run (its file isn't there): the plate.
  const bare = await browser.newContext({ viewport });
  await bare.route(STORE, (r) => r.fulfill({ headers: { 'Access-Control-Allow-Origin': '*' }, json: { type: 'waarm64-store', version: 1, demos: [] } }));
  await bare.route('**/intro.img.gz*', (r) => r.fulfill({ status: 404, body: 'none' }));
  await o.state(`intro-hero-plate${suffix}`, async () => {
    const page = await bare.newPage();
    await page.goto(`${o.base}/web/app/#intro`);
    if (o.css) await page.addStyleTag({ path: o.css });
    await page.locator('[data-intro] .hero dl').waitFor({ timeout: 30_000 });
    await o.shot(page, `intro-hero-plate${suffix}`);
    await page.close();
  });
  await bare.close();
}

/** The introduction's states, wide and narrow, and its machine running (wide). */
export async function introScreens(browser: Browser, o: Shots, wide: { width: number; height: number }, narrow: { width: number; height: number }) {
  await at(browser, o, wide, '');
  await at(browser, o, narrow, '-narrow');
  await o.state('intro-hero-running', async () => {
    if (!existsSync(`${ROOT}target/images/intro/intro.img.gz`)) throw new Error("the introduction's machine isn't built (images/build.sh intro)");
    const ctx = await browser.newContext({ viewport: wide });
    await ctx.route(STORE, (r) => r.fulfill({ headers: { 'Access-Control-Allow-Origin': '*' }, json: { type: 'waarm64-store', version: 1, demos: [] } }));
    const page = await ctx.newPage();
    await page.goto(`${o.base}/web/app/#intro`);
    if (o.css) await page.addStyleTag({ path: o.css });
    await page.locator('[data-intro] figure[data-mark="reveal"]').waitFor({ timeout: 60_000 });
    await page.waitForFunction(() => /scope\.c/.test(document.querySelector('[data-intro] figure .xterm-rows')?.textContent ?? ''), null, { timeout: 30_000 });
    await o.shot(page, 'intro-hero-running');
    await ctx.close();
  });
}
