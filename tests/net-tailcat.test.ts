// The guest through a tailcat server, end to end in headless Chromium (docs/networking/tailnet.md
// T2): the page's Debian with virtio-net on the Ethernet gateway behind the Rust tailnet client
// (net/ts, web/tailcat.ts), against `tests/net/tailcat.sh`'s exit node (tailcat and derper,
// native, on this machine). The guest takes both leases from systemd-networkd (IPv4 192.0.0.2,
// translated to the tunnel's IPv6 by the client; IPv6 the tunnel's own address), and reaches an
// HTTP server on this machine's LAN address through the exit node: a page, then 2 MB (the MSS
// clamp and the 1,260-byte IPv4 path) and 2 MB up (virtio-net's TSO: the device cuts the guest's
// large packets, web/offload.ts), then over IPv6 when this machine has a non-link-local IPv6
// address. A tailcat exit node does forward private addresses, so no internet is needed; the
// internet and DNS (the lease's 1.1.1.1 through the exit node) are opt-in, WAARM64_TAILCAT_INTERNET=1.
// The client's IPv6 probe (web/reach6.ts): where this machine has no IPv6 address (the dev VM), the exit node's IPv6
// doesn't reach out, so the probe is lost and the guest has no IPv6 default route: IPv6 to the internet is
// unreachable at once, and tailcat clients still come in (each has a route of its own). With one, the probe asks
// tests/net/resolver.ts's stand-in on it: the default route is there while it answers, goes when it stops, and comes
// back with its next answer.
// The machine also lets tailcat clients in (T3): the real tailcat CLI parses the machine's address,
// then fetches a page from a web server in the guest through it. And on images/debian-tools/build.sh's Debian (on demand),
// which has an SSH server: serving alone with an allow list of the CLI's own key, `tailcat ssh` logs in to the guest,
// `tailcat ping` gets a pong, and a client with another key gets nothing; over the rig's relay, or over tailcat's public
// relays with WAARM64_TAILCAT_INTERNET=1.
// Realtime: one boot, ~2 min alone. Opt-in: WAARM64_TAILCAT=1 (needs Go for tailcat.sh, the
// Debian image and target/net/ts.wasm).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { withDebianLock } from './debian-lock.ts';
import { loginRoot, run as runIn } from './serial-console.ts';
import { probeResolver, type ProbeResolver } from './net/resolver.ts';
import { clientKey, RIG_RELAY, tailcat, tailcatRun } from './net/tailcat-cli.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const has = (cmd: string, arg = '--version') => spawnSync(cmd, [arg], { stdio: 'ignore' }).status === 0;
const skip = process.env.WAARM64_TAILCAT !== '1' ? 'SKIPPED: set WAARM64_TAILCAT=1'
  : !existsSync(`${ROOT}target/images/debian/disk.qcow2`) || !existsSync(`${ROOT}target/images/edk2/QEMU_EFI.fd`) ? 'SKIPPED: run images/build.sh debian edk2'
  : !existsSync(`${ROOT}target/net/ts.wasm`) ? 'SKIPPED: no target/net/ts.wasm (net/ts/build.sh)'
  : !has('go', 'version') && !existsSync(`${ROOT}target/net/tailcat-test/bin/tailcat`) ? 'SKIPPED: no Go to build tailcat and derper'
  : undefined;
const script = `${ROOT}tests/net/tailcat.sh`;
const OVERLAY = 'waarm64-tailcat-test';
const TOOLS = `${ROOT}target/images/debian-tools/disk.qcow2`;
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
let resolver: ProbeResolver | undefined;
before(async () => {
  if (skip) return;
  const v6 = lan('IPv6');
  resolver = v6 ? await probeResolver(v6) : undefined;
  const env = Object.fromEntries(execFileSync(script, ['up'], { encoding: 'utf8', timeout: 300_000 }).trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)));
  addr = env.WAARM64_TAILCAT_ADDR;
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
  await resolver?.off();
  if (!skip) spawnSync(script, ['down']);
});

