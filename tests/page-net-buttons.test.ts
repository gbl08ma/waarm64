// The toolbar's Network buttons in Chromium (web/app/Network.svelte, Toolbar.svelte; docs/frontend.md "Network"), on a
// stored machine with four adapters and a blank disk (the firmware runs, no guest): a button per adapter, each with
// its number, where the toolbar keeps to one row with them, its menu that adapter's alone; one button with every
// adapter's section where they'd wrap; and a menu's panel that ends inside the window, scrolling its contents, the page
// not scrolling. Before a machine's first start (no disk: it waits) its adapters aren't known: no Network button.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { t } from '../web/i18n.ts';

const FIRMWARE = new URL('../target/images/edk2/QEMU_EFI.fd', import.meta.url);
const skip = !existsSync(FIRMWARE) ? 'SKIPPED: run images/build.sh edk2' : undefined;

let browser: Browser;
let base: string;
let close: () => void;
before(async () => {
  if (skip) return;
  const server = await startServer();
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
});
after(async () => { await browser?.close(); close?.(); });

/** A stored machine with four adapters and a blank disk (`disk` false: none), made through the page's own code. */
function seed(page: Page, disk = true): Promise<string> {
  return page.evaluate(async ([modules, disk]) => {
    const { Store } = await import(modules[0]) as typeof import('../web/app/store.ts');
    const { attach, createDisk, createMachine, updateMachine, withAdapter } = await import(modules[1]) as typeof import('../web/app/machines.ts');
    const store = await Store.open();
    let m = await createMachine(store, { name: 'Four adapters', ncpus: 1, ramMiB: 256, display: '2d', usb: false });
    if (disk) await attach(store, m, await createDisk(store, { kind: 'blank', size: 64 << 20, name: 'Four disk' }));
    m = (await store.get('machines', m.id))!;
    for (let i = 0; i < 4; i++) m = withAdapter(m);
    await updateMachine(store, m);
    store.close();
    return m.id;
  }, [['/web/app/store.ts', '/web/app/machines.ts'], disk] as const);
}

/** The toolbar's network menus: their ids, the number on their buttons, the adapters' sections each holds, and open. */
const menus = (page: Page) => page.$$eval('header.toolbar > [data-net-menu]', (ms) => ms.map((m) => ({
  id: m.id,
  digit: m.querySelector('summary .digit')?.textContent ?? '',
  sections: [...m.querySelectorAll('section.net-adapter')].map((s) => (s as HTMLElement).dataset.adapter),
  open: (m as HTMLDetailsElement).open,
})));
const opened = async (page: Page) => (await menus(page)).map((m) => m.open);
/** The toolbar's rows: its children's distinct middles (a row centers them). */
const rows = (page: Page) => page.$eval('header.toolbar', (h) => new Set([...h.children].map((c) => c.getBoundingClientRect())
  .filter((r) => r.width).map((r) => Math.round(r.top + r.height / 2))).size);

