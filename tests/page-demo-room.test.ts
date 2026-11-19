// A demo's room (docs/networking/rooms.md "A demo's room"; DEMO loop 15): two visitors' Alpine demo machines (two
// profiles in one Chromium), each made from the demo's template as the store makes it (web/app/template.ts
// `machineFromDemo`: its first adapter on the demo network, its second on a room connection of its own), reach each
// other through the room. The demo network is the fork's server on loopback (tests/waarm64-demonet.ts, as
// tests/page-demonet.test.ts runs it) and the room's relays are the tests' (tests/net/nostr-relay.ts and the tailcat
// rig's derper, tests/net/tailcat.sh) instead of the global room's public ones: the test points the two connections
// there before the first start. After the restore the agent brings up `eth1`, which nothing in Alpine manages (CARDS,
// docs/devices.md "A card nothing else manages"): udhcpc6 takes the room's address, the router advertisement's Route
// Information option the room's /48, and the default routes stay `eth0`'s; then each pings the other's room address.
// The template: `WAARM64_DEMO_SITE` (default target/demos) `/alpine-term`, built by tools/build-demos.ts from
// deploy/disks/demos.json (two adapters); skipped when it isn't this core's or has one adapter. ~20 s. Opt-in with the
// network tests (scripts/ci-net.sh): WAARM64_NET_TESTS=1, WAARM64_TAILCAT=1 (Go for derper).
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, openAsBlob, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { siteServer } from '../bench/demo/site.ts';
import { shapeHashOf } from '../tools/demo-site.ts';
import { startServer } from '../tools/serve.ts';
import { checkDefinition } from '../web/app/definitions.ts';
import { roomLink } from '../web/room.ts';
import { readHeader, SNAPSHOT_VERSION } from '../web/snapshot-file.ts';
import { answerAsks } from './page-ask.ts';
import { startNostrRelay, type NostrRelay } from './net/nostr-relay.ts';
import { RIG_RELAY } from './net/tailcat-cli.ts';
import { buildDemonet, demonetSkip } from './waarm64-demonet.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const SITE = join(ROOT, process.env.WAARM64_DEMO_SITE ?? 'target/demos');
const NAME = 'alpine-term';
const has = (cmd: string, arg = '--version') => spawnSync(cmd, [arg], { stdio: 'ignore' }).status === 0;
const skip = process.env.WAARM64_NET_TESTS !== '1' ? 'SKIPPED: scripts/ci-net.sh runs it (WAARM64_NET_TESTS=1)'
  : process.env.WAARM64_TAILCAT !== '1' ? "SKIPPED: set WAARM64_TAILCAT=1 (the tailcat rig's derper)"
  : !existsSync(join(ROOT, 'target/images/edk2/QEMU_EFI.fd')) ? 'SKIPPED: no images/build.sh edk2'
  : !existsSync(join(ROOT, 'target/net/ts.wasm')) ? 'SKIPPED: no target/net/ts.wasm (net/ts/build.sh)'
  : !has('go', 'version') && !existsSync(join(ROOT, 'target/net/tailcat-test/bin/derper')) ? 'SKIPPED: no Go to build derper'
  : demonetSkip();
const RIG = join(ROOT, 'tests/net/tailcat.sh');

/** Why the template can't be tested here: not built, another core's, or one adapter (no room). */
async function unfit(): Promise<string | false> {
  const at = (f: string) => join(SITE, NAME, f);
  if (!existsSync(at('definition.json')) || !existsSync(at('snapshot.json'))) return `SKIPPED: no demo template at ${SITE}/${NAME}`;
  const def = checkDefinition(JSON.parse(readFileSync(at('definition.json'), 'utf8')));
  if ((def.machine.macs?.length ?? 0) < 2) return `SKIPPED: ${NAME}'s template has one adapter (node tools/build-demos.ts --only ${NAME})`;
  const m = JSON.parse(readFileSync(at('snapshot.json'), 'utf8')) as { pieces: string; hashes: string[] };
  const piece = (h: string) => openAsBlob(join(SITE, NAME, m.pieces.replace('{hash}', h)));
  const h = await readHeader(new Blob(await Promise.all(m.hashes.slice(0, 2).map(piece))));
  if (h.coreVersion !== SNAPSHOT_VERSION || h.shapeHash !== (await shapeHashOf(def)))
    return `SKIPPED: ${NAME}'s template is another core's (node tools/build-demos.ts --only ${NAME})`;
  return false;
}

