// IPv6 through the local helper on hosts that have it (docs/plans/networking-local.md §5, L0; bench/net/REPORT.md "The
// local helper"). Debian on the page in the dev VM, which has no IPv6 of its own, so one of two rigs:
//   node bench/net/local-ipv6.ts mac <out.json>      the helper on the Mac (cross-built here, kept in ~/webpc-net-test
//                                                    there) over an ssh tunnel: the Mac's real IPv6, curl and apt over it
//   unshare -Urn node bench/net/local-ipv6.ts netns <out.json>
//                                                    everything in a new network namespace whose "internet" is a dummy
//                                                    interface holding the helper's probe target: the reach really goes
//                                                    (the address is removed) and comes back under a running guest
// One Debian boot each. Build target/net/webpc-net first for netns (tests/webpc-net.ts `buildHelper`), which has no network for the toolchain.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { startServer } from '../../tools/serve.ts';
import { withDebianLock } from '../../tests/debian-lock.ts';
import { loginRoot, run as runIn } from '../../tests/serial-console.ts';
import { helperSource } from '../../tests/webpc-net.ts';

const helperDir = () => {
  const s = helperSource();
  if ('skip' in s) throw new Error(s.skip);
  return s.dir;
};

const ROOT = new URL('../../', import.meta.url).pathname;
const [mode, out] = process.argv.slice(2);
const PORT = 18743;
const MAC = 'macmini.lan';
const PROBE = '2606:4700:4700::1111';
const ip = (...a: string[]) => execFileSync('ip', a, { stdio: 'inherit' });

const log = (s: string) => console.log(`# ${s}`);
const result: Record<string, unknown> = { date: new Date().toISOString(), mode };
const token = randomBytes(32).toString('base64url');
const procs: ChildProcess[] = [];
const server = await startServer();
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const http = createServer((_, res) => res.end('hello over IPv6\n'));

