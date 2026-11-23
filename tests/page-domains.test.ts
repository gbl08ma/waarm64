// A room connection's Domains pane in Chromium (web/app/DomainsPane.svelte, DomainCard.svelte, NameDialog.svelte,
// ConnectionBackup.svelte; docs/networking/names.md "What the user sees"), with the connection never connected and no
// machine on the page: the names agent's worker on the tests' module (target/net/ts-test.wasm in ts.wasm's place: a
// cheap proof of work), the compiled calendars and explorers routed to the pretend ones (tests/net/ots-calendar.ts), the
// room's relays refused (nobody can say whether a domain is free). The first explainer with the connection's own name
// in the room; Register a domain… from the pane, pressed twice (nobody could say); the card Reserved with its date, the
// column's count; a subdomain added and saved, then every point at this connection; the second explainer collapsed;
// the backup (with domains, and an ephemeral connection's without); Let it go; the cards' other states and the upkeep
// line's warning from titles set in the area (the agent's own states are tests/names-agent.test.ts's); an ephemeral
// connection's pane; New name on a connection that holds domains (pointed at the new key, or let go).
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { t } from '../web/i18n.ts';
import type { TitleView } from '../web/names.ts';
import { CALENDARS, EXPLORERS } from '../web/names-fetch.ts';
import { CALENDARS as PRETEND, startOtsCalendar, type OtsCalendar } from './net/ots-calendar.ts';
import { TEST_WASM } from './net/names-agent.ts';
import { ALT, answerAsks, type Question } from './page-ask.ts';
import { words } from './words.ts';

const skip = !existsSync(TEST_WASM) ? 'net/ts/build.sh --test-params' : !existsSync(process.env.CHROMIUM ?? '/usr/bin/chromium') ? 'no Chromium' : false;
const LINK = 'waarm64-room:gabriel-lan?nostr=ws%3A%2F%2F127.0.0.1%3A9&derp=127.0.0.1%3A9'; // i18n-ignore: a link

let browser: Browser;
let cal: OtsCalendar;
let base = '';
let closeServer = () => {};
before(async () => {
  if (skip) return;
  cal = await startOtsCalendar({ depth: 6 });
  const server = await startServer();
  closeServer = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
});
after(async () => {
  await browser?.close();
  closeServer();
  await cal?.close();
});

/** A browser profile with the services routed (names-browser.test.ts's): anything else outside the page is refused;
 * a calendar's stamp waits while `hold.stamps` is set (a release's work that takes long). */
async function profile(hold: { stamps?: Promise<void> } = {}): Promise<BrowserContext> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const map: [string, string][] = [...CALENDARS.map((c, i): [string, string] => [c, cal.calendars[PRETEND[i]]]), ...EXPLORERS.map((e): [string, string] => [e, cal.explorer])];
  await ctx.route('**/target/net/ts.wasm', (r) => r.fulfill({ path: TEST_WASM, contentType: 'application/wasm' }));
  await ctx.route((u) => u.origin !== base, async (r) => {
    const url = r.request().url();
    const to = map.find(([from]) => url.startsWith(`${from}/`));
    if (!to) return r.abort();
    if (url.endsWith('/digest')) await hold.stamps;
    await r.fulfill({ response: await r.fetch({ url: to[1] + url.slice(to[0].length) }) });
  });
  return ctx;
}

const text = async (page: Page, sel: string) => ((await page.locator(sel).textContent()) ?? '').replace(/\s+/g, ' ').trim();
const card = (name: string) => `#domains [data-name="${name}"]`;
const stateOf = (page: Page, name: string) => page.locator(card(name)).getAttribute('data-state');
/** The titles the names agent keeps, as the page reads them. */
const titles = (page: Page) => page.evaluate(() => import('/web/names.ts' as string).then((n: typeof import('../web/names.ts')) => n.namesAgent().titles())) as Promise<TitleView[]>;

