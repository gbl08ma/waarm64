// The names agent (web/names.ts) with a room's real servers in Node: room nodes on the tests' module
// (target/net/ts-test.wasm) serving titles, a member resolving names through its resolver (the guest's DNS query
// as a packet), and the agent publishing with no machine running, through a publisher (a names client alone) over the
// tailcat rig's derper and the tests' Nostr relay; the calendars and explorers are the pretend ones
// (tests/net/ots-calendar.ts, through `fetch`: tests/net/names-agent.ts). A claim public once anchored and resolved; a
// renewal made with the machine off (its pending anchor signed, held by the servers) that a second member then
// resolves; a title renewed in two browsers, the fork settled; a name lost to a better chain.
// Opt-in with the rig: WAARM64_TAILCAT=1 (Go for derper), and net/ts/build.sh --test-params.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { exportNames, importNames, roomTitles, serviceFetch, type NamesConn, type TitleRecord } from '../web/names.ts';
import { namesOp } from '../web/names-ops.ts';
import { TsClient, type TsEvent } from '../web/ts-client.ts';
import { aged, DAY, nowS, point, routeServices, statusOf, TEST_WASM, testAgent, testModule, type Asked } from './net/names-agent.ts';
import { startNostrRelay, type NostrRelay } from './net/nostr-relay.ts';
import { startOtsCalendar, type OtsCalendar } from './net/ots-calendar.ts';
import { dnsQuery, udp } from './net/packets.ts';
import { RIG_RELAY } from './net/tailcat-cli.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const has = (cmd: string, arg = '--version') => spawnSync(cmd, [arg], { stdio: 'ignore' }).status === 0;
const skip = process.env.WAARM64_TAILCAT !== '1' ? 'SKIPPED: set WAARM64_TAILCAT=1 (the tailcat rig\'s derper)'
  : !existsSync(TEST_WASM) ? 'SKIPPED: no target/net/ts-test.wasm (net/ts/build.sh --test-params)'
  : !has('go', 'version') && !existsSync(`${ROOT}target/net/tailcat-test/bin/derper`) ? 'SKIPPED: no Go to build derper'
  : undefined;
const script = `${ROOT}tests/net/tailcat.sh`;

let cal: OtsCalendar;
/** Every fetch a node asked of the page, and whether that node was a server. */
const fetches: { url: string; server: boolean }[] = [];
let nostr: NostrRelay;
let asked: Asked;
let restore = () => {};
const nodes: TsClient[] = [];
before(async () => {
  if (skip) return;
  execFileSync(script, ['up'], { encoding: 'utf8', timeout: 300_000 });
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // the rig's relay's self-signed certificate
  nostr = await startNostrRelay();
  cal = await startOtsCalendar({ depth: 6 });
  ({ asked, restore } = routeServices(cal));
});
after(async () => {
  for (const n of nodes) n.close();
  restore();
  await cal?.close();
  await nostr?.close();
  if (!skip) spawnSync(script, ['down']);
});

const linkOf = (id: string) => `waarm64-room:${encodeURIComponent(id)}?nostr=${encodeURIComponent(nostr.url)}&derp=${encodeURIComponent(RIG_RELAY)}`;
const v6 = (b: number[]) => Array.from({ length: 8 }, (_, k) => ((b[2 * k] << 8) | b[2 * k + 1]).toString(16)).join(':');

type Node = { c: TsClient; events: TsEvent[]; self(): Extract<TsEvent, { type: 'self' }>; ask(name: string): Promise<{ rcode: number; answers: number }> };

/** A room node (a page with a machine: a server with `titles`, else a member), `Running`. */
async function node(link: string, titles: { key: string; item: string }[] = []): Promise<Node> {
  const m = await testModule();
  const events: TsEvent[] = [];
  const replies: Uint8Array[] = [];
  let running!: () => void;
  const up = new Promise<void>((r) => { running = r; });
  let me: TsClient | undefined;
  const c = new TsClient(m, { room: { link, relayOnly: true, ...(titles.length ? { names: { titles } } : {}) } }, {
    // A server's asks outside the room, as the room's worker makes them (web/room-worker.ts), routed to the pretend
    // services; a member's node never asks.
    namesFetch: (id, url) => {
      fetches.push({ url, server: titles.length > 0 });
      void serviceFetch(url).then((r) => me?.namesFetched(id, r.status, r.body));
    },
    packet: (p) => replies.push(p),
    event(e) {
      events.push(e);
      if (e.type === 'state' && e.state === 'Running') running(); // i18n-ignore
    },
  });
  me = c;
  nodes.push(c);
  await Promise.race([up, new Promise((_, rej) => setTimeout(() => rej(new Error(`not Running: ${JSON.stringify(events.slice(-5))}`)), 20_000))]);
  const self = () => events.find((e): e is Extract<TsEvent, { type: 'self' }> => e.type === 'self')!;
  let qid = 1;
  return {
    c, events, self,
    async ask(name) {
      const s = self();
      const me = v6(s.address6);
      const resolver = v6([...s.address6.slice(0, 6), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x53]);
      const id = qid++;
      replies.length = 0;
      c.guest(udp(me, 40000 + id, resolver, 53, dnsQuery(id, `${name}.${s.tag}.p2p.internal`, 28)));
      const t0 = Date.now();
      for (;;) {
        const r = replies.find((p) => p[6] === 17 && p.length > 48 + 12 && ((p[48] << 8) | p[49]) === id);
        if (r) {
          const d = r.subarray(48);
          return { rcode: d[3] & 15, answers: (d[6] << 8) | d[7] };
        }
        if (Date.now() - t0 > 6000) return { rcode: -1, answers: 0 };
        await new Promise((res) => setTimeout(res, 50));
      }
    },
  };
}

