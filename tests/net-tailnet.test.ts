// The guest on a tailnet, end to end in headless Chromium (docs/plans/networking.md N4): the page's
// Debian with virtio-net on the Ethernet gateway (web/gateway.ts) behind the Tailscale client
// (net/ts, the Rust client, in its own worker), against a headscale and a peer that
// `tests/net/tailnet.sh` starts in rootless Podman (its range is not the default 100.64.0.0/10:
// the guest's address is whatever the client reports). The guest takes a DHCP lease from
// systemd-networkd, pings the peer, resolves it through MagicDNS, and the peer connects to a
// server in the guest. Then two adapters: this tailnet beside tailcat through a server (below).
// Realtime, so not exact: two boots, ~4 min alone.
// Opt-in: WEBPC_TAILNET=1 (needs Podman, target/net/ts.wasm (net/ts/build.sh) and the Debian image,
// `npm start` or tools/debian.ts).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { withDebianLock } from './debian-lock.ts';
import { loginRoot, run as runIn } from './serial-console.ts';
import { probeResolver } from './net/resolver.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const WASM = `${ROOT}target/net/ts.wasm`;
const has = (cmd: string) => spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0;
const skip = process.env.WEBPC_TAILNET !== '1' ? 'SKIPPED: set WEBPC_TAILNET=1'
  : !existsSync(`${ROOT}target/images/debian/disk.qcow2`) || !existsSync(`${ROOT}target/images/edk2/QEMU_EFI.fd`) ? 'SKIPPED: run images/build.sh debian edk2'
  : !has('podman') ? 'SKIPPED: no podman'
  : !existsSync(WASM) ? 'SKIPPED: no target/net/ts.wasm (net/ts/build.sh)'
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
      const self6 = ts.netmap.addresses.find((a) => a.includes(':'))?.replace(/\/\d+$/, '');
      assert.ok(self6 && env.WEBPC_TS_PEER_IP6, `the tailnet has IPv6 addresses (${self6}, the peer's ${env.WEBPC_TS_PEER_IP6})`);
      assert.ok(ts.netmap.dns.includes('fd7a:115c:a1e0::53'), 'MagicDNS is on over IPv6 too');
      const peer = ts.netmap.peers.find((p) => p.addresses.some((a) => a.replace(/\/\d+$/, '') === env.WEBPC_TS_PEER_IP));
      assert.ok(peer, `the peer ${env.WEBPC_TS_PEER_IP} is in the netmap`);

      const context = () => clientState(page);
      const run = (cmd: string, ms = 60_000) => runIn(page, cmd, ms, context);
      await loginRoot(page, 240_000, context);

      // Networking as a distribution does it: systemd-networkd's DHCP client and systemd-resolved.
      await run("mkdir -p /run/systemd/network && printf '[Match]\\nName=e*\\n[Network]\\nDHCP=yes\\n' > /run/systemd/network/20-eth.network");
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
      // The lease's MTU on the link (UseMTU in the page's credential): 1280, the tunnel's, not virtio-net's 1500.
      assert.equal((await run("cat /sys/class/net/e*/mtu")).trim().split('\n')[0], '1280', 'the link takes the lease\'s MTU');

      const ping = await run(`ping -c 3 -W 5 ${env.WEBPC_TS_PEER_IP}`, 90_000);
      assert.match(ping, /3 packets transmitted, 3 received, 0% packet loss/, ping);

      // IPv6 (N6): the same lease carries the node's IPv6 address (DHCPv6, after the gateway's router advertisement)
      let addr6 = '';
      for (let k = 0; k < 40 && !addr6; k++) {
        addr6 = (await run("ip -6 -o addr show scope global | awk '{print $4}'")).trim().split('\n')[0];
        if (!addr6) await page.waitForTimeout(1000);
      }
      assert.equal(addr6.split('/')[0], self6, `the IPv6 lease is the address the client reports (${addr6})`);
      assert.match(await run('ip -6 route'), /default (nhid \d+ )?via fe80::77:65ff:fe62:7063 dev e\S+ proto ra/);
      const ping6 = await run(`ping -6 -c 3 -W 5 ${env.WEBPC_TS_PEER_IP6}`, 90_000);
      assert.match(ping6, /3 packets transmitted, 3 received, 0% packet loss/, ping6);

      const name = env.WEBPC_TS_PEER_NAME.replace(/\.$/, '');
      console.log(`# the guest's resolver: ${(await run('resolvectl status 2>&1 | grep -v "^ *$" | head -40')).replace(/\n/g, ' | ')}`);
      const resolved = await run(`getent hosts ${name}`);
      assert.ok(resolved.includes(env.WEBPC_TS_PEER_IP), `MagicDNS: ${name} resolves to the peer (${resolved})`);
      // (No AAAA check: the client's MagicDNS answers AAAA for peers only when the control server sends the
      // `magicdns-aaaa` node attribute, which this headscale doesn't. IPv6 reaches peers by address.)
      const short = await run('getent hosts peer');
      assert.ok(short.includes(env.WEBPC_TS_PEER_IP), `the search domain: "peer" resolves (${short})`);
      // What a user types: ping by the short name (the resolver's search domain, then whichever family it picks).
      const pingName = await run('ping -c 3 -W 5 peer', 90_000);
      assert.match(pingName, /3 packets transmitted, 3 received, 0% packet loss/, `ping peer: ${pingName}; resolv.conf: ${await run('cat /etc/resolv.conf; resolvectl status 2>&1 | head -30')}`);

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
      // ... and over IPv6, to a server listening on :: (the peer dials the guest's IPv6 address)
      await run('(cd /tmp/www && nohup python3 -m http.server 8081 --bind :: > /tmp/http6.log 2>&1 &)');
      let local6 = '';
      for (let k = 0; k < 30 && !local6.includes('hello-from-the-guest'); k++) {
        local6 = await run(`curl -s -m 5 "http://[${self6}]:8081/"`);
        if (!local6.includes('hello-from-the-guest')) await page.waitForTimeout(2000);
      }
      assert.match(local6, /hello-from-the-guest/, `the guest's IPv6 server didn't come up: ${await run('cat /tmp/http6.log; ss -ltn')}`);
      const nc6 = spawnSync('podman', ['exec', 'webpc-peer', 'sh', '-c', `(printf 'GET / HTTP/1.0\\r\\n\\r\\n'; sleep 10) | timeout 30 tailscale --socket=/tmp/ts.sock nc ${self6} 8081`], { encoding: 'utf8' });
      assert.equal(nc6.status, 0, `the peer couldn't reach the guest's IPv6 server: ${nc6.stderr}`);
      assert.match(nc6.stdout, /hello-from-the-guest/);
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
        // IPv6 through the exit node (web/reach6.ts): a new exit node counts as out until the probe answers, so the
        // default goes at once; it comes back only if the peer's machine reaches the internet over IPv6, which
        // rootless Podman's network doesn't give it.
        const peer6 = /^default /m.test(podman('exec', 'webpc-peer', 'ip', '-6', 'route'));
        let routes6 = '';
        const default6 = async () => /^default /m.test(routes6 = await run('ip -6 route'));
        let has6 = await default6();
        for (let k = 0; k < 30 && has6 !== peer6; k++) {
          await page.waitForTimeout(1000);
          has6 = await default6();
        }
        assert.equal(has6, peer6, `the guest's IPv6 default through the exit node ${peer6 ? 'is' : "isn't"} there as the peer's IPv6 route out: ${routes6}`);
        console.log(`# IPv6 through the exit node: the peer ${peer6 ? 'has' : 'has no'} IPv6 route out, the guest's default ${has6 ? 'is there' : 'is gone'}`);
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
        let back6 = await default6();
        for (let k = 0; k < 10 && !back6; k++) {
          await page.waitForTimeout(1000);
          back6 = await default6();
        }
        assert.ok(back6, `no exit node, no probe: the lease's IPv6 default is back: ${routes6}`);
      }
    } finally {
      await page.evaluate(async (n) => (await navigator.storage.getDirectory()).removeEntry(n, { recursive: true }).catch(() => {}), OVERLAY).catch(() => {});
      await ctx.close();
    }
  });
});