test("a room connection's Domains pane, never connected and no machine running: explain, register, point, back up, let go", { skip, timeout: 180_000 }, async () => {
  const ctx = await profile();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`# page error: ${e}`));
  await answerAsks(page);
  await page.goto(`${base}/web/app/?autostart=1`);
  await page.waitForFunction(() => !!document.getElementById('machines-open'));
  const id = await page.evaluate(async ([m, link]) => {
    const { page: p } = await import(m) as typeof import('../web/app/page.ts');
    return (await p.netCreate({ kind: 'room', name: 'gabriel-lan', room: { link, incoming: true, relayOnly: false } })).id;
  }, ['/web/app/page.ts', LINK] as const);

  // The address of its Domains: the first explainer in the cards' place, with the connection's own name in the room.
  await page.goto(`${base}/web/app/?autostart=1#home/connections/${id}/domains`);
  await page.locator('#domains-intro').waitFor({ timeout: 30_000 });
  const meta = await text(page, 'section[data-selected=connection-domains] .meta');
  assert.equal(meta, t('network:DomainsPane.meta', { name: 'gabriel-lan', room: 'gabriel-lan', domain: 'gabriel-lan.p2p.internal' }));
  const intro = await text(page, '#domains-intro');
  const member = /[a-z2-7]{52}\.gabriel-lan\.p2p\.internal/.exec(intro)?.[0];
  assert.ok(member, `its own name in the room: ${intro}`);
  assert.match(intro, words('network:DomainsIntro.what', { member }), 'what a domain is, with its own name');
  assert.equal(await page.locator('#domains-intro ol > li').count(), 3, 'three steps');
  assert.equal(await page.locator('#domains-intro ul > li').count(), 5, 'five things to know first');
  assert.equal(await page.locator('[data-action=register-domain], [data-action=register-domain-intro]').count(), 2, 'Register a domain… in the head and under the explainer');
  assert.equal(await page.locator('#domains-how').count(), 0, 'no second explainer yet');
  assert.equal(await page.locator('.machines nav [data-section=domains] .count').count(), 0, 'no count with none');

  // Register through the dialog: the relays refused, nobody can say; pressed again, registered, the dialog closed.
  await page.click('[data-action=register-domain-intro]');
  await page.waitForFunction(() => (document.getElementById('net-name') as HTMLDialogElement).open, null, { timeout: 5_000 });
  assert.match(await text(page, '#net-name-full'), words('network:NameDialog.suffix', { domain: 'gabriel-lan.p2p.internal' }));
  // A name that can't be registered: what it's refused for, and no line saying how guests would reach it.
  await page.fill('#net-name-input', '-x');
  await page.waitForFunction(() => document.getElementById('net-name-check')?.dataset.check === 'invalid', null, { timeout: 10_000 });
  assert.equal(await page.locator('#net-name-full').count(), 0, 'no full name beside the refusal');
  await page.fill('#net-name-input', 'mybox');
  await page.waitForFunction(() => document.getElementById('net-name-check')?.dataset.check === 'valid', null, { timeout: 10_000 });
  assert.match(await text(page, '#net-name-full'), words('network:NameDialog.full', { full: 'mybox.gabriel-lan.p2p.internal', name: 'mybox' }));
  await page.click('#net-name-register');
  await page.waitForFunction(() => document.getElementById('net-name-check')?.dataset.check === 'unknown', null, { timeout: 40_000 });
  await page.click('#net-name-register');
  await page.waitForFunction(() => !(document.getElementById('net-name') as HTMLDialogElement).open, null, { timeout: 5_000 });
  await page.locator(card('mybox')).waitFor({ timeout: 10_000 });
  await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute('data-state') === 'reserved', card('mybox'), { timeout: 60_000, polling: 250 })
    .catch(async (e) => { throw new Error(`${e}; its state ${await stateOf(page, 'mybox')}`); });
  assert.equal(await page.locator('#domains-intro').count(), 0, 'the first explainer gone');
  assert.match(await text(page, `${card('mybox')} [data-field=state]`), words('network:names-view.reserved', {}));
  assert.equal(await page.locator(`${card('mybox')} [data-date]`).count(), 0, 'reserved: no dates before its claim is public');
  assert.equal(await text(page, `${card('mybox')} .full`), 'mybox.gabriel-lan.p2p.internal');
  assert.equal(await text(page, '.machines nav [data-section=domains] .count'), '1', 'the column counts it');
  assert.equal(await page.locator('.machines nav [data-section=domains]').getAttribute('aria-label'), t('machines:ConnectionNav.domains.named', { n: 1 }));
  // The second explainer, collapsed; open on a click.
  assert.equal(await page.locator('#domains-how').evaluate((d) => (d as HTMLDetailsElement).open), false, 'collapsed');
  await page.click('#domains-how summary');
  assert.ok((await text(page, '#domains-how')).includes(t('network:DomainsHow.keep')));
  assert.equal(await page.locator('#domains-names-line').count(), 0, 'not connected: no registry line');

  // Where it points: at this connection's own name; a subdomain added there, saved; then pointed elsewhere and back.
  assert.equal(await page.locator(`${card('mybox')} [data-point=""] [data-field=target]`).inputValue(), member);
  // Save and Revert only while something is unsaved; Revert drops the edit.
  const saveZone = page.locator(`${card('mybox')} [data-action=save-zone]`);
  const revertZone = page.locator(`${card('mybox')} [data-action=revert-zone]`);
  assert.equal(await saveZone.count(), 0, 'nothing edited: no Save');
  assert.equal(await revertZone.count(), 0, 'nothing edited: no Revert');
  await page.click(`${card('mybox')} [data-action=add-label]`);
  assert.equal(await saveZone.count(), 1, 'edited: Save');
  await revertZone.click();
  assert.equal(await page.locator(`${card('mybox')} [data-field=label]`).count(), 0, 'reverted: the subdomain gone');
  assert.equal(await saveZone.count(), 0, 'reverted: no Save');
  await page.click(`${card('mybox')} [data-action=add-label]`);
  await page.fill(`${card('mybox')} [data-field=label]`, 'git');
  await page.fill(`${card('mybox')} [data-point="git"] [data-field=target]`, 'ab'.repeat(32));
  await page.click(`${card('mybox')} [data-action=save-zone]`);
  const pointsOf = async () => (await titles(page)).find((v) => v.name === 'mybox')?.points.map((p) => `${p.label ?? ''}>${p.key.slice(0, 4)}`).join(' ');
  for (let k = 0; k < 50 && !(await pointsOf())?.includes('git>abab'); k++) await page.waitForTimeout(100);
  const [, here] = (await pointsOf())?.match(/^>(\w{4})/) ?? [];
  assert.equal(await pointsOf(), `>${here} git>abab`, 'saved: the domain at this connection, git at another key');
  await saveZone.waitFor({ state: 'detached', timeout: 5_000 });
  await page.click(`${card('mybox')} [data-action=point-here]`);
  await page.click(`${card('mybox')} [data-action=save-zone]`);
  for (let k = 0; k < 50 && (await pointsOf())?.includes('abab'); k++) await page.waitForTimeout(100);
  assert.equal(await pointsOf(), `>${here} git>${here}`, 'all at this connection');

  // The backup: the key then its domains, secret, with the words for a connection that has domains.
  await page.click('.machines nav [data-action=backup-connection]');
  await page.waitForFunction(() => (document.getElementById('connection-backup') as HTMLDialogElement | null)?.open, null, { timeout: 5_000 });
  await page.waitForFunction(() => /\./.test((document.getElementById('connection-backup-value') as HTMLInputElement | null)?.value ?? ''), null, { timeout: 10_000 }); // no field until it is read
  assert.match(await page.locator('#connection-backup-value').inputValue(), /^[0-9a-f]{64}\.[A-Za-z0-9_-]+$/);
  assert.equal(await page.locator('#connection-backup-value').getAttribute('type'), 'password', 'hidden until shown');
  assert.equal(await text(page, '#connection-backup-intro'), t('network:ConnectionBackup.intro', { name: 'gabriel-lan' }));
  await page.click('#connection-backup-close');
  await page.waitForFunction(() => !document.getElementById('connection-backup'), null, { timeout: 5_000 });

  // Let it go (asked, answered OK): its state and what it means, nothing to edit, no upkeep line, no count.
  await page.click(`${card('mybox')} [data-action=release]`);
  await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute('data-state') === 'released', card('mybox'), { timeout: 30_000, polling: 250 })
    .catch(async (e) => { throw new Error(`${e}; its state ${await stateOf(page, 'mybox')}; the card says ${await text(page, card('mybox'))}; asked: ${await page.evaluate(() => document.getElementById('ask')?.textContent)}`); });
  assert.equal(await text(page, `${card('mybox')} [data-field=ended]`), t('network:names-view.ended.released'));
  assert.equal(await page.locator(`${card('mybox')} input`).count(), 0, 'nothing to edit');
  assert.equal(await page.locator('#domains-upkeep').count(), 0, 'none live: no upkeep line');
  assert.equal(await page.locator('.machines nav [data-section=domains] .count').count(), 0, 'none held: no count');
  await ctx.close();
});

