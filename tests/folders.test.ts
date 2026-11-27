// Shared folders (docs/shares.md) without a guest: the folders tree's 9P answers in Chromium, on OPFS directories
// through both backends (tests/browser/folders-worker.ts); the record, the attachments, the mount unit and the live
// side over a memory store. The guest's side is tests/page-folders.test.ts.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { after, before, test } from 'node:test';
import { chromium, type Browser } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { attachFolder, createFolder, deleteFolder, detachFolder, editFolder, folderLock, folderSpecs, machinesWith, MAX_FOLDERS, moveFolder, preselect, rootNames, type Folder } from '../web/app/folders.ts';
import { PageFolders, type FolderAccess } from '../web/app/folders-live.ts';
import { mountUnit, sharesCredentials, sharesPathError } from '../web/app/shares-mount.ts';
import { folderDir, Store } from '../web/app/store.ts';
import { memoryFiles, memoryRecords } from '../web/app/store-backends.ts';
import { createMachine } from '../web/app/machines.ts';
import { guestWords } from '../web/app/guest-words.ts';
import { msgOf } from '../web/msg.ts';
import { words } from './words.ts';

let browser: Browser;
let base: string;
let close: () => void;
before(async () => {
  const server = await startServer();
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
});
after(async () => {
  await browser?.close();
  close?.();
});

test('the folders tree, on OPFS through both backends', { timeout: 300_000 }, async () => {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log(String(e)));
  if (process.env.WAARM64_FOLDERS_LOG) page.on('console', (m) => console.log(m.text()));
  await page.goto(`${base}/tests/browser/folders.html`);
  const r = await page.evaluate(() => (window as unknown as { __result: Promise<{ passed: string[]; failed: string[] }> }).__result);
  await page.close();
  assert.deepEqual(r.failed, []);
  assert.ok(r.passed.length >= 30, `${r.passed.length} cases`);
});

const newFiles = () => memoryFiles();
const newStore = (files = newFiles()) => new Store(memoryRecords(), files);
const fakeDir = (name: string) => ({ name }) as FileSystemDirectoryHandle;

test('folders: names, attachments, delete', async () => {
  const files = newFiles();
  const store = newStore(files);
  const [a, b, c] = [await createFolder(store, { kind: 'opfs', name: 'Data' }), await createFolder(store, { kind: 'opfs', name: 'Data' }), await createFolder(store, { kind: 'host', name: 'Src', handle: fakeDir('src'), readOnly: true })];
  assert.equal(b.name, 'Data (2)');
  assert.equal(c.readOnly, true);
  const m = await createMachine(store, { name: 'M' });
  assert.equal(m.shares, true, 'a new machine has shared folders');
  await attachFolder(store, m.id, a.id, false);
  await attachFolder(store, m.id, a.id, false);
  await attachFolder(store, m.id, c.id, false);
  await moveFolder(store, m.id, c.id, -1);
  assert.deepEqual((await store.get('machines', m.id))!.folders, [{ id: c.id, readOnly: false }, { id: a.id, readOnly: false }]);
  assert.deepEqual((await machinesWith(store, a.id)).map((x) => x.id), [m.id]);
  assert.ok((await store.get('folders', a.id))!.lastUsed > 0, 'attaching marks it used');
  assert.equal(preselect([a, b, await store.get('folders', a.id) as Folder], []), a.id);
  // Two folders of one name at the root (renamed to clash) are told apart in the list's order.
  const clash = { ...a, name: 'Src' };
  assert.deepEqual([...rootNames([{ id: c.id, readOnly: false }, { id: a.id, readOnly: false }], [clash, c]).values()], ['Src', 'Src (2)']);
  const specs = folderSpecs([{ id: c.id, readOnly: false }, { id: a.id, readOnly: true }], [c, a], new Map([[c.id, fakeDir('x')]]));
  assert.deepEqual(specs.map((s) => [s.name, s.kind, s.readOnly]), [['Src', 'host', true]], 'only what is present; the folder\'s Read-only wins');
  await editFolder(store, b.id, { name: 'Data' });
  assert.equal((await store.get('folders', b.id))!.name, 'Data (2)', 'a rename stays unique');
    files.write(`${folderDir(a.id)}/f`, 10);
  await deleteFolder(store, a.id);
  assert.deepEqual(files.paths(), [], 'its files go');
  assert.deepEqual((await store.get('machines', m.id))!.folders, [{ id: c.id, readOnly: false }], 'detached everywhere');
  assert.equal(await store.get('folders', a.id), undefined);
  await detachFolder(store, m.id, c.id);
  assert.equal('folders' in (await store.get('machines', m.id))!, false, 'no attachments: left out');
  for (let k = 0; k < MAX_FOLDERS; k++) await attachFolder(store, m.id, (await createFolder(store, { kind: 'opfs', name: `f${k}` })).id, false);
  await assert.rejects(attachFolder(store, m.id, c.id, false), (e) => msgOf(e)?.key === 'folders:folders.tooMany' && msgOf(e)?.params?.max === 16);
  store.close();
});

