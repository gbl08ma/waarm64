// The tailcat backend (web/tailcat.ts, the Rust tailnet client net/ts in its worker) in headless
// Chromium, with no guest (docs/tailnet.md "tailcat"): the page loads the module from the
// dev server under COEP, opens the relay's WebSocket, reaches `Running`, hands the gateway's
// port a lease, and carries UDP to an echo server on the exit node's machine and back. The
// guest's side is tests/net-tailcat.test.ts's. A kept identity is the same node through a server, so an exit node
// can let only it in (`--allow`); a served machine answers `tailcat ping` (disco), over tailcat's public relays too
// (opt-in, WEBPC_TAILCAT_INTERNET=1: this machine reaches them, and tailcat.dev's map).
// Opt-in: WEBPC_TAILCAT=1 (needs Go for tests/net/tailcat.sh's tailcat and derper, and
// target/net/ts.wasm, net/ts/build.sh).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { exitNode, RIG_RELAY, tailcatRun } from './net/tailcat-cli.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const has = (cmd: string, arg = '--version') => spawnSync(cmd, [arg], { stdio: 'ignore' }).status === 0;
const skip = process.env.WEBPC_TAILCAT !== '1' ? 'SKIPPED: set WEBPC_TAILCAT=1'
  : !existsSync(`${ROOT}target/net/ts.wasm`) ? 'SKIPPED: no target/net/ts.wasm (net/ts/build.sh)'
  : !has('go', 'version') && !existsSync(`${ROOT}target/net/tailcat-test/bin/tailcat`) ? 'SKIPPED: no Go to build tailcat and derper'
  : undefined;
const script = `${ROOT}tests/net/tailcat.sh`;

let addr: string;
let browser: Browser;
let base: string;
let closeServer: () => void;
let echo: ReturnType<typeof createSocket>;
before(async () => {
  if (skip) return;
  const env = Object.fromEntries(execFileSync(script, ['up'], { encoding: 'utf8', timeout: 300_000 }).trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)));
  addr = env.WEBPC_TAILCAT_ADDR;
  echo = createSocket('udp4');
  echo.on('message', (m, r) => echo.send(m, r.port, r.address));
  await new Promise<void>((resolve) => echo.bind(0, '127.0.0.1', resolve));
  const server = await startServer();
  closeServer = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
});
after(async () => {
  await browser?.close();
  closeServer?.();
  echo?.close();
  if (!skip) spawnSync(script, ['down']);
});

test('the page\'s tailcat client comes up, leases the guest an address and carries UDP both ways', { skip, timeout: 120_000 }, async () => {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true }); // the relay's self-signed certificate
  const page = await ctx.newPage();
  page.on('console', (m) => console.log(`# page: ${m.text().slice(0, 300)}`));
  page.on('pageerror', (e) => console.log(`# page error: ${e}`));
  await page.goto(`${base}/tests/browser/tailcat.html?${new URLSearchParams({ addr, port: String(echo.address().port) })}`);
  const state = () => page.evaluate('window.harness.tailcat()') as Promise<{ state: string; netmap?: { addresses: string[] }; timings: { loadMs?: number; runningMs?: number }; lease?: { address: number[]; address6?: number[]; mtu: number } }>;
  await page.waitForFunction('window.harness?.tailcat().state === "Running" && window.harness.tailcat().lease', null, { timeout: 30_000, polling: 100 })
    .catch(async (e) => { throw new Error(`${e}; ${JSON.stringify(await state())}; events ${JSON.stringify(await page.evaluate('window.harness?.events()'))}`); });
  const s = await state();
  console.log(`# tailcat in Chromium: module loaded in ${s.timings.loadMs?.toFixed(0)} ms, Running after ${s.timings.runningMs?.toFixed(0)} ms; ${s.netmap?.addresses.join(', ')}`);
  assert.deepEqual(s.lease!.address, [192, 0, 0, 2]);
  assert.deepEqual(s.lease!.address6!.slice(0, 6), [0xfd, 0x7a, 0x11, 0x5c, 0xa1, 0xe0]);
  assert.equal(s.lease!.mtu, 1280);
  const small = await page.evaluate('window.harness.echoes(20, 32)') as { back: number; ms: number };
  assert.equal(small.back, 20, 'every small echo came back');
  const big = await page.evaluate('window.harness.echoes(2000, 1232, 32)') as { back: number; ms: number };
  console.log(`# 2000 echoes of 1260 B: ${big.back} back in ${big.ms.toFixed(0)} ms = ${(big.back * 1260 * 8 / big.ms / 1000).toFixed(1)} Mbit/s each way`);
  assert.ok(big.back >= 1990, `the large echoes came back (${big.back} of 2000)`);
  await ctx.close();
});

