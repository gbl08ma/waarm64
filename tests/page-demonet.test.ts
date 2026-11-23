// The demo network on the page (docs/networking/demo-network.md), in Chromium,
// against the real server (github.com/gbl08ma/waarm64-demonet at the commit tests/waarm64-demonet.ts pins, built with
// Go) on loopback, without TLS, as its README runs it locally: Alpine's published UEFI cloud image as a stored machine
// whose first adapter is attached to a `demo` connection to it (web/app/net-demo.ts `attachDemoNetwork`, what a demo's
// definition does). The guest takes the server's lease and reads the gateway's /status; a name off the allowlist is
// refused, and the Network menu's status counts it and names it; the owner announces a restart (the config's
// [notice], reloaded): the message bar says when, then the server stops (4011) and the menu says when it tries again,
// and once it's back the page reconnects by itself; the day's budget (small here) is spent by the guest's pings: the
// message bar says 80 %, then that it's used up, and after the server's 4010 the menu says when it resets. Every
// word from the catalog. One Alpine boot (~2 min); needs Go, images/build.sh alpine-uefi edk2. Opt-in with the network
// tests: scripts/ci-net.sh.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { fatImage } from '../web/fat.ts';
import { answerAsks } from './page-ask.ts';
import { buildDemonet, demonetSkip } from './waarm64-demonet.ts';
import { words } from './words.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const IMAGE = 'target/images/alpine-uefi/alpine.qcow2';
const SEED = 'target/tests/demonet/seed.img'; // served by the dev server, as the image is
const has = (p: string) => existsSync(join(ROOT, p));
const skip = process.env.WAARM64_NET_TESTS !== '1' ? 'SKIPPED: scripts/ci-net.sh runs it (WAARM64_NET_TESTS=1)'
  : !has(IMAGE) || !has('target/images/edk2/QEMU_EFI.fd') ? 'SKIPPED: run images/build.sh alpine-uefi edk2'
  : demonetSkip();
const GATEWAY = '192.168.127.1';

let browser: Browser;
let base: string;
let closeServer: () => void;
let bin: string;
let dir: string;
let port: number;
let server: ChildProcess | undefined;
let log = '';

const freePort = () => new Promise<number>((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const p = (s.address() as AddressInfo).port;
    s.close(() => resolve(p));
  });
});