/** Asks until the answer is `want` (a guest's resolver retries), for at most `ms`. */
async function resolves(n: Node, name: string, want: number, ms = 60_000) {
  const t0 = Date.now();
  let a = { rcode: -1, answers: 0 };
  while (Date.now() - t0 < ms) {
    a = await n.ask(name);
    if (a.rcode === want && (want !== 0 || a.answers > 0)) return Date.now() - t0;
    await new Promise((r) => setTimeout(r, 2000));
  }
  assert.fail(`${name}: ${JSON.stringify(a)}, not rcode ${want}`);
}

/** Two servers of the room, each with a name of its own made by an agent (claimed 25 days ago); found and synced. */
async function room(id: string) {
  const link = linkOf(id);
  const servers: Node[] = [];
  const own = await testAgent();
  for (const name of ['alpha', 'bravo']) {
    const c = { identityKey: `server-${name}`, link };
    await aged(cal, own.agent, c, name, nowS() - 25 * DAY);
    const titles = await roomTitles(own.store, (op, input) => namesOp(await0, op, input), c.identityKey, id);
    servers.push(await node(link, titles));
  }
  // The first question of each finds nobody; the next finds the other.
  await new Promise((r) => setTimeout(r, 4000));
  return { link, servers, own };
}
let await0: Awaited<ReturnType<typeof testModule>>;
before(async () => { if (!skip) await0 = await testModule(); });

const titleOf = async (store: { titles(i?: string): Promise<TitleRecord[]> }, c: NamesConn) => (await store.titles(c.identityKey))[0];

test('with no machine running: a claim public once anchored, and a renewal made in its grace that the servers finish with the page closed, and a second member then resolves', { skip, timeout: 240_000 }, async () => {
  const id = `names room ${Math.random()}`;
  const { link, servers } = await room(id);
  const member1 = await node(link);
  const log: string[] = [];
  const { agent, store, backend } = await testAgent({ log });
  // A claim: held back while it waits for its anchor; once anchored, published, and a member resolves it.
  const c = { identityKey: 'conn-1', link };
  await agent.register(c, 'charlie', point(servers[0].self().key.replace('nodekey:', '')));
  await resolves(member1, 'charlie', 3, 15_000);
  cal.mine(7);
  const t0 = Date.now();
  await agent.pass(c.identityKey);
  assert.equal((await agent.titles(c.identityKey))[0].state, 'active', log.join('\n'));
  assert.ok((await titleOf(store, c)).publishedAt, log.join('\n'));
  console.log(`# collected and published through the rig: ${Date.now() - t0} ms`);
  const member2 = await node(link);
  await resolves(member2, 'charlie', 0);
  // A title in its grace (claimed 31 days ago): it resolves for nobody until renewed.
  const d = { identityKey: 'conn-2', link };
  await aged(cal, agent, d, 'delta', nowS() - 31 * DAY, point(servers[1].self().key.replace('nodekey:', '')));
  // That pass collected the claim, made the renewal (due) and published it with its signed pending anchor: the servers
  // hold it (a server keeps only a pending anchor its owner key signed).
  let t = await titleOf(store, d);
  let st = await statusOf(backend, t);
  const renewal = st.entries.find((e) => e.kind === 'renew')!;
  assert.ok(renewal && renewal.time === null && renewal.pending);
  assert.ok(t.publishedAt, log.join('\n'));
  await resolves(member2, 'delta', 3, 15_000);
  // Its anchor finishes at the calendar while no page is open: the servers finish it themselves (the calendar's proof,
  // then the block's hash and header at an explorer) and a second member resolves it, the agent never asked.
  const asked0 = fetches.length;
  cal.mine(7);
  const t1 = Date.now();
  const member3 = await node(link);
  await resolves(member3, 'delta', 0, 60_000);
  const mine = fetches.slice(asked0);
  console.log(`# a renewal finished by the servers: ${Date.now() - t1} ms after its block; asks ${JSON.stringify(mine.map((f) => new URL(f.url).pathname.split('/').slice(0, 3).join('/')))}`);
  assert.ok(mine.some((f) => f.url.includes('/timestamp/')) && mine.some((f) => f.url.includes('/block-height/')), 'the calendar and an explorer asked');
  assert.ok(fetches.every((f) => f.server), 'only servers fetch: a member asks nothing outside the room');
  assert.deepEqual(asked.foreign, [], 'the compiled services only');
  // The next visit finds it anchored in the room.
  await agent.pass(d.identityKey);
  t = await titleOf(store, d);
  st = await statusOf(backend, t);
  assert.equal(st.owner?.ids.at(-1), renewal.id, 'the renewal anchored');
});

