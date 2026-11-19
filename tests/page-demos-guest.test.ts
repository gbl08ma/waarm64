// The demo store's page with a guest (docs/frontend.md "The demo store"; DEMO loop 6): a demo's template, built as the
// demos' site lays it out (`<site>/<name>/definition.json`, `snapshot.json` and the disk's `manifest.json`, one shared
// `<site>/pieces/`: bench/demo/make-template.ts, the demos' build), served by a local stand-in for vmdisks.tny.im
// (bench/demo/site.ts, another origin), listed by a store the test makes. In a fresh profile, the store's card →
// Start → a `#` prompt that answers a command (the template restored, nothing booted); a file written there survives a
// reload, the machine booting again from its overlay. A desktop's (its card's view the screen: the Arch desktop, DEMO
// loop 12) → Start → its screen like the template's thumbnail (bench/demo/screen-like.ts: the desktop resumed, sway's
// 3D state loaded) and a command answered on its serial console; no reload (that's a whole Arch boot). The site:
// `WAARM64_DEMO_SITE` (default target/demos; scripts/ci-machines.sh makes it from the build under test with
// tools/build-demos.ts into target/ci-demos) and `WAARM64_DEMO_NAME` (default alpine-term; a comma list, a case each;
// scripts/ci-graphics.sh runs arch-desktop from target/demos, which the desktop's build leaves there); a demo not built
// there, or built by another core (its snapshot's format or shape hash: tools/build-demos.ts --only <id> makes it again)
// is skipped. ~2 min for Alpine, ~1 min for the desktop.
import assert from 'node:assert/strict';
import { existsSync, openAsBlob, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { siteServer } from '../bench/demo/site.ts';
import { untilLike } from '../bench/demo/screen-like.ts';
import { shapeHashOf, type Session } from '../tools/demo-site.ts';
import { checkDefinition } from '../web/app/definitions.ts';
import { readHeader, SNAPSHOT_VERSION } from '../web/snapshot-file.ts';
import { startServer } from '../tools/serve.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const SITE = join(ROOT, process.env.WAARM64_DEMO_SITE ?? 'target/demos');
const NAMES = (process.env.WAARM64_DEMO_NAME ?? 'alpine-term').split(',');
const has = (name: string, f: string) => existsSync(join(SITE, name, f));
const skip = process.env.WAARM64_DEMO_TESTS !== '1' ? 'SKIPPED: scripts/ci-machines.sh and ci-graphics.sh run it (WAARM64_DEMO_TESTS=1)'
  : !existsSync(join(ROOT, 'target/images/edk2/QEMU_EFI.fd')) ? 'SKIPPED: no images/build.sh edk2'
  : false;

/** Why demo `name`'s build can't be tested here: not built, or its snapshot isn't this build's (format, shape hash). */
async function unfit(name: string): Promise<string | false> {
  if (!has(name, 'definition.json') || !has(name, 'snapshot.json'))
    return `SKIPPED: no demo template at ${SITE}/${name} (the demos' build, or WAARM64_DEMO_SITE)`;
  const m = JSON.parse(readFileSync(join(SITE, name, 'snapshot.json'), 'utf8')) as { pieces: string; hashes: string[] };
  const piece = (h: string) => openAsBlob(join(SITE, name, m.pieces.replace('{hash}', h)));
  const h = await readHeader(new Blob(await Promise.all(m.hashes.slice(0, 2).map(piece))));
  const def = checkDefinition(JSON.parse(readFileSync(join(SITE, name, 'definition.json'), 'utf8')));
  if (h.coreVersion !== SNAPSHOT_VERSION || h.shapeHash !== (await shapeHashOf(def)))
    return `SKIPPED: ${name}'s template is another core's (node tools/build-demos.ts --only ${name} makes it again)`;
  return false;
}

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

/** Whether demo `name` is a desktop (its build made with a session: its card's view the screen). */
const isDesktop = (name: string) =>
  has(name, 'template.json') && Boolean((JSON.parse(readFileSync(join(SITE, name, 'template.json'), 'utf8')) as { session?: unknown }).session);

/** The store: the site's definition with its demo (the site's own, else one made here: the serial view, offline). */
function store(NAME: string) {
  const def = JSON.parse(readFileSync(join(SITE, NAME, 'definition.json'), 'utf8')) as { disks: { url?: string }[]; demo?: Record<string, unknown> } & Record<string, unknown>;
  const snap = JSON.parse(readFileSync(join(SITE, NAME, 'snapshot.json'), 'utf8')) as { id: string; size: number };
  const at = (u?: string) => (u && !/^[a-z]+:/.test(u) ? `${NAME}/${u}` : u);
  const own = def.demo as { snapshot?: { manifest: string }; thumbnail?: string } | undefined;
  const demo = own
    ? { ...own, snapshot: own.snapshot && { ...own.snapshot, manifest: at(own.snapshot.manifest) }, ...(own.thumbnail ? { thumbnail: at(own.thumbnail) } : {}), network: undefined }
    : { id: NAME, summary: 'A demo.', download: snap.size, view: isDesktop(NAME) ? 'screen' : 'serial', snapshot: { manifest: `${NAME}/snapshot.json`, id: snap.id } };
  return { type: 'waarm64-store', version: 1, demos: [{ ...def, version: 2, disks: def.disks.map((d) => ({ ...d, url: at(d.url) })), demo }] };
}

const terminal = (page: Page) => page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '');
async function run(page: Page, cmd: string, want: RegExp, ms = 60_000) {
  await page.locator('.xterm').click();
  await page.keyboard.type(`${cmd}\n`, { delay: 5 });
  await page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.xterm-rows')?.textContent ?? ''), want.source, { timeout: ms, polling: 200 })
    .catch(async (e: unknown) => { throw new Error(`${String(e)}; the terminal shows: ${await terminal(page)}`); });
}

