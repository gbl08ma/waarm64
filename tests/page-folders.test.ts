// Shared folders on the page (docs/shares.md). Without a guest, on stored machines whose only disk is blank (the firmware
// runs and finds nothing to boot, which is all a folder's lock needs): the Home page's tab and pane, the wizard, the
// lock's Use it here between two tabs, Delete. On Debian (opt-in with WAARM64_DISTROS=debian, scripts/ci-machines.sh): the
// guest's side, through the mount the page sets up: read and write under the mount point, whose files the page sees;
// owners per attach; a workload (a tree of files, rm -r, a rename across folders; a C project built and a git repository
// on images/debian-tools/build.sh's Debian, on demand); a folder attached while running; another mount point after a restart.
// Needs the firmware (images/build.sh edk2), and for the guest images/build.sh debian.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { credentialsQuery } from './debian-unattended.ts';
import { withDebianLock } from './debian-lock.ts';
import { answerAsks } from './page-ask.ts';
import { PAGE_QUERY } from './page-query.ts';
import { t } from '../web/i18n.ts';
import { words } from './words.ts';
import { SHARES_BY_HAND } from '../web/app/shares-mount.ts';

const FIRMWARE = new URL('../target/images/edk2/QEMU_EFI.fd', import.meta.url);
const IMAGE = new URL('../target/images/debian/disk.qcow2', import.meta.url);
const TOOLS = new URL('../target/images/debian-tools/disk.qcow2', import.meta.url);
const skip = !existsSync(FIRMWARE) ? 'SKIPPED: run images/build.sh edk2' : undefined;
const debian = (process.env.WAARM64_DISTROS ?? '').split(',').includes('debian');
const skipGuest = !debian ? 'SKIPPED: scripts/ci-machines.sh runs it (WAARM64_DISTROS=debian)' : !existsSync(IMAGE) ? 'SKIPPED: run images/build.sh debian' : skip;
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

/** Runs `f` on the page with the store open. */
const withStore = <T,>(page: Page, f: string, arg?: unknown) => page.evaluate(async ([f, arg]) => {
  const { Store } = await import('/web/app/store.ts' as string);
  const folders = await import('/web/app/folders.ts' as string);
  const live = await import('/web/app/folders-live.ts' as string);
  const shape = await import('/web/app/shape.ts' as string);
  const store = await Store.open();
  try {
    return await (0, eval)(f as string)({ store, ...folders, ...live, newId: shape.newId }, arg);
  } finally {
    store.close();
  }
}, [f, arg]) as Promise<T>;

/** A folder in the browser, with `files` (name → text) in its directory. */
const makeFolder = (page: Page, name: string, files: Record<string, string> = {}, readOnly = false) => withStore<string>(page, `(async ({ store, createFolder, browserAccess }, [name, files, readOnly]) => {
  const f = await createFolder(store, { kind: 'opfs', name, readOnly });
  const d = await browserAccess.directory(f);
  for (const [k, text] of Object.entries(files)) { const w = await (await d.getFileHandle(k, { create: true })).createWritable(); await w.write(text); await w.close(); }
  return f.id;
})`, [name, files, readOnly]);

/** The text of a file in folder `id` on the page's side. */
const folderFile = (page: Page, id: string, path: string) => withStore<string>(page, `(async ({ browserAccess }, [id, path]) => {
  let d = await browserAccess.directory({ id });
  const parts = path.split('/');
  for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p);
  return (await (await d.getFileHandle(parts.at(-1))).getFile()).text();
})`, [id, path]);

