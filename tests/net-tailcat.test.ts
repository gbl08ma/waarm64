// The guest through a tailcat server, end to end in headless Chromium (docs/plans/tailnet-client.md
// T2): the page's Debian with virtio-net on the Ethernet gateway behind the Rust tailnet client
// (net/ts, web/tailcat.ts), against `tests/net/tailcat.sh`'s exit node (tailcat and derper,
// native, on this machine). The guest takes both leases from systemd-networkd (IPv4 192.0.0.2,
// translated to the tunnel's IPv6 by the client; IPv6 the tunnel's own address), and reaches an
// HTTP server on this machine's LAN address through the exit node: a page, then 2 MB (the MSS
// clamp and the 1,260-byte IPv4 path), then over IPv6 when this machine has a non-link-local IPv6
// address. A tailcat exit node does forward private addresses, so no internet is needed; the
// internet and DNS (the lease's 1.1.1.1 through the exit node) are opt-in, WEBPC_TAILCAT_INTERNET=1.
// Realtime: one boot, ~2 min alone. Opt-in: WEBPC_TAILCAT=1 (needs Go for tailcat.sh, the
// Debian image and target/net/ts.wasm).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { networkInterfaces } from 'node:os';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { withDebianLock } from './debian-lock.ts';
import { loginRoot, run as runIn } from './serial-console.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const has = (cmd: string, arg = '--version') => spawnSync(cmd, [arg], { stdio: 'ignore' }).status === 0;
const skip = process.env.WEBPC_TAILCAT !== '1' ? 'SKIPPED: set WEBPC_TAILCAT=1'
  : !existsSync(`${ROOT}target/images/debian/disk.qcow2`) || !existsSync(`${ROOT}target/images/edk2/QEMU_EFI.fd`) ? 'SKIPPED: run npm start (or images/build.sh debian edk2)'
  : !existsSync(`${ROOT}target/net/ts.wasm`) ? 'SKIPPED: no target/net/ts.wasm (net/ts/build.sh)'
  : !has('go', 'version') && !existsSync(`${ROOT}target/net/tailcat-test/bin/tailcat`) ? 'SKIPPED: no Go to build tailcat and derper'
  : undefined;
const script = `${ROOT}tests/net/tailcat.sh`;
const OVERLAY = 'webpc-tailcat-test';
const BIG = 2 << 20;

/** This machine's addresses the exit node can dial: not loopback, not link-local. */
const lan = (family: 'IPv4' | 'IPv6') => Object.values(networkInterfaces()).flat()
  .find((a) => a && a.family === family && !a.internal && !a.address.startsWith('fe80') && !a.address.startsWith('169.254'))?.address;

let addr: string;
let browser: Browser;
let base: string;
let closeServer: () => void;
let http: Server;
let port: number;
before(async () => {
  if (skip) return;
  const env = Object.fromEntries(execFileSync(script, ['up'], { encoding: 'utf8', timeout: 300_000 }).trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)));
  addr = env.WEBPC_TAILCAT_ADDR;
  const big = Buffer.alloc(BIG, 'x');
  http = createServer((req, res) => res.end(req.url === '/big' ? big : 'hello-from-the-exit-nodes-lan\n'));
  await new Promise<void>((resolve) => http.listen(0, '::', resolve)); // both families
  port = (http.address() as { port: number }).port;
  const server = await startServer();
  closeServer = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
});
after(async () => {
  await browser?.close();
  closeServer?.();
  http?.close();
  if (!skip) spawnSync(script, ['down']);
});

const harness = <T>(page: Page, f: string) => page.evaluate(`window.harness.${f}`) as Promise<T>;


