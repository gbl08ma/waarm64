// The guest on a tailnet, end to end in headless Chromium (docs/plans/networking.md N4): the page's
// Debian with virtio-net on the Ethernet gateway (web/gateway.ts) behind the Tailscale client
// (net/tailscale, the Go wasm build, in its own worker), against a headscale and a peer that
// `tests/net/tailnet.sh` starts in rootless Podman (its range is not the default 100.64.0.0/10:
// the guest's address is whatever the client reports). The guest takes a DHCP lease from
// systemd-networkd, pings the peer, resolves it through MagicDNS, and the peer connects to a
// server in the guest. Realtime, so not exact: one boot, ~2 min alone.
// Opt-in: WEBPC_TAILNET=1 (needs Podman, the Go wasm build (net/tailscale/build.sh; built here if
// Go is there) and the Debian image, `npm start` or tools/debian.ts).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { withDebianLock } from './debian-lock.ts';
import { loginRoot, run as runIn } from './serial-console.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const WASM = `${ROOT}target/net/tailscale.wasm`;
const has = (cmd: string) => spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0;
const skip = process.env.WEBPC_TAILNET !== '1' ? 'SKIPPED: set WEBPC_TAILNET=1'
  : !existsSync(`${ROOT}target/images/debian/disk.qcow2`) || !existsSync(`${ROOT}target/images/edk2/QEMU_EFI.fd`) ? 'SKIPPED: run npm start (or images/build.sh debian edk2)'
  : !has('podman') ? 'SKIPPED: no podman'
  : !existsSync(WASM) && !has('go') ? 'SKIPPED: no target/net/tailscale.wasm and no Go to build it'
  : undefined;

// WEBPC_TAILNET_SCRIPT: another implementation of up|key|env|down (for a machine without Podman); `podman` must then still answer the peer's `tailscale` calls.
const script = process.env.WEBPC_TAILNET_SCRIPT ?? `${ROOT}tests/net/tailnet.sh`;
const podman = (...args: string[]) => execFileSync('podman', args, { encoding: 'utf8' });
const peerTs = (...args: string[]) => podman('exec', 'webpc-peer', 'tailscale', '--socket=/tmp/ts.sock', ...args);

let env: Record<string, string>;
let authKey: string;
let browser: Browser;
let base: string;
let closeServer: () => void;
before(async () => {
  if (skip) return;
  if (!existsSync(WASM)) execFileSync(`${ROOT}net/tailscale/build.sh`, [], { stdio: 'inherit' });
  env = Object.fromEntries(execFileSync(script, ['up'], { encoding: 'utf8', timeout: 240_000 }).trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2) as [string, string]));
  authKey = execFileSync(script, ['key'], { encoding: 'utf8' }).trim();
  const server = await startServer();
  closeServer = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
});
after(async () => {
  await browser?.close();
  closeServer?.();
  if (!skip) spawnSync(script, ['down']);
});

const OVERLAY = 'webpc-tailnet-test';
const INTERNET_IP = '1.1.1.1';
const INTERNET_HOST = 'example.com';
const harness = <T>(page: Page, f: string) => page.evaluate(`window.harness.${f}`) as Promise<T>;
/** What the client was doing, for a failure's message. */
const clientState = async (page: Page) => `; the client: ${JSON.stringify(await harness<object>(page, 'tailscale()'))}`;