/** A stored machine with shared folders. */
const makeMachine = (page: Page, m: { name: string; folders?: { id: string; readOnly: boolean }[]; disk?: unknown }) => withStore<string>(page, `(async ({ store, newId }, m) => {
  const now = Date.now();
  const disk = m.disk ?? { id: newId(), kind: 'blank', name: 'Blank', size: 1 << 26, created: now };
  disk.identity ??= { kind: 'blank', id: disk.id, bytes: disk.size };
  await store.put('disks', { created: now, ...disk });
  const id = newId();
  await store.put('machines', { id, name: m.name, ncpus: 2, ramMiB: 1024, display: '2d', adapters: [], shares: true, folders: m.folders, attachments: [{ id: newId(), disk: disk.id, readOnly: false }], created: now, modified: now });
  return id;
})`, m);

const started = (page: Page) => page.waitForFunction(() => ['booting', 'running'].includes(document.getElementById('state')?.dataset.state ?? ''), null, { timeout: 60_000 });
const menu = async (page: Page) => {
  await page.waitForSelector('#folders');
  if (!(await page.evaluate(() => (document.getElementById('folders') as HTMLDetailsElement).open))) await page.locator('#folders summary').click();
};
const itemState = (page: Page, id: string) => page.locator(`#folders [data-folder="${id}"]`).textContent();

