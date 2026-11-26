// A file disk whose file this web app can't reach (docs/machines.md §3.2), on the page in Chromium, without a guest:
// its file a file in OPFS (a handle the page keeps, as a picked file's), the browser's answers stood in for where
// headless Chromium can't give them. The start's message bar says why and offers Allow and start where a grant may help
// and Choose <disk> again and start always: when the browser answers neither the question nor Allow (seen on a user's
// Linux Chromium: Allow and start did nothing), when the file was moved away; a file of another size isn't taken; the
// disk keeps its id, machines and overlays with the new handle. An overlay's export, its file gone, says so with Choose
// again, as the Home page's Disks pane does. `WAARM64_SHOTS=<dir>`: screenshots of those states there.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { t } from '../web/i18n.ts';
import { answerAsks, type Question } from './page-ask.ts';
import { openHome } from './page-home.ts';
import { words } from './words.ts';

/** A start boots the machine's UEFI firmware: unbuilt where images aren't (GitHub's runner). */
const FIRMWARE = new URL('../target/images/edk2/QEMU_EFI.fd', import.meta.url);
const skip = !existsSync(FIRMWARE) ? 'SKIPPED: run images/build.sh edk2' : undefined;

let base: string;
let close: () => void;
let dir: string;
before(async () => {
  const server = await startServer();
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  dir = mkdtempSync(join(tmpdir(), 'waarm64-file-disk-'));
});
after(() => {
  close?.();
  if (dir) rmSync(dir, { recursive: true });
});

const SHOTS = process.env.WAARM64_SHOTS;
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(600); // the bar's slide in
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};

/** The page's file picker answers with OPFS file `window.__pick` (a path); `never`: the browser answers no grant. */
function stubs(never: boolean) {
  const w = window as unknown as Record<string, unknown>;
  w.__asked = 0;
  w.showSaveFilePicker = undefined; // a download (headless Chromium's picker waits for a dialog nobody answers)
  w.showOpenFilePicker = async () => {
    const path = String(w.__pick).split('/');
    let d = await navigator.storage.getDirectory();
    for (const p of path.slice(0, -1)) d = await d.getDirectoryHandle(p);
    return [await d.getFileHandle(path.at(-1)!)];
  };
  if (!never) return;
  const proto = FileSystemHandle.prototype as unknown as Record<string, unknown>;
  proto.queryPermission = () => new Promise(() => undefined);
  proto.requestPermission = () => {
    w.__asked = (w.__asked as number) + 1;
    return new Promise(() => undefined);
  };
}

/** OPFS file `path` with `bytes` bytes of the fixture (or `fill`), made or replaced; or removed (`bytes` 0). */
const opfsFile = (page: Page, path: string, bytes: number, fill?: number) =>
  page.evaluate(
    async ([path, bytes, fill]) => {
      const parts = path.split('/');
      let d = await navigator.storage.getDirectory();
      for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
      const name = parts.at(-1)!;
      if (!bytes) return void (await d.removeEntry(name).catch(() => undefined));
      const data = fill === undefined ? await (await fetch('/tests/qcow2/data.raw')).arrayBuffer() : new Uint8Array(bytes).fill(fill);
      const w = await (await d.getFileHandle(name, { create: true })).createWritable();
      await w.write(data);
      await w.close();
    },
    [path, bytes, fill] as [string, number, number | undefined],
  );

/**
 * The message bar shows `key`'s words as its headline or a detail, and these buttons: the floating bar's, or the Home
 * page's banner (which shows it while Home is open).
 */
async function bar(page: Page, key: string, params: Record<string, string | number>, buttons: string[]) {
  const said = () => page.evaluate(() => `${document.getElementById('message-text')?.textContent ?? ''} ${document.getElementById('message-details')?.textContent ?? ''}`);
  const src = words(key, params).source;
  await page
    .waitForFunction((src) => new RegExp(src).test(`${document.getElementById('message-text')?.textContent ?? ''} ${document.getElementById('message-details')?.textContent ?? ''}`), src, { timeout: 20_000 })
    .catch(async (e: unknown) => {
      throw new Error(`${key}: the bar says ${await said()}`, { cause: e });
    });
  assert.deepEqual(await buttonsOf(page).allTextContents(), buttons);
}
/** The message's buttons, in the floating bar or the Home page's banner. */
const buttonsOf = (page: Page) => page.locator('.banner:has(#message-text) .actions button');
/** Started: its disks opened, handed to the worker (its overlay made). */
const started = (page: Page) =>
  page.waitForFunction(() => ['booting', 'running'].includes(document.body.dataset.state!), null, { timeout: 30_000 });
