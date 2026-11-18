// The page's frames in Chromium, without a guest: every pane of the Home page (web/app/ui/Pane.svelte) puts its title
// at the same place, and its body at the same place under a head of one line, whether or not the head has buttons; the
// message's text (#message) is centered on its buttons while it is one line.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, type Browser } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { t } from '../web/i18n.ts';

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

test("the Home page's panes: the title and the body at one place, with buttons in the head or none", async () => {
  // Wide enough that every pane's head is one line.
  const page = await browser.newPage({ viewport: { width: 2400, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/web/app/`);
  await page.click('#machines-open');
  await page.click('[data-action=new-machine]');
  await page.locator('section.machine[data-selected] [data-tab=settings]').waitFor();
  const ids = await page.$$eval('nav [data-machine]', (bs) => bs.map((b) => (b as HTMLElement).dataset.machine!));
  const at: Record<string, { title: number; titleX: number; head: number; body: number; tabs: boolean; buttons: number }> = {};
  for (const id of ids) {
    await page.click(`nav [data-machine="${id}"]`);
    await page.locator(`section.machine[data-selected="${id}"]`).waitFor();
    at[id] = await page.locator(`section.machine[data-selected="${id}"]`).evaluate((s) => {
      const top = s.getBoundingClientRect().top;
      const r = (sel: string) => s.querySelector(sel)!.getBoundingClientRect();
      return { title: r('h3').top - top, titleX: r('h3').left - s.getBoundingClientRect().left, head: r('.head').height,
        body: r(':scope > .tab').top - top, tabs: !!s.querySelector('.tabs'), buttons: s.querySelectorAll('.head > button').length };
    });
  }
  const plain = Object.entries(at).filter(([, x]) => !x.tabs);
  assert.ok(plain.some(([, x]) => x.buttons > 0) && plain.some(([, x]) => x.buttons === 0), `panes with and without buttons: ${JSON.stringify(at)}`);
  assert.ok(Object.values(at).some((x) => x.tabs), 'a machine, with tabs');
  const one = (what: string, f: (x: (typeof at)[string]) => number, of = Object.entries(at)) =>
    assert.equal(new Set(of.map(([, x]) => f(x))).size, 1, `${what}: ${JSON.stringify(Object.fromEntries(of.map(([id, x]) => [id, f(x)])))}`);
  one('the title', (x) => x.title);
  one("the title's left", (x) => x.titleX);
  one('the head', (x) => x.head);
  one('the body (no tabs)', (x) => x.body, plain);
  assert.deepEqual(errors, []);
  await page.close();
});

test('the message: one line of text centered on its buttons', async () => {
  // The first message (open a disk image) is one line this wide.
  const page = await browser.newPage({ viewport: { width: 2560, height: 600 } });
  await page.goto(`${base}/web/app/`);
  await page.locator('#message:not([hidden]) #message-actions button').waitFor();
  // Where it lands: its slide down from above the page (ui/crossfade.ts) done.
  await page.locator('#message .banner').evaluate((e) => Promise.all(e.getAnimations().map((a) => a.finished)));
  const mid = (sel: string) => page.locator(sel).first().evaluate((e) => { const r = e.getBoundingClientRect(); return r.top + r.height / 2; });
  const [text, button, close] = [await mid('#message-body'), await mid('#message-actions button'), await mid('#message-close')];
  const height = await page.locator('#message-text').evaluate((e) => e.getBoundingClientRect().height);
  assert.ok(height < 20, `one line: ${height}px`);
  assert.ok(Math.abs(text - button) <= 0.5 && Math.abs(close - button) <= 0.5, `centers: text ${text}, button ${button}, close ${close}`);
  await page.close();
});

test("the primitives: a form's buttons are one height (ui/Button.svelte), and the page's styles are the tokens'", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${base}/web/app/`);
  await page.click('#machines-open');
  await page.click('[data-action=new-machine]');
  await page.locator('section.machine[data-selected] [data-tab=settings]').waitFor();
  const got = await page.evaluate(() => {
    const control = getComputedStyle(document.documentElement).getPropertyValue('--control-h').trim();
    const heights = [...document.querySelectorAll('section.machine .button.bordered, section.machine .button.primary')]
      .filter((b) => (b as HTMLElement).offsetParent)
      .map((b) => b.getBoundingClientRect().height);
    return { control, heights };
  });
  assert.equal(got.control, '28px', 'tokens.css is loaded');
  assert.ok(got.heights.length >= 2, `buttons: ${got.heights.length}`);
  assert.deepEqual([...new Set(got.heights)], [28], `heights: ${got.heights.join(', ')}`);
  await page.close();
});

test("the Home page's outline: its heading, then the machines' list and each pane under it; the nav named for the page", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${base}/web/app/`);
  await page.click('#machines-open');
  await page.locator('.machines nav').waitFor();
  const r = await page.evaluate(() => {
    const nav = document.querySelector('.machines nav')!;
    const by = nav.getAttribute('aria-labelledby');
    return {
      nav: nav.getAttribute('aria-label') ?? (by ? document.getElementById(by)?.textContent?.trim() : undefined),
      headings: [...document.querySelectorAll('.machines :is(h1, h2, h3, h4)')].map((h) => `${h.tagName}:${h.textContent?.trim()}`),
    };
  });
  assert.equal(r.nav, t('machines:MachinesPage.heading'));
  assert.deepEqual(r.headings.slice(0, 2), [`H2:${t('machines:MachinesPage.heading')}`, `H3:${t('machines:MachinesNav.heading')}`]);
  assert.ok(r.headings.slice(2).every((h) => h.startsWith('H3:')), JSON.stringify(r.headings));
  await page.close();
});

/** A page with the first message (open a disk image) landed, its slide down done. */
async function withMessage(o: { reducedMotion?: 'reduce' } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, ...o });
  await page.goto(`${base}/web/app/`);
  await page.locator('#message:not([hidden]) #message-actions button').waitFor();
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
  return page;
}
/** Clicks `sel`, then waits a frame: the bars' 250 ms move under way. */
const clickNow = (sel: string) => `document.querySelector(${JSON.stringify(sel)}).click(); await new Promise((r) => requestAnimationFrame(() => r()));`;
const settled = 'await new Promise((r) => setTimeout(r, 400));';

test('the message moving to the Home page: one #message-text, the new one, during the move', async () => {
  const page = await withMessage();
  const r = await page.evaluate(`(async () => { ${clickNow('#machines-open')} return [...document.querySelectorAll('[id=message-text], [id=message-details]')].map((e) => e.closest('.machines') ? 'home' : 'floating'); })()`);
  assert.deepEqual(r, ['home']);
  await page.close();
});

test('the message moving to the Home page with prefers-reduced-motion: a fade, nothing moves', async () => {
  const page = await withMessage({ reducedMotion: 'reduce' });
  const moves = await page.evaluate(`(async () => { ${clickNow('#machines-open')} return [...document.querySelectorAll('.banner')].flatMap((b) => b.getAnimations().flatMap((a) => a.effect.getKeyframes())).filter((k) => k.transform && k.transform !== 'none').length; })()`);
  assert.equal(moves, 0);
  await page.close();
});

test('the Home page closed and opened again within the move: in the flow, not left fixed where it was', async () => {
  const page = await withMessage();
  await page.click('#machines-open');
  await page.locator('.machines [data-action=back]').waitFor();
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
  const r = await page.evaluate(`(async () => { ${clickNow('.machines [data-action=back]')} ${clickNow('#machines-open')} ${settled} return [...document.querySelectorAll('.machines')].map((e) => e.style.position + '|' + getComputedStyle(e).position); })()`);
  assert.deepEqual(r, ['|static']);
  await page.close();
});

test("a notice's countdown goes on where it was when the bar moves to the Home page", async () => {
  const page = await withMessage();
  const r = await page.evaluate(async () => {
    const { Messages } = await import('/web/app/run/messages.ts' as string);
    new Messages({ spec: {} }, () => undefined).notify('notice-1');
    const ring = () => [...document.querySelectorAll('.ring circle')].map((c) => Number(c.getAnimations()[0]?.currentTime ?? -1));
    await new Promise((res) => setTimeout(res, 1500));
    const before = ring();
    (document.getElementById('machines-open') as HTMLElement).click();
    await new Promise((res) => setTimeout(res, 400));
    return { before, after: ring() };
  });
  assert.equal(r.after.length, 1, JSON.stringify(r));
  assert.ok(r.before[0] >= 1400 && r.after[0] >= 1800, JSON.stringify(r));
  await page.close();
});
