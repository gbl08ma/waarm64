// Registered names as the page says them (web/app/names-view.ts, docs/networking/names.md "What the user sees"): a
// title's state at each step, the dialog's check (as typed, by the page alone; the room's servers at Register) and when Register is offered, the Home page's line, a
// member's name in the room read back as its key; and the wording cases, which pin the words the kickoff's decisions
// bind (the dialog's two notices: decisions 6 and 13).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { t, text } from '../web/i18n.ts';
import type { NameCheck, TitleView } from '../web/names.ts';
import { canRegister, checkWords, domainsLink, endedWords, isLive, NameForm, needsAttention, type CheckShown, namesLine, parseTarget, subdomainOk, targetName, titleDates, titleState, titleTone, titlesOf, upkeepLine, zonePoints } from '../web/app/names-view.ts';
import { msg, MsgError } from '../web/i18n.ts';

const NOW = 1_800_000_000_000;
const v = (o: Partial<TitleView>): TitleView => ({ identityKey: 'k', room: 'r', link: 'l', name: 'mybox', state: 'active', points: [], ...o });

test('a title\'s state in words: each state its own, the reserved one\'s hours rounded up, never fewer than one', () => {
  assert.equal(text(titleState(v({ state: 'preparing' }), NOW)), t('network:names-view.preparing'));
  assert.equal(text(titleState(v({ state: 'reserved', publicAbout: NOW + 90 * 60_000 }), NOW)), t('network:names-view.reserved', { count: 2 }));
  assert.equal(text(titleState(v({ state: 'reserved', publicAbout: NOW - 1 }), NOW)), t('network:names-view.reservedLate'), 'late (the page closed before its proof came): no hours counted (review 2)');
  const until = NOW / 1000 + 20 * 86400;
  assert.equal(text(titleState(v({ state: 'active', keptUntil: until }), NOW)), t('network:names-view.active', { when: new Date(until * 1000) }));
  assert.equal(text(titleState(v({ state: 'grace', lapsesAt: until }), NOW)), t('network:names-view.grace', { when: new Date(until * 1000) }));
  for (const [state, key] of [['lapsed', 'network:names-view.lapsed'], ['released', 'network:names-view.released'], ['lost', 'network:names-view.lost']] as const) {
    assert.equal(text(titleState(v({ state }), NOW)), t(key));
  }
});

test('the dialog\'s check: what it says under the field, and Register offered for a valid name not asked about yet or one nobody can say about', () => {
  assert.equal(checkWords('', { state: 'empty' }), undefined);
  const shown = { checking: false, invalid: false, yours: false, valid: true, free: true, unknown: true, disputed: true, taken: false, empty: false };
  const said = { checking: true, invalid: true, yours: true, valid: false, free: false, unknown: true, disputed: true, taken: true, empty: false };
  for (const [state, offered] of Object.entries(shown)) {
    const c = state === 'taken' || state === 'disputed' ? { state, until: 1 } as const : { state } as { state: Exclude<keyof typeof shown, 'taken' | 'disputed'> };
    assert.equal(canRegister(c), offered, state);
    assert.equal(!!checkWords('mybox', c), said[state as keyof typeof said], state);
  }
  assert.equal(text(checkWords('mybox', { state: 'taken', until: 1_800_000_000 })!), t('network:names-view.check.taken', { name: 'mybox', when: new Date(1_800_000_000_000) }));
});