/** The disk's record and the machine's attachments as the store has them, and whether its handle is OPFS file `path`. */
const record = (page: Page, ids: { disk: string; machine: string }, path: string) =>
  page.evaluate(
    async ([ids, path]) => {
      const { Store } = await import('/web/app/store.ts' as string);
      const store = await Store.open();
      const d = await store.get('disks', ids.disk);
      const m = await store.get('machines', ids.machine);
      const overlays = (await store.all('overlays')).filter((o: { disk: string }) => o.disk === ids.disk).length;
      store.close();
      const parts = path.split('/');
      let dir = await navigator.storage.getDirectory();
      for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
      const want = await dir.getFileHandle(parts.at(-1)!).catch(() => undefined);
      return { id: d?.id, name: d?.name, identity: JSON.stringify(d?.identity), at: !!want && (await d.handle.isSameEntry(want)), attachments: m.attachments.map((a: { id: string; disk: string }) => `${a.id}:${a.disk}`).join(), overlays };
    },
    [ids, path] as [{ disk: string; machine: string }, string],
  );

test("a file disk's file out of reach: the start says why and offers Choose again, which keeps the disk; so do an export and the Disks pane", { skip, timeout: 240_000 }, async () => {
  const context = await chromium.launchPersistentContext(mkdtempSync(join(dir, 'profile-')), { executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', viewport: { width: 1280, height: 800 } });
  const errors: string[] = [];
  const questions: Question[] = [];
  const open = async (never: boolean) => {
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.addInitScript(stubs, never);
    await answerAsks(page, (q) => void questions.push(q));
    return page;
  };
  try {
    // The machine: its disk the fixture's bytes in OPFS (`disk.img`), and a copy (`copy/disk.img`: another date).
    const setup = await open(false);
    await setup.goto(`${base}/tests/browser/core.html`);
    await opfsFile(setup, 'disk.img', 1);
    await opfsFile(setup, 'copy/disk.img', 1);
    const ids = await setup.evaluate(async () => {
      const { Store } = await import('/web/app/store.ts' as string);
      const { createDisk, createMachine, attach } = await import('/web/app/machines.ts' as string);
      const store = await Store.open();
      const h = await (await navigator.storage.getDirectory()).getFileHandle('disk.img');
      const file = await h.getFile();
      const m = await createMachine(store, { name: 'Filed', ncpus: 1, ramMiB: 512, display: '2d' });
      const d = await createDisk(store, { kind: 'file', file, handle: h, size: file.size });
      await attach(store, m, d);
      store.close();
      return { disk: d.id as string, machine: m.id as string };
    });
    await setup.close();
    const name = 'disk.img';
    const repickAndStart = t('disks:problems.repickAndStart', { name });

    // 1. The browser answers neither the question nor Allow: the start doesn't wait for it, Allow and start says it
    // got no answer (before: nothing happened, the click waited for good), and Choose again starts the machine.
    const p1 = await open(true);
    await p1.goto(`${base}/web/app/?m=${ids.machine}&autostart=1&display=simple`);
    await bar(p1, 'disks:file-access.unanswered', {}, [t('disks:problems.allowAndStart'), repickAndStart]);
    await shot(p1, 'start-unanswered');
    await buttonsOf(p1).filter({ hasText: t('disks:problems.allowAndStart') }).click();
    // The request not answered either: said once its bound passed (the browser asked once), with both buttons again.
    await bar(p1, 'disks:file-access.unansweredAllow', {}, [t('disks:problems.allowAndStart'), repickAndStart]);
    await shot(p1, 'allow-unanswered');
    assert.equal(await p1.evaluate(() => (window as unknown as { __asked: number }).__asked), 1);
    await p1.evaluate(() => { (window as unknown as { __pick: string }).__pick = 'copy/disk.img'; });
    const was = await record(p1, ids, 'disk.img');
    await buttonsOf(p1).filter({ hasText: repickAndStart }).click();
    await started(p1);
    assert.equal(questions.filter((q) => words('disks:file-actions.otherFile').test(q.text)).length, 1, 'another date: asked, and taken');
    await p1.close();
    const now = await (async () => {
      const p = await open(false);
      await p.goto(`${base}/tests/browser/core.html`);
      const r = await record(p, ids, 'copy/disk.img');
      await p.close();
      return r;
    })();
    assert.equal(now.at, true, 'the disk keeps the file chosen');
    assert.deepEqual({ ...now, at: undefined, overlays: 0 }, { ...was, at: undefined, overlays: 0 }, 'the same disk: id, name, identity, attachments');
    assert.equal(now.overlays, 1, 'its overlay, made at the start');

    // 2. The file moved away (its grant still there): only Choose again; a file of another size isn't taken.
    const p2 = await open(false);
    await p2.goto(`${base}/tests/browser/core.html`);
    await opfsFile(p2, 'copy/disk.img', 0);
    await opfsFile(p2, 'other.img', 4096, 3);
    await p2.goto(`${base}/web/app/?m=${ids.machine}&autostart=1&display=simple`);
    await bar(p2, 'disks:file-access.missing', {}, [repickAndStart]);
    await shot(p2, 'start-missing');
    await p2.evaluate(() => { (window as unknown as { __pick: string }).__pick = 'other.img'; });
    await buttonsOf(p2).filter({ hasText: repickAndStart }).click();
    await bar(p2, 'disks:file-access.other.size', { size: 4096, bytes: 196608 }, [repickAndStart]);
    await shot(p2, 'start-other-file');
    assert.equal(await p2.evaluate(() => document.body.dataset.state), 'idle', 'not started');
    // Its own file (the same name, size and date): taken without a question, and it starts.
    const asked = questions.length;
    await p2.evaluate(() => { (window as unknown as { __pick: string }).__pick = 'disk.img'; });
    await buttonsOf(p2).filter({ hasText: repickAndStart }).click();
    await started(p2);
    assert.equal(questions.length, asked, 'no question');
    await p2.close();

    // 3. Its file gone again: the Home page's export of its overlay says so before the save, with Choose again; the
    // Disks pane says why too, and its Choose the file again… brings it back; the export then saves.
    const p3 = await open(false);
    await p3.goto(`${base}/tests/browser/core.html`);
    await opfsFile(p3, 'disk.img', 0);
    await p3.goto(`${base}/web/app/?m=${ids.machine}&display=simple`);
    await openHome(p3);
    await p3.locator('.machines [data-tab=disks]').click();
    await p3.locator('.machines [data-action=export]').click();
    await p3.locator('#export [data-export=whole]').click();
    await p3.locator('#export [data-save=raw]').click();
    await bar(p3, 'disks:file-access.missing', {}, [t('disks:file-actions.repick', { name })]);
    assert.match(await p3.locator('#message-text').textContent() ?? '', words('disks:disk-export.save.failed', {}, { whole: true }));
    await shot(p3, 'export-missing');
    await p3.locator('.banner:has(#message-text) .dismiss').click();
    await p3.locator('[data-machine=disks]').click();
    const card = p3.locator(`[data-disk="${ids.disk}"]`);
    await card.locator('[data-field=disk-file-problem]').waitFor({ timeout: 10_000 });
    assert.match(await card.locator('[data-field=disk-file-problem]').textContent() ?? '', words('disks:file-access.missing'));
    assert.equal(await card.locator('[data-action=allow-disk-file]').count(), 0, 'no Allow: the grant is not what is missing');
    await shot(p3, 'disks-pane-missing');
    await opfsFile(p3, 'disk.img', 1);
    await p3.evaluate(() => { (window as unknown as { __pick: string }).__pick = 'disk.img'; });
    await card.locator('[data-action=repick-disk-file]').click();
    await card.locator('[data-field=disk-file-problem]').waitFor({ state: 'detached', timeout: 10_000 });
    await p3.locator(`[data-machine="${ids.machine}"]`).click();
    await p3.locator('.machines [data-tab=disks]').click();
    const [saved] = await Promise.all([
      p3.waitForEvent('download', { timeout: 30_000 }),
      (async () => {
        await p3.locator('.machines [data-action=export]').click();
        await p3.locator('#export [data-export=whole]').click();
        await p3.locator('#export [data-save=raw]').click();
      })(),
    ]);
    assert.equal(saved.suggestedFilename(), 'disk-saved.img');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});
