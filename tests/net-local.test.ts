// The local network helper (docs/plans/networking-local.md; github.com/gbl08ma/waarm64-net): the page's Debian with one card on an IP
// port, as the page has it, first on the page's gateway with a lease of its own, then handed to the local helper's
// client (web/local-net.ts `startLocal`, its worker) as the Network menu does: the card goes on a frame port, the
// page's gateway bypassed, its frames over a WebSocket on loopback to the helper, whose DHCP, DNS and gateway serve the
// guest onto this computer's sockets. The link flaps on the switch and the guest takes the helper's lease at once
// (networkd, the card's credential), resolves through the helper, moves a few megabytes each way to a server on this
// machine's loopback (--host-loopback) and runs `apt-get update`; IPv6 is on-link always and routed out only when this
// machine reaches the internet over IPv6 (the helper's probe), so dual-stack names connect without a wait either way;
// the helper refuses a wrong token and a page from another origin, each with its own close code.
// One Debian boot in realtime (~2 min); needs Go (the helper is built at the commit tests/waarm64-net.ts pins). Opt-in like the other
// network tests: scripts/ci-net.sh.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { buildHelper, helperSkip } from './waarm64-net.ts';
import { withDebianLock } from './debian-lock.ts';
import { debianFixture } from './debian-fixture.ts';
import { loginRoot, run as runIn } from './serial-console.ts';
import { startNostrRelay } from './net/nostr-relay.ts';
import { RIG_RELAY } from './net/tailcat-cli.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const skip = process.env.WAARM64_NET_TESTS !== '1' ? 'SKIPPED: scripts/ci-net.sh runs it (WAARM64_NET_TESTS=1)'
  : !(process.env.WAARM64_DISTROS ?? '').split(',').includes('debian') ? 'SKIPPED: set WAARM64_DISTROS=debian'
  : !existsSync(`${ROOT}target/images/debian/disk.qcow2`) || !existsSync(`${ROOT}target/images/edk2/QEMU_EFI.fd`) ? 'SKIPPED: run images/build.sh debian edk2'
  : helperSkip();

const OVERLAY = 'waarm64-net-local-test';
const BIG = 8 << 20;
const big = randomBytes(BIG);
const bigSum = createHash('sha256').update(big).digest('hex');
let browser: Browser;
let base: string;
let closeServer: () => void;
let helper: ChildProcess | undefined;
let helperLog = '';
let ws: string;
let files: Server;
let filesPort: number;

const freePort = () => new Promise<number>((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const p = (s.address() as AddressInfo).port;
    s.close(() => resolve(p));
  });
});

/** Whether this machine reaches the internet over IPv6 (what the helper's probe asks: a root NS query to public resolvers). */
const hostReaches6 = () => new Promise<boolean>((resolve) => {
  let s: dgram.Socket;
  try {
    s = dgram.createSocket('udp6');
  } catch {
    return resolve(false);
  }
  const done = (v: boolean) => {
    clearTimeout(t);
    try { s.close(); } catch { /* closed */ }
    resolve(v);
  };
  const t = setTimeout(() => done(false), 3000);
  s.on('error', () => done(false));
  s.on('message', (m) => { if (m.length >= 12 && m[0] === 0x12 && m[1] === 0x34) done(true); });
  const q = Buffer.from([0x12, 0x34, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 1]);
  for (const to of ['2606:4700:4700::1111', '2001:4860:4860::8888', '2620:fe::fe']) s.send(q, 53, to, () => {});
});

