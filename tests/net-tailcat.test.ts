// The guest through a tailcat server, end to end in headless Chromium (docs/plans/tailnet-client.md
// T2): the page's Debian with virtio-net on the Ethernet gateway behind the Rust tailnet client
// (net/ts, web/tailcat.ts), against `tests/net/tailcat.sh`'s exit node (tailcat and derper,
// native, on this machine). The guest takes both leases from systemd-networkd (IPv4 192.0.0.2,
// translated to the tunnel's IPv6 by the client; IPv6 the tunnel's own address), and reaches an
// HTTP server on this machine's LAN address through the exit node: a page, then 2 MB (the MSS
// clamp and the 1,260-byte IPv4 path) and 2 MB up (virtio-net's TSO: the device cuts the guest's
// large packets, web/offload.ts), then over IPv6 when this machine has a non-link-local IPv6
// address. A tailcat exit node does forward private addresses, so no internet is needed; the
// internet and DNS (the lease's 1.1.1.1 through the exit node) are opt-in, WEBPC_TAILCAT_INTERNET=1.
// The machine also lets tailcat clients in (T3): the real tailcat CLI parses the machine's address,
// then fetches a page from a web server in the guest through it.
// Realtime: one boot, ~2 min alone. Opt-in: WEBPC_TAILCAT=1 (needs Go for tailcat.sh, the
// Debian image and target/net/ts.wasm).
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  : !existsSync(`${ROOT}target/images/debian/disk.qcow2`) || !existsSync(`${ROOT}target/images/edk2/QEMU_EFI.fd`) ? 'SKIPPED: run images/build.sh debian edk2'
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
  http = createServer((req, res) => {
    if (req.url !== '/up') return res.end(req.url === '/big' ? big : 'hello-from-the-exit-nodes-lan\n');
    // An upload: its size and SHA-256.
    const h = createHash('sha256');
    let n = 0;
    req.on('data', (d: Buffer) => { h.update(d); n += d.length; });
    req.on('end', () => res.end(`${n} ${h.digest('hex')}\n`));
  });
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

/** The tailcat CLI (tests/net/tailcat.sh built it) as a client, `input` on its stdin; its stdout. Never synchronous: this
 * process serves the page's disk, and a guest reading it while the CLI waits on the guest would wait for the timeout. */