test('the page: the wizard, the lock between two tabs, the tab and the pane, Delete', { skip, timeout: 5 * 60_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const a = await context.newPage();
  const errors: string[] = [];
  const asked: string[] = [];
  a.on('pageerror', (e) => errors.push(`A: ${e}`));
  await answerAsks(a, (q) => { asked.push(q.text); });
  await a.goto(`${base}/web/app/`);
  const data = await makeFolder(a, 'Data', { 'hello.txt': 'hello' });
  const [alpha, bravo] = [await makeMachine(a, { name: 'Alpha', folders: [{ id: data, readOnly: false }] }), await makeMachine(a, { name: 'Bravo', folders: [{ id: data, readOnly: false }] })];

  await a.goto(`${base}/web/app/?m=${alpha}`);
  await started(a);
  await menu(a);
  assert.ok((await itemState(a, data) ?? '').includes(`Data ${t('folders:FoldersMenu.state.readWrite')}`));
  // The menu says where the guest finds them, in its width; the command to mount them by hand is in Details…, to copy.
  assert.match(await a.locator('#folders-where').textContent() ?? '', words('folders:FoldersMenu.where'));
  const sideways = await a.locator('#folders').evaluate((m) => [...m.querySelectorAll('*')].filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX !== 'visible').map((e) => `${e.tagName}.${e.className} ${e.scrollWidth}/${e.clientWidth}`));
  assert.deepEqual(sideways, [], 'nothing in the menu scrolls sideways');
  const panel = await a.locator('#folders').evaluate((m) => { const p = m.querySelector('summary')!.nextElementSibling as HTMLElement; return { scroll: p.scrollWidth, client: p.clientWidth }; });
  assert.ok(panel.scroll <= panel.client, `the menu's panel holds its words: ${JSON.stringify(panel)}`);
  assert.equal(await a.locator('#folders').textContent().then((s) => s?.includes('mount -t')), false, 'no command in the menu');
  // From the keyboard: closed, the dialog gives the focus back to the Folders button (the menu's closed with Details… in it).
  await a.focus('#folders-mount-open');
  await a.keyboard.press('Enter');
  await a.waitForFunction(() => (document.getElementById('folders-mount') as HTMLDialogElement).open, null, { timeout: 5_000 });
  assert.equal(await a.locator('#folders-mount-command').inputValue(), SHARES_BY_HAND);
  assert.match(await a.locator('#folders-mount-auto').textContent() ?? '', words('folders:FoldersMount.auto', { path: '/mnt/shared' }));
  assert.equal(await a.locator('#folders-mount').evaluate((d) => d.scrollWidth <= d.clientWidth), true, 'the dialog holds the command');
  await a.keyboard.press('Escape');
  await a.waitForFunction(() => !(document.getElementById('folders-mount') as HTMLDialogElement).open, null, { timeout: 5_000 });
  assert.equal(await a.evaluate(() => document.activeElement?.matches('#folders > summary') ?? false), true, `focus on ${await a.evaluate(() => document.activeElement?.outerHTML.slice(0, 80))}`);
  await menu(a);

  // A second tab's machine: Alpha writes it, so it waits, naming Alpha, and takes it after asking.
  const b = await context.newPage();
  b.on('pageerror', (e) => errors.push(`B: ${e}`));
  await answerAsks(b, (q) => { asked.push(q.text); });
  await b.goto(`${base}/web/app/?m=${bravo}`);
  await started(b);
  await menu(b);
  await b.waitForFunction(([id, want]) => (document.querySelector(`#folders [data-folder="${id}"]`)?.textContent ?? '').includes(want), [data, t('folders:FoldersMenu.state.heldBy', { holder: 'Alpha' })], { timeout: 10_000 });
  await b.locator(`#folders [data-folder="${data}"] [data-action="use-folder"]`).click();
  await b.waitForFunction((id) => document.querySelector(`#folders [data-folder="${id}"]`)?.getAttribute('data-problem') === null, data, { timeout: 15_000 });
  assert.match(asked.at(-1)!, words('folders:folder-actions.inUse.confirm', { who: 'Alpha' }));
  await a.waitForFunction((id) => document.querySelector(`#folders [data-folder="${id}"]`)?.getAttribute('data-problem') === 'held', data, { timeout: 5_000 });

  // Attach a new folder through the wizard while Bravo runs: nothing else to attach, so its kinds at once.
  await b.click('#folder-attach');
  await b.click('#folder-kind-opfs');
  await b.fill('#folder-name', 'Made here');
  assert.equal(await b.locator('#folder-form').evaluate((e) => getComputedStyle(e).padding), '16px', "the wizard's layout");
  await b.click('#folder-ok');
  await b.waitForFunction(() => /Made here/.test(document.getElementById('folders')?.textContent ?? ''), null, { timeout: 10_000 });
  const records = await withStore<{ id: string; name: string }[]>(b, '(({ store }) => store.all("folders"))');
  const made = records.find((f) => f.name === 'Made here')!;
  assert.ok(made, 'kept');
  assert.deepEqual(await withStore(b, `(async ({ store }, id) => (await store.get('machines', id)).folders)`, bravo), [{ id: data, readOnly: false }, { id: made.id, readOnly: false }], 'saved at once');

  // The Home page: the machine's tab, then the browser's folders.
  await b.click('#machines-open');
  await b.locator('.machines .pick', { hasText: 'Bravo' }).click();
  await b.click('[data-tab="folders"]');
  await b.waitForSelector(`.folders-list [data-folder="${made.id}"]`);
  // A Svelte component's styles stop at its own markup: the settings and the pane's frame have the Home page's.
  assert.equal(await b.locator('.folders-switch').evaluate((e) => getComputedStyle(e).rowGap), '12px', "the settings' layout");
  await b.fill('[data-field="shares-path"]', '/etc');
  await b.waitForSelector('[data-shares-path-error]');
  await b.fill('[data-field="shares-path"]', '/mnt/elsewhere');
  await b.locator('[data-action="save"]').first().click().catch(() => {});
  await b.click('[data-machine="folders"]');
  await b.waitForSelector(`[data-selected="folders"] [data-folder="${data}"]`);
  assert.equal(await b.locator('[data-selected="folders"] .tab').evaluate((e) => getComputedStyle(e).paddingTop), '16px', "the pane's frame");
  await b.locator(`[data-selected="folders"] [data-folder="${data}"] [data-action="folder-files"]`).click();
  await b.waitForFunction(() => /hello\.txt/.test(document.querySelector('[data-files]')?.textContent ?? ''), null, { timeout: 5_000 });
  await b.locator(`[data-selected="folders"] [data-folder="${data}"] [data-action="delete-folder"]`).click();
  await b.waitForFunction((id) => !document.querySelector(`[data-selected="folders"] [data-folder="${id}"]`), data, { timeout: 10_000 });
  assert.ok([['Alpha', 'Bravo'], ['Bravo', 'Alpha']].some((ms) => words('folders:FoldersPane.delete.opfs.lose', { count: 2, name: 'Data', machines: ms.join(', ') }).test(asked.at(-1)!)), asked.at(-1)!);
  assert.deepEqual(await withStore(b, `(async ({ store }, id) => (await store.get('machines', id)).folders)`, alpha), undefined, 'detached from every machine');
  assert.deepEqual(errors, []);
  await context.close();
});