test('a folder is one record per directory, and the sweep takes the files of one gone', async () => {
  const files = newFiles();
  const store = newStore(files);
  const a = await createFolder(store, { kind: 'host', name: 'A', handle: fakeDir('same') });
  const all = store.all.bind(store);
  // A handle's isSameEntry doesn't survive the memory store's clone.
  (store as { all: unknown }).all = async () => (await all('folders')).map((f) => ({ ...f, handle: { isSameEntry: async (o: { name: string }) => o.name === 'same' } }));
  const b = await createFolder(store, { kind: 'host', name: 'B', handle: fakeDir('same') });
  (store as { all: unknown }).all = all;
  assert.equal(b.id, a.id, 'the same directory dropped twice');
  // A crash between the files and the record: the sweep takes them.
  files.write('folders/aaaaaaaaaaaa/f', 10);
  assert.ok((await store.sweep())?.includes(folderDir('aaaaaaaaaaaa')));
  store.close();
});

test('the mount unit: names as systemd-escape makes them, paths refused', { skip: (() => { try { execFileSync('systemd-escape', ['--version']); return false; } catch { return 'SKIPPED: no systemd-escape'; } })() }, () => {
  for (const p of ['/mnt/shared', '/home/me/host files', '/mnt/é', '/data.v2/.hidden', '/a-b/c_d:e', '/x+y']) {
    assert.equal(mountUnit(p), execFileSync('systemd-escape', ['--path', p], { encoding: 'utf8' }).trim(), p);
  }
  assert.equal(mountUnit('/mnt/shared'), 'mnt-shared');
  assert.equal(mountUnit('/home/me/host files'), 'home-me-host\\x20files');
  for (const ok of ['/mnt/shared', '/media/x', '/home/me/host files', '/srv/data', '/var/share/x']) assert.equal(sharesPathError(ok), undefined, ok);
  for (const bad of ['/mnt/100%', '/mnt/x ', '/mnt/x\\', `/${'é/'.repeat(30)}x`, '', 'mnt', '/', '/mnt/', '/mnt//x', '/mnt/../x', '/mnt/./x', '/etc', '/usr', '/lib64', '/dev', '/dev/x', '/proc/x', '/sys/y', '/a\nb', `/${'x'.repeat(255)}`]) assert.ok(sharesPathError(bad), JSON.stringify(bad));
  const units = sharesCredentials('/mnt/shared', guestWords().shares);
  assert.match(units[0].data, new RegExp(`^Description=${words('guest:guest-words.shares').source}$`, 'm'));
  assert.deepEqual(units.map((c) => c.name), ['systemd.extra-unit.mnt-shared.mount', 'systemd.extra-unit.mnt-shared.automount', 'systemd.unit-dropin.remote-fs.target~waarm64-shares']);
  assert.match(units[0].data, /What=waarm64\nWhere=\/mnt\/shared\nType=9p\nOptions=trans=virtio,version=9p2000\.L,cache=none,msize=1048576,access=user,nofail\n/);
  assert.match(units[2].data, /Wants=mnt-shared\.automount/);
});

/** A device's port as a list of what it was told. */
function devicePort() {
  const told: unknown[] = [];
  const port = { postMessage: (m: unknown) => told.push(m), close() {}, onmessage: undefined as unknown };
  return { port: port as unknown as MessagePort, told, say: (m: unknown) => (port.onmessage as (e: { data: unknown }) => void)({ data: m }) };
}

test("the live side: a grant the browser doesn't answer leaves its folder out, and the start goes on", async () => {
  // Chromium can leave a stored handle's queryPermission unanswered (a host folder, after the computer restarted): a
  // start that waited for it never ended, on its boot card with no error.
  const store = newStore();
  let answer: (granted: boolean) => void = () => {};
  let asked = 0;
  const access: FolderAccess = {
    directory: async (f) => fakeDir(f.id),
    query: () => {
      asked++;
      return new Promise<boolean>((resolve) => { answer = resolve; });
    },
    request: async () => true,
    pick: async () => fakeDir('picked again'),
  };
  const live = new PageFolders({ store, me: () => 'This one', onChange() {}, access, grantWaitMs: 20 });
  const [opfs, host] = [await createFolder(store, { kind: 'opfs', name: 'In the browser' }), await createFolder(store, { kind: 'host', name: 'On disk', handle: fakeDir('d') })];
  const m = await createMachine(store, { name: 'M' });
  await attachFolder(store, m.id, host.id, false);
  await attachFolder(store, m.id, opfs.id, false);
  const device = devicePort();
  try {
    const began = live.begin((await store.get('machines', m.id))!, device.port);
    const specs = await Promise.race([began, new Promise<'hung'>((r) => setTimeout(() => r('hung'), 2000))]);
    assert.notEqual(specs, 'hung', 'the start waited for the grant');
    assert.deepEqual((specs as { name: string }[]).map((s) => s.name), ['In the browser'], 'the folder without an answer is left out');
    assert.deepEqual(live.views().map((v) => v.problem), ['unanswered', undefined]);
    // The answer, late: granted, the folder comes in while the machine runs.
    answer(true);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(live.views()[0].problem, undefined);
    assert.deepEqual(device.told.map((t) => [(t as { type: string }).type, (t as { folder: { name: string } }).folder.name]), [['attach', 'On disk']]);
    live.end();
    // Unanswered again at the next start; Choose again… (the user's click) picks the directory anew: the record keeps
    // its id and name with the new handle, and the machine gets it.
    const second = devicePort();
    await live.begin((await store.get('machines', m.id))!, second.port);
    assert.equal(asked, 2);
    assert.equal(live.views()[0].problem, 'unanswered');
    await live.repick(host.id);
    assert.equal(live.views()[0].problem, undefined);
    assert.equal(asked, 2, 'a picked directory is not asked about again');
    const picked = await store.get('folders', host.id);
    assert.deepEqual([picked?.name, picked?.handle?.name], ['On disk', 'picked again']);
    assert.deepEqual(second.told.map((t) => [(t as { type: string }).type, (t as { folder: { handle: { name: string } } }).folder.handle.name]), [['attach', 'picked again']]);
    // A late answer once the machine stopped brings nothing in.
    live.end();
    answer(true);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(second.told.length, 1);
    assert.equal(live.views().length, 0);
  } finally {
    live.close(); // a failure leaves nothing that keeps the file running
    store.close();
  }
});

