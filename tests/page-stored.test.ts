// A disk stored in the browser (docs/plans/machines.md §3), on Debian: imported into the block store, its
// overlays as variants, merged into it, written in place, under an overlay again; each a boot of the stored
// machine on the page. Its own file so that scripts/ci-machines.sh runs it beside tests/page-machines.test.ts
// (whose helpers these are). Opt-in with WEBPC_DISTROS=debian; a Debian page boot is ~40 s in the dev VM,
// ~2.5 min in a cloud session.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { credentialsQuery } from './debian-unattended.ts';
import { withDebianLock } from './debian-lock.ts';
import { PAGE_QUERY } from './page-query.ts';
import { answerAsks } from './page-ask.ts';

const debian = (process.env.WEBPC_DISTROS ?? '').split(',').includes('debian');
const IMAGE = new URL('../target/images/debian/disk.qcow2', import.meta.url);
const FIRMWARE = new URL('../target/images/edk2/QEMU_EFI.fd', import.meta.url);
const skip = !debian ? 'SKIPPED: scripts/ci-machines.sh runs it (WEBPC_DISTROS=debian)' : (!existsSync(IMAGE) || !existsSync(FIRMWARE)) && 'SKIPPED: run images/build.sh debian edk2';
const BOOT_MS = 420_000;

let browser: Browser;
let base: string;
let close: () => void;
before(async () => {
  if (skip) return;
  const server = await startServer();
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
});
after(async () => { await browser?.close(); close?.(); });

const terminal = (page: Page) => page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '');
const shows = (page: Page, re: RegExp, ms = 60_000) =>
  page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.xterm-rows')?.textContent ?? ''), re.source, { timeout: ms, polling: 100 })
    .catch(async (e) => { throw new Error(`${e}; the terminal shows: ${await terminal(page)}`); });

/** Waits until the page settles in `running` (from another state than `from`). */
async function running(page: Page, from?: string, ms = BOOT_MS) {
  await page.waitForFunction((from) => document.body.dataset.state !== from && ['running', 'failed', 'crashed', 'idle', 'off'].includes(document.body.dataset.state!), from, { timeout: ms, polling: 250 })
    .catch(async (e) => { throw new Error(`${e}; the page is ${await page.evaluate(() => document.body.dataset.state)}; the terminal shows: ${await terminal(page)}`); });
  const [state, message] = await page.evaluate(() => [document.body.dataset.state, (document.getElementById('message-text')?.textContent ?? '')]);
  assert.equal(state, 'running', message ?? '');
}

async function type(page: Page, text: string) {
  await page.locator('.xterm').click();
  await page.keyboard.type(text, { delay: 5 });
}

let tag = 0;
/**
 * Runs `cmd` in the guest's shell and returns what it printed between two markers (on one line: the unquoted `$o`
 * joins its lines with spaces), with its exit status. The markers are made by the shell, so the echoed command never matches.
 */
async function sh(page: Page, cmd: string, ms = 120_000): Promise<{ out: string; status: number }> {
  const t = ++tag;
  await type(page, `o=$( { ${cmd} ; } 2>&1 ); s=$?; echo "<$((${t}*1))<"$o">$s>${t}>"\n`);
  const re = new RegExp(`<${t}<(.*?)>(\\d+)>${t}>`);
  await shows(page, re, ms);
  const m = re.exec(await terminal(page))!;
  return { out: m[1].trim(), status: Number(m[2]) };
}
const ok = async (page: Page, cmd: string, ms?: number) => {
  const r = await sh(page, cmd, ms);
  assert.equal(r.status, 0, `${cmd}: ${r.out}`);
  return r.out;
};