test("a folder in the browser's files: added, listed, copied, emptied", { skip }, async () => {
  const page = await browser.newPage();
  await page.goto(`${base}/web/app/`);
  const r = await page.evaluate(async () => {
    const { addFiles, copyTree, emptyFolder, folderSize, topLevel } = await import('/web/app/folder-files.ts' as string);
    const top = await (await navigator.storage.getDirectory()).getDirectoryHandle('files-test', { create: true });
    const [a, b] = [await top.getDirectoryHandle('a', { create: true }), await top.getDirectoryHandle('b', { create: true })];
    await addFiles(a, [new File(['hello'], 'x.txt'), new File(['more!!'], 'y.txt')]);
    const sub = await a.getDirectoryHandle('sub', { create: true });
    await addFiles(sub, [new File(['deep'], 'z.txt')]);
    const listed = await topLevel(a);
    const c = { done: 0, total: 0, bytes: 0 };
    await copyTree(a, b, c);
    const copied = await (await (await (await b.getDirectoryHandle('sub')).getFileHandle('z.txt')).getFile()).text();
    const stopped = { done: 0, total: 0, bytes: 0, stop: true };
    await copyTree(a, await top.getDirectoryHandle('c', { create: true }), stopped);
    const size = await folderSize(b);
    await emptyFolder(b);
    const left = await topLevel(b);
    await (await navigator.storage.getDirectory()).removeEntry('files-test', { recursive: true });
    return { listed, c, copied, stopped: stopped.done, size, left };
  });
  await page.close();
  assert.deepEqual(r.listed, [{ name: 'sub', kind: 'directory', size: 4 }, { name: 'x.txt', kind: 'file', size: 5 }, { name: 'y.txt', kind: 'file', size: 6 }]);
  assert.deepEqual(r.c, { done: 3, total: 3, bytes: 15 });
  assert.equal(r.copied, 'deep');
  assert.equal(r.stopped, 0, 'Cancel stops it');
  assert.equal(r.size, 15);
  assert.deepEqual(r.left, []);
});

const terminal = (page: Page) => page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '');
const shows = (page: Page, re: RegExp, ms = 60_000) =>
  page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.xterm-rows')?.textContent ?? ''), re.source, { timeout: ms, polling: 100 })
    .catch(async (e) => { throw new Error(`${e}; the terminal shows: ${await terminal(page)}`); });
