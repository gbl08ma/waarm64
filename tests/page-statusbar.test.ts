// The status bar and its Preferences (docs/frontend.md "The status bar"): elements added from the palette (by a click
// and by a drag), moved, set to another look, shown in the bar with the running machine's numbers (per-vCPU bars,
// the disk's speed); all removed, no bar, remembered; the defaults back. On Buildroot (seconds). And a finger's drags
// in the editor (no machine).
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { PAGE_QUERY } from './page-query.ts';
import { answerAsks } from './page-ask.ts';
import { t } from '../web/i18n.ts';
import { words } from './words.ts';

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

/** Message `key`'s words as a pattern's source, each parameter in `re` matched by its own pattern. */
const pattern = (key: string, re: Record<string, string> = {}) => {
  let src = words(key, Object.fromEntries(Object.keys(re).map((k) => [k, `\u{E000}${k}\u{E000}`]))).source;
  for (const [k, v] of Object.entries(re)) src = src.replace(`\u{E000}${k}\u{E000}`, v);
  return src;
};
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
  const mips = pattern('statusbar:statusbar.cpu.mips', { value: '\\d+' });
  await page.waitForFunction((src) => new RegExp(src).test(document.getElementById('status')?.textContent ?? ''), mips, { timeout: 60_000, polling: 200 });
  // And past the boot (a loaded host shows MIPS while the state still says booting).
  const running = `^\\s*${words('machine:main.state.running').source}\\s`;
  await page.waitForFunction((src) => new RegExp(src).test(document.getElementById('status')?.textContent ?? ''), running, { timeout: 60_000, polling: 200 });
  const vcpus = words('statusbar:statusbar.vcpus', { count: 2 }).source;
  // The power state, a divider, then the rest with a dot between (the bar's drawing, not words).
  assert.match(await bar(page), new RegExp(`^${words('machine:main.state.running').source} ${[
    vcpus, '256 MiB', pattern('statusbar:statusbar.uptime', { time: '\\d+:\\d\\d:\\d\\d' }), mips,
    pattern('statusbar:statusbar.cpu.jit', { value: '[\\d.]+%' }), pattern('statusbar:statusbar.irqs', { irqs: '\\d+' }),
  ].join(' · ')}$`));

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
  const rate = '[\\d.]+ (B|KiB|MiB)/s';
  assert.match(await bar(page), new RegExp(`${pattern('statusbar:statusbar.disk.all', { traffic: pattern('statusbar:statusbar.disk.traffic', { read: rate, written: rate }) })}$`));
  // The look: the vCPUs as an icon and the number.
  const tall = () => page.evaluate(() => document.getElementById('status')!.getBoundingClientRect().height);
  const plainHeight = await tall();
  await page.click(`${chips}[data-kind=vcpus] .pick`);
  await page.click('[data-field=status-options] input[name=status-look] >> nth=1');
  assert.equal(await page.locator('#status [data-kind=vcpus] svg').count(), 1);
  assert.equal(await tall(), plainHeight, 'icons don\'t make the bar taller');
  assert.equal((await kept(page)).find((i: { kind: string }) => i.kind === 'vcpus').look, 'icon');
  // A vCPU element's two sets of options (its look, bars or numbers), each in its own frame.
  await page.click(`${chips}[data-kind=mips][data-at="10"] .pick`);
  assert.deepEqual(await page.$$eval('[data-field=status-options] fieldset legend', (ls) => ls.map((l) => l.textContent)), [t('statusbar:StatusOptions.look'), t('statusbar:StatusOptions.cpus')]);
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
  const keysSay = (words: string) => page.waitForFunction((w) => (document.querySelector('#status [data-kind=keyboard]')?.textContent ?? '').includes(w), words, { timeout: 5000 });
  await keysSay(await page.evaluate(() => 'keyboard' in navigator) ? t('statusbar:statusbar.keyboard.locked') : t('statusbar:statusbar.keyboard.typing'));
  await page.evaluate(() => document.exitFullscreen());
  await keysSay(t('statusbar:statusbar.keyboard.typing')); // the screen keeps the focus
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await keysSay(t('statusbar:statusbar.keyboard.click'));
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
  await page.waitForFunction((src) => new RegExp(src).test(document.getElementById('status')?.textContent?.replace(/\s+/g, ' ') ?? ''), `${words('statusbar:statusbar.vcpus', { count: 2 }).source} · 256 MiB`, { timeout: 10_000 });
  assert.deepEqual(errors, []);
  await context.close();
});

test('the status bar\'s editor on a touchscreen: a long press drags a chip or a palette item, a swipe doesn\'t', async () => {
  const context = await browser.newContext({ viewport: { width: 900, height: 2000 }, hasTouch: true });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/web/app/`);
  await page.click('#machines-open');
  await page.click('[data-machine=preferences]');
  const chips = '.status-edit .bar .chip';
  const order = () => kinds(page, chips);
  const before = await order();
  const cdp = await context.newCDPSession(page);
  const centre = async (sel: string, dx = 0) => {
    const b = (await page.locator(sel).boundingBox())!;
    return { x: b.x + b.width / 2 + dx * b.width, y: b.y + b.height / 2 };
  };
  /** A finger from `from` to `to` in steps, held `hold` ms first. */
  const finger = async (from: { x: number; y: number }, to: { x: number; y: number }, hold: number) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...from, id: 1 }] });
    await page.waitForTimeout(hold);
    for (let k = 1; k <= 6; k++) {
      const p = { x: from.x + (to.x - from.x) * k / 6, y: from.y + (to.y - from.y) * k / 6, id: 1 };
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [p] });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };

  // A swipe down from a chip (a scroll, no hold) moves nothing.
  const first = await centre(`${chips}[data-at="0"]`);
  await finger(first, { x: first.x, y: first.y + 120 }, 0);
  assert.deepEqual(await order(), before);
  // Its fling over first: while one runs, Chromium sends the next touches uncancelable, and the drag that follows
  // would overscroll into a back navigation (synthetic touches only: a finger's touch ends a fling).
  await page.waitForTimeout(500);
  // Held, the first chip goes after the fourth.
  await finger(await centre(`${chips}[data-at="0"]`), await centre(`${chips}[data-at="3"]`, 0.4), 600);
  assert.deepEqual(await order(), [...before.slice(1, 4), before[0], ...before.slice(4)]);
  assert.equal(await page.locator(`${chips}.lifted`).count(), 0);
  // A palette item held and dropped on the first chip's left half: the clock first.
  await finger(await centre('[data-add="clock"]'), await centre(`${chips}[data-at="0"]`, -0.45), 600);
  assert.equal((await order())[0], 'clock');
  // A chip held and dropped on the palette goes away.
  await finger(await centre(`${chips}[data-at="0"]`), await centre('[data-add="spacer"]'), 600);
  assert.deepEqual(await order(), [...before.slice(1, 4), before[0], ...before.slice(4)]);
  assert.deepEqual((await kept(page)).map((i: { kind: string }) => i.kind), await order());
  assert.deepEqual(errors, []);
  await context.close();
});