const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`# [${((Date.now() - t0) / 1000).toFixed(1)} s]`, ...a);

let browser: Browser;
let base: string;
let closeServer: () => void;
let site: { base: string; close: () => Promise<void> };
let nostr: NostrRelay;
let dir: string;
let demonet: ChildProcess | undefined;
let demonetLog = '';
let port: number;

const freePort = () => new Promise<number>((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const p = (s.address() as AddressInfo).port;
    s.close(() => resolve(p));
  });
});

before(async () => {
  if (skip) return;
  execFileSync(RIG, ['up'], { encoding: 'utf8', timeout: 300_000 });
  log('the rig up');
  nostr = await startNostrRelay();
  const server = await startServer();
  closeServer = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  site = await siteServer(SITE, [], () => 'site');
  dir = mkdtempSync(join(tmpdir(), 'waarm64-demo-room-'));
  port = await freePort();
  writeFileSync(join(dir, 'config.toml'), ['[server]', `listen = "127.0.0.1:${port}"`, `origins = ["${base}"]`, '[[allow]]', 'name = "dl-cdn.alpinelinux.org"', 'ports = [443]', 'note = "the test\'s one rule"', ''].join('\n'));
  const bin = buildDemonet();
  log('the demo server built');
  demonet = spawn(bin, ['--config', join(dir, 'config.toml')], { stdio: ['ignore', 'pipe', 'pipe'] });
  demonet.stdout!.on('data', (d) => { demonetLog += d; });
  demonet.stderr!.on('data', (d) => { demonetLog += d; });
  for (let k = 0; k < 100 && !demonetLog.includes('listening on'); k++) await new Promise((r) => setTimeout(r, 100));
  assert.match(demonetLog, /listening on/, `the demo server didn't start: ${demonetLog}`);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
  log('ready');
});
after(async () => {
  await browser?.close();
  closeServer?.();
  await site?.close();
  await nostr?.close();
  demonet?.kill('SIGTERM');
  if (dir) rmSync(dir, { recursive: true, force: true });
  if (!skip) spawnSync(RIG, ['down']);
});

/** The store: the site's definition with a card made here (the build's definition has none): the demo network and the room. */
function store() {
  const def = JSON.parse(readFileSync(join(SITE, NAME, 'definition.json'), 'utf8')) as { disks: { url?: string }[] } & Record<string, unknown>;
  const snap = JSON.parse(readFileSync(join(SITE, NAME, 'snapshot.json'), 'utf8')) as { id: string; size: number };
  const at = (u?: string) => (u && !/^[a-z]+:/.test(u) ? `${NAME}/${u}` : u);
  const demo = { id: NAME, summary: 'A demo.', download: snap.size, view: 'serial', snapshot: { manifest: `${NAME}/snapshot.json`, id: snap.id }, network: 'demo', room: 'global' };
  return { type: 'waarm64-store', version: 1, demos: [{ ...def, version: 2, disks: def.disks.map((d) => ({ ...d, url: at(d.url) })), demo }] };
}

const terminal = (page: Page) => page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '');
let runs = 0;
/** Runs `cmd` on the serial shell: its output on one line, between markers of its own. */
async function run(page: Page, cmd: string, ms = 60_000) {
  const re = new RegExp(`<<${++runs}:([^<>]*)>>`);
  await page.locator('.xterm').click();
  await page.keyboard.type(`clear; echo "<<${runs}:$({ ${cmd}; } 2>&1 | tr '\\n<>' ' []')>"">"\n`, { delay: 5 });
  await page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.xterm-rows')?.textContent ?? ''), re.source, { timeout: ms, polling: 200 })
    .catch(async (e: unknown) => { throw new Error(`${String(e)}; the terminal shows: ${await terminal(page)}`); });
  return re.exec(await terminal(page))![1].trim();
}

/**
 * A visitor's demo machine in a fresh profile: made from the store's demo, its connections pointed at the tests'
 * servers (`ws`: the demo server; `link`: the room's), started (the template restored). Returns its page.
 */
