// The page's Debian with a network card, without a tailnet (docs/frontend.md "Network"): the
// command line the page uses for a machine with a card (web/app/machine.ts `network`) on the
// Ethernet gateway with its synchronous echo backend (lease 198.18.0.15, answers pings to any
// address). Nobody sets the guest up: systemd-networkd takes a .network file from a credential on the
// command line and takes the gateway's lease, and the guest pings an address that
// exists nowhere and its router. It also checks that the units the card needs don't make the
// boot wait for a network that isn't coming (a login prompt inside the boot's usual time).
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
const skip = !(process.env.WEBPC_DISTROS ?? '').split(',').includes('debian') ? 'SKIPPED: set WEBPC_DISTROS=debian'
  : !existsSync(`${ROOT}target/images/debian/Image`) ? 'SKIPPED: run tools/debian.ts (or npm start)'
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
      const dns = await run(page, 'resolvectl status 2>&1 | head -20');
      console.log(`# resolved: ${dns.trim().replace(/\n/g, ' | ')}`);
    } finally {
      await removeOverlay();
      await page.context().close();
    }
  });
});
