// Chromium's Local Network Access for the local helper (docs/plans/networking-local.md L0, bench/net/REPORT.md "The
// local helper"): a page of a public origin opens a WebSocket to the helper on loopback, from the page and from a worker,
// and we see what the permission does. A public origin: `https://waarm64.com` as it is deployed (the page's code doesn't
// matter: this drives the socket from outside) when it's reachable, else any public https site named by LNA_ORIGIN; and a
// copy on 127.0.0.1 that `--ip-address-space-overrides` calls public. The helper accepts each origin with --origin.
// Usage: node bench/net/lna.ts [<out.json>]    (headless: no prompt to click; what a headless browser shows is what a
// grant or a denial does to the socket and what `navigator.permissions` says.)
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { startServer } from '../../tools/serve.ts';
import { buildHelper } from '../../tests/waarm64-net.ts';

const ROOT = new URL('../../', import.meta.url).pathname;
const out = process.argv[2];
const origin = process.env.LNA_ORIGIN ?? 'https://waarm64.com';
const server = await startServer();
const port = (server.address() as { port: number }).port;
const copy = `http://127.0.0.1:${port}`;
const listen = 18742;

buildHelper(); // at the commit tests/waarm64-net.ts pins, or WAARM64_NET_SRC
const token = randomBytes(32).toString('base64url');
const ws = `ws://127.0.0.1:${listen}/${token}`;
const helper = spawn(`${ROOT}target/net/waarm64-net`, ['--listen', `127.0.0.1:${listen}`, '--origin', origin, '--origin', copy, '--no-ipv6'], { env: { ...process.env, WAARM64_NET_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
helper.stdout.on('data', (d) => { log += d; });
helper.stderr.on('data', (d) => { log += d; });
for (let k = 0; k < 100 && !log.includes('listening on'); k++) await new Promise((r) => setTimeout(r, 100));

// What a socket does: open (and its close code when the helper closes it), or how it failed, in ms.
const socket = (u: string, ms: number) => {
  const s = new WebSocket(u, 'waarm64-net.v1');
  const t0 = performance.now();
  return new Promise<string>((resolve) => {
    const t = setTimeout(() => resolve(`pending after ${ms} ms`), ms);
    s.onopen = () => { clearTimeout(t); s.close(); resolve(`open in ${Math.round(performance.now() - t0)} ms`); };
    s.onclose = (e) => { clearTimeout(t); resolve(`closed ${e.code} in ${Math.round(performance.now() - t0)} ms`); };
  });
};
const inPage = (page: Page, u: string, ms = 6000) => page.evaluate(`(${socket})(${JSON.stringify(u)}, ${ms})`) as Promise<string>; // a string: the deployed page's CSP may refuse eval
const inWorker = (page: Page, u: string, ms = 6000) => page.evaluate(({ f, u, ms }) => new Promise<string>((resolve) => {
  try {
    const w = new Worker(URL.createObjectURL(new Blob([`onmessage = async (e) => postMessage(await (${f})(e.data.u, e.data.ms))`], { type: 'text/javascript' })));
    w.onerror = (e) => resolve(`worker error: ${e.message}`);
    w.onmessage = (e) => resolve(e.data);
    w.postMessage({ u, ms });
  } catch (e) { resolve(`no worker: ${e}`); }
}), { f: socket.toString(), u, ms }) as Promise<string>;
const perm = (page: Page) => page.evaluate(async () => {
  const r: Record<string, string> = {};
  for (const name of ['local-network-access', 'local-network', 'loopback-network']) {
    try { r[name] = (await navigator.permissions.query({ name: name as PermissionName })).state; } catch (e) { r[name] = `(${(e as Error).name})`; }
  }
  return r;
});
const info = (page: Page) => page.evaluate(() => ({ origin: location.origin, secure: isSecureContext, isolated: crossOriginIsolated }));

const results: Record<string, unknown>[] = [];
async function probe(label: string, url: string, launchArgs: string[], prepare?: (ctx: BrowserContext, origin: string) => Promise<void>) {
  const dir = mkdtempSync(join(process.env.CLAUDE_JOB_DIR ? `${process.env.CLAUDE_JOB_DIR}/tmp` : tmpdir(), 'lna-'));
  const ctx = await chromium.launchPersistentContext(dir, { executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', args: launchArgs });
  try {
    const page = ctx.pages()[0] ?? await ctx.newPage();
    await page.goto(url, { timeout: 30_000, waitUntil: 'domcontentloaded' });
    await prepare?.(ctx, new URL(url).origin);
    const r: Record<string, unknown> = { label, version: ctx.browser()?.version(), page: await info(page), before: await perm(page) };
    r.fromPage = await inPage(page, ws);
    r.fromWorker = await inWorker(page, ws);
    r.after = await perm(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    r.afterReload = { perm: await perm(page), fromPage: await inPage(page, ws, 3000) };
    console.log(JSON.stringify(r));
    results.push(r);
  } catch (e) {
    console.log(`${label}: ${e}`);
    results.push({ label, error: String(e).slice(0, 400) });
  } finally {
    await ctx.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const space = [`--ip-address-space-overrides=127.0.0.1:${port}=public`];
const grant = (name: string) => async (ctx: BrowserContext, o: string) => {
  const cdp = await ctx.newCDPSession(ctx.pages()[0]);
  await cdp.send('Browser.setPermission', { permission: { name }, setting: 'granted', origin: o }).catch((e: Error) => console.log(`  ${name}: ${e.message}`));
};
const page = `${copy}/tests/browser/core.html`;
await probe('127.0.0.1 page (local: what the tests see)', page, []);
await probe('public by override, nothing granted', page, space);
await probe('public by override, CDP grant local-network-access', page, space, grant('local-network-access'));
await probe('public by override, CDP grant local-network', page, space, grant('local-network'));
await probe('public by override, CDP grant loopback-network', page, space, grant('loopback-network'));
await probe(`the real public origin ${origin}, nothing granted`, origin, []);
await probe(`the real public origin ${origin}, CDP grant loopback-network`, origin, [], grant('loopback-network'));
await probe('public by override, the feature off', page, [...space, '--disable-features=LocalNetworkAccessChecks']);
// A worker alone asks (nothing from the page first), and what a restart keeps. Headless shows no prompt: an ask ends denied.
{
  const fresh = async (dir: string) => chromium.launchPersistentContext(dir, { executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', args: space });
  const mk = () => mkdtempSync(join(process.env.CLAUDE_JOB_DIR ? `${process.env.CLAUDE_JOB_DIR}/tmp` : tmpdir(), 'lna-'));
  let dir = mk();
  let ctx = await fresh(dir);
  let p = ctx.pages()[0];
  await p.goto(page);
  const r: Record<string, unknown> = { label: 'a worker first', before: await perm(p), fromWorker: await inWorker(p, ws), after: await perm(p) };
  await ctx.close();
  rmSync(dir, { recursive: true, force: true });
  console.log(JSON.stringify(r));
  results.push(r);

  dir = mk();
  ctx = await fresh(dir);
  p = ctx.pages()[0];
  await p.goto(page);
  await grant('loopback-network')(ctx, new URL(page).origin);
  const before = await inPage(p, ws, 3000);
  await ctx.close();
  const prefs = readFileSync(join(dir, 'Default/Preferences'), 'utf8');
  const keys = [...prefs.matchAll(/"([a-z_]*(?:loopback|local_network)[a-z_]*)"/g)].map((m) => m[1]);
  ctx = await fresh(dir);
  p = ctx.pages()[0];
  await p.goto(page);
  const restart = { label: 'a CDP grant, then a restart', before, prefKeys: [...new Set(keys)], perm: await perm(p), fromPage: await inPage(p, ws, 3000) };
  await ctx.close();
  console.log(JSON.stringify(restart));
  results.push(restart);

  // What a click stores: a content setting in the profile's Preferences, read at the next start.
  const o = new URL(page).origin;
  const prefsJson = JSON.parse(readFileSync(join(dir, 'Default/Preferences'), 'utf8'));
  prefsJson.profile ??= {};
  prefsJson.profile.content_settings ??= {};
  prefsJson.profile.content_settings.exceptions ??= {};
  prefsJson.profile.content_settings.exceptions.loopback_network = { [`${o},*`]: { last_modified: '13400000000000000', setting: 1 } };
  writeFileSync(join(dir, 'Default/Preferences'), JSON.stringify(prefsJson));
  ctx = await fresh(dir);
  p = ctx.pages()[0];
  await p.goto(page);
  const stored = { label: 'a stored content setting, as a click leaves it', perm: await perm(p), fromPage: await inPage(p, ws, 3000), fromWorker: await inWorker(p, ws, 3000) };
  await ctx.close();
  rmSync(dir, { recursive: true, force: true });
  console.log(JSON.stringify(stored));
  results.push(stored);
}
if (out) writeFileSync(join(ROOT, out), JSON.stringify({ date: new Date().toISOString(), results, helperLog: log.replaceAll(token, '<token>') }, null, 1));
helper.kill();
server.close();
process.exit(0);
