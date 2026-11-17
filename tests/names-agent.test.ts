// The names agent (web/names.ts, docs/plans/room-names.md "The names agent") in Node, on the tests' module
// (target/net/ts-test.wasm) and the pretend calendars and explorer (tests/net/ots-calendar.ts), its compiled services
// routed there through `fetch` (tests/net/names-agent.ts): a claim held back until anchored, then published; an entry
// whose anchor came past REF_WINDOW (or none in its window) made again; one Web Lock a title (two tabs make one entry);
// a lost title not renewed; a zone's `seq` never shared by two copies of a title; nothing asked of any service but the
// compiled ones; the dialog's check (as typed, by the page alone; at Register, its servers asked for one first byte, never the id) and the last week's notice. A room's servers (the publisher through DERP) are tests/names-room.test.ts's.
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
  const clock = Date.now;
  Date.now = () => clock() - 60_000; // stamped a minute ago
  try {
    await agent.register(c, 'late', point());
  } finally {
    Date.now = clock;
  }
  const first = (await statusOf(backend, (await store.titles(c.identityKey))[0])).entries[0].id;
  const stamped = (await store.titles(c.identityKey))[0].stampedAt!;
  cal.mine(7); // anchored now, and a recent block 6 deep for what is made again
  await agent.pass(c.identityKey);
  assert.ok(log.some((l) => l.includes('refused for good (AnchorWindow)')), log.join('\n'));
  assert.ok((await store.titles(c.identityKey))[0].stampedAt! > stamped, 'the claim made again: "public in about" counts from its stamp (review 2)');
  let st = await statusOf(backend, (await store.titles(c.identityKey))[0]);
  assert.equal(st.entries.length, 1, 'made again');
  assert.notEqual(st.entries[0].id, first);
  assert.equal(st.entries[0].time, null);
  cal.mine(7);
  await agent.pass(c.identityKey);
  assert.equal((await agent.titles(c.identityKey))[0].state, 'active');
  // A block 6 deep 53 hours old: the claim is past its window and the slack, unanchored. Another is made at the next
  // pass; the first is kept and asked for (an anchor in its window may still come: review 2), and dropped a week
  // past its window.
  const d = conn('conn-stale');
  refAt(cal, nowS() - 53 * 3600);
  await agent.register(d, 'stale', point());
  const old = (await statusOf(backend, (await store.titles(d.identityKey))[0])).entries[0];
  assert.equal(old.stale, true);
  cal.forget(); // its proof never comes
  cal.mine(7);
  await agent.pass(d.identityKey);
  st = await statusOf(backend, (await store.titles(d.identityKey))[0]);
  assert.equal(st.entries.length, 2, 'made again, the first kept');
  const fresh = st.entries.find((e) => e.id !== old.id)!;
  assert.equal(fresh.stale, false);
  const real = Date.now;
  Date.now = () => real() + 8 * DAY * 1000;
  try {
    await agent.pass(d.identityKey);
  } finally {
    Date.now = real;
  }
  st = await statusOf(backend, (await store.titles(d.identityKey))[0]);
  assert.ok(!st.entries.some((e) => e.id === old.id), 'dropped a week past its window');
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
  assert.ok(pub.puts.length > 1, 'put again, so that it is judged again (review 2)');
  assert.equal((await mine.agent.titles(c.identityKey))[0].state, 'lost', 'and still lost');
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

/** `globalThis.fetch` failing the URLs `bad` names (or answering them as it says) until the restore. */
function breakFetch(bad: (url: string) => Response | 'fail' | undefined): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const b = bad(url);
    if (b === 'fail') return Promise.reject(new TypeError(`down: ${url}`));
    if (b) return Promise.resolve(b);
    return real(input, init);
  };
  return () => { globalThis.fetch = real; };
}