/** The server's config: our test page's origin, the one rule, a day's budget of `budget`, and a restart announced. */
function config(budget: string, notice?: { at: Date; back: Date }) {
  const toml = [
    '[server]', `listen = "127.0.0.1:${port}"`, `origins = ["${base}"]`,
    '[budget]', `bytes_per_day = "${budget}"`,
    '[[allow]]', 'name = "dl-cdn.alpinelinux.org"', 'ports = [443]', 'note = "the test\'s one rule"',
    ...(notice ? ['[notice]', `restart_at = ${notice.at.toISOString().replace(/\.\d+Z$/, 'Z')}`, `back_at = ${notice.back.toISOString().replace(/\.\d+Z$/, 'Z')}`] : []),
  ].join('\n');
  writeFileSync(join(dir, 'config.toml'), `${toml}\n`);
}
async function startDemonet() {
  log = '';
  server = spawn(bin, ['--config', join(dir, 'config.toml')], { stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout!.on('data', (d) => { log += d; });
  server.stderr!.on('data', (d) => { log += d; });
  for (let k = 0; k < 100 && !log.includes('listening on'); k++) await new Promise((r) => setTimeout(r, 100));
  assert.match(log, /listening on/, `the server didn't start: ${log}`);
}
async function stopDemonet() {
  const s = server;
  server = undefined;
  if (!s || s.exitCode !== null) return;
  const gone = new Promise((r) => s.once('exit', r));
  s.kill('SIGTERM');
  await Promise.race([gone, new Promise((r) => setTimeout(r, 15_000))]);
}

before(async () => {
  if (skip) return;
  bin = buildDemonet();
  dir = mkdtempSync(join(tmpdir(), 'waarm64-demonet-'));
  mkdirSync(join(ROOT, 'target/tests/demonet'), { recursive: true });
  writeFileSync(join(ROOT, SEED), fatImage('CIDATA', [{ name: 'meta-data', data: 'instance-id: waarm64-demonet\nlocal-hostname: alpine\n' }, { name: 'user-data', data: '#!/bin/sh\npasswd -d root\n' }]));
  const s = await startServer();
  closeServer = () => s.close();
  base = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
  port = await freePort();
  config('500MB');
  await startDemonet();
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
});
after(async () => {
  await browser?.close();
  closeServer?.();
  await stopDemonet();
  if (dir) rmSync(dir, { recursive: true, force: true });
  rmSync(join(ROOT, 'target/tests/demonet'), { recursive: true, force: true });
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
const status = (page: Page) => page.evaluate(() => document.getElementById('net-status')?.textContent ?? '');
const bar = (page: Page) => page.evaluate(() => document.getElementById('message')?.textContent ?? '');
const phase = (page: Page) => page.evaluate(() => document.getElementById('network')?.dataset.phase);
/** Until the Network menu's status matches one of `res` (the menu is open: its status is drawn). */
const statusLike = (page: Page, res: RegExp[], ms = 60_000) =>
  page.waitForFunction((srcs) => srcs.some((s) => new RegExp(s).test(document.getElementById('net-status')?.textContent ?? '')), res.map((r) => r.source), { timeout: ms, polling: 200 })
    .catch(async (e) => { throw new Error(`${e}; the status says: ${await status(page)}; the message bar: ${await bar(page)}; the server:\n${log}`); });
const barLike = (page: Page, re: RegExp, ms = 60_000) =>
  page.waitForFunction((src) => new RegExp(src).test(document.getElementById('message')?.textContent ?? ''), re.source, { timeout: ms, polling: 100 })
    .catch(async (e) => { throw new Error(`${e}; the message bar says: ${await bar(page)}; the status: ${await status(page)}`); });
async function menu(page: Page) {
  if (!(await page.evaluate(() => (document.getElementById('network') as HTMLDetailsElement).open))) await page.locator('#network summary').click();
}

test('the demo network on the page: the lease and /status, a refusal counted, a restart announced and waited out, the budget crossed and spent', { skip, timeout: 15 * 60_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await answerAsks(page);
  await page.goto(`${base}/web/app/?autostart=1`);
  const ws = `ws://127.0.0.1:${port}/`;
  const id = await page.evaluate(async ([image, seed, ws]) => {
    const { Store } = await import('/web/app/store.ts' as string);
    const { attach, createDisk, createMachine } = await import('/web/app/machines.ts' as string);
    const { checkUrl } = await import('/web/app/urlcheck.ts' as string);
    const { attachDemoNetwork } = await import('/web/app/net-demo.ts' as string);
    const store = await Store.open();
    const m = await createMachine(store, { name: 'Alpine', ncpus: 2, ramMiB: 512, display: '2d', network: true, usb: false, mouse: false, touch: false, shares: false });
    for (const url of [image, seed]) {
      const c = await checkUrl(url);
      if (!c.ok || !c.head) throw new Error(`${url}: ${JSON.stringify(c.problems)}`);
      const v = new DataView(c.head.buffer, c.head.byteOffset);
      const size = v.getUint32(0) === 0x514649fb ? Number(v.getBigUint64(24)) : c.bytes;
      await attach(store, m, await createDisk(store, { kind: 'url', url, name: c.name, size, bytes: c.bytes }));
    }
    await attachDemoNetwork(store, m.id, 0, ws);
    return m.id as string;
  }, [`${base}/${IMAGE}`, `${base}/${SEED}`, ws] as const);
  await page.goto(`${base}/web/app/?autostart=1&m=${id}&view=both`);
  await page.waitForFunction(() => document.getElementById('network')?.dataset.phase === 'connected', null, { timeout: 60_000 });
  await menu(page);
  assert.match(await status(page), words('network:demo-view.connected', {}, { start: true }));

  // The guest: the server's lease, its gateway's /status.
  await shows(page, /login: \s*$/, 300_000);
  await onSerial(page, 'root\n');
  await shows(page, /:~# \s*$/);
  let addr = '';
  for (let k = 0; k < 60 && !/^192\.168\.127\./.test(addr); k++) {
    if (k) await page.waitForTimeout(1000);
    addr = await run(page, "ip -4 -o addr show dev eth0 scope global | awk '{print $4}'");
  }
  assert.match(addr, /^192\.168\.127\.\d+\/\d+$/, `the server's lease: ${addr}`);
  await statusLike(page, [words('network:demo-view.connected.address', { address: addr.split('/')[0] })]);
  const st = await run(page, `wget -q -O- http://${GATEWAY}/status`);
  assert.match(st, /protocol: waarm64-demonet\.v1 .*lane: fast/, st);

  // A name off the allowlist: refused (NXDOMAIN), counted and named in the menu's status.
  const ns = await run(page, `nslookup pypi.org ${GATEWAY}; true`);
  assert.match(ns, /NXDOMAIN|can't find/i, ns);
  // (The guest's own lookups are refused too: its NTP pool's, say. The count is the network's total.)
  await statusLike(page, [new RegExp(`${words('network:demo-view.refused', {}).source}.*pypi\\.org`)]);

  // A restart announced (the config reloaded): the message bar says when; the server stops (4011): the menu says when
  // it tries again (`back_at`, plus up to 30 s); once it's back, the page connects again by itself.
  const at = new Date(Date.now() + 15_000);
  const back = new Date(Date.now() + 20_000);
  config('500MB', { at, back });
  await barLike(page, words('network:demo-view.notice.restart.back', {}), 30_000);
  await statusLike(page, [words('network:demo-view.restart.back', {})]);
  await stopDemonet();
  await statusLike(page, [words('network:demo-view.wait.maintenance', {})], 30_000);
  assert.equal(await phase(page), 'connecting');
  // Back with a small budget for what follows: a stop forgets the visitors' counts.
  config('1MB');
  await startDemonet();
  await statusLike(page, [words('network:demo-view.connected', {}, { start: true })], 90_000);
  assert.match(await run(page, `wget -q -O- http://${GATEWAY}/status`), /lane: fast/, 'the guest on the new network: its lease renewed or kept');

  // The day's budget spent by the guest's pings: 80 % said, then used up; past the grace the server closes (4010), and
  // the menu says when it resets.
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __seen: string[] }).__seen = seen;
    setInterval(() => {
      const s = document.getElementById('message')?.textContent ?? '';
      if (s && seen.at(-1) !== s) seen.push(s);
    }, 50);
  });
  await run(page, `for i in $(seq 20); do ping -q -c 40 -s 1400 ${GATEWAY} > /dev/null 2>&1 & done; wait`, 120_000);
  await statusLike(page, [words('network:demo-view.wait.bytes', {})], 60_000);
  const seen = await page.evaluate(() => (window as unknown as { __seen: string[] }).__seen);
  assert.ok(seen.some((s) => words('network:demo-view.notice.budget.resets', { percent: 80 }).test(s)), `80 % said: ${JSON.stringify(seen)}`);
  // Used up, and said until closed whichever way the socket ended: past the grace the server's 4010, or (under load,
  // its close not through in time) a lost socket whose reconnect meets 4010, said again.
  const spent = words('network:demo-view.notice.spent', {});
  assert.ok(seen.some((s) => spent.test(s)), `used up said: ${JSON.stringify(seen)}`);
  assert.match(await bar(page), spent, `still said at the end: ${JSON.stringify(seen)}`);
  assert.deepEqual(errors, []);
  await context.close();
});