/** The dialog's form on fakes: what it asked, what it registered, what it showed. */
function form(servers: (name: string) => Promise<NameCheck>) {
  const asked = { here: [] as string[], servers: [] as string[], registered: [] as string[], shown: [] as CheckShown['state'][] };
  const f = new NameForm({
    here: (n) => { asked.here.push(n); return Promise.resolve(n === 'wpad' ? { state: 'invalid' } : { state: 'valid' }); },
    servers: (n) => { asked.servers.push(n); return servers(n); },
    register: (n) => { asked.registered.push(n); },
  }, (c) => asked.shown.push(c.state));
  return { f, asked };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

test('the dialog: typing asks no server; Register asks once and registers a free name', async () => {
  const { f, asked } = form(() => Promise.resolve({ state: 'free' }));
  for (const typed of ['m', 'my', 'myb', 'mybo', 'mybox']) f.typed(typed);
  await settle();
  assert.deepEqual(asked.servers, [], 'typing sends nothing to any server');
  assert.equal(f.shown.state, 'valid');
  f.typed('wpad');
  await settle();
  assert.equal(f.shown.state, 'invalid', 'not valid: said as typed, from the page alone');
  assert.equal(await f.press(), false, 'not valid: Register does nothing');
  assert.deepEqual(asked.servers, []);
  f.typed('mybox');
  await settle();
  assert.equal(await f.press(), true, 'free: registered, the dialog closes');
  assert.deepEqual(asked.servers, ['mybox'], 'one check a press');
  assert.deepEqual(asked.registered, ['mybox']);
});

test('the dialog: taken keeps it open with the date, and Register does nothing until the name changes', async () => {
  const until = 1_800_000_000;
  const { f, asked } = form(() => Promise.resolve({ state: 'taken', until }));
  f.typed('test123');
  await settle();
  assert.equal(await f.press(), false, 'taken: not registered');
  assert.deepEqual(f.shown, { state: 'taken', until });
  assert.match(text(checkWords('test123', f.shown)!), /until about/);
  assert.equal(await f.press(), false);
  assert.deepEqual(asked.servers, ['test123'], 'taken: not asked again for the same name');
  assert.deepEqual(asked.registered, [], 'nothing registered');
  f.typed('test1234');
  await settle();
  assert.equal(f.shown.state, 'valid', 'a new name: Register offered again');
});

test('the dialog: nobody can say, it says so, and Register pressed again registers that name', async () => {
  const { f, asked } = form(() => Promise.resolve({ state: 'unknown' }));
  f.typed('mybox');
  await settle();
  assert.equal(await f.press(), false, 'the first press: nobody can say, said');
  assert.equal(f.shown.state, 'unknown');
  assert.ok(canRegister(f.shown), 'Register still offered');
  assert.equal(await f.press(), true, 'pressed again: registered, the servers not asked again');
  assert.deepEqual(asked.servers, ['mybox']);
  assert.deepEqual(asked.registered, ['mybox']);
  // The name changed after nobody could say: the next press asks again, it doesn't register unasked.
  const other = form(() => Promise.resolve({ state: 'unknown' }));
  other.f.typed('mybox');
  await settle();
  await other.f.press();
  other.f.typed('mybox2');
  await settle();
  assert.equal(await other.f.press(), false);
  assert.deepEqual(other.asked.servers, ['mybox', 'mybox2']);
  assert.deepEqual(other.asked.registered, []);
});

test('the dialog: the servers disagree, it says so, and Register pressed again registers that name (the final review, finding 8)', async () => {
  const until = 1_800_000_000;
  const { f, asked } = form(() => Promise.resolve({ state: 'disputed', until }));
  f.typed('common');
  await settle();
  assert.equal(await f.press(), false, 'the first press: the disagreement said');
  assert.deepEqual(f.shown, { state: 'disputed', until });
  assert.equal(text(checkWords('common', f.shown)!), t('network:names-view.check.disputed', { name: 'common', when: new Date(until * 1000) }));
  assert.ok(canRegister(f.shown), 'Register still offered');
  assert.equal(await f.press(), true, 'pressed again: registered, the servers not asked again');
  assert.deepEqual(asked.servers, ['common']);
  assert.deepEqual(asked.registered, ['common']);
});

test('the dialog: an answer to a name typed over, or a dialog closed, is dropped', async () => {
  let answer: (c: NameCheck) => void = () => {};
  const { f, asked } = form(() => new Promise((r) => (answer = r)));
  f.typed('mybox');
  await settle();
  const pressed = f.press();
  assert.equal(f.shown.state, 'checking');
  f.close();
  answer({ state: 'free' });
  assert.equal(await pressed, false);
  assert.deepEqual(asked.registered, [], 'closed: nothing registered');
});

test('the registry\'s line by role', () => {
  assert.equal(text(namesLine({ serving: true, names: 3, servers: 2 })), t('network:names-view.line.serving', { count: 3, servers: 2 }));
  assert.equal(text(namesLine({ serving: false, names: 1, servers: 2 })), t('network:names-view.line.member', { count: 1, servers: 2 }));
});

test('where a name points: a member\'s name in the room, its first label, or a key, read back as the key', () => {
  const key = 'a7'.repeat(16) + '0f'.repeat(16);
  const name = targetName(key, 'abcdefgh.p2p.internal');
  assert.match(name, /^[a-z2-7]{52}\.abcdefgh\.p2p\.internal$/);
  assert.equal(parseTarget(name), key);
  assert.equal(parseTarget(name.split('.')[0].toUpperCase()), key);
  assert.equal(parseTarget(` ${key.toUpperCase()} `), key);
  for (const bad of ['', 'mybox', key.slice(2), `${name.slice(0, 51)}z.x`]) assert.equal(parseTarget(bad), undefined, bad);
  // Under the room's name (a room whose ID is a label: docs/networking/rooms.md "The resolver"), as the page shows it.
  const named = targetName(key, 'gabriel-lan.p2p.internal');
  assert.equal(named, `${name.split('.')[0]}.gabriel-lan.p2p.internal`);
  assert.equal(parseTarget(named), key);
});

test('a subdomain the details take is one the module takes: a DNS label, never `--` in its third and fourth places (the final review, finding 10)', () => {
  for (const ok of ['git', 'a', 'a-b', 'ab-c', 'a--b', '0', 'x'.repeat(63), 'abc--', 'ab-']) assert.equal(subdomainOk(ok), !ok.endsWith('-'), ok);
  for (const bad of ['', '-a', 'a-', 'ab--c', 'xn--a', 'xn--abc', '12--', 'x'.repeat(64), 'A', 'a.b', 'a_b']) assert.equal(subdomainOk(bad), false, bad);
});

test('Save\'s rows as a zone\'s points: a subdomain the module would refuse, or one twice, said in the catalog\'s words (the final review, finding 10)', () => {
  const here = targetName('ab'.repeat(32), 'abcdefgh.p2p.internal');
  const said = (rows: { label: string | null; target: string }[]) => {
    try {
      zonePoints(rows);
      return undefined;
    } catch (err) {
      assert.ok(err instanceof MsgError, String(err));
      return text(err.msg);
    }
  };
  assert.deepEqual(zonePoints([{ label: null, target: here }, { label: ' Git ', target: 'cd'.repeat(32) }]), [{ label: null, key: 'ab'.repeat(32) }, { label: 'git', key: 'cd'.repeat(32) }]);
  assert.equal(said([{ label: null, target: here }, { label: 'ab--c', target: here }]), t('network:names-view.badLabel', { label: 'ab--c' }));
  assert.equal(said([{ label: 'xn--a', target: here }]), t('network:names-view.badLabel', { label: 'xn--a' }));
  assert.equal(said([{ label: 'git', target: here }, { label: 'GIT', target: here }]), t('network:names-view.labelTwice', { label: 'git' }));
  assert.equal(said([{ label: 'git', target: 'nowhere' }]), t('network:names-view.badTarget', { target: 'nowhere' }));
});

test('wording: the dialog\'s two notices (decision 6: discoverable, and the visits; decision 13: every 2 weeks)', () => {
  assert.equal(t('network:NameDialog.notice.find'), 'Members of this room who know the domain can reach this connection\'s address and see when it\'s online. While this connection is connected, this web app helps other members look domains up.');
  assert.equal(t('network:NameDialog.notice.visit'), 'Open this web app at least every 2 weeks to keep the domain.');
  assert.equal(t('network:NameDialog.register'), 'Register');
});

test('wording: a domain, not a name (the user, 2026-11-18: a term to look up, held by the connection, not the machine)', () => {
  assert.equal(t('network:NameDialog.full', { full: 'mybox.abcdefgh.p2p.internal', name: 'mybox' }), 'Guests in this room will reach it as mybox.abcdefgh.p2p.internal, and usually as mybox alone.');
  assert.equal(t('network:NameDialog.suffix', { domain: 'abcdefgh.p2p.internal' }), 'A domain in this room ends in .abcdefgh.p2p.internal, which guests can usually leave out.');
  assert.equal(t('network:DomainCard.addLabel'), 'Add a subdomain');
  assert.equal(t('network:DomainCard.pointHere'), 'Point all at this connection');
});

test('wording: the adapter\'s states as the spec words them', () => {
  assert.equal(t('network:names-view.preparing'), 'Preparing');
  assert.equal(t('network:names-view.reserved', { count: 3 }), 'Reserved, public in about 3 hours; it already works in machines that use this connection.');
  assert.match(t('network:names-view.active', { when: new Date(NOW) }), /^Active, kept until about .+ unless you visit$/);
});

test('wording: the dialog\'s check', () => {
  assert.match(t('network:names-view.check.taken', { name: 'mybox', when: new Date(NOW) }), /^mybox is taken, until about .+ unless its owner renews it\.$/);
  assert.match(t('network:names-view.check.unknown', { name: 'mybox' }), /^Nobody in the room can say whether mybox is free/);
  assert.match(t('network:names-view.check.unknown', { name: 'mybox' }), /Press Register again to register it all the same\.$/, 'nobody can say: the way on');
  assert.match(t('network:names-view.check.disputed', { name: 'mybox', when: new Date(NOW) }), /^The room's servers disagree about mybox: one says it is taken, until about .+, and another doesn't\./);
  assert.match(t('network:names-view.check.disputed', { name: 'mybox', when: new Date(NOW) }), /Press Register again to register it all the same\.$/, 'the servers disagree: the way on');
  assert.match(t('network:names-view.check.invalid'), /^Not a domain that can be registered\./);
});

test('a connection\'s names: by its key and room, whatever link it was registered with (review 2, finding 16)', () => {
  const a = 'waarm64-room:myroom?nostr=wss%3A%2F%2Fone.example';
  const b = 'waarm64-room:myroom?nostr=wss%3A%2F%2Ftwo.example';
  const titles = [v({ room: 'myroom', link: a, name: 'one' }), v({ room: 'other', link: 'waarm64-room:other', name: 'two' }), v({ identityKey: 'x', room: 'myroom', link: a, name: 'three' })];
  assert.deepEqual(titlesOf(titles, [], { identityKey: 'k', link: b }).map((x) => x.name), ['one'], 'another link to the same room');
  const making = [{ identityKey: 'k', link: a, name: 'new' }];
  assert.deepEqual(titlesOf(titles, making, { identityKey: 'k', link: b }).map((x) => [x.name, x.state]), [['new', 'preparing'], ['one', 'active']]);
});

const DAY_S = 86400;
const nowS = NOW / 1000;

test('a domain\'s light: on, on its way, needing a renewal, gone or taken; live while held', () => {
  const tones = { active: 'ok', preparing: 'busy', reserved: 'busy', grace: 'warn', lapsed: 'off', released: 'off', lost: 'bad' } as const;
  for (const [state, tone] of Object.entries(tones)) {
    assert.equal(titleTone(v({ state: state as keyof typeof tones })), tone, state);
    assert.equal(isLive(v({ state: state as keyof typeof tones })), ['active', 'preparing', 'reserved', 'grace'].includes(state), state);
  }
});

test('a card\'s dates where the title has them, and what an end means', () => {
  const d = titleDates(v({ claimedAt: nowS - 20 * DAY_S, renewAt: nowS - DAY_S, keptUntil: nowS + 10 * DAY_S }));
  assert.deepEqual(d.map((x) => x.key), ['claimed', 'renew', 'until']);
  assert.equal(text(d[0].m), t('network:names-view.date.claimed', { when: new Date((nowS - 20 * DAY_S) * 1000) }));
  assert.equal(text(d[1].title!), t('network:names-view.date.renew.title'), 'the next renewal has its tooltip');
  assert.equal(text(d[2].m), t('network:names-view.date.until', { when: new Date((nowS + 10 * DAY_S) * 1000) }));
  assert.deepEqual(titleDates(v({ state: 'preparing' })), [], 'none before its claim is made');
  assert.equal(text(endedWords(v({ state: 'lapsed' }))!), t('network:names-view.ended.lapsed'));
  assert.equal(text(endedWords(v({ state: 'released' }))!), t('network:names-view.ended.released'));
  assert.equal(text(endedWords(v({ state: 'lost' }))!), t('network:names-view.ended.lost'));
  for (const state of ['active', 'grace', 'reserved', 'preparing'] as const) assert.equal(endedWords(v({ state })), undefined, state);
});

test('the upkeep line: by the earliest date, the last week and the grace named in the warning tone, none when nothing is live', () => {
  const later = nowS + 20 * DAY_S;
  const sooner = nowS + 10 * DAY_S;
  const one = upkeepLine([v({ keptUntil: later })], NOW)!;
  assert.deepEqual([text(one.m), one.warn], [t('network:names-view.upkeep', { when: new Date(later * 1000), count: 1 }), false]);
  const two = upkeepLine([v({ keptUntil: later }), v({ name: 'blog', keptUntil: sooner }), v({ name: 'new', state: 'reserved' }), v({ name: 'gone', state: 'lapsed', keptUntil: nowS - 40 * DAY_S })], NOW)!;
  assert.deepEqual([text(two.m), two.warn], [t('network:names-view.upkeep', { when: new Date(sooner * 1000), count: 3 }), false], 'the earliest date of those live; a lapsed one left out');
  const soon = upkeepLine([v({ keptUntil: nowS + 3 * DAY_S }), v({ name: 'blog', keptUntil: later })], NOW)!;
  assert.deepEqual([text(soon.m), soon.warn], [t('network:names-view.upkeep.soon', { names: ['mybox'], count: 1 }), true], 'its last week');
  const grace = upkeepLine([v({ state: 'grace', keptUntil: nowS - DAY_S }), v({ name: 'blog', keptUntil: nowS + DAY_S })], NOW)!;
  assert.deepEqual([text(grace.m), grace.warn], [t('network:names-view.upkeep.soon', { names: ['mybox', 'blog'], count: 2 }), true], 'the grace and the last week together');
  assert.equal(upkeepLine([v({ state: 'released' }), v({ state: 'lost' }), v({ state: 'lapsed' })], NOW), undefined, 'none live: no line');
  assert.equal(upkeepLine([], NOW), undefined);
  assert.equal(upkeepLine([v({ state: 'preparing' })], NOW), undefined, 'no date yet: no line');
});

test('the status link: Register a domain… with none, how many, and how many need attention in the warning tone', () => {
  const said = (views: TitleView[]) => { const l = domainsLink(views, NOW); return [text(l.m), l.warn]; };
  assert.deepEqual(said([]), [t('network:DomainsPane.register'), false]);
  assert.deepEqual(said([v({ state: 'released' }), v({ state: 'lapsed' })]), [t('network:DomainsPane.register'), false], 'none held');
  const held = (count: number) => msg('network:names-view.link.held', { count });
  assert.deepEqual(said([v({ keptUntil: nowS + 20 * DAY_S })]), [t('network:names-view.link.held', { count: 1 }), false]);
  assert.deepEqual(said([v({ keptUntil: nowS + 20 * DAY_S }), v({ name: 'b', state: 'reserved' })]), [t('network:names-view.link.held', { count: 2 }), false]);
  assert.deepEqual(said([v({ keptUntil: nowS + 2 * DAY_S }), v({ name: 'b', state: 'reserved' })]), [text(msg('network:names-view.link.attention', { held: held(2), count: 1 })), true], 'its last week');
  assert.deepEqual(said([v({ state: 'grace' }), v({ name: 'b', state: 'lost' }), v({ name: 'c', state: 'released' })]), [text(msg('network:names-view.link.attention', { held: held(2), count: 2 })), true], 'the grace and a lost one; one let go not counted');
  assert.equal(needsAttention(v({ keptUntil: nowS + 8 * DAY_S }), NOW), false);
  assert.equal(needsAttention(v({ keptUntil: nowS + 6 * DAY_S }), NOW), true);
});

test('wording: the upkeep line, the dates, the link (the kickoff\'s words)', () => {
  const when = new Date(NOW);
  assert.match(t('network:names-view.upkeep', { when, count: 1 }), /^Reopen this web app by about .+ to keep this domain\.$/);
  assert.match(t('network:names-view.upkeep', { when, count: 2 }), /^Reopen this web app by about .+ to keep these domains\.$/);
  assert.equal(t('network:names-view.upkeep.soon', { names: ['mybox'], count: 1 }), 'mybox needs renewing. Leave this web app open for a few hours to keep it.');
  assert.equal(t('network:names-view.upkeep.soon', { names: ['mybox', 'blog'], count: 2 }), 'mybox, blog need renewing. Leave this web app open for a few hours to keep them.');
  assert.match(t('network:names-view.date.claimed', { when }), /^Registered /);
  assert.match(t('network:names-view.date.renew', { when }), /^Next renewal from /);
  assert.match(t('network:names-view.date.until', { when }), /^Works until about /);
  assert.equal(t('network:DomainsPane.register'), 'Register a domain…');
  assert.equal(t('network:names-view.link.held', { count: 1 }), '1 domain registered');
  assert.equal(t('network:names-view.link.held', { count: 3 }), '3 domains registered');
  assert.equal(text(msg('network:names-view.link.attention', { held: msg('network:names-view.link.held', { count: 1 }), count: 1 })), '1 domain registered, 1 needs attention');
  assert.equal(text(msg('network:names-view.link.attention', { held: msg('network:names-view.link.held', { count: 3 }), count: 2 })), '3 domains registered, 2 need attention');
});
