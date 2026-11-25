// The Home page's levels in Chromium (docs/frontend.md "The Home page"; web/app/areas/machines-nav.svelte.ts,
// web/app/areas/home-levels.ts, HomeColumn.svelte), without a guest: two stored machines without disks, Alpha on the
// page (`?m=`) and Bravo with a room connection attached, and a tailnet connection besides (neither ever connects).
// At the root, Back to the machine is the column's first entry. A reload on a connection's address opens its page
// (Back to Connections, Details chosen, its machines linked, why its live values are missing, its room's link, its own
// name in the room, its key made for it); the
// column's entries and the pane slide as a level is entered; Esc and Back return to Connections, the card's Details
// taking the focus back; a section is chosen instantly and in the address; Domains is a room's alone; Bravo's link
// leads to its Network tab, and a page entered from there or from the machine's screen leads back there; an unknown
// id opens Connections. Going down a level is an entry of the browser's history: its Back leaves the level for where
// it was entered from, Forward enters it again, the column's Back after a push goes back in the history (no entry left
// over), a section replaces, and after a reload the level is entered from Connections. A connection's Settings save,
// revert and refuse what's wrong; its commands are in its column; the wizard opened on an adapter that has a
// connection asks first whether to edit it (its Settings, Back leading to the machine's tab or screen) or attach another.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { t } from '../web/i18n.ts';
import { answerAsks } from './page-ask.ts';

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
    await setAdapterConnection(store, alpha, 0, tailnet);
    store.close();
    return { alpha, bravo, room, tailnet, link };
  }, [['/web/app/store.ts', '/web/app/machines.ts', '/web/app/page.ts'], LINK] as const);
}

const text = async (page: Page, sel: string) => ((await page.locator(sel).textContent()) ?? '').trim();
/**
 * Waits until the column shows level `want` alone (two levels are in the DOM while one leaves and another comes in, and
 * a move may start a moment after what asked for it: waiting for one level alone could see the old one before it).
 */
async function atLevel(page: Page, want: string, what = '') {
  const now = () => page.evaluate(() => [...document.querySelectorAll('.machines nav [data-level]')].map((l) => l.getAttribute('data-level')));
  try {
    await page.waitForFunction((w) => { const l = document.querySelectorAll('.machines nav [data-level]'); return l.length === 1 && l[0].getAttribute('data-level') === w; }, want, { timeout: 5000 });
  } catch {
    assert.fail(`${what ? `${what}: ` : ''}the column shows ${JSON.stringify(await now())}, not ${want} alone`);
  }
}
const hash = (page: Page) => page.evaluate(() => location.hash);
/** Calls `page.openConnection` as the toolbar's Details… and a machine's tab do. */
const openConnection = (page: Page, id: string, from: unknown) =>
  page.evaluate(async ([id, from]) => {
    const { page: p } = await import('/web/app/page.ts' as string) as typeof import('../web/app/page.ts');
    p.openConnection(id, 'details', from as Parameters<typeof p.openConnection>[2]);
  }, [id, from] as const);
/** The stored connections, as the page's store has them. */
const stored = (page: Page) =>
  page.evaluate(async (m) => {
    const { Store } = await import(m) as typeof import('../web/app/store.ts');
    const store = await Store.open();
    const all = await store.all('connections');
    store.close();
    return all as { id: string; name: string; tailnet?: { hostname: string } }[];
  }, '/web/app/store.ts');