test('a title renewed in two browsers: the fork is settled, both taking the room\'s branch', { skip, timeout: 240_000 }, async () => {
  const id = `names fork ${Math.random()}`;
  const { link } = await room(id);
  const a = await testAgent();
  const ca = { identityKey: 'fork-a', link };
  // Claimed 20 days ago: due. The pass that collects it renews it and publishes; so it's exported after.
  await aged(cal, a.agent, ca, 'echo', nowS() - 20 * DAY);
  const b = await testAgent();
  const cb = { identityKey: 'fork-b', link };
  // B has the title as A had it before its renewal: A's export carries everything, so B's copy drops A's pending renewal
  // (it renews on its own, as a browser that imported the title earlier would).
  const bundle = (await exportNames(a.store, ca.identityKey))!;
  await importNames(b.store, cb.identityKey, bundle);
  const tb = await titleOf(b.store, cb);
  const renewA = (await statusOf(a.backend, tb)).entries.find((e) => e.kind === 'renew')!;
  const dropped = await b.backend.op<{ item: string }>('drop', { item: tb.item, ids: [renewA.id] });
  await b.store.put({ ...tb, item: dropped.item, stamps: {}, collect: {} });
  await b.agent.pass(cb.identityKey); // B renews: a second renewal of the same claim
  cal.mine(7);
  await a.agent.pass(ca.identityKey);
  await b.agent.pass(cb.identityKey);
  // Whichever lost the room's order took the other's branch when its put was answered with the better one; the one
  // that put first learns at its next visit (or hour), when the room shows it the other branch.
  const a2 = await testAgent({ store: a.store });
  const b2 = await testAgent({ store: b.store });
  await a2.agent.pass(ca.identityKey);
  await b2.agent.pass(cb.identityKey);
  const lastA = (await statusOf(a.backend, await titleOf(a.store, ca))).owner?.ids.at(-1);
  const lastB = (await statusOf(b.backend, await titleOf(b.store, cb))).owner?.ids.at(-1);
  assert.ok(lastA && lastA === lastB, `${lastA} ${lastB}`);
  // The copy whose branch lost holds both, the room's owning (the servers finish both renewals once the calendar
  // has, and keep the owning chain: the winner's copy may never be shown the other).
  const renewals = async (x: typeof a, c: NamesConn) => (await statusOf(x.backend, await titleOf(x.store, c))).entries.filter((e) => e.kind === 'renew').length;
  const [na, nb] = [await renewals(a, ca), await renewals(b, cb)];
  assert.ok(Math.max(na, nb) === 2 && Math.min(na, nb) >= 1, `${na} ${nb}`);
});

test('a better chain shown by the servers makes a title lost: renewal stops', { skip, timeout: 240_000 }, async () => {
  const id = `names lost ${Math.random()}`;
  const { link } = await room(id);
  const log: string[] = [];
  const { agent, store, backend } = await testAgent({ log });
  const c = { identityKey: 'conn-lost', link };
  // alpha is a server's, claimed 25 days ago; this one claimed 20 days ago.
  await aged(cal, agent, c, 'alpha', nowS() - 20 * DAY);
  const [v] = await agent.titles(c.identityKey);
  assert.equal(v.state, 'lost', log.join('\n'));
  const n = (await statusOf(backend, await titleOf(store, c))).entries.length;
  const posts = asked.posts;
  await agent.pass(c.identityKey);
  assert.equal(asked.posts, posts, 'no stamp');
  assert.equal((await statusOf(backend, await titleOf(store, c))).entries.length, n);
});
