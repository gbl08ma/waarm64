// Registered names as the page says them (web/app/names-view.ts, docs/plans/room-names.md "What the user sees"): a
// title's state at each step, the dialog's check as typed and when Register is offered, the Machines page's line, a
// member's name in the room read back as its key; and the wording cases, which pin the words the kickoff's decisions
// bind (the dialog's two notices: decisions 6 and 13).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { t, text } from '../web/i18n.ts';
import type { TitleView } from '../web/names.ts';
import { canRegister, checkWords, machineNames, namesLine, parseTarget, targetName, titleState } from '../web/app/names-view.ts';

const NOW = 1_800_000_000_000;
const v = (o: Partial<TitleView>): TitleView => ({ identityKey: 'k', room: 'r', link: 'l', name: 'mybox', state: 'active', points: [], ...o });

test('a title\'s state in words: each state its own, the reserved one\'s hours rounded up, never fewer than one', () => {
  assert.equal(text(titleState(v({ state: 'preparing' }), NOW)), t('network:names-view.preparing'));
  assert.equal(text(titleState(v({ state: 'reserved', publicAbout: NOW + 90 * 60_000 }), NOW)), t('network:names-view.reserved', { count: 2 }));
  assert.equal(text(titleState(v({ state: 'reserved', publicAbout: NOW - 1 }), NOW)), t('network:names-view.reserved', { count: 1 }), 'late: about an hour still');
  const until = NOW / 1000 + 20 * 86400;
  assert.equal(text(titleState(v({ state: 'active', keptUntil: until }), NOW)), t('network:names-view.active', { when: new Date(until * 1000) }));
  assert.equal(text(titleState(v({ state: 'grace', lapsesAt: until }), NOW)), t('network:names-view.grace', { when: new Date(until * 1000) }));
  for (const [state, key] of [['lapsed', 'network:names-view.lapsed'], ['released', 'network:names-view.released'], ['lost', 'network:names-view.lost']] as const) {
    assert.equal(text(titleState(v({ state }), NOW)), t(key));
  }
});

test('the dialog\'s check: what it says under the field, and Register offered only for a free name or one nobody can say about', () => {
  assert.equal(checkWords('', { state: 'empty' }), undefined);
  const shown = { checking: false, invalid: false, yours: false, free: true, unknown: true, taken: false, empty: false };
  for (const [state, offered] of Object.entries(shown)) {
    const c = state === 'taken' ? { state, until: 1 } as const : { state } as { state: Exclude<keyof typeof shown, 'taken'> };
    assert.equal(canRegister(c), offered, state);
    if (state !== 'empty') assert.ok(checkWords('mybox', c), state);
  }
  assert.equal(text(checkWords('mybox', { state: 'taken', until: 1_800_000_000 })!), t('network:names-view.check.taken', { name: 'mybox', when: new Date(1_800_000_000_000) }));
});

test('the Machines page\'s line: the live names with their dates; the details\' line by role', () => {
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
  assert.equal(t('network:NameDialog.notice.find'), 'Members of this room who know the name can find this machine and see when it\'s online, and your machine helps other members look names up.');
  assert.equal(t('network:NameDialog.notice.visit'), 'Open this web app at least every 2 weeks to keep the name.');
  assert.equal(t('network:NetNames.name'), 'Name this machine…');
  assert.equal(t('network:NameDialog.register'), 'Register');
});

test('wording: the adapter\'s states as the spec words them', () => {
  assert.equal(t('network:names-view.preparing'), 'Preparing');
  assert.equal(t('network:names-view.reserved', { count: 3 }), 'Reserved, public in about 3 hours; it already works on this machine.');
  assert.match(t('network:names-view.active', { when: new Date(NOW) }), /^Active, kept until about .+ unless you visit$/);
});

test('wording: the dialog\'s check', () => {
  assert.equal(t('network:names-view.check.free', { name: 'mybox' }), 'mybox is free.');
  assert.match(t('network:names-view.check.taken', { name: 'mybox', when: new Date(NOW) }), /^mybox is taken, until about .+ unless its owner renews it\.$/);
  assert.match(t('network:names-view.check.unknown', { name: 'mybox' }), /^Nobody in the room can say whether mybox is free/);
  assert.match(t('network:names-view.check.invalid'), /^Not a name that can be registered\./);
});