/** A fresh page with the machines and connections seeded, Alpha on it (`?m=`), on `hash`. */
async function seeded(hash = '') {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${base}/web/app/?autostart=1`);
  await page.waitForFunction(() => !!document.getElementById('machines-open'));
  const s = await seed(page);
  await page.goto(`${base}/web/app/?autostart=1&m=${s.alpha}${hash}`);
  await page.waitForFunction(() => !!document.getElementById('machines-open'));
  return { page, s };
}
const backTo = (page: Page) => page.locator('.machines nav [data-action=back]').getAttribute('data-back');
const homeOpen = async (page: Page) => (await page.locator('#machines-open').getAttribute('aria-pressed')) === 'true';

test("Home's levels: a connection's page by its address, Back and Esc to each origin, the column's swap", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${base}/web/app/?autostart=1`);
  await page.waitForFunction(() => !!document.getElementById('machines-open'));
  const s = await seed(page);

  // A reload on a room connection's address: its page, entered from Connections.
  await page.goto(`${base}/web/app/?autostart=1&m=${s.alpha}#home/connections/${s.room}`);
  await page.locator('[data-context-connection]').waitFor({ timeout: 30_000 });
  await atLevel(page, `connection:${s.room}`);
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
  // Its name in the room, though it never connected (the names agent's `member`, its key made under its entry): under
  // the room's tag, the link's ID being a private room's.
  await page.locator('#net-details-room-name').waitFor({ timeout: 30_000 });
  assert.match(await page.locator('#net-details-room-name').inputValue(), /^[a-z2-7]{52}\.[a-z2-7]{8}\.p2p\.internal$/);
  assert.equal(await page.locator('label:has(#net-details-room-name) .name').textContent(), t('network:ConnectionRoom.name'));

  // A section: instant, in the address; Esc leaves for Connections, the card's Details taking the focus back.
  await page.locator('[data-section=domains]').click();
  assert.equal(await hash(page), `#home/connections/${s.room}/domains`);
  assert.equal(await page.locator('.machines nav [data-level]').count(), 1, 'a section is no move between levels');
  await page.locator('section[data-selected=connection-domains]').waitFor();
  await page.keyboard.press('Escape');
  await atLevel(page, 'root');
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
  await atLevel(page, `connection:${s.tailnet}`);
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'H3', "the pane's title has the focus");
  assert.equal(await page.locator('[data-section=domains]').count(), 0, 'a tailnet has no Domains');
  await page.locator('[data-section=settings]').click();
  assert.equal(await hash(page), `#home/connections/${s.tailnet}/settings`);
  await back.click();
  await atLevel(page, 'root');

  // Bravo's link: its Network tab. Entered from there, Back returns there.
  await page.locator(`[data-connection="${s.room}"] [data-action=connection-details]`).click();
  await page.locator(`[data-machine-tab="${s.bravo}"]`).click();
  await atLevel(page, 'root');
  await page.locator(`section[data-selected="${s.bravo}"] [data-tab=network][aria-selected=true]`).waitFor();
  await openConnection(page, s.room, { to: 'tab', machine: s.bravo });
  await atLevel(page, `connection:${s.room}`);
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
  await atLevel(page, 'root');

  // An unknown id opens Connections.
  await page.goto(`${base}/web/app/?autostart=1&m=${s.alpha}#home/connections/gone`);
  await page.locator('section[data-selected=connections]').waitFor({ timeout: 30_000 });
  await atLevel(page, 'root');
  assert.equal(await hash(page), '#home');
  await page.close();
});