test('the Network buttons: one per adapter where they fit, one for all where they would wrap; a panel that scrolls', { skip, timeout: 120_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1800, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/web/app/`);
  const id = await seed(page);
  await page.goto(`${base}/web/app/?m=${id}`);
  await page.waitForFunction(() => ['booting', 'running'].includes(document.getElementById('state')?.dataset.state ?? ''), null, { timeout: 60_000 });

  // Wide: a button each, numbered, adapter 1's `#network`; each menu has its own adapter alone.
  await page.waitForFunction(() => document.querySelectorAll('header.toolbar > [data-net-menu]').length === 4, null, { timeout: 10_000 });
  assert.deepEqual(await menus(page), [0, 1, 2, 3].map((i) => ({ id: i ? `network-${i}` : 'network', digit: `${i + 1}`, sections: [`${i}`], open: false })),
    'a menu each, with its adapter alone');
  assert.equal(await rows(page), 1, 'the toolbar is one row');
  assert.equal(await page.locator('#network-2 summary').getAttribute('title'), t('network:Network.title.adapter', { adapter: 3 }));
  await page.locator('#network-2 summary').click();
  assert.deepEqual(await opened(page), [false, false, true, false]);
  assert.ok((await page.locator('#network-2 .net-head').textContent() ?? '').includes(t('network:NetAdapter.adapter', { adapter: 3 })), 'headed by its number');
  await page.locator('#network-1 summary').click();
  assert.deepEqual(await opened(page), [false, true, false, false], 'one menu open at a time');
  await page.locator('#network-1 summary').click();
  assert.deepEqual(await opened(page), [false, false, false, false]);

  // Narrow: the buttons would wrap, so one has them all, unnumbered, a section each. The window's width is the
  // toolbar's one row less two adapters' buttons: room for the single one, not for four.
  const width = await page.$eval('header.toolbar', (h) => {
    const s = getComputedStyle(h);
    const gap = parseFloat(s.columnGap);
    const shown = [...h.children].filter((c) => c.getBoundingClientRect().width);
    const net = shown.filter((c) => (c as HTMLElement).dataset.netMenu !== undefined).map((c) => c.getBoundingClientRect().width);
    const all = shown.reduce((w, c) => w + c.getBoundingClientRect().width + parseFloat(getComputedStyle(c).marginLeft) + parseFloat(getComputedStyle(c).marginRight), 0)
      + gap * (shown.length - 1) + parseFloat(s.paddingLeft) + parseFloat(s.paddingRight);
    return Math.floor(all - 2 * (Math.max(...net) + gap)) + (innerWidth - h.clientWidth);
  });
  await page.setViewportSize({ width, height: 400 });
  await page.waitForFunction(() => document.querySelectorAll('header.toolbar > [data-net-menu]').length === 1, null, { timeout: 5_000 });
  assert.deepEqual(await menus(page), [{ id: 'network', digit: '', sections: ['0', '1', '2', '3'], open: false }]);
  assert.equal(await rows(page), 1, 'one row with the single button');
  await page.locator('#network summary').click();
  // The menu's state follows the toggle event, a task later; the panel's cap follows the state.
  await page.waitForFunction(() => !!document.querySelector<HTMLElement>('#network > .items')?.style.getPropertyValue('--menu-top'), null, { timeout: 5_000 });
  assert.deepEqual(await opened(page), [true]);
  // The panel ends inside the window and scrolls; the page doesn't.
  const fit = await page.$eval('#network > .items', (p) => ({ bottom: p.getBoundingClientRect().bottom, scroll: p.scrollHeight > p.clientHeight,
    window: innerHeight, page: document.scrollingElement!.scrollHeight }));
  assert.ok(fit.bottom <= fit.window, `the panel ends inside the window: ${JSON.stringify(fit)}`);
  assert.ok(fit.scroll, `its contents scroll: ${JSON.stringify(fit)}`);
  assert.ok(fit.page <= fit.window, `the page doesn't: ${JSON.stringify(fit)}`);
  await page.locator('#network summary').click();

  // Wide again: a button each.
  await page.setViewportSize({ width: 1800, height: 900 });
  await page.waitForFunction(() => document.querySelectorAll('header.toolbar > [data-net-menu]').length === 4, null, { timeout: 5_000 });
  assert.deepEqual(errors, []);
  await page.close();
});

test('no Network button before the machine first starts: its adapters are not known yet', { skip, timeout: 60_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1800, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/web/app/`);
  const id = await seed(page, false);
  await page.goto(`${base}/web/app/?m=${id}`);
  await page.waitForFunction(() => document.getElementById('state')?.dataset.state === 'idle', null, { timeout: 30_000 });
  assert.equal(await page.locator('header.toolbar > [data-net-menu]').count(), 0, 'no Network button');
  assert.deepEqual(errors, []);
  await page.close();
});
