// The Home page's levels in Chromium (docs/frontend.md "The Home page"; web/app/areas/machines-nav.svelte.ts,
// web/app/areas/home-levels.ts, HomeColumn.svelte), without a guest: two stored machines without disks, Alpha on the
// page (`?m=`) and Bravo with a room connection attached, and a tailnet connection besides (neither ever connects).
// At the root, Back to the machine is the column's first entry. A reload on a connection's address opens its page
// (Back to Connections, Details chosen, its machines linked, why its live values are missing, its room's link); the
// column's entries and the pane slide as a level is entered; Esc and Back return to Connections, the card's Details
// taking the focus back; a section is chosen instantly and in the address; Domains is a room's alone; Bravo's link
// leads to its Network tab, and a page entered from there or from the machine's screen leads back there; an unknown
// id opens Connections.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
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

type Seeded = { alpha: string; bravo: string; room: string; tailnet: string; link: string };
const LINK = 'waarm64-room:test-lan-abcdefghijklmnopqrstuvwxyz?nostr=wss%3A%2F%2Frelay.invalid'; // i18n-ignore: a link

/** The two machines and the two connections, made through the page's own code (`Page` types the modules: tsc can't resolve the page's URLs). */
async function seed(page: Page): Promise<Seeded> {
  return page.evaluate(async ([modules, link]) => {
    const { Store } = await import(modules[0]) as typeof import('../web/app/store.ts');
    const { createMachine, setAdapterConnection } = await import(modules[1]) as typeof import('../web/app/machines.ts');
    const { page: p } = await import(modules[2]) as typeof import('../web/app/page.ts');
    const store = await Store.open();
    const alpha = (await createMachine(store, { name: 'Alpha', ncpus: 1, ramMiB: 256, display: '2d', usb: false })).id;
    const bravo = (await createMachine(store, { name: 'Bravo', ncpus: 1, ramMiB: 256, display: '2d', usb: false })).id;
    const room = (await p.netCreate({ kind: 'room', name: 'test lan', room: { link, incoming: true, relayOnly: false } })).id;
    const tailnet = (await p.netCreate({ kind: 'tailnet', name: 'tails', tailnet: { controlURL: 'http://127.0.0.1:1', hostname: 'h', exitNode: '' } })).id;
    await setAdapterConnection(store, bravo, 0, room);
    store.close();
    return { alpha, bravo, room, tailnet, link };
  }, [['/web/app/store.ts', '/web/app/machines.ts', '/web/app/page.ts'], LINK] as const);
}

const text = async (page: Page, sel: string) => ((await page.locator(sel).textContent()) ?? '').trim();
/** The column's levels in the DOM (two while one leaves and another comes in), once the move is over. */
const settled = (page: Page) => page.waitForFunction(() => document.querySelectorAll('.machines nav [data-level]').length === 1, null, { timeout: 5000 });
const level = async (page: Page) => { await settled(page); return page.locator('.machines nav [data-level]').getAttribute('data-level'); };
const hash = (page: Page) => page.evaluate(() => location.hash);
/** Calls `page.openConnection` as the toolbar's Details… and a machine's tab do. */
const openConnection = (page: Page, id: string, from: unknown) =>
  page.evaluate(async ([id, from]) => {
    const { page: p } = await import('/web/app/page.ts' as string) as typeof import('../web/app/page.ts');
    p.openConnection(id, 'details', from as Parameters<typeof p.openConnection>[2]);
  }, [id, from] as const);