test("Home's levels in the browser's history: Back and Forward from each origin, the column's Back, a reload", async () => {
  const { page, s } = await seeded('#home');
  await page.locator('[data-machine="connections"]').click();
  await page.locator('section[data-selected=connections]').waitFor();
  const length = () => page.evaluate(() => history.length);
  const before = await length();

  // From Connections: down pushes, a section replaces; Back leaves for Connections, Forward enters again.
  await page.locator(`[data-connection="${s.room}"] [data-action=connection-details]`).click();
  await atLevel(page, `connection:${s.room}`);
  assert.equal(await length(), before + 1, 'down a level: an entry of its own');
  await page.locator('[data-section=settings]').click();
  assert.equal(await length(), before + 1, 'a section: in place');
  await page.goBack();
  await atLevel(page, 'root');
  assert.equal(await hash(page), '#home');
  await page.locator('section[data-selected=connections]').waitFor();
  await page.goForward();
  await atLevel(page, `connection:${s.room}`);
  assert.equal(await hash(page), `#home/connections/${s.room}/settings`);
  assert.equal(await backTo(page), 'connections', 'entered from Connections again');
  // The column's Back after a push: back in the history, so no entry is left to come back to by mistake.
  await page.locator('.machines nav [data-action=back]').click();
  await atLevel(page, 'root');
  assert.equal(await page.evaluate(() => history.state), null, "Connections' entry, not a new one");
  await page.goForward();
  await atLevel(page, `connection:${s.room}`);
  await page.keyboard.press('Escape');
  await atLevel(page, 'root');

  // From a machine's Network tab: Back returns to the tab, Forward to the page with its Back to the machine.
  await page.locator(`[data-machine="${s.bravo}"]`).click();
  await page.locator('[data-tab=network]').click();
  await openConnection(page, s.room, { to: 'tab', machine: s.bravo });
  await atLevel(page, `connection:${s.room}`);
  await page.goBack();
  await page.locator(`section[data-selected="${s.bravo}"] [data-tab=network][aria-selected=true]`).waitFor();
  await atLevel(page, 'root');
  await page.goForward();
  await atLevel(page, `connection:${s.room}`);
  assert.equal(await backTo(page), 'tab', 'the origin kept in the entry');
  assert.equal(await text(page, '.machines nav [data-action=back]'), t('machines:ConnectionNav.back.machine', { machine: 'Bravo' }));

  // After a reload the level is entered from Connections: its Back replaces, and the browser's Back still leaves it.
  await page.reload();
  await page.locator('[data-context-connection]').waitFor({ timeout: 30_000 });
  assert.equal(await backTo(page), 'connections');
  const reloaded = await length();
  await page.locator('.machines nav [data-action=back]').click();
  await atLevel(page, 'root');
  assert.equal(await length(), reloaded, 'in place');
  assert.equal(await hash(page), '#home');

  // From the machine's screen: Back closes Home, Forward opens the level again, Back to the machine.
  await page.locator('[data-action=back-to-machine]').click();
  assert.equal(await homeOpen(page), false);
  await openConnection(page, s.tailnet, { to: 'screen' });
  await atLevel(page, `connection:${s.tailnet}`);
  await page.goBack();
  await page.waitForFunction(() => document.getElementById('machines-open')?.getAttribute('aria-pressed') === 'false', null, { timeout: 5000 });
  assert.equal(await hash(page), '');
  await page.goForward();
  await atLevel(page, `connection:${s.tailnet}`);
  assert.equal(await backTo(page), 'screen');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.getElementById('machines-open')?.getAttribute('aria-pressed') === 'false', null, { timeout: 5000 });
  await page.close();
});

