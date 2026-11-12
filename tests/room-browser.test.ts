// A room's members (web/room.ts, net/ts's room.rs) in headless Chromium with no guest (docs/networking/rooms.md): pages
// join one room by its link, which names the tailcat rig's relay (tests/net/tailcat.sh: only its derper is used) and
// the tests' Nostr relay (tests/net/nostr-relay.ts). One dials another's address (or its name, through the room's
// resolver): its lookup goes out on the Nostr relay, the other calls back through DERP, and UDP echoes go through the
// relay at once, then over the WebRTC data channel the two set up with signalling inside the tunnel; a dropped channel
// falls back to the relay, relay only never opens one, and a member with incoming connections off isn't reached.
// Opt-in, with the rig: WEBPC_TAILCAT=1 (Go for derper, and target/net/ts.wasm, net/ts/build.sh).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { startNostrRelay, type NostrRelay } from './net/nostr-relay.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const has = (cmd: string, arg = '--version') => spawnSync(cmd, [arg], { stdio: 'ignore' }).status === 0;
const skip = process.env.WEBPC_TAILCAT !== '1' ? 'SKIPPED: set WEBPC_TAILCAT=1'
  : !existsSync(`${ROOT}target/net/ts.wasm`) ? 'SKIPPED: no target/net/ts.wasm (net/ts/build.sh)'
  : !has('go', 'version') && !existsSync(`${ROOT}target/net/tailcat-test/bin/derper`) ? 'SKIPPED: no Go to build derper'
  : undefined;
const script = `${ROOT}tests/net/tailcat.sh`;
const RELAY = '127.0.0.1:8444';

let browser: Browser;
let nostr: NostrRelay;
let base: string;
let closeServer: () => void;
before(async () => {
  if (skip) return;
  execFileSync(script, ['up'], { encoding: 'utf8', timeout: 300_000 });
  nostr = await startNostrRelay();
  const server = await startServer();
  closeServer = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
});
after(async () => {
  await browser?.close();
  closeServer?.();
  await nostr?.close();
  if (!skip) spawnSync(script, ['down']);
});

type Member = { state: string; self?: { key: string; address6: number[]; tag?: string; name?: string }; peers: { key: string; path: string }[]; timings: { runningMs?: number } };
type Echoes = { back: number; ms: number; rtts: number[] };

/** A member's page in room `room`, `Running` (in its own context, or `ctx`). */
async function member(room: string, q: Record<string, string> = {}, ctx?: BrowserContext): Promise<Page> {
  ctx ??= await browser.newContext({ ignoreHTTPSErrors: true }); // the relay's self-signed certificate
  const page = await ctx.newPage();
  page.on('console', (m) => { if (/rror|panic|room:/.test(m.text())) console.log(`# page: ${m.text().slice(0, 300)}`); });
  page.on('pageerror', (e) => console.log(`# page error: ${e}`));
  await page.goto(`${base}/tests/browser/room.html?${new URLSearchParams({ room, relay: RELAY, nostr: nostr.url, ...q })}`);
  await page.waitForFunction('window.harness?.room().state === "Running"', null, { timeout: 30_000, polling: 50 })
    .catch(async (e) => { throw new Error(`${e}; events ${JSON.stringify(await page.evaluate('window.harness?.events()'))}`); });
  return page;
}

const of = (p: Page) => p.evaluate('window.harness.room()') as Promise<Member>;
const pathTo = async (p: Page, key: string) => (await of(p)).peers.find((x) => x.key === key)?.path;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? NaN;

/** Two members of a fresh room, the second dialing the first; `dial` takes extra parameters. */
async function pair(dial: Record<string, string> = {}) {
  const room = `test ${Math.random()}`;
  const b = await member(room);
  const bs = await of(b);
  const a = await member(room, { peer: bs.self!.key, ...dial });
  const as = await of(a);
  return { a, b, aKey: as.self!.key, bKey: bs.self!.key, to: bs.self!.address6 };
}

const close = (...ps: Page[]) => Promise.all(ps.map((p) => p.context().close()));