async function running(page: Page, from?: string, ms = BOOT_MS) {
  await page.waitForFunction((from) => document.body.dataset.state !== from && ['running', 'failed', 'crashed', 'idle', 'off'].includes(document.body.dataset.state!), from, { timeout: ms, polling: 250 })
    .catch(async (e) => { throw new Error(`${e}; the terminal shows: ${await terminal(page)}`); });
  assert.equal(await page.evaluate(() => document.body.dataset.state), 'running', await page.evaluate(() => document.getElementById('message-text')?.textContent ?? ''));
}
async function type(page: Page, text: string) {
  await page.locator('.xterm').click();
  await page.keyboard.type(text, { delay: 2 });
}
let tag = 0;
async function sh(page: Page, cmd: string, ms = 120_000): Promise<{ out: string; status: number }> {
  const t = ++tag;
  await type(page, `clear; o=$( { ${cmd} ; } 2>&1 ); s=$?; echo "<$((${t}*1))<"$o">$s>${t}>"\n`);
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
  await shows(page, /(?:root@\S+|\S+):~# /);
  await type(page, 'set +H\n'); // no `!` history
}

/** A machine with shared folders on the tests' Debian. */
async function debianMachine(page: Page, folders: { id: string; readOnly: boolean }[], image = IMAGE) {
  const bytes = readFileSync(image);
  const size = Number(bytes.readBigUInt64BE(24));
  const url = new URL(image).pathname.slice(new URL('..', import.meta.url).pathname.length - 1);
  return makeMachine(page, { name: 'Debian', folders, disk: { id: 'd00000000001', kind: 'url', name: 'disk.qcow2', size, url, identity: { kind: 'url', path: url, bytes: bytes.length } } });
}

test('the guest: the mount, owners, a workload, a folder attached while running, another mount point', { skip: skipGuest, timeout: 20 * 60_000 }, () => withDebianLock(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'waarm64-profile-'));
  const context = await chromium.launchPersistentContext(dir, { executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' }); // on disk: docs/backlog.md "A handle read back off the record"
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await answerAsks(page);
  await page.goto(`${base}/web/app/?${PAGE_QUERY}view=terminal`);
  const work = await makeFolder(page, 'Work', { 'from-the-page.txt': 'written by the page' });
  const docs = await makeFolder(page, 'Docs', { 'read-me.txt': 'read only' }, true);
  const other = await makeFolder(page, 'Other');
  const host = await makeFolder(page, 'Host');
  const id = await debianMachine(page, [{ id: work, readOnly: false }, { id: docs, readOnly: false }, { id: other, readOnly: false }, { id: host, readOnly: false }]);
  await page.goto(`${base}/web/app/?${PAGE_QUERY}m=${id}&view=terminal&display=simple&sharesasync=Host&${credentialsQuery()}`);
  await running(page);
  await login(page);

  // The first access mounts it; the root lists the folders.
  assert.equal(await ok(page, 'ls /mnt/shared'), 'Docs Host Other Work');
  assert.match(await ok(page, 'findmnt -n -o FSTYPE,OPTIONS --target /mnt/shared/Work'), / 9p rw.*access=user/);
  assert.equal(await ok(page, 'cat /mnt/shared/Work/from-the-page.txt'), 'written by the page');
  await ok(page, 'echo from-the-guest > /mnt/shared/Work/g.txt && sync');
  assert.equal(await folderFile(page, work, 'g.txt'), 'from-the-guest\n');
  assert.equal(await ok(page, 'cat /mnt/shared/Docs/read-me.txt'), 'read only');
  assert.match((await sh(page, 'touch /mnt/shared/Docs/x')).out, /Read-only file system/);

  // Each user owns what it sees (`access=user`: an attach per uid).
  assert.equal(await ok(page, 'stat -c "%u %a" /mnt/shared/Work/g.txt'), '0 644');
  assert.equal(await ok(page, `su -s /bin/sh nobody -c 'stat -c "%u %a" /mnt/shared/Work/g.txt; echo mine > /mnt/shared/Work/n.txt; stat -c %u /mnt/shared/Work/n.txt'`), '65534 644 65534');

  // A directory pinned by one user (its cwd) and looked at by another: v9fs writes the asker's uid into the shared inode, so
  // what's allowed can't depend on the owner.
  await ok(page, `su -s /bin/sh nobody -c 'cd /mnt/shared/Work && sleep 2 && touch pinned' & sleep 1; ls -la /mnt/shared/Work >/dev/null; wait $!`);
  assert.equal(await ok(page, 'stat -c %u /mnt/shared/Work/pinned'), '0');

  // A workload, through both backends.
  for (const W of ['/mnt/shared/Work', '/mnt/shared/Host']) {
    await ok(page, `cd ${W} && mkdir -p tree/a/b && for k in 1 2 3 4 5 6 7 8 9; do echo $k > tree/a/b/f$k; done && tar cf /tmp/t.tar tree && mkdir un && tar xf /tmp/t.tar -C un && diff -r tree un/tree && cd`);
    assert.equal(await ok(page, `cd ${W}/tree/a && echo x > .swp && mv .swp y && mv y b/ && ls b | wc -l; cd`), '10');
    assert.equal(await ok(page, `mv ${W}/tree ${W}/moved && cat ${W}/moved/a/b/f7`), '7');
    assert.equal(await ok(page, `printf "#!/bin/sh\\necho ran\\n" > ${W}/run.sh && chmod +x ${W}/run.sh && ${W}/run.sh`), 'ran');
    assert.match(await ok(page, `echo x > ${W}/t; ln -s x ${W}/l; ln ${W}/t ${W}/h; rm ${W}/t; echo done`), /Operation not permitted[^]*Operation not permitted[^]*done/);
    await ok(page, `rm -r ${W}/moved ${W}/un`);
  }
  // Across folders the rename itself is EXDEV, and mv copies.
  assert.equal(await ok(page, `perl -e 'rename("/mnt/shared/Work/g.txt", "/mnt/shared/Other/g.txt") or print $!+0'`), '18');
  await ok(page, 'mv /mnt/shared/Work/g.txt /mnt/shared/Other/g.txt');
  assert.equal(await folderFile(page, other, 'g.txt'), 'from-the-guest\n');

  // A folder attached while running is in the next ls.
  await page.evaluate(() => { (document.querySelector('#folders summary') as HTMLElement).click(); });
  await page.click('#folder-attach');
  await page.click('#folder-kind-opfs');
  await page.fill('#folder-name', 'Late');
  await page.click('#folder-ok');
  await page.waitForFunction(() => /Late/.test(document.getElementById('folders')?.textContent ?? ''), null, { timeout: 10_000 });
  assert.equal(await ok(page, 'ls /mnt/shared'), 'Docs Host Late Other Work');
  await ok(page, 'echo late > /mnt/shared/Late/f');
  // A real folder of this computer, dropped: writing it needs a click no headless browser can give, so it waits for one;
  // read-only (what a drop grants) it is served, through the host backend on the real thing.
  const real = mkdtempSync(join(tmpdir(), 'waarm64-real-'));
  try {
    const name = basename(real);
    writeFileSync(join(real, 'real.txt'), 'on the disk\n');
    const cdp = await context.newCDPSession(page);
    const data = { items: [], files: [real], dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop'] as const) await cdp.send('Input.dispatchDragEvent', { type, x: 200, y: 200, data });
    const row = (problem: string) => page.waitForFunction(([name, problem]) => [...document.querySelectorAll<HTMLElement>('#folders li')].some((li) => li.textContent!.includes(name) && (li.dataset.problem ?? '') === problem), [name, problem], { timeout: 10_000 });
    await row('permission');
    await menu(page);
    await page.locator('#folders li', { hasText: name }).locator('[data-action="detach-folder"]').click();
    await page.waitForFunction((name) => !document.getElementById('folders')!.textContent!.includes(name), name, { timeout: 10_000 });
    await page.click('#folder-attach');
    await page.locator('#folder-wizard [data-folder]', { hasText: name }).click();
    await page.check('#folder-attach-ro');
    await page.click('#folder-ok');
    await row('');
    assert.equal(await ok(page, `cat /mnt/shared/${name}/real.txt`), 'on the disk');
    writeFileSync(join(real, 'later.txt'), 'x');
    assert.equal(await ok(page, `ls /mnt/shared/${name}`), 'later.txt real.txt');
    assert.match((await sh(page, `touch /mnt/shared/${name}/w`)).out, /Read-only file system/);
    await menu(page);
    await page.locator('#folders li', { hasText: name }).locator('[data-action="detach-folder"]').click();
    await page.waitForFunction((name) => !document.getElementById('folders')!.textContent!.includes(name), name, { timeout: 10_000 });
    await page.locator('#folders summary').click();
  } finally {
    rmSync(real, { recursive: true, force: true });
  }

  // Detached with a file open for writing: what it wrote lands, the guest's fid goes stale, the mount lives on.
  await type(page, 'exec 9>/mnt/shared/Other/open.txt\n');
  await ok(page, 'echo partial >&9');
  await menu(page);
  await page.locator('#folders li', { hasText: 'Other' }).locator('[data-action="detach-folder"]').click();
  await page.waitForFunction(() => !/Other/.test(document.getElementById('folders')?.textContent ?? ''), null, { timeout: 10_000 });
  assert.equal(await folderFile(page, other, 'open.txt'), 'partial\n');
  assert.notEqual((await sh(page, 'echo more >&9')).status, 0);
  await type(page, 'exec 9>&-\n');
  assert.equal(await ok(page, 'ls /mnt/shared'), 'Docs Host Late Work');

  // Another mount point takes effect at the next start.
  await withStore(page, `(async ({ store }, id) => store.put('machines', { ...(await store.get('machines', id)), sharesPath: '/srv/host files' }))`, id);
  await type(page, 'reboot\n');
  await page.waitForFunction(() => document.body.dataset.state !== 'running', null, { timeout: 120_000, polling: 100 });
  await running(page);
  await login(page);
  assert.equal(await ok(page, 'ls "/srv/host files"'), 'Docs Host Late Work');
  assert.equal(await ok(page, 'cat "/srv/host files/Late/f"'), 'late');
  assert.equal(await ok(page, 'ls /mnt/shared 2>&1 | wc -l; systemctl is-active "srv-host\\x20files.automount"'), '0 active');
  await type(page, 'poweroff\n');
  await page.waitForFunction(() => document.body.dataset.state === 'off', null, { timeout: 120_000 });
  assert.deepEqual(errors, []);
  await context.close();
  rmSync(dir, { recursive: true, force: true });
}));

test('snapshots: restored with a file open for writing, and into a folder detached since', { skip: skipGuest, timeout: 20 * 60_000 }, () => withDebianLock(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'waarm64-profile-'));
  const context = await chromium.launchPersistentContext(dir, { executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' }); // on disk: docs/backlog.md "A handle read back off the record"
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await answerAsks(page, () => true);
  await page.goto(`${base}/web/app/?${PAGE_QUERY}view=terminal`);
  const [work, host, gone] = [await makeFolder(page, 'Work'), await makeFolder(page, 'Host'), await makeFolder(page, 'Gone', { 'kept.txt': 'kept' })];
  const id = await debianMachine(page, [{ id: work, readOnly: false }, { id: host, readOnly: false }, { id: gone, readOnly: false }]);
  await page.goto(`${base}/web/app/?${PAGE_QUERY}m=${id}&view=terminal&display=simple&sharesasync=Host&${credentialsQuery()}`);
  await running(page);
  await login(page);
  await type(page, 'exec 9>/mnt/shared/Work/open.txt 7>/mnt/shared/Host/open.txt 8</mnt/shared/Gone/kept.txt\n');
  await ok(page, 'echo one >&9; echo one >&7; chmod 700 /mnt/shared/Work/open.txt; stat -c %i /mnt/shared/Work/open.txt > /tmp/inode');
  await page.waitForTimeout(1000);
  await page.locator('#save-snapshot').click();
  await page.waitForFunction((src) => new RegExp(src).test(document.getElementById('message-text')?.textContent ?? ''), words('snapshots:snapshot-actions.kept', {}, { start: true }).source, { timeout: 180_000 }); // its .slept and .awake variants start the same
  // The snapshot landed what was open, and the machine writes on.
  assert.equal(await folderFile(page, host, 'open.txt'), 'one\n');
  await ok(page, 'echo two >&9; echo two >&7');
  // Detached since: its fids go stale, and the mount lives on.
  await menu(page);
  await page.locator(`#folders [data-folder="${gone}"] [data-action="detach-folder"]`).click();
  await page.waitForFunction((id) => !document.querySelector(`#folders [data-folder="${id}"]`), gone, { timeout: 10_000 });
  await page.locator('#folders summary').click();
  await page.click('#machines-open');
  await page.locator('.machines [data-tab=snapshots]').click();
  await page.locator('.machines [data-snapshot]').first().getByRole('button', { name: t('snapshots:Snapshots.restore') }).click();
  await page.waitForFunction(() => document.body.dataset.state !== 'running', null, { timeout: 30_000, polling: 50 });
  await running(page);
  await page.waitForTimeout(1000);
  await type(page, '\n');
  assert.equal(await ok(page, 'ls /mnt/shared'), 'Host Work');
  assert.equal(await ok(page, 'stat -c "%a %i" /mnt/shared/Work/open.txt'), `700 ${await ok(page, 'cat /tmp/inode')}`.trim(), 'its chmod and its qid came back');
  await ok(page, 'echo three >&9; echo three >&7');
  await type(page, 'exec 9>&- 7>&-\n');
  assert.equal(await ok(page, 'cat /mnt/shared/Work/open.txt'), 'one three');
  assert.equal(await ok(page, 'cat /mnt/shared/Host/open.txt'), 'one three');
  assert.match((await sh(page, 'cat <&8')).out, /Stale file handle/);
  assert.equal(await folderFile(page, gone, 'kept.txt'), 'kept');
  assert.deepEqual(errors, []);
  await context.close();
  rmSync(dir, { recursive: true, force: true });
}));

