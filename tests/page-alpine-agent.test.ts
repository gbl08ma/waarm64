// The guest agent on Alpine (DEMO-KICKOFF.md decision 14; docs/devices.md "The guest's agent", "On OpenRC"), on the
// page through the local helper (its DHCP, and TCP to this machine's loopback: tests/net-local.test.ts): Alpine's
// published UEFI cloud image, unmodified (root unlocked by a NoCloud seed disk, as tests/uefi.test.ts does), as a
// stored machine whose card is attached to the helper. Under `?ready=guest` the machine stays `booting` past its login
// prompt (no READY=1 on OpenRC) until the agent's HELLO, which comes once root runs the installer the machine gives over
// fw_cfg (`opt/waarm64/openrc`): the OpenRC service, at once and at each boot. The guest's clock is then set back
// months (a template's is old) and a CA of the test's own trusted: `apk` over TLS to this machine fails ("not yet
// valid"). A snapshot of it, flagged as a template, makes a machine in a fresh profile (web/app/template.ts, the demos'
// path), attached to the helper again, whose first start restores it: the agent connects again, the clock is right,
// the page's LEASE renews dhcpcd's lease (`dhcpcd -n`, `body[data-lease]` = agent), `apk` over TLS reaches this machine;
// then the card handed to udhcpc (the alpine-demo image's client) and LEASE asked again: busybox's renew (SIGUSR1);
// and POWER through busybox's poweroff.
// ~4 min; needs Go (the helper), openssl, images/build.sh alpine-uefi edk2 agent. Opt-in with the network tests:
// scripts/ci-net.sh.
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, openAsBlob, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createServer as createHttps } from 'node:https';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { chromiumEnv } from '../tools/nosme.ts';
import { fatImage } from '../web/fat.ts';
import { asTemplate } from '../web/snapshot-file.ts';
import { answerAsks } from './page-ask.ts';
import { buildHelper, helperSkip } from './waarm64-net.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const IMAGE = 'target/images/alpine-uefi/alpine.qcow2';
const SEED = 'target/tests/alpine-agent/seed.img'; // served by the dev server, as the image is
const SNAP = 'target/tests/alpine-agent/template.waarm64snap';
const has = (p: string) => existsSync(join(ROOT, p));
const skip = process.env.WAARM64_NET_TESTS !== '1' ? 'SKIPPED: scripts/ci-net.sh runs it (WAARM64_NET_TESTS=1)'
  : !has(IMAGE) || !has('target/images/edk2/QEMU_EFI.fd') || !has('target/images/agent/waarm64-agent.gz') ? 'SKIPPED: run images/build.sh alpine-uefi edk2 agent'
  : helperSkip();
/** The host as the helper's guests reach it (--host-loopback), and the name the guest knows it by (its /etc/hosts):
 * apk's TLS checks a certificate's DNS names, not its IP addresses. */
const HOST = '192.168.127.254';
const NAME = 'waarm64-host.test';
/** The clock the template is left at: months before the test's certificate. */
const OLD = '2025-01-01 00:00:00';

let browser: Browser;
let base: string;
let closeServer: () => void;
let helper: ChildProcess | undefined;
let helperLog = '';
let ws: string;
let files: Server;
let filesPort: number;
let tls: Server;
let tlsPort: number;
let dir: string;
/** The paths the TLS server was asked for: a request means a handshake the guest's apk took. */
const asked: string[] = [];

const freePort = () => new Promise<number>((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const p = (s.address() as AddressInfo).port;
    s.close(() => resolve(p));
  });
});