test("a connection's Settings: its values, Revert, a refusal, Save and a rename; the commands in its column", async () => {
  const { page, s } = await seeded();
  const asked: string[] = [];
  await answerAsks(page, (q) => { asked.push(q.text); });
  await page.evaluate((id) => { location.hash = `#home/connections/${id}/settings`; }, s.tailnet);
  await page.locator('section[data-selected=connection-settings]').waitFor({ timeout: 30_000 });
  assert.equal(await page.locator('#settings-name').inputValue(), 'tails');
  assert.equal(await page.locator('#settings-hostname').inputValue(), 'h');
  assert.equal(await page.locator('#settings-control').isDisabled(), true, 'a new control server needs a new connection');
  const save = page.locator('section[data-selected=connection-settings] [data-action=save]');
  const revert = page.locator('section[data-selected=connection-settings] [data-action=revert]');
  assert.equal(await save.isDisabled(), true, 'nothing to save');
  assert.equal(await revert.count(), 0);
  // Revert drops the draft.
  await page.fill('#settings-hostname', 'other');
  assert.equal(await save.isDisabled(), false);
  await revert.click();
  assert.equal(await page.locator('#settings-hostname').inputValue(), 'h');
  // What's wrong is refused, in the wizard's words, in the Home page's banner; nothing is written. (The message bar's
  // word on Alpha's disks goes first: the banner shows it before an action's error.)
  await page.evaluate(async () => (await import('/web/app/page.ts' as string) as typeof import('../web/app/page.ts')).page.dismiss());
  await page.fill('#settings-hostname', 'no good');
  await save.click();
  await page.waitForFunction((w) => (document.querySelector('.machines-page')?.textContent ?? '').includes(w), t('network:network.badHostname'), { timeout: 5000 })
    .catch(async (e) => { throw new Error(`${e}; the banner says ${await page.locator('.machines-page').textContent().catch(() => 'nothing')}`); });
  assert.equal((await stored(page)).find((c) => c.id === s.tailnet)?.tailnet?.hostname, 'h');
  // Save writes the hostname and the name.
  await page.fill('#settings-hostname', 'box');
  await page.fill('#settings-name', 'Tails two');
  await save.click();
  await page.waitForFunction(() => !document.querySelector('section[data-selected=connection-settings] [data-action=revert]'), null, { timeout: 5000 });
  const tn = (await stored(page)).find((c) => c.id === s.tailnet);
  assert.deepEqual([tn?.name, tn?.tailnet?.hostname], ['Tails two', 'box']);
  assert.equal(await text(page, '[data-context-connection] h3'), 'Tails two', 'the column follows');
  // A rename alone.
  await page.fill('#settings-name', 'Tails');
  await save.click();
  await page.waitForFunction((id) => document.querySelector(`[data-context-connection="${id}"] h3`)?.textContent === 'Tails', s.tailnet, { timeout: 5000 });
  // Leaving the section drops a draft, as a machine's Settings does.
  await page.fill('#settings-hostname', 'dropped');
  await page.locator('[data-section=details]').click();
  await page.locator('[data-section=settings]').click();
  assert.equal(await page.locator('#settings-hostname').inputValue(), 'box');

  // A room's Settings: its switches, and its key under Advanced (made when its Details first showed its name, though it
  // never connected).
  await openConnection(page, s.room, { to: 'connections' });
  await atLevel(page, `connection:${s.room}`);
  await page.locator('[data-section=settings]').click();
  assert.equal(await page.isChecked('#settings-room-direct'), true);
  assert.equal(await page.isChecked('#settings-room-incoming'), true);
  await page.locator('#settings-room-advanced summary').click();
  await page.waitForFunction(() => /^[0-9a-f]{64}$/.test((document.getElementById('settings-room-key-value') as HTMLInputElement).value), null, { timeout: 10_000 });
  assert.equal(await page.locator('#settings-room-new-name').isDisabled(), false, 'a key of its own to drop');
  await page.uncheck('#settings-room-direct');
  await save.click();
  await page.waitForFunction(() => !document.querySelector('section[data-selected=connection-settings] [data-action=revert]'), null, { timeout: 5000 });
  const room = (await stored(page)).find((c) => c.id === s.room) as { room?: { relayOnly: boolean; incoming: boolean } } | undefined;
  assert.deepEqual([room?.room?.relayOnly, room?.room?.incoming], [true, true]);

  // The commands: a room's backup, no Log out without a node, no New address on a room; Delete leaves for Connections.
  const commands = () => page.locator('.machines nav [data-level] [data-action]').evaluateAll((b) => b.map((x) => (x as HTMLElement).dataset.action));
  assert.deepEqual(await commands(), ['back', 'backup-connection', 'delete-connection']);
  assert.equal(await page.locator('.machines nav [data-action=delete-connection]').getAttribute('title'), t('machines:ConnectionsPane.connection.delete.title'));
  await page.locator('.machines nav [data-action=delete-connection]').click();
  await page.locator('section[data-selected=connections]').waitFor({ timeout: 10_000 });
  await atLevel(page, 'root');
  assert.equal(asked.length, 1, 'Delete asks first');
  assert.equal((await stored(page)).some((c) => c.id === s.room), false);
  // A card keeps its name, its line, Details and Delete.
  assert.deepEqual(await page.locator(`[data-connection="${s.tailnet}"] [data-action]`).evaluateAll((b) => b.map((x) => (x as HTMLElement).dataset.action)), ['connection-details', 'delete-connection']);
  await page.close();
});