test("Home's levels: a connection's page by its address, Back and Esc to each origin, the column's swap", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${base}/web/app/`);
  await page.waitForFunction(() => !!document.getElementById('machines-open'));
  const s = await seed(page);

  // A reload on a room connection's address: its page, entered from Connections.
  await page.goto(`${base}/web/app/?m=${s.alpha}#home/connections/${s.room}`);
  await page.locator('[data-context-connection]').waitFor({ timeout: 30_000 });
  assert.equal(await level(page), `connection:${s.room}`);
  assert.equal(await hash(page), `#home/connections/${s.room}`);
  const back = page.locator('.machines nav [data-action=back]');
  assert.equal(await back.getAttribute('data-back'), 'connections');
  assert.equal(await text(page, '.machines nav [data-action=back]'), t('machines:ConnectionNav.back.connections'));
  assert.equal(await text(page, '[data-context-connection] h3'), 'test lan');
  assert.deepEqual(await page.locator('[data-section]').evaluateAll((b) => b.map((x) => (x as HTMLElement).dataset.section)), ['details', 'settings', 'domains']);
  assert.equal(await page.locator('[data-section=details]').getAttribute('aria-current'), 'page');
  assert.equal(await text(page, '#connection-details-machines'), t('machines:ConnectionDetails.machines', { machines: ['Bravo'] }));
  assert.equal(await page.locator(`#connection-details-machines [data-machine-tab="${s.bravo}"]`).count(), 1, 'Bravo is a link');
  assert.equal(await text(page, '#net-details-elsewhere'), t('machines:ConnectionDetails.notHere'));
  assert.equal(await page.locator('#net-details-room-link').inputValue(), s.link);

  // A section: instant, in the address; Esc leaves for Connections, the card's Details taking the focus back.
  await page.locator('[data-section=domains]').click();
  assert.equal(await hash(page), `#home/connections/${s.room}/domains`);
  assert.equal(await page.locator('.machines nav [data-level]').count(), 1, 'a section is no move between levels');
  await page.locator('section[data-selected=connection-domains]').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await level(page), 'root');
  assert.equal(await hash(page), '#home');
  await page.locator('section[data-selected=connections]').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.closest('[data-connection]')?.getAttribute('data-connection')), s.room);

  // At the root, Back to the machine is the column's first entry.
  assert.equal(await page.locator('.machines nav [data-level] > :first-child [data-action=back-to-machine]').count(), 1);

  // A card's Details: the column swaps, the old entries and the new ones side by side while they slide.
  const during = await page.evaluate(async (id) => {
    (document.querySelector(`[data-connection="${id}"] [data-action=connection-details]`) as HTMLElement).click();
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    return [...document.querySelectorAll('.machines nav [data-level]')].map((e) => (e as HTMLElement).dataset.level);
  }, s.tailnet);
  assert.deepEqual(during.sort(), [`connection:${s.tailnet}`, 'root'].sort());
  assert.equal(await level(page), `connection:${s.tailnet}`);
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'H3', "the pane's title has the focus");
  assert.equal(await page.locator('[data-section=domains]').count(), 0, 'a tailnet has no Domains');
  await page.locator('[data-section=settings]').click();
  assert.equal(await hash(page), `#home/connections/${s.tailnet}/settings`);
  await back.click();
  assert.equal(await level(page), 'root');

  // Bravo's link: its Network tab. Entered from there, Back returns there.
  await page.locator(`[data-connection="${s.room}"] [data-action=connection-details]`).click();
  await page.locator(`[data-machine-tab="${s.bravo}"]`).click();
  assert.equal(await level(page), 'root');
  await page.locator(`section[data-selected="${s.bravo}"] [data-tab=network][aria-selected=true]`).waitFor();
  await openConnection(page, s.room, { to: 'tab', machine: s.bravo });
  assert.equal(await level(page), `connection:${s.room}`);
  assert.equal(await text(page, '.machines nav [data-action=back]'), t('machines:ConnectionNav.back.machine', { machine: 'Bravo' }));
  await page.keyboard.press('Escape');
  await page.locator(`section[data-selected="${s.bravo}"] [data-tab=network][aria-selected=true]`).waitFor();
  assert.equal(await hash(page), '#home');

  // From the machine's screen (the toolbar's Details…): Back to the machine closes Home.
  await page.locator('[data-action=back-to-machine]').click();
  assert.equal(await page.locator('#machines-open').getAttribute('aria-pressed'), 'false');
  await openConnection(page, s.room, { to: 'screen' });
  await page.locator('[data-context-connection]').waitFor();
  assert.equal(await text(page, '.machines nav [data-action=back]'), t('machines:MachinesNav.back'));
  await back.click();
  assert.equal(await page.locator('#machines-open').getAttribute('aria-pressed'), 'false');
  assert.equal(await hash(page), '');
  // Home opens at its root next time.
  await page.locator('#machines-open').click();
  assert.equal(await level(page), 'root');

  // An unknown id opens Connections.
  await page.goto(`${base}/web/app/?m=${s.alpha}#home/connections/gone`);
  await page.locator('section[data-selected=connections]').waitFor({ timeout: 30_000 });
  assert.equal(await level(page), 'root');
  assert.equal(await hash(page), '#home');
  await page.close();
});