type Harness = { state: string; netmap?: { tailcatKey?: string; serving?: string } };
const hex = () => Array.from({ length: 32 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join('');

/** Opens the harness with `q`; waits for `Running` (or an error, given `fails`), then hands the page to `f`. */
async function harnessOn<T>(q: Record<string, string>, f: (h: () => Promise<Harness>) => Promise<T>, fails = false): Promise<T> {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (/rror|panic|allow/.test(m.text())) console.log(`# page: ${m.text().slice(0, 300)}`); });
  try {
    await page.goto(`${base}/tests/browser/tailcat.html?${new URLSearchParams({ port: String(echo.address().port), ...q })}`);
    const h = () => page.evaluate('window.harness.tailcat()') as Promise<Harness>;
    const done = fails
      ? 'window.harness?.events().some((e) => e.type === "error")'
      : 'window.harness?.tailcat().state === "Running" && window.harness.tailcat().netmap';
    await page.waitForFunction(done, null, { timeout: 45_000, polling: 100 })
      .catch(async (e) => { throw new Error(`${e}; ${JSON.stringify(await h())}; events ${JSON.stringify(await page.evaluate('window.harness?.events()'))}`); });
    return await f(h);
  } finally {
    await ctx.close();
  }
}

test('a kept identity is the same node through a server: an exit node with --allow lets it in, and no other', { skip, timeout: 180_000 }, async () => {
  const mine = { key: hex(), psk: hex() };
  const key = await harnessOn({ addr, identity: JSON.stringify(mine) }, async (h) => (await h()).netmap?.tailcatKey);
  assert.match(key ?? '', /^nodekey:[0-9a-f]{64}$/, 'the menu has the key to allow');
  assert.equal(await harnessOn({ addr, identity: JSON.stringify(mine) }, async (h) => (await h()).netmap?.tailcatKey), key, 'the same key at the next connect');
  const strict = await exitNode([`--allow=${key}`]);
  try {
    await harnessOn({ addr: strict.addr, identity: JSON.stringify(mine) }, async () => {
      console.log('# an exit node with --allow=<the kept key> let the page in');
    });
    // Another node (a fresh key, as without a kept connection) isn't answered: the client gives up.
    await harnessOn({ addr: strict.addr }, async () => {}, true);
  } finally {
    strict.stop();
  }
});

test("a served machine answers tailcat ping (disco over the relay), on its own relay or tailcat's public ones", { skip, timeout: 180_000 }, async () => {
  const relays = [{ relay: RIG_RELAY, internet: false }, ...(process.env.WEBPC_TAILCAT_INTERNET === '1' ? [{ relay: '', internet: true }] : [])];
  if (relays.length === 1) console.log("# SKIPPED: tailcat ping through tailcat's public relays (opt-in: WEBPC_TAILCAT_INTERNET=1)");
  for (const { relay, internet } of relays) {
    await harnessOn({ serve: '', relay }, async (h) => {
      const served = (await h()).netmap?.serving ?? '';
      assert.ok(served.startsWith('tc'), `serving at an address: ${JSON.stringify(await h())}`);
      const r = await tailcatRun(['--key=new', 'ping', served], '', { internet });
      assert.match(r.out, /^pong in \S+ via DERP\(/m, `a pong over ${relay || "tailcat's public relays"}: exit ${r.code}; ${r.err.slice(-600)}`);
      console.log(`# tailcat ping over ${relay || "tailcat's public relays"}: ${r.out.trim()}`);
    });
  }
});