test('the wizard on an adapter that has a connection asks first: edit it (its Settings, Back to where it was opened) or attach another', async () => {
  const { page, s } = await seeded('#home');
  // Bravo's Network tab: Change… asks; Attach a different connection goes on to the pick step, whose Back returns.
  await page.locator(`[data-machine="${s.bravo}"]`).click();
  await page.locator('[data-tab=network]').click();
  const change = page.locator('[data-adapter="0"] [data-action=attach-connection]');
  await change.click();
  await page.locator('#net-step-change').waitFor({ state: 'visible' });
  assert.equal(await text(page, '#net-wizard-title'), t('network:NetWizard.title.change'));
  assert.equal(await text(page, '#net-change-edit b'), t('network:NetChangeStep.edit', { name: 'test lan' }));
  assert.equal(await page.locator('#net-back').isVisible(), false, 'nothing before it');
  assert.equal(await page.locator('#net-connect').isVisible(), false, 'it only chooses');
  await page.click('#net-change-other');
  assert.equal(await page.locator('#net-step-pick').isVisible(), true);
  assert.equal(await page.locator('[id^=net-pick-edit-]').count(), 0, 'no Edit… on the connections to pick');
  await page.click('#net-back');
  assert.equal(await page.locator('#net-step-change').isVisible(), true, 'Back: the choice again');
  // Edit: the wizard closes for the connection's Settings, Back leading to Bravo's tab.
  await page.click('#net-change-edit');
  await page.locator('section[data-selected=connection-settings]').waitFor();
  assert.equal(await page.evaluate(() => (document.getElementById('net-wizard') as HTMLDialogElement).open), false);
  assert.equal(await hash(page), `#home/connections/${s.room}/settings`);
  assert.equal(await text(page, '.machines nav [data-action=back]'), t('machines:ConnectionNav.back.machine', { machine: 'Bravo' }));
  await page.locator('.machines nav [data-action=back]').click();
  await page.locator(`section[data-selected="${s.bravo}"] [data-tab=network][aria-selected=true]`).waitFor();

  // Opened from the machine's screen (as the toolbar's Network menu opens it: its Change connection… on Alpha's adapter;
  // the menu itself needs a running machine, tests/page-connections.test.ts): Edit leads to the Settings, Back to the
  // screen.
  await page.locator('[data-action=back-to-machine]').click();
  await page.evaluate(async ([alpha, attached]) => {
    const { network } = await import('/web/app/areas/network.ts' as string) as typeof import('../web/app/areas/network.ts');
    network.openWizard({ mode: 'attach', machine: alpha, adapter: 0, attached, from: { to: 'screen' } });
  }, [s.alpha, s.tailnet] as const);
  await page.locator('#net-step-change').waitFor({ state: 'visible' });
  assert.equal(await text(page, '#net-change-edit b'), t('network:NetChangeStep.edit', { name: 'tails' }));
  await page.click('#net-change-edit');
  await page.locator('section[data-selected=connection-settings]').waitFor();
  assert.equal(await backTo(page), 'screen');
  await page.locator('.machines nav [data-action=back]').click();
  await page.waitForFunction(() => document.getElementById('machines-open')?.getAttribute('aria-pressed') === 'false', null, { timeout: 5000 });
  // An adapter without a connection opens as before: on the pick step.
  await page.evaluate(async (alpha) => {
    const { network } = await import('/web/app/areas/network.ts' as string) as typeof import('../web/app/areas/network.ts');
    network.openWizard({ mode: 'attach', machine: alpha, adapter: 1, from: { to: 'screen' } });
  }, s.alpha);
  await page.locator('#net-step-pick').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#net-back').isVisible(), false);
  await page.close();
});

/** The element with the focus: its tag, and the pane (`data-selected`) it is in. */
const focused = (page: Page) => page.evaluate(() => ({ tag: document.activeElement?.tagName, pane: document.activeElement?.closest('section[data-selected]')?.getAttribute('data-selected') }));
const settledFor = (page: Page, ms = 600) => page.waitForTimeout(ms);