test('a renewal collected late revives its chain: not dropped on one failed try, and the title not lost meanwhile (review 2, findings 4 and 8)', { skip, timeout: 90_000 }, async () => {
  const log: string[] = [];
  const real = Date.now;
  const shift = 4 * DAY * 1000;
  let interloper = '';
  const pub = fakePublish(() => [{ id: '', server: 's1', result: interloper ? 'better' : 'taken', item: interloper || null }]);
  const { agent, store, backend } = await testAgent({ publish: pub, log });
  const c = conn('conn-revived');
  try {
    // Four days ago: the claim (36 days old then) and its renewal, made and stamped; the page closes before the
    // renewal's anchor is collected.
    Date.now = () => real() - shift;
    const s = nowS();
    refAt(cal, s - 36 * DAY);
    await agent.register(c, 'revived', point());
    cal.mine(7, s - 36 * DAY + 3600);
    refAt(cal, s);
    await agent.pass(c.identityKey);
    const st = await statusOf(backend, (await store.titles(c.identityKey))[0]);
    assert.ok(st.entries.some((e) => e.kind === 'renew' && e.time === null), `a renewal waits: ${log.join('\n')}`);
    cal.mine(7, s + 3600); // its block, an hour later
  } finally {
    Date.now = real;
  }
  // Now: the claim's chain alone has lapsed, and another key's claim of two days ago owns the name in the room.
  const other = await testAgent({ publish: fakePublish() });
  const oc = conn('conn-interloper');
  await aged(cal, other.agent, oc, 'revived', nowS() - 2 * DAY);
  interloper = (await other.store.titles(oc.identityKey))[0].item;
  // The first pass of the visit can't reach the calendars: the renewal is kept, and the title isn't called lost.
  const restore = breakFetch((u) => (u.includes('/timestamp/') ? 'fail' : undefined));
  try {
    await agent.pass(c.identityKey);
  } finally {
    restore();
  }
  let [t] = await store.titles(c.identityKey);
  assert.ok((await statusOf(backend, t)).entries.some((e) => e.kind === 'renew'), `the renewal is kept: ${log.join('\n')}`);
  assert.equal(t.lost, undefined, 'not lost while its own renewal waits');
  // The next pass collects it: the chain is the claim's of 36 days ago, renewed, and beats the interloper's.
  await agent.pass(c.identityKey);
  [t] = await store.titles(c.identityKey);
  const [v] = await agent.titles(c.identityKey);
  assert.equal(v.state, 'active', log.join('\n'));
  assert.equal(t.lost, undefined);
});

test('a calendar answering junk, or an explorer an inconsistent run, doesn\'t drop an entry: the others are tried (review 2, finding 4)', { skip, timeout: 60_000 }, async () => {
  const log: string[] = [];
  const { agent, store, backend } = await testAgent({ publish: fakePublish(), log });
  // The first calendar answers 200 with a page that isn't a timestamp.
  const c = conn('conn-junk-calendar');
  cal.mine(7);
  await agent.register(c, 'junkcal', point());
  cal.mine(7);
  const restore = breakFetch((u) => (u.startsWith(`${CALENDARS[0]}/timestamp/`) ? new Response('<html>a proxy</html>', { status: 200 }) : undefined));
  try {
    await agent.pass(c.identityKey);
  } finally {
    restore();
  }
  assert.equal((await agent.titles(c.identityKey))[0].state, 'active', log.join('\n'));
  // The first explorer serves the block's header for every follower (a run that doesn't link): the second's is used.
  const d = conn('conn-junk-explorer');
  cal.mine(7);
  await agent.register(d, 'junkexp', point());
  cal.mine(7);
  // Followers' headers at the first explorer: the block's own.
  let first: string | undefined;
  const real = globalThis.fetch;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const m = /\/block\/([0-9a-f]{64})\/header$/.exec(url);
    if (url.startsWith(EXPLORERS[0]) && m) {
      if (!first) first = m[1];
      else if (m[1] !== first) return real(`${EXPLORERS[0]}/block/${first}/header`, init);
    }
    return real(input, init);
  };
  try {
    await agent.pass(d.identityKey);
  } finally {
    globalThis.fetch = real;
  }
  const st = await statusOf(backend, (await store.titles(d.identityKey))[0]);
  assert.ok(st.entries[0].time !== null, `anchored through the second explorer: ${log.join('\n')}`);
});

