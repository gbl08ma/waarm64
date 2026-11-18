// Room names' TypeScript side (docs/plans/room-names.md; the member's and the resolver's logic is net/ts's, tested
// natively: `cargo test -p waarm64_ts`): the tests' pretend calendars and explorer (tests/net/ots-calendar.ts) answer as
// the real ones do over a chain that meets the tests' floor and not production's; the shipped module runs on
// production's parameters and only the page tests' build (net/ts/build.sh --test-params, ts-test.wasm) on the tests';
// a room's registry records kept in IndexedDB `waarm64-room` (web/room.ts `roomNamesStore`), the old database
// upgraded with its identities, and streamed into the module by a stored connection's worker (Chromium, headless).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { TsClient, TsModule, type TsEvent } from '../web/ts-client.ts';
import { applyOps, EASY_BITS, readTimestamp, sha256d, startOtsCalendar, target, type OtsCalendar } from './net/ots-calendar.ts';
import { base32, nameOf, roomPrefix } from './net/room-keys.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const WASM = `${ROOT}target/net/ts.wasm`;
const TEST_WASM = `${ROOT}target/net/ts-test.wasm`;
/** Production's floor (room/names.rs `Params::PRODUCTION`): 1/16 of block 976,177's difficulty. */
const PRODUCTION_FLOOR = 0x17216730;

let cal: OtsCalendar;
before(async () => { cal = await startOtsCalendar({ depth: 6 }); });
after(async () => { await cal?.close(); });

const get = (url: string, init?: RequestInit) => fetch(url, init);

test('the pretend calendars stamp, answer pending without CORS, then serve the finished proof to a block of the pretend chain', async () => {
  const digest = createHash('sha256').update('an entry id').digest();
  const r = await get(`${cal.calendars.alice}/digest`, { method: 'POST', body: digest });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  const receipt = Buffer.from(await r.arrayBuffer());
  const t = readTimestamp(receipt);
  assert.deepEqual(t.attestation, { kind: 'pending', uri: cal.calendars.alice });
  const commitment = applyOps(t.ops, digest);
  assert.equal(commitment.length, 32);
  // A second stamp at another calendar, to share the block.
  const r2 = await get(`${cal.calendars.finney}/digest`, { method: 'POST', body: createHash('sha256').update('another').digest() });
  const c2 = applyOps(readTimestamp(Buffer.from(await r2.arrayBuffer())).ops, createHash('sha256').update('another').digest());
  // Pending: 404 without the CORS header (a page sees a failed fetch), until its block is 6 deep.
  const proofURL = `${cal.calendars.alice}/timestamp/${commitment.toString('hex')}`;
  const p0 = await get(proofURL);
  assert.equal(p0.status, 404);
  assert.equal(p0.headers.get('access-control-allow-origin'), null);
  assert.equal(cal.waiting(), 2);
  const [b] = cal.mine();
  assert.equal(cal.waiting(), 0);
  cal.mine(4);
  assert.equal((await get(proofURL)).status, 404, 'five deep: still pending');
  cal.mine();
  const p1 = await get(proofURL);
  assert.equal(p1.status, 200);
  assert.equal(p1.headers.get('access-control-allow-origin'), '*');
  const proof = readTimestamp(Buffer.from(await p1.arrayBuffer()));
  assert.deepEqual(proof.attestation, { kind: 'bitcoin', height: b.height });
  // The joined path reaches the block's Merkle root, as the module's verifier checks (anchor.rs).
  assert.ok(applyOps([...t.ops, ...proof.ops], digest).equals(b.header.subarray(36, 68)));
  const other = readTimestamp(Buffer.from(await (await get(`${cal.calendars.finney}/timestamp/${c2.toString('hex')}`)).arrayBuffer()));
  assert.ok(applyOps(other.ops, c2).equals(b.header.subarray(36, 68)), 'two commitments, one tree');
  // The header proves itself against the tests' floor, and not against production's.
  const work = Buffer.from(sha256d(b.header)).reverse();
  assert.ok(work.compare(target(EASY_BITS)) <= 0);
  assert.ok(work.compare(target(PRODUCTION_FLOOR)) > 0, 'a pretend header is far under production\'s floor');
  assert.ok(Math.abs(b.header.readUInt32LE(68) - Date.now() / 1000) < 60, 'the wall clock\'s time');
  // A calendar that's down.
  cal.down.add('bob');
  assert.equal((await get(`${cal.calendars.bob}/digest`, { method: 'POST', body: digest })).status, 503);
  cal.down.clear();
});

test('the pretend explorer: block hashes by height and their headers, in the explorers\' byte order', async () => {
  // What the agent asks for an anchor (web/names.ts `header`): the hash of the block at the proof's height, then its
  // header, which an anchor carries alone.
  const digest = createHash('sha256').update('one header').digest();
  await get(`${cal.calendars.alice}/digest`, { method: 'POST', body: digest });
  const [b] = cal.mine();
  const e = cal.explorer;
  const hash = await (await get(`${e}/block-height/${b.height}`)).text();
  assert.equal(hash, Buffer.from(b.hash).reverse().toString('hex'));
  const r = await get(`${e}/block/${hash}/header`);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  const header = Buffer.from(await r.text(), 'hex');
  assert.equal(header.length, 80);
  assert.equal(Buffer.from(sha256d(header)).reverse().toString('hex'), hash);
  assert.ok(header.subarray(4, 36).equals(cal.blocks[b.height - 1].hash), 'a chain: each header names the one before');
  assert.ok(Buffer.from(sha256d(header)).reverse().compare(target(EASY_BITS)) <= 0, 'meets the tests\' floor');
  assert.equal((await get(`${e}/block/${'00'.repeat(32)}/header`)).status, 404);
  assert.equal((await get(`${e}/block-height/${b.height + 1}`)).status, 404);
  // Nothing else of Esplora's: the agent asks for no tip and walks no chain.
  assert.equal((await get(`${e}/blocks/tip/height`)).status, 404);
  assert.equal((await get(`${e}/block/${hash}/status`)).status, 404);
});

