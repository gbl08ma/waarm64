// The Tailscale backends (web/tailscale.ts) in headless Chromium with no guest
// (docs/plans/tailnet-client.md T5, T6): the Go client (net/tailscale) and the Rust one (net/ts), in
// turn, each in its worker against the test tailnet (tests/net/tailnet.sh): they reach `Running`,
// lease the gateway an address and carry UDP to the peer and back (numbers for both, side by side);
// a kept node comes back after a reload as the same node, also in the other client (the store in
// IndexedDB); logging out forgets it. The guest's side is tests/net-tailnet.test.ts's
// (WEBPC_TS_BACKEND=rust there).
// Opt-in: WEBPC_TAILNET=1 (Podman, or WEBPC_TAILNET_SCRIPT=tests/net/tailnet-native.sh;
// target/net/tailscale.wasm and target/net/ts.wasm).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const script = process.env.WEBPC_TAILNET_SCRIPT ?? `${ROOT}tests/net/tailnet.sh`;
const skip = process.env.WEBPC_TAILNET !== '1' ? 'SKIPPED: set WEBPC_TAILNET=1'
  : !existsSync(`${ROOT}target/net/tailscale.wasm`) ? 'SKIPPED: no target/net/tailscale.wasm (net/tailscale/build.sh)'
  : !existsSync(`${ROOT}target/net/ts.wasm`) ? 'SKIPPED: no target/net/ts.wasm (net/ts/build.sh)'
  : undefined;

let env: Record<string, string>;
let browser: Browser;
let base: string;
let closeServer: () => void;
let echo: ReturnType<typeof createSocket>;
before(async () => {
  if (skip) return;
  env = Object.fromEntries(execFileSync(script, ['up'], { encoding: 'utf8', timeout: 240_000 }).trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2) as [string, string]));
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

type State = { state: string; netmap?: { addresses: string[] }; timings: { loadMs?: number; runningMs?: number }; lease?: { address: number[]; address6?: number[]; mtu: number } };
const state = (page: Page) => page.evaluate('window.harness.tailscale()') as Promise<State>;

/** Opens the page for `backend` and waits for `Running` with a lease. */
async function open(page: Page, backend: string, o: { authkey?: string; persist?: string; hostname: string }) {
  await page.goto(`${base}/tests/browser/tailscale.html?${new URLSearchParams({ tsbackend: backend, control: env.WEBPC_TS_CONTROL, peer: env.WEBPC_TS_PEER_IP, port: String(echo.address().port), authkey: o.authkey ?? '', persist: o.persist ?? '', hostname: o.hostname })}`);
  await page.waitForFunction('window.harness?.tailscale().state === "Running" && window.harness.tailscale().lease', null, { timeout: 60_000, polling: 100 })
    .catch(async (e) => { throw new Error(`${backend}: ${e}; ${JSON.stringify(await state(page))}; events ${JSON.stringify(await page.evaluate('window.harness?.events()'))}`); });
  return state(page);
}

for (const backend of ['go', 'rust']) {
  test(`the ${backend} client in the page: Running, a lease, UDP to the peer and back`, { skip, timeout: 180_000 }, async () => {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true }); // the tailnet's test CA
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log(`# page error: ${e}`));
    page.on('console', (m) => { if (/rror|panic/.test(m.text())) console.log(`# page: ${m.text().slice(0, 300)}`); });
    try {
      const key = execFileSync(script, ['key'], { encoding: 'utf8' }).trim();
      const s = await open(page, backend, { authkey: key, hostname: `${backend}-page` });
      assert.equal(s.lease!.address.join('.'), s.netmap!.addresses.find((a) => !a.includes(':'))!.replace(/\/\d+$/, ''));
      assert.equal(s.lease!.mtu, 1280);
      // The first echoes also wait out the WireGuard handshake.
      const first = await page.evaluate('window.harness.echoes(20, 32, 1)') as { back: number; ms: number };
      assert.ok(first.back >= 15, `small echoes came back (${first.back} of 20)`);
      const small = await page.evaluate('window.harness.echoes(200, 32, 1)') as { back: number; ms: number };
      const big = await page.evaluate('window.harness.echoes(2000, 1200, 32)') as { back: number; ms: number };
      console.log(`# ${backend} in Chromium ${browser.version()}: module loaded in ${s.timings.loadMs?.toFixed(0)} ms, Running after ${s.timings.runningMs?.toFixed(0)} ms; RTT ${(small.ms / small.back).toFixed(2)} ms (200 echoes, one at a time); 2000 echoes of 1228 B: ${big.back} back in ${big.ms.toFixed(0)} ms = ${(big.back * 1228 * 8 / big.ms / 1000).toFixed(1)} Mbit/s each way`);
      assert.ok(big.back >= 1900, `the large echoes came back (${big.back} of 2000)`);
    } finally {
      await ctx.close();
    }
  });
}

test('a kept node comes back after a reload as the same node, in either client, until it logs out', { skip, timeout: 240_000 }, async () => {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`# page error: ${e}`));
  try {
    const persist = env.WEBPC_TS_CONTROL;
    const key = execFileSync(script, ['key', 'lasting'], { encoding: 'utf8' }).trim();
    const one = await open(page, 'rust', { authkey: key, persist, hostname: 'kept' });
    const addr = one.netmap!.addresses.join(' ');
    // No auth key from here: only the kept node can log in.
    for (const backend of ['rust', 'go', 'rust']) {
      const again = await open(page, backend, { persist, hostname: 'kept' });
      assert.equal(again.netmap!.addresses.join(' '), addr, `${backend}: the same node after a reload`);
    }
    const stored = await page.evaluate('window.harness.stored()') as string[];
    assert.ok(stored.includes(`${persist}/_machinekey`), `the store: ${stored}`);
    assert.equal(await page.evaluate('window.harness.logout()'), 'done');
    const left = (await page.evaluate('window.harness.stored()') as string[]).filter((k) => k.startsWith(`${persist}/`));
    assert.deepEqual(left, [], 'logging out forgets the node');
    const named = (JSON.parse(execFileSync(script, ['nodes'], { encoding: 'utf8' })) as { name: string; expiry?: { seconds: number } }[]).find((n) => n.name === 'kept');
    assert.ok(named?.expiry && named.expiry.seconds * 1000 < Date.now(), `the control server expired the node's key: ${JSON.stringify(named)}`);
  } finally {
    await ctx.close();
  }
});