async function login(page: Page) {
  await shows(page, /login: /, 60_000);
  await type(page, 'root\n');
  await shows(page, /(?:root@\S+|\S+):~# /); // Debian's prompt, Alpine's
}

/** Boots stored machine `id` on a fresh page load, logs root in on the serial terminal; says how long it took. */
async function boot(page: Page, id: string, what = '') {
  const t = Date.now();
  await page.goto(`${base}/web/app/?${PAGE_QUERY}m=${id}&view=terminal&display=simple&${credentialsQuery()}`);
  await running(page);
  await login(page);
  console.log(`# ${what} booted in ${((Date.now() - t) / 1000).toFixed(0)} s`);
}
/** Powers the guest off and waits for the page to say so (its records are refreshed then). */
async function powerOff(page: Page) {
  await type(page, 'poweroff\n');
  await page.waitForFunction(() => document.body.dataset.state === 'off', null, { timeout: 180_000 });
  await page.waitForTimeout(500);
}
/** Runs `f` in the page with the store and web/app/disks.ts. */
const inStore = <T, A>(page: Page, f: (s: { store: never; disks: never; a: A }) => Promise<T>, a: A) => page.evaluate(async ({ src, a }) => {
  const { Store } = await import('/web/app/store.ts' as string);
  const disks = await import('/web/app/disks.ts' as string);
  const store = await Store.open();
  try {
    return await (new Function(`return (${src})`)())({ store, disks, a });
  } finally {
    store.close();
  }
}, { src: f.toString(), a }) as Promise<T>;

/**
 * The stored disk's two steps share a profile (the disk stored in the first): a fresh one on disk, as a user's (an
 * off-the-record context's storage is in memory, with a quota, ~1 GB here, that Debian stored, ~1 GB, doesn't fit).
 * Each step stays under 10 minutes in a cloud session.
 */
let storedRun: { profile: string; context: BrowserContext; page: Page; id: string; errors: string[] } | undefined;
after(async () => {
  await storedRun?.context.close();
  if (storedRun) rmSync(storedRun.profile, { recursive: true, force: true });
});

test("a disk stored in the browser (1): imported, its overlays as variants (changes loaded into a new one, switched)", { skip, timeout: 25 * 60_000 }, () => withDebianLock(async () => {
  const profile = mkdtempSync(join(tmpdir(), 'webpc-profile-'));
  const context = await chromium.launchPersistentContext(profile, { executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
  const page = context.pages()[0] ?? await context.newPage();
  const errors: string[] = [];
  storedRun = { profile, context, page, id: '', errors };
  page.on('pageerror', (e) => errors.push(String(e)));
  await answerAsks(page);
  await page.goto(`${base}/web/app/?${PAGE_QUERY}view=terminal`);
  // The import: Debian's qcow2 (95% compressed clusters) inflated into the block store.
  const t0 = Date.now();
  const imported = await inStore(page, async ({ store, disks }: any) => {
    const file = new File([await (await fetch('/target/images/debian/disk.qcow2')).blob()], 'debian.qcow2');
    const estimate = await disks.estimateStored(file);
    const d = await disks.importStored(store, file);
    const { newId } = await import('/web/app/shape.ts' as string);
    const now = Date.now();
    const id = newId();
    await store.put('machines', { id, name: 'Stored', ncpus: 2, ramMiB: 1024, display: '2d', network: true, attachments: [{ id: newId(), disk: d.id, readOnly: false }], created: now, modified: now });
    return { id, disk: d.id, size: d.size, estimate: estimate.estimate, bytes: await store.files.size(`disks/${d.id}`) };
  }, null);
  console.log(`# imported Debian in ${((Date.now() - t0) / 1000).toFixed(0)} s: ${(imported.bytes / 1e6).toFixed(0)} MB stored, ${(imported.estimate / 1e6).toFixed(0)} MB estimated`);
  assert.ok(imported.bytes <= imported.estimate * 1.01 + (1 << 20), 'the estimate covers what it takes');
  const { id } = imported;
  storedRun.id = id;

  // 1. Its first overlay ("Changes", made at the start) takes a file; its generation moves.
  await boot(page, id, 'over its first overlay');
  await ok(page, 'echo one > /root/one && sync');
  await powerOff(page);
  const first = await inStore(page, async ({ store, a }: any) => {
    const m = await store.get('machines', a);
    return store.get('overlays', m.attachments[0].overlay);
  }, id);
  assert.equal(first.name, 'Changes');
  assert.ok(first.generation >= 1 && first.bytes > 0, `generation ${first.generation}, ${first.bytes} bytes`);

  // 2. Its changes saved and loaded into a new overlay; an empty one beside them; the machine switched to the loaded one.
  const variants = await inStore(page, async ({ store, disks, a }: any) => {
    const { runExport } = await import('/web/app/export.ts' as string);
    const m = await store.get('machines', a);
    const d = await store.get('disks', m.attachments[0].disk);
    const r = await runExport({ mode: 'changes', compress: true, disk: await disks.diskRef(d, m.attachments[0].overlay), baseName: d.name }, () => {});
    const loaded = await disks.loadChangesInto(store, d, new File([r.blob], 'saved-changes.qcow2'), () => {});
    const empty = await disks.createOverlay(store, d, 'Fresh');
    await disks.switchOverlay(store, m, m.attachments[0].id, loaded.id);
    return { loaded: loaded.name, empty: empty.id, names: (await store.overlaysOf(d.id)).map((o: { name: string }) => o.name).sort() };
  }, id);
  assert.deepEqual(variants.names, ['Changes', 'Fresh', 'saved-changes']);
  await boot(page, id, 'over the loaded changes');
  assert.equal(await ok(page, 'cat /root/one'), 'one');
  await ok(page, 'echo two > /root/two && sync');
  await powerOff(page);
  assert.deepEqual(errors, []);
}));

test('a disk stored in the browser (2): an overlay merged into it, then written in place, then under an overlay again', { skip, timeout: 25 * 60_000 }, () => withDebianLock(async () => {
  if (!storedRun?.id) throw new Error('step 1 failed: nothing to merge');
  const { page, id, errors } = storedRun;
  // 3. Merged into the disk: the other overlays are deleted, the disk's generation moves; then written in place.
  const merged = await inStore(page, async ({ store, disks, a }: any) => {
    const m = await store.get('machines', a);
    const o = m.attachments[0].overlay;
    const costs = (await disks.mergeCosts(store, o)).map((x: { name: string }) => x.name).sort();
    const before = (await store.get('disks', m.attachments[0].disk)).generation;
    const blocks = await disks.mergeIntoDisk(store, o);
    const m2 = await store.get('machines', a);
    m2.attachments[0].inPlace = true;
    await store.put('machines', m2);
    return { costs, blocks, before, after: (await store.get('disks', m.attachments[0].disk)).generation, overlays: (await store.overlaysOf(m.attachments[0].disk)).length, files: await store.files.list('overlays') };
  }, id);
  assert.deepEqual(merged.costs, ['Changes', 'Fresh']);
  assert.ok(merged.blocks > 0 && merged.after === merged.before + 1, JSON.stringify(merged));
  assert.equal(merged.overlays, 0);
  assert.deepEqual(merged.files, []);
  await boot(page, id, 'in place');
  assert.equal(await ok(page, 'cat /root/one /root/two'), 'one two');
  await ok(page, 'echo three > /root/three && sync');
  await powerOff(page);
  const inPlace = await inStore(page, async ({ store, a }: any) => {
    const m = await store.get('machines', a);
    const d = await store.get('disks', m.attachments[0].disk);
    m.attachments[0].inPlace = false; // back to an overlay: a new empty one is made at the start
    await store.put('machines', m);
    return { generation: d.generation, overlays: (await store.overlaysOf(d.id)).length };
  }, id);
  assert.equal(inPlace.generation, merged.after + 1, 'writing in place moved the disk on');
  assert.equal(inPlace.overlays, 0, 'in place, no overlay');

  // 4. Over an overlay again: the disk has what was written in place.
  await boot(page, id, 'over a new overlay');
  assert.equal(await ok(page, 'cat /root/one /root/two /root/three'), 'one two three');
  await powerOff(page);
  assert.deepEqual(errors, []);
}));