test('the guest gets both leases from the tailcat client and reaches the exit node\'s network over IPv4 and IPv6', { skip, timeout: 900_000 }, async () => {
  const v4 = lan('IPv4');
  assert.ok(v4, 'this machine has a LAN IPv4 address for the exit node to dial');
  await withDebianLock(async () => {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true }); // the relay's self-signed certificate
    const page = await ctx.newPage();
    page.on('console', (m) => { if (/rror|panic|tailcat/.test(m.text())) console.log(`# page: ${m.text().slice(0, 300)}`); });
    try {
      await page.goto(`${base}/tests/browser/core.html`);
      await page.evaluate(async (n) => (await navigator.storage.getDirectory()).removeEntry(n, { recursive: true }).catch(() => {}), OVERLAY);
      await page.goto(`${base}/tests/browser/tailnet.html?${new URLSearchParams({ tailcat: addr, overlay: OVERLAY })}`);
      await page.waitForFunction('window.harness?.tailscale().state === "Running" && window.harness.tailscale().netmap', null, { timeout: 60_000, polling: 250 })
        .catch(async (e) => { throw new Error(`${e}; ${JSON.stringify(await harness(page, 'tailscale()'))}; events ${JSON.stringify(await harness(page, 'events()'))}`); });
      const ts = await harness<{ netmap: { addresses: string[] }; timings: { loadMs: number; runningMs: number } }>(page, 'tailscale()');
      const self6 = ts.netmap.addresses.find((a) => a.includes(':'))!.replace(/\/\d+$/, '');
      console.log(`# tailcat in Chromium: loaded in ${ts.timings.loadMs.toFixed(0)} ms, Running after ${ts.timings.runningMs.toFixed(0)} ms; ${ts.netmap.addresses.join(', ')}`);

      const context = async () => `; the client: ${JSON.stringify(await harness(page, 'tailscale()'))}`;
      const run = (cmd: string, ms = 60_000) => runIn(page, cmd, ms, context);
      await loginRoot(page, 240_000, context);
      await run("mkdir -p /run/systemd/network && printf '[Match]\\nName=e*\\n[Network]\\nDHCP=yes\\n' > /run/systemd/network/20-eth.network");
      await run('ln -sf /run/systemd/resolve/stub-resolv.conf /etc/resolv.conf; systemctl start systemd-resolved systemd-networkd', 120_000);
      let a4 = '';
      for (let k = 0; k < 40 && !a4; k++) {
        a4 = (await run("ip -4 -o addr show scope global | awk '{print $4}'")).trim();
        if (!a4) await page.waitForTimeout(1000);
      }
      assert.equal(a4.split('/')[0], '192.0.0.2', `the IPv4 lease is the translator's address: ${await run('ip -br addr; networkctl list 2>&1 | head')}`);
      let a6 = '';
      for (let k = 0; k < 40 && !a6; k++) {
        a6 = (await run("ip -6 -o addr show scope global | awk '{print $4}'")).trim().split('\n')[0];
        if (!a6) await page.waitForTimeout(1000);
      }
      assert.equal(a6.split('/')[0], self6, `the IPv6 lease is the tunnel's address (${a6})`);
      console.log(`# guest: ${a4}, ${a6}; ${(await run('ip route; ip -6 route')).trim().replace(/\n/g, ' | ')}`);

      // TCP over IPv4: translated to IPv6 by the client, proxied by the exit node to this machine's LAN address.
      const page4 = await run(`curl -s -m 20 http://${v4}:${port}/`, 60_000);
      assert.match(page4, /hello-from-the-exit-nodes-lan/, `the guest reaches ${v4}:${port} through the exit node${await context()}`);
      // 2 MB: full-size segments must fit the tunnel (the MSS clamp; 1,260-byte IPv4 packets).
      const size = (await run(`curl -s -m 60 -o /dev/null -w '%{size_download} %{speed_download}\\n' http://${v4}:${port}/big`, 120_000)).split('\n')[0].trim();
      console.log(`# 2 MB over IPv4 through tailcat: ${size} (bytes, bytes/s)`);
      assert.equal(size.split(' ')[0], String(BIG), `the whole download arrived: ${size}`);

      // IPv6, untranslated: the guest's own tunnel address to this machine's IPv6 address.
      const v6 = lan('IPv6');
      if (!v6) console.log('# SKIPPED: IPv6 through the exit node (this machine has no non-link-local IPv6 address)');
      else {
        const page6 = await run(`curl -s -m 20 "http://[${v6}]:${port}/"`, 60_000);
        assert.match(page6, /hello-from-the-exit-nodes-lan/, `the guest reaches [${v6}]:${port} over IPv6${await context()}`);
        const size6 = (await run(`curl -s -m 60 -o /dev/null -w '%{size_download}\\n' "http://[${v6}]:${port}/big"`, 120_000)).split('\n')[0].trim();
        assert.equal(size6, String(BIG), `the whole IPv6 download arrived: ${size6}`);
      }

      // The internet and DNS through the exit node (the lease's resolver is 1.1.1.1): opt-in.
      if (process.env.WEBPC_TAILCAT_INTERNET !== '1') console.log('# SKIPPED: the internet through the exit node (opt-in: WEBPC_TAILCAT_INTERNET=1)');
      else {
        let named = '';
        for (let k = 0; k < 6 && !named.includes(' '); k++) named = (await run('getent ahostsv4 example.com | head -1', 60_000)).split('\n')[0].trim();
        assert.match(named, /^\d+\.\d+\.\d+\.\d+ /, 'the guest resolves example.com through the exit node');
        // Over IPv4: where the exit node's machine has no IPv6 route out (the dev VM), its netstack still accepts
        // the guest's IPv6 connection and then closes it empty, so curl never falls back (docs/backlog.md "Network").
        const got = await run("curl -4 -s -m 20 -o /dev/null -w 'status=%{http_code}\\n' http://example.com/", 60_000);
        if (!/status=[1-5]\d\d/.test(got)) assert.fail(`the guest reaches example.com: ${got}; ${await run('curl -4 -v -m 20 -o /dev/null http://example.com/ 2>&1 | tail -15; getent ahosts example.com', 60_000)}`);
      }
    } finally {
      await page.evaluate(async (n) => (await navigator.storage.getDirectory()).removeEntry(n, { recursive: true }).catch(() => {}), OVERLAY).catch(() => {});
      await ctx.close();
    }
  });
});