test('two members talk through the relay at once, then over their data channel, and fall back when it drops', { skip, timeout: 120_000 }, async () => {
  const { a, b, aKey, bKey, to } = await pair();
  const as = await of(a);
  assert.equal(as.self!.address6[0], 0xfd);
  assert.deepEqual(as.self!.address6.slice(0, 6), (await of(b)).self!.address6.slice(0, 6), 'one room, one /48');
  const firstMs = await a.evaluate(`window.harness.first(${JSON.stringify(to)})`) as number;
  assert.ok(firstMs >= 0, 'an echo came back');
  await a.waitForFunction(`window.harness.room().peers.some((p) => p.key === ${JSON.stringify(bKey)} && p.path === 'direct')`, null, { timeout: 15_000, polling: 20 });
  await b.waitForFunction(`window.harness.room().peers.some((p) => p.key === ${JSON.stringify(aKey)} && p.path === 'direct')`, null, { timeout: 5_000, polling: 20 });
  const events = await a.evaluate('window.harness.events()') as { ms: number; type: string; path?: string }[];
  const direct = events.find((e) => e.type === 'path' && e.path === 'direct')!.ms;
  const peer = events.find((e) => e.type === 'peer')!.ms;
  console.log(`# first echo ${firstMs.toFixed(0)} ms after Running; the direct path ${(direct - peer).toFixed(0)} ms after the handshake`);
  const small = await a.evaluate(`window.harness.echoes(${JSON.stringify(to)}, 200, 32, 1)`) as Echoes;
  assert.equal(small.back, 200);
  const big = await a.evaluate(`window.harness.echoes(${JSON.stringify(to)}, 4000, 1232, 32)`) as Echoes;
  console.log(`# direct: RTT ${median(small.rtts).toFixed(2)} ms; 4000 echoes of 1280 B: ${big.back} back, ${(big.back * 1280 * 8 / big.ms / 1000).toFixed(1)} Mbit/s each way`);
  assert.ok(big.back >= 3900, `the large echoes came back (${big.back} of 4000)`);
  // The connection fails (as when ICE drops): the relay carries again, at once.
  await a.evaluate('window.harness.dropDirect()');
  await a.waitForFunction(`window.harness.room().peers.some((p) => p.path === 'relay')`, null, { timeout: 5_000, polling: 20 });
  const after = await a.evaluate(`window.harness.echoes(${JSON.stringify(to)}, 50, 32, 4)`) as Echoes;
  assert.equal(after.back, 50, 'through the relay after the channel dropped');
  assert.equal(await pathTo(b, aKey), 'relay', 'the other side fell back too');
  await close(a, b);
});

test('relay only never opens a data channel, and the relay carries everything', { skip, timeout: 120_000 }, async () => {
  const { a, b, aKey, bKey, to } = await pair({ relayOnly: '1' });
  assert.ok(await a.evaluate(`window.harness.first(${JSON.stringify(to)})`) as number >= 0);
  const small = await a.evaluate(`window.harness.echoes(${JSON.stringify(to)}, 200, 32, 1)`) as Echoes;
  const big = await a.evaluate(`window.harness.echoes(${JSON.stringify(to)}, 2000, 1232, 32)`) as Echoes;
  console.log(`# relay only: RTT ${median(small.rtts).toFixed(2)} ms; 2000 echoes of 1280 B: ${big.back} back, ${(big.back * 1280 * 8 / big.ms / 1000).toFixed(1)} Mbit/s each way`);
  assert.equal(small.back, 200);
  assert.ok(big.back >= 1950, `${big.back} of 2000`);
  assert.equal(await pathTo(a, bKey), 'relay');
  assert.equal(await pathTo(b, aKey), 'relay');
  const opened = await a.evaluate('window.harness.events().filter((e) => e.type === "path").length') as number;
  assert.equal(opened, 0, 'no path change: never direct');
  await close(a, b);
});

