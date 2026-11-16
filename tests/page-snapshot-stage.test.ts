// A snapshot to a file staged through OPFS on the page (docs/frontend.md "Snapshots", SNAPZ's decision 3), on Buildroot
// in an on-disk profile: a download and a picked file (a file in OPFS stands in for the user's pick) go through a
// staging file during the pause, the picked one copied after the resume and the staging file removed, the download's
// kept until the next file save; the fallbacks write the file directly: no room (`?stageroom=0`), a staging write refused partway
// (the origin's quota lowered through the DevTools protocol, `Storage.overrideQuotaForOrigin`, which `estimate()`
// doesn't report: tests/page-quota.test.ts), and a copy that fails after the resume (the quota between one file's
// worth and two) says so and leaves nothing behind; a staging file no page holds (one left by a crash) is removed at the
// next start.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { readHeader } from '../web/snapshot-file.ts';
import { PAGE_QUERY } from './page-query.ts';
import { answerAsks } from './page-ask.ts';
import { eventually } from './until.ts';
import { words } from './words.ts';
import { checkSave } from './snapshot-phases.ts';

const IMAGES = new URL('../target/images/', import.meta.url);
const buildroot = existsSync(new URL('buildroot/rootfs.ext4', IMAGES)) && existsSync(new URL('linux/Image', IMAGES));
const skip = !buildroot && 'SKIPPED: run images/build.sh';
const BOOT_MS = 240_000;

let base: string;
let close: () => void;
let dir: string;
before(async () => {
  const server = await startServer();
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  dir = mkdtempSync(join(tmpdir(), 'waarm64-stage-'));
});
after(() => { close?.(); if (dir) rmSync(dir, { recursive: true }); });

const terminal = (page: Page) => page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '');
const shows = (page: Page, re: RegExp, ms = 60_000) =>
  page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.xterm-rows')?.textContent ?? ''), re.source, { timeout: ms, polling: 100 })
    .catch(async (e) => { throw new Error(`${e}; the terminal shows: ${await terminal(page)}`); });
async function onSerial(page: Page, text: string) {
  await page.locator('.xterm').click();
  await page.keyboard.type(text, { delay: 10 });
}
async function running(page: Page) {
  await page.waitForFunction(() => ['running', 'failed', 'crashed', 'idle', 'off'].includes(document.body.dataset.state!), null, { timeout: BOOT_MS, polling: 100 });
  assert.equal(await page.evaluate(() => document.body.dataset.state), 'running', await page.evaluate(() => document.getElementById('message-text')?.textContent ?? ''));
}
/** The staging files in OPFS, with their sizes. */
const staging = (page: Page) => page.evaluate(async () => {
  const out: Record<string, number> = {};
  let d: FileSystemDirectoryHandle;
  try {
    d = await (await navigator.storage.getDirectory()).getDirectoryHandle('snapshot-staging');
  } catch {
    return out;
  }
  for await (const [name, h] of (d as unknown as { entries(): AsyncIterable<[string, FileSystemFileHandle]> }).entries()) out[name] = (await h.getFile()).size;
  return out;
});
type Info = { kind: string; bytes: number; pausedMs: number; staging?: string; phases: { copy: number; close: number } };
const info = async (page: Page) => JSON.parse(await page.evaluate(() => document.getElementById('message')?.dataset.snapshot ?? '{}')) as Info;
const said = (page: Page, key: string, params: Parameters<typeof words>[1] = {}) =>
  page.waitForFunction((src) => new RegExp(src).test(document.getElementById('message-text')?.textContent ?? ''), words(key, params, { start: true }).source, { timeout: 120_000, polling: 50 });