const harness = <T>(page: Page, f: string) => page.evaluate(`window.harness.${f}`) as Promise<T>;

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
      await page.goto(`${base}/tests/browser/tailnet.html?${new URLSearchParams({ tailcat: addr, serve: '', overlay: OVERLAY, probe6: JSON.stringify(resolver ? { to: [resolver.to], port: resolver.port, everyMs: 5000 } : {}) })}`);
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
      const until = async (what: string, cmd: string, ok: (s: string) => boolean, ms: number) => {
        const t0 = performance.now();
        let out = await run(cmd);
        while (!ok(out) && performance.now() - t0 < ms) {
          await page.waitForTimeout(1000);
          out = await run(cmd);
        }
        assert.ok(ok(out), `${what} after ${ms / 1000} s:\n${out}${await context()}`);
        return (performance.now() - t0) / 1000;
      };
      const default6 = (s: string) => /^default (nhid \d+ )?via fe80::77:65ff:fe62:7063 dev \S+ proto ra/m.test(s);
      if (resolver) await until('the IPv6 default route (the probe answered)', 'ip -6 route', default6, 30_000);
      console.log(`# guest: ${a4}, ${a6}; ${(await run('ip route; ip -6 route')).trim().replace(/\n/g, ' | ')}`);

      // TCP over IPv4: translated to IPv6 by the client, proxied by the exit node to this machine's LAN address.
      const page4 = await run(`curl -s -m 20 http://${v4}:${port}/`, 60_000);
      assert.match(page4, /hello-from-the-exit-nodes-lan/, `the guest reaches ${v4}:${port} through the exit node${await context()}`);
      // 2 MB: full-size segments must fit the tunnel (the MSS clamp; 1,260-byte IPv4 packets). The relay's messages
      // carry 2 to 4 of them, which virtio-net merges (web/offload.ts `receive`): the guest takes fewer packets than
      // the ~1,700 segments.
      const rxPackets = async () => Number((await run('cat /sys/class/net/eth0/statistics/rx_packets')).split('\n')[0]);
      const rx0 = await rxPackets();
      const size = (await run(`curl -s -m 60 -o /dev/null -w '%{size_download} %{speed_download}\\n' http://${v4}:${port}/big`, 120_000)).split('\n')[0].trim();
      const received = (await rxPackets()) - rx0;
      console.log(`# 2 MB over IPv4 through tailcat: ${size} (bytes, bytes/s), ${received} packets into the guest's interface`);
      assert.equal(size.split(' ')[0], String(BIG), `the whole download arrived: ${size}`);
      assert.ok(received < 1600, `segments were merged on the way in: ${received} packets for 2 MB${await context()}`);
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

      // The exit node's IPv6 stops reaching out: within three lost probes the router advertisement withdraws the
      // default, so IPv6 to the internet fails at once (curl's 7, "couldn't connect", not 52's empty reply from the exit
      // node). The tailcat clients below still come in: each is a route of its own, the address staying.
      if (!resolver) console.log('# SKIPPED: the IPv6 default route while the probe answers (this machine has no non-link-local IPv6 address)');
      await resolver?.off();
      const gone = await until('no IPv6 default route (the probe lost)', 'ip -6 route', (s) => !default6(s), 60_000);
      const routes6 = await run('ip -6 route');
      const unreachable = await run("curl -6 -s -m 20 -o /dev/null -w 'exit=' 'http://[2606:4700:4700::1111]/'; echo $?", 60_000);
      assert.match(unreachable, /exit=7/, `IPv6 to the internet is unreachable at once: ${unreachable}`);
      console.log(`# IPv6 out: the default route gone after ${gone.toFixed(0)} s; ${routes6.trim().replace(/\n/g, ' | ')}`);

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
      assert.match(await run('ip -6 route'), /^fd7a:\S+ (nhid \d+ )?via fe80::77:65ff:fe62:7063 dev \S+ proto ra/m, "the client's own route, with no default");
      const entered = (await harness<{ type: string }[]>(page, 'events()')).length;
      console.log(`# tailcat client to the guest's web server: ${got.split('\n')[0].trim()} (${entered} events)`);

      // The internet and DNS through the exit node (the lease's resolver is 1.1.1.1): opt-in.
      if (process.env.WAARM64_TAILCAT_INTERNET !== '1') console.log('# SKIPPED: the internet through the exit node (opt-in: WAARM64_TAILCAT_INTERNET=1)');
      else {
        let named = '';
        for (let k = 0; k < 6 && !named.includes(' '); k++) named = (await run('getent ahostsv4 example.com | head -1', 60_000)).split('\n')[0].trim();
        assert.match(named, /^\d+\.\d+\.\d+\.\d+ /, 'the guest resolves example.com through the exit node');
        // Either family: with IPv6 out (above), curl's IPv6 attempt fails at once and it uses IPv4.
        const got = await run("curl -s -m 20 -o /dev/null -w 'status=%{http_code}\\n' http://example.com/", 60_000);
        if (!/status=[1-5]\d\d/.test(got)) assert.fail(`the guest reaches example.com: ${got}; ${await run('curl -v -m 20 -o /dev/null http://example.com/ 2>&1 | tail -15; getent ahosts example.com', 60_000)}`);
      }

      // And back: the next probe's answer advertises the default router again.
      if (resolver) {
        await resolver.on();
        const back = await until('the IPv6 default route again (the probe answered)', 'ip -6 route', default6, 30_000);
        console.log(`# IPv6 back: the default route after ${back.toFixed(0)} s`);
      }
    } finally {
      await page.evaluate(async (n) => (await navigator.storage.getDirectory()).removeEntry(n, { recursive: true }).catch(() => {}), OVERLAY).catch(() => {});
      await ctx.close();
    }
  });
});