async function rig() {
  if (mode === 'mac') {
    execFileSync('go', ['build', '-trimpath', '-o', `${ROOT}target/net/webpc-net-darwin-arm64`, '.'], { cwd: helperDir(), env: { ...process.env, GOOS: 'darwin', GOARCH: 'arm64', CGO_ENABLED: '0' }, stdio: 'inherit', timeout: 300_000 });
    execFileSync('ssh', [MAC, 'mkdir -p webpc-net-test']);
    execFileSync('scp', ['-q', `${ROOT}target/net/webpc-net-darwin-arm64`, `${MAC}:webpc-net-test/webpc-net`]);
    // Another port there: Lima forwards the VM's loopback ports to the Mac's.
    const h = spawn('ssh', ['-tt', '-L', `${PORT}:127.0.0.1:${PORT + 10}`, MAC, `WEBPC_NET_TOKEN=${token} exec webpc-net-test/webpc-net --listen 127.0.0.1:${PORT + 10} --origin ${base}`], { stdio: ['pipe', 'pipe', 'pipe'] });
    procs.push(h);
    return h;
  }
  ip('link', 'set', 'lo', 'up');
  ip('link', 'add', 'd0', 'type', 'dummy');
  ip('link', 'set', 'd0', 'up');
  ip('-6', 'addr', 'add', `${PROBE}/128`, 'dev', 'd0', 'nodad');
  const dns = createSocket('udp6');
  dns.on('message', (m, from) => {
    if (m.length < 12) return;
    m[2] |= 0x80; // QR: an answer
    dns.send(m, from.port, from.address);
  });
  await new Promise<void>((r) => dns.bind(53, PROBE, r));
  dns.on('error', () => {});
  await new Promise<void>((r) => http.listen(8086, PROBE, r));
  const h = spawn(`${ROOT}target/net/webpc-net`, ['--listen', `127.0.0.1:${PORT}`, '--origin', base], { env: { ...process.env, WEBPC_NET_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(h);
  return h;
}

const helper = await rig();
let helperLog = '';
const add = (d: Buffer) => { helperLog += d; if (mode === 'netns') process.stdout.write(`[${new Date().toISOString().slice(14, 19)}] ${d}`); };
helper.stdout!.on('data', add);
helper.stderr!.on('data', add);
for (let k = 0; k < 150 && !helperLog.includes('listening on'); k++) await new Promise((r) => setTimeout(r, 100));
if (!helperLog.includes('listening on')) throw new Error(`the helper didn't start: ${helperLog}`);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
const overlay = 'webpc-net-ipv6';
const removeOverlay = (page: Page) => page.evaluate(async (n) => (await navigator.storage.getDirectory()).removeEntry(n, { recursive: true }).catch(() => {}), overlay).catch(() => {});

/** Polls the guest until `default` in its IPv6 routes is `want`; the seconds that took. */
async function followDefault(run: (c: string, ms?: number) => Promise<string>, page: Page, want: boolean, ms: number) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await run('ip -6 route show default');
    if (/^default/m.test(r) === want) return (Date.now() - t0) / 1000;
    await page.waitForTimeout(1000);
  }
  throw new Error(`the guest's IPv6 default isn't ${want ? 'there' : 'gone'} after ${ms / 1000} s\n${helperLog.slice(-1500)}`);
}

let code = 0;
try {
  await withDebianLock(async () => {
    const page = await (await browser.newContext()).newPage();
    try {
      await page.goto(`${base}/tests/browser/core.html`);
      await removeOverlay(page);
      await page.goto(`${base}/tests/browser/netguest.html?${new URLSearchParams({ overlay, port: '1' })}`);
      await page.evaluate((u) => (window as unknown as { harness: { connectLocal(u: string): void } }).harness.connectLocal(u), `ws://127.0.0.1:${PORT}/${token}`);
      await loginRoot(page, 240_000, async () => `\n${helperLog.slice(-1000)}`);
      const run = (c: string, ms = 60_000) => runIn(page, c, ms, async () => `\n${helperLog.slice(-1000)}`);
      for (let k = 0; k < 60 && !(await run('ip -4 -o route show default')).trim(); k++) await page.waitForTimeout(1000);
      result.addresses = (await run('ip -6 -o addr show scope global')).trim();
      const first = await followDefault(run, page, true, 90_000);
      result.defaultAfter = first;
      result.route = (await run('ip -6 route show default')).trim();
      log(`default route ${first} s after the lease: ${result.route}`);
      if (mode === 'mac') {
        await page.waitForTimeout(40_000); // idle past Linux's neighbor check: the default stays
        assert.match(await run('ip -6 route show default'), /^default/m, 'the default survives the guest pausing');
        result.curl = (await run("curl -6 -s -m 30 -o /dev/null -w '%{http_code} %{remote_ip} connect %{time_connect} total %{time_total}\\n' http://deb.debian.org/debian/", 45_000)).trim();
        result.curlTls = (await run("curl -6 -s -m 30 -o /dev/null -w '%{http_code} %{remote_ip} connect %{time_connect}\\n' https://www.cloudflare.com/", 45_000)).trim();
        result.dual = (await run("curl -s -m 30 -o /dev/null -w '%{remote_ip} connect %{time_connect}\\n' http://deb.debian.org/debian/", 45_000)).trim();
        await page.waitForTimeout(40_000); // and after traffic, when the check actually comes
        assert.match(await run('ip -6 route show default'), /^default/m, 'the default survives a pause after traffic');
        result.apt = (await run('timeout 240 apt-get update -o Acquire::Retries=0 -o Acquire::ForceIPv6=true >/tmp/apt.log 2>&1; echo "exit $?"; tail -3 /tmp/apt.log', 280_000)).trim();
        log(JSON.stringify(result));
        if (!/^200 2/.test(result.curl as string) || !/exit 0/.test(result.apt as string)) code = 1;
      } else {
        result.curl = (await run(`curl -s -m 10 -w ' %{remote_ip}\\n' http://[${PROBE}]:8086/`)).trim();
        log(`${result.curl}`);
        // Idle past Linux's neighbor check (reachable 30 s, a 5 s delay): the default stays (the Router flag).
        await page.waitForTimeout(40_000);
        assert.match(await run('ip -6 route show default'), /^default/m, 'the default survives the guest pausing');
        log(`[${new Date().toISOString().slice(14, 19)}] removing the probe's address`);
        ip('-6', 'addr', 'del', `${PROBE}/128`, 'dev', 'd0');
        result.goneAfter = await followDefault(run, page, false, 100_000);
        log(`[${new Date().toISOString().slice(14, 19)}] reach lost: the default went in ${result.goneAfter} s`);
        log(await run('ip -6 route; journalctl -u systemd-networkd -n 12 --no-pager -o short-precise | cut -c8-110; date'));
        result.whileOut = (await run(`curl -s -m 20 -o /dev/null -w '%{exitcode} in %{time_total} s\\n' http://[${PROBE}]:8086/; true`)).trim();
        log(`curl while out: ${result.whileOut}`);
        ip('-6', 'addr', 'add', `${PROBE}/128`, 'dev', 'd0', 'nodad');
        log(`[${new Date().toISOString().slice(14, 19)}] the address is back`);
        result.backAfter = await followDefault(run, page, true, 100_000).catch(async (e) => { log(await run('ip -6 route; journalctl -u systemd-networkd -n 12 --no-pager -o short-precise | cut -c8-110; date')); throw e; });
        log(`reach back: the default came in ${result.backAfter} s`);
      }
    } finally {
      await removeOverlay(page);
      await page.context().close();
    }
  });
} catch (e) {
  code = 1;
  console.error(String(e));
  result.error = String(e).slice(0, 800);
}
result.helperLog = helperLog.replaceAll(token, '<token>').split('\n').filter((l) => /IPv6 to the internet|listening/.test(l)).map((l) => l.trim());
mkdirSync(dirname(join(ROOT, out)), { recursive: true });
writeFileSync(join(ROOT, out), JSON.stringify(result, null, 1));
await browser.close();
for (const p of procs) p.kill();
server.close();
http.close();
process.exit(code);