/** Save snapshot as a download: the file's bytes, once the page says it's saved, and its `data-snapshot`. */
async function download(page: Page, name: string) {
  const before = await page.evaluate(() => document.getElementById('message')?.dataset.snapshot ?? '');
  const [d] = await Promise.all([page.waitForEvent('download', { timeout: 120_000 }), page.locator('#save-snapshot').click()]);
  const path = join(dir, name);
  await d.saveAs(path);
  await page.waitForFunction((b) => (document.getElementById('message')?.dataset.snapshot ?? '') !== b, before, { timeout: 120_000 });
  await said(page, 'snapshots:snapshot-actions.saved');
  const i = await info(page);
  checkSave(i, 'file');
  const bytes = readFileSync(path);
  assert.equal(i.bytes, bytes.length, 'the page counted the bytes the file has');
  assert.equal((await readHeader(new Blob([bytes]))).machine, 'buildroot');
  return { info: i, bytes };
}
/** The picker returns OPFS file `name` (as a user's pick would a file on the computer). */
const pickInto = (page: Page, name: string) => page.evaluate((n) => {
  (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = async () => (await navigator.storage.getDirectory()).getFileHandle(n, { create: true });
}, name);
const noPicker = (page: Page) => page.evaluate(() => { (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = undefined; });
const picked = (page: Page, name: string) => page.evaluate(async (n) => {
  const f = await (await (await navigator.storage.getDirectory()).getFileHandle(n)).getFile();
  return { size: f.size, magic: new TextDecoder().decode(await f.slice(0, 8).arrayBuffer()) };
}, name);
const usage = (page: Page) => page.evaluate(async () => (await navigator.storage.estimate()).usage ?? 0);

test('a file save staged through OPFS: a download and a picked file; no room, a refusal partway and a failed copy; a stale staging file removed', { skip, timeout: 8 * 60_000 }, async () => {
  const context: BrowserContext = await chromium.launchPersistentContext(mkdtempSync(join(dir, 'profile-')), { executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', viewport: { width: 1200, height: 800 } });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await answerAsks(page);
    await page.addInitScript(() => { (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = undefined; });
    const url = `${base}/web/app/?${PAGE_QUERY}machine=buildroot&ncpus=2&view=terminal`;
    await page.goto(url);
    await running(page);
    await onSerial(page, 'echo sa""ved-$((6*7))\n');
    await shows(page, /saved-42/);

    // A download: staged, the file handed to the browser, its staging file kept until the next file save.
    const first = await download(page, 'first.waarm64snap');
    assert.equal(first.info.staging, 'staged');
    const kept = await staging(page);
    assert.deepEqual(Object.values(kept), [first.bytes.length], `the download's staging file: ${JSON.stringify(kept)}`);

    // A picked file: staged, then copied into it after the resume, and the staging file removed.
    await pickInto(page, 'picked.waarm64snap');
    await page.locator('#save-snapshot').click();
    await said(page, 'snapshots:snapshot-actions.saved', { name: 'picked.waarm64snap' });
    const p = await info(page);
    checkSave(p, 'file');
    assert.equal(p.staging, 'staged');
    assert.ok(p.phases.copy > 0, `the copy's time: ${JSON.stringify(p.phases)}`);
    assert.deepEqual(await picked(page, 'picked.waarm64snap'), { size: p.bytes, magic: 'WAARMSNP' });
    assert.deepEqual(await staging(page), {}, 'the download\'s staging file let go at this save\'s start, the picked file\'s gone');
    await onSerial(page, 'echo aft""er-$((6*7))\n');
    await shows(page, /after-42/);

    // A staging write refused partway (room for half a file): written again directly, still paused; nothing staged left.
    const cdp = await context.newCDPSession(page);
    const N = first.bytes.length;
    await noPicker(page);
    await cdp.send('Storage.overrideQuotaForOrigin', { origin: base, quotaSize: (await usage(page)) + Math.floor(N / 2) });
    const refused = await download(page, 'refused.waarm64snap');
    assert.equal(refused.info.staging, 'refused');
    assert.ok(Math.abs(refused.bytes.length - N) < N / 4, `a whole file (${refused.bytes.length} against ${N})`);
    assert.deepEqual(await staging(page), {}, 'the refused staging file is gone');

    // A copy that fails after the resume (room for one file's worth, not the picked file's too): said, nothing left.
    await pickInto(page, 'failed.waarm64snap');
    await cdp.send('Storage.overrideQuotaForOrigin', { origin: base, quotaSize: (await usage(page)) + Math.floor(N * 1.5) });
    await page.locator('#save-snapshot').click();
    await page.waitForFunction((src) => new RegExp(src).test(document.getElementById('message-details')?.textContent ?? ''), words('snapshots:worker-stage.notCopied', { name: 'failed.waarm64snap' }, { start: true }).source, { timeout: 120_000, polling: 50 });
    assert.match(await page.evaluate(() => document.getElementById('message-text')?.textContent ?? ''), words('snapshots:worker-snapshot.notSaved', {}, { start: true }));
    assert.equal((await picked(page, 'failed.waarm64snap')).size, 0, 'the picked file holds none of it');
    assert.deepEqual(await staging(page), {}, 'the failed copy\'s staging file is gone');
    await cdp.send('Storage.overrideQuotaForOrigin', { origin: base });
    assert.equal(await page.evaluate(() => document.body.dataset.state), 'running');
    await onSerial(page, 'echo st""ill-$((6*7))\n');
    await shows(page, /still-42/);

    // A staging file no page holds (a crash's), beside a download's (its page about to end): both removed at the next
    // start, here with no room for staging.
    await noPicker(page);
    assert.equal((await download(page, 'second.waarm64snap')).info.staging, 'staged');
    await page.evaluate(async () => {
      const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('snapshot-staging', { create: true });
      const w = await (await d.getFileHandle('left-by-a-crash', { create: true })).createWritable();
      await w.write(new Uint8Array(4096));
      await w.close();
    });
    assert.equal(Object.keys(await staging(page)).length, 2);
    await page.goto(`${url}&stageroom=0`);
    await running(page);
    await eventually(async () => assert.deepEqual(await staging(page), {}, 'the staging files no page holds are removed at the start'));

    // No room: written directly to the download, as before staging.
    const direct = await download(page, 'direct.waarm64snap');
    assert.equal(direct.info.staging, 'room');
    assert.deepEqual(await staging(page), {}, 'nothing staged');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('a download\'s staging file is kept however long the browser takes to read it, until the next file save', async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
  try {
    const page = await browser.newPage();
    await page.clock.install(); // no guest here: the page's timers are the test's
    await page.goto(`${base}/tests/browser/core.html`);
    const stage = () => page.evaluate(async () => {
      const { holdStaging, stagedFile, keepForDownload } = await import('/web/snapshot-stage.ts' as string) as typeof import('../web/snapshot-stage.ts');
      const s = (await holdStaging())!;
      const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('snapshot-staging', { create: true });
      const w = await (await d.getFileHandle(s.name, { create: true })).createWritable();
      await w.write(new TextEncoder().encode(s.name));
      await w.close();
      const file = await stagedFile(s.name);
      keepForDownload(s);
      ((window as unknown as { files: Record<string, File> }).files ??= {})[s.name] = file;
      return s.name;
    });
    /** Download `name`'s File read now (as the browser would, late): its bytes, or why it can't be read. */
    const read = (name: string) => page.evaluate(async (n) => {
      try {
        return new TextDecoder().decode(await (window as unknown as { files: Record<string, File> }).files[n].arrayBuffer());
      } catch (e) {
        return `unreadable: ${(e as Error).name}`;
      }
    }, name);
    const a = await stage();
    await page.clock.runFor(10 * 60_000); // a save dialog left open, a slow disk
    assert.equal(await read(a), a, 'the download\'s file still reads ten minutes on');
    assert.deepEqual(Object.keys(await staging(page)), [a]);
    // The next download's keeps its own and lets the previous go.
    const b = await stage();
    await eventually(async () => assert.deepEqual(Object.keys(await staging(page)), [b], 'the previous download\'s staging file removed'));
    assert.equal(await read(b), b);
    // The next file save's start lets the last download's go too.
    await page.evaluate(async () => {
      const { dropDownload } = await import('/web/snapshot-stage.ts' as string) as typeof import('../web/snapshot-stage.ts');
      await dropDownload();
    });
    assert.deepEqual(await staging(page), {});
  } finally {
    await browser.close();
  }
});
