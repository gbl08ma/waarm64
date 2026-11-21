// A connection's Settings in Node (web/app/connection-settings.ts; docs/frontend.md "The Home page"): the draft taken
// from each kind of connection, whether a draft differs (in what that kind's Settings show) or changes more than the
// name, and the connection Save writes: each kind's values in place, the rest of the record kept, an empty name the old
// one, and what's typed wrong refused with the wizard's own messages.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { differs, draftOf, editedOf, settingsChanged, type SettingsDraft } from '../web/app/connection-settings.ts';
import type { Connection } from '../web/app/connections.ts';
import { DEMO_URL } from '../web/demo-net.ts';

const base = { id: 'c1', name: 'Lab', ephemeral: false, connectAtStart: true, lastUsed: 1, created: 1 };
const tailnet: Connection = { ...base, kind: 'tailnet', tailnet: { controlURL: 'https://c.example/', hostname: 'box', exitNode: '', stateKey: 'c1' } };
const tailcat: Connection = { ...base, kind: 'tailcat', tailcat: { serve: true, relay: '127.0.0.1:8444', allow: ['k1', 'k2'], identityKey: 'c1' } };
const local: Connection = { ...base, kind: 'local', local: { url: 'ws://127.0.0.1:8740/abc' } };
const demo: Connection = { ...base, kind: 'demo', demo: { url: DEMO_URL } };
const room: Connection = { ...base, kind: 'room', room: { link: 'room:x', incoming: true, relayOnly: false, identityKey: 'c1' } };

const edited = (c: Connection, d: Partial<SettingsDraft>) => {
  const r = editedOf(c, { ...draftOf(c), ...d });
  if ('error' in r) throw new Error(`refused: ${r.error.key}`);
  return r.connection;
};
const refused = (c: Connection, d: Partial<SettingsDraft>) => {
  const r = editedOf(c, { ...draftOf(c), ...d });
  return 'error' in r ? r.error.key : undefined;
};

test("a draft is the stored connection's values, by kind", () => {
  assert.equal(draftOf(tailnet).hostname, 'box');
  const cat = draftOf(tailcat);
  assert.deepEqual([cat.exit, cat.address, cat.serve, cat.relay, cat.allow], [false, '', true, '127.0.0.1:8444', 'k1\nk2']);
  assert.equal(draftOf(local).url, 'ws://127.0.0.1:8740/abc');
  assert.equal(draftOf(demo).url, '', "the project's server is the field's default, left empty");
  assert.equal(draftOf({ ...demo, demo: { url: 'wss://mine.example/' } }).url, 'wss://mine.example/');
  assert.deepEqual([draftOf(room).incoming, draftOf(room).relayOnly], [true, false]);
  assert.equal(draftOf(room).name, 'Lab');
});

test('a draft differs in what its kind shows; the name alone is not a change of settings', () => {
  const d = draftOf(room);
  assert.equal(differs('room', d, { ...d }), false);
  assert.equal(differs('room', d, { ...d, name: 'Other' }), true);
  assert.equal(differs('room', d, { ...d, relayOnly: true }), true);
  assert.equal(differs('room', d, { ...d, hostname: 'not a room field' }), false, "another kind's field");
  assert.equal(settingsChanged(room, { ...d, name: 'Other' }), false, 'a rename');
  assert.equal(settingsChanged(room, { ...d, incoming: false }), true);
  assert.equal(settingsChanged(tailnet, { ...draftOf(tailnet), hostname: 'box2' }), true);
});

test("Save's connection: each kind's values in place, the record kept, an empty name the old one", () => {
  assert.deepEqual(edited(tailnet, { hostname: 'box2', name: ' New ' }), { ...tailnet, name: 'New', tailnet: { ...tailnet.tailnet!, hostname: 'box2' } });
  assert.equal(edited(tailnet, { name: '  ' }).name, 'Lab', 'an empty name keeps the old one');
  assert.deepEqual(edited(local, { url: 'ws://127.0.0.1:8741/def' }).local, { url: 'ws://127.0.0.1:8741/def' });
  assert.deepEqual(edited(demo, { url: '' }).demo, { url: DEMO_URL }, "empty: the project's server");
  assert.deepEqual(edited(room, { incoming: false, relayOnly: true }).room, { ...room.room!, incoming: false, relayOnly: true });
  const cat = edited(tailcat, { allow: '' });
  assert.equal(cat.tailcat?.allow, undefined, 'nobody listed: the field is dropped');
  assert.equal(cat.tailcat?.identityKey, 'c1', 'the identity stays the same');
  const exit = edited(tailcat, { exit: true, address: `tc${'a'.repeat(40)}`, serve: false }).tailcat;
  assert.deepEqual([exit?.exit, exit?.serve, exit?.allow], [`tc${'a'.repeat(40)}`, false, undefined], 'an exit alone');
});

test("what's typed wrong is refused with the wizard's words", () => {
  assert.equal(refused(tailnet, { hostname: 'no good' }), 'network:network.badHostname');
  assert.equal(refused(tailcat, { exit: false, serve: false }), 'network:NetTailcatStep.chooseTailcat');
  assert.equal(refused(tailcat, { serve: true, exit: false, relay: 'https://nope/' }), 'network:tailcat.badRelay');
  assert.match(refused(local, { url: 'nope' }) ?? '', /^network:local-net\./);
  assert.match(refused(demo, { url: 'http://far.example/' }) ?? '', /^network:demo-net\./);
});