test('Let it go while a renewal waits for its anchor: the renewal goes, and a release no calendar stamped is made again (review 2, finding 6)', { skip, timeout: 90_000 }, async () => {
  const log: string[] = [];
  const pub = fakePublish();
  const { agent, store, backend } = await testAgent({ publish: pub, log });
  const c = conn('conn-letgo');
  // Claimed 20 days ago: the pass that collects the claim renews it, and the renewal waits for its anchor.
  await aged(cal, agent, c, 'letgo', nowS() - 20 * DAY);
  let st = await statusOf(backend, (await store.titles(c.identityKey))[0]);
  const renewal = st.entries.find((e) => e.kind === 'renew' && e.time === null);
  assert.ok(renewal, log.join('\n'));
  await agent.release(c, 'letgo');
  let [t] = await store.titles(c.identityKey);
  st = await statusOf(backend, t);
  assert.ok(!st.entries.some((e) => e.id === renewal.id), 'the waiting renewal is dropped: it would outlive the release');
  assert.equal(t.stamps[renewal.id], undefined);
  const release = st.entries.find((e) => e.kind === 'release');
  assert.ok(release && t.stamps[release.id]?.length, 'the release made and stamped');
  // Collected: the chain ends in the release.
  cal.mine(7);
  await agent.pass(c.identityKey);
  st = await statusOf(backend, (await store.titles(c.identityKey))[0]);
  assert.ok(st.best?.released, 'the chain ends in the release');
  // Another name let go while no calendar answers: made again at the next pass.
  const d = conn('conn-letgo2');
  await aged(cal, agent, d, 'letgo2', nowS() - 5 * DAY);
  const restore = breakFetch((u) => (u.endsWith('/digest') ? 'fail' : undefined));
  try {
    await agent.release(d, 'letgo2');
  } finally {
    restore();
  }
  [t] = await store.titles(d.identityKey);
  assert.ok(!(await statusOf(backend, t)).entries.some((e) => e.kind === 'release'), 'not stamped: not kept');
  cal.mine(7);
  await agent.pass(d.identityKey);
  [t] = await store.titles(d.identityKey);
  const r2 = (await statusOf(backend, t)).entries.find((e) => e.kind === 'release');
  assert.ok(r2 && t.stamps[r2.id]?.length, `made again: ${log.join('\n')}`);
});

test('an export pasted into a connection that has an owners\' secret already: its titles keep their own (review 2, finding 11)', { skip, timeout: 60_000 }, async () => {
  const log: string[] = [];
  // Browser B's connection holds a name of its own, so it has a secret.
  const b = await testAgent({ publish: fakePublish(), log });
  const cb = conn('conn-has-secret');
  cal.mine(7);
  await b.agent.register(cb, 'bsown', point());
  const before = await b.store.secret(cb.identityKey);
  // Browser A's title, claimed 16 days ago (its renewal due), exported before A collected it.
  const a = await testAgent({ publish: fakePublish() });
  const ca = conn('conn-a-export');
  refAt(cal, nowS() - 16 * DAY);
  await a.agent.register(ca, 'moved', point());
  cal.mine(7, nowS() - 16 * DAY + 3600);
  cal.mine(7);
  await importNames(b.store, cb.identityKey, (await exportNames(a.store, ca.identityKey))!);
  assert.equal(await b.store.secret(cb.identityKey), before, 'the connection keeps its secret');
  await b.agent.pass(cb.identityKey);
  const t = (await b.store.titles(cb.identityKey)).find((x) => x.name === 'moved')!;
  const st = await statusOf(b.backend, t);
  const claim = st.entries.find((e) => e.kind === 'claim')!;
  const renewal = st.entries.find((e) => e.kind === 'renew');
  assert.ok(renewal, log.join('\n'));
  assert.equal(renewal.owner, claim.owner, 'renewed with the title\'s own key');
  assert.equal((await b.agent.titles(cb.identityKey)).find((v) => v.name === 'moved')?.state, 'active');
});

