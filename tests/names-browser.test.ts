// The names agent in Chromium (web/names.ts, docs/plans/room-names.md "The names agent"): its worker
// (web/names-worker.ts) on the tests' module (target/net/ts-test.wasm, served in ts.wasm's place), its titles and the
// owners' secret in IndexedDB `waarm64-room` (stores `owner` and `titles`), its Web Locks, and the compiled calendars and
// explorers routed to the pretend ones (tests/net/ots-calendar.ts; a pending proof's 404 has no CORS header, so the page
// sees a failed fetch): a claim held back until anchored, kept over a reload, and a connection's export taken in
// another browser. Nothing else is fetched. The room's servers are tests/names-room.test.ts's.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { CALENDARS, EXPLORERS } from '../web/names.ts';
import { CALENDARS as PRETEND, startOtsCalendar, type OtsCalendar } from './net/ots-calendar.ts';
import { TEST_WASM } from './net/names-agent.ts';

const skip = !existsSync(TEST_WASM) ? 'net/ts/build.sh --test-params' : !existsSync(process.env.CHROMIUM ?? '/usr/bin/chromium') ? 'no Chromium' : false;
const LINK = 'waarm64-room:names%20browser?nostr=ws%3A%2F%2F127.0.0.1%3A9&derp=127.0.0.1%3A9';

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

/** A browser profile with the services routed, every URL outside the page's origin recorded. */
async function profile(): Promise<{ ctx: BrowserContext; outside: string[] }> {
  const ctx = await browser.newContext();
  const outside: string[] = [];
  const map: [string, string][] = [...CALENDARS.map((c, i): [string, string] => [c, cal.calendars[PRETEND[i]]]), ...EXPLORERS.map((e): [string, string] => [e, cal.explorer])];
  await ctx.route('**/target/net/ts.wasm', (r) => r.fulfill({ path: TEST_WASM, contentType: 'application/wasm' }));
  await ctx.route((u) => u.origin !== base, async (r) => {
    const url = r.request().url();
    outside.push(url);
    const to = map.find(([from]) => url.startsWith(`${from}/`));
    if (!to) return r.abort();
    const res = await r.fetch({ url: to[1] + url.slice(to[0].length) });
    await r.fulfill({ response: res });
  });
  return { ctx, outside };
}

test('in the page: a claim held back until anchored, the title kept over a reload, and taken by another browser with its connection\'s export', { skip, timeout: 120_000 }, async () => {
  const { ctx, outside } = await profile();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`# page error: ${e}`));
  const url = `${base}/tests/browser/names.html?${new URLSearchParams({ conn: 'conn-a', link: LINK })}`;
  await page.goto(url);
  await page.waitForFunction('window.harness');
  const r = await page.evaluate('window.harness.register("browser1")') as { view: { state: string }; ms: number };
  console.log(`# a claim made in the page (the tests' proof of work), stamped: ${r.ms.toFixed(0)} ms`);
  assert.equal(r.view.state, 'reserved');
  const t0 = Date.now();
  await page.evaluate('window.harness.pass()');
  assert.equal((await page.evaluate('window.harness.titles()') as { state: string }[])[0].state, 'reserved', 'pending: a failed fetch, asked again later');
  cal.mine(7);
  await page.evaluate('window.harness.pass()');
  const [v] = await page.evaluate('window.harness.titles()') as { state: string; keptUntil: number; claimedAt: number }[];
  assert.equal(v.state, 'active');
  console.log(`# anchored and collected in the page: ${Date.now() - t0} ms`);
  // Kept: a reload reads it back from IndexedDB.
  await page.reload();
  await page.waitForFunction('window.harness');
  const [kept] = await page.evaluate('window.harness.stored()') as { name: string; item: string }[];
  assert.equal(kept.name, 'browser1');
  assert.match(await page.evaluate('window.harness.secret()') as string, /^[0-9a-f]{64}$/);
  // Another browser takes the connection's export: the same title, its state the same.
  const bundle = await page.evaluate('window.harness.exportNames()') as string;
  const other = await profile();
  const p2 = await other.ctx.newPage();
  await p2.goto(`${base}/tests/browser/names.html?${new URLSearchParams({ conn: 'conn-b', link: LINK })}`);
  await p2.waitForFunction('window.harness');
  await p2.evaluate(`window.harness.importNames(${JSON.stringify(bundle)})`);
  const [w] = await p2.evaluate('window.harness.titles()') as { state: string; claimedAt: number }[];
  assert.equal(w.state, 'active');
  assert.equal(w.claimedAt, v.claimedAt);
  const [copy] = await p2.evaluate('window.harness.stored()') as { item: string }[];
  assert.equal(copy.item, kept.item);
  // Nothing but the compiled services (the publisher's relays are the room's link's, refused here: nobody to put to).
  for (const u of [...outside, ...other.outside]) {
    assert.ok([...CALENDARS, ...EXPLORERS].some((s) => u.startsWith(`${s}/`)) || u.startsWith('ws://127.0.0.1:9') || u.startsWith('wss://127.0.0.1:9'), u);
  }
  await ctx.close();
  await other.ctx.close();
});
