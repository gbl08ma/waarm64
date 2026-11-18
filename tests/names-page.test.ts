// Registered names as the page says them (web/app/names-view.ts, docs/plans/room-names.md "What the user sees"): a
// title's state at each step, the dialog's check (as typed, by the page alone; the room's servers at Register) and when Register is offered, the Home page's line, a
// member's name in the room read back as its key; and the wording cases, which pin the words the kickoff's decisions
// bind (the dialog's two notices: decisions 6 and 13).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { t, text } from '../web/i18n.ts';
import type { NameCheck, TitleView } from '../web/names.ts';
import { canRegister, checkWords, machineNames, NameForm, type CheckShown, namesLine, parseTarget, targetName, titleState, titlesOf } from '../web/app/names-view.ts';

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
  const shown = { checking: false, invalid: false, yours: false, valid: true, free: true, unknown: true, taken: false, empty: false };
  const said = { checking: true, invalid: true, yours: true, valid: false, free: false, unknown: true, taken: true, empty: false };
  for (const [state, offered] of Object.entries(shown)) {
    const c = state === 'taken' ? { state, until: 1 } as const : { state } as { state: Exclude<keyof typeof shown, 'taken'> };
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

test('the Home page\'s line: the live names with their dates; the details\' line by role', () => {
  const until = 1_800_000_000;
  const lines = machineNames([v({ keptUntil: until }), v({ name: 'new', state: 'reserved' }), v({ name: 'gone', state: 'lapsed', keptUntil: 1 }), v({ name: 'lost', state: 'lost' })]).map(text);
  assert.deepEqual(lines, [t('network:names-view.machine.until', { name: 'mybox', when: new Date(until * 1000) }), t('network:names-view.machine.new', { name: 'new' })]);
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
});

test('wording: the dialog\'s two notices (decision 6: discoverable, and the visits; decision 13: every 2 weeks)', () => {
  assert.equal(t('network:NameDialog.notice.find'), 'Members of this room who know the domain can reach this connection\'s address and see when it\'s online. While this connection is connected, this web app helps other members look domains up.');
  assert.equal(t('network:NameDialog.notice.visit'), 'Open this web app at least every 2 weeks to keep the domain.');
  assert.equal(t('network:NetNames.name'), 'Register a domain…');
  assert.equal(t('network:NameDialog.register'), 'Register');
});

test('wording: a domain, not a name (the user, 2026-11-18: a term to look up, held by the connection, not the machine)', () => {
  assert.equal(t('network:NameDialog.full', { full: 'mybox.abcdefgh.p2p.internal', name: 'mybox' }), 'Guests in this room will reach it as mybox.abcdefgh.p2p.internal, and usually as mybox alone.');
  assert.equal(t('network:NameDialog.suffix', { domain: 'abcdefgh.p2p.internal' }), 'A domain in this room ends in .abcdefgh.p2p.internal, which guests can usually leave out.');
  assert.equal(t('network:NameEntry.addLabel'), 'Add a subdomain');
  assert.equal(t('network:NameEntry.pointHere'), 'Point all at this connection');
});

test('wording: the adapter\'s states as the spec words them', () => {
  assert.equal(t('network:names-view.preparing'), 'Preparing');
  assert.equal(t('network:names-view.reserved', { count: 3 }), 'Reserved, public in about 3 hours; it already works on this machine.');
  assert.match(t('network:names-view.active', { when: new Date(NOW) }), /^Active, kept until about .+ unless you visit$/);
});

test('wording: the dialog\'s check', () => {
  assert.match(t('network:names-view.check.taken', { name: 'mybox', when: new Date(NOW) }), /^mybox is taken, until about .+ unless its owner renews it\.$/);
  assert.match(t('network:names-view.check.unknown', { name: 'mybox' }), /^Nobody in the room can say whether mybox is free/);
  assert.match(t('network:names-view.check.unknown', { name: 'mybox' }), /Press Register again to register it all the same\.$/, 'nobody can say: the way on');
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
