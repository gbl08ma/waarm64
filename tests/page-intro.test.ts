// The introduction (web/app/IntroPage.svelte; docs/frontend.md "The introduction"), in Chromium without a guest: a
// first visit opens it over the whole window (no toolbar, no status bar) at `#intro`; Skip leaves it for the demo
// store's page, where the toolbar and the status bar are, and the browser's Back returns to it; a reload keeps it. A
// visitor with a machine isn't shown it by a bare address, reaches it at `#intro` and from About's button, and Skip
// leads them Home. Its sections: the bar's links, the readouts, the comparison's table, the paths of how it
// works and its two deep dives (the captured code's panes, the RAM split). Our store is answered empty by the test (no request leaves the machine).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { OUR_STORE } from '../web/app/demo-store.ts';
import { t } from '../web/i18n.ts';
import { standIn } from './demo-fixture.ts';
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

test('the sections: the bar\'s links scroll to them; the comparison names each project, ours lit, and the speed figures of the measurement', async () => {
  const { ctx, page, errors } = await visitor();
  await page.goto(`${base}/web/app/#intro`);
  await page.locator('[data-intro] h1').waitFor({ timeout: 30_000 });
  const top = (id: string) => page.locator(`[data-section="${id}"]`).evaluate((e) => Math.round(e.getBoundingClientRect().top));
  const bar = await page.locator('[data-intro] > header').evaluate((e) => e.getBoundingClientRect().height);
  for (const id of ['intro-facts', 'intro-compare', 'intro-how']) {
    assert.ok((await top(id)) > bar + 100, `${id} starts further down`);
    await page.locator(`[data-to-section="${id}"]`).click();
    await page.waitForFunction(([i, b]) => Math.abs(document.querySelector(`[data-section="${i}"]`)!.getBoundingClientRect().top - (b as number)) < 40, [id, bar] as const, { timeout: 10_000, polling: 50 });
  }
  assert.equal(await page.locator('[data-section="intro-facts"] .readout').count(), 4);
  // The introduction scrolls, the document under it doesn't: one scrollbar.
  assert.deepEqual(await page.evaluate(() => [document.scrollingElement!.scrollHeight <= innerHeight, document.scrollingElement!.scrollWidth <= innerWidth]), [true, true], 'the document itself overflows the window');
  const table = page.locator('[data-section="intro-compare"] table');
  assert.deepEqual(await table.locator('thead th').allInnerTexts(), ['waarm64', 'unkernel', 'WebVM', 'v86', 'JSLinux']);
  assert.equal(await table.locator('tbody tr').count(), 12);
  assert.equal(await table.locator('tbody td[data-peer="ours"]').count(), 12, 'a cell of ours in every row');
  assert.equal(await table.locator('tbody td').evaluateAll((tds) => tds.filter((td) => !td.textContent?.trim()).length), 0, 'no empty cell');
  // The speed figures are the measurement's (web/app/intro/speed.ts; bench/compare/REPORT.md): a project each, the next fastest said so.
  const { SPEED } = await import('../web/app/intro/speed.ts');
  assert.deepEqual(await page.locator('[data-field="speed-lead"] .lead').evaluateAll((es) => es.map((e) => (e as HTMLElement).dataset.peer)), (SPEED?.leads ?? []).map((l) => l.peer));
  for (const lead of SPEED?.leads ?? []) {
    const words = (await page.locator(`[data-field="speed-lead"] .lead[data-peer="${lead.peer}"]`).innerText()).replace(/\s+/g, ' ');
    assert.ok(words.includes(lead.times.toFixed(1)) && words.includes(lead.peer), `${lead.peer}'s figure: ${words}`);
    assert.equal(await page.locator(`[data-field="speed-lead"] .lead[data-peer="${lead.peer}"][data-next]`).count(), lead.next ? 1 : 0, `${lead.peer}: the next fastest is said so`);
  }
  // Every source is a link to another site, opened apart and told nothing of the page.
  const links = await page.locator('[data-section="intro-compare"] .sources a').evaluateAll((as) => as.map((a) => ({ rel: a.getAttribute('rel'), target: a.getAttribute('target') })));
  assert.equal(links.length, 4);
  for (const l of links) assert.deepEqual(l, { rel: 'external nofollow noopener noreferrer', target: '_blank' });
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('how it works: five paths that step and stop on a click; the processor\'s captured code lights one instruction in every pane, the visitor\'s own host first; memory\'s split follows its slider', async () => {
  const { ctx, page, errors } = await visitor();
  await page.goto(`${base}/web/app/#intro`);
  await page.locator('[data-intro] h1').waitFor({ timeout: 30_000 });
  await page.locator('[data-action="intro-how"]').click();
  const how = page.locator('[data-section="intro-how"]');
  assert.equal(await how.locator('[data-topic]').count(), 5);
  assert.equal(await how.locator('[data-topic] ol > li').count(), 25, 'five stages a path');

  // A path: it steps by itself on screen, and a click on a stage stops it there, with that stage's words.
  const cpu = how.locator('[data-topic="intro-how-cpu"]');
  await cpu.scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector('[data-topic="intro-how-cpu"] [data-stage="1"]')?.getAttribute('aria-pressed') === 'true', null, { timeout: 15_000, polling: 100 });
  await cpu.locator('[data-stage="3"]').click();
  assert.equal(await cpu.locator('[data-field="stage-words"]').innerText(), t('intro:IntroHow.cpu.4.words'));
  await page.waitForTimeout(4000);
  assert.equal(await cpu.locator('[data-stage="3"]').getAttribute('aria-pressed'), 'true', 'a picked stage stays');

  // The processor's deep dive: mounted when opened, its data fetched then.
  assert.equal(await cpu.locator('[data-translate]').count(), 0);
  await cpu.locator('[data-action="go-deeper"]').click();
  await cpu.locator('[data-translate="sum-loop"]').waitFor({ timeout: 15_000 });
  for (const pane of ['guest', 'uops', 'wasm', 'host']) assert.ok((await cpu.locator(`[data-pane="${pane}"] .row`).count()) > 3, `${pane} has code`);
  assert.equal(await cpu.locator('[data-pane="guest"] .row').count(), 4, "the block's four instructions");
  // A row under the pointer picks its instruction: its lines in the other panes light up, and the place says so.
  await cpu.locator('[data-pane="guest"] .row').nth(2).hover();
  assert.equal(await cpu.locator('[data-pane="guest"] .row.lit').count(), 1);
  assert.match(await cpu.locator('[data-pane="guest"] .row.lit').innerText(), /add\s+w8, w8, w9/);
  assert.equal(await cpu.locator('[data-pane="uops"] .row.lit').count(), 1);
  assert.match(await cpu.locator('[data-pane="wasm"] .row.lit').first().innerText(), /local\.get/);
  assert.ok((await cpu.locator('[data-pane="wasm"] .row.lit').count()) > 3);
  assert.match(await cpu.locator('.place').innerText(), /^Instruction 3 of 4/);
  // Next from the last instruction comes round to the first, whose load lights lines of the host's code too.
  await cpu.locator('[data-step="next"]').click();
  await cpu.locator('[data-step="next"]').click();
  assert.match(await cpu.locator('[data-pane="guest"] .row.lit').innerText(), /ldrb/);
  assert.ok((await cpu.locator('[data-pane="host"] .row.lit').count()) > 0, 'V8 ties the load to its machine code');
  // Both hosts' machine code: the visitor's own kind of processor first (Chromium runs here), the other a chip away.
  const own = process.arch === 'arm64' ? 'arm64' : 'x64';
  const other = own === 'arm64' ? 'x64' : 'arm64';
  await page.waitForFunction((a) => document.querySelector(`[data-arch="${a}"]`)?.getAttribute('aria-pressed') === 'true', own, { timeout: 5000, polling: 100 });
  const ownCode = await cpu.locator('[data-pane="host"]').innerText();
  await cpu.locator(`[data-arch="${other}"]`).click();
  assert.equal(await cpu.locator(`[data-arch="${other}"]`).getAttribute('aria-pressed'), 'true');
  assert.notEqual(await cpu.locator('[data-pane="host"]').innerText(), ownCode, "the other host's code");
  await cpu.locator(`[data-arch="${own}"]`).click();
  // A fold unfolds in place; another block is a click on its chip.
  const rows = await cpu.locator('[data-pane="wasm"] .row').count();
  await cpu.locator('[data-pane="wasm"] .fold').first().click();
  assert.ok((await cpu.locator('[data-pane="wasm"] .row').count()) > rows);
  await cpu.locator('[data-block="cap-loop"]').click();
  await cpu.locator('[data-translate="cap-loop"]').waitFor();
  assert.equal(await cpu.locator('[data-pane="guest"] .row').count(), 9);
  await cpu.locator('[data-action="go-deeper"]').click();
  assert.equal(await cpu.locator('[data-translate]').count(), 0, 'folded away again');

  // Memory's: 8 GiB is memory 0 and two more memories; 2 GiB is memory 0 alone.
  const memory = how.locator('[data-topic="intro-how-memory"]');
  await memory.locator('[data-action="go-deeper"]').click();
  await memory.locator('[data-field="ram-split"]').waitFor();
  assert.equal(await memory.locator('[data-memory]').count(), 3);
  await memory.locator('[data-field="intro-ram"]').fill('2048');
  await page.waitForFunction(() => document.querySelectorAll('[data-field="ram-split"] [data-memory]').length === 1, null, { timeout: 5000 });
  await memory.locator('[data-field="intro-ram"]').fill('16384');
  await page.waitForFunction(() => document.querySelectorAll('[data-field="ram-split"] [data-memory]').length === 5, null, { timeout: 5000 });
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

test("the comparison's day is the one written, in words, west of UTC and in another language's browser too", async () => {
  const { CHECKED } = await import('../web/app/intro/compare.ts');
  const ctx = await browser.newContext({ timezoneId: 'America/Los_Angeles', locale: 'pt-PT' }); // another language's browser: the day stays English
  const page = await ctx.newPage();
  await ctx.route(OUR_STORE, (r) => r.fulfill({ headers: { 'Access-Control-Allow-Origin': '*' }, json: { type: 'waarm64-store', version: 1, demos: [] } }));
  await page.goto(`${base}/web/app/#intro`);
  const lede = await page.locator('[data-section="intro-compare"] p').first().innerText();
  const [y, m, d] = CHECKED.split('-').map(Number);
  // Written out in the catalog's language, whatever the browser's (`{{when, day}}`: "November 20, 2026").
  const written = new Date(y, m - 1, d).toLocaleDateString('en', { dateStyle: 'long' });
  assert.ok(lede.includes(written), `the day shown isn't ${written}: ${lede}`);
  await ctx.close();
});

test("a visit that opens the introduction, Home or the store first doesn't start the machine opened last; the machine's own address does", async () => {
  const { ctx, page, errors } = await visitor();
  await standIn(page);
  const started = () => page.evaluate(() => (window as unknown as { __starts: unknown[] }).__starts.length);
  const settled = () => page.waitForFunction(() => ['off', 'idle', 'failed'].includes(document.body.dataset.state ?? ''), null, { timeout: 30_000, polling: 50 });
  await page.goto(`${base}/web/app/`);
  await page.waitForFunction(() => document.body.dataset.state === 'idle', null, { timeout: 30_000, polling: 50 });
  // A machine with a disk, opened on the page: it starts (the stand-in answers "off").
  await page.evaluate(async () => {
    const { Store } = await import('/web/app/store.ts' as string);
    const { attach, createDisk, createMachine } = await import('/web/app/machines.ts' as string);
    const { page: p } = await import('/web/app/page.ts' as string);
    const store = await Store.open();
    const m = await createMachine(store, { name: 'Kept', ncpus: 1, ramMiB: 256, display: '2d', usb: false, mouse: false, touch: false, shares: false });
    await attach(store, m, await createDisk(store, { kind: 'blank', size: 16 << 20, name: 'Scratch' }));
    await p.openMachine(m.id);
  });
  await page.waitForFunction(() => (window as unknown as { __starts: unknown[] }).__starts.length === 1, null, { timeout: 30_000, polling: 50 });
  for (const [address, shows] of [['#intro', 'intro'], ['#home', 'machines'], ['#demos', 'demos']] as const) {
    await page.goto(`${base}/web/app/${address}`);
    await page.reload();
    await becomes(page, shows);
    await settled();
    await page.waitForTimeout(500);
    assert.equal(await started(), 0, `${address}: the machine opened last started behind it`);
    assert.equal(await page.evaluate(() => document.body.dataset.state), 'off', `${address}: the machine waits, stopped`);
  }
  // Its own address (no page asked for): it starts, as before.
  await page.goto(`${base}/web/app/`);
  await page.reload();
  await page.waitForFunction(() => (window as unknown as { __starts: unknown[] }).__starts.length === 1, null, { timeout: 30_000, polling: 50 });
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("How it was made: the author's account, the reasons, and the way to the credits in About", async () => {
  const { ctx, page, errors } = await visitor();
  await page.goto(`${base}/web/app/#intro`);
  const made = page.locator('[data-section="intro-made"]');
  await made.waitFor({ timeout: 30_000 });
  assert.equal((await made.locator('h2').innerText()).trim(), t('intro:IntroMade.title'));
  assert.equal(await made.locator('dl dt').count(), 6);
  // Three across and two down in a wide window.
  assert.equal(new Set(await made.locator('dl > div').evaluateAll((es) => es.map((e) => Math.round(e.getBoundingClientRect().left)))).size, 3);
  assert.equal(await made.locator('ol li').count(), 4);
  assert.equal(await made.locator('.close p').count(), 3, "the author's closing paragraphs");
  assert.equal(await made.locator('.close i').count(), 1, 'their stress, in italics');
  // It comes after how it works, before the end.
  const order = await page.locator('[data-intro] [data-section]').evaluateAll((es) => es.map((e) => (e as HTMLElement).dataset.section));
  assert.deepEqual(order.slice(order.indexOf('intro-how')), ['intro-how', 'intro-made', ...order.slice(order.indexOf('intro-made') + 1)]);
  // The call to the demos comes before it (the account is long), and again, small, at the page's very end, with the
  // source's address and the license.
  const tops = await page.evaluate(() => ['[data-intro-end]', '[data-section="intro-made"]', '[data-intro-foot]'].map((s) => document.querySelector(s)!.getBoundingClientRect().top));
  assert.ok(tops[0]! < tops[1]! && tops[1]! < tops[2]!, `the order down the page: ${tops.join(', ')}`);
  const foot = page.locator('[data-intro-foot]');
  assert.deepEqual([await foot.locator('[data-action="intro-source"]').getAttribute('href'), await foot.locator('[data-action="intro-source"]').getAttribute('target')], ['https://github.com/gbl08ma/waarm64', '_blank']);
  assert.equal((await foot.locator('[data-field="license"]').innerText()).trim(), t('intro:IntroEnd.license'));
  assert.equal(await foot.locator('[data-action="intro-foot-demos"]').count(), 1);
  // Signed, with a link to the author's own site that opens apart from the page.
  const signed = made.locator('[data-action="intro-author"]');
  assert.deepEqual([await signed.getAttribute('href'), await signed.getAttribute('target'), (await signed.innerText()).trim()], ['https://gbl08ma.com', '_blank', 'gbl08ma']);
  await made.locator('[data-action="intro-about"]').click();
  await becomes(page, 'machines');
  assert.equal(await page.locator('section[data-selected=about]').count(), 1, "Home's About pane, where the projects are credited");
  assert.deepEqual(errors, []);
  await ctx.close();
});
