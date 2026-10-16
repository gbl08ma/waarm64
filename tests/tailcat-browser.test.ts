// The tailcat backend (web/tailcat.ts, the Rust tailnet client net/ts in its worker) in headless
// Chromium, with no guest (docs/plans/tailnet-client.md T2): the page loads the module from the
// dev server under COEP, opens the relay's WebSocket, reaches `Running`, hands the gateway's
// port a lease, and carries UDP to an echo server on the exit node's machine and back. The
// guest's side is tests/net-tailcat.test.ts's.
// Opt-in: WEBPC_TAILCAT=1 (needs Go for tests/net/tailcat.sh's tailcat and derper, and
// target/net/ts.wasm, net/ts/build.sh).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser } from 'playwright-core';
import { startServer } from '../tools/serve.ts';

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