// A primary per family (docs/networking/adapters.md §4): two adapters on tailcat through the server, the first's IPv6
// probe asking a port nothing answers (its server's IPv6 out), the second's the stand-in resolver. IPv4's default goes
// through the first (the first that reaches the internet), IPv6's through the second, and the guest reaches this
// machine over IPv6 through it. Needs a non-link-local IPv6 address here, as the IPv6 default's case above.
test("a primary per family: IPv4's default through the first adapter, IPv6's through the second whose probe answers", { skip: skip || (!lan('IPv6') && 'SKIPPED: this machine has no non-link-local IPv6 address'), timeout: 900_000 }, async () => {
  await resolver!.on();
  await withDebianLock(async () => {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (/rror|panic/.test(m.text())) console.log(`# page: ${m.text().slice(0, 300)}`); });
    const context = async () => `; the adapters: ${JSON.stringify(await harness(page, 'views()'))}, primaries ${await harness(page, 'primary()')}/${await harness(page, 'primary6()')}`;
    const run = (cmd: string, ms = 60_000) => runIn(page, cmd, ms, context);
    try {
      await page.goto(`${base}/tests/browser/core.html`);
      await page.evaluate(async (n) => (await navigator.storage.getDirectory()).removeEntry(n, { recursive: true }).catch(() => {}), OVERLAY);
      const probe = (p: number) => JSON.stringify({ to: [resolver!.to], port: p, everyMs: 5000 });
      await page.goto(`${base}/tests/browser/adapters.html?${new URLSearchParams({ split: '', tailcat: addr, overlay: OVERLAY, probe6a: probe(9), probe6b: probe(resolver!.port) })}`);
      await page.waitForFunction('window.harness?.primary6() === 1', null, { timeout: 120_000, polling: 250 })
        .catch(async (e) => { throw new Error(`${e}${await context()}`); });
      assert.equal(await harness<number>(page, 'primary()'), 0, "IPv4's primary is the first that reaches the internet");
      await loginRoot(page, 240_000, context);
      const until = async (what: string, cmd: string, ok: (s: string) => boolean, ms: number) => {
        const t0 = performance.now();
        let out = await run(cmd);
        while (!ok(out) && performance.now() - t0 < ms) {
          await page.waitForTimeout(1000);
          out = await run(cmd);
        }
        assert.ok(ok(out), `${what} after ${ms / 1000} s:\n${out}${await context()}`);
      };
      await until('two IPv6 leases', 'ip -6 -o addr show scope global', (s) => s.trim().split('\n').length >= 2, 90_000);
      await until("IPv4's default through the first adapter only", 'ip -4 route', (s) => /^default via 169\.254\.0\.1 /m.test(s) && !/^default via 169\.254\.0\.2 /m.test(s), 90_000);
      await until("IPv6's default through the second adapter only", 'ip -6 route', (s) => /^default (nhid \d+ )?via fe80::77:65ff:fe62:7064 /m.test(s) && !/via fe80::77:65ff:fe62:7063 .*proto ra/.test(s.split('\n').filter((l) => l.startsWith('default')).join('\n')), 60_000);
      console.log(`# guest: ${(await run('ip -4 route; ip -6 route')).trim().replace(/\n/g, ' | ')}`);
      const page6 = await run(`curl -s -m 20 "http://[${resolver!.to}]:${port}/"`, 60_000);
      assert.match(page6, /hello-from-the-exit-nodes-lan/, `the guest reaches [${resolver!.to}]:${port} over IPv6 through the second adapter${await context()}`);
      const page4 = await run(`curl -s -m 20 http://${lan('IPv4')}:${port}/`, 60_000);
      assert.match(page4, /hello-from-the-exit-nodes-lan/, `and over IPv4 through the first${await context()}`);
      // The second's server loses IPv6: IPv6's default comes back to the primary, whose lease has none, so there is none.
      await resolver!.off();
      await page.waitForFunction('window.harness.primary6() === 0', null, { timeout: 60_000, polling: 250 })
        .catch(async (e) => { throw new Error(`${e}${await context()}`); });
      await until('no IPv6 default (neither reaches it)', 'ip -6 route', (s) => !/^default /m.test(s), 60_000);
    } finally {
      await page.evaluate(async (n) => (await navigator.storage.getDirectory()).removeEntry(n, { recursive: true }).catch(() => {}), OVERLAY).catch(() => {});
      await ctx.close();
    }
  });
});

