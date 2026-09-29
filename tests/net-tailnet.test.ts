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

const ROOT = new URL('..', import.meta.url).pathname;
const WASM = `${ROOT}target/net/tailscale.wasm`;
const has = (cmd: string) => spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0;
const skip = process.env.WEBPC_TAILNET !== '1' ? 'SKIPPED: set WEBPC_TAILNET=1'
  : !existsSync(`${ROOT}target/images/debian/Image`) ? 'SKIPPED: run tools/debian.ts (or npm start)'
  : !has('podman') ? 'SKIPPED: no podman'
  : !existsSync(WASM) && !has('go') ? 'SKIPPED: no target/net/tailscale.wasm and no Go to build it'
  : undefined;

const script = `${ROOT}tests/net/tailnet.sh`;
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
const harness = <T>(page: Page, f: string) => page.evaluate(`window.harness.${f}`) as Promise<T>;

/** Waits until the serial output matches; on failure says what the guest and the client were doing. */
async function shows(page: Page, re: RegExp, ms: number, from = 0) {
  const deadline = Date.now() + ms;
  for (;;) {
    const out = (await harness<string>(page, 'output()')).slice(from);
    const m = re.exec(out);
    if (m) return m;
    const err = await harness<string | undefined>(page, 'error()');
    if (err) throw new Error(`the machine worker failed: ${err}`);
    if (Date.now() > deadline) {
      const ts = await harness<object>(page, 'tailscale()');
      throw new Error(`timed out waiting for ${re}; the client: ${JSON.stringify(ts)}; the serial output ends: ${out.slice(-1500)}`);
    }
    await page.waitForTimeout(250);
  }
}

/** Runs a shell command on the serial console; resolves with its output. The end marker is built by the shell, so the echoed command doesn't match it. */
async function run(page: Page, cmd: string, ms = 60_000) {
  const from = (await harness<string>(page, 'output()')).length;
  await page.evaluate((c) => (window as never as { harness: { send(s: string): void } }).harness.send(c), `${cmd}\necho __END$((40+2))__\n`);
  await shows(page, /__END42__\r?\n/, ms, from);
  const out = (await harness<string>(page, 'output()')).slice(from);
  return out.slice(out.indexOf('\n', out.indexOf('__END$((40+2))__')) + 1).replace(/__END42__[\s\S]*$/, '').replace(/\r/g, '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
}

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

      await shows(page, /\S+ login: /, 240_000);
      await page.evaluate(() => (window as never as { harness: { send(s: string): void } }).harness.send('root\n'));
      await shows(page, /root@\S+:~# /, 60_000);

      // Networking as a distribution does it: systemd-networkd's DHCP client and systemd-resolved.
      await run(page, "mkdir -p /run/systemd/network && printf '[Match]\\nName=e*\\n[Network]\\nDHCP=ipv4\\n' > /run/systemd/network/20-eth.network");
      await run(page, 'ln -sf /run/systemd/resolve/stub-resolv.conf /etc/resolv.conf; systemctl start systemd-resolved systemd-networkd', 120_000);
      let addr = '';
      for (let k = 0; k < 40 && !addr; k++) {
        addr = (await run(page, "ip -4 -o addr show scope global | awk '{print $4}'")).trim();
        if (!addr) await page.waitForTimeout(1000);
      }
      assert.ok(addr, `no DHCP lease after 40 s:\n${await run(page, 'ip -br link; ip -br addr; systemctl is-active systemd-networkd systemd-resolved; networkctl list 2>&1 | head; journalctl -u systemd-networkd --no-pager 2>&1 | tail -15; lsmod | grep -i virtio')}`);
      assert.equal(addr.split('/')[0], self, 'the lease is the address the client reports');
      const routes = await run(page, 'ip -4 route');
      console.log(`# guest: ${addr}; routes: ${routes.trim().replace(/\n/g, ' | ')}`);
      assert.match(routes, /default via 169\.254\.0\.1/);

      const ping = await run(page, `ping -c 3 -W 5 ${env.WEBPC_TS_PEER_IP}`, 90_000);
      assert.match(ping, /3 packets transmitted, 3 received, 0% packet loss/, ping);

      const name = env.WEBPC_TS_PEER_NAME.replace(/\.$/, '');
      const resolved = await run(page, `getent hosts ${name}`);
      assert.ok(resolved.includes(env.WEBPC_TS_PEER_IP), `MagicDNS: ${name} resolves to the peer (${resolved})`);
      const short = await run(page, 'getent hosts peer');
      assert.ok(short.includes(env.WEBPC_TS_PEER_IP), `the search domain: "peer" resolves (${short})`);

      // The peer connects to a server in the guest (through the tailnet, to the guest's own address).
      await run(page, 'mkdir -p /tmp/www && echo hello-from-the-guest > /tmp/www/index.html && (cd /tmp/www && nohup python3 -m http.server 8080 --bind 0.0.0.0 > /tmp/http.log 2>&1 &) ; sleep 2');
      const reply = podman('exec', 'webpc-peer', 'sh', '-c', `printf 'GET / HTTP/1.0\\r\\n\\r\\n' | timeout 30 tailscale --socket=/tmp/ts.sock nc ${self} 8080`);
      assert.match(reply, /HTTP\/1\.0 200 OK/);
      assert.match(reply, /hello-from-the-guest/);
      assert.match(peerTs('status'), new RegExp(`${self}\\s+guest`));
    } finally {
      await page.evaluate(async (n) => (await navigator.storage.getDirectory()).removeEntry(n, { recursive: true }).catch(() => {}), OVERLAY).catch(() => {});
      await ctx.close();
    }
  });
});