test('the guest gets a DHCP lease from the tailnet, reaches a peer by address and by name, and is reached', { skip, timeout: 900_000 }, async () => {
  await withDebianLock(async () => {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true }); // headscale's test CA
    const page = await ctx.newPage();
    page.on('console', (m) => { if (/rror|panic/.test(m.text())) console.log(`# page: ${m.text().slice(0, 300)}`); });
    try {
      await page.goto(`${base}/tests/browser/core.html`); // any page of the origin: a fresh overlay
      await page.evaluate(async (n) => (await navigator.storage.getDirectory()).removeEntry(n, { recursive: true }).catch(() => {}), OVERLAY);
      await page.goto(`${base}/tests/browser/tailnet.html?${new URLSearchParams({ control: env.WEBPC_TS_CONTROL, authkey: authKey, hostname: 'guest', overlay: OVERLAY })}`);

      // The client comes up first: the guest's address is what it reports.
      await page.waitForFunction(() => (window as never as { harness: { tailscale(): { state: string } } }).harness.tailscale().state === 'Running', null, { timeout: 120_000, polling: 250 })
        .catch(async (e) => { throw new Error(`${e}; ${JSON.stringify(await harness(page, 'tailscale()'))}; events ${JSON.stringify(await harness(page, 'events()'))}`); });
      await page.waitForFunction((ip) => (window as never as { harness: { tailscale(): { netmap?: { peers: { addresses: string[] }[] } } } }).harness.tailscale().netmap?.peers.some((p) => p.addresses.some((a) => a.replace(/\/\d+$/, '') === ip)), env.WEBPC_TS_PEER_IP, { timeout: 30_000, polling: 250 });
      const ts = await harness<{ netmap: { addresses: string[]; peers: { name: string; addresses: string[] }[]; dns: string[]; domains: string[]; mtu: number }; timings: { loadMs: number; runningMs: number } }>(page, 'tailscale()');
      const self = ts.netmap.addresses.find((a) => !a.includes(':'))!.replace(/\/\d+$/, '');
      console.log(`# Tailscale in Chromium: module loaded in ${ts.timings.loadMs.toFixed(0)} ms, Running after ${ts.timings.runningMs.toFixed(0)} ms; the guest is ${self}, dns ${ts.netmap.dns}, domains ${ts.netmap.domains}, mtu ${ts.netmap.mtu}`);
      assert.ok(ts.netmap.dns.includes('100.100.100.100'), 'MagicDNS is on');
      const peer = ts.netmap.peers.find((p) => p.addresses.some((a) => a.replace(/\/\d+$/, '') === env.WEBPC_TS_PEER_IP));
      assert.ok(peer, `the peer ${env.WEBPC_TS_PEER_IP} is in the netmap`);

      const context = () => clientState(page);
      const run = (cmd: string, ms = 60_000) => runIn(page, cmd, ms, context);
      await loginRoot(page, 240_000, context);

      // Networking as a distribution does it: systemd-networkd's DHCP client and systemd-resolved.
      await run("mkdir -p /run/systemd/network && printf '[Match]\\nName=e*\\n[Network]\\nDHCP=ipv4\\n' > /run/systemd/network/20-eth.network");
      await run('ln -sf /run/systemd/resolve/stub-resolv.conf /etc/resolv.conf; systemctl start systemd-resolved systemd-networkd', 120_000);
      let addr = '';
      for (let k = 0; k < 40 && !addr; k++) {
        addr = (await run("ip -4 -o addr show scope global | awk '{print $4}'")).trim();
        if (!addr) await page.waitForTimeout(1000);
      }
      assert.ok(addr, `no DHCP lease after 40 s:\n${await run('ip -br link; ip -br addr; systemctl is-active systemd-networkd systemd-resolved; networkctl list 2>&1 | head; journalctl -u systemd-networkd --no-pager 2>&1 | tail -15; lsmod | grep -i virtio')}`);
      assert.equal(addr.split('/')[0], self, 'the lease is the address the client reports');
      const routes = await run('ip -4 route');
      console.log(`# guest: ${addr}; routes: ${routes.trim().replace(/\n/g, ' | ')}`);
      assert.match(routes, /default via 169\.254\.0\.1/);

      const ping = await run(`ping -c 3 -W 5 ${env.WEBPC_TS_PEER_IP}`, 90_000);
      assert.match(ping, /3 packets transmitted, 3 received, 0% packet loss/, ping);

      const name = env.WEBPC_TS_PEER_NAME.replace(/\.$/, '');
      const resolved = await run(`getent hosts ${name}`);
      assert.ok(resolved.includes(env.WEBPC_TS_PEER_IP), `MagicDNS: ${name} resolves to the peer (${resolved})`);
      const short = await run('getent hosts peer');
      assert.ok(short.includes(env.WEBPC_TS_PEER_IP), `the search domain: "peer" resolves (${short})`);

      // The peer connects to a server in the guest (through the tailnet, to the guest's own address).
      await run('mkdir -p /tmp/www && echo hello-from-the-guest > /tmp/www/index.html && (cd /tmp/www && nohup python3 -m http.server 8080 --bind 0.0.0.0 > /tmp/http.log 2>&1 &)');
      // Python takes a while to start under emulation: the server must answer inside the guest first.
      let local = '';
      for (let k = 0; k < 30 && !local.includes('hello-from-the-guest'); k++) {
        local = await run(`curl -s -m 5 http://${self}:8080/`);
        if (!local.includes('hello-from-the-guest')) await page.waitForTimeout(2000);
      }
      assert.match(local, /hello-from-the-guest/, `the guest's server didn't come up: ${await run('cat /tmp/http.log; ss -ltn')}`);
      const nc = spawnSync('podman', ['exec', 'webpc-peer', 'sh', '-c', `(printf 'GET / HTTP/1.0\\r\\n\\r\\n'; sleep 10) | timeout 30 tailscale --socket=/tmp/ts.sock nc ${self} 8080`], { encoding: 'utf8' });
      if (nc.status !== 0) {
        assert.fail(`the peer couldn't reach the guest's server (${nc.status}): ${nc.stderr}\nguest: ${await run('ip -s link show dev e*; nstat -az TcpInSegs TcpOutSegs TcpInErrs IpInDelivers IpInAddrErrors; ss -tan; cat /tmp/http.log')}`);
      }
      const reply = nc.stdout; // (`tailscale nc` quits when its stdin ends, so the request is followed by a wait for the reply)
      assert.match(reply, /HTTP\/1\.0 200 OK/);
      assert.match(reply, /hello-from-the-guest/);
      assert.match(peerTs('status'), new RegExp(`${self}\\s+guest`));

      // The exit node: the peer offers to carry the guest's internet traffic. Tailscale's exit nodes
      // never forward RFC 1918 addresses, the exit node's own LAN included (ipn/ipnlocal's
      // removeFromDefaultRoute: the "guest wifi" rule), so a server on this host's LAN can't stand for the
      // internet: the phase uses the real one, so it is opt-in (WEBPC_TAILNET_INTERNET=1) and is
      // skipped, loudly, when this host can't reach it.
      const reach = async (url: string) => fetch(url, { signal: AbortSignal.timeout(8000), redirect: 'manual' }).then((r) => r.status, () => 0);
      const internet = process.env.WEBPC_TAILNET_INTERNET === '1' && (await reach(`http://${INTERNET_IP}/`)) !== 0 && (await reach(`http://${INTERNET_HOST}/`)) !== 0;
      if (!internet) {
        console.log(`# SKIPPED: the exit-node phase (opt-in: WEBPC_TAILNET_INTERNET=1, and this host must reach ${INTERNET_IP} and ${INTERNET_HOST})`);
      } else {
        const offers = (await harness<{ netmap: { exitNode: string; peers: { id: string; name: string; exitNodeOption: boolean }[] } }>(page, 'tailscale()')).netmap;
        const exit = offers.peers.find((p) => p.exitNodeOption);
        assert.ok(exit, `the peer offers to be an exit node: ${JSON.stringify(offers.peers)}`);
        assert.equal(offers.exitNode, '', 'none in use yet');
        const probe = (host: string) => run(`curl -s -m 10 -o /dev/null -w 'status=%{http_code}' http://${host}/; echo " exit=$?"`, 60_000);
        const before = await probe(INTERNET_IP);
        assert.doesNotMatch(before, /status=[1-5]\d\d/, `without an exit node the tailnet has no route to ${INTERNET_IP}: ${before}`);
        assert.equal(await harness<string>(page, `setExitNode(${JSON.stringify(exit.id)})`), '', 'the client takes the exit node');
        await page.waitForFunction((id) => (window as never as { harness: { tailscale(): { netmap: { exitNode: string } } } }).harness.tailscale().netmap.exitNode === id, exit.id, { timeout: 30_000, polling: 250 });
        let via = '';
        for (let k = 0; k < 6 && !/status=[1-5]\d\d/.test(via); k++) via = await probe(INTERNET_IP);
        assert.match(via, /status=[1-5]\d\d/, `through the exit node the guest reaches ${INTERNET_IP}${await context()}; the peer: ${podman('exec', 'webpc-peer', 'tailscale', '--socket=/tmp/ts.sock', 'metrics', 'print').split('\n').filter((l) => /dropped_packets_total\{/.test(l)).join(' ')}`);
        // Names: the guest's resolver asks MagicDNS, which (the tailnet has no nameservers) can only
        // forward to the exit node's resolver (a DoH query to its peerapi); SERVFAIL means it couldn't.
        let named = '';
        for (let k = 0; k < 6 && !named.includes(' '); k++) named = (await run(`getent ahostsv4 ${INTERNET_HOST} | head -1`, 60_000)).split('\n')[0].trim();
        assert.match(named, /^\d+\.\d+\.\d+\.\d+ /, `the guest resolves ${INTERNET_HOST} through the exit node`);
        const http = await probe(INTERNET_HOST);
        assert.match(http, /status=[1-5]\d\d/, `and connects to it by name: ${http}`);
        assert.equal(await harness<string>(page, "setExitNode('')"), '');
        const after = await probe(INTERNET_IP);
        assert.doesNotMatch(after, /status=[1-5]\d\d/, 'and stops when the exit node is cleared');
      }
    } finally {
      await page.evaluate(async (n) => (await navigator.storage.getDirectory()).removeEntry(n, { recursive: true }).catch(() => {}), OVERLAY).catch(() => {});
      await ctx.close();
    }
  });
});