test("the Domains pane: each state's light and words, the upkeep line, an ephemeral connection's pane and its backup", { skip, timeout: 120_000 }, async () => {
  const ctx = await profile();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`# page error: ${e}`));
  await page.goto(`${base}/web/app/?autostart=1`);
  await page.waitForFunction(() => !!document.getElementById('machines-open'));
  const [id, eph] = await page.evaluate(async ([m, link]) => {
    const { page: p } = await import(m) as typeof import('../web/app/page.ts');
    const a = (await p.netCreate({ kind: 'room', name: 'gabriel-lan', room: { link, incoming: true, relayOnly: false } })).id;
    const b = (await p.netCreate({ kind: 'room', name: 'passing', ephemeral: true, room: { link, incoming: true, relayOnly: false } })).id;
    return [a, b];
  }, ['/web/app/page.ts', LINK] as const);
  await page.evaluate((h) => (location.hash = h), `#home/connections/${id}/domains`);
  await page.locator('#domains-intro').waitFor({ timeout: 30_000 });
  // Titles in every state, set in the area (its reads stopped, so the agent's titles don't come back over them).
  const now = Math.floor(Date.now() / 1000);
  const day = 86400;
  const identityKey = await page.evaluate(async ([c]) => {
    const all = await (await import('/web/app/store.ts' as string) as typeof import('../web/app/store.ts')).Store.open().then((s) => s.all('connections'));
    return (all as { id: string; room?: { identityKey: string } }[]).find((x) => x.id === c)?.room?.identityKey ?? '';
  }, [id] as const);
  const v = (name: string, state: TitleView['state'], o: Partial<TitleView> = {}): TitleView => ({ identityKey, room: 'gabriel-lan', link: LINK, name, state, points: [{ label: null, key: 'ab'.repeat(32) }], ...o });
  const set: TitleView[] = [
    v('active', 'active', { claimedAt: now - 20 * day, renewAt: now - day, keptUntil: now + 10 * day }),
    v('soon', 'active', { claimedAt: now - 26 * day, renewAt: now - 12 * day, keptUntil: now + 3 * day }),
    v('grace', 'grace', { claimedAt: now - 40 * day, keptUntil: now - 2 * day, lapsesAt: now + 5 * day }),
    v('reserved', 'reserved', { claimedAt: now, publicAbout: Date.now() + 90 * 60_000 }),
    v('lapsed', 'lapsed'),
    v('lost', 'lost'),
  ];
  await page.evaluate(async ([m, set]) => {
    const { pageNames } = await import(m) as typeof import('../web/app/areas/names.svelte.ts');
    pageNames.refresh = () => Promise.resolve();
    pageNames.titles = set;
  }, ['/web/app/areas/names.svelte.ts', set] as const);
  await page.locator(card('lost')).waitFor({ timeout: 10_000 });
  const tones = { active: 'ok', soon: 'ok', grace: 'warn', reserved: 'busy', lapsed: 'off', lost: 'bad' };
  for (const [name, tone] of Object.entries(tones)) {
    assert.equal(await page.locator(`${card(name)} .dot.${tone}`).count(), 1, `${name}: its light ${tone}`);
  }
  assert.equal(await text(page, `${card('lapsed')} [data-field=ended]`), t('network:names-view.ended.lapsed'));
  assert.equal(await text(page, `${card('lost')} [data-field=ended]`), t('network:names-view.ended.lost'));
  assert.equal(await page.locator(`${card('lost')} input`).count(), 0, 'lost: nothing to edit');
  assert.equal(await page.locator(`${card('grace')} [data-field=target]`).count(), 1, 'in its grace: still its points');
  assert.equal(await page.locator(`${card('active')} [data-date]`).count(), 3, 'the three dates');
  assert.equal(await page.locator(`${card('active')} [data-date=renew]`).getAttribute('title'), t('network:names-view.date.renew.title'));
  // The upkeep line: those in their last week and grace named, in the warning tone.
  assert.equal(await page.locator('#domains-upkeep').getAttribute('data-warn'), 'true');
  assert.equal(await text(page, '#domains-upkeep'), t('network:names-view.upkeep.soon', { names: ['soon', 'grace'], count: 2 }));
  assert.equal(await text(page, '.machines nav [data-section=domains] .count'), '5', 'the ones the pane shows as held (live and lost), as the link counts them');
  // The Connections card's link: how many, and how many need attention, in the warning tone; it opens the pane again.
  await page.click('.machines nav [data-action=back]');
  const link = `li[data-connection="${id}"] [data-action=domains-link]`;
  await page.locator(link).waitFor({ timeout: 10_000 });
  assert.equal(await text(page, link), t('network:names-view.link.attention', { held: t('network:names-view.link.held', { count: 5 }), count: 3 }), 'five held (a lost one too), three need attention');
  assert.equal(await page.locator(link).getAttribute('data-warn'), 'true');
  assert.equal(await page.locator(`li[data-connection="${eph}"] [data-action=domains-link]`).count(), 0, 'none for an ephemeral key');
  await page.click(link);
  await page.locator(card('lost')).waitFor({ timeout: 10_000 });
  assert.equal(await page.locator('.machines nav [data-action=back]').getAttribute('data-back'), 'connections');
  // Without them: the earliest date, not a warning.
  await page.evaluate(async ([m, set]) => {
    const { pageNames } = await import(m) as typeof import('../web/app/areas/names.svelte.ts');
    pageNames.titles = set;
  }, ['/web/app/areas/names.svelte.ts', set.filter((x) => x.name !== 'soon' && x.name !== 'grace')] as const);
  await page.waitForFunction(() => document.getElementById('domains-upkeep')?.dataset.warn === 'false', null, { timeout: 5_000 });
  assert.equal(await text(page, '#domains-upkeep'), t('network:names-view.upkeep', { when: new Date((now + 10 * day) * 1000), count: 2 }));

  // An ephemeral connection with a key of its own: why it can't hold a domain, and nothing else.
  await page.evaluate(([c]) => import('/web/app/page.ts' as string).then((m: typeof import('../web/app/page.ts')) => m.page.openConnection(c, 'domains')), [eph] as const);
  await page.locator('#domains-ephemeral').waitFor({ timeout: 10_000 });
  await page.waitForFunction(() => document.querySelectorAll('section[data-selected=connection-domains]').length === 1, null, { timeout: 5_000 }); // the other pane gone (a move between levels)
  assert.equal(await text(page, '#domains-ephemeral'), t('network:DomainsPane.ephemeral'));
  assert.equal(await page.locator('[data-action=register-domain], [data-action=register-domain-intro], #domains-intro, #domains-how').count(), 0, 'nothing else');
  // Its backup: its key alone, with the words for no domains.
  await page.click('.machines nav [data-action=backup-connection]');
  await page.waitForFunction(() => /^[0-9a-f]{64}$/.test((document.getElementById('connection-backup-value') as HTMLInputElement | null)?.value ?? ''), null, { timeout: 10_000 });
  assert.equal(await text(page, '#connection-backup-intro'), t('network:ConnectionBackup.intro.none', { name: 'passing' }));
  await ctx.close();
});