/** A room client's `self` event in Node, from the module at `wasm` (its sockets stubbed: nothing connects). */
async function selfOf(wasm: string, id = 'params'): Promise<Extract<TsEvent, { type: 'self' }>> {
  const real = globalThis.WebSocket;
  (globalThis as { WebSocket: unknown }).WebSocket = class { binaryType = ''; readyState = 0; send() {} close() {} };
  try {
    const m = await TsModule.load(readFileSync(wasm));
    let self: TsEvent | undefined;
    const c = new TsClient(m, { room: { link: `waarm64-room:${encodeURIComponent(id)}?nostr=ws%3A%2F%2F127.0.0.1%3A9&derp=127.0.0.1%3A9` } }, {
      packet() {},
      event(e) { if (e.type === 'self') self = e; },
    });
    c.close();
    assert.ok(self?.type === 'self');
    return self;
  } finally {
    (globalThis as { WebSocket: unknown }).WebSocket = real;
  }
}

test('the shipped module runs on production\'s parameters; only the page tests\' build on the tests\'', { skip: existsSync(WASM) ? false : 'net/ts/build.sh' }, async () => { // i18n-ignore
  assert.equal((await selfOf(WASM)).params, 'production');
  if (!existsSync(TEST_WASM)) return console.log('# no target/net/ts-test.wasm (net/ts/build.sh --test-params): only the shipped module checked');
  assert.equal((await selfOf(TEST_WASM)).params, 'test');
});

test('a member\'s name the page shows: under the room\'s name when its ID is a label that doesn\'t look derived, else under its tag', { skip: existsSync(WASM) ? false : 'net/ts/build.sh' }, async () => { // i18n-ignore
  const tagShaped = base32(roomPrefix('test room').subarray(1));
  for (const [id, domain] of [
    ['Gabriel-LAN', 'gabriel-lan.p2p.internal'],
    ['global', 'global.p2p.internal'],
    ['test room', undefined],
    [tagShaped, undefined],
    [`lan-${'a'.repeat(26)}`, undefined],
  ] as const) {
    const s = await selfOf(WASM, id);
    const tag = `${base32(roomPrefix(id).subarray(1))}.p2p.internal`;
    assert.equal(s.tag, base32(roomPrefix(id).subarray(1)), id);
    assert.equal(s.name, nameOf(id, Buffer.from(s.key.replace('nodekey:', ''), 'hex')), id);
    assert.equal(s.name?.split('.').slice(1).join('.'), domain ?? tag, id);
  }
});

let browser: Browser | undefined;
let base = '';
let closeServer = () => {};
const chromiumSkip = !existsSync(WASM) ? 'net/ts/build.sh' : !existsSync(process.env.CHROMIUM ?? '/usr/bin/chromium') ? 'no Chromium' : false; // i18n-ignore

test('a room\'s registry records in IndexedDB: kept by room and connection in batches, the old database upgraded, streamed into the module at the start, written before the worker goes', { skip: chromiumSkip, timeout: 60_000 }, async () => {
  const server = await startServer();
  closeServer = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
  try {
    const page = await (await browser.newContext()).newPage();
    page.on('pageerror', (e) => console.log(`# page error: ${e}`));
    await page.goto(`${base}/tests/browser/room-names.html`);
    await page.waitForFunction('window.harness');
    await page.evaluate('window.harness.old()');
    type Rec = [string, number[]];
    const r = await page.evaluate('window.harness.store()') as { identity: { key: string }; before: number; first: Rec[]; second: Rec[]; other: Rec[]; otherConn: Rec[]; key: string; keyB: string; keyConn: string };
    assert.deepEqual(r.identity, { key: 'ab'.repeat(32) }, 'the identity kept before the names store is there');
    assert.equal(r.before, 0, 'written in a batch, not at once');
    const id = (k: number) => k.toString(16).padStart(2, '0').repeat(32);
    assert.deepEqual(r.first, [[id(1), [2, 1]], [id(2), [2, 22]], [id(3), [2, 3]]]);
    assert.deepEqual(r.second, [[id(1), [2, 1]], [id(2), [2, 22]]], 'deleted');
    assert.deepEqual(r.other, [[id(1), [2, 9]]], 'another room\'s apart');
    assert.deepEqual(r.otherConn, [[id(1), [2, 42]]], 'another connection\'s in the same room apart');
    assert.match(r.key, /^[0-9a-f]{32}$/);
    assert.notEqual(r.key, r.keyB);
    assert.notEqual(r.key, r.keyConn);
    const w = await page.evaluate(`window.harness.worker(${JSON.stringify(`${base}/target/net/ts.wasm`)})`) as { stored: number; left: number; self: { params: string } };
    assert.equal(w.stored, 1);
    assert.equal(w.self.params, 'production');
    assert.equal(w.left, 0, 'a record the module refused is deleted');
    const c = await page.evaluate(`window.harness.closed(${JSON.stringify(`${base}/target/net/ts.wasm`)})`) as { left: number };
    assert.equal(c.left, 0, 'the delete waiting for its batch is written before the worker goes');
  } finally {
    await browser.close();
    closeServer();
  }
});
