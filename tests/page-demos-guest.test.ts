// The demo store's page with a guest (docs/frontend.md "The demo store"; DEMO loop 6): a demo's template, built as the
// demos' site lays it out (`<site>/<name>/definition.json`, `snapshot.json` and the disk's `manifest.json`, one shared
// `<site>/pieces/`: bench/demo/make-template.ts, the demos' build), served by a local stand-in for vmdisks.tny.im
// (bench/demo/site.ts, another origin), listed by a store the test makes. In a fresh profile, the store's card →
// Start → a `#` prompt that answers a command (the template restored, nothing booted); a file written there survives a
// reload, the machine booting again from its overlay. The site: `WAARM64_DEMO_SITE` (default target/demos;
// scripts/ci-machines.sh makes it from the build under test with tools/build-demos.ts into target/ci-demos) and
// `WAARM64_DEMO_NAME` (default alpine-term); skipped without it. ~2 min.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { siteServer } from '../bench/demo/site.ts';
import { startServer } from '../tools/serve.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const SITE = join(ROOT, process.env.WAARM64_DEMO_SITE ?? 'target/demos');
const NAME = process.env.WAARM64_DEMO_NAME ?? 'alpine-term';
const has = (f: string) => existsSync(join(SITE, NAME, f));
const skip = process.env.WAARM64_DEMO_TESTS !== '1' ? 'SKIPPED: scripts/ci-machines.sh runs it (WAARM64_DEMO_TESTS=1)'
  : !has('definition.json') || !has('snapshot.json') || !existsSync(join(ROOT, 'target/images/edk2/QEMU_EFI.fd'))
    ? `SKIPPED: no demo template at ${SITE}/${NAME} (the demos' build, or WAARM64_DEMO_SITE), or no images/build.sh edk2`
  : false;

let browser: Browser;
let base: string;
let site: { base: string; close: () => Promise<void> };
let close: () => void;
before(async () => {
  if (skip) return;
  const server = await startServer();
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  site = await siteServer(SITE, [], () => 'site');
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
});
after(async () => {
  await browser?.close();
  await site?.close();
  close?.();
});

/** The store: the site's definition with its demo (the site's own, else one made here: the serial view, offline). */
function store() {
  const def = JSON.parse(readFileSync(join(SITE, NAME, 'definition.json'), 'utf8')) as { disks: { url?: string }[]; demo?: Record<string, unknown> } & Record<string, unknown>;
  const snap = JSON.parse(readFileSync(join(SITE, NAME, 'snapshot.json'), 'utf8')) as { id: string; size: number };
  const at = (u?: string) => (u && !/^[a-z]+:/.test(u) ? `${NAME}/${u}` : u);
  const own = def.demo as { snapshot?: { manifest: string }; thumbnail?: string } | undefined;
  const demo = own
    ? { ...own, snapshot: own.snapshot && { ...own.snapshot, manifest: at(own.snapshot.manifest) }, ...(own.thumbnail ? { thumbnail: at(own.thumbnail) } : {}), network: undefined }
    : { id: NAME, summary: 'A terminal.', download: snap.size, view: 'serial', snapshot: { manifest: `${NAME}/snapshot.json`, id: snap.id } };
  return { type: 'waarm64-store', version: 1, demos: [{ ...def, version: 2, disks: def.disks.map((d) => ({ ...d, url: at(d.url) })), demo }] };
}

const terminal = (page: Page) => page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '');
async function run(page: Page, cmd: string, want: RegExp, ms = 60_000) {
  await page.locator('.xterm').click();
  await page.keyboard.type(`${cmd}\n`, { delay: 5 });
  await page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.xterm-rows')?.textContent ?? ''), want.source, { timeout: ms, polling: 200 })
    .catch(async (e: unknown) => { throw new Error(`${String(e)}; the terminal shows: ${await terminal(page)}`); });
}

test("a store's card to a prompt: the template restored; a file written there survives a reload", { skip, timeout: 8 * 60_000 }, async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => { errors.push(`asked: ${d.message()}`); void d.dismiss(); });
  const url = `${site.base}/store.json`;
  await ctx.route(url, (r) => r.fulfill({ headers: { 'Access-Control-Allow-Origin': '*' }, json: store() }));
  await page.goto(`${base}/demos?store=${encodeURIComponent(url)}`);
  await page.locator('[data-action="accept-store"]').click({ timeout: 30_000 });
  await page.locator('.cards [data-demo]').first().click();
  const t0 = Date.now();
  await page.locator('[data-action="start-demo"]:not([disabled])').click({ timeout: 30_000 });
  await page.waitForFunction(() => document.body.dataset.state === 'running', null, { timeout: 120_000, polling: 100 });
  await run(page, 'echo demo-$((6*7)) > /root/demo-file; cat /root/demo-file; sync', /demo-42/, 120_000);
  console.log(`# click to a command answered: ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  await page.reload();
  await page.waitForFunction(() => document.body.dataset.state === 'running', null, { timeout: 180_000, polling: 200 });
  assert.equal(await page.evaluate(() => document.body.dataset.page), 'machine', 'the machine, not the store');
  await run(page, 'cat /root/demo-file', /demo-42/, 180_000);
  assert.deepEqual(errors, []);
  await ctx.close();
});