test('a browser that uses no UDP for WebRTC says so, and the relay carries everything', { skip, timeout: 120_000 }, async () => {
  // As ungoogled-chromium by default: a profile whose WebRTC IP handling policy is `disable_non_proxied_udp` gathers no
  // candidate. (Its own `--force-webrtc-ip-handling-policy` switch isn't upstream's; the preference is.)
  const dir = mkdtempSync(join(tmpdir(), 'room-')); // short: Chromium's singleton socket path has a limit
  mkdirSync(join(dir, 'Default'));
  writeFileSync(join(dir, 'Default', 'Preferences'), JSON.stringify({ webrtc: { ip_handling_policy: 'disable_non_proxied_udp' } })); // i18n-ignore: Chromium's profile file
  const ctx = await chromium.launchPersistentContext(dir, { executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', ignoreHTTPSErrors: true });
  try {
    const room = `test ${Math.random()}`;
    const b = await member(room);
    const bs = (await of(b)).self!;
    const a = await member(room, { peer: bs.key }, ctx);
    const aKey = (await of(a)).self!.key;
    assert.ok(await a.evaluate(`window.harness.first(${JSON.stringify(bs.address6)})`) as number >= 0, 'an echo came back');
    // Whichever side offers, the blocked member's connection gathers nothing and it says so.
    await a.waitForFunction('window.harness.events().some((e) => e.type === "direct" && e.blocked)', null, { timeout: 15_000, polling: 50 });
    const small = await a.evaluate(`window.harness.echoes(${JSON.stringify(bs.address6)}, 100, 32, 1)`) as Echoes;
    assert.equal(small.back, 100, 'through the relay');
    assert.equal(await pathTo(a, bs.key), 'relay');
    assert.equal(await pathTo(b, aKey), 'relay');
    const bEvents = await b.evaluate('window.harness.events().filter((e) => e.type === "direct")') as unknown[];
    assert.deepEqual(bEvents, [], 'the other member gathers candidates: nothing to say');
    await close(b);
  } finally {
    await ctx.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a member reached by its name, and one with incoming connections off not at all', { skip, timeout: 120_000 }, async () => {
  const room = `test ${Math.random()}`;
  const b = await member(room);
  const c = await member(room, { incoming: '0' });
  const a = await member(room);
  const bs = (await of(b)).self!;
  assert.match(bs.name!, new RegExp(`^[a-z2-7]{52}\\.${bs.tag}\\.p2p\\.internal$`));
  const to = await a.evaluate(`window.harness.resolve(${JSON.stringify(bs.name)})`) as number[] | null;
  assert.deepEqual(to, bs.address6, 'the name is the address, computed');
  assert.equal(await a.evaluate(`window.harness.resolve("nobody.${bs.tag}.p2p.internal")`), null, 'NXDOMAIN');
  const before = nostr.events.length;
  assert.ok(await a.evaluate(`window.harness.first(${JSON.stringify(to)})`) as number >= 0, 'reached by name');
  assert.ok(nostr.events.length > before, 'through a lookup on the Nostr relay');
  const lookup = nostr.events[before];
  assert.equal(Buffer.from(lookup.content, 'base64').length, 106, 'a lookup (sealed to the key the name carries: cargo test checks)');
  const cs = (await of(c)).self!;
  const none = await a.evaluate(`window.harness.echoes(${JSON.stringify(cs.address6)}, 1, 32, 1, 8000)`) as Echoes;
  assert.equal(none.back, 0, 'incoming off: unanswered');
  assert.deepEqual((await of(c)).peers, []);
  await close(a, b, c);
});

test('two workers sharing a key on its first start get the same one, and it is the one kept', { skip, timeout: 60_000 }, async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${base}/web/room.ts`); // any document of the origin: the test imports the module itself
  const r = await page.evaluate(async (url) => {
    const m = await import(url) as typeof import('../web/room.ts');
    const key = `shared-${Math.random()}`;
    const [a, b, c, d] = await Promise.all([m.roomIdentity(key), m.roomIdentity(key), m.roomIdentity(key), m.roomIdentity(key)]);
    const kept = await m.roomIdentity(key);
    return [a, b, c, d].map((x) => x.key === kept.key);
  }, '/web/room.ts');
  assert.deepEqual(r, [true, true, true, true]);
  await ctx.close();
});