test("a machine's draft through a connection's page and back; Home reopens where it was; the focus back on the tab", async () => {
  const { page, s } = await seeded('#home');
  // Bravo's Settings, a name typed (unsaved); its Network tab; the adapter's link to the room's Domains; Back.
  await page.locator(`[data-machine="${s.bravo}"]`).click();
  await page.locator('[data-tab=settings]').click();
  await page.fill('[data-field=name]', 'Bravo edited');
  await page.locator('[data-tab=network]').click();
  await page.locator('[data-adapter="0"] [data-action=domains-link]').click();
  await atLevel(page, `connection:${s.room}`);
  await page.locator('.machines nav [data-action=back]').click();
  await atLevel(page, 'root');
  await page.locator(`section[data-selected="${s.bravo}"] [data-tab=network][aria-selected=true]`).waitFor();
  assert.deepEqual(await focused(page), { tag: 'H3', pane: s.bravo }, "the machine's title has the focus");
  await page.locator('[data-tab=settings]').click();
  assert.equal(await page.locator('[data-field=name]').inputValue(), 'Bravo edited', 'the draft kept');
  const revert = page.locator(`section[data-selected="${s.bravo}"] [data-action=revert]`);
  assert.equal(await revert.count(), 1, 'still a change to save');
  await revert.click();
  assert.equal(await page.locator('[data-field=name]').inputValue(), 'Bravo');
  assert.equal(await revert.count(), 0, 'nothing to save after Revert');

  // Disks chosen, then the machine's screen, a connection's page from there and Back: Home reopens on Disks.
  await page.locator('[data-machine="disks"]').click();
  await page.locator('section[data-selected=disks]').waitFor();
  await page.locator('[data-action=back-to-machine]').click();
  assert.equal(await homeOpen(page), false);
  await openConnection(page, s.room, { to: 'screen' });
  await page.locator('[data-context-connection]').waitFor();
  await page.locator('.machines nav [data-action=back]').click();
  assert.equal(await homeOpen(page), false);
  await page.locator('#machines-open').click();
  await page.locator('section[data-selected=disks]').waitFor({ timeout: 5_000 });
  await page.close();
});

test("Back and Esc twice during a move run once; a link out of a level is an entry; an origin from what Home shows", async () => {
  const { page, s } = await seeded('#home');
  await page.locator('[data-machine="connections"]').click();
  await page.locator('section[data-selected=connections]').waitFor();
  // Back double-clicked: one move, Home still open at Connections.
  await page.locator(`[data-connection="${s.room}"] [data-action=connection-details]`).click();
  await atLevel(page, `connection:${s.room}`);
  await page.locator('.machines nav [data-action=back]').dblclick();
  await settledFor(page);
  assert.equal(await homeOpen(page), true, 'Home still open');
  await atLevel(page, 'root');
  assert.equal(await hash(page), '#home');
  await page.locator('section[data-selected=connections]').waitFor();
  // Esc twice at once: the same.
  await page.locator(`[data-connection="${s.room}"] [data-action=connection-details]`).click();
  await atLevel(page, `connection:${s.room}`);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await settledFor(page);
  assert.equal(await homeOpen(page), true, 'Home still open after two Esc');
  await atLevel(page, 'root');
  assert.equal(await hash(page), '#home');

  // Details' machine link out of a pushed level: an entry of its own, so the browser's Back returns to the level.
  await page.locator(`[data-connection="${s.room}"] [data-action=connection-details]`).click();
  await atLevel(page, `connection:${s.room}`);
  const before = await page.evaluate(() => history.length);
  await page.locator(`[data-machine-tab="${s.bravo}"]`).click();
  await page.locator(`section[data-selected="${s.bravo}"] [data-tab=network][aria-selected=true]`).waitFor();
  assert.equal(await page.evaluate(() => history.length), before + 1);
  await page.goBack();
  await atLevel(page, `connection:${s.room}`, "Back: the connection's page again");
  await page.goBack();
  await atLevel(page, 'root');

  // Home on Bravo's Settings: the toolbar's way in (its origin is what Home shows) leads back to Bravo's Settings.
  await page.locator(`[data-machine="${s.bravo}"]`).click();
  await page.locator('[data-tab=settings]').click();
  await page.evaluate(async (id) => {
    const { page: p } = await import('/web/app/page.ts' as string) as typeof import('../web/app/page.ts');
    const { machinesNav } = await import('/web/app/areas/machines-nav.svelte.ts' as string) as typeof import('../web/app/areas/machines-nav.svelte.ts');
    p.openConnection(id, 'details', machinesNav.origin());
  }, s.room);
  await atLevel(page, `connection:${s.room}`);
  assert.equal(await text(page, '.machines nav [data-action=back]'), t('machines:ConnectionNav.back.machine', { machine: 'Bravo' }));
  await page.locator('.machines nav [data-action=back]').click();
  await page.locator(`section[data-selected="${s.bravo}"] [data-tab=settings][aria-selected=true]`).waitFor();
  assert.equal(await homeOpen(page), true);
  await page.close();
});

