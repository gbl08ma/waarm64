// The names agent (web/names.ts, docs/plans/room-names.md "The names agent") in Node, on the tests' module
// (target/net/ts-test.wasm) and the pretend calendars and explorer (tests/net/ots-calendar.ts), its compiled services
// routed there through `fetch` (tests/net/names-agent.ts): a claim held back until anchored, then published; an entry
// whose anchor came past REF_WINDOW (or none in its window) made again; one Web Lock a title (two tabs make one entry);
// a lost title not renewed; a zone's `seq` never shared by two copies of a title; nothing asked of any service but the
// compiled ones; the dialog's check (its servers asked for a first byte, never the id) and the last week's notice. A room's servers (the publisher through DERP) are tests/names-room.test.ts's.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { CALENDARS, EXPLORERS, exportNames, importNames, inLastWeek, LAST_WEEK_S, memoryNamesStore, roomOf, SERVICES, type TitleView } from '../web/names.ts';
import type { IdsAnswer, NamesBackend } from '../web/names-ops.ts';
import { aged, DAY, fakePublish, nowS, point, refAt, routeServices, statusOf, TEST_WASM, testAgent, type Asked } from './net/names-agent.ts';
import { startOtsCalendar, type OtsCalendar } from './net/ots-calendar.ts';

const skip = existsSync(TEST_WASM) ? false : 'no target/net/ts-test.wasm (net/ts/build.sh --test-params)';
const LINK = 'waarm64-room:names%20agent?nostr=ws%3A%2F%2F127.0.0.1%3A9&derp=127.0.0.1%3A9';
const conn = (identityKey = 'conn-a') => ({ identityKey, link: LINK });

let cal: OtsCalendar;
let asked: Asked;
let restore = () => {};
before(async () => {
  cal = await startOtsCalendar({ depth: 6 });
  ({ asked, restore } = routeServices(cal));
});
after(async () => {
  restore();
  await cal?.close();
});

test('a claim is held back until anchored, then published; the next pass of the visit puts nothing new', { skip, timeout: 60_000 }, async () => {
  const pub = fakePublish();
  const log: string[] = [];
  const { agent, store, backend } = await testAgent({ publish: pub, log });
  cal.mine(7);
  const t0 = Date.now();
  const v = await agent.register(conn(), 'test123', point());
  assert.equal(v.state, 'reserved');
  assert.ok(v.publicAbout && v.publicAbout > Date.now(), 'about when it becomes public');
  // Stamped at all three calendars: three pending anchors kept, the lowest on the entry.
  const [t] = await store.titles();
  const st = await statusOf(backend, t);
  assert.equal(st.entries.length, 1);
  assert.equal(st.entries[0].kind, 'claim');
  assert.equal(t.stamps[st.entries[0].id].length, 3);
  assert.equal(st.entries[0].pending, true);
  assert.ok(st.zone && Number(BigInt(st.zone.seq) & 0xffffffffn) === t.zone.branch, 'the zone\'s seq carries the title\'s branch');
  // Not anchored: a pass collects nothing (the proof is a 404 without CORS: a failed fetch) and publishes nothing.
  await agent.pass();
  assert.equal((await agent.titles())[0].state, 'reserved');
  assert.equal(pub.puts.length, 0, 'a claim is private until its anchor exists');
  cal.mine(5);
  await agent.pass();
  assert.equal(pub.puts.length, 0, 'five deep: the calendars still say pending');
  cal.mine();
  await agent.pass();
  assert.equal(pub.puts.length, 0, 'six deep: the proof is served, but the anchor needs the sixth header after its block');
  cal.mine();
  await agent.pass();
  const [a] = await agent.titles();
  assert.equal(a.state, 'active', log.join('\n'));
  console.log(`# from register to public under the pretend calendar: ${Date.now() - t0} ms`);
  assert.equal(pub.puts.length, 1, 'published once anchored');
  const [held] = await store.titles();
  assert.equal(pub.puts[0], held.item);
  assert.equal(held.published, held.item);
  assert.ok(a.keptUntil && a.renewAt && a.lapsesAt && a.claimedAt && a.keptUntil - a.claimedAt === 30 * DAY && a.lapsesAt - a.keptUntil === 7 * DAY);
  assert.equal(a.renewAt, a.claimedAt + 15 * DAY, 'renewed past half a term');
  await agent.pass();
  assert.equal(pub.puts.length, 1, 'unchanged and put this visit: not again');
  // A new visit (a new agent on the same titles) puts it again, once.
  const again = await testAgent({ store, publish: pub });
  await again.agent.pass();
  assert.equal(pub.puts.length, 2);
  // A zone change is published at once.
  await agent.setZone(conn(), 'test123', [{ label: null, key: 'cd'.repeat(32) }, { label: 'git', key: 'ab'.repeat(32) }]);
  assert.equal(pub.puts.length, 3);
  // The rules: a reserved name is refused.
  await assert.rejects(agent.register(conn(), 'wpad', point()), { code: 'Name' }); // i18n-ignore
});