before(async () => {
  if (skip) return;
  buildHelper();
  const server = await startServer();
  closeServer = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  // The machine's own server, which the guest reaches at the helper's host address.
  files = createServer((req, res) => {
    if (req.method === 'POST') {
      const h = createHash('sha256');
      req.on('data', (d) => h.update(d)).on('end', () => res.end(h.digest('hex')));
    } else if (req.url === '/big') res.end(big);
    else res.end('hello from the host\n');
  });
  await new Promise<void>((r) => files.listen(0, '127.0.0.1', r));
  filesPort = (files.address() as AddressInfo).port;
  const port = await freePort();
  const token = randomBytes(32).toString('base64url');
  ws = `ws://127.0.0.1:${port}/${token}`;
  helper = spawn(`${ROOT}target/net/waarm64-net`, ['--listen', `127.0.0.1:${port}`, '--origin', base, '--host-loopback'], { env: { ...process.env, WAARM64_NET_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
  helper.stdout!.on('data', (d) => { helperLog += d; });
  helper.stderr!.on('data', (d) => { helperLog += d; });
  for (let k = 0; k < 100 && !helperLog.includes('listening on'); k++) await new Promise((r) => setTimeout(r, 100));
  assert.match(helperLog, /listening on/, `the helper didn't start: ${helperLog}`);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
});
after(async () => {
  await browser?.close();
  closeServer?.();
  files?.close();
  helper?.kill();
});

const harness = <T>(page: Page, f: string) => page.evaluate(`window.harness.${f}`) as Promise<T>;
const local = (page: Page) => page.evaluate('window.harness.local()') as Promise<{ state: string; error?: string; addresses?: string[] } | undefined>;

/** The close code a WebSocket to `url` gets, from `page`'s origin. */
const closeCode = (page: Page, url: string) => page.evaluate((u) => new Promise<number>((resolve) => {
  const s = new WebSocket(u, 'waarm64-net.v1');
  s.onclose = (e) => resolve(e.code);
}), url);

test('Debian on the page through the local helper: its lease, DNS, TCP to this machine both ways, apt, IPv6 as far as the host has it, refusals', { skip, timeout: 900_000 }, async () => {
  const reach6 = await hostReaches6();
  console.log(`# this machine reaches the internet over IPv6: ${reach6}`);
  const restore = await debianFixture(browser, base, 'port');
  await withDebianLock(async () => {
    const page = await (await browser.newContext()).newPage();
    const removeOverlay = () => page.evaluate(async (n) => (await navigator.storage.getDirectory()).removeEntry(n, { recursive: true }).catch(() => {}), OVERLAY).catch(() => {});
    const context = async () => `\n# client: ${JSON.stringify(await local(page).catch(() => undefined))}\n# helper:\n${helperLog}`;
    const run = (cmd: string, ms?: number) => runIn(page, cmd, ms, context);
    try {
      await page.goto(`${base}/tests/browser/core.html`);
      await removeOverlay();
      // Refusals first, from this page's origin and from another (localhost isn't 127.0.0.1 to a browser).
      assert.equal(await closeCode(page, `${ws}x`), 4004, 'a wrong token');
      const other = await (await browser.newContext()).newPage();
      await other.goto(`${base.replace('127.0.0.1', 'localhost')}/tests/browser/core.html`);
      assert.equal(await closeCode(other, ws), 4003, 'another origin');
      await other.context().close();

      const t0 = Date.now();
      await page.goto(`${base}/tests/browser/netguest.html?${new URLSearchParams({ ...(restore ? { restore } : {}), overlay: OVERLAY, port: '1' })}`);
      await page.evaluate('window.harness.lease()'); // the page's gateway's lease, as a tailnet's would be
      await loginRoot(page, undefined, context);
      console.log(`# login prompt after ${((Date.now() - t0) / 1000).toFixed(0)} s`);

      const addr4 = () => run("ip -4 -o addr show scope global | awk '{print $2, $4}'").then((s) => s.trim().split('\n')[0]);
      /** The guest's IPv4 address once it matches `re` (polled each second, at most `s` s). */
      const addrLike = async (re: RegExp, s: number) => {
        let got = await addr4();
        for (let k = 0; k < s && !re.test(got); k++) {
          await page.waitForTimeout(1000);
          got = await addr4();
        }
        return got;
      };
      let got = await addrLike(/198\.18\.0\.15/, 60);
      assert.match(got, /^e\S+ 198\.18\.0\.15\/32$/, `the page's gateway's lease first: ${got}`);
      // The Network menu's Connect: the helper's client takes the card's port. Without the flap the guest would keep the
      // gateway's address until its renewal (half an hour); with it, the helper's lease comes within seconds of the link's
      // return (devices.ts `FLAP_MS`: the gateway's lease's MTU, 1280, makes networkd wait out a loss under 5 s).
      const t1 = Date.now();
      await page.evaluate((u) => (window as unknown as { harness: { connectLocal(u: string): void } }).harness.connectLocal(u), ws);
      got = await addrLike(/192\.168\.127\.\d+/, 30);
      if (!/192\.168\.127\./.test(got)) assert.fail(`the helper's lease: ${got}\n${await run("journalctl -b -u systemd-networkd --no-pager -o short-monotonic | sed -n '/Lost carrier/,$p' | head -40", 30_000)}${await context()}`);
      console.log(`# the helper's lease ${((Date.now() - t1) / 1000).toFixed(0)} s after the switch: ${got}`);
      assert.equal((await local(page))?.state, 'Running', await context()); // i18n-ignore
      const routes = await run('ip -4 route');
      assert.match(routes, /default via 192\.168\.127\.1/, routes);
      assert.doesNotMatch(routes, /198\.18|169\.254\.0\.1/, `nothing left of the gateway's lease: ${routes}`);
      for (let k = 0; k < 10 && !(await local(page))?.addresses?.length; k++) await page.waitForTimeout(500);
      assert.deepEqual((await local(page))?.addresses, [`${got.split(' ')[1].split('/')[0]}/32`], "the menu's address: the helper's lease, read from its acknowledgment");

      // DNS through the helper's resolver (the host's).
      const name = await run('getent ahostsv4 deb.debian.org | head -1', 30_000);
      assert.match(name, /^\d+\.\d+\.\d+\.\d+\s/m, `deb.debian.org through the helper's DNS: ${name}`);

      // TCP to this machine's loopback through --host-loopback, both ways.
      const url = `http://192.168.127.254:${filesPort}`;
      assert.match(await run(`curl -s -m 20 ${url}/`, 60_000), /hello from the host/);
      const down = (await run(`curl -s -m 120 -o /tmp/big -w '%{size_download} %{speed_download}\\n' ${url}/big && sha256sum /tmp/big`, 180_000)).trim().split('\n');
      const [size, speed] = down[0].split(' ').map(Number);
      assert.equal(size, BIG, down.join('\n'));
      assert.equal(down[1].split(/\s+/)[0], bigSum, 'the download arrived whole');
      const up = (await run(`curl -s -m 120 -w ' %{speed_upload}\\n' --data-binary @/tmp/big ${url}/up`, 180_000)).trim().split('\n')[0].split(' ');
      assert.equal(up[0], bigSum, 'the upload arrived whole');
      console.log(`# 8 MiB to the guest at ${(speed * 8 / 1e6).toFixed(1)} Mbit/s, from it at ${(Number(up[1]) * 8 / 1e6).toFixed(1)} Mbit/s (Debian's curl, loopback, this machine)`);

      // IPv6: always on the link (the helper's /64 and its gateway), routed out only when this machine has it.
      const addr6 = () => run("ip -6 -o addr show scope global | awk '{print $4}'");
      let got6 = await addr6();
      for (let k = 0; k < 30 && !/fd77:6562:7063:/.test(got6); k++) {
        await page.waitForTimeout(1000);
        got6 = await addr6();
      }
      assert.match(got6, /fd77:6562:7063:/, `an address in the helper's /64: ${got6}\n${await run('ip -6 route; networkctl status eth0 --no-pager 2>&1 | head -30')}`);
      const gw6 = await run('ping -6 -c 1 -W 5 fd77:6562:7063::1');
      assert.match(gw6, /1 packets transmitted, 1 received/, gw6);
      const routes6 = await run('ip -6 route');
      if (reach6) assert.match(routes6, /^default .*proto ra/m, `this machine has IPv6, so the guest's default: ${routes6}`);
      else assert.doesNotMatch(routes6, /^default/m, `this machine has no IPv6, so no default for the guest: ${routes6}`);
      // A dual-stack name connects at once either way (no IPv6 route: "network unreachable", and curl uses IPv4).
      const connect = (await run("curl -s -m 30 -o /dev/null -w '%{time_connect} %{remote_ip}\\n' http://deb.debian.org/debian/", 60_000)).trim().split('\n')[0];
      console.log(`# curl deb.debian.org: connected in ${connect.split(' ')[0]} s to ${connect.split(' ')[1]}`);
      assert.ok(Number(connect.split(' ')[0]) < 5, `connected without waiting on IPv6: ${connect}`);
      if (!reach6) {
        const t = Date.now();
        const v6 = await run('curl -s -m 20 -o /dev/null -w "%{exitcode}\\n" "http://[2606:4700:4700::1111]/"; true', 60_000);
        assert.match(v6, /^7$/m, `IPv6 to the internet fails at once (couldn't connect): ${v6}`);
        assert.ok(Date.now() - t < 10_000, 'at once');
      }

      const apt = await run('timeout 240 apt-get update -o Acquire::Retries=0 >/tmp/apt.log 2>&1; echo "exit $?"; tail -3 /tmp/apt.log', 300_000);
      assert.match(apt, /exit 0/, apt);
    } finally {
      await removeOverlay();
      await page.context().close();
    }
  });
});

// A room on a second adapter beside the local helper (docs/networking/rooms.md "Tests", docs/networking/adapters.md §4):
// tests/browser/adapters.html with card 1 on the helper and card 2 in a room on the tailcat rig's derper and the tests'
// Nostr relay, whose other member is tests/browser/room.html in another context. The helper's adapter is the primary
// (`primaryOf`), so the defaults stay its own and the room's adds only its /48 and its names: the guest reaches the room's
// member by name (UDP to its echo port, through the room's resolver) while names and TCP still go out through the helper.
// Opt-in also with WAARM64_TAILCAT=1 (Go builds derper). One Debian boot, ~2 min.
const roomSkip = skip ?? (process.env.WAARM64_TAILCAT !== '1' ? 'SKIPPED: set WAARM64_TAILCAT=1 too (the tailcat rig\'s derper)'
  : !existsSync(`${ROOT}target/net/ts.wasm`) ? 'SKIPPED: no target/net/ts.wasm (net/ts/build.sh)' : undefined);
test('a room on a second adapter beside the local helper: the member by name, the internet through the helper', { skip: roomSkip, timeout: 900_000 }, async () => {
  const rig = `${ROOT}tests/net/tailcat.sh`;
  execFileSync(rig, ['up'], { encoding: 'utf8', timeout: 300_000 });
  const nostr = await startNostrRelay();
  const overlay = `${OVERLAY}-room`;
  const id = `beside-${randomBytes(4).toString('hex')}`;
  const link = `waarm64-room:${encodeURIComponent(id)}?nostr=${encodeURIComponent(nostr.url)}&derp=${encodeURIComponent(RIG_RELAY)}`;
  try {
    const restore = await debianFixture(browser, base, 'ports2');
    await withDebianLock(async () => {
      const ctx = await browser.newContext({ ignoreHTTPSErrors: true }); // the rig's derper's self-signed certificate
      const memberCtx = await browser.newContext({ ignoreHTTPSErrors: true });
      const page = await ctx.newPage();
      page.on('console', (m) => { if (/rror|panic/.test(m.text())) console.log(`# page: ${m.text().slice(0, 300)}`); });
      type View = { phase: string; text: string; address?: string; internet?: boolean; local?: boolean; room?: { name: string } };
      const views = () => harness<View[]>(page, 'views()');
      const context = async () => `; the adapters: ${JSON.stringify(await views().catch(() => undefined))}\n# helper:\n${helperLog}`;
      const run = (cmd: string, ms = 60_000) => runIn(page, cmd, ms, context);
      const until = async (what: string, cmd: string, ok: (s: string) => boolean, ms: number) => {
        const t0 = Date.now();
        let out = await run(cmd);
        while (!ok(out) && Date.now() - t0 < ms) {
          await page.waitForTimeout(1000);
          out = await run(cmd);
        }
        assert.ok(ok(out), `${what} after ${ms / 1000} s:\n${out}${await context()}`);
        return out;
      };
      try {
        const member = await memberCtx.newPage();
        await member.goto(`${base}/tests/browser/room.html?${new URLSearchParams({ room: id, relay: RIG_RELAY, nostr: nostr.url })}`);
        await member.waitForFunction(() => (window as never as { harness: { room(): { state: string } } }).harness.room().state === 'Running', null, { timeout: 60_000, polling: 250 }); // i18n-ignore
        const memberName = (await member.evaluate('window.harness.room().self') as { name: string }).name;

        await page.goto(`${base}/tests/browser/core.html`);
        await page.evaluate(async (n) => (await navigator.storage.getDirectory()).removeEntry(n, { recursive: true }).catch(() => {}), overlay);
        await page.goto(`${base}/tests/browser/adapters.html?${new URLSearchParams({ ...(restore ? { restore } : {}), local: ws, room: link, overlay })}`);
        await page.waitForFunction(() => (window as never as { harness: { views(): { phase: string }[] } }).harness.views().every((v) => v.phase === 'connected'), null, { timeout: 120_000, polling: 250 })
          .catch(async (e) => { throw new Error(`${e}${await context()}`); });
        const [lv, rv] = await views();
        assert.deepEqual([lv.local, lv.internet, rv.internet], [true, true, false], `the helper's reaches the internet, the room's doesn't${await context()}`);
        assert.equal(await harness<number>(page, 'primary()'), 0, "the helper's adapter is the primary");
        assert.match(rv.room?.name ?? '', /\.p2p\.internal$/, 'the room gave the machine its name');
        await loginRoot(page, 240_000, context);

        await until("both leases: the helper's IPv4, the room's IPv6", "ip -o addr show scope global | awk '{print $2, $4}'",
          (s) => /192\.168\.127\.\d+\//.test(s) && s.includes(`${rv.address!.split('/')[0]}/`), 90_000);
        const room48 = rv.address!.split(':').slice(0, 3).join(':');
        const routes = await until("the defaults through the helper's card, the room's /48 through the room's", 'ip -4 route; ip -6 route',
          (s) => /^default via 192\.168\.127\.1 /m.test(s) && new RegExp(`^${room48}::/48 `, 'm').test(s), 60_000);
        const roomDev = /^\d+: (\S+) /m.exec(await run(`ip -o -6 addr show to ${rv.address!.split('/')[0]}`))?.[1];
        assert.ok(roomDev, "the room's card");
        assert.doesNotMatch(routes, new RegExp(`^default .*dev ${roomDev} `, 'm'), `no default through the room's card: ${routes}`);
        console.log(`# guest: ${routes.trim().replace(/\n/g, ' | ')}`);

        // The member by its name (the room's resolver, through systemd-resolved's routing domain), UDP to its echo port,
        // resent each second until the lookup's call back lets the first through; and at once a page from this machine's
        // server and a name from the helper's resolver.
        const echo = await run(`for i in $(seq 30); do exec 3<>/dev/udp/${memberName}/7 || { sleep 1; continue; }; printf hello >&3; if timeout 1 head -c 5 <&3; then echo " back after $i"; break; fi; exec 3>&-; done`, 90_000);
        assert.match(echo, /hello back after \d+/, `the room's member by name: ${echo}; ${await run(`resolvectl query ${memberName}; resolvectl status --no-pager | head -30`)}${await context()}`);
        console.log(`# the member's echo: ${echo.trim()}`);
        assert.match(await run(`curl -s -m 20 http://192.168.127.254:${filesPort}/`, 60_000), /hello from the host/, "this machine through the helper");
        const name = await run('getent ahostsv4 deb.debian.org | head -1', 30_000);
        assert.match(name, /^\d+\.\d+\.\d+\.\d+\s/m, `deb.debian.org through the helper's DNS beside the room's: ${name}`);
        const apt = await run('timeout 240 apt-get update -o Acquire::Retries=0 >/tmp/apt.log 2>&1; echo "exit $?"; tail -3 /tmp/apt.log', 300_000);
        assert.match(apt, /exit 0/, apt);
        const peers = await member.evaluate('window.harness.room().peers') as unknown[];
        assert.equal(peers.length, 1, 'the member reached the guest');
      } finally {
        await page.evaluate(async (n) => (await navigator.storage.getDirectory()).removeEntry(n, { recursive: true }).catch(() => {}), overlay).catch(() => {});
        await ctx.close();
        await memberCtx.close();
      }
    });
  } finally {
    await nostr.close();
    spawnSync(rig, ['down']);
  }
});
