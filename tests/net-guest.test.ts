// The page's Debian with a network card, without a tailnet (docs/frontend.md "Network"): the
// command line the page uses for a machine with a card (web/app/machine.ts `network`) on the
// Ethernet gateway with its synchronous echo backend (lease 198.18.0.15, answers pings to any
// address). Nobody sets the guest up: systemd-networkd takes a .network file from a credential on the
// command line and takes the gateway's lease, and the guest pings an address that
// exists nowhere and its router. It also checks that the units the card needs don't make the
// boot wait for a network that isn't coming (a login prompt inside the boot's usual time), and that three cards each
// get their own lease and router (docs/plans/network-adapters.md §4).
// Realtime, one Debian boot, ~2 min alone. Opt-in with WEBPC_DISTROS=debian, like Debian's
// other Chromium tests.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { withDebianLock } from './debian-lock.ts';
import { loginRoot, run } from './serial-console.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const skip = process.env.WEBPC_NET_TESTS !== '1' ? 'SKIPPED: scripts/ci-net.sh runs it (WEBPC_NET_TESTS=1)'
  : !(process.env.WEBPC_DISTROS ?? '').split(',').includes('debian') ? 'SKIPPED: set WEBPC_DISTROS=debian'
  : !existsSync(`${ROOT}target/images/debian/disk.qcow2`) || !existsSync(`${ROOT}target/images/edk2/QEMU_EFI.fd`) ? 'SKIPPED: run images/build.sh debian edk2'
  : undefined;

const OVERLAY = 'webpc-net-guest-test';
let browser: Browser;
let base: string;
let closeServer: () => void;
before(async () => {
  if (skip) return;
  const server = await startServer();
  closeServer = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
});
after(async () => {
  await browser?.close();
  closeServer?.();
});