test('an entry whose anchor came past REF_WINDOW, or none in its window, is made again', { skip, timeout: 60_000 }, async () => {
  const log: string[] = [];
  const pub = fakePublish();
  const { agent, store, backend } = await testAgent({ publish: pub, log });
  const c = conn('conn-window');
  // The chain's block 6 deep is 49 hours old: the claim made after it is anchored past its 48-hour window.
  refAt(cal, nowS() - 49 * 3600);
  await agent.register(c, 'late', point());
  const first = (await statusOf(backend, (await store.titles(c.identityKey))[0])).entries[0].id;
  cal.mine(7); // anchored now, and a recent block 6 deep for what is made again
  await agent.pass(c.identityKey);
  assert.ok(log.some((l) => l.includes('refused for good (AnchorWindow)')), log.join('\n'));
  let st = await statusOf(backend, (await store.titles(c.identityKey))[0]);
  assert.equal(st.entries.length, 1, 'made again');
  assert.notEqual(st.entries[0].id, first);
  assert.equal(st.entries[0].time, null);
  cal.mine(7);
  await agent.pass(c.identityKey);
  assert.equal((await agent.titles(c.identityKey))[0].state, 'active');
  // A block 6 deep 53 hours old: the claim can never be anchored in its window (now past it and the slack): dropped
  // at the next pass and made again, with nothing collected.
  const d = conn('conn-stale');
  refAt(cal, nowS() - 53 * 3600);
  await agent.register(d, 'stale', point());
  const old = (await statusOf(backend, (await store.titles(d.identityKey))[0])).entries[0];
  assert.equal(old.stale, true);
  cal.forget(); // its proof never comes
  cal.mine(7);
  await agent.pass(d.identityKey);
  st = await statusOf(backend, (await store.titles(d.identityKey))[0]);
  assert.equal(st.entries.length, 1);
  assert.notEqual(st.entries[0].id, old.id);
  assert.equal(st.entries[0].stale, false);
  assert.ok(log.some((l) => l.includes('never anchored in their window')));
});

test('one Web Lock a title: two tabs looking after it at once make one entry', { skip, timeout: 60_000 }, async () => {
  const store = memoryNamesStore();
  const a = await testAgent({ store });
  const b = await testAgent({ store });
  const c = conn('conn-locks');
  cal.mine(7);
  // Every calendar down: the claim can't be stamped, and waits to be made again.
  for (const x of ['alice', 'bob', 'finney'] as const) cal.down.add(x);
  await a.agent.register(c, 'twotabs', point());
  assert.equal((await a.agent.titles(c.identityKey))[0].state, 'preparing');
  cal.down.clear();
  const posts = asked.posts;
  await Promise.all([a.agent.pass(c.identityKey), b.agent.pass(c.identityKey)]);
  assert.equal(asked.posts - posts, 3, 'one claim stamped at three calendars, not two');
  const st = await statusOf(a.backend, (await store.titles(c.identityKey))[0]);
  assert.equal(st.entries.length, 1);
});