before(async () => {
  if (skip) return;
  buildHelper();
  dir = mkdtempSync(join(tmpdir(), 'waarm64-alpine-agent-'));
  // A certificate of the test's own for the host's address, valid from now: the guest trusts it as a CA.
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2', '-subj', '/CN=waarm64 test',
    '-addext', `subjectAltName=DNS:${NAME}`, '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'pipe' });
  const cert = readFileSync(join(dir, 'cert.pem'));
  tls = createHttps({ key: readFileSync(join(dir, 'key.pem')), cert }, (req, res) => {
    asked.push(req.url ?? '');
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => tls.listen(0, '127.0.0.1', r));
  tlsPort = (tls.address() as AddressInfo).port;
  // Plain HTTP for the CA's way in.
  files = createServer((_, res) => res.end(cert));
  await new Promise<void>((r) => files.listen(0, '127.0.0.1', r));
  filesPort = (files.address() as AddressInfo).port;
  mkdirSync(join(ROOT, 'target/tests/alpine-agent'), { recursive: true });
  writeFileSync(join(ROOT, SEED), fatImage('CIDATA', [{ name: 'meta-data', data: 'instance-id: waarm64-agent\nlocal-hostname: alpine\n' }, { name: 'user-data', data: '#!/bin/sh\npasswd -d root\n' }]));
  const server = await startServer();
  closeServer = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const port = await freePort();
  const token = randomBytes(32).toString('base64url');
  ws = `ws://127.0.0.1:${port}/${token}`;
  helper = spawn(`${ROOT}target/net/waarm64-net`, ['--listen', `127.0.0.1:${port}`, '--origin', base, '--host-loopback'], { env: { ...process.env, WAARM64_NET_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
  helper.stdout!.on('data', (d) => { helperLog += d; });
  helper.stderr!.on('data', (d) => { helperLog += d; });
  for (let k = 0; k < 100 && !helperLog.includes('listening on'); k++) await new Promise((r) => setTimeout(r, 100));
  assert.match(helperLog, /listening on/, `the helper didn't start: ${helperLog}`);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', env: chromiumEnv() });
});
after(async () => {
  await browser?.close();
  closeServer?.();
  files?.close();
  tls?.close();
  helper?.kill();
  if (dir) rmSync(dir, { recursive: true, force: true });
  rmSync(join(ROOT, 'target/tests/alpine-agent'), { recursive: true, force: true });
});

const terminal = (page: Page) => page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '');
const shows = (page: Page, re: RegExp, ms = 60_000) =>
  page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.xterm-rows')?.textContent ?? ''), re.source, { timeout: ms, polling: 100 })
    .catch(async (e) => { throw new Error(`${e}; the terminal shows: ${await terminal(page)}`); });
async function onSerial(page: Page, text: string) {
  await page.locator('.xterm').click();
  await page.keyboard.type(text, { delay: 5 });
}
let runs = 0;
/** Runs `cmd` on the serial shell: its output on one line, between markers of its own. */
async function run(page: Page, cmd: string, ms = 60_000) {
  const re = new RegExp(`<<${++runs}:([^<>]*)>>`);
  await onSerial(page, `clear; echo "<<${runs}:$({ ${cmd}; } 2>&1 | tr '\\n<>' ' []')>"">"\n`);
  await shows(page, re, ms);
  return re.exec(await terminal(page))![1].trim();
}
const state = (page: Page) => page.evaluate(() => document.body.dataset.state);
const agentUp = (page: Page, ms = 120_000) =>
  page.waitForFunction(() => !!(window as unknown as { __agent?: { agent?: unknown } }).__agent?.agent, null, { timeout: ms, polling: 200 });
/** What apk makes of the test's repository over TLS (its index: the server answers 404, past the handshake). */
const apk = (page: Page) => run(page, `apk --repositories-file /dev/null --repository https://${NAME}:${tlsPort}/alpine/main update 2>&1 | head -3; true`, 90_000);

/** Stored machine `id`'s first adapter attached to a new `local` connection to the helper (what the pairing link's
 * wizard makes; done through the page's code so that nothing starts the machine first). */
const attachHelper = (page: Page, id: string) => page.evaluate(async ([id, ws]) => {
  const { Store } = await import('/web/app/store.ts' as string);
  const { Connections } = await import('/web/app/connections.ts' as string);
  const { setAdapterConnection } = await import('/web/app/machines.ts' as string);
  const store = await Store.open();
  const c = await new Connections(store).create({ kind: 'local', local: { url: ws } });
  await setAdapterConnection(store, id, 0, c.id);
}, [id, ws] as const);

test('the agent on Alpine: installed from fw_cfg, the machine up at its HELLO; a template restored with an old clock gets the clock, its lease renewed (dhcpcd, udhcpc) and apk over TLS', { skip, timeout: 15 * 60_000 }, async () => {
  // The template's profile: the machine made through the page's own code, its card on the helper.
  const maker = await browser.newContext({ acceptDownloads: true });
  const a = await maker.newPage();
  await answerAsks(a);
  await a.goto(`${base}/web/app/`);
  const id = await a.evaluate(async ([image, seed]) => {
    const { Store } = await import('/web/app/store.ts' as string);
    const { attach, createDisk, createMachine } = await import('/web/app/machines.ts' as string);
    const { checkUrl } = await import('/web/app/urlcheck.ts' as string);
    const store = await Store.open();
    const m = await createMachine(store, { name: 'Alpine', ncpus: 2, ramMiB: 512, display: '2d', network: true, usb: false, mouse: false, touch: false, shares: false });
    for (const url of [image, seed]) {
      const c = await checkUrl(url);
      if (!c.ok || !c.head) throw new Error(`${url}: ${JSON.stringify(c.problems)}`);
      const v = new DataView(c.head.buffer, c.head.byteOffset);
      const size = v.getUint32(0) === 0x514649fb ? Number(v.getBigUint64(24)) : c.bytes;
      await attach(store, m, await createDisk(store, { kind: 'url', url, name: c.name, size, bytes: c.bytes }));
    }
    return m.id as string;
  }, [`${base}/${IMAGE}`, `${base}/${SEED}`]);
  await attachHelper(a, id);
  // Only the guest's own signs say it's up (`?ready=guest`): on OpenRC, the agent's HELLO.
  await a.goto(`${base}/web/app/?m=${id}&clocksync=0&ready=guest&view=both`);
  await shows(a, /login: \s*$/, 300_000);
  await a.waitForTimeout(1000);
  assert.equal(await state(a), 'booting', 'no agent yet: the login prompt alone says nothing');
  await onSerial(a, 'root\n');
  await shows(a, /:~# \s*$/);
  const installed = await run(a, 'modprobe qemu_fw_cfg; sh /sys/firmware/qemu_fw_cfg/by_name/opt/waarm64/openrc/raw', 120_000);
  assert.match(installed, /installed and started/, installed);
  await agentUp(a);
  await a.waitForFunction(() => document.body.dataset.state === 'running', null, { timeout: 10_000 });
  assert.equal(await run(a, 'rc-status default | grep -c "waarm64-agent.*started"'), '1', 'in the default runlevel, started');
  const addr = await run(a, "ip -4 -o addr show dev eth0 scope global | awk '{print $4}'");
  assert.match(addr, /^192\.168\.127\.\d+\/\d+$/, `the helper's lease: ${addr}`);
  assert.match(await run(a, 'pgrep -l dhcpcd | head -1'), /dhcpcd/, "the cloud image's client");
  // A template's clock: months old. The test's CA trusted; apk's TLS then fails on the certificate's dates.
  await run(a, `wget -q -O- http://${HOST}:${filesPort}/ >> /etc/ssl/certs/ca-certificates.crt`);
  await run(a, `echo '${HOST} ${NAME}' >> /etc/hosts`);
  // With the boot's clock (the RTC's: right) apk takes the certificate; with a template's, it doesn't (apk says "not
  // trusted" for its dates too).
  const right = await apk(a);
  assert.ok(asked.some((p) => p.endsWith('/APKINDEX.tar.gz')), `apk over TLS with the right clock: ${right}`);
  asked.length = 0;
  await run(a, `date -s '${OLD}' > /dev/null`);
  const before = await apk(a);
  console.log(`# apk with the template's old clock: ${before}`);
  assert.equal(asked.length, 0, `no request with the old clock: ${before}`);
  assert.match(before, /TLS: server certificate not trusted/, before);
  // The link's carrier changes so far: the restore's renewal must not flap it (web/devices.ts `restored`: the card's
  // switch onto the helper's frames holds its flap while the agent's LEASE runs, which a link down would lose).
  const carrier = await run(a, 'cat /sys/class/net/eth0/carrier_changes');
  // The snapshot, kept in the machine and downloaded, flagged as a template; the machine's definition.
  await a.locator('#save-snapshot').click();
  const kept = () => a.evaluate(async (id) => {
    const { Store } = await import('/web/app/store.ts' as string);
    return (await (await Store.open()).all('snapshots')).some((s: { machine: string }) => s.machine === id) as boolean;
  }, id);
  for (const end = Date.now() + 180_000; !(await kept()); await a.waitForTimeout(500)) if (Date.now() > end) throw new Error('the snapshot was not kept');
  const [download] = await Promise.all([
    a.waitForEvent('download', { timeout: 60_000 }),
    a.evaluate(async (id) => {
      const { Store, snapshotPath } = await import('/web/app/store.ts' as string);
      const { opfsDir } = await import('/web/overlay.ts' as string);
      const s = (await (await Store.open()).all('snapshots')).find((x: { machine: string }) => x.machine === id);
      const path: string = snapshotPath(id, s.id);
      const file = await (await (await opfsDir(path.slice(0, path.lastIndexOf('/')))).getFileHandle(s.id)).getFile();
      const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: 'alpine.waarm64snap' });
      document.body.append(link);
      link.click();
    }, id),
  ]);
  const plain = join(dir, 'plain.waarm64snap');
  await download.saveAs(plain);
  const def = await a.evaluate(async (id) => {
    const { Store } = await import('/web/app/store.ts' as string);
    const { exportDefinition } = await import('/web/app/definitions.ts' as string);
    return exportDefinition(await Store.open(), id);
  }, id);
  await maker.close();
  await writeFile(join(ROOT, SNAP), (await asTemplate(await openAsBlob(plain))).stream());

  // A visitor's fresh profile: the machine made from the definition and the template (the demos' click), its card on
  // the helper, its first start the template's restore; the page sets the clock (its default).
  const visitor = await browser.newContext();
  const b = await visitor.newPage();
  await answerAsks(b);
  await b.goto(`${base}/web/app/`);
  const id2 = await b.evaluate(async ([def, snap]) => {
    const { Store } = await import('/web/app/store.ts' as string);
    const { machineFromTemplate } = await import('/web/app/template.ts' as string);
    const blob = await (await fetch(snap)).blob();
    const { machine } = await machineFromTemplate(await Store.open(), def, new File([blob], 'alpine.waarm64snap'));
    return machine.id as string;
  }, [def, `${base}/${SNAP}`] as const);
  await attachHelper(b, id2);
  const t0 = Date.now();
  await b.goto(`${base}/web/app/?m=${id2}&view=both`);
  await agentUp(b);
  console.log(`# the restored guest's agent connected ${((Date.now() - t0) / 1000).toFixed(1)} s after the page's load`);
  await onSerial(b, '\n');
  const now = Number(await run(b, 'date +%s'));
  assert.ok(Math.abs(now - Date.now() / 1000) < 60, `the clock set at the restore: ${new Date(now * 1000).toISOString()}`);
  await b.waitForFunction(() => document.body.dataset.lease !== undefined, null, { timeout: 150_000, polling: 250 });
  const log = () => run(b, 'grep -E "lease|renew" /var/log/waarm64-agent.log | tail -4');
  assert.equal(await b.evaluate(() => document.body.dataset.lease), 'agent', `the lease renewed by the agent; it says: ${await log()}`);
  assert.equal(await run(b, 'cat /sys/class/net/eth0/carrier_changes'), carrier, 'the link stayed up through the restore and its renewal');
  // dhcpcd's rebind takes the address down while it asks (an INIT-REBOOT): back within seconds.
  let addr2 = '';
  for (let k = 0; k < 30 && !/^192\.168\.127\./.test(addr2); k++) {
    if (k) await b.waitForTimeout(1000);
    addr2 = await run(b, "ip -4 -o addr show dev eth0 scope global | awk '{print $4}'");
  }
  assert.match(addr2, /^192\.168\.127\.\d+\/\d+$/, `the lease after the rebind: ${addr2}; ${await run(b, 'grep dhcpcd /var/log/messages | tail -6')}`);
  console.log(`# the restored guest's address ${((Date.now() - t0) / 1000).toFixed(1)} s after the page's load`);
  const after = await apk(b);
  assert.ok(asked.some((p) => p.endsWith('/APKINDEX.tar.gz')), `apk reached the repository over TLS: ${after}; asked ${JSON.stringify(asked)}`);

  // The card handed to udhcpc (the alpine-demo image's client: ifupdown's way of running it), then LEASE: busybox's
  // renew.
  await run(b, 'ifdown eth0 > /dev/null 2>&1; ip link set eth0 up; (udhcpc -f -R -i eth0 -p /run/udhcpc.eth0.pid > /tmp/udhcpc.log 2>&1 &); sleep 5', 60_000);
  assert.match(await run(b, 'cat /tmp/udhcpc.log'), /lease of 192\.168\.127\.\d+ obtained/);
  const leased = await b.evaluate(() => (window as unknown as { __agent: { lease(ms: number): Promise<number | undefined> } }).__agent.lease(60_000));
  assert.equal(leased, 0, `LEASED: RENEWED; the agent says: ${await log()}`);
  await b.waitForTimeout(3000);
  const u = await run(b, 'cat /tmp/udhcpc.log');
  assert.match(u, /renew to server 192\.168\.127\.1 .*lease of 192\.168\.127\.\d+ obtained/, u);
  assert.match(await run(b, 'rc-status --crashed | wc -l'), /^0$/, 'nothing crashed');
  // POWER without logind or shutdown: busybox's poweroff, its init's shutdown (OpenRC's), the machine off.
  const powered = await b.evaluate(() => (window as unknown as { __agent: { power(r: boolean, ms: number): Promise<number | 'gone' | undefined> } }).__agent.power(false, 30_000));
  assert.ok(powered === 0 || powered === 'gone', `POWERED: ${powered}`);
  await b.waitForFunction(() => document.body.dataset.state === 'off', null, { timeout: 120_000, polling: 250 });
  await visitor.close();
});