for (const NAME of NAMES) {
  test(`${NAME}: a store's card to a prompt: the template restored; a file written there survives a reload (a desktop: its screen shown)`, { skip, timeout: 8 * 60_000 }, async (t) => {
    const why = await unfit(NAME);
    if (why) return void t.skip(why);
    const screen = isDesktop(NAME);
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('dialog', (d) => { errors.push(`asked: ${d.message()}`); void d.dismiss(); });
    const url = `${site.base}/store.json`;
    await ctx.route(url, (r) => r.fulfill({ headers: { 'Access-Control-Allow-Origin': '*' }, json: store(NAME) }));
    await page.goto(`${base}/demos?store=${encodeURIComponent(url)}`);
    await page.locator('[data-action="accept-store"]').click({ timeout: 30_000 });
    await page.locator('.cards [data-demo]').first().click();
    const t0 = Date.now();
    await page.locator('[data-action="start-demo"]:not([disabled])').click({ timeout: 30_000 });
    await page.waitForFunction(() => document.body.dataset.state === 'running', null, { timeout: 120_000, polling: 100 });
    if (screen) {
      const d = await untilLike(page, readFileSync(join(SITE, NAME, 'thumb.webp')), 120_000);
      console.log(`# click to the desktop shown: ${((Date.now() - t0) / 1000).toFixed(1)} s (its difference from the thumbnail ${d.toFixed(1)})`);
      // The serial console, root logged in there, beside the screen.
      await page.locator('[data-view-button="both"]').click();
    }
    await run(page, 'echo demo-$((6*7)) > /root/demo-file; cat /root/demo-file; sync', /demo-42/, 120_000);
    console.log(`# click to a command answered: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    if (screen) {
      // The session's countdown (tools/demo-site.ts `Countdown`) resumed: its app's window comes in sway's tree.
      const c = (JSON.parse(readFileSync(join(SITE, NAME, 'template.json'), 'utf8')) as { session: Session }).session.countdown;
      if (c) {
        const sock = `SWAYSOCK=$(ls /run/user/$(id -u arch)/sway-ipc.*.sock)`;
        // Up to 120 s after the restore: the count, then the app's start under emulation (Firefox's ~30 s).
        await run(page, `clear; for i in $(seq 120); do su arch -c "${sock} swaymsg -t get_tree" | grep -q -E '"(app_id|class)": "${c.window}"' && break; sleep 1; done; [ "$i" -lt 120 ] && echo WIN""DOW-UP || echo WIN""DOW-NONE`, /WINDOW-(UP|NONE)/, 180_000);
        if (!/WINDOW-UP/.test(await terminal(page))) {
          // What the guest says of it: sway's log (the app's stderr, sway started it), the app_ids sway has, its processes.
          await run(page, `clear; tail -n 25 /tmp/sway.log; su arch -c "${sock} swaymsg -t get_tree" | grep -o -E '"(app_id|class)": "[^"]*"'; ps -eo args | grep -v -E '^\\[|ps -eo' | tail -n 6; echo DI""AG-END`, /DIAG-END/, 60_000);
          assert.fail(`${c.name}'s window (${c.window}) never came after the countdown; the guest: ${(await terminal(page)).slice(-2500)}`);
        }
        console.log(`# click to ${c.name}'s window (the countdown resumed): ${((Date.now() - t0) / 1000).toFixed(1)} s`);
        // `WAARM64_DEMO_SHOT=<dir>`: the screen 10 s after the window came, to see what the app drew (a person's check).
        if (process.env.WAARM64_DEMO_SHOT) {
          await page.waitForTimeout(10_000);
          await page.locator('#screen').screenshot({ path: join(process.env.WAARM64_DEMO_SHOT, `${NAME}-app.png`) });
        }
      }
      assert.deepEqual(errors, []);
      return void (await ctx.close());
    }

    await page.reload();
    await page.waitForFunction(() => document.body.dataset.state === 'running', null, { timeout: 180_000, polling: 200 });
    assert.equal(await page.evaluate(() => document.body.dataset.page), 'machine', 'the machine, not the store');
    await run(page, 'cat /root/demo-file', /demo-42/, 180_000);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}