test('the live side: what a start serves, what waits, and what brings it in', async () => {
  const store = newStore();
  let allowed = false;
  const access: FolderAccess = { directory: async (f) => fakeDir(f.id), query: async () => allowed, request: async () => { allowed = true; return true; }, pick: async () => undefined };
  const live = new PageFolders({ store, me: () => 'This one', onChange() {}, access });
  const [opfs, host] = [await createFolder(store, { kind: 'opfs', name: 'In the browser' }), await createFolder(store, { kind: 'host', name: 'On disk', handle: fakeDir('d') })];
  const m = await createMachine(store, { name: 'M' });
  await attachFolder(store, m.id, opfs.id, false);
  await attachFolder(store, m.id, host.id, false);
  const device = devicePort();
  const specs = await live.begin((await store.get('machines', m.id))!, device.port);
  assert.deepEqual(specs.map((s) => s.name), ['In the browser'], 'the host folder waits for a click');
  assert.deepEqual(live.views().map((v) => v.problem), [undefined, 'permission']);
  await live.allow(host.id);
  assert.deepEqual(device.told.map((t) => [(t as { type: string }).type, (t as { folder: { name: string } }).folder.name]), [['attach', 'On disk']]);
  assert.equal(live.views()[1].problem, undefined);
  // A grant lost while running: the button comes back; given again, the device hears it.
  device.say({ type: 'denied', id: host.id });
  assert.equal(live.views()[1].problem, 'permission');
  await live.allow(host.id);
  assert.deepEqual(device.told.at(-1), { type: 'granted', id: host.id });
  await assert.rejects(live.setReadOnly(m.id, host.id, true), (e) => msgOf(e)?.key === 'folders:folders-live.detachFirst');
  // Attached while it runs, then detached.
  const third = await createFolder(store, { kind: 'opfs', name: 'Third' });
  await live.attach(m.id, third, true);
  assert.equal((device.told.at(-1) as { folder: { readOnly: boolean } }).folder.readOnly, true);
  const leaving3 = live.detach(m.id, third.id);
  await new Promise((r) => setTimeout(r, 5));
  device.say({ type: 'detached', id: third.id });
  await leaving3;
  assert.deepEqual(device.told.at(-1), { type: 'detach', id: third.id });
  assert.equal(live.views().length, 2);
  // The lock goes after the device let go.
  const fourth = await createFolder(store, { kind: 'opfs', name: 'Fourth' });
  await live.attach(m.id, fourth, false);
  const detaching = live.detach(m.id, fourth.id);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(live.locks.mine(folderLock(fourth.id)), true, 'held while the device lands its writes');
  device.say({ type: 'detached', id: fourth.id });
  await detaching;
  assert.equal(live.locks.mine(folderLock(fourth.id)), false);
  const leavingHost = live.detach(m.id, host.id);
  await new Promise((r) => setTimeout(r, 5));
  device.say({ type: 'detached', id: host.id });
  await leavingHost;
  // Another tab's change to the record reaches the machine running here.
  const fifth = await createFolder(store, { kind: 'opfs', name: 'Fifth' });
  await attachFolder(store, m.id, fifth.id, false);
  await live.refresh();
  assert.equal((device.told.at(-1) as { folder?: { name: string } }).folder?.name, 'Fifth');
  await detachFolder(store, m.id, fifth.id);
  const leaving = live.refresh();
  await new Promise((r) => setTimeout(r, 5));
  device.say({ type: 'detached', id: fifth.id });
  await leaving;
  assert.deepEqual(device.told.at(-1), { type: 'detach', id: fifth.id });
  live.end();
  assert.equal(live.running, false);
  assert.equal(folderLock('x'), 'waarm64-folder:x');
  live.close();
  store.close();
});
