// The page's frames in Chromium, without a guest: every pane of the Home page (web/app/ui/Pane.svelte) puts its title
// at the same place, and its body at the same place under a head of one line, whether or not the head has buttons; the
// message's text (#message) is centered on its buttons while it is one line; and the veil over the screen and the
// terminal of a machine that doesn't run (web/app/StateVeil.svelte).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, type Browser } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
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
after(async () => { await browser?.close(); close?.(); });

test("the Home page's panes: the title and the body at one place, with buttons in the head or none", async () => {
  // Wide enough that every pane's head is one line.
  const page = await browser.newPage({ viewport: { width: 2400, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/web/app/?autostart=1`);
  await openHome(page);
  await newEmptyMachine(page);
  await page.locator('section.machine[data-selected] [data-tab=settings]').waitFor();
  // Every pane (Demos isn't one: it opens the demo store's page in Home's place, tests/page-demos.test.ts).
  const ids = (await page.$$eval('nav [data-machine]', (bs) => bs.map((b) => (b as HTMLElement).dataset.machine!))).filter((id) => id !== 'demos');
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
  await page.goto(`${base}/web/app/?autostart=1`);
  await page.locator('#message:not([hidden]) #message-actions button').waitFor();
  // Where it lands: its slide down from above the page (ui/crossfade.ts) done.
  await page.locator('#message .banner').evaluate((e) => Promise.all(e.getAnimations().map((a) => a.finished)));
  const mid = (sel: string) => page.locator(sel).first().evaluate((e) => { const r = e.getBoundingClientRect(); return r.top + r.height / 2; });
  const [text, button, close] = [await mid('#message-body'), await mid('#message-actions button'), await mid('#message-close')];
  const [height, line] = await page.locator('#message-text').evaluate((e) => [e.getBoundingClientRect().height, parseFloat(getComputedStyle(e).lineHeight)]);
  assert.ok(height < 1.5 * line, `one line: ${height}px, a line ${line}px`);
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
  await page.goto(`${base}/web/app/?autostart=1`);
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
  await page.goto(`${base}/web/app/?autostart=1`);
  await openHome(page);
  await newEmptyMachine(page);
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
  await page.goto(`${base}/web/app/?autostart=1`);
  await openHome(page);
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
  await page.goto(`${base}/web/app/?autostart=1`);
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
  await openHome(page);
  await page.locator('#wordmark[data-action=back]').waitFor();
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
  const r = await page.evaluate(`(async () => { ${clickNow('#wordmark[data-action=back]')} ${clickNow('#machines-open')} ${settled} return [...document.querySelectorAll('.machines')].map((e) => e.style.position + '|' + getComputedStyle(e).position); })()`);
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
    // The move ended (under load it outlasts the 400 ms, the outgoing bar's ring still there): every animation but the rings'.
    const moving = document.getAnimations().filter((a) => !((a.effect as KeyframeEffect | null)?.target instanceof SVGCircleElement));
    await Promise.all(moving.map((a) => a.finished.catch(() => undefined)));
    // And the outgoing bar removed, a task or two after its outro ends (later under load).
    for (const end = performance.now() + 3000; ring().length > 1 && performance.now() < end; ) await new Promise((res) => setTimeout(res, 20));
    return { before, after: ring() };
  });
  assert.equal(r.after.length, 1, JSON.stringify(r));
  // Relative, not absolute: timers run late under load. A restarted ring would be below where it was.
  assert.ok(r.before[0] >= 1000 && r.after[0] >= r.before[0] + 200, JSON.stringify(r));
  await page.close();
});

test("a machine that doesn't run: the veil over the screen and the terminal, its state on a plaque as the boot card's", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/web/app/?autostart=1`);
  await page.locator('#screen-frame [data-state-veil]').waitFor();
  /** The page's areas' state, changed by `f` (the dev server gives the page and these imports one module each). */
  const setUi = (f: string) => page.evaluate(async (f) => {
    const area = (name: string) => import(`/web/app/areas/${name}.svelte.ts`);
    new Function('a', f)({ ...(await area('power')), ...(await area('screen')), ...(await area('boot-card')) });
  }, f);
  /** What shows: the veils (the screen's, the terminal's), the plaques' words, and the picture's and the text's filters once settled. */
  const shown = async () => {
    await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
    return page.evaluate(() => {
      const veil = (sel: string) => document.querySelector<HTMLElement>(`${sel} [data-state-veil]`);
      const of = (v: HTMLElement | null) => v && { veil: v.dataset.stateVeil, cover: v.dataset.cover !== undefined, words: v.querySelector('[data-veil-title]')?.textContent, opacity: getComputedStyle(v).opacity };
      const filter = (sel: string) => getComputedStyle(document.querySelector(sel)!).filter;
      return { screen: of(veil('#screen-frame')), terminal: of(veil('#terminal')), picture: filter('#screen'), text: filter('#terminal .xterm') };
    });
  };
  const words = (s: string) => t(`machine:messages.state.${s}`);

  // No machine yet: nothing to see of one, and the state in the screen's middle.
  let s = await shown();
  assert.deepEqual(s.screen, { veil: 'idle', cover: true, words: words('idle'), opacity: '1' });
  assert.equal(s.picture, 'brightness(0)');
  // Suspended: the picture and the terminal's text stay, dimmed and without their colors; the plaque is the screen's
  // while both show, and the terminal's when it shows alone.
  await setUi(`a.power.state = 'suspended'; a.screen.view = 'both';`);
  s = await shown();
  assert.deepEqual(s.screen, { veil: 'suspended', cover: false, words: words('suspended'), opacity: '1' });
  assert.deepEqual(s.terminal, { veil: 'suspended', cover: false, words: undefined, opacity: '1' });
  assert.match(s.picture, /grayscale\(1\) brightness\(0\.\d+\)/);
  assert.equal(s.text, s.picture);
  // Resume on the plaque, which takes the pointer (the veil lets it through), and in the toolbar.
  const resume = page.locator('#screen-frame [data-action=resume]');
  assert.equal((await resume.textContent())?.trim(), t('machine:StateVeil.resume'));
  assert.equal(await resume.evaluate((b) => { const r = b.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('button') === b; }), true, 'the button takes the pointer');
  assert.equal(await page.locator('#restart').textContent(), t('toolbar:Toolbar.resume'));
  await setUi(`a.screen.view = 'terminal';`);
  assert.equal((await shown()).terminal?.words, words('suspended'));
  // Off: no picture (the screen's last frame is covered), the terminal's text as a suspended machine's.
  await setUi(`a.power.state = 'off'; a.screen.view = 'both';`);
  s = await shown();
  assert.deepEqual(s.screen, { veil: 'off', cover: true, words: words('off'), opacity: '1' });
  assert.equal(s.picture, 'brightness(0)');
  assert.deepEqual(s.terminal, { veil: 'off', cover: false, words: undefined, opacity: '1' });
  assert.match(s.text, /grayscale/);
  assert.equal(await page.locator('[data-action=resume]').count(), 0, 'Resume is a suspended machine\'s');
  assert.equal(await page.locator('#restart').textContent(), t('toolbar:Toolbar.start'));
  // Running: neither.
  await setUi(`a.power.state = 'running'; a.screen.view = 'screen';`);
  s = await shown();
  assert.deepEqual([s.screen, s.terminal, s.picture, s.text], [null, null, 'none', 'none']);
  // Held still for a snapshot: the hatch alone, no plaque, and not at once (a short save doesn't flash).
  await setUi(`a.power.paused = true;`);
  const early = await page.evaluate(() => ({ opacity: getComputedStyle(document.querySelector('#screen-frame [data-state-veil]')!).opacity, picture: getComputedStyle(document.querySelector('#screen')!).filter }));
  assert.equal(early.opacity, '0', 'no hatch yet at the start of the pause');
  assert.match(early.picture, /^(none|grayscale\(0\) brightness\(1\))$/, 'the picture as it was at the start of the pause');
  s = await shown();
  assert.deepEqual(s.screen, { veil: 'paused', cover: false, words: undefined, opacity: '1' });
  assert.match(s.picture, /grayscale/);
  await setUi(`a.power.paused = false;`);
  assert.equal((await shown()).screen, null);
  // Starting: the boot card's words on the same plaque, over no picture.
  await setUi(`a.power.state = 'booting'; a.bootCard.shown = true; a.bootCard.title = 'x';`);
  const [boot, plaque] = await page.evaluate(() => {
    const look = (e: Element) => { const c = getComputedStyle(e); return `${c.backgroundColor} ${c.borderRadius} ${c.boxShadow}`; };
    const card = document.querySelector('#boot > .plaque');
    return [card && !document.getElementById('boot')!.hidden && card.contains(document.getElementById('boot-title')) && look(card), ''];
  });
  await setUi(`a.bootCard.shown = false; a.power.state = 'off';`);
  const stopped = await page.evaluate(() => { const c = getComputedStyle(document.querySelector('#screen-frame [data-state-veil] > .plaque')!); return `${c.backgroundColor} ${c.borderRadius} ${c.boxShadow}`; });
  assert.ok(boot, 'the boot card is a plaque');
  assert.equal(boot, stopped + plaque, 'one look for both');
  assert.deepEqual(errors, []);
  await page.close();
});