test('a better chain of another key\'s makes a title lost, and a lost title isn\'t renewed', { skip, timeout: 90_000 }, async () => {
  // Another owner's chain, claimed 25 days ago.
  const other = await testAgent({ publish: fakePublish() });
  const theirs = conn('conn-other');
  await aged(cal, other.agent, theirs, 'contested', nowS() - 25 * DAY);
  const [better] = await other.store.titles(theirs.identityKey);
  // This one's, claimed 20 days ago (so its renewal is due), shown the better chain by a server.
  const pub = fakePublish(() => [{ id: '', server: 's1', result: 'better', item: better.item }]);
  const log: string[] = [];
  const mine = await testAgent({ publish: pub, log });
  const c = conn('conn-mine');
  await aged(cal, mine.agent, c, 'contested', nowS() - 20 * DAY);
  const [v] = await mine.agent.titles(c.identityKey);
  assert.equal(v.state, 'lost', log.join('\n'));
  const key = (await other.backend.op<{ owner: string }>('key', { room: roomOf(LINK), secret: await other.store.secret(theirs.identityKey), name: 'contested' })).owner;
  assert.equal(v.lostTo, key);
  // The pass that collected the claim made the renewal (due) and then saw the better chain; after that, nothing, even
  // with that renewal gone (it is due again).
  const [t0] = await mine.store.titles(c.identityKey);
  const renewal = (await statusOf(mine.backend, t0)).entries.find((e) => e.kind === 'renew')!;
  const { item } = await mine.backend.op<{ item: string }>('drop', { item: t0.item, ids: [renewal.id] });
  await mine.store.put({ ...t0, item, stamps: {}, collect: {} });
  const [t] = await mine.store.titles(c.identityKey);
  const entries = (await statusOf(mine.backend, t)).entries.length;
  const posts = asked.posts;
  cal.mine(7);
  await mine.agent.pass(c.identityKey);
  await mine.agent.pass(c.identityKey);
  assert.equal(asked.posts, posts, 'no stamp');
  assert.equal((await statusOf(mine.backend, (await mine.store.titles(c.identityKey))[0])).entries.length, entries, 'no entry made');
  assert.equal(pub.puts.length, 1, 'not published again');
  // A forged better chain changes nothing (the server lies): a fresh title shown a broken one stays its own.
  const forged = better.item.replace(/.{8}$/, (s) => (parseInt(s, 16) ^ 1).toString(16).padStart(8, '0'));
  const liar = await testAgent({ publish: fakePublish(() => [{ id: '', server: 's2', result: 'better', item: forged }]) });
  const l = conn('conn-liar');
  await aged(cal, liar.agent, l, 'contested', nowS() - 20 * DAY);
  assert.notEqual((await liar.agent.titles(l.identityKey))[0].state, 'lost');
});

test('a title exported to another browser: the two copies never share a zone\'s seq', { skip, timeout: 60_000 }, async () => {
  const a = await testAgent({ publish: fakePublish() });
  const ca = conn('conn-fork-a');
  cal.mine(7);
  await a.agent.register(ca, 'forked', point());
  cal.mine(7);
  await a.agent.pass(ca.identityKey);
  const bundle = await exportNames(a.store, ca.identityKey);
  assert.ok(bundle);
  const b = await testAgent({ publish: fakePublish() });
  const cb = conn('conn-fork-b');
  await importNames(b.store, cb.identityKey, bundle);
  assert.equal(await b.store.secret(cb.identityKey), await a.store.secret(ca.identityKey), 'the owners\' secret travels');
  const [ta] = await a.store.titles(ca.identityKey);
  const [tb] = await b.store.titles(cb.identityKey);
  assert.equal(tb.item, ta.item, 'the title travels');
  assert.notEqual(tb.zone.branch, ta.zone.branch);
  // Both change the zone from the same state (each its own content): their seqs differ.
  await a.agent.setZone(ca, 'forked', [{ label: null, key: '11'.repeat(32) }]);
  await b.agent.setZone(cb, 'forked', [{ label: null, key: '22'.repeat(32) }]);
  const za = (await statusOf(a.backend, (await a.store.titles(ca.identityKey))[0])).zone!;
  const zb = (await statusOf(b.backend, (await b.store.titles(cb.identityKey))[0])).zone!;
  assert.equal(BigInt(za.seq) >> 32n, BigInt(zb.seq) >> 32n, 'the same count');
  assert.notEqual(za.seq, zb.seq, 'never the same seq');
});

test('one export pasted into two browsers: each copy a branch of its own, so their zones never share a seq', { skip, timeout: 60_000 }, async () => {
  const a = await testAgent({ publish: fakePublish() });
  const ca = conn('conn-paste-a');
  cal.mine(7);
  await a.agent.register(ca, 'pasted', point());
  cal.mine(7);
  await a.agent.pass(ca.identityKey);
  const bundle = (await exportNames(a.store, ca.identityKey))!;
  // The same text pasted twice (two browsers), and once more into a third connection of the second.
  const copies = [];
  for (const k of ['conn-paste-b', 'conn-paste-c']) {
    const x = await testAgent({ publish: fakePublish() });
    await importNames(x.store, k, bundle);
    copies.push({ ...x, c: conn(k) });
  }
  await importNames(copies[1].store, 'conn-paste-d', bundle);
  const [ta] = await a.store.titles(ca.identityKey);
  const branches = [ta.zone.branch];
  for (const x of copies) branches.push((await x.store.titles(x.c.identityKey))[0].zone.branch);
  branches.push((await copies[1].store.titles('conn-paste-d'))[0].zone.branch);
  assert.equal(new Set(branches).size, branches.length, `every copy a branch of its own: ${branches.join(', ')}`);
  // Both pasted copies change the zone from the same state, each its own content: their seqs differ.
  const seqs: string[] = [];
  for (const [i, x] of copies.entries()) {
    await x.agent.setZone(x.c, 'pasted', [{ label: null, key: `${i + 1}`.repeat(64) }]);
    seqs.push(String((await statusOf(x.backend, (await x.store.titles(x.c.identityKey))[0])).zone!.seq));
  }
  assert.notEqual(seqs[0], seqs[1], 'never the same seq');
});