test('a title publishes through its connection\'s link as it is now, not the one it was registered with (review 2, finding 16)', { skip, timeout: 60_000 }, async () => {
  const pub = fakePublish();
  const { agent: agent2, store } = await testAgent({ publish: pub });
  const links = pub.links;
  const c = conn('conn-relink');
  cal.mine(7);
  await agent2.register(c, 'relinked', point());
  cal.mine(7);
  await agent2.pass(c.identityKey);
  assert.equal(links.at(-1), LINK);
  // The connection now reaches the room through other relays: the same room's ID, another link.
  const moved = `${LINK}&nostr=${encodeURIComponent('ws://127.0.0.1:10')}`;
  await agent2.relink({ identityKey: c.identityKey, link: moved });
  const [t] = await store.titles(c.identityKey);
  assert.equal(t.link, moved);
  await agent2.setZone({ identityKey: c.identityKey, link: moved }, 'relinked', point('77'.repeat(32)));
  assert.equal(links.at(-1), moved, 'published through the link the connection has now');
  // Another room's connection changes nothing.
  await agent2.relink({ identityKey: c.identityKey, link: 'waarm64-room:another' });
  assert.equal((await store.titles(c.identityKey))[0].link, moved);
});

test('a zone of more than four points is sealed wide: sixteen slots (review 2, finding 17)', { skip, timeout: 60_000 }, async () => {
  const { agent, store, backend } = await testAgent({ publish: fakePublish() });
  const c = conn('conn-wide');
  cal.mine(7);
  await agent.register(c, 'wide', point());
  const many = [{ label: null, key: '01'.repeat(32) }, ...['a', 'b', 'c', 'd', 'e'].map((l, i) => ({ label: l, key: `${i + 2}`.padStart(2, '0').repeat(32) }))];
  await agent.setZone(c, 'wide', many);
  const [t] = await store.titles(c.identityKey);
  assert.equal(t.points.length, 6);
  assert.ok((await statusOf(backend, t)).zone);
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

test('the dialog\'s check: as typed, the rules and this connection\'s own, asking no server; at Register, one first byte, never the id', { skip, timeout: 60_000 }, async () => {
  const { agent, backend } = await testAgent();
  const firsts: number[] = [];
  let answer: () => Promise<IdsAnswer> = () => Promise.resolve({ result: 'nobody', ids: [] });
  // The servers' answers as the test says; what the agent asked recorded.
  (backend as { ids: NamesBackend['ids'] }).ids = (_link, first) => { firsts.push(first); return answer(); };
  for (const bad of ['', 'Wpad', 'wpad', 'com', 'ab', 'xn--abc', '-ab', 'x'.repeat(33), 'has.dot']) {
    assert.deepEqual(await agent.checkHere(conn(), bad), { state: 'invalid' }, bad);
    assert.deepEqual(await agent.check(conn(), bad), { state: 'invalid' }, bad);
  }
  assert.deepEqual(firsts, [], 'a name the rules refuse asks nobody');
  const { id } = await backend.op<{ id: string }>('key', { room: roomOf(LINK), secret: '11'.repeat(32), name: 'mybox' });
  const first = parseInt(id.slice(0, 2), 16);
  // Typed a letter at a time: the page alone, no server asked (the user's decision, 2026-11-17; review 2, finding 1:
  // each prefix's first byte, asked as typed, told a server the name a character at a time).
  for (const typed of ['m', 'my', 'myb', 'mybo', 'mybox']) assert.equal((await agent.checkHere(conn(), typed)).state, typed === 'my' ? 'invalid' : 'valid', typed);
  assert.deepEqual(firsts, [], 'typing asks no server');
  // Register pressed: one first byte, the name's id's.
  assert.deepEqual(await agent.check(conn(), 'mybox'), { state: 'unknown' }, 'nobody serves: nobody can say');
  assert.deepEqual(firsts, [first], 'one byte, the id\'s first');
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
  assert.deepEqual(firsts, [first, first, first, first, first], 'one byte a check');
  // This connection's own already.
  cal.mine(7);
  await agent.register(conn(), 'mybox', point());
  const n = firsts.length;
  assert.deepEqual(await agent.checkHere(conn(), 'mybox'), { state: 'yours' });
  assert.deepEqual(await agent.check(conn(), 'mybox'), { state: 'yours' });
  assert.equal(firsts.length, n, 'its own: nobody asked');
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