async function visitor(storeUrl: string, ws: string, link: string, errors: string[]) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, ignoreHTTPSErrors: true }); // the rig's derper has a self-signed certificate
  await ctx.route(storeUrl, (r) => r.fulfill({ headers: { 'Access-Control-Allow-Origin': '*' }, json: store() }).catch((e: unknown) => log('the store route:', e)));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => /room|error/i.test(m.text()) && log('[page]', m.text().slice(0, 300)));
  await answerAsks(page);
  await page.goto(`${base}/web/app/`);
  log('the page open');
  const id = await page.evaluate(async ([storeUrl, ws, link]) => {
    const { Store } = await import('/web/app/store.ts' as string);
    const { fetchStore, findDemo } = await import('/web/app/demo-store.ts' as string);
    const { machineFromDemo } = await import('/web/app/template.ts' as string);
    const store = await Store.open();
    const { machine } = await machineFromDemo(store, findDemo(await fetchStore(storeUrl), 'alpine-term'));
    for (const c of await store.all('connections')) {
      if (c.kind === 'demo') await store.put('connections', { ...c, demo: { url: ws } });
      if (c.kind === 'room') await store.put('connections', { ...c, room: { ...c.room, link } });
    }
    return machine.id as string;
  }, [storeUrl, ws, link]);
  log('machine made', id);
  await page.goto(`${base}/web/app/?m=${id}&clocksync=0&view=both`);
  await page.waitForFunction(() => document.body.dataset.state === 'running', null, { timeout: 120_000, polling: 200 })
    .catch(async (e: unknown) => { throw new Error(`${String(e)}; state ${await page.evaluate(() => document.body.dataset.state)}; the message bar: ${await page.evaluate(() => document.getElementById('message')?.textContent)}`); });
  log('running');
  return page;
}

/** The guest's room address: `eth1`'s global IPv6 address, once udhcpc6 has it (the agent brought it up). */
async function roomAddress(page: Page): Promise<string> {
  const out = await run(page, 'for i in $(seq 60); do ip -6 -o addr show dev eth1 scope global | grep -q inet6 && break; sleep 1; done; ip -6 -o addr show dev eth1 scope global; echo; ip -o link show eth1', 90_000);
  const m = /inet6 ([0-9a-f:]+)\/128/.exec(out);
  if (!m) {
    const log = await run(page, 'tail -n 15 /var/log/waarm64-agent.log; ps -o args | grep -E "udhcpc" | grep -v grep');
    assert.fail(`eth1 has no room address: ${out}; the agent: ${log}`);
  }
  log('room address', m[1]);
  return m[1];
}

test("a demo's room: two visitors' Alpine demo machines, each its own key; the agent brings eth1 up (udhcpc6, the room's /48), eth0 keeps the defaults; each pings the other's room address", { skip, timeout: 12 * 60_000 }, async (t) => {
  const why = await unfit();
  if (why) return void t.skip(why);
  const errors: string[] = [];
  const storeUrl = `${site.base}/store.json`;
  const room = `demo-room-test-${randomBytes(4).toString('hex')}`;
  const made = roomLink({ id: room, nostr: [nostr.url], derp: [RIG_RELAY] });
  assert.ok('link' in made);
  const link = made.link;
  const ws = `ws://127.0.0.1:${port}/`;
  const a = await visitor(storeUrl, ws, link, errors);
  const b = await visitor(storeUrl, ws, link, errors);
  const [addrA, addrB] = [await roomAddress(a), await roomAddress(b)];
  assert.notEqual(addrA, addrB, 'an address each: a key each');
  // The room's /48 by the advertisement's Route Information option on eth1; the default routes eth0's (the primary).
  const routes = await run(a, 'ip -6 route show dev eth1; echo DEF; ip -6 route show default; ip -4 route show default');
  assert.match(routes, new RegExp(`${addrA.split(':').slice(0, 3).join(':')}::/48 via fe80:`), `the room's /48 on eth1: ${routes}`);
  assert.doesNotMatch(routes.split('DEF')[1], /eth1/, `no default route on eth1: ${routes}`);
  assert.match(await run(a, 'cat /proc/sys/net/ipv6/conf/eth1/accept_ra_rt_info_max_plen'), /^128$/);
  // Each reaches the other (the first pings can go while the peers find each other).
  for (const [from, to] of [[a, addrB], [b, addrA]] as const) {
    const out = await run(from, `for i in 1 2 3 4 5 6; do ping -c 2 -W 5 ${to} > /tmp/ping.out 2>&1 && break; sleep 2; done; tail -n 3 /tmp/ping.out`, 180_000);
    assert.match(out, /[12] packets received/, `ping ${to}: ${out}`);
  }
  assert.deepEqual(errors, []);
});