test('a real workload: make, gcc and git in a share, both backends', { skip: skipGuest || (!existsSync(TOOLS) && 'SKIPPED: run images/debian-tools/build.sh'), timeout: 15 * 60_000 }, () => withDebianLock(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'waarm64-profile-'));
  const context = await chromium.launchPersistentContext(dir, { executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await answerAsks(page);
  await page.goto(`${base}/web/app/?${PAGE_QUERY}view=terminal`);
  const [work, host] = [await makeFolder(page, 'Work'), await makeFolder(page, 'Host')];
  const id = await debianMachine(page, [{ id: work, readOnly: false }, { id: host, readOnly: false }], TOOLS);
  await page.goto(`${base}/web/app/?${PAGE_QUERY}m=${id}&view=terminal&display=simple&sharesasync=Host&${credentialsQuery()}`);
  await running(page);
  await login(page);
  for (const W of ['/mnt/shared/Work', '/mnt/shared/Host']) {
    await ok(page, `mkdir ${W}/c && cd ${W}/c && printf "int f(void);\\nint main(void){return f();}\\n" > m.c && echo "int f(void){return 0;}" > f.c && printf "p: m.o f.o\\n\\tgcc -o p m.o f.o\\n" > Makefile && make -s && ./p && touch f.c && make -s && ./p`);
    await ok(page, `cd ${W} && git init -q r && cd r && git config user.email a@b && git config user.name a && for k in 1 2 3 4 5; do echo $k > f$k; done && git add . && git commit -qm one && echo more >> f1 && mkdir d && git mv f2 d/ && git add -A && git commit -qm two && git status --porcelain && git log --oneline | wc -l && git fsck --strict 2>&1 | tail -1 && git gc -q && git log --oneline | wc -l`);
    assert.equal(await ok(page, `cd ${W}/r && git log --oneline | wc -l; git status --porcelain | wc -l`), '2 0');
    await ok(page, `cd; rm -r ${W}/c ${W}/r`);
    assert.equal(await ok(page, `ls ${W} | wc -l`), '0');
  }
  await type(page, 'poweroff\n');
  await page.waitForFunction(() => document.body.dataset.state === 'off', null, { timeout: 120_000 });
  assert.deepEqual(errors, []);
  await context.close();
  rmSync(dir, { recursive: true, force: true });
}));