test('the page\'s Debian with a card takes the gateway\'s lease by itself and pings through it', { skip, timeout: 600_000 }, async () => {
  await withDebianLock(async () => {
    const page = await (await browser.newContext()).newPage();
    const removeOverlay = () => page.evaluate(async (n) => (await navigator.storage.getDirectory()).removeEntry(n, { recursive: true }).catch(() => {}), OVERLAY).catch(() => {});
    try {
      await page.goto(`${base}/tests/browser/core.html`); // any page of the origin: a fresh overlay
      await removeOverlay();
      const t0 = Date.now();
      await page.goto(`${base}/tests/browser/netguest.html?overlay=${OVERLAY}`);
      await loginRoot(page);
      console.log(`# login prompt after ${((Date.now() - t0) / 1000).toFixed(0)} s`);

      const addr = (await run(page, "ip -4 -o addr show scope global | awk '{print $2, $4}'")).trim();
      const diag = () => run(page, 'ip -br link; ip -br addr; systemctl is-active systemd-networkd systemd-resolved; networkctl status --no-pager 2>&1 | head -20; journalctl -u systemd-networkd --no-pager 2>&1 | tail -20; cat /run/systemd/network/*.network 2>&1 | head -20; cat /proc/cmdline');
      // The lease can come a moment after the login prompt.
      let got = addr;
      for (let k = 0; k < 30 && !got; k++) {
        await page.waitForTimeout(1000);
        got = (await run(page, "ip -4 -o addr show scope global | awk '{print $2, $4}'")).trim();
      }
      assert.ok(got, `no address after 30 s:\n${await diag()}`);
      assert.match(got, /^e\S+ 198\.18\.0\.15\//, `the echo backend's lease: ${got}`);

      const routes = await run(page, 'ip -4 route');
      assert.match(routes, /default via 169\.254\.0\.1/, routes);
      const other = await run(page, 'ping -c 3 -W 5 100.64.1.2', 90_000); // the echo backend answers for any address
      assert.match(other, /3 packets transmitted, 3 received, 0% packet loss/, other);
      const router = await run(page, 'ping -c 1 -W 5 169.254.0.1'); // the gateway itself
      assert.match(router, /1 packets transmitted, 1 received/, router);
      // IPv6 (N6): the address comes from DHCPv6 after the router advertisement, the default route from the advertisement
      const v6 = async () => (await run(page, "ip -6 -o addr show scope global | awk '{print $4}'")).match(/fd00:5eb0::f\/128/)?.[0] ?? '';
      let got6 = await v6();
      for (let k = 0; k < 30 && !got6; k++) {
        await page.waitForTimeout(1000);
        got6 = await v6();
      }
      assert.ok(got6, `no IPv6 address after 30 s:\n${await diag()}\n${await run(page, 'ip -6 route; ip -6 -br addr')}`);
      const routes6 = await run(page, 'ip -6 route');
      assert.match(routes6, /default (nhid \d+ )?via fe80::77:65ff:fe62:7063 dev e\S+ proto ra/, routes6);
      const other6 = await run(page, 'ping -6 -c 3 -W 5 fd7a:115c:a1e0::2', 90_000); // the echo backend answers for any address
      assert.match(other6, /3 packets transmitted, 3 received, 0% packet loss/, other6);
      const router6 = await run(page, 'ping -6 -c 1 -W 5 fe80::77:65ff:fe62:7063%eth0'); // the gateway itself
      assert.match(router6, /1 packets transmitted, 1 received/, router6);
      assert.match(await run(page, 'resolvectl dns 2>&1 | cat'), /fd00:5eb0::53/, 'the DHCPv6 and RA resolver');
      const dns = await run(page, 'resolvectl status 2>&1 | head -20');
      console.log(`# resolved: ${dns.trim().replace(/\n/g, ' | ')}`);
    } finally {
      await removeOverlay();
      await page.context().close();
    }
  });
});

// Several adapters (docs/plans/network-adapters.md §4, L1): each card has its own gateway (MAC and address) and its own
// echo lease, and the guest reaches each gateway through its own interface.
test('three adapters, each on its own gateway and lease', { skip, timeout: 600_000 }, async () => {
  await withDebianLock(async () => {
    const page = await (await browser.newContext()).newPage();
    const removeOverlay = () => page.evaluate(async (n) => (await navigator.storage.getDirectory()).removeEntry(n, { recursive: true }).catch(() => {}), OVERLAY).catch(() => {});
    try {
      await page.goto(`${base}/tests/browser/core.html`);
      await removeOverlay();
      await page.goto(`${base}/tests/browser/netguest.html?overlay=${OVERLAY}&adapters=3`);
      await loginRoot(page);
      const addrs = () => run(page, "ip -4 -o addr show scope global | awk '{print $2, $4}' | sort").then((s) => [...s.matchAll(/^(e\S+) (198\.18\.0\.\d+)\/\d+$/gm)].map((x) => `${x[1]} ${x[2]}`));
      let got = await addrs();
      for (let k = 0; k < 40 && got.length < 3; k++) {
        await page.waitForTimeout(1000);
        got = await addrs();
      }
      const links = await run(page, 'ip -br link');
      assert.equal(got.length, 3, `three leases: ${got.join(', ')}\n${links}`);
      // In slot order: the first card is the first interface, with the first lease.
      const byLease = new Map(got.map((g) => [g.split(' ')[1], g.split(' ')[0]]));
      assert.deepEqual([...byLease.keys()].sort(), ['198.18.0.15', '198.18.0.16', '198.18.0.17']);
      for (const [n, mac] of ['56', '57', '58'].entries()) {
        const dev = byLease.get(`198.18.0.${15 + n}`)!;
        assert.match(await run(page, `cat /sys/class/net/${dev}/address`), new RegExp(`52:54:00:12:34:${mac}`), `${dev} is card ${n + 1}`);
        const routes = await run(page, `ip -4 route show dev ${dev}`);
        assert.match(routes, new RegExp(`default via 169\\.254\\.0\\.${n + 1}`), `${dev}: its own router: ${routes}`);
        const router = await run(page, `ping -c 1 -W 5 -I ${dev} 169.254.0.${n + 1}`); // that card's gateway
        assert.match(router, /1 packets transmitted, 1 received/, `${dev}: ${router}`);
        assert.match(await run(page, `ip neigh show 169.254.0.${n + 1} dev ${dev}`), new RegExp(`02:77:65:62:70:${(0x63 + n).toString(16)}`), `${dev}: its gateway's own MAC`);
      }
    } finally {
      await removeOverlay();
      await page.context().close();
    }
  });
});

// Routes over several adapters (docs/plans/network-adapters.md §4, L2): the primary's gateway is the default router; the
// other's gives only its network's routes (option 121 without a default, a router advertisement with lifetime 0 and a
// Route Information option). Made the other the primary, IPv6 moves at once and IPv4 at the next renewal (every 10 s:
// `SEVERAL_ADAPTERS`; the times are printed, and IPv4's bounded at 45 s, for a loaded machine).
test('two adapters: the default route through the primary only, the other for its network; it moves when the primary does', { skip, timeout: 600_000 }, async () => {
  await withDebianLock(async () => {
    const page = await (await browser.newContext()).newPage();
    const removeOverlay = () => page.evaluate(async (n) => (await navigator.storage.getDirectory()).removeEntry(n, { recursive: true }).catch(() => {}), OVERLAY).catch(() => {});
    try {
      await page.goto(`${base}/tests/browser/core.html`);
      await removeOverlay();
      await page.goto(`${base}/tests/browser/netguest.html?overlay=${OVERLAY}&ports=2`);
      await page.evaluate(() => (window as never as { harness: { primary(k: number): void } }).harness.primary(0));
      await loginRoot(page);
      const until = async (what: string, cmd: string, ok: (s: string) => boolean, ms: number) => {
        const t0 = Date.now();
        let out = await run(page, cmd);
        while (!ok(out) && Date.now() - t0 < ms) {
          await page.waitForTimeout(1000);
          out = await run(page, cmd);
        }
        assert.ok(ok(out), `${what} after ${ms / 1000} s:\n${out}`);
        return (Date.now() - t0) / 1000;
      };
      const devOf = async (addr: string) => /^(\S+) /m.exec(await run(page, `ip -4 -o addr show to ${addr} | awk '{print $2, $4}'`))?.[1] ?? '';
      await until('two leases', "ip -4 -o addr show scope global", (s) => /198\.18\.0\.15\//.test(s) && /198\.18\.0\.16\//.test(s), 60_000);
      const [a, b] = [await devOf('198.18.0.15'), await devOf('198.18.0.16')];
      assert.ok(a && b && a !== b, `${a} ${b}`);
      const v4 = () => run(page, 'ip -4 route');
      const v6 = () => run(page, 'ip -6 route');
      const r4 = await v4();
      assert.match(r4, new RegExp(`default via 169\\.254\\.0\\.1 dev ${a}`), r4);
      assert.doesNotMatch(r4, /default via 169\.254\.0\.2/, r4);
      assert.match(r4, new RegExp(`100\\.64\\.0\\.0/10 via 169\\.254\\.0\\.2 dev ${b}`), r4);
      await until("IPv6: the primary's default, the other's /48", 'ip -6 route', (s) => new RegExp(`default (nhid \\d+ )?via fe80::77:65ff:fe62:7063 dev ${a}`).test(s) && new RegExp(`fd7a:115c:a1e0::/48 (nhid \\d+ )?via fe80::77:65ff:fe62:7064 dev ${b}`).test(s), 60_000);
      assert.doesNotMatch(await v6(), /default .*fe62:7064/, 'no IPv6 default through the other');
      // The other becomes the primary (the first lost its way out).
      await page.evaluate(() => (window as never as { harness: { primary(k: number): void } }).harness.primary(1));
      const t6 = await until('IPv6 default moved', 'ip -6 route', (s) => new RegExp(`default (nhid \\d+ )?via fe80::77:65ff:fe62:7064 dev ${b}`).test(s) && !/default .*fe62:7063/.test(s), 60_000);
      const t4 = await until('IPv4 default moved', 'ip -4 route', (s) => new RegExp(`default via 169\\.254\\.0\\.2 dev ${b}`).test(s) && !/default via 169\.254\.0\.1 /.test(s), 45_000);
      console.log(`# the default route moved: IPv6 in ${t6.toFixed(0)} s, IPv4 in ${t4.toFixed(0)} s (at the lease's renewal)`);
      assert.match(await v4(), new RegExp(`100\\.64\\.0\\.0/10 via 169\\.254\\.0\\.1 dev ${a}`), 'the first now gives its network only');
    } finally {
      await removeOverlay();
      await page.context().close();
    }
  });
});

// The page's card is there from the boot, and the client connects later (the Network menu): the
// gateway has no lease until then. How long the guest takes to notice one that arrives late is
// networkd's DHCP retry schedule; the test reports it and bounds it.
test('a lease that arrives after the boot is taken by the guest without a restart', { skip, timeout: 600_000 }, async () => {
  await withDebianLock(async () => {
    const page = await (await browser.newContext()).newPage();
    const removeOverlay = () => page.evaluate(async (n) => (await navigator.storage.getDirectory()).removeEntry(n, { recursive: true }).catch(() => {}), OVERLAY).catch(() => {});
    try {
      await page.goto(`${base}/tests/browser/core.html`);
      await removeOverlay();
      await page.goto(`${base}/tests/browser/netguest.html?overlay=${OVERLAY}&port=1`);
      await loginRoot(page);
      // (An empty output leaves the shell's echo of the markers in what `run` returns: look for an address.)
      const addr = () => run(page, "ip -4 -o addr show scope global | awk '{print $4}'").then((s) => /\d+\.\d+\.\d+\.\d+\/\d+/.exec(s)?.[0] ?? '');
      assert.equal(await addr(), '', 'no lease yet: no address');
      assert.match(await run(page, 'ip -br link show'), /^eth0 /m, 'the card is there');
      // The boot's own DHCP attempts have gone unanswered for a while; then the client "connects".
      await page.waitForTimeout(20_000);
      await page.evaluate(() => (window as never as { harness: { lease(): void } }).harness.lease());
      const t0 = Date.now();
      // (both families, one loop: the IPv6 address needs the advertisement the lease triggers)
      const addr6 = () => run(page, "ip -6 -o addr show scope global | awk '{print $4}'").then((s) => /fd00:5eb0::f\/128/.exec(s)?.[0] ?? '');
      let got = '';
      let got6 = '';
      let took6 = 0;
      while ((!got || !got6) && Date.now() - t0 < 180_000) {
        await page.waitForTimeout(1000);
        got ||= await addr();
        if (!got6 && (got6 = await addr6())) took6 = (Date.now() - t0) / 1000;
      }
      const took = (Date.now() - t0) / 1000;
      console.log(`# the guest took a lease that arrived late: IPv6 address after ${took6 ? took6.toFixed(0) : 'never'} s, both after ${took.toFixed(0)} s`);
      assert.match(got, /^198\.18\.0\.15\//, `no address ${took.toFixed(0)} s after the lease`);
      assert.ok(got6, 'the late lease brought an IPv6 address too');
    } finally {
      await removeOverlay();
      await page.context().close();
    }
  });
});
