// The status bar and its Preferences (docs/frontend.md "The status bar"): elements added from the palette (by a click
// and by a drag), moved, set to another look, shown in the bar with the running machine's numbers (per-vCPU bars,
// the disk's speed); all removed, no bar, remembered; the defaults back. On Buildroot (seconds).
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { PAGE_QUERY } from './page-query.ts';
import { answerAsks } from './page-ask.ts';

const IMAGES = new URL('../target/images/', import.meta.url);
const skip = !(existsSync(new URL('buildroot/rootfs.ext4', IMAGES)) && existsSync(new URL('linux/Image', IMAGES))) && 'SKIPPED: run images/build.sh';
/** `WEBPC_SHOTS=<dir>`: screenshots of the bar and its editor, to look at. */
const shots = process.env.WEBPC_SHOTS;

let browser: Browser;
let base: string;
let close: () => void;
before(async () => {
  const server = await startServer();
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
});
after(async () => { await browser?.close(); close?.(); });

const bar = (page: Page) => page.evaluate(() => (document.getElementById('status')?.textContent ?? '').replace(/\s+/g, ' ').trim());
const kinds = (page: Page, sel: string) => page.$$eval(sel, (els) => els.map((e) => (e as HTMLElement).dataset.kind));
const kept = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('webpc.settings') ?? '{}').statusBar);

test('the status bar\'s elements: chosen, ordered and set in Preferences, drawn from the machine, remembered', { skip }, async () => {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await answerAsks(page);
  await page.goto(`${base}/web/app/?${PAGE_QUERY}machine=buildroot&ncpus=2`);
  await page.waitForFunction(() => /MIPS/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 60_000, polling: 200 });
  assert.match(await bar(page), /^Running 2 vCPUs · 256 MiB · up \d+:\d\d:\d\d · \d+ MIPS · [\d.]+% in JIT · \d+ IRQ\/s$/);

  await page.click('#machines-open');
  await page.click('[data-machine=preferences]');
  const chips = '.status-edit .bar .chip';
  assert.deepEqual(await kinds(page, chips), ['state', 'divider', 'vcpus', 'ram', 'uptime', 'mips', 'jit', 'irqs']);

  // Added by clicks, at the end; a spacer before the last two.
  await page.click('[data-add="spacer"]');
  await page.click('[data-add="mips:each"]');
  await page.click('[data-add="diskrate:all"]');
  assert.deepEqual((await kinds(page, chips)).slice(8), ['spacer', 'mips', 'diskrate']);
  // A drag from the palette onto the first chip's left half puts the clock first.
  await page.locator('[data-add="clock"]').dragTo(page.locator(`${chips}[data-at="0"]`), { targetPosition: { x: 2, y: 5 } });
  assert.equal((await kinds(page, chips))[0], 'clock');
  // Alt+→ moves the chosen chip: the clock after the power state.
  await page.locator(`${chips}[data-at="0"] .pick`).focus();
  await page.keyboard.press('Alt+ArrowRight');
  assert.deepEqual((await kinds(page, chips)).slice(0, 2), ['state', 'clock']);

  // The bar draws them: a spacer, a bar per vCPU, the disk's speed.
  await page.waitForFunction(() => document.querySelectorAll('#status [data-kind=mips] .bars span').length === 2, null, { timeout: 10_000 });
  assert.equal(await page.locator('#status .spacer').count(), 1);
  assert.match(await bar(page), /disk R [\d.]+ (B|KiB|MiB)\/s W [\d.]+ (B|KiB|MiB)\/s$/);
  // The look: the vCPUs as an icon and the number.
  await page.click(`${chips}[data-kind=vcpus] .pick`);
  await page.click('[data-field=status-options] input[name=status-look] >> nth=1');
  assert.equal(await page.locator('#status [data-kind=vcpus] svg').count(), 1);
  assert.equal(await page.evaluate(() => document.getElementById('status')!.getBoundingClientRect().height), 29, 'icons don\'t make the bar taller');
  assert.equal((await kept(page)).find((i: { kind: string }) => i.kind === 'vcpus').look, 'icon');
  // A vCPU element's two sets of options (its look, bars or numbers), each in its own frame.
  await page.click(`${chips}[data-kind=mips][data-at="10"] .pick`);
  assert.deepEqual(await page.$$eval('[data-field=status-options] fieldset legend', (ls) => ls.map((l) => l.textContent)), ['Look', 'Each vCPU as']);
  if (shots) await page.locator('[data-field=status-options]').screenshot({ path: `${shots}/options.png` });
  await page.click(`${chips}[data-kind=vcpus] .pick`);
  if (shots) {
    await page.locator('.status-edit').screenshot({ path: `${shots}/editor.png` });
    await page.locator('section[data-selected=preferences]').screenshot({ path: `${shots}/preferences.png` });
    await page.locator('#status').screenshot({ path: `${shots}/bar.png` });
  }

  // Full screen with the bar along (Preferences): the bar shows there, and the keyboard lock with it.
  await page.click('[data-add="keyboard"]');
  const keys = () => page.getAttribute('#status [data-kind=keyboard]', 'data-tone');
  assert.equal(await keys(), 'off');
  await page.check('[data-field=status-fullscreen]');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('webpc.settings')!).statusFullscreen), true);
  await page.click('#fullscreen');
  await page.waitForFunction(() => document.fullscreenElement === document.body, null, { timeout: 5000 });
  assert.equal(await page.locator('#status').isVisible(), true);
  assert.equal(await page.locator('header.toolbar').isVisible(), false);
  const keysSay = (re: RegExp) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector('#status [data-kind=keyboard]')?.textContent ?? ''), re.source, { timeout: 5000 });
  await keysSay(await page.evaluate(() => 'keyboard' in navigator) ? /Keys locked/ : /Typing to the machine/);
  await page.evaluate(() => document.exitFullscreen());
  await keysSay(/Typing to the machine/); // the screen keeps the focus
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await keysSay(/Click to type/);
  await page.click('#machines-open');
  await page.click('[data-machine=preferences]');

  // All removed: no bar (the power state's `#state` stays for tools), remembered across a reload.
  while (await page.locator(chips).count()) await page.locator(`${chips} .x`).first().click();
  assert.equal(await page.locator('#status').isVisible(), false);
  assert.deepEqual(await kept(page), []);
  await page.reload();
  await page.waitForSelector('#state[data-state=running]', { state: 'attached', timeout: 60_000 });
  assert.equal(await page.locator('#status').isVisible(), false);
  // The defaults back.
  await page.click('#machines-open');
  await page.click('[data-machine=preferences]');
  await page.click('[data-action=status-defaults]');
  assert.equal(await kept(page), undefined);
  await page.waitForFunction(() => /2 vCPUs · 256 MiB/.test(document.getElementById('status')?.textContent?.replace(/\s+/g, ' ') ?? ''), null, { timeout: 10_000 });
  assert.deepEqual(errors, []);
  await context.close();
});