/** The backup's export as its dialog shows it (opened from the column, closed again). */
async function backup(page: Page): Promise<string> {
  await page.click('.machines nav [data-action=backup-connection]');
  await page.waitForFunction(() => /^[0-9a-f]{64}/.test((document.getElementById('connection-backup-value') as HTMLInputElement | null)?.value ?? ''), null, { timeout: 10_000 });
  const v = await page.locator('#connection-backup-value').inputValue();
  await page.click('#connection-backup-close');
  await page.waitForFunction(() => !document.getElementById('connection-backup'), null, { timeout: 5_000 });
  return v;
}

test("New name, then Save or a rename from the card: the new key stays (the page reads the new record)", { skip, timeout: 120_000 }, async () => {
  const ctx = await profile();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`# page error: ${e}`));
  await answerAsks(page);
  await page.goto(`${base}/web/app/?autostart=1`);
  await page.waitForFunction(() => !!document.getElementById('machines-open'));
  const eph = await page.evaluate(async ([m, link]) => {
    const { page: p } = await import(m) as typeof import('../web/app/page.ts');
    return (await p.netCreate({ kind: 'room', name: 'passing', ephemeral: true, room: { link, incoming: true, relayOnly: false } })).id;
  }, ['/web/app/page.ts', LINK] as const);
  await page.evaluate((h) => (location.hash = h), `#home/connections/${eph}/settings`);
  await page.locator('section[data-selected=connection-settings]').waitFor({ timeout: 30_000 });
  await page.click('#settings-room-advanced summary');
  const keyField = () => page.locator('#settings-room-key-value').inputValue();
  await page.waitForFunction(() => /^[0-9a-f]{64}$/.test((document.getElementById('settings-room-key-value') as HTMLInputElement).value), null, { timeout: 10_000 });
  const old = await keyField();
  await page.click('#settings-room-new-name');
  await page.waitForFunction((old) => { const v = (document.getElementById('settings-room-key-value') as HTMLInputElement).value; return /^[0-9a-f]{64}$/.test(v) && v !== old; }, old, { timeout: 10_000 });
  const now = await keyField();
  assert.equal(await backup(page), now, 'the backup exports the new key');
  // A switch and Save: the record saved is the new one.
  await page.uncheck('#settings-room-direct');
  await page.click('section[data-selected=connection-settings] [data-action=save]');
  await page.waitForFunction(() => !document.querySelector('section[data-selected=connection-settings] [data-action=revert]'), null, { timeout: 5_000 });
  assert.equal(await backup(page), now, 'Save kept the new key');
  // A rename from the Connections card: the same.
  await page.click('.machines nav [data-action=back]');
  const name = page.locator(`[data-connection="${eph}"] [data-field=connection-name]`);
  await name.fill('renamed');
  await name.press('Enter');
  await page.waitForFunction((id) => !!document.querySelector(`[data-connection="${id}"]`) && !document.querySelector('.machines[data-busy=true]'), eph, { timeout: 5_000 });
  await page.locator(`[data-connection="${eph}"] [data-action=connection-details]`).click();
  await page.locator('[data-context-connection] h3').filter({ hasText: 'renamed' }).waitFor({ timeout: 5_000 });
  assert.equal(await backup(page), now, 'the rename kept the new key');
  await ctx.close();
});