test('a zone the room\'s servers didn\'t take: counted past the room\'s and put again, not called published (review 2, finding 10)', { skip, timeout: 60_000 }, async () => {
  // Two copies of one title: B's zone is further along (n 4), A's behind it.
  const a = await testAgent({ publish: fakePublish() });
  const ca = conn('conn-zone-a');
  cal.mine(7);
  await a.agent.register(ca, 'zoned', point());
  cal.mine(7);
  await a.agent.pass(ca.identityKey);
  const b = await testAgent({ publish: fakePublish() });
  const cb = conn('conn-zone-b');
  await importNames(b.store, cb.identityKey, (await exportNames(a.store, ca.identityKey))!);
  for (const k of ['11', '22', '33']) await b.agent.setZone(cb, 'zoned', point(k.repeat(32)));
  const [tb] = await b.store.titles(cb.identityKey);
  const roomSeq = BigInt((await statusOf(b.backend, tb)).zone!.seq);
  // A saves new points; the room's servers hold B's zone and refuse A's (a lower seq): `better`, with B's item.
  let answer: 'better' | 'taken' = 'better';
  const pub = fakePublish(() => [{ id: '', server: 's1', result: answer, item: answer === 'better' ? tb.item : null }]);
  const log: string[] = [];
  const a2 = await testAgent({ store: a.store, publish: pub, log });
  await a2.agent.setZone(ca, 'zoned', point('44'.repeat(32)));
  assert.equal(pub.puts.length, 1);
  const [ta] = await a.store.titles(ca.identityKey);
  const seq = BigInt((await statusOf(a.backend, ta)).zone!.seq);
  assert.ok(seq >> 32n > roomSeq >> 32n, `counted past the room's: ${seq >> 32n} against ${roomSeq >> 32n}\n${log.join('\n')}`);
  assert.notEqual(ta.published, ta.item, 'not called published');
  assert.ok(ta.putAgain, 'put again later');
  // The next pass puts the new zone; taken, it is published.
  answer = 'taken';
  await a2.agent.pass(ca.identityKey);
  assert.equal(pub.puts.at(-1), ta.item);
  const [done] = await a.store.titles(ca.identityKey);
  assert.equal(done.published, done.item);
  assert.equal(done.putAgain, undefined);
  // A second Save within the servers' 10 minutes: they keep the zone before (`better` with it), so it isn't called
  // published, and it is put again later.
  const before = done.item;
  const pub2 = fakePublish(() => [{ id: '', server: 's1', result: 'better', item: before }]);
  const a3 = await testAgent({ store: a.store, publish: pub2 });
  await a3.agent.setZone(ca, 'zoned', point('55'.repeat(32)));
  const [again] = await a.store.titles(ca.identityKey);
  assert.notEqual(again.item, before);
  assert.notEqual(again.published, again.item, 'the servers kept the zone before');
  assert.ok(again.putAgain);
});

