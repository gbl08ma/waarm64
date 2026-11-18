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

/**
 * A font as tall as some systems' `system-ui` (Noto Sans's ascent and descent, 1.36 em): its inline boxes nearly fill
 * the page's line height, so a pill's frame past them overflowed the message's box (a scrollbar beside its words).
 */
const TALL_FONT = `@font-face { font-family: Tall; src: local('DejaVu Sans'), local('Noto Sans'), local('Liberation Sans'), local('Arial');
  ascent-override: 107%; descent-override: 29%; line-gap-override: 0%; }
:root { --font: Tall, system-ui, sans-serif; }`;

test('the references in words: no pill overflows the message or makes its line taller, at any of the text sizes', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${base}/web/app/`);
  await page.locator('#message:not([hidden]) #message-actions button').waitFor();
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
  await page.addStyleTag({ content: TALL_FONT });
  assert.ok(await page.evaluate(async () => (await document.fonts.load('14px Tall')).length > 0), 'the tall font loads');
  /** The message's overflow, its lines' count and height, and the pills in it, at each text size. */
  const measure = () =>
    page.evaluate(async () => {
      const out: string[] = [];
      const body = document.getElementById('message-body')!;
      const text = document.getElementById('message-text')!;
      for (const size of ['xs', 'sm', 'md', 'base', 'lg']) {
        text.style.fontSize = `var(--text-${size})`;
        await new Promise((r) => requestAnimationFrame(r));
        const lh = parseFloat(getComputedStyle(text).lineHeight);
        // The lines: the distinct baselines (bottoms) of the words' own boxes, not their elements'.
        const bottoms: number[] = [];
        const walk = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          const range = document.createRange();
          range.selectNodeContents(n);
          for (const r of range.getClientRects()) if (r.width) bottoms.push(r.bottom);
        }
        bottoms.sort((a, b) => a - b);
        const lines = bottoms.filter((b, i) => !i || b - bottoms[i - 1] > lh / 2).length;
        const pills = text.querySelectorAll('.ui, .name').length;
        const height = text.getBoundingClientRect().height;
        if (body.scrollHeight > body.clientHeight) out.push(`${size}: overflows by ${body.scrollHeight - body.clientHeight}px`);
        if (Math.abs(height - lines * lh) > 0.5) out.push(`${size}: ${lines} lines of ${lh}px are ${height}px`);
        if (!pills) out.push(`${size}: no pills`);
      }
      text.style.fontSize = '';
      return out;
    });
  // The first visit's message (Open disk…), then messages with several pills: names, the page's elements, an icon.
  assert.deepEqual(await measure(), [], 'the first message');
  for (const m of [{ key: 'disks:changes.notChanges', params: { name: 'disk.qcow2' } }, { key: 'snapshots:snapshot-file.notSnapshot' }]) {
    await page.evaluate(async (m) => {
      const { Messages } = await import('/web/app/run/messages.ts' as string);
      new Messages({ spec: {} }, () => undefined).notify(m);
      await new Promise((r) => requestAnimationFrame(r));
      // The bars' moves, not the notice's countdown (its ring's 15 s).
      await Promise.all([...document.querySelectorAll('.banner')].flatMap((b) => b.getAnimations().map((a) => a.finished)));
    }, m);
    assert.deepEqual(await measure(), [], m.key);
  }
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
  // Relative, not absolute: timers run late under load. A restarted ring would be below where it was.
  assert.ok(r.before[0] >= 1000 && r.after[0] >= r.before[0] + 200, JSON.stringify(r));
  await page.close();
});