async function tailcat(args: string[], input: string): Promise<string> {
  const child = spawn(`${ROOT}target/net/tailcat-test/bin/tailcat`, args, {
    env: { ...process.env, SSL_CERT_FILE: `${ROOT}target/net/tailcat-test/certs/127.0.0.1.crt`, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1', HOME: `${ROOT}target/net/tailcat-test/run` },
  });
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8').on('data', (d: string) => { out += d; });
  child.stderr.setEncoding('utf8').on('data', (d: string) => { err += d; });
  child.stdin.end(input);
  const timer = setTimeout(() => child.kill(), 60_000);
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
  clearTimeout(timer);
  if (code !== 0 && !out) throw new Error(`tailcat ${args[0]}: exit ${code}; ${err.slice(-800)}`);
  return out;
}

test('the guest gets both leases from the tailcat client and reaches the exit node\'s network over IPv4 and IPv6, and lets tailcat clients in', { skip, timeout: 900_000 }, async () => {
  const v4 = lan('IPv4');
  assert.ok(v4, 'this machine has a LAN IPv4 address for the exit node to dial');
  await withDebianLock(async () => {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true }); // the relay's self-signed certificate
    const page = await ctx.newPage();
    page.on('console', (m) => { if (/rror|panic|tailcat/.test(m.text())) console.log(`# page: ${m.text().slice(0, 300)}`); });
    try {
      await page.goto(`${base}/tests/browser/core.html`);
      await page.evaluate(async (n) => (await navigator.storage.getDirectory()).removeEntry(n, { recursive: true }).catch(() => {}), OVERLAY);
      await page.goto(`${base}/tests/browser/tailnet.html?${new URLSearchParams({ tailcat: addr, serve: '', overlay: OVERLAY })}`);
      await page.waitForFunction('window.harness?.tailscale().state === "Running" && window.harness.tailscale().netmap', null, { timeout: 60_000, polling: 250 })
        .catch(async (e) => { throw new Error(`${e}; ${JSON.stringify(await harness(page, 'tailscale()'))}; events ${JSON.stringify(await harness(page, 'events()'))}`); });
      const ts = await harness<{ netmap: { addresses: string[]; serving?: string }; timings: { loadMs: number; runningMs: number } }>(page, 'tailscale()');
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
      // 2 MB up: the guest's stack hands the device packets of up to 64 KB, cut here into 1,228-byte segments (TSO), so
      // the interface counts far fewer packets than the ~1,700 segments that reach the server.
      const sum = (await run(`head -c ${BIG} /dev/urandom > /tmp/up && sha256sum /tmp/up`)).trim().split(/\s+/)[0];
      const upload = async (url: string, family: string) => {
        const tx = async () => Number((await run('cat /sys/class/net/eth0/statistics/tx_packets')).split('\n')[0]);
        const before = await tx();
        const t0 = performance.now();
        const got = (await run(`curl -s -m 60 --data-binary @/tmp/up -H 'Content-Type: application/octet-stream' ${url}`, 120_000)).split('\n')[0].trim();
        const packets = (await tx()) - before;
        console.log(`# 2 MB up over ${family} through tailcat: ${got.split(' ')[0]} bytes in ${((performance.now() - t0) / 1000).toFixed(1)} s, ${packets} packets from the guest's interface`);
        assert.equal(got, `${BIG} ${sum}`, `the whole upload arrived over ${family}`);
        assert.ok(packets < 1000, `the guest's stack sent large packets (TSO): ${packets} for 2 MB${await context()}`);
      };
      await upload(`http://${v4}:${port}/up`, 'IPv4');

      // IPv6, untranslated: the guest's own tunnel address to this machine's IPv6 address.
      const v6 = lan('IPv6');
      if (!v6) console.log('# SKIPPED: IPv6 through the exit node (this machine has no non-link-local IPv6 address)');
      else {
        const page6 = await run(`curl -s -m 20 "http://[${v6}]:${port}/"`, 60_000);
        assert.match(page6, /hello-from-the-exit-nodes-lan/, `the guest reaches [${v6}]:${port} over IPv6${await context()}`);
        const size6 = (await run(`curl -s -m 60 -o /dev/null -w '%{size_download}\\n' "http://[${v6}]:${port}/big"`, 120_000)).split('\n')[0].trim();
        assert.equal(size6, String(BIG), `the whole IPv6 download arrived: ${size6}`);
        await upload(`"http://[${v6}]:${port}/up"`, 'IPv6');
      }

      // The machine as a tailcat server: its address is one tailcat reads (the exit node's relay), and the CLI
      // reaches a port the guest listens on (as `tailcat ssh` reaches port 22).
      const served = ts.netmap.serving ?? '';
      assert.ok(served.startsWith('tc'), `the machine serves at an address of its own: ${JSON.stringify(ts.netmap)}`);
      const parsed = JSON.parse(await tailcat(['parse', served], ''));
      assert.equal(parsed.Region[0].Nodes[0].HostName, '127.0.0.1', `the exit node's relay: ${JSON.stringify(parsed)}`);
      console.log(`# the machine's tailcat address: ${served.length} characters, ${JSON.stringify(parsed.Region)}`);
      assert.match(await run('command -v python3'), /python3/, 'the guest has a web server to offer');
      await run('cd /tmp && echo hello-from-the-guest > index.html && (python3 -m http.server --bind :: 8080 > /dev/null 2>&1 &) && sleep 1');
      let got = '';
      try {
        got = await tailcat([served, '8080'], 'GET /index.html HTTP/1.0\r\n\r\n');
      } catch (e) {
        throw new Error(`${e}; the guest: ${await run("ss -ltn | grep 8080; ip -6 route; nstat -az 2>/dev/null | grep -E 'Ip6In(NoRoutes|AddrErrors|Discards|Receives)|TcpInSegs|TcpOutSegs|ListenDrops' ; cat /proc/net/snmp6 | grep -E 'Ip6InReceives|Ip6InNoRoutes|Ip6InAddrErrors|Ip6InDiscards|Ip6OutRequests'")}${await context()}`);
      }
      assert.match(got, /hello-from-the-guest/, `a tailcat client reaches the guest's port 8080: ${got.slice(0, 500)}`);
      const entered = (await harness<{ type: string }[]>(page, 'events()')).length;
      console.log(`# tailcat client to the guest's web server: ${got.split('\n')[0].trim()} (${entered} events)`);

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