test("a connection gone under its page: Home leaves the level for Connections; an unknown id never entered later; machines linked by id", async () => {
  const { page, s } = await seeded('#home');
  await answerAsks(page);
  const inConnections = () => page.waitForFunction(() => document.activeElement?.tagName === 'H3' && document.activeElement.closest('section[data-selected]')?.getAttribute('data-selected') === 'connections', null, { timeout: 5_000 });
  // Delete from its own page, entered from its card: Connections, its title focused, the address Home's root.
  const spare = await page.evaluate(async () => {
    const { page: p } = await import('/web/app/page.ts' as string) as typeof import('../web/app/page.ts');
    return (await p.netCreate({ kind: 'tailnet', name: 'spare', tailnet: { controlURL: 'http://127.0.0.1:1', hostname: 's', exitNode: '' } })).id;
  });
  await page.locator('[data-machine="connections"]').click();
  await page.locator(`[data-connection="${spare}"] [data-action=connection-details]`).click();
  await atLevel(page, `connection:${spare}`);
  await page.locator('.machines nav [data-action=delete-connection]').click();
  await page.locator('section[data-selected=connections]').waitFor({ timeout: 10_000 });
  await atLevel(page, 'root');
  assert.equal(await hash(page), '#home');
  await inConnections();
  // The same entered by its address (another pane chosen before).
  await page.locator(`[data-machine="${s.bravo}"]`).click();
  await page.evaluate((id) => { location.hash = `#home/connections/${id}`; }, s.tailnet);
  await page.locator('[data-context-connection]').waitFor({ timeout: 30_000 });
  const tailnet = (await stored(page)).find((c) => c.id === s.tailnet);
  await page.locator('.machines nav [data-action=delete-connection]').click();
  await page.locator('section[data-selected=connections]').waitFor({ timeout: 10_000 });
  await atLevel(page, 'root');
  assert.equal(await hash(page), '#home');
  await page.waitForFunction(() => document.activeElement?.closest('section[data-selected]')?.getAttribute('data-selected') === 'connections', null, { timeout: 5_000 });
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'H3', "Connections' title has the focus");

  // An address with an id unknown at load: Connections; the connection appearing later doesn't open its page.
  await page.goto(`${base}/web/app/?autostart=1&m=${s.alpha}#home/connections/later`);
  await page.locator('section[data-selected=connections]').waitFor({ timeout: 30_000 });
  await page.evaluate(async (c) => {
    const { page: p } = await import('/web/app/page.ts' as string) as typeof import('../web/app/page.ts');
    await p.netRename(c as Parameters<typeof p.netRename>[0], 'Later');
  }, { ...tailnet, id: 'later' });
  await page.locator('li[data-connection="later"]').waitFor({ timeout: 5_000 });
  await settledFor(page, 300);
  await atLevel(page, 'root', 'not entered unasked');

  // Two machines with one name: each linked to its own Network tab.
  const twin = await page.evaluate(async ([modules, room]) => {
    const { Store } = await import(modules[0]) as typeof import('../web/app/store.ts');
    const { createMachine, setAdapterConnection } = await import(modules[1]) as typeof import('../web/app/machines.ts');
    const store = await Store.open();
    const id = (await createMachine(store, { name: 'Bravo', ncpus: 1, ramMiB: 256, display: '2d', usb: false })).id;
    await setAdapterConnection(store, id, 0, room);
    // Named as the other (a new machine's name is made unique; a rename can still match another's).
    const m = await store.get('machines', id);
    if (m) await store.put('machines', { ...m, name: 'Bravo' });
    store.close();
    return id;
  }, [['/web/app/store.ts', '/web/app/machines.ts'], s.room] as const);
  await page.goto(`${base}/web/app/?autostart=1&m=${s.alpha}#home/connections/${s.room}`);
  await page.locator('#connection-details-machines [data-machine-tab]').first().waitFor({ timeout: 30_000 });
  assert.equal(await text(page, '#connection-details-machines'), t('machines:ConnectionDetails.machines', { machines: ['Bravo', 'Bravo'] }));
  const tabs = await page.locator('#connection-details-machines [data-machine-tab]').evaluateAll((b) => b.map((x) => (x as HTMLElement).dataset.machineTab));
  assert.deepEqual(tabs.sort(), [s.bravo, twin].sort(), 'one link each');
  await page.close();
});