test('tailcat ssh logs in to the served guest\'s sshd; tailcat ping gets a pong; the allow list keeps other keys out', { skip: skip || (!existsSync(TOOLS) && 'SKIPPED: run images/debian-tools/build.sh'), timeout: 900_000 }, async () => {
  const internet = process.env.WAARM64_TAILCAT_INTERNET === '1';
  const relay = internet ? '' : RIG_RELAY;
  if (!internet) console.log("# SKIPPED: tailcat ssh through tailcat's public relays (opt-in: WAARM64_TAILCAT_INTERNET=1); over the rig's relay instead");
  const mine = await clientKey();
  // ssh as tailcat runs it, with a key of the test's own (never the user's).
  const tmp = mkdtempSync(join(tmpdir(), 'waarm64-tailcat-ssh-'));
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'waarm64-test', '-f', `${tmp}/id`]);
  writeFileSync(`${tmp}/ssh`, `#!/bin/sh\nexec /usr/bin/ssh -i ${tmp}/id -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=60 "$@"\n`);
  chmodSync(`${tmp}/ssh`, 0o755);
  const cli = { internet, env: { PATH: `${tmp}:${process.env.PATH}` }, timeoutMs: 120_000 };
  await withDebianLock(async () => {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true }); // the relay's self-signed certificate
    const page = await ctx.newPage();
    page.on('console', (m) => { if (/rror|panic|tailcat/.test(m.text())) console.log(`# page: ${m.text().slice(0, 300)}`); });
    const overlay = `${OVERLAY}-ssh`;
    try {
      await page.goto(`${base}/tests/browser/core.html`);
      await page.evaluate(async (n) => (await navigator.storage.getDirectory()).removeEntry(n, { recursive: true }).catch(() => {}), overlay);
      await page.goto(`${base}/tests/browser/tailnet.html?${new URLSearchParams({ serve: '', relay, allow: mine, overlay, disk: `${base}/target/images/debian-tools/disk.qcow2` })}`);
      await page.waitForFunction('window.harness?.tailscale().state === "Running" && window.harness.tailscale().netmap?.serving', null, { timeout: 60_000, polling: 250 })
        .catch(async (e) => { throw new Error(`${e}; ${JSON.stringify(await harness(page, 'tailscale()'))}; events ${JSON.stringify(await harness(page, 'events()'))}`); });
      const served = (await harness<{ netmap: { serving: string } }>(page, 'tailscale()')).netmap.serving;
      const context = async () => `; the client: ${JSON.stringify(await harness(page, 'tailscale()'))}`;
      const run = (cmd: string, ms = 60_000) => runIn(page, cmd, ms, context);
      await loginRoot(page, 240_000, context);
      await run("mkdir -p /run/systemd/network && printf '[Match]\\nName=e*\\n[Network]\\nDHCP=yes\\n' > /run/systemd/network/20-eth.network");
      await run('systemctl start systemd-networkd', 120_000);
      await run(`mkdir -p -m 700 /root/.ssh && echo '${readFileSync(`${tmp}/id.pub`, 'utf8').trim()}' > /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys`);
      let up = '';
      for (let k = 0; k < 60 && !(up.includes('active') && up.includes('fd7a')); k++) {
        up = await run("systemctl is-active ssh; ip -6 -o addr show scope global | awk '{print $4}'");
        if (!up.includes('fd7a')) await page.waitForTimeout(1000);
      }
      assert.match(up, /^active/m, `the guest's sshd runs: ${up}`);
      assert.match(up, /fd7a:/, `the guest has its tunnel address: ${up}${await context()}`);

      // Another key than the allowed one: no answer to its hello, so no pong (tailcat's own --allow does the same).
      const stranger = await tailcatRun(['--key=new', 'ping', '--timeout=10s', served], '', cli);
      assert.doesNotMatch(stranger.out, /pong/, `a key not on the list got in: ${stranger.out}`);
      assert.notEqual(stranger.code, 0);
      const pong = await tailcatRun(['ping', served], '', cli);
      assert.match(pong.out, /^pong in \S+ via DERP\(/m, `the CLI's own key gets a pong: exit ${pong.code}; ${pong.err.slice(-600)}`);
      const t0 = performance.now();
      const r = await tailcatRun(['ssh', `root@${served}`, 'echo hello-over-ssh $(uname -m) $(id -un)'], '', cli);
      assert.match(r.out, /hello-over-ssh aarch64 root/, `tailcat ssh logged in: exit ${r.code}; ${r.err.slice(-800)}${await context()}`);
      console.log(`# over ${relay || "tailcat's public relays"}: ${pong.out.trim()}; tailcat ssh in ${((performance.now() - t0) / 1000).toFixed(1)} s: ${r.out.trim()}`);
    } finally {
      await page.evaluate(async (n) => (await navigator.storage.getDirectory()).removeEntry(n, { recursive: true }).catch(() => {}), overlay).catch(() => {});
      await ctx.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