test('production talks to the compiled calendars and explorers only: no link, title or receipt names another', { skip, timeout: 60_000 }, async () => {
  // The calendars are the module's, in its order (anchor.rs `Calendar::url`: a pending anchor names one by index).
  const rust = readFileSync(new URL('../net/ts/src/room/names/anchor.rs', import.meta.url), 'utf8');
  assert.deepEqual([...rust.matchAll(/Calendar::\w+ => "(https:\/\/[^"]+)"/g)].map((m) => m[1]), [...CALENDARS]);
  assert.deepEqual([...EXPLORERS], ['https://blockstream.info/api', 'https://mempool.space/api']);
  assert.deepEqual(SERVICES, [...CALENDARS, ...EXPLORERS]);
  // A full life (register, collect, renew, publish) with a link that carries made-up services, and a title whose stored
  // fields name one: the pretend calendars' receipts name their own address (127.0.0.1) as a real one names itself,
  // and it is never asked.
  const before = asked.urls.length;
  const pub = fakePublish();
  const { agent, store } = await testAgent({ publish: pub });
  const c = { identityKey: 'conn-services', link: `${LINK}&calendar=${encodeURIComponent('https://calendar.evil.example')}&explorer=https%3A%2F%2Fevil.example` };
  await aged(cal, agent, c, 'services', nowS() - 20 * DAY);
  const [t] = await store.titles(c.identityKey);
  await store.put({ ...t, link: `${t.link}&url=https://evil.example`, ...({ calendar: 'https://evil.example' } as object) });
  cal.mine(7);
  await agent.pass(c.identityKey);
  assert.equal((await agent.titles(c.identityKey))[0].state, 'active');
  const urls = asked.urls.slice(before);
  assert.ok(urls.some((u) => u.includes('/timestamp/')) && urls.some((u) => u.includes('/digest')) && urls.some((u) => u.includes('/header')));
  assert.deepEqual(asked.foreign, [], 'nothing but the compiled services');
  for (const u of urls) assert.ok(SERVICES.some((s) => u.startsWith(`${s}/`)), u);
});

test('the dialog\'s check: the rules, this connection\'s own, and what servers hold under the id\'s first byte (never the id)', { skip, timeout: 60_000 }, async () => {
  const { agent, backend } = await testAgent();
  const firsts: number[] = [];
  let answer: (first: number) => Promise<IdsAnswer> = () => Promise.resolve({ result: 'nobody', ids: [] });
  // The servers' answers as the test says; what the agent asked recorded (a first byte, nothing else).
  (backend as { ids: NamesBackend['ids'] }).ids = (_link, first) => { firsts.push(first); return answer(first); };
  for (const bad of ['', 'Wpad', 'wpad', 'com', 'ab', 'xn--abc', '-ab', 'x'.repeat(33), 'has.dot']) {
    assert.deepEqual(await agent.check(conn(), bad), { state: 'invalid' }, bad);
  }
  assert.deepEqual(firsts, [], 'a name the rules refuse asks nobody');
  const { id } = await backend.op<{ id: string }>('key', { room: roomOf(LINK), secret: '11'.repeat(32), name: 'mybox' });
  const first = parseInt(id.slice(0, 2), 16);
  assert.deepEqual(await agent.check(conn(), 'mybox'), { state: 'unknown' }, 'nobody serves: nobody can say');
  assert.deepEqual(firsts, [first], 'the id\'s first byte alone');
  const other = `${id.slice(0, 2)}${'0'.repeat(62)}`;
  answer = () => Promise.resolve({ result: 'ids', ids: [[other, nowS() + DAY]] });
  assert.deepEqual(await agent.check(conn(), 'mybox'), { state: 'free' }, 'another name under its byte');
  const until = nowS() + 20 * DAY;
  answer = () => Promise.resolve({ result: 'ids', ids: [[other, 0], [id, until]] });
  assert.deepEqual(await agent.check(conn(), 'mybox'), { state: 'taken', until });
  answer = () => Promise.resolve({ result: 'ids', ids: [[id, 0]] });
  assert.deepEqual(await agent.check(conn(), 'mybox'), { state: 'free' }, 'held, but nobody owns it now');
  answer = () => Promise.resolve({ result: 'failed', ids: [] });
  assert.deepEqual(await agent.check(conn(), 'mybox'), { state: 'unknown' }, 'no server answered');
  // This connection's own already.
  cal.mine(7);
  await agent.register(conn(), 'mybox', point());
  const asked = firsts.length;
  assert.deepEqual(await agent.check(conn(), 'mybox'), { state: 'yours' });
  assert.equal(firsts.length, asked, 'its own: nobody asked');
  assert.deepEqual(await agent.held('conn-a'), ['mybox'], 'what deleting the connection would lose');
  await agent.forget('conn-a');
  assert.deepEqual(await agent.titles('conn-a'), []);
});

test('on load the page says which names are in their last week: still resolving or in their grace, kept less than a week', () => {
  const now = 1_800_000_000;
  const v = (name: string, state: TitleView['state'], keptUntil?: number): TitleView => ({ identityKey: 'k', room: 'r', link: LINK, name, state, keptUntil, points: [] });
  const views = [
    v('soon', 'active', now + 6 * DAY), v('later', 'active', now + 8 * DAY), v('grace', 'grace', now - DAY),
    v('gone', 'lapsed', now - 9 * DAY), v('let', 'released', now + DAY), v('lost', 'lost'), v('new', 'reserved'),
    v('sooner', 'active', now + 2 * DAY),
  ];
  assert.deepEqual(inLastWeek(views, now).map((x) => x.name), ['grace', 'sooner', 'soon']);
  assert.deepEqual(inLastWeek([v('edge', 'active', now + LAST_WEEK_S)], now), [], 'a week exactly: not yet');
});