test("New name on a connection that holds domains asks what becomes of them: pointed at the new key, or let go (NAMES2 loop 3); its room's only, the new key shown while they are let go (review fix B)", { skip, timeout: 180_000 }, async () => {
  const hold: { stamps?: Promise<void> } = {};
  const ctx = await profile(hold);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`# page error: ${e}`));
  const asked: Question[] = [];
  let reply: boolean | string = true;
  await answerAsks(page, (q) => { asked.push(q); return reply; });
  await page.goto(`${base}/web/app/?autostart=1`);
  await page.waitForFunction(() => !!document.getElementById('machines-open'));
  const id = await page.evaluate(async ([m, link]) => {
    const { page: p } = await import(m) as typeof import('../web/app/page.ts');
    return (await p.netCreate({ kind: 'room', name: 'gabriel-lan', room: { link, incoming: true, relayOnly: false } })).id;
  }, ['/web/app/page.ts', LINK] as const);
  // Two domains at this connection, one with a subdomain at another member.
  const OTHER = 'ab'.repeat(32);
  const FAR = 'waarm64-room:elsewhere?nostr=ws%3A%2F%2F127.0.0.1%3A9&derp=127.0.0.1%3A9'; // i18n-ignore: a link
  const keyOf = () => page.evaluate(async ([c]) => {
    const all = await (await import('/web/app/store.ts' as string) as typeof import('../web/app/store.ts')).Store.open().then((s) => s.all('connections'));
    const r = (all as { id: string; room?: { identityKey: string; link: string } }[]).find((x) => x.id === c)!.room!;
    const n = await import('/web/names.ts' as string) as typeof import('../web/names.ts');
    return { identityKey: r.identityKey, key: (await n.namesAgent().member({ identityKey: r.identityKey, link: r.link })).key };
  }, [id] as const);
  const before = await keyOf();
  await page.evaluate(async ([c, link, key, other, far]) => {
    const n = await import('/web/names.ts' as string) as typeof import('../web/names.ts');
    const conn = { identityKey: c, link };
    await n.namesAgent().register(conn, 'mybox', [{ label: null, key }]);
    await n.namesAgent().register(conn, 'other', [{ label: null, key }, { label: 'git', key: other }]);
    // One in another room under the same key's entry (an export made there, pasted here): New name leaves it.
    await n.namesAgent().register({ identityKey: c, link: far }, 'far', [{ label: null, key }]);
  }, [before.identityKey, LINK, before.key, OTHER, FAR] as const);
  const newName = async () => {
    await page.evaluate((h) => (location.hash = h), `#home/connections/${id}/settings`);
    await page.locator('section[data-selected=connection-settings]').waitFor({ timeout: 30_000 });
    if (!(await page.locator('#settings-room-advanced').evaluate((d) => (d as HTMLDetailsElement).open))) await page.click('#settings-room-advanced summary');
    await page.waitForFunction(() => !(document.getElementById('settings-room-new-name') as HTMLButtonElement).disabled, null, { timeout: 10_000 });
    const n = asked.length;
    await page.click('#settings-room-new-name');
    for (let k = 0; k < 100 && asked.length === n; k++) await page.waitForTimeout(100);
    await page.waitForFunction(() => document.querySelector('.machines')?.getAttribute('data-busy') !== 'true' && !(document.getElementById('ask') as HTMLDialogElement | null)?.open, null, { timeout: 30_000 });
    return asked.slice(n);
  };
  const pointsOf = async (name: string) => (await titles(page)).find((v) => v.name === name)?.points.map((p) => `${p.label ?? ''}>${p.key}`).join(' ');

  // Pointed at the new key: what pointed at the old one points there now, a subdomain at another member stays.
  let q = await newName();
  assert.equal(q.length, 1, 'one question');
  assert.match(q[0].text, words('network:network-actions.newName.confirm.domains', { name: 'gabriel-lan', names: ['mybox', 'other'], count: 2 }));
  const after = await keyOf();
  assert.notEqual(after.key, before.key, 'a new key');
  for (let k = 0; k < 100 && (await pointsOf('other')) !== `>${after.key} git>${OTHER}`; k++) await page.waitForTimeout(100);
  assert.equal(await pointsOf('mybox'), `>${after.key}`, 'the domain points at the new key');
  assert.equal(await pointsOf('other'), `>${after.key} git>${OTHER}`, 'a subdomain at another member stays there');

  // Abandoned: both let go, and the key changed all the same, shown at once while the releases wait for their
  // stamps (a release's proof of work takes a while), which the agent then makes.
  // Their claims anchored first: a release is made on an owned chain only.
  cal.mine(6);
  await page.evaluate(async () => {
    // Asked for now (the page's agent asks a pending proof again minutes on).
    const store = (await import('/web/names-store.ts' as string) as typeof import('../web/names-store.ts')).idbNamesStore();
    for (const t of await store.titles()) {
      for (const c of Object.values(t.collect)) c.next = 0;
      await store.put(t);
    }
    await (await import('/web/names.ts' as string) as typeof import('../web/names.ts')).namesAgent().pass();
  });
  assert.deepEqual((await titles(page)).map((v) => v.state), ['active', 'active', 'active']);
  reply = ALT;
  let stamp = () => {};
  hold.stamps = new Promise<void>((r) => (stamp = r));
  q = await newName();
  assert.match(q[0].text, words('network:network-actions.newName.confirm.domains', { name: 'gabriel-lan', names: ['mybox', 'other'], count: 2 }));
  const third = await keyOf();
  assert.notEqual(third.key, after.key, 'a new key');
  const states = async () => (await titles(page)).filter((v) => v.room !== 'elsewhere').map((v) => v.state);
  assert.deepEqual(await states(), ['released', 'released'], 'both let go before their releases are made');
  // The export shown starts with the key kept under the entry (the secret one, not the room's name for it).
  const kept = await page.evaluate(async (k) => (await (await import('/web/room.ts' as string) as typeof import('../web/room.ts')).readRoomIdentity(k))?.key ?? '', third.identityKey);
  assert.match(kept, /^[0-9a-f]{64}$/);
  for (let k = 0; k < 100 && !(await page.locator('#settings-room-key-value').inputValue()).startsWith(kept); k++) await page.waitForTimeout(100);
  assert.ok((await page.locator('#settings-room-key-value').inputValue()).startsWith(kept), 'the new key shown');
  stamp();
  hold.stamps = undefined;
  // The stamps given: each release made (the one entry stamped and waiting: the claims are anchored).
  const made = () => page.evaluate(async () => {
    const all = await (await import('/web/names-store.ts' as string) as typeof import('../web/names-store.ts')).idbNamesStore().titles();
    return all.filter((t) => t.room !== 'elsewhere' && Object.keys(t.stamps).length === 1).length;
  });
  for (let k = 0; k < 600 && (await made()) < 2; k++) await page.waitForTimeout(100); // each publish waits on the refused relays
  assert.equal(await made(), 2, 'both releases made once the calendars answer');
  const far = (await titles(page)).find((v) => v.name === 'far');
  assert.deepEqual([far?.state, far?.points.map((p) => p.key)], ['active', [before.key]], 'another room\'s domain is left as it was');

  // None held: New name asks as before, nothing about domains.
  reply = true;
  q = await newName();
  assert.match(q[0].text.replace(/\s+/g, ' ').trim(), words('network:network-actions.newName.confirm', { name: 'gabriel-lan' }, { whole: true }));
  await ctx.close();
});