// Two adapters (docs/network-adapters.md §4, L2): adapter 1 on this tailnet without an exit node, adapter 2 on
// tailcat through tests/net/tailcat.sh's server (the exit node's machine is this one, so this machine's LAN stands for
// the internet). The page's credential has the guest configure both cards itself. Only tailcat reaches the internet, so
// it is the primary although it comes second: the default routes go through it, the tailnet's adapter gives its /10
// and /48 only, and its lease's MagicDNS domain sends the peer's name to it. The guest reaches the tailnet's peer and
// the internet at once. Opt-in also with WEBPC_TAILCAT=1 (Go builds tailcat and derper).
const tailcatSkip = skip ?? (process.env.WEBPC_TAILCAT !== '1' ? 'SKIPPED: set WEBPC_TAILCAT=1 too' : undefined);
test('two adapters: a tailnet without an exit node beside tailcat through a server, the peer and the internet at once', { skip: tailcatSkip, timeout: 900_000 }, async () => {
  const TAILCAT = `${ROOT}tests/net/tailcat.sh`;
  const addr = /WEBPC_TAILCAT_ADDR=(\S+)/.exec(execFileSync(TAILCAT, ['up'], { encoding: 'utf8', timeout: 300_000 }))![1];
  const lan = Object.values(networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254'))?.address;
  assert.ok(lan, 'this machine has a LAN IPv4 address for the exit node to dial');
  const http = createServer((_req, res) => res.end('hello-from-the-internet\n'));
  await new Promise<void>((resolve) => http.listen(0, '0.0.0.0', resolve));
  const url = `http://${lan}:${(http.address() as { port: number }).port}/`;
  // tailcat's IPv6 probe (web/reach6.ts) answered by a stand-in on this machine's IPv6 address: IPv6's default goes
  // through tailcat too. Without one (the dev VM) the probe is lost and the guest has no IPv6 default.
  const lan6 = Object.values(networkInterfaces()).flat().find((a) => a && a.family === 'IPv6' && !a.internal && !a.address.startsWith('fe80'))?.address;
  const resolver = lan6 ? await probeResolver(lan6) : undefined;
  try {
    await withDebianLock(async () => {
      const ctx = await browser.newContext({ ignoreHTTPSErrors: true }); // headscale's test CA, the relay's self-signed certificate
      const page = await ctx.newPage();
      page.on('console', (m) => { if (/rror|panic/.test(m.text())) console.log(`# page: ${m.text().slice(0, 300)}`); });
      type View = { phase: string; text: string; address?: string; internet?: boolean };
      const views = () => harness<View[]>(page, 'views()');
      const context = async () => `; the adapters: ${JSON.stringify(await views())}`;
      const run = (cmd: string, ms = 60_000) => runIn(page, cmd, ms, context);
      try {
        await page.goto(`${base}/tests/browser/core.html`);
        await page.evaluate(async (n) => (await navigator.storage.getDirectory()).removeEntry(n, { recursive: true }).catch(() => {}), OVERLAY);
        await page.goto(`${base}/tests/browser/adapters.html?${new URLSearchParams({ control: env.WEBPC_TS_CONTROL, authkey: authKey, hostname: 'guest2', tailcat: addr, overlay: OVERLAY, probe6: JSON.stringify(resolver ? { to: [resolver.to], port: resolver.port } : {}) })}`);
        await page.waitForFunction(() => (window as never as { harness: { views(): { phase: string }[] } }).harness.views().every((v) => v.phase === 'connected'), null, { timeout: 120_000, polling: 250 })
          .catch(async (e) => { throw new Error(`${e}${await context()}`); });
        const [tn, tc] = await views();
        assert.equal(tn.internet, false, 'the tailnet has no exit node in use');
        assert.equal(tc.internet, true, 'tailcat goes online through its server');
        assert.equal(await harness<number>(page, 'primary()'), 1, 'the primary is the adapter that reaches the internet, though second');
        const self = tn.address!;
        await loginRoot(page, 240_000, context);

        const until = async (what: string, cmd: string, ok: (s: string) => boolean, ms: number) => {
          const t0 = Date.now();
          let out = await run(cmd);
          while (!ok(out) && Date.now() - t0 < ms) {
            await page.waitForTimeout(1000);
            out = await run(cmd);
          }
          assert.ok(ok(out), `${what} after ${ms / 1000} s:\n${out}${await context()}`);
        };
        await until('both leases', 'ip -4 -o addr show scope global', (s) => s.includes(`${self}/`) && s.includes('192.0.0.2/'), 90_000);
        const devOf = async (a: string) => /^(\S+) /m.exec(await run(`ip -4 -o addr show to ${a} | awk '{print $2, $4}'`))?.[1] ?? '';
        const [a, b] = [await devOf(self), await devOf('192.0.0.2')];
        assert.ok(a && b && a !== b, `${a} ${b}`);
        await until("IPv4: the default through tailcat's adapter, the tailnet's /10 through the tailnet's", 'ip -4 route',
          (s) => new RegExp(`default via 169\\.254\\.0\\.2 dev ${b}`).test(s) && new RegExp(`100\\.64\\.0\\.0/10 via 169\\.254\\.0\\.1 dev ${a}`).test(s), 60_000);
        assert.doesNotMatch(await run('ip -4 route'), /default via 169\.254\.0\.1 /, 'no default through the tailnet');
        // The tailnet's /48 at high preference, as the first adapter (web/gateway.ts `ranked`): tailcat's, offered when its
        // IPv6 is out, is the same prefix at medium, so the peer is reached through the tailnet.
        const tailnet48 = new RegExp(`fd7a:115c:a1e0::/48 (nhid \\d+ )?via fe80::77:65ff:fe62:7063 dev ${a} .*pref high`);
        if (resolver) {
          await until("IPv6: the default through tailcat's adapter, the tailnet's /48 through the tailnet's", 'ip -6 route',
            (s) => new RegExp(`default (nhid \\d+ )?via fe80::77:65ff:fe62:7064 dev ${b}`).test(s) && tailnet48.test(s), 60_000);
        } else {
          await until("IPv6: no default (tailcat's exit node has no IPv6 out), the tailnet's /48 through the tailnet's", 'ip -6 route',
            (s) => !/^default /m.test(s) && tailnet48.test(s), 60_000);
        }
        console.log(`# guest: ${(await run('ip -4 route; ip -6 route')).trim().replace(/\n/g, ' | ')}`);

        // At once: the peer pinged through the tailnet while the internet's page comes through tailcat.
        const both = await run(`ping -c 5 -W 5 ${env.WEBPC_TS_PEER_IP} > /tmp/ping.txt 2>&1 & curl -s -m 30 ${url}; wait; cat /tmp/ping.txt`, 90_000);
        assert.match(both, /hello-from-the-internet/, `the internet through tailcat: ${both}`);
        assert.match(both, /5 packets transmitted, 5 received, 0% packet loss/, `the peer through the tailnet: ${both}`);
        const ping6 = await run(`ping -6 -c 3 -W 5 ${env.WEBPC_TS_PEER_IP6}`, 90_000);
        assert.match(ping6, /3 packets transmitted, 3 received, 0% packet loss/, `the peer over IPv6: ${ping6}`);
        // Names: the tailnet's lease's domain routes the peer's name to MagicDNS, on the tailnet's link.
        const name = env.WEBPC_TS_PEER_NAME.replace(/\.$/, '');
        const resolved = await run(`getent hosts ${name}`);
        assert.ok(resolved.includes(env.WEBPC_TS_PEER_IP), `MagicDNS: ${name} resolves to the peer (${resolved}); ${await run('resolvectl status 2>&1 | grep -v "^ *$" | head -40')}`);
      } finally {
        await page.evaluate(async (n) => (await navigator.storage.getDirectory()).removeEntry(n, { recursive: true }).catch(() => {}), OVERLAY).catch(() => {});
        await ctx.close();
      }
    });
  } finally {
    http.close();
    await resolver?.off();
    spawnSync(TAILCAT, ['down']);
  }
});
