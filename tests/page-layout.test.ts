// The page's frames in Chromium, without a guest: every pane of the Machines page (web/app/ui/Pane.svelte) puts its title
// at the same place, and its body at the same place under a head of one line, whether or not the head has buttons; the
// message's text (#message) is centered on its buttons while it is one line.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, type Browser } from 'playwright-core';
import { startServer } from '../tools/serve.ts';

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

test("the Machines page's panes: the title and the body at one place, with buttons in the head or none", async () => {
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