test("a connection's name in its room that can't be read: said in the pane, the backup and Details, read again later; a read overtaken by New name dropped", { skip, timeout: 120_000 }, async () => {
  const ctx = await profile();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`# page error: ${e}`));
  await page.goto(`${base}/web/app/?autostart=1`);
  await page.waitForFunction(() => !!document.getElementById('machines-open'));
  const id = await page.evaluate(async ([m, link]) => {
    const { page: p } = await import(m) as typeof import('../web/app/page.ts');
    return (await p.netCreate({ kind: 'room', name: 'gabriel-lan', room: { link, incoming: true, relayOnly: false } })).id;
  }, ['/web/app/page.ts', LINK] as const);
  // The agent refuses every `member` read.
  await page.evaluate(async () => {
    const n = await import('/web/names.ts' as string) as typeof import('../web/names.ts');
    const a = n.namesAgent() as unknown as { member: unknown; realMember?: unknown };
    a.realMember = a.member;
    a.member = () => Promise.reject(new Error('the worker did not start'));
  });
  await page.evaluate((h) => (location.hash = h), `#home/connections/${id}/domains`);
  const failed = t('network:names.memberFailed');
  await page.locator('#domains-member-error').waitFor({ timeout: 30_000 });
  assert.ok((await text(page, '#domains-member-error')).startsWith(failed), 'the pane says why it is empty');
  assert.ok((await text(page, '#domains-member-error')).includes('the worker did not start'), 'with the cause');
  // The backup: the error, no empty field to copy.
  await page.click('.machines nav [data-action=backup-connection]');
  await page.locator('#connection-backup-error').waitFor({ timeout: 10_000 });
  assert.ok((await text(page, '#connection-backup-error')).startsWith(failed));
  assert.equal(await page.locator('#connection-backup-value').count(), 0, 'no empty field to copy');
  await page.click('#connection-backup-close');
  await page.waitForFunction(() => !document.getElementById('connection-backup'), null, { timeout: 5_000 });
  // Details: the same words where the name in the room goes.
  await page.click('.machines nav [data-section=details]');
  await page.locator('#net-details-room-name-error').waitFor({ timeout: 10_000 });
  assert.ok((await text(page, '#net-details-room-name-error')).startsWith(failed));
  // The agent answers again: a later read (the pane shown again) gets it.
  await page.evaluate(async () => {
    const n = await import('/web/names.ts' as string) as typeof import('../web/names.ts');
    const a = n.namesAgent() as unknown as { member: unknown; realMember?: unknown };
    a.member = a.realMember;
  });
  await page.click('.machines nav [data-section=domains]');
  await page.locator('#domains-intro').waitFor({ timeout: 30_000 });
  assert.equal(await page.locator('#domains-member-error').count(), 0, 'the error gone');

  // A read in flight when the key is forgotten (New name), and the read after it: the first one's answer (the old
  // key's) isn't kept, even arriving after the second one started; the second one's is.
  const kept = await page.evaluate(async ([m]) => {
    const n = await import('/web/names.ts' as string) as typeof import('../web/names.ts');
    const { pageNames } = await import(m) as typeof import('../web/app/areas/names.svelte.ts');
    const a = n.namesAgent() as unknown as { member: (c: unknown) => Promise<unknown> };
    const real = a.member;
    const answers: ((m: unknown) => void)[] = [];
    a.member = () => new Promise((r) => answers.push(r));
    const conn = { identityKey: 'slow-entry', link: 'waarm64-room:gabriel-lan' }; // i18n-ignore: a link
    const tick = () => new Promise((r) => setTimeout(r, 50));
    const said = () => pageNames.member(conn)?.key ?? 'none';
    pageNames.member(conn); // the read starts
    await tick();
    pageNames.forgetMember('slow-entry'); // New name, before it answers
    pageNames.member(conn); // read again (the new key)
    await tick();
    answers[0]?.({ key: 'old', name: 'o', domain: 'd', domains: [] });
    await tick();
    const first = said();
    answers[1]?.({ key: 'new', name: 'n', domain: 'd', domains: [] });
    await tick();
    a.member = real;
    return [answers.length, first, said()];
  }, ['/web/app/areas/names.svelte.ts'] as const);
  assert.deepEqual(kept, [2, 'none', 'new'], "the overtaken read's answer dropped, the later one's kept");
  await ctx.close();
});
